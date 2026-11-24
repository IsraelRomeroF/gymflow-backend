import {
  uuidv7,
  type InventoryMovementType, type PaymentMethodType, type PosSaleStatus, type SaleLine,
} from '@gymflow/core';
import {
  PrismaInventoryMovementType, PrismaPaymentMethodType, PrismaPosSaleStatus,
} from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

const S = PrismaPosSaleStatus;
const M = PrismaPaymentMethodType;
const I = PrismaInventoryMovementType;

export type PosSaleRecord = {
  id: string;
  branchId: string;
  cashSessionId: string;
  memberId: string | null;
  status: PosSaleStatus;
  totalCents: bigint;
  method: PaymentMethodType | null;
  chargeId: string | null;
  folio: string | null;
  voidReason: string | null;
  soldByUserId: string;
  soldAt: Date;
  businessDate: Date;
};

const SELECT = {
  id: true, branchId: true, cashSessionId: true, memberId: true, status: true,
  totalCents: true, method: true, chargeId: true, folio: true,
  voidReason: true, soldByUserId: true, soldAt: true, businessDate: true,
} as const;

export type PosSaleLineRecord = {
  id: string;
  productId: string;
  quantity: number;
  unitPriceCents: bigint;
  lineTotalCents: bigint;
  /** PUBLIC · MEMBER: a qué precio salió (D-21). */
  priceKind: string;
};

/** Lo que la venta deja escrito de cada línea además del precio (D-21): a qué precio salió y lo que costaba ese día. */
export type DatosDeLinea = { priceKind: 'PUBLIC' | 'MEMBER'; unitCostCents: bigint | null };

export class PosSaleRepository extends TenantRepository {
  async findById(id: string): Promise<PosSaleRecord | null> {
    const row = await this.db.posSale.findFirst({ where: this.scope({ id }), select: SELECT });
    return row as PosSaleRecord | null;
  }

  async findByIdempotencyKey(key: string): Promise<PosSaleRecord | null> {
    const row = await this.db.posSale.findFirst({ where: this.scope({ idempotencyKey: key }), select: SELECT });
    return row as PosSaleRecord | null;
  }

  async lines(posSaleId: string): Promise<PosSaleLineRecord[]> {
    const rows = await this.db.posSaleLine.findMany({
      where: this.scope({ posSaleId }),
      select: { id: true, productId: true, quantity: true, unitPriceCents: true, lineTotalCents: true, priceKind: true },
      orderBy: { id: 'asc' },
    });
    return rows as PosSaleLineRecord[];
  }

  /** Ventas de una sede en un día de negocio, las más recientes primero. */
  async listForDay(branchId: string, businessDate: Date): Promise<PosSaleRecord[]> {
    const rows = await this.db.posSale.findMany({
      where: this.scope({ branchId, businessDate }), select: SELECT, orderBy: { soldAt: 'desc' }, take: 200,
    });
    return rows as PosSaleRecord[];
  }

