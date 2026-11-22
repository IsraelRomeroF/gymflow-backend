import {
  uuidv7, money, deriveChargeStatus,
  type ChargeType, type ChargeStatus, type AdjustmentType, type CuotaDePeriodo, notFound } from '@gymflow/core';
import { PrismaChargeType, PrismaChargeStatus, PrismaAdjustmentType } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { dondeSede } from '../../platform/db/filtro-de-sede.js';
import type { SedesDelDia } from '../../platform/time/business-calendar.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';

const T = PrismaChargeType;
const S = PrismaChargeStatus;
/** Cargos que cuentan como deuda viva. Espejo de `countsAsDebt` del dominio. */
const DEBT = [S.OPEN, S.PARTIALLY_PAID, S.OVERDUE];

export type ChargeRecord = {
  id: string;
  memberId: string;
  membershipId: string | null;
  branchId: string | null;
  billingCycleId: string | null;
  chargeType: ChargeType;
  status: ChargeStatus;
  concept: string;
  subtotalCents: bigint;
  taxCents: bigint;
  discountCents: bigint;
  amountCents: bigint;
  allocatedCents: bigint;
  adjustedCents: bigint;
  periodStart: Date | null;
  periodEnd: Date | null;
  issuedAt: Date | null;
  dueDate: Date;
  idempotencyKey: string | null;
  voidReason: string | null;
  writeOffReason: string | null;
  createdAt: Date;
};

const SELECT = {
  id: true, memberId: true, membershipId: true, branchId: true, billingCycleId: true,
  chargeType: true, status: true, concept: true,
  subtotalCents: true, taxCents: true, discountCents: true, amountCents: true,
  allocatedCents: true, adjustedCents: true,
  periodStart: true, periodEnd: true, issuedAt: true, dueDate: true,
  idempotencyKey: true, voidReason: true, writeOffReason: true, createdAt: true,
} as const;

export type ChargeInput = {
  memberId: string;
  membershipId?: string | null;
  branchId?: string | null;
  billingCycleId?: string | null;
  chargeType: ChargeType;
  concept: string;
  subtotalCents: bigint;
  taxCents?: bigint;
  discountCents?: bigint;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  dueDate: Date;
  idempotencyKey?: string | null;
  createdByUserId?: string | null;
};

export type AdjustmentRecord = {
  id: string;
  chargeId: string;
  adjustmentType: AdjustmentType;
  amountCents: bigint;
  reason: string;
  reasonCode: string | null;
  approvedByUserId: string | null;
  createdAt: Date;
};

/** Estado derivado del saldo. La base guarda el resultado; la verdad es esta. */
function statusOf(c: ChargeRecord, today: Date): ChargeStatus {
  return deriveChargeStatus({
    amountTotal: money(c.amountCents),
    allocated: money(c.allocatedCents),
    adjusted: money(c.adjustedCents),
    issued: c.issuedAt !== null,
    dueDate: c.dueDate,
    today,
    voided: c.voidReason !== null,
    writtenOff: c.writeOffReason !== null,
  });
}

export class ChargeRepository extends TenantRepository {
  async findById(id: string): Promise<ChargeRecord | null> {
    const row = await this.db.charge.findFirst({ where: this.scope({ id }), select: SELECT });
    return row as ChargeRecord | null;
  }

  async findByIdempotencyKey(key: string): Promise<ChargeRecord | null> {
    const row = await this.db.charge.findFirst({ where: this.scope({ idempotencyKey: key }), select: SELECT });
    return row as ChargeRecord | null;
  }

  async listForMember(memberId: string, opts: { limit?: number | undefined } = {}): Promise<ChargeRecord[]> {
    const rows = await this.db.charge.findMany({
      where: this.scope({ memberId }),
      select: SELECT,
      orderBy: [{ dueDate: 'desc' }, { id: 'desc' }],
      take: opts.limit ?? 100,
    });
    return rows as ChargeRecord[];
  }

  /** Deuda viva del socio, de la MÁS ANTIGUA a la más nueva. */
  async listOutstanding(memberId: string): Promise<ChargeRecord[]> {
    const rows = await this.db.charge.findMany({
      where: this.scope({ memberId, status: { in: DEBT } }),
      select: SELECT,
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    });
    return rows as ChargeRecord[];
  }

