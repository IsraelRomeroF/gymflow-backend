import { Prisma } from '@gymflow/db';
import { precioConAumentos, precioTrasCambio, primerCobroConAumento, rigeDesde, uuidv7, type CambioDeLaMembresia, type PlanDuration } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

/** Lo que toca un cambio de precio, contado sin recorrer socios. */
export type CuentaDelCambio = {
  touched: number; atList: number; touchedDelta: bigint;
  protegidas: number; protectedDelta: bigint;
  enSedesConPrecioPropio: number; firstPaymentOn: Date | null; sinCelular: number;
  /** 4.20 (P-14): desde qué día rige y cuántas de las tocadas pagan antes de ese día una vez más el precio de antes. */
  rige: Date; antesDelAviso: number;
};

export type PrecioProtegido = {
  membershipId: string; memberId: string; memberCode: string; firstName: string; lastName: string;
  branchId: string | null; agreedPriceCents: bigint; listPriceCents: bigint; reason: string | null;
};

export type CambioDeMembresia = {
  id: string; membershipId: string; fromPriceCents: bigint; toPriceCents: bigint; createdAt: Date;
  /** 4.20: desde cuándo rige (NULL = rigió al guardarse), la previsión del primer cobro y, si ya llegó, con qué cuota. */
  appliesFrom: Date | null; firstChargeOn: Date | null; aplicadoConCuota: string | null; aplicado: boolean;
};

/** Un aumento guardado que todavía no llega a una membresía (4.20, P-14). */
export type AumentoPorLlegar = { id: string; deltaCents: bigint; appliesFrom: Date; toPriceCents: bigint; firstChargeOn: Date | null };

/** Una membresía tocada, con lo necesario para prever su primer cobro al precio nuevo. */
type Tocada = {
  id: string; memberId: string; status: string; currentPeriodEnd: Date; billingAnchorDay: number;
  actual: bigint; prot: boolean; lista: boolean; phone: string | null; conPendiente: boolean;
};

/** Estados en los que la membresía sigue emitiendo cuotas: de ellos sale la fecha del primer cobro. */
const QUE_COBRAN = new Set(['TRIALING', 'ACTIVE', 'PAST_DUE']);

/**
 * CAMBIOS DE PRECIO DE UN PLAN (fase 3 · bloque 3.6 · D-19; fase 4 · bloque
 * 4.20 · P-14). Dueño de `plan_price_changes`, `membership_price_changes` y
 * `membership_price_applications`, y de las dos columnas de la membresía que
 * son del precio: `agreedPriceCents` cuando lo mueve un cambio de precio, y la
 * marca `priceProtected` («conserva su precio»).
 *
 * A quién toca un cambio del precio de lista: a las membresías VIVAS (ni
 * canceladas ni vencidas) del plan vendidas donde rige ese precio, es decir,
 * en una sucursal sin precio propio escrito (o sin sucursal de venta).
 *
 * CUÁNDO LES LLEGA (4.20, P-14):
 *  · Una BAJADA, al guardarla: se mueve el precio pactado (como en 3.6).
 *  · Un AUMENTO espera: queda «por llegar» con `appliesFrom` = hoy + 15 y el
 *    precio pactado NO se mueve. La emisión de la cuota (`billing`) pregunta
 *    `paraCuota` (la regla es `precioConAumentos` del núcleo) y, cuando la
 *    cuota ya lo lleva, deja la constancia (`registrarLlegada`). Así lo que
 *    dicen hoy la ficha, el Tablero y el perdón («lo que paga») es lo que de
 *    verdad paga hoy. Quien no tenía precio escrito queda con el de antes
 *    escrito, para que el precio de lista nuevo no le llegue antes.
 */
export class PriceChangeRepository extends TenantRepository {
  /**
   * Los cambios de precio de la membresía `ms` que cuentan (4.20): los de su
   * plan actual y posteriores a su último cambio de plan (cambiar de plan
   * deja el precio de lista del plan nuevo y olvida lo anterior).
   */
  private cambiosQueCuentan(): Prisma.Sql {
    return Prisma.sql`pc."membershipId" = ms."id" AND pc."organizationId" = ms."organizationId"
      AND (SELECT a."planId" FROM "plan_price_changes" a WHERE a."id" = pc."planPriceChangeId") = ms."planId"
      AND pc."createdAt" > COALESCE((SELECT MAX(e."at") FROM "membership_events" e
                                      WHERE e."membershipId" = ms."id" AND e."organizationId" = ms."organizationId" AND e."eventType" = 'PLAN_CHANGED'), '-infinity'::timestamptz)`;
  }

