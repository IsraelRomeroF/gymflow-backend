import { Prisma } from '@gymflow/db';
import { uuidv7 } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

/** Lo que toca un cambio de precio, contado sin recorrer socios. */
export type CuentaDelCambio = {
  touched: number; atList: number; touchedDelta: bigint;
  protegidas: number; protectedDelta: bigint;
  enSedesConPrecioPropio: number; firstPaymentOn: Date | null; sinCelular: number;
};

export type PrecioProtegido = {
  membershipId: string; memberId: string; memberCode: string; firstName: string; lastName: string;
  branchId: string | null; agreedPriceCents: bigint; listPriceCents: bigint; reason: string | null;
};

export type CambioDeMembresia = { id: string; membershipId: string; fromPriceCents: bigint; toPriceCents: bigint; createdAt: Date };

/**
 * CAMBIOS DE PRECIO DE UN PLAN (fase 3 · bloque 3.6 · D-19). Dueño de
 * `plan_price_changes` y `membership_price_changes`, y de las dos columnas de
 * la membresía que son del precio: `agreedPriceCents` cuando lo mueve un
 * cambio de precio, y la marca `priceProtected` («conserva su precio»).
 *
 * A quién toca un cambio del precio de lista: a las membresías VIVAS (ni
 * canceladas ni vencidas) del plan vendidas donde rige ese precio, es decir,
 * en una sucursal sin precio propio escrito (o sin sucursal de venta).
 */
export class PriceChangeRepository extends TenantRepository {
  /** Las membresías vivas del plan con lo que pagan hoy, si rige para ellas el precio de lista y si conservan su precio. */
  private universo(planId: string, fromPriceCents: bigint): Prisma.Sql {
    return Prisma.sql`
      SELECT ms."id", ms."memberId", ms."status", ms."currentPeriodEnd", ms."priceProtected" AS "prot",
             COALESCE(ms."agreedPriceCents", ${fromPriceCents}::bigint) AS "actual",
             NOT EXISTS (SELECT 1 FROM "plan_branch_availability" a
                          WHERE a."planId" = ms."planId" AND a."branchId" = ms."soldAtBranchId" AND a."priceOverrideCents" IS NOT NULL) AS "lista",
             m."phoneE164" AS "phone"
        FROM "memberships" ms
        JOIN "members" m ON m."id" = ms."memberId" AND m."organizationId" = ms."organizationId"
       WHERE ms."organizationId" = ${this.organizationId}::uuid AND ms."planId" = ${planId}::uuid
         AND ms."status" NOT IN ('CANCELED', 'EXPIRED')`;
  }

  /** A cuántos toca y cuánto cambia, ANTES de confirmar. `hoy` es el día del gimnasio. */
  async contar(planId: string, fromPriceCents: bigint, toPriceCents: bigint, hoy: Date): Promise<CuentaDelCambio> {
    const delta = toPriceCents - fromPriceCents;
    const cambio = Prisma.sql`(GREATEST(0, x."actual" + ${delta}::bigint) - x."actual")`;
    const [f] = await this.db.$queryRaw<Array<{
      touched: number; atList: number; touchedDelta: bigint; protegidas: number; protectedDelta: bigint;
      propias: number; first: Date | null; sinCelular: number;
    }>>`
      SELECT COUNT(*) FILTER (WHERE x."lista" AND NOT x."prot")::int AS "touched",
             COUNT(*) FILTER (WHERE x."lista" AND NOT x."prot" AND x."actual" = ${fromPriceCents}::bigint)::int AS "atList",
             COALESCE(SUM(${cambio}) FILTER (WHERE x."lista" AND NOT x."prot"), 0)::bigint AS "touchedDelta",
             COUNT(*) FILTER (WHERE x."lista" AND x."prot")::int AS "protegidas",
             COALESCE(SUM(${cambio}) FILTER (WHERE x."lista" AND x."prot"), 0)::bigint AS "protectedDelta",
             COUNT(*) FILTER (WHERE NOT x."lista")::int AS "propias",
             MIN(x."currentPeriodEnd") FILTER (WHERE x."lista" AND NOT x."prot" AND x."status" IN ('TRIALING', 'ACTIVE', 'PAST_DUE') AND x."currentPeriodEnd" >= ${hoy}::date) AS "first",
             COUNT(*) FILTER (WHERE x."lista" AND NOT x."prot" AND x."phone" IS NULL)::int AS "sinCelular"
        FROM (${this.universo(planId, fromPriceCents)}) x`;
    return {
      touched: f?.touched ?? 0, atList: f?.atList ?? 0, touchedDelta: f?.touchedDelta ?? 0n,
      protegidas: f?.protegidas ?? 0, protectedDelta: f?.protectedDelta ?? 0n,
      enSedesConPrecioPropio: f?.propias ?? 0, firstPaymentOn: f?.first ?? null, sinCelular: f?.sinCelular ?? 0,
    };
  }

