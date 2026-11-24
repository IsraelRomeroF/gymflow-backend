import { uuidv7, type PaymentMethodType } from '@gymflow/core';
import { PrismaInventoryMovementType, PrismaPaymentMethodType } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * CORREGIR UNA VENTA DE TIENDA (D-13, bloque 3.5): la marca «por corregir»
 * (`pos_sale_flags`) y la devolución de otro día (`pos_sale_returns`).
 */
export type FlagRecord = {
  id: string; posSaleId: string; branchId: string; reason: string;
  flaggedByUserId: string; flaggedAt: Date;
  resolution: string | null; resolvedByUserId: string | null; resolvedAt: Date | null; resolutionNote: string | null;
};
export type ReturnRecord = {
  id: string; posSaleId: string; branchId: string; amountCents: bigint; method: PaymentMethodType;
  cashSessionId: string | null; returnRef: string | null; reason: string;
  approvedByUserId: string; createdByUserId: string; businessDate: Date; createdAt: Date;
};

const FLAG = {
  id: true, posSaleId: true, branchId: true, reason: true, flaggedByUserId: true, flaggedAt: true,
  resolution: true, resolvedByUserId: true, resolvedAt: true, resolutionNote: true,
} as const;
const RET = {
  id: true, posSaleId: true, branchId: true, amountCents: true, method: true, cashSessionId: true, returnRef: true,
  reason: true, approvedByUserId: true, createdByUserId: true, businessDate: true, createdAt: true,
} as const;

export class PosCorrectionRepository extends TenantRepository {
  async flagOf(posSaleId: string): Promise<FlagRecord | null> {
    return this.db.posSaleFlag.findFirst({ where: this.scope({ posSaleId }), select: FLAG });
  }

  async flagsOf(posSaleIds: readonly string[]): Promise<Map<string, FlagRecord>> {
    if (posSaleIds.length === 0) return new Map();
    const rows = await this.db.posSaleFlag.findMany({ where: this.scope({ posSaleId: { in: [...posSaleIds] } }), select: FLAG });
    return new Map(rows.map((r) => [r.posSaleId, r]));
  }

  /** Marca la venta; si ya tenía una marca resuelta, la reabre (una fila por venta). */
  async flag(input: { posSaleId: string; branchId: string; reason: string; userId: string }): Promise<FlagRecord> {
    return this.db.posSaleFlag.upsert({
      where: { posSaleId: input.posSaleId },
      create: { id: uuidv7(), organizationId: this.organizationId, posSaleId: input.posSaleId, branchId: input.branchId, reason: input.reason, flaggedByUserId: input.userId },
      update: { reason: input.reason, flaggedByUserId: input.userId, flaggedAt: new Date(), resolution: null, resolvedByUserId: null, resolvedAt: null, resolutionNote: null },
      select: FLAG,
    });
  }

  /** Cierra la marca abierta de esa venta, si la tiene. */
  async resolve(posSaleId: string, resolution: 'VOIDED' | 'RETURNED' | 'DISMISSED', userId: string, note: string | null): Promise<boolean> {
    const r = await this.db.posSaleFlag.updateMany({
      where: this.scope({ posSaleId, resolvedAt: null }),
      data: { resolution, resolvedByUserId: userId, resolvedAt: new Date(), resolutionNote: note },
    });
    return r.count > 0;
  }

  /** Las ventas que siguen «por corregir», de una sede o de las que se indiquen (`null` = todo el gimnasio). */
  async openFlags(branchIds: readonly string[] | null, limit = 100): Promise<FlagRecord[]> {
    return this.db.posSaleFlag.findMany({
      where: this.scope({ resolvedAt: null, ...(branchIds ? { branchId: { in: [...branchIds] } } : {}) }),
      select: FLAG, orderBy: { flaggedAt: 'asc' }, take: limit,
    });
  }

  async returnOf(posSaleId: string): Promise<ReturnRecord | null> {
    return this.db.posSaleReturn.findFirst({ where: this.scope({ posSaleId }), select: RET }) as Promise<ReturnRecord | null>;
  }