  /**
   * Lo que pagará la membresía `ms` cuando lleguen los aumentos ya guardados
   * (`precioAlFinal` del núcleo): si alguno espera, el último cambio; si no,
   * lo que paga hoy (sin precio escrito, `sinPacto`: el de lista de antes del cambio).
   */
  private hayPorLlegar(): Prisma.Sql {
    return Prisma.sql`EXISTS (
        SELECT 1 FROM "membership_price_changes" pc
         WHERE ${this.cambiosQueCuentan()} AND pc."appliesFrom" IS NOT NULL AND pc."toPriceCents" > pc."fromPriceCents"
           AND NOT EXISTS (SELECT 1 FROM "membership_price_applications" ap WHERE ap."membershipPriceChangeId" = pc."id"))`;
  }

  private proyectado(sinPacto: bigint): Prisma.Sql {
    return Prisma.sql`(CASE WHEN ${this.hayPorLlegar()}
      THEN (SELECT pc."toPriceCents" FROM "membership_price_changes" pc WHERE ${this.cambiosQueCuentan()} ORDER BY pc."createdAt" DESC, pc."id" DESC LIMIT 1)
      ELSE COALESCE(ms."agreedPriceCents", ${sinPacto}::bigint) END)`;
  }

  /**
   * Las membresías vivas del plan con lo que pagan, si rige para ellas el
   * precio de lista y si conservan su precio. `actual` es de dónde parte el
   * cambio: lo que pagarán cuando lleguen los aumentos ya guardados (sin
   * ninguno, lo que pagan hoy). `pendiente`: tiene algún aumento por llegar.
   */
  private universo(planId: string, fromPriceCents: bigint): Prisma.Sql {
    return Prisma.sql`
      SELECT ms."id", ms."memberId", ms."status", ms."currentPeriodEnd", ms."billingAnchorDay", ms."priceProtected" AS "prot",
             ${this.proyectado(fromPriceCents)} AS "actual",
             ${this.hayPorLlegar()} AS "conPendiente",
             NOT EXISTS (SELECT 1 FROM "plan_branch_availability" a
                          WHERE a."planId" = ms."planId" AND a."branchId" = ms."soldAtBranchId" AND a."priceOverrideCents" IS NOT NULL) AS "lista",
             m."phoneE164" AS "phone"
        FROM "memberships" ms
        JOIN "members" m ON m."id" = ms."memberId" AND m."organizationId" = ms."organizationId"
       WHERE ms."organizationId" = ${this.organizationId}::uuid AND ms."planId" = ${planId}::uuid
         AND ms."status" NOT IN ('CANCELED', 'EXPIRED')`;
  }

  /** La duración del plan, para prever los periodos de cada socio. */
  private async duracion(planId: string): Promise<PlanDuration | null> {
    const p = await this.db.plan.findFirst({ where: this.scope({ id: planId }), select: { durationUnit: true, durationValue: true } });
    return p ? { unit: p.durationUnit as PlanDuration['unit'], value: p.durationValue } : null;
  }

  /**
   * La previsión del primer cobro al precio nuevo de una membresía (4.20).
   * Un aumento: su primer inicio de periodo desde `rige`. Una bajada: su
   * siguiente pago. `null` si no está emitiendo cuotas (suspendida,
   * congelada, por activar) o su plan no tiene periodos.
   */
  private previsto(t: Pick<Tocada, 'status' | 'currentPeriodEnd' | 'billingAnchorDay'>, duracion: PlanDuration | null, hoy: Date, rige: Date, sube: boolean): Date | null {
    if (!QUE_COBRAN.has(t.status) || t.currentPeriodEnd.getTime() < hoy.getTime()) return null;
    if (!sube) return t.currentPeriodEnd;
    if (!duracion) return null;
    return primerCobroConAumento({ siguienteInicio: t.currentPeriodEnd, duracion, diaDeCorte: t.billingAnchorDay, rige });
  }