  /**
   * APLICA el cambio dentro de la unidad en curso: deja el acto, una fila por
   * membresía tocada (de cuánto a cuánto) y mueve su precio pactado. La que
   * no tenía pactado no se escribe: ya paga el de lista del día de su cuota.
   * No toca `updatedAt`: el precio cambió, la membresía no se movió.
   */
  async aplicar(input: {
    planId: string; fromPriceCents: bigint; toPriceCents: bigint; includeProtected: boolean;
    reason: string; userId: string | null; protectedKept: number;
  }): Promise<{ id: string; touched: number }> {
    const id = uuidv7();
    const delta = input.toPriceCents - input.fromPriceCents;
    // Primero el acto (la fila de cada membresía lo referencia); sus cifras se saben antes de escribir.
    const quienes = Prisma.sql`x."lista" AND (NOT x."prot" OR ${input.includeProtected}::boolean) AND GREATEST(0, x."actual" + ${delta}::bigint) <> x."actual"`;
    // El candado de fila evita que una renovación a la vez lea el precio a medias.
    await this.db.$queryRaw`
      SELECT ms."id" FROM "memberships" ms
       WHERE ms."organizationId" = ${this.organizationId}::uuid AND ms."planId" = ${input.planId}::uuid AND ms."status" NOT IN ('CANCELED', 'EXPIRED')
       FOR UPDATE`;
    const [n] = await this.db.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS "n" FROM (${this.universo(input.planId, input.fromPriceCents)}) x WHERE ${quienes}`;
    const touched = n?.n ?? 0;
    await this.db.planPriceChange.create({
      data: {
        id, organizationId: this.organizationId, planId: input.planId,
        fromPriceCents: input.fromPriceCents, toPriceCents: input.toPriceCents,
        includedProtected: input.includeProtected, touchedCount: touched, protectedKeptCount: input.protectedKept,
        reason: input.reason, createdByUserId: input.userId,
      },
    });
    if (touched === 0) return { id, touched };
    await this.db.$executeRaw`
      INSERT INTO "membership_price_changes" ("id", "organizationId", "planPriceChangeId", "membershipId", "memberId", "fromPriceCents", "toPriceCents", "wasProtected")
      SELECT gen_random_uuid(), ${this.organizationId}::uuid, ${id}::uuid, x."id", x."memberId", x."actual", GREATEST(0, x."actual" + ${delta}::bigint), x."prot"
        FROM (${this.universo(input.planId, input.fromPriceCents)}) x WHERE ${quienes}`;
    await this.db.$executeRaw`
      UPDATE "memberships" ms
         SET "agreedPriceCents" = pc."toPriceCents"
        FROM "membership_price_changes" pc
       WHERE pc."planPriceChangeId" = ${id}::uuid AND pc."membershipId" = ms."id"
         AND ms."organizationId" = ${this.organizationId}::uuid AND ms."agreedPriceCents" IS NOT NULL`;
    return { id, touched };
  }

  /** El último cambio de precio que tocó a una membresía; `null` si ninguno. */
  async ultimoDe(membershipId: string): Promise<CambioDeMembresia | null> {
    const f = await this.db.membershipPriceChange.findFirst({
      where: this.scope({ membershipId }), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, membershipId: true, fromPriceCents: true, toPriceCents: true, createdAt: true },
    });
    return f;
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