  async returnsOf(posSaleIds: readonly string[]): Promise<Map<string, ReturnRecord>> {
    if (posSaleIds.length === 0) return new Map();
    const rows = await this.db.posSaleReturn.findMany({ where: this.scope({ posSaleId: { in: [...posSaleIds] } }), select: RET });
    return new Map((rows as ReturnRecord[]).map((r) => [r.posSaleId, r]));
  }

  /**
   * La devolución y el producto de vuelta al inventario, en una transacción.
   * El índice único por venta impide devolverla dos veces aunque dos personas
   * lo intenten a la vez.
   */
  async createReturn(input: {
    posSaleId: string; branchId: string; amountCents: bigint; method: PaymentMethodType;
    cashSessionId: string | null; returnRef: string | null; reason: string;
    approvedByUserId: string; createdByUserId: string; businessDate: Date;
    restock: ReadonlyArray<{ productId: string; quantity: number }>;
  }): Promise<ReturnRecord> {
    return this.db.$transaction(async (tx) => {
      const row = await tx.posSaleReturn.create({
        data: {
          id: uuidv7(), organizationId: this.organizationId, posSaleId: input.posSaleId, branchId: input.branchId,
          amountCents: input.amountCents, method: PrismaPaymentMethodType[input.method], cashSessionId: input.cashSessionId,
          returnRef: input.returnRef, reason: input.reason, approvedByUserId: input.approvedByUserId,
          createdByUserId: input.createdByUserId, businessDate: input.businessDate,
        },
        select: RET,
      });
      for (const l of input.restock) {
        await tx.$executeRaw`
          INSERT INTO "inventory_stock" ("organizationId", "branchId", "productId", "quantityOnHand", "updatedAt")
          VALUES (${this.organizationId}::uuid, ${input.branchId}::uuid, ${l.productId}::uuid, 0, now())
          ON CONFLICT ("branchId", "productId") DO NOTHING`;
        await tx.$executeRaw`
          UPDATE "inventory_stock" SET "quantityOnHand" = "quantityOnHand" + ${l.quantity}, "updatedAt" = now()
          WHERE "organizationId" = ${this.organizationId}::uuid AND "branchId" = ${input.branchId}::uuid AND "productId" = ${l.productId}::uuid`;
        await tx.inventoryMovement.create({
          data: {
            id: uuidv7(), organizationId: this.organizationId, branchId: input.branchId, productId: l.productId,
            // El mismo tipo que la anulación: el producto de una venta que regresa al estante.
            movementType: PrismaInventoryMovementType.SALE_VOIDED, quantityDelta: l.quantity,
            reason: `Devolución de venta: ${input.reason}`.slice(0, 300), posSaleId: input.posSaleId,
            createdByUserId: input.createdByUserId, businessDate: input.businessDate,
          },
        });
      }
      return row as ReturnRecord;
    });
  }

  /** Lo devuelto con dinero de ESE turno, por método: resta en su corte. */
  async returnTotalsForSession(cashSessionId: string): Promise<Array<{ method: PaymentMethodType; amountCents: bigint }>> {
    const rows = await this.db.posSaleReturn.groupBy({ by: ['method'], where: this.scope({ cashSessionId }), _sum: { amountCents: true } });
    return rows.map((r) => ({ method: r.method as PaymentMethodType, amountCents: r._sum.amountCents ?? 0n }));
  }

  /** Lo devuelto en un rango de días de negocio, por día y sede: es lo que resta en Movimientos el día en que se devolvió. */
  async returnedByDay(from: Date, to: Date, branchIds: readonly string[] | null): Promise<Array<{ businessDate: Date; branchId: string; amountCents: bigint; count: number }>> {
    const rows = await this.db.posSaleReturn.groupBy({
      by: ['businessDate', 'branchId'],
      where: this.scope({ businessDate: { gte: from, lt: to }, ...(branchIds ? { branchId: { in: [...branchIds] } } : {}) }),
      _sum: { amountCents: true }, _count: { _all: true },
    });
    return rows.map((r) => ({ businessDate: r.businessDate, branchId: r.branchId, amountCents: r._sum.amountCents ?? 0n, count: r._count._all }));
  }
}
