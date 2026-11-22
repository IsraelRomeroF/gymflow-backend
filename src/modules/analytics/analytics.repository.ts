import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * Agregaciones para el tablero.
 *
 * TODO se suma en el MOTOR. Traer cargos y pagos a memoria para sumarlos
 * funciona con datos de demostración y se cae el día que el historial crece;
 * además, el tablero lo abre el dueño desde el teléfono y espera segundos, no
 * minutos.
 */


export type AccruedImmediateRow = { branchId: string | null; amountCents: bigint };

export type PeriodChargeRow = {
  branchId: string | null;
  amountCents: bigint;
  periodStart: Date;
  periodEnd: Date;
};

export type VisitRecognitionRow = {
  branchId: string | null;
  packId: string;
  chargeAmountCents: bigint | null;
  planPriceCents: bigint | null;
  visitsPurchased: number;
  consumedInWindow: number;
  expiredInWindow: number;
};

export type DeferredRow = {
  branchId: string | null;
  packId: string;
  chargeAmountCents: bigint | null;
  planPriceCents: bigint | null;
  visitsPurchased: number;
  consumedTotal: number;
  expiredTotal: number;
};

export type MrrRow = {
  branchId: string | null;
  priceCents: bigint;
  durationUnit: string;
  durationValue: number;
  memberships: number;
};

/** Socio activo: con membresía en uso. Una venta sin pagar (PENDING) aún no lo es (BE2-15). */
const ESTADOS_SOCIO = "('TRIALING','ACTIVE','PAST_DUE','FROZEN')";

export class AnalyticsRepository extends TenantRepository {
  // "Dinero que entró" ya no se calcula aquí: hay UNA definición, la de
  // Movimientos (`dineroQueEntro`), y el Tablero la usa (BE2-15).

  /**
   * Cargos que se ganan EN EL ACTO, emitidos dentro de la ventana.
   * Se excluye `OPENING_BALANCE`: lo ganó el sistema anterior.
   * Se excluye `VISIT_PACK`: se gana al consumirse, no al venderse.
   */
  async accruedImmediate(from: Date, to: Date): Promise<AccruedImmediateRow[]> {
    return this.db.$queryRaw<AccruedImmediateRow[]>`
      SELECT "branchId", SUM("amountCents" - "adjustedCents")::bigint AS "amountCents"
      FROM (
        SELECT c."branchId", c."amountCents", c."adjustedCents"
        FROM "charges" c
        WHERE c."organizationId" = ${this.organizationId}::uuid
          AND c."status" <> 'VOID'
          AND c."chargeType" IN ('DAY_PASS','CLASS_SINGLE','SIGNUP_FEE','NO_SHOW_PENALTY',
                                 'PRORATION_ADJUSTMENT','MANUAL_ADJUSTMENT')
          AND c."dueDate" >= ${from}::date AND c."dueDate" < ${to}::date
        UNION ALL
        SELECT s."branchId", s."totalCents", 0::bigint
        FROM "pos_sales" s
        WHERE s."organizationId" = ${this.organizationId}::uuid
          AND s."status" = 'COMPLETED'
          AND s."businessDate" >= ${from}::date AND s."businessDate" < ${to}::date
      ) t
      GROUP BY "branchId"`;
  }

  /** Cuotas de periodo que SOLAPAN la ventana. El prorrateo lo hace el dominio. */
  async periodCharges(from: Date, to: Date): Promise<PeriodChargeRow[]> {
    return this.db.$queryRaw<PeriodChargeRow[]>`
      SELECT c."branchId",
             (c."amountCents" - c."adjustedCents")::bigint AS "amountCents",
             c."periodStart", c."periodEnd"
      FROM "charges" c
      WHERE c."organizationId" = ${this.organizationId}::uuid
        AND c."chargeType" = 'MEMBERSHIP_PERIOD'
        AND c."status" <> 'VOID'
        AND c."periodStart" IS NOT NULL AND c."periodEnd" IS NOT NULL
        AND c."periodStart" < ${to}::date AND c."periodEnd" > ${from}::date`;
  }

