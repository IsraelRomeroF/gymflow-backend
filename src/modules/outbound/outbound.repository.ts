import { Prisma } from '@gymflow/db';
import { uuidv7 } from '@gymflow/core';
import type { OutboundKind } from '@gymflow/core/contracts';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { sqlDeSede } from '../../platform/db/filtro-de-sede.js';
import type { SedesDelDia } from '../../platform/time/business-calendar.js';

/** Días que un mensaje espera en la lista antes de caducar solo. */
export const DIAS_DE_VIGENCIA = 10;
/** Con cuántos días de anticipación se avisa de un pago o de un plan que termina. */
export const DIAS_DE_ANTICIPACION = 3;
/** Hasta cuántos días después de vencido se recuerda un pago. */
export const DIAS_DE_VENCIDO = 7;
/** Cuántos hechos de cada tipo se atienden por corrida; si se llena, la siguiente sigue. */
export const LOTE = 500;

/** Un mensaje con su hecho, leído HOY: de aquí sale el texto. */
export type OutboundRow = {
  id: string; kind: OutboundKind; status: string; memberId: string; branchId: string | null;
  createdAt: Date; resolvedAt: Date | null; body: string | null; engagementState: string | null;
  firstName: string; lastName: string; memberCode: string; phoneE164: string | null; homeBranchId: string | null;
  concept: string | null; dueCents: bigint | null; dueDate: Date | null;
  planName: string | null; periodEnd: Date | null;
  /** Solo PRICE_CHANGE (D-19, bloque 3.6): de cuánto a cuánto cambió lo que paga por periodo. */
  priceFromCents: bigint | null; priceToCents: bigint | null;
  resolvedByName: string | null;
};

/** A quién se le puede leer la lista: sus sedes de dinero y sus sedes de Retención. */
export type AlcanceDeMensajes = {
  /** Sedes donde manda mensajes. */
  sedes: readonly string[];
  /** De esas, donde además anota seguimientos de Retención (y el módulo está encendido). */
  sedesDeRetencion: readonly string[];
  /** Alcance de todo el gimnasio: también ve a los socios sin sede de casa. */
  sinSede: boolean;
};

export type Nuevo = {
  memberId: string; branchId: string | null; kind: OutboundKind; dedupeKey: string;
  chargeId?: string | null; membershipId?: string | null; engagementState?: string | null;
  /** Solo PRICE_CHANGE: la fila de `membership_price_changes` de la que avisa. */
  priceChangeId?: string | null;
};

/** Lo más grave primero: así se ordena la lista y así se decide cuál gana por socio. */
const GRAVEDAD = Prisma.sql`CASE o."kind" WHEN 'MEMBERSHIP_SUSPENDED' THEN 0 WHEN 'PAYMENT_OVERDUE' THEN 1 WHEN 'PAYMENT_DUE_SOON' THEN 2 WHEN 'MEMBERSHIP_ENDING' THEN 3 ELSE 4 END`;

const DESDE = Prisma.sql`
  FROM "outbound_messages" o
  JOIN "members" m ON m."id" = o."memberId" AND m."organizationId" = o."organizationId"
  LEFT JOIN "charges" c ON c."id" = o."chargeId" AND c."organizationId" = o."organizationId"
  LEFT JOIN "memberships" ms ON ms."id" = o."membershipId" AND ms."organizationId" = o."organizationId"
  LEFT JOIN "plans" p ON p."id" = ms."planId"
  LEFT JOIN "membership_price_changes" pc ON pc."id" = o."priceChangeId" AND pc."organizationId" = o."organizationId"`;