  /** A cuántos toca y cuánto cambia, ANTES de confirmar. `hoy` es el día del gimnasio. */
  async contar(planId: string, fromPriceCents: bigint, toPriceCents: bigint, hoy: Date): Promise<CuentaDelCambio> {
    const delta = toPriceCents - fromPriceCents;
    const sube = delta > 0n;
    const rige = rigeDesde(hoy, fromPriceCents, toPriceCents);
    const filas = await this.db.$queryRaw<Tocada[]>`SELECT * FROM (${this.universo(planId, fromPriceCents)}) x`;
    const duracion = await this.duracion(planId);
    const cambio = (actual: bigint) => precioTrasCambio({ actualCents: actual, fromPriceCents, toPriceCents }) - actual;
    const tocadas = filas.filter((x) => x.lista && !x.prot);
    const protegidas = filas.filter((x) => x.lista && x.prot);
    let primero: Date | null = null;
    let antesDelAviso = 0;
    for (const t of tocadas) {
      const f = this.previsto(t, duracion, hoy, rige, sube);
      if (f && (primero === null || f.getTime() < primero.getTime())) primero = f;
      // Su siguiente cuota cae antes de los 15 días: esa la paga al precio de antes.
      if (sube && QUE_COBRAN.has(t.status) && t.currentPeriodEnd.getTime() >= hoy.getTime() && t.currentPeriodEnd.getTime() < rige.getTime()) antesDelAviso++;
    }
    return {
      touched: tocadas.length, atList: tocadas.filter((t) => t.actual === fromPriceCents).length,
      touchedDelta: tocadas.reduce((a, t) => a + cambio(t.actual), 0n),
      protegidas: protegidas.length, protectedDelta: protegidas.reduce((a, t) => a + cambio(t.actual), 0n),
      enSedesConPrecioPropio: filas.filter((x) => !x.lista).length, firstPaymentOn: primero,
      sinCelular: tocadas.filter((t) => t.phone === null).length, rige, antesDelAviso,
    };
  }

  /**
   * APLICA el cambio dentro de la unidad en curso: deja el acto (con desde
   * cuándo rige) y una fila por membresía tocada (de cuánto a cuánto, y la
   * previsión de su primer cobro). Una bajada mueve ya el precio pactado; un
   * aumento lo deja «por llegar» (4.20). No toca `updatedAt`: el precio
   * cambió, la membresía no se movió.
   */
  async aplicar(input: {
    planId: string; fromPriceCents: bigint; toPriceCents: bigint; includeProtected: boolean;
    reason: string; userId: string | null; protectedKept: number; hoy: Date;
  }): Promise<{ id: string; touched: number; rige: Date }> {
    const id = uuidv7();
    const delta = input.toPriceCents - input.fromPriceCents;
    const sube = delta > 0n;
    const rige = rigeDesde(input.hoy, input.fromPriceCents, input.toPriceCents);
    // El candado de fila evita que una renovación a la vez lea el precio a medias.
    await this.db.$queryRaw`
      SELECT ms."id" FROM "memberships" ms
       WHERE ms."organizationId" = ${this.organizationId}::uuid AND ms."planId" = ${input.planId}::uuid AND ms."status" NOT IN ('CANCELED', 'EXPIRED')
       FOR UPDATE`;
    const filas = (await this.db.$queryRaw<Tocada[]>`SELECT * FROM (${this.universo(input.planId, input.fromPriceCents)}) x`)
      .filter((x) => x.lista && (!x.prot || input.includeProtected))
      .map((x) => ({ ...x, nuevo: precioTrasCambio({ actualCents: x.actual, fromPriceCents: input.fromPriceCents, toPriceCents: input.toPriceCents }) }))
      .filter((x) => x.nuevo !== x.actual);
    const duracion = await this.duracion(input.planId);
    const touched = filas.length;
    // Primero el acto (la fila de cada membresía lo referencia).
    await this.db.planPriceChange.create({
      data: {
        id, organizationId: this.organizationId, planId: input.planId,
        fromPriceCents: input.fromPriceCents, toPriceCents: input.toPriceCents,
        includedProtected: input.includeProtected, touchedCount: touched, protectedKeptCount: input.protectedKept,
        reason: input.reason, createdByUserId: input.userId, appliesFrom: sube ? rige : null,
      },
    });
    if (touched === 0) return { id, touched, rige };
    await this.db.membershipPriceChange.createMany({
      data: filas.map((x) => ({
        id: uuidv7(), organizationId: this.organizationId, planPriceChangeId: id, membershipId: x.id, memberId: x.memberId,
        fromPriceCents: x.actual, toPriceCents: x.nuevo, wasProtected: x.prot,
        appliesFrom: sube ? rige : null, firstChargeOn: this.previsto(x, duracion, input.hoy, rige, sube),
      })),
    });
    const ids = filas.map((x) => x.id);
    if (sube) {
      // Quien pagaba el de lista sin precio escrito queda con el de antes escrito: el de lista ya es el nuevo.
      await this.db.$executeRaw`
        UPDATE "memberships" SET "agreedPriceCents" = ${input.fromPriceCents}::bigint
         WHERE "organizationId" = ${this.organizationId}::uuid AND "id" = ANY(${ids}::uuid[]) AND "agreedPriceCents" IS NULL`;
    } else {
      // La bajada no espera. Sin aumentos por llegar, su precio pasa ya al nuevo (sin precio
      // escrito ya paga el de lista, que bajó). Con alguno, lo que pague HOY con la regla del
      // núcleo: la bajada se aplica, pero no adelanta el aumento (`precioConAumentos`).
      const simples = filas.filter((x) => !x.conPendiente).map((x) => x.id);
      if (simples.length > 0) {
        await this.db.$executeRaw`
          UPDATE "memberships" ms SET "agreedPriceCents" = pc."toPriceCents"
            FROM "membership_price_changes" pc
           WHERE pc."planPriceChangeId" = ${id}::uuid AND pc."membershipId" = ms."id"
             AND ms."organizationId" = ${this.organizationId}::uuid AND ms."id" = ANY(${simples}::uuid[]) AND ms."agreedPriceCents" IS NOT NULL`;
      }
      for (const x of filas.filter((f) => f.conPendiente)) {
        const m = await this.db.membership.findFirst({ where: this.scope({ id: x.id }), select: { planId: true, agreedPriceCents: true } });
        if (!m || m.agreedPriceCents === null) continue;
        const { precio } = precioConAumentos({ base: m.agreedPriceCents, cambios: await this.cambiosDe(x.id), inicio: input.hoy, emitidaEl: input.hoy });
        await this.db.$executeRaw`UPDATE "memberships" SET "agreedPriceCents" = ${precio}::bigint WHERE "id" = ${x.id}::uuid AND "organizationId" = ${this.organizationId}::uuid`;
      }
    }
    return { id, touched, rige };
  }