  /**
   * Periodos ya COBRADOS que siguen después de `asOf`: una anualidad pagada
   * es servicio que se debe al socio (UXB-02). Solo la parte pagada.
   */
  async prepaidPeriods(asOf: Date): Promise<PeriodChargeRow[]> {
    return this.db.$queryRaw<PeriodChargeRow[]>`
      SELECT c."branchId", LEAST(c."allocatedCents", c."amountCents" - c."adjustedCents")::bigint AS "amountCents",
             c."periodStart", c."periodEnd"
      FROM "charges" c
      -- Una membresía cancelada o expirada ya no debe servicio a nadie (DM-03).
      JOIN "memberships" ms ON ms."id" = c."membershipId" AND ms."status" NOT IN ('CANCELED','EXPIRED')
      WHERE c."organizationId" = ${this.organizationId}::uuid
        AND c."chargeType" = 'MEMBERSHIP_PERIOD'
        AND c."status" <> 'VOID' AND c."allocatedCents" > 0
        AND c."periodStart" IS NOT NULL AND c."periodEnd" > ${asOf}::date`;
  }

  /**
   * Visitas consumidas y caducadas DENTRO de la ventana, con el importe real
   * del cargo que financió el paquete. `planPriceCents` es el respaldo para
   * los paquetes anteriores al enlace con el cargo.
   */
  async visitRecognition(from: Date, to: Date): Promise<VisitRecognitionRow[]> {
    return this.db.$queryRaw<VisitRecognitionRow[]>`
      SELECT vp."soldAtBranchId" AS "branchId",
             vp."id" AS "packId",
             ch."amountCents" AS "chargeAmountCents",
             pl."priceCents" AS "planPriceCents",
             vp."visitsPurchased",
             COALESCE(SUM(CASE WHEN e."entryType" = 'CONSUME' THEN -e."delta" ELSE 0 END), 0)::int AS "consumedInWindow",
             COALESCE(SUM(CASE WHEN e."entryType" = 'EXPIRE'  THEN -e."delta" ELSE 0 END), 0)::int AS "expiredInWindow"
      FROM "visit_packs" vp
      JOIN "visit_ledger_entries" e ON e."visitPackId" = vp."id"
      LEFT JOIN "charges" ch ON ch."id" = vp."chargeId"
      LEFT JOIN "plans" pl ON pl."id" = vp."planId"
      WHERE vp."organizationId" = ${this.organizationId}::uuid
        AND e."entryType" IN ('CONSUME','EXPIRE')
        AND e."businessDate" >= ${from}::date AND e."businessDate" < ${to}::date
      GROUP BY vp."soldAtBranchId", vp."id", ch."amountCents", pl."priceCents", vp."visitsPurchased"`;
  }

  /** Estado ACUMULADO de cada paquete, para calcular el pasivo diferido. */
  async deferredPacks(): Promise<DeferredRow[]> {
    return this.db.$queryRaw<DeferredRow[]>`
      SELECT vp."id" AS "packId", vp."soldAtBranchId" AS "branchId",
             ch."amountCents" AS "chargeAmountCents",
             pl."priceCents" AS "planPriceCents",
             vp."visitsPurchased",
             COALESCE(SUM(CASE WHEN e."entryType" = 'CONSUME' THEN -e."delta" ELSE 0 END), 0)::int AS "consumedTotal",
             COALESCE(SUM(CASE WHEN e."entryType" = 'EXPIRE'  THEN -e."delta" ELSE 0 END), 0)::int AS "expiredTotal"
      FROM "visit_packs" vp
      LEFT JOIN "visit_ledger_entries" e ON e."visitPackId" = vp."id"
      LEFT JOIN "charges" ch ON ch."id" = vp."chargeId"
      LEFT JOIN "plans" pl ON pl."id" = vp."planId"
      WHERE vp."organizationId" = ${this.organizationId}::uuid
        AND vp."status" <> 'EXPIRED'
      GROUP BY vp."id", vp."soldAtBranchId", ch."amountCents", pl."priceCents", vp."visitsPurchased"`;
  }