const COLUMNAS = Prisma.sql`
  o."id", o."kind", o."status", o."memberId", o."branchId", o."createdAt", o."resolvedAt", o."body", o."engagementState",
  m."firstName", m."lastName", m."memberCode", m."phoneE164", m."homeBranchId",
  c."concept", (c."amountCents" - c."allocatedCents" - c."adjustedCents") AS "dueCents", c."dueDate",
  p."name" AS "planName", ms."currentPeriodEnd" AS "periodEnd",
  pc."fromPriceCents" AS "priceFromCents", pc."toPriceCents" AS "priceToCents",
  (SELECT u."fullName" FROM "users" u WHERE u."id" = o."resolvedByUserId") AS "resolvedByName"`;

/**
 * ¿SIGUE VIVO EL HECHO? Lo que hace que un pendiente siga mereciendo mandarse,
 * con el día `hoy`. La lista lo aplica al leer (quien pagó hace diez minutos
 * no aparece) y el job lo usa, negado, para cerrar lo que ya no hace falta.
 * Un hecho que ya no se encuentra (NULL) cuenta como que dejó de existir.
 * El aviso de un cambio de precio (D-19) vive mientras la membresía siga viva
 * en ese plan y no haya otro cambio más nuevo que la toque.
 */
const hechoVivo = (hoy: Date) => Prisma.sql`COALESCE((
  (o."kind" = 'PAYMENT_DUE_SOON' AND o."chargeId" IS NOT NULL AND c."status" IN ('OPEN', 'PARTIALLY_PAID') AND c."dueDate" >= ${hoy}::date
     AND (c."amountCents" - c."allocatedCents" - c."adjustedCents") > 0)
  OR (o."kind" = 'PAYMENT_DUE_SOON' AND o."chargeId" IS NULL AND ms."status" = 'ACTIVE' AND ms."autoRenew" = true
     AND ms."currentPeriodEnd" > ${hoy}::date AND ms."currentPeriodEnd" <= ${hoy}::date + ${DIAS_DE_ANTICIPACION}::int)
  OR (o."kind" = 'PAYMENT_OVERDUE' AND c."status" = 'OVERDUE' AND (c."amountCents" - c."allocatedCents" - c."adjustedCents") > 0)
  OR (o."kind" = 'MEMBERSHIP_SUSPENDED' AND ms."status" = 'SUSPENDED')
  OR (o."kind" = 'MEMBERSHIP_ENDING' AND ms."status" = 'ACTIVE' AND ms."autoRenew" = false
     AND ms."currentPeriodEnd" > ${hoy}::date AND ms."currentPeriodEnd" <= ${hoy}::date + ${DIAS_DE_ANTICIPACION}::int)
  OR (o."kind" = 'WE_MISS_YOU'
     AND EXISTS (SELECT 1 FROM "memberships" v WHERE v."memberId" = o."memberId" AND v."organizationId" = o."organizationId" AND v."status" IN ('TRIALING', 'ACTIVE', 'PAST_DUE'))
     AND NOT EXISTS (SELECT 1 FROM "attendance_events" a WHERE a."organizationId" = o."organizationId" AND a."memberId" = o."memberId" AND a."at" > o."createdAt")
     AND NOT EXISTS (SELECT 1 FROM "follow_ups" f WHERE f."organizationId" = o."organizationId" AND f."memberId" = o."memberId" AND f."createdAt" > o."createdAt"))
  OR (o."kind" = 'PRICE_CHANGE' AND pc."id" IS NOT NULL AND ms."status" NOT IN ('CANCELED', 'EXPIRED')
     AND ms."planId" = (SELECT a."planId" FROM "plan_price_changes" a WHERE a."id" = pc."planPriceChangeId")
     AND NOT EXISTS (SELECT 1 FROM "membership_price_changes" n WHERE n."membershipId" = pc."membershipId" AND n."organizationId" = pc."organizationId" AND n."createdAt" > pc."createdAt"))
), false)`;

/** Se puede mandar: el socio sigue en el padrón, tiene celular y el mensaje no caducó por viejo. */
const mandable = Prisma.sql`(m."deletedAt" IS NULL AND m."phoneE164" IS NOT NULL AND o."createdAt" > now() - make_interval(days => ${DIAS_DE_VIGENCIA}::int))`;