  /** Los cambios que cuentan para una membresía (`cambiosQueCuentan`), del más viejo al más nuevo, con si ya llegaron. */
  async cambiosDe(membershipId: string): Promise<Array<CambioDeLaMembresia & { firstChargeOn: Date | null }>> {
    const filas = await this.db.$queryRaw<Array<{ id: string; fromPriceCents: bigint; toPriceCents: bigint; appliesFrom: Date | null; firstChargeOn: Date | null; llego: boolean }>>`
      SELECT pc."id", pc."fromPriceCents", pc."toPriceCents", pc."appliesFrom", pc."firstChargeOn",
             EXISTS (SELECT 1 FROM "membership_price_applications" ap WHERE ap."membershipPriceChangeId" = pc."id") AS "llego"
        FROM "membership_price_changes" pc
        JOIN "memberships" ms ON ms."id" = pc."membershipId"
       WHERE ms."id" = ${membershipId}::uuid AND ms."organizationId" = ${this.organizationId}::uuid AND ${this.cambiosQueCuentan()}
       ORDER BY pc."createdAt", pc."id"`;
    return filas;
  }

  /**
   * El precio de la cuota de esa membresía que empieza `inicio` y se emite
   * `emitidaEl` (4.20), con `base` = lo que paga hoy, y qué aumentos ya lleva.
   */
  async paraCuota(membershipId: string, base: bigint, cuota: { inicio: Date; emitidaEl: Date }): Promise<{ precio: bigint; llegan: string[] }> {
    const cambios = await this.cambiosDe(membershipId);
    return precioConAumentos({ base, cambios, inicio: cuota.inicio, emitidaEl: cuota.emitidaEl });
  }

  /** Los aumentos que todavía esperan, del más viejo al más nuevo (para la ficha). */
  async porLlegar(membershipId: string): Promise<AumentoPorLlegar[]> {
    return (await this.cambiosDe(membershipId))
      .filter((c) => c.appliesFrom !== null && c.toPriceCents > c.fromPriceCents && !c.llego)
      .map((c) => ({ id: c.id, deltaCents: c.toPriceCents - c.fromPriceCents, appliesFrom: c.appliesFrom!, toPriceCents: c.toPriceCents, firstChargeOn: c.firstChargeOn }));
  }

