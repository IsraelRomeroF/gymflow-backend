import { uuidv7 } from '@gymflow/core';
import { PrismaBillingCycleStatus } from '@gymflow/db';
import { sqlDeSede } from '../../platform/db/filtro-de-sede.js';
import type { SedesDelDia } from '../../platform/time/business-calendar.js';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';

const S = PrismaBillingCycleStatus;

export type BillingCycleRecord = {
  id: string;
  runDate: Date;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  chargesCreated: number;
  chargesSkipped: number;
  amountCents: bigint;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
};

const SELECT = {
  id: true, runDate: true, status: true, chargesCreated: true,
  chargesSkipped: true, amountCents: true, startedAt: true,
  finishedAt: true, error: true,
} as const;

export type PendingPeriodCharge = {
  membershipId: string;
  memberId: string;
  periodStart: Date;
};

export class BillingCycleRepository extends TenantRepository {
  /**
   * Abre la corrida del día, o devuelve la que ya existe.
   *
   * El índice parcial `billing_cycles_one_valid_per_day` garantiza que solo
   * haya una corrida válida por día: si dos ejecuciones arrancan a la vez,
   * la segunda choca y reutiliza la primera en vez de generar cargos en
   * paralelo contra las mismas membresías.
   */
  async start(runDate: Date): Promise<{ cycle: BillingCycleRecord; created: boolean }> {
    // A diferencia de los cargos, aquí SÍ se consulta antes de insertar. La
    // corrida es un registro de coordinación, no dinero: el `catch` de abajo
    // sigue siendo la barrera real, y esta consulta solo evita que el reintento
    // normal de cada día deje un error de violación de unicidad en el log de
    // operación, donde un ruido recurrente acaba escondiendo el fallo de verdad.
    const previa = await this.db.billingCycle.findFirst({
      where: this.scope({ runDate, status: { not: S.FAILED } }),
      select: SELECT,
    });
    if (previa) return { cycle: previa as BillingCycleRecord, created: false };

    try {
      const row = await this.db.billingCycle.create({
        data: { id: uuidv7(), organizationId: this.organizationId, runDate, status: S.RUNNING },
        select: SELECT,
      });
      return { cycle: row as BillingCycleRecord, created: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.db.billingCycle.findFirst({
        where: this.scope({ runDate, status: { not: S.FAILED } }),
        select: SELECT,
      });
      if (!existing) throw err;
      return { cycle: existing as BillingCycleRecord, created: false };
    }
  }

  /**
   * Cierra la corrida ACUMULANDO, nunca reemplazando.
   *
   * Una segunda ejecución el mismo día reutiliza la corrida del día (el índice
   * parcial solo permite una válida). Si escribiera los totales en vez de
   * sumarlos, la segunda pasada —que normalmente genera cero— borraría el
   * registro de lo que la primera sí generó, y la corrida dejaría de poder
   * responder "¿de dónde salió este cargo?", que es su única razón de existir.
   *
   * `startedAt` se queda en la primera pasada y `finishedAt` avanza con la
   * última: la corrida es EL DÍA, no una invocación concreta.
   */
  async complete(id: string, totals: {
    chargesCreated: number; chargesSkipped: number; amountCents: bigint;
  }): Promise<void> {
    await this.db.billingCycle.updateMany({
      where: this.scope({ id }),
      data: {
        chargesCreated: { increment: totals.chargesCreated },
        chargesSkipped: { increment: totals.chargesSkipped },
        amountCents: { increment: totals.amountCents },
        status: S.COMPLETED,
        finishedAt: new Date(),
      },
    });
  }

  async fail(id: string, error: string): Promise<void> {
    await this.db.billingCycle.updateMany({
      where: this.scope({ id }),
      data: { status: S.FAILED, finishedAt: new Date(), error: error.slice(0, 500) },
    });
  }

  async findByRunDate(runDate: Date): Promise<BillingCycleRecord | null> {
    const row = await this.db.billingCycle.findFirst({
      where: this.scope({ runDate }), select: SELECT, orderBy: { startedAt: 'desc' },
    });
    return row as BillingCycleRecord | null;
  }

  /**
   * Membresías cuyo periodo en curso ya empezó y todavía NO tiene su cuota.
   *
   * El `NOT EXISTS` se apoya en el índice `(membershipId, periodStart)`: es la
   * misma pareja que define la idempotencia, así que la consulta y la barrera
   * hablan del mismo hecho y no pueden desincronizarse.
   *
   * Un cargo ANULADO no cuenta como existente: anular una cuota emitida por
   * error debe permitir volver a emitirla.
   */
  async membershipsNeedingPeriodCharge(day: Date, limit: number, sedes: SedesDelDia | null = null): Promise<PendingPeriodCharge[]> {
    return this.db.$queryRaw<PendingPeriodCharge[]>`
      SELECT m."id" AS "membershipId", m."memberId", m."currentPeriodStart" AS "periodStart"
      FROM "memberships" m
      WHERE m."organizationId" = ${this.organizationId}::uuid
        AND m."status" IN ('PENDING','TRIALING','ACTIVE','PAST_DUE')
        AND m."currentPeriodStart" <= ${day}::date
        AND ${sqlDeSede('m."soldAtBranchId"', sedes)}
        AND NOT EXISTS (
          SELECT 1 FROM "charges" c
          WHERE c."organizationId" = m."organizationId"
            AND c."membershipId" = m."id"
            AND c."chargeType" = 'MEMBERSHIP_PERIOD'
            AND c."periodStart" = m."currentPeriodStart"
            AND c."status" <> 'VOID'
        )
      ORDER BY m."currentPeriodStart" ASC, m."id" ASC
      LIMIT ${limit}`;
  }

  /**
   * Membresías VIGENTES que ya deben una cuota o inscripción vencida.
   *
   * Es el disparador real de la mora: antes bastaba con que terminara el
   * periodo, aunque nunca se hubiera emitido la cuota siguiente. Devuelve el
   * vencimiento más antiguo, desde el que se cuenta la gracia.
   */
  async membershipsWithOverdueDues(day: Date, limit: number, sedes: SedesDelDia | null = null): Promise<Array<{ membershipId: string; oldestDueDate: Date }>> {
    return this.db.$queryRaw<Array<{ membershipId: string; oldestDueDate: Date }>>`
      SELECT m."id" AS "membershipId", MIN(c."dueDate") AS "oldestDueDate"
      FROM "memberships" m
      JOIN "charges" c
        ON c."organizationId" = m."organizationId" AND c."membershipId" = m."id"
      WHERE m."organizationId" = ${this.organizationId}::uuid
        AND m."status" = 'ACTIVE'
        AND c."chargeType" IN ('MEMBERSHIP_PERIOD','SIGNUP_FEE')
        AND c."status" IN ('OPEN','PARTIALLY_PAID','OVERDUE')
        AND c."dueDate" < ${day}::date
        AND ${sqlDeSede('m."soldAtBranchId"', sedes)}
      GROUP BY m."id"
      ORDER BY m."id" ASC
      LIMIT ${limit}`;
  }

  /**
   * Reconcilia el saldo CACHEADO de todos los socios contra el derivado real.
   *
   * Se hace en una sola sentencia en el motor, no socio por socio: con 3,000
   * socios, 3,000 idas y vueltas convertirían un job de segundos en uno de
   * minutos. Devuelve cuántos estaban DESVIADOS, que es la métrica que
   * interesa vigilar: si deja de ser cero de forma sostenida, hay un camino
   * de escritura que no está actualizando la caché.
   */
  async reconcileCachedBalances(): Promise<number> {
    return this.db.$executeRaw`
      UPDATE "members" m
      SET "balanceCentsCached" = calc."neto", "balanceComputedAt" = now()
      FROM (
        SELECT mm."id",
               COALESCE(d."total", 0) - COALESCE(p."total", 0) AS "neto"
        FROM "members" mm
        LEFT JOIN (
          SELECT c."memberId",
                 SUM(c."amountCents" - c."allocatedCents" - c."adjustedCents") AS "total"
          FROM "charges" c
          WHERE c."organizationId" = ${this.organizationId}::uuid
            AND c."status" IN ('OPEN','PARTIALLY_PAID','OVERDUE')
          GROUP BY c."memberId"
        ) d ON d."memberId" = mm."id"
        LEFT JOIN (
          SELECT pp."memberId",
                 SUM(CASE WHEN pp."amountCents" < 0 THEN -pp."unappliedCents" ELSE pp."unappliedCents" END) AS "total"
          FROM "payments" pp
          WHERE pp."organizationId" = ${this.organizationId}::uuid
            AND pp."status" IN ('SUCCEEDED','REVERSED')
          GROUP BY pp."memberId"
        ) p ON p."memberId" = mm."id"
        WHERE mm."organizationId" = ${this.organizationId}::uuid
      ) calc
      WHERE m."id" = calc."id"
        AND m."balanceCentsCached" IS DISTINCT FROM calc."neto"`;
  }
}