/** Las sedes de quien mira, por la sede de casa del socio HOY (si cambió de sede, manda dónde está ahora). */
function deSusSedes(a: AlcanceDeMensajes): Prisma.Sql {
  const en = (ids: readonly string[]) => (a.sinSede
    ? Prisma.sql`(m."homeBranchId" = ANY(${[...ids]}::uuid[]) OR m."homeBranchId" IS NULL)`
    : Prisma.sql`m."homeBranchId" = ANY(${[...ids]}::uuid[])`);
  return Prisma.sql`((o."kind" <> 'WE_MISS_YOU' AND ${en(a.sedes)}) OR (o."kind" = 'WE_MISS_YOU' AND ${en(a.sedesDeRetencion)}))`;
}

/**
 * BANDEJA DE SALIDA: única dueña de `outbound_messages`. Lo demás (cargos,
 * membresías, asistencia, seguimientos) solo se LEE para saber qué hecho
 * merece mensaje y si sigue vivo; aquí no se escribe en tablas de otros.
 */
export class OutboundRepository extends TenantRepository {
  // ── Leer ─────────────────────────────────────────────────────────────────

  /** Los pendientes vivos de esas sedes, lo más grave primero. Sin recorte: el recorte va después de contar. */
  pendientes(hoy: Date, alcance: AlcanceDeMensajes): Promise<OutboundRow[]> {
    return this.db.$queryRaw<OutboundRow[]>`
      SELECT ${COLUMNAS} ${DESDE}
       WHERE o."organizationId" = ${this.organizationId}::uuid AND o."status" = 'PENDING'
         AND ${mandable} AND ${hechoVivo(hoy)} AND ${deSusSedes(alcance)}
       ORDER BY ${GRAVEDAD}, o."createdAt", o."id" LIMIT 2000`;
  }

  /** Solo los motivos de los pendientes vivos: la cuenta de la campana. */
  async motivosPendientes(hoy: Date, alcance: AlcanceDeMensajes): Promise<OutboundKind[]> {
    const filas = await this.db.$queryRaw<Array<{ kind: OutboundKind }>>`
      SELECT o."kind" ${DESDE}
       WHERE o."organizationId" = ${this.organizationId}::uuid AND o."status" = 'PENDING'
         AND ${mandable} AND ${hechoVivo(hoy)} AND ${deSusSedes(alcance)} LIMIT 2000`;
    return filas.map((f) => f.kind);
  }

  /** Los mandados el día `hoy` de la zona del gimnasio, el más reciente primero. */
  mandadosHoy(hoy: Date, zona: string, alcance: AlcanceDeMensajes, limite = 100): Promise<OutboundRow[]> {
    return this.db.$queryRaw<OutboundRow[]>`
      SELECT ${COLUMNAS} ${DESDE}
       WHERE o."organizationId" = ${this.organizationId}::uuid AND o."status" = 'SENT'
         AND (o."resolvedAt" AT TIME ZONE ${zona})::date = ${hoy}::date AND ${deSusSedes(alcance)}
       ORDER BY o."resolvedAt" DESC LIMIT ${limite}`;
  }