  /**
   * Las compras de UN socio, la más reciente primero y por páginas (bloque
   * 2.2; 8-01): también las anuladas. `total` las cuenta todas y `spentCents`
   * suma las que no se anularon, estén o no en esta página.
   */
  async pageForMember(memberId: string, limit: number, cursor: { orden: string; id: string } | null): Promise<{ filas: PosSaleRecord[]; total: number; spentCents: bigint }> {
    const desde = cursor ? new Date(cursor.orden) : null;
    const [filas, total, gastado] = await Promise.all([
      this.db.posSale.findMany({
        where: this.scope({
          memberId,
          ...(cursor && desde ? { OR: [{ soldAt: { lt: desde } }, { soldAt: desde, id: { lt: cursor.id } }] } : {}),
        }),
        select: SELECT,
        orderBy: [{ soldAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.db.posSale.count({ where: this.scope({ memberId }) }),
      this.db.posSale.aggregate({ where: this.scope({ memberId, status: S.COMPLETED }), _sum: { totalCents: true } }),
    ]);
    return { filas: filas as PosSaleRecord[], total, spentCents: gastado._sum.totalCents ?? 0n };
  }

  /** Las líneas de varias ventas con el nombre del producto (también el de uno que ya se quitó del catálogo: la venta ocurrió), por venta. */
  async linesWithNames(saleIds: readonly string[]): Promise<Map<string, Array<PosSaleLineRecord & { name: string | null }>>> {
    const porVenta = new Map<string, Array<PosSaleLineRecord & { name: string | null }>>();
    if (saleIds.length === 0) return porVenta;
    const filas = await this.db.posSaleLine.findMany({
      where: this.scope({ posSaleId: { in: [...saleIds] } }),
      select: { id: true, posSaleId: true, productId: true, quantity: true, unitPriceCents: true, lineTotalCents: true, priceKind: true, product: { select: { name: true } } },
      orderBy: { id: 'asc' },
    });
    for (const f of filas) {
      const lista = porVenta.get(f.posSaleId) ?? [];
      lista.push({ id: f.id, productId: f.productId, quantity: f.quantity, unitPriceCents: f.unitPriceCents, lineTotalCents: f.lineTotalCents, priceKind: f.priceKind, name: f.product.name });
      porVenta.set(f.posSaleId, lista);
    }
    return porVenta;
  }

  /** Nombres de quienes cobraron, por id. */
  async sellerNames(ids: readonly string[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) return new Map();
    const us = await this.db.user.findMany({ where: { id: { in: unicos }, organizationId: this.organizationId }, select: { id: true, fullName: true } });
    return new Map(us.map((u) => [u.id, u.fullName]));
  }

  async listForSession(cashSessionId: string): Promise<PosSaleRecord[]> {
    const rows = await this.db.posSale.findMany({
      where: this.scope({ cashSessionId }), select: SELECT, orderBy: { soldAt: 'asc' },
    });
    return rows as PosSaleRecord[];
  }

  /**
   * Crea venta, líneas Y movimientos de existencias en UNA SOLA transacción.
   *
   * Tienen que ir juntos. Separarlos producía ventas a medias: si el stock no
   * alcanzaba, la venta ya estaba creada y el corte contaba producto que nunca
   * salió del estante. Se detectó con 34 ventas huérfanas en desarrollo, una
   * de $2,115.
   *
   * `inventoryProductIds` dice qué productos llevan existencias: un servicio
   * (un casillero por día) no debe inventar una fila de inventario.
   */
  async create(input: {
    branchId: string;
    cashSessionId: string;
    memberId?: string | null;
    totalCents: bigint;
    method?: PaymentMethodType | null;
    chargeId?: string | null;
    folio?: string | null;
    externalRef?: string | null;
    idempotencyKey?: string | null;
    soldByUserId: string;
    businessDate: Date;
    lines: readonly SaleLine[];
    /** Por producto: a qué precio salió y su costo de hoy. Sin dato, precio de público y sin costo. */
    lineData?: ReadonlyMap<string, DatosDeLinea>;
    inventoryProductIds: ReadonlySet<string>;
  }): Promise<PosSaleRecord> {
    return this.db.$transaction(async (tx) => {
      const sale = await tx.posSale.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          branchId: input.branchId,
          cashSessionId: input.cashSessionId,
          memberId: input.memberId ?? null,
          status: S.COMPLETED,
          totalCents: input.totalCents,
          method: input.method ? M[input.method] : null,
          chargeId: input.chargeId ?? null,
          folio: input.folio ?? null,
          externalRef: input.externalRef ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          soldByUserId: input.soldByUserId,
          businessDate: input.businessDate,
        },
        select: SELECT,
      });

      for (const linea of input.lines) {
        await tx.posSaleLine.create({
          data: {
            id: uuidv7(),
            organizationId: this.organizationId,
            posSaleId: sale.id,
            productId: linea.productId,
            quantity: linea.quantity,
            unitPriceCents: linea.unitPrice.cents,
            lineTotalCents: linea.lineTotal.cents,
            priceKind: input.lineData?.get(linea.productId)?.priceKind ?? 'PUBLIC',
            unitCostCents: input.lineData?.get(linea.productId)?.unitCostCents ?? null,
          },
        });

        if (!input.inventoryProductIds.has(linea.productId)) continue;
        await this.moveStock(tx, {
          branchId: input.branchId,
          productId: linea.productId,
          movementType: 'SALE',
          quantityDelta: -linea.quantity,
          posSaleId: sale.id,
          createdByUserId: input.soldByUserId,
          businessDate: input.businessDate,
        });
      }
      return sale as PosSaleRecord;
    });
  }

  /**
   * Movimiento de existencias DENTRO de una transacción en curso.
   *
   * Dos sentencias en vez de `INSERT … ON CONFLICT DO UPDATE`: PostgreSQL
   * evalúa los `CHECK` sobre la tupla propuesta antes de detectar el conflicto,
   * así que un delta negativo fallaba aunque hubiera existencias de sobra.
   */
  private async moveStock(
    tx: Parameters<Parameters<typeof this.db.$transaction>[0]>[0],
    input: {
      branchId: string; productId: string; movementType: InventoryMovementType;
      quantityDelta: number; reason?: string | null; posSaleId?: string | null;
      createdByUserId: string; businessDate: Date;
    },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "inventory_stock" ("organizationId", "branchId", "productId", "quantityOnHand", "updatedAt")
      VALUES (${this.organizationId}::uuid, ${input.branchId}::uuid, ${input.productId}::uuid, 0, now())
      ON CONFLICT ("branchId", "productId") DO NOTHING`;

    await tx.$executeRaw`
      UPDATE "inventory_stock"
      SET "quantityOnHand" = "quantityOnHand" + ${input.quantityDelta}, "updatedAt" = now()
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "branchId" = ${input.branchId}::uuid
        AND "productId" = ${input.productId}::uuid`;

    await tx.inventoryMovement.create({
      data: {
        id: uuidv7(),
        organizationId: this.organizationId,
        branchId: input.branchId,
        productId: input.productId,
        movementType: I[input.movementType],
        quantityDelta: input.quantityDelta,
        reason: input.reason ?? null,
        posSaleId: input.posSaleId ?? null,
        createdByUserId: input.createdByUserId,
        businessDate: input.businessDate,
      },
    });
  }

  /**
   * Anula la venta y DEVUELVE el producto, en una sola transacción.
   * Cuadrar el dinero y descuadrar el inventario es peor que no anular.
   */
  async voidWithRestock(input: {
    saleId: string; branchId: string; userId: string; reason: string;
    businessDate: Date; inventoryProductIds: ReadonlySet<string>;
  }): Promise<PosSaleRecord | null> {
    return this.db.$transaction(async (tx) => {
      const res = await tx.posSale.updateMany({
        where: { id: input.saleId, organizationId: this.organizationId, status: S.COMPLETED },
        data: {
          status: S.VOIDED, voidedByUserId: input.userId,
          voidReason: input.reason, voidedAt: new Date(),
        },
      });
      if (res.count === 0) return null;

      const lineas = await tx.posSaleLine.findMany({
        where: { posSaleId: input.saleId, organizationId: this.organizationId },
        select: { productId: true, quantity: true },
      });
      for (const l of lineas) {
        if (!input.inventoryProductIds.has(l.productId)) continue;
        await this.moveStock(tx, {
          branchId: input.branchId,
          productId: l.productId,
          movementType: 'SALE_VOIDED',
          quantityDelta: l.quantity,
          reason: `Anulación de venta: ${input.reason}`,
          posSaleId: input.saleId,
          createdByUserId: input.userId,
          businessDate: input.businessDate,
        });
      }

      const row = await tx.posSale.findFirst({
        where: { id: input.saleId, organizationId: this.organizationId }, select: SELECT,
      });
      return row as PosSaleRecord;
    });
  }

  /** Anulación idempotente: dos clics no producen dos anulaciones. */
  async markVoided(id: string, userId: string, reason: string): Promise<PosSaleRecord | null> {
    const res = await this.db.posSale.updateMany({
      where: this.scope({ id, status: S.COMPLETED }),
      data: { status: S.VOIDED, voidedByUserId: userId, voidReason: reason, voidedAt: new Date() },
    });
    return res.count === 0 ? null : this.findById(id);
  }

  /**
   * Efectivo cobrado por venta de producto en el turno.
   *
   * Solo cuenta lo COMPLETADO y en efectivo: una venta anulada devolvió el
   * dinero, y una cargada a la cuenta del socio nunca entró al cajón.
   */
  async cashTotalsForSession(cashSessionId: string): Promise<Array<{ method: PaymentMethodType; amountCents: bigint }>> {
    const rows = await this.db.$queryRaw<Array<{ method: PaymentMethodType; total: bigint }>>`
      SELECT "method", COALESCE(SUM("totalCents"), 0)::bigint AS total
      FROM "pos_sales"
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "cashSessionId" = ${cashSessionId}::uuid
        AND "status" = 'COMPLETED'
        AND "method" IS NOT NULL
      GROUP BY "method"`;
    return rows.map((r) => ({ method: r.method, amountCents: r.total }));
  }
}