  /**
   * Membresías vigentes agrupadas por plan: la base del MRR.
   *
   * El `JOIN` contra `members` con `deletedAt IS NULL` **no es decorativo**.
   * Archivar un socio no cancelaba su membresía, así que al ejecutar la
   * plataforma había 15,073 membresías vivas de socios archivados: el 88% del
   * MRR era ingreso fantasma. El job `membership.close-archived` cierra el
   * hueco en el origen; este filtro es la defensa en profundidad, y seguirá
   * haciendo falta porque la migración de BDKGYM traerá datos con esa forma.
   */
  /**
   * MRR (BE2-15): solo lo que de verdad se cobra cada mes. Cuenta ACTIVE y
   * PAST_DUE (una venta sin pagar o una congelada no es ingreso recurrente),
   * y vale lo que dice su último cargo de periodo menos descuentos, no el
   * precio de lista del plan. Sin cargo todavía, el precio del plan.
   */
  async liveMemberships(): Promise<MrrRow[]> {
    return this.db.$queryRawUnsafe<MrrRow[]>(`
      SELECT m."soldAtBranchId" AS "branchId",
             COALESCE(ult."neto", m."agreedPriceCents", p."priceCents")::bigint AS "priceCents",
             p."durationUnit"::text AS "durationUnit", p."durationValue",
             COUNT(*)::int AS "memberships"
      FROM "memberships" m
      JOIN "plans" p ON p."id" = m."planId"
      JOIN "members" mem ON mem."id" = m."memberId" AND mem."deletedAt" IS NULL
      LEFT JOIN LATERAL (
        SELECT (c."amountCents" - c."adjustedCents") AS "neto"
        FROM "charges" c
        WHERE c."membershipId" = m."id" AND c."chargeType" = 'MEMBERSHIP_PERIOD' AND c."status" <> 'VOID'
        ORDER BY c."periodStart" DESC NULLS LAST, c."createdAt" DESC
        LIMIT 1
      ) ult ON true
      WHERE m."organizationId" = $1::uuid
        AND m."status" IN ('ACTIVE','PAST_DUE')
        AND p."billingModel" IN ('RECURRING','PREPAID_PERIOD')
      GROUP BY 1, 2, 3, 4`,
      this.organizationId);
  }

  /** Sucursales VIVAS. El comparativo no debe listar sedes archivadas. */
  async liveBranchIds(): Promise<Set<string>> {
    const rows = await this.db.branch.findMany({
      where: this.scope({ deletedAt: null }), select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /** Socios con al menos una membresía vigente, por sucursal. */
  async activeMembers(): Promise<Array<{ branchId: string | null; total: number }>> {
    return this.db.$queryRawUnsafe(`
      SELECT m."homeBranchId" AS "branchId", COUNT(DISTINCT m."id")::int AS total
      FROM "members" m
      JOIN "memberships" ms ON ms."memberId" = m."id" AND ms."status" IN ${ESTADOS_SOCIO}
      WHERE m."organizationId" = $1::uuid AND m."deletedAt" IS NULL
      GROUP BY m."homeBranchId"`, this.organizationId);
  }

  /**
   * Socios atrasados (UX5-D-07): con la cuota vencida (PAST_DUE) o ya
   * suspendidos por no pagar. `suspended` aparte porque esos no cuentan como
   * socios vivos y hay que sumarlos a la base para sacar la proporción.
   */
  async membersBehind(): Promise<Array<{ branchId: string | null; behind: number; suspended: number }>> {
    return this.db.$queryRawUnsafe(`
      SELECT m."homeBranchId" AS "branchId",
             COUNT(DISTINCT m."id")::int AS behind,
             COUNT(DISTINCT m."id") FILTER (WHERE ms."status" = 'SUSPENDED')::int AS suspended
      FROM "members" m
      JOIN "memberships" ms ON ms."memberId" = m."id" AND ms."status" IN ('PAST_DUE','SUSPENDED')
      WHERE m."organizationId" = $1::uuid AND m."deletedAt" IS NULL
      GROUP BY m."homeBranchId"`, this.organizationId);
  }

  /** Turnos de caja abiertos ahora mismo. El dueño quiere verlos desde el móvil. */
  async openCashSessions(): Promise<Array<{
    id: string; branchId: string; registerCode: string; openedAt: Date; openingFloatCents: bigint;
  }>> {
    return this.db.$queryRaw`
      SELECT s."id", s."branchId", r."code" AS "registerCode",
             s."openedAt", s."openingFloatCents"
      FROM "cash_sessions" s
      JOIN "cash_registers" r ON r."id" = s."cashRegisterId"
      WHERE s."organizationId" = ${this.organizationId}::uuid AND s."status" = 'OPEN'
      ORDER BY s."openedAt" ASC`;
  }
}