  async cuantosMandadosHoy(hoy: Date, zona: string, alcance: AlcanceDeMensajes): Promise<number> {
    const [f] = await this.db.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n ${DESDE}
       WHERE o."organizationId" = ${this.organizationId}::uuid AND o."status" = 'SENT'
         AND (o."resolvedAt" AT TIME ZONE ${zona})::date = ${hoy}::date AND ${deSusSedes(alcance)}`;
    return f?.n ?? 0;
  }

  /** Un mensaje de ESE socio, como esté. `vivo` dice si hoy todavía se puede mandar. */
  async deSocio(id: string, memberId: string, hoy: Date): Promise<(OutboundRow & { vivo: boolean }) | null> {
    const [f] = await this.db.$queryRaw<Array<OutboundRow & { vivo: boolean }>>`
      SELECT ${COLUMNAS}, (${mandable} AND ${hechoVivo(hoy)}) AS "vivo" ${DESDE}
       WHERE o."organizationId" = ${this.organizationId}::uuid AND o."id" = ${id}::uuid AND o."memberId" = ${memberId}::uuid`;
    return f ?? null;
  }

  // ── Resolver ─────────────────────────────────────────────────────────────

  /** De pendiente a mandado o descartado. Devuelve si lo cambió: dos toques a la vez no lo resuelven dos veces. */
  async resolver(id: string, como: 'SENT' | 'DISMISSED', userId: string, body: string | null): Promise<boolean> {
    const { count } = await this.db.outboundMessage.updateMany({
      where: this.scope({ id, status: 'PENDING' }),
      data: { status: como, resolvedAt: new Date(), resolvedByUserId: userId, body },
    });
    return count === 1;
  }

  // ── El job ───────────────────────────────────────────────────────────────

  /** Crea los que no existan ya con esa clave. Devuelve cuántos nacieron. */
  async crear(nuevos: readonly Nuevo[]): Promise<number> {
    if (nuevos.length === 0) return 0;
    const { count } = await this.db.outboundMessage.createMany({
      data: nuevos.map((n) => ({
        id: uuidv7(), organizationId: this.organizationId, memberId: n.memberId, branchId: n.branchId, kind: n.kind, dedupeKey: n.dedupeKey,
        chargeId: n.chargeId ?? null, membershipId: n.membershipId ?? null, engagementState: n.engagementState ?? null,
        priceChangeId: n.priceChangeId ?? null,
      })),
      skipDuplicates: true,
    });
    return count;
  }

  /** Cierra los pendientes que ya no hacen falta, diciendo por qué. Devuelve cuántos. */
  async caducar(hoy: Date): Promise<number> {
    return this.db.$executeRaw`
      UPDATE "outbound_messages" x
         SET "status" = 'EXPIRED', "resolvedAt" = now(), "closeReason" = q."porque"
        FROM (
          SELECT o."id",
                 CASE WHEN m."deletedAt" IS NOT NULL OR m."phoneE164" IS NULL THEN 'NO_PHONE'
                      WHEN NOT ${hechoVivo(hoy)} THEN 'FACT_GONE'
                      ELSE 'STALE' END AS "porque"
          ${DESDE}
           WHERE o."organizationId" = ${this.organizationId}::uuid AND o."status" = 'PENDING'
             AND NOT (${mandable} AND ${hechoVivo(hoy)})
        ) q
       WHERE x."id" = q."id" AND x."status" = 'PENDING'`;
  }

  /**
   * UNO POR SOCIO: de dinero, queda el más grave (y de esos, el más nuevo);
   * de «te extrañamos», el más nuevo; del cambio de precio, el más nuevo (un
   * recordatorio de pago no tapa el aviso del precio). Los demás se cierran
   * como reemplazados.
   */
  async reemplazar(): Promise<number> {
    return this.db.$executeRaw`
      UPDATE "outbound_messages" x
         SET "status" = 'EXPIRED', "resolvedAt" = now(), "closeReason" = 'SUPERSEDED'
        FROM (
          SELECT o."id", ROW_NUMBER() OVER (
                   PARTITION BY o."memberId", (CASE o."kind" WHEN 'WE_MISS_YOU' THEN 1 WHEN 'PRICE_CHANGE' THEN 2 ELSE 0 END)
                   ORDER BY ${GRAVEDAD}, o."createdAt" DESC, o."id" DESC) AS "lugar"
            FROM "outbound_messages" o
           WHERE o."organizationId" = ${this.organizationId}::uuid AND o."status" = 'PENDING'
        ) q
       WHERE x."id" = q."id" AND q."lugar" > 1 AND x."status" = 'PENDING'`;
  }

  // Los hechos de hoy. `sedes` acota por la sede de casa del socio: cada uno
  // se decide con el día de operación de SU sede. Lo que ya tiene mensaje no
  // se vuelve a traer: si el lote se llena, la siguiente corrida avanza.

  /** «Todavía no tiene mensaje con esta clave» (`prefijo` + el id de la fila). */
  private sinMensaje(clave: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`NOT EXISTS (SELECT 1 FROM "outbound_messages" o WHERE o."organizationId" = ${this.organizationId}::uuid AND o."dedupeKey" = ${clave})`;
  }

  porVencer(hoy: Date, sedes: SedesDelDia | null) {
    return this.db.$queryRaw<Array<{ id: string; memberId: string; homeBranchId: string | null }>>`
      SELECT c."id", c."memberId", m."homeBranchId"
        FROM "charges" c JOIN "members" m ON m."id" = c."memberId" AND m."deletedAt" IS NULL AND m."phoneE164" IS NOT NULL
       WHERE c."organizationId" = ${this.organizationId}::uuid AND c."status" IN ('OPEN', 'PARTIALLY_PAID')
         AND (c."amountCents" - c."allocatedCents" - c."adjustedCents") > 0
         AND c."dueDate" > ${hoy}::date AND c."dueDate" <= ${hoy}::date + ${DIAS_DE_ANTICIPACION}::int
         AND ${this.sinMensaje(Prisma.sql`'PAYMENT_DUE_SOON:' || c."id"::text`)}
         AND ${sqlDeSede(Prisma.sql`m."homeBranchId"`, sedes)} LIMIT ${LOTE}`;
  }

  vencidos(hoy: Date, sedes: SedesDelDia | null) {
    return this.db.$queryRaw<Array<{ id: string; memberId: string; homeBranchId: string | null }>>`
      SELECT c."id", c."memberId", m."homeBranchId"
        FROM "charges" c JOIN "members" m ON m."id" = c."memberId" AND m."deletedAt" IS NULL AND m."phoneE164" IS NOT NULL
       WHERE c."organizationId" = ${this.organizationId}::uuid AND c."status" = 'OVERDUE'
         AND (c."amountCents" - c."allocatedCents" - c."adjustedCents") > 0
         AND c."dueDate" >= ${hoy}::date - ${DIAS_DE_VENCIDO}::int
         AND ${this.sinMensaje(Prisma.sql`'PAYMENT_OVERDUE:' || c."id"::text`)}
         AND ${sqlDeSede(Prisma.sql`m."homeBranchId"`, sedes)} LIMIT ${LOTE}`;
  }

  /** Suspendidas en los últimos dos días: la misma ventana que el aviso del portal. */
  suspendidas(sedes: SedesDelDia | null) {
    return this.db.$queryRaw<Array<{ id: string; memberId: string; homeBranchId: string | null }>>`
      SELECT ms."id", ms."memberId", m."homeBranchId"
        FROM "memberships" ms JOIN "members" m ON m."id" = ms."memberId" AND m."deletedAt" IS NULL AND m."phoneE164" IS NOT NULL
       WHERE ms."organizationId" = ${this.organizationId}::uuid AND ms."status" = 'SUSPENDED' AND ms."updatedAt" >= now() - interval '2 days'
         AND ${this.sinMensaje(Prisma.sql`'MEMBERSHIP_SUSPENDED:' || ms."id"::text`)}
         AND ${sqlDeSede(Prisma.sql`m."homeBranchId"`, sedes)} LIMIT ${LOTE}`;
  }

  /**
   * Membresías activas, de una semana o más, cuyo periodo termina pronto.
   * `autoRenew`: se renueva sola y ese día nace su cuota (la cuota de un
   * periodo vence el día en que empieza: antes de ese día no hay cargo que
   * recordar, así que el recordatorio sale de la membresía). Sin `autoRenew`:
   * el plan termina y hay que renovarlo en el mostrador.
   */
  porTerminar(hoy: Date, sedes: SedesDelDia | null) {
    return this.db.$queryRaw<Array<{ id: string; memberId: string; homeBranchId: string | null; periodEnd: Date; autoRenew: boolean }>>`
      SELECT ms."id", ms."memberId", m."homeBranchId", ms."currentPeriodEnd" AS "periodEnd", ms."autoRenew"
        FROM "memberships" ms JOIN "plans" p ON p."id" = ms."planId"
        JOIN "members" m ON m."id" = ms."memberId" AND m."deletedAt" IS NULL AND m."phoneE164" IS NOT NULL
       WHERE ms."organizationId" = ${this.organizationId}::uuid AND ms."status" = 'ACTIVE'
         AND p."billingModel" IN ('RECURRING', 'PREPAID_PERIOD') AND (ms."currentPeriodEnd" - ms."currentPeriodStart") >= 7
         AND ms."currentPeriodEnd" > ${hoy}::date AND ms."currentPeriodEnd" <= ${hoy}::date + ${DIAS_DE_ANTICIPACION}::int
         AND ${this.sinMensaje(Prisma.sql`(CASE WHEN ms."autoRenew" THEN 'PAYMENT_DUE_SOON:M:' ELSE 'MEMBERSHIP_ENDING:' END) || ms."id"::text || ':' || to_char(ms."currentPeriodEnd", 'YYYY-MM-DD')`)}
         AND ${sqlDeSede(Prisma.sql`m."homeBranchId"`, sedes)} LIMIT ${LOTE}`;
  }

  /**
   * Cambios de precio recientes (D-19, bloque 3.6) que todavía no tienen su
   * aviso: una fila de `membership_price_changes` por membresía tocada. No
   * depende del día de la sede: el precio cambió para todo el gimnasio a la vez.
   */
  cambiosDePrecio() {
    return this.db.$queryRaw<Array<{ id: string; membershipId: string; memberId: string; homeBranchId: string | null }>>`
      SELECT pc."id", pc."membershipId", pc."memberId", m."homeBranchId"
        FROM "membership_price_changes" pc
        JOIN "members" m ON m."id" = pc."memberId" AND m."organizationId" = pc."organizationId" AND m."deletedAt" IS NULL AND m."phoneE164" IS NOT NULL
        JOIN "memberships" ms ON ms."id" = pc."membershipId" AND ms."status" NOT IN ('CANCELED', 'EXPIRED')
       WHERE pc."organizationId" = ${this.organizationId}::uuid AND pc."createdAt" > now() - make_interval(days => ${DIAS_DE_VIGENCIA}::int)
         AND pc."toPriceCents" <> pc."fromPriceCents"
         AND NOT EXISTS (SELECT 1 FROM "membership_price_changes" n WHERE n."membershipId" = pc."membershipId" AND n."organizationId" = pc."organizationId" AND n."createdAt" > pc."createdAt")
         AND ${this.sinMensaje(Prisma.sql`'PRICE_CHANGE:' || pc."id"::text`)}
       ORDER BY pc."createdAt", pc."id" LIMIT ${LOTE}`;
  }

  /** Socios a los que ya se les resolvió un «te extrañamos» (mandado o descartado) desde `desde`: no se les arma otro tan pronto. */
  async conMensajeReciente(memberIds: readonly string[], desde: Date): Promise<Set<string>> {
    if (memberIds.length === 0) return new Set();
    const filas = await this.db.outboundMessage.findMany({
      where: this.scope({ memberId: { in: [...memberIds] }, kind: 'WE_MISS_YOU', status: { in: ['SENT', 'DISMISSED'] }, resolvedAt: { gte: desde } }),
      select: { memberId: true },
    });
    return new Set(filas.map((f) => f.memberId));
  }
}
