import { uuidv7 } from '@gymflow/core';
import { PrismaRefundStatus, PrismaChargebackStatus } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';

const R = PrismaRefundStatus;
const C = PrismaChargebackStatus;

export type RefundRecord = {
  id: string; paymentId: string; amountCents: bigint;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  reason: string; idempotencyKey: string; createdAt: Date; confirmedAt: Date | null;
};

const SELECT = {
  id: true, paymentId: true, amountCents: true, status: true, reason: true,
  idempotencyKey: true, createdAt: true, confirmedAt: true,
} as const;

export class RefundRepository extends TenantRepository {
  async totalForPayment(paymentId: string): Promise<bigint> {
    const rows = await this.db.$queryRaw<Array<{ total: bigint }>>`
      SELECT COALESCE(SUM("amountCents"), 0)::bigint AS total
      FROM "refunds"
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "paymentId" = ${paymentId}::uuid
        AND "status" <> 'FAILED'`;
    return rows[0]?.total ?? 0n;
  }

  async listForPayment(paymentId: string): Promise<RefundRecord[]> {
    const rows = await this.db.refund.findMany({
      where: this.scope({ paymentId }), select: SELECT, orderBy: { createdAt: 'asc' },
    });
    return rows as RefundRecord[];
  }

  async nextSequence(paymentId: string): Promise<number> {
    return (await this.db.refund.count({ where: this.scope({ paymentId }) })) + 1;
  }

  /** Se abre ANTES de llamar al proveedor, igual que el intento de cobro. */
  async open(input: {
    paymentId: string; branchId: string | null; amountCents: bigint;
    reason: string; idempotencyKey: string; createdByUserId: string | null;
  }): Promise<RefundRecord | null> {
    try {
      const row = await this.db.refund.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          paymentId: input.paymentId,
          branchId: input.branchId,
          amountCents: input.amountCents,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          createdByUserId: input.createdByUserId,
        },
        select: SELECT,
      });
      return row as RefundRecord;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async settle(id: string, externalReference: string): Promise<void> {
    await this.db.refund.updateMany({
      where: this.scope({ id }),
      data: { status: R.SUCCEEDED, externalReference, confirmedAt: new Date() },
    });
  }

  async fail(id: string): Promise<void> {
    await this.db.refund.updateMany({ where: this.scope({ id }), data: { status: R.FAILED } });
  }

  // ── Contracargos ──────────────────────────────────────────────────────────

  async openChargeback(input: {
    paymentId: string; amountCents: bigint; providerCaseId: string | null;
    reasonCode: string | null; openedAt: Date; dueByAt: Date | null;
  }): Promise<{ id: string } | null> {
    try {
      return await this.db.chargeback.create({
        data: { id: uuidv7(), organizationId: this.organizationId, ...input },
        select: { id: true },
      });
    } catch (err) {
      // Ya estaba abierto: el proveedor reenvía el evento de la disputa.
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async listChargebacks(limit = 50): Promise<Array<{
    id: string; paymentId: string; amountCents: bigint; status: string;
    reasonCode: string | null; openedAt: Date; dueByAt: Date | null;
  }>> {
    return this.db.chargeback.findMany({
      where: this.scope({}),
      select: {
        id: true, paymentId: true, amountCents: true, status: true,
        reasonCode: true, openedAt: true, dueByAt: true,
      },
      orderBy: { openedAt: 'desc' },
      take: limit,
    });
  }

  async resolveChargeback(id: string, status: 'WON' | 'LOST' | 'ACCEPTED'): Promise<void> {
    await this.db.chargeback.updateMany({
      where: this.scope({ id }), data: { status: C[status], resolvedAt: new Date() },
    });
  }
}