  /**
   * LLEGÓ EL AUMENTO (4.20): la cuota `chargeId` ya sale con él. Deja la
   * constancia de cada aumento que llevó y escribe el precio pactado nuevo
   * (`precio`, lo que se cobró), dentro de la unidad de la emisión.
   */
  async registrarLlegada(membershipId: string, aumentos: readonly string[], chargeId: string, precio: bigint): Promise<void> {
    if (aumentos.length === 0) return;
    await this.db.membershipPriceApplication.createMany({
      data: aumentos.map((a) => ({ id: uuidv7(), organizationId: this.organizationId, membershipPriceChangeId: a, membershipId, chargeId })),
    });
    await this.db.$executeRaw`
      UPDATE "memberships" SET "agreedPriceCents" = ${precio}::bigint
       WHERE "id" = ${membershipId}::uuid AND "organizationId" = ${this.organizationId}::uuid`;
  }

  /** El último cambio de precio que tocó a una membresía; `null` si ninguno. Con su llegada, si es un aumento por llegar (4.20). */
  async ultimoDe(membershipId: string): Promise<CambioDeMembresia | null> {
    const f = await this.db.membershipPriceChange.findFirst({
      where: this.scope({ membershipId }), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true, membershipId: true, fromPriceCents: true, toPriceCents: true, createdAt: true, appliesFrom: true, firstChargeOn: true,
        aplicacion: { select: { chargeId: true } },
      },
    });
    if (!f) return null;
    const { aplicacion, ...resto } = f;
    return { ...resto, aplicadoConCuota: aplicacion?.chargeId ?? null, aplicado: aplicacion !== null };
  }

  // ── «Conserva su precio» ─────────────────────────────────────────────────

  /** Quiénes conservan su precio en ese plan (vivas), por nombre. */
  async protegidas(planId: string, limite: number): Promise<{ total: number; filas: PrecioProtegido[] }> {
    const donde = Prisma.sql`ms."organizationId" = ${this.organizationId}::uuid AND ms."planId" = ${planId}::uuid
      AND ms."status" NOT IN ('CANCELED', 'EXPIRED') AND ms."priceProtected" = true`;
    const [filas, [t]] = await Promise.all([
      this.db.$queryRaw<PrecioProtegido[]>`
        SELECT ms."id" AS "membershipId", m."id" AS "memberId", m."memberCode", m."firstName", m."lastName",
               ms."soldAtBranchId" AS "branchId", ms."agreedPriceCents", ms."priceProtectedReason" AS "reason",
               COALESCE((SELECT a."priceOverrideCents" FROM "plan_branch_availability" a WHERE a."planId" = ms."planId" AND a."branchId" = ms."soldAtBranchId"), p."priceCents") AS "listPriceCents"
          FROM "memberships" ms
          JOIN "members" m ON m."id" = ms."memberId" AND m."organizationId" = ms."organizationId"
          JOIN "plans" p ON p."id" = ms."planId"
         WHERE ${donde}
         ORDER BY m."firstName", m."lastName", ms."id" LIMIT ${limite}`,
      this.db.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS "n" FROM "memberships" ms WHERE ${donde}`,
    ]);
    return { total: t?.n ?? 0, filas };
  }

  /** La membresía con lo necesario para marcarla: su plan, su sede y lo que paga. */
  async paraMarcar(membershipId: string): Promise<{
    id: string; memberId: string; planId: string; soldAtBranchId: string | null; status: string;
    agreedPriceCents: bigint | null; priceProtected: boolean; priceProtectedReason: string | null;
  } | null> {
    return this.db.membership.findFirst({
      where: this.scope({ id: membershipId }),
      select: { id: true, memberId: true, planId: true, soldAtBranchId: true, status: true, agreedPriceCents: true, priceProtected: true, priceProtectedReason: true },
    });
  }

  /** Pone o quita la marca. Al ponerla queda escrito el precio que conserva. */
  async marcar(membershipId: string, input: { protegida: boolean; reason: string | null; agreedPriceCents: bigint | null }): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "memberships"
         SET "priceProtected" = ${input.protegida}::boolean, "priceProtectedReason" = ${input.reason}::text,
             "agreedPriceCents" = COALESCE("agreedPriceCents", ${input.agreedPriceCents}::bigint)
       WHERE "id" = ${membershipId}::uuid AND "organizationId" = ${this.organizationId}::uuid`;
  }
}