  /**
   * Alta idempotente.
   *
   * No se consulta antes de insertar: se INSERTA y se atrapa la violación de
   * unicidad. Consultar primero deja una rendija entre el SELECT y el INSERT
   * por la que dos ejecuciones simultáneas del job pasan las dos.
   */
  async create(input: ChargeInput): Promise<{ charge: ChargeRecord; created: boolean }> {
    const tax = input.taxCents ?? 0n;
    const discount = input.discountCents ?? 0n;
    const amount = input.subtotalCents + tax - discount;

    try {
      const row = await this.db.charge.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          memberId: input.memberId,
          membershipId: input.membershipId ?? null,
          branchId: input.branchId ?? null,
          billingCycleId: input.billingCycleId ?? null,
          chargeType: T[input.chargeType],
          status: S.OPEN,
          concept: input.concept,
          subtotalCents: input.subtotalCents,
          taxCents: tax,
          discountCents: discount,
          amountCents: amount,
          periodStart: input.periodStart ?? null,
          periodEnd: input.periodEnd ?? null,
          issuedAt: new Date(),
          dueDate: input.dueDate,
          idempotencyKey: input.idempotencyKey ?? null,
          createdByUserId: input.createdByUserId ?? null,
        },
        select: SELECT,
      });
      return { charge: row as ChargeRecord, created: true };
    } catch (err) {
      if (isUniqueViolation(err) && input.idempotencyKey) {
        const existing = await this.findByIdempotencyKey(input.idempotencyKey);
        if (existing) return { charge: existing, created: false };
      }
      throw err;
    }
  }

  /**
   * Ajuste de una obligación. Append-only: el importe original NO se toca, se
   * mueve `adjustedCents`. Quien lo autorizó queda en el asiento.
   */
  async adjust(input: {
    chargeId: string;
    adjustmentType: AdjustmentType;
    amountCents: bigint;
    reason: string;
    reasonCode?: string | null;
    approvedByUserId?: string | null;
    createdByUserId?: string | null;
    today: Date;
  }): Promise<ChargeRecord> {
    return this.db.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "charges"
        WHERE "id" = ${input.chargeId}::uuid AND "organizationId" = ${this.organizationId}::uuid
        FOR UPDATE`;
      if (!locked) throw notFound('Cargo no encontrado');

      await tx.chargeAdjustment.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          chargeId: input.chargeId,
          adjustmentType: PrismaAdjustmentType[input.adjustmentType],
          amountCents: input.amountCents,
          reason: input.reason,
          reasonCode: input.reasonCode ?? null,
          approvedByUserId: input.approvedByUserId ?? null,
          createdByUserId: input.createdByUserId ?? null,
        },
      });

      const updated = await tx.charge.update({
        where: { id: input.chargeId },
        data: { adjustedCents: { increment: input.amountCents } },
        select: SELECT,
      });

      const status = statusOf(updated as ChargeRecord, input.today);
      const final = await tx.charge.update({
        where: { id: input.chargeId },
        data: { status: S[status] },
        select: SELECT,
      });
      return final as ChargeRecord;
    });
  }

  async listAdjustments(chargeId: string): Promise<AdjustmentRecord[]> {
    const rows = await this.db.chargeAdjustment.findMany({
      where: this.scope({ chargeId }),
      select: {
        id: true, chargeId: true, adjustmentType: true, amountCents: true,
        reason: true, reasonCode: true, approvedByUserId: true, createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows as AdjustmentRecord[];
  }

  /**
   * Anulación: el cargo nunca debió existir (error de captura).
   * Distinta de la condonación, donde la deuda SÍ existía y se perdona.
   */
  /**
   * Anula SOLO si no tiene pagos aplicados; si los tiene devuelve null y no
   * toca nada (la base también lo impide con un CHECK). Acotada a la
   * organización: antes actualizaba por id a secas.
   */
  /**
   * Al cerrar una membresía (cancelada o venta nunca cobrada), sus cuotas SIN
   * ningún pago dejan de ser deuda (DM-03). Lo parcialmente pagado se queda:
   * eso es una decisión de la gerencia (condonar con firma o seguir cobrando).
   */
  async voidUnpaidForMembership(membershipId: string, reason: string): Promise<number> {
    const { count } = await this.db.charge.updateMany({
      where: this.scope({ membershipId, allocatedCents: 0n, status: { in: [S.OPEN, S.OVERDUE] } }),
      data: { status: S.VOID, voidedAt: new Date(), voidReason: reason },
    });
    return count;
  }

  async voidCharge(id: string, reason: string): Promise<ChargeRecord | null> {
    const { count } = await this.db.charge.updateMany({
      where: this.scope({ id, allocatedCents: 0n, status: { not: S.VOID } }),
      data: { status: S.VOID, voidedAt: new Date(), voidReason: reason },
    });
    if (count === 0) return null;
    return this.findById(id);
  }

  async writeOff(id: string, reason: string): Promise<ChargeRecord> {
    const row = await this.db.charge.update({
      where: { id, organizationId: this.organizationId },
      data: { status: S.WRITTEN_OFF, writtenOffAt: new Date(), writeOffReason: reason },
      select: SELECT,
    });
    return row as ChargeRecord;
  }

  /** Lote de cargos vencidos pendientes de marcar. Lo consume el job diario. */
  async findDueForOverdue(today: Date, limit: number, sedes: SedesDelDia | null = null): Promise<ChargeRecord[]> {
    const rows = await this.db.charge.findMany({
      where: this.scope({ status: { in: [S.OPEN, S.PARTIALLY_PAID] }, dueDate: { lt: today }, AND: dondeSede('branchId', sedes) }),
      select: SELECT,
      orderBy: { dueDate: 'asc' },
      take: limit,
    });
    return rows as ChargeRecord[];
  }

  async markOverdue(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.db.charge.updateMany({
      where: this.scope({ id: { in: ids }, status: { in: [S.OPEN, S.PARTIALLY_PAID] } }),
      data: { status: S.OVERDUE },
    });
    return res.count;
  }

  /** Deuda total viva del socio, calculada por el motor (no en memoria). */
  /**
   * ¿La membresía todavía debe su inscripción o alguna cuota hasta el periodo
   * indicado? Es la condición para que un cobro la active: liquidar solo la
   * inscripción no puede dar un mes de acceso con la cuota pendiente.
   */
  async membershipHasOpenDues(membershipId: string, upToPeriodStart: Date): Promise<boolean> {
    const n = await this.db.charge.count({
      where: this.scope({
        membershipId,
        chargeType: { in: [T.MEMBERSHIP_PERIOD, T.SIGNUP_FEE] },
        status: { in: DEBT },
        OR: [{ periodStart: null }, { periodStart: { lte: upToPeriodStart } }],
      }),
    });
    return n > 0;
  }

  /**
   * Lo mínimo para abrir la puerta (MC-22): la cuota de periodo más vieja sin
   * pagar y cuántos periodos debe. Quien trae solo un mes, paga ese mes y entra;
   * el resto lo decide en la ficha ("Decidir adeudo").
   */
  async oldestOpenPeriod(memberId: string): Promise<{ minimumCents: bigint; periodsOwed: number } | null> {
    const rows = await this.db.$queryRaw<Array<{ balance: bigint; periodos: number }>>`
      SELECT (SELECT ("amountCents" - "allocatedCents" - "adjustedCents") FROM "charges"
               WHERE "organizationId" = ${this.organizationId}::uuid AND "memberId" = ${memberId}::uuid
                 AND "chargeType" = 'MEMBERSHIP_PERIOD' AND "status" IN ('OPEN','PARTIALLY_PAID','OVERDUE')
               ORDER BY "dueDate" ASC LIMIT 1)::bigint AS balance,
             (SELECT COUNT(*) FROM "charges"
               WHERE "organizationId" = ${this.organizationId}::uuid AND "memberId" = ${memberId}::uuid
                 AND "chargeType" = 'MEMBERSHIP_PERIOD' AND "status" IN ('OPEN','PARTIALLY_PAID','OVERDUE'))::int AS periodos`;
    const r = rows[0];
    if (!r || r.balance === null || r.periodos === 0) return null;
    return { minimumCents: r.balance, periodsOwed: r.periodos };
  }

  /**
   * Las cuotas de periodo de una membresía COMO ESTABAN en un instante: lo
   * aplicado y lo ajustado hasta entonces. Es lo que permite que un
   * comprobante reimpreso diga hasta dónde quedó pagado CON ESE pago, no con
   * los que vinieron después (3-01 en el recibo).
   */
  async cuotasAlMomento(membershipId: string, at: Date): Promise<CuotaDePeriodo[]> {
    const rows = await this.db.$queryRaw<Array<{
      periodStart: Date; periodEnd: Date; status: string; amountCents: bigint; allocated: bigint; adjusted: bigint;
    }>>`
      SELECT c."periodStart", c."periodEnd", c."status"::text AS status, c."amountCents",
             COALESCE((SELECT SUM(pa."amountCents") FROM "payment_allocations" pa
                        WHERE pa."chargeId" = c."id" AND pa."createdAt" <= ${at}), 0)::bigint AS allocated,
             COALESCE((SELECT SUM(a."amountCents") FROM "charge_adjustments" a
                        WHERE a."chargeId" = c."id" AND a."createdAt" <= ${at}), 0)::bigint AS adjusted
        FROM "charges" c
       WHERE c."organizationId" = ${this.organizationId}::uuid AND c."membershipId" = ${membershipId}::uuid
         AND c."chargeType" = 'MEMBERSHIP_PERIOD' AND c."createdAt" <= ${at}
         AND c."periodStart" IS NOT NULL AND c."periodEnd" IS NOT NULL`;
    return rows.map((r) => ({
      periodStart: r.periodStart, periodEnd: r.periodEnd,
      // Solo importa si se anuló o castigó; lo demás lo decide el saldo de entonces.
      status: (r.status === 'VOID' || r.status === 'WRITTEN_OFF' ? r.status : 'OPEN') as ChargeStatus,
      amountCents: r.amountCents, allocatedCents: r.allocated, adjustedCents: r.adjusted,
    }));
  }

  async outstandingTotalCents(memberId: string): Promise<bigint> {
    const rows = await this.db.$queryRaw<Array<{ total: bigint | null }>>`
      SELECT COALESCE(SUM("amountCents" - "allocatedCents" - "adjustedCents"), 0)::bigint AS total
      FROM "charges"
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "memberId" = ${memberId}::uuid
        AND "status" IN ('OPEN','PARTIALLY_PAID','OVERDUE')`;
    return rows[0]?.total ?? 0n;
  }
}
