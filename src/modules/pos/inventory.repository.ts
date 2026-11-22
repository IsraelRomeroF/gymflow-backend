import { uuidv7, type InventoryMovementType } from '@gymflow/core';
import { PrismaInventoryMovementType } from '@gymflow/db';
import { armarCursor, cortarPagina, type PartesDelCursor } from '@gymflow/core/contracts';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

const T = PrismaInventoryMovementType;

export type StockRecord = {
  branchId: string;
  productId: string;
  quantityOnHand: number;
};

export type MovementRecord = {
  id: string;
  branchId: string;
  productId: string;
  movementType: InventoryMovementType;
  quantityDelta: number;
  reason: string | null;
  posSaleId: string | null;
  at: Date;
};

/** Un renglón del libro: el movimiento, de qué producto y quién lo registró. */
export type MovementRow = MovementRecord & {
  sku: string | null;
  productName: string | null;
  createdByUserId: string;
  createdByName: string | null;
  businessDate: Date;
};

export class InventoryRepository extends TenantRepository {
  async stockFor(branchId: string, productIds?: readonly string[]): Promise<StockRecord[]> {
    const rows = await this.db.inventoryStock.findMany({
      where: this.scope({
        branchId,
        ...(productIds?.length ? { productId: { in: [...productIds] } } : {}),
      }),
      select: { branchId: true, productId: true, quantityOnHand: true },
    });
    return rows as StockRecord[];
  }

  /**
   * Aplica un movimiento y actualiza existencias en UNA transacción.
   *
   * El `CHECK (quantityOnHand >= 0)` de la base es quien impide vender lo que
   * no hay: si dos cajas venden la última pieza a la vez, una de las dos falla
   * en el motor. Comprobarlo solo en la aplicación dejaría pasar la carrera.
   */
  async move(input: {
    branchId: string;
    productId: string;
    movementType: InventoryMovementType;
    quantityDelta: number;
    reason?: string | null;
    posSaleId?: string | null;
    createdByUserId: string;
    businessDate: Date;
  }): Promise<MovementRecord> {
    return this.db.$transaction(async (tx) => {
      /**
       * DOS sentencias, no un `INSERT … ON CONFLICT DO UPDATE`.
       *
       * PostgreSQL evalúa los `CHECK` sobre la tupla PROPUESTA antes de
       * detectar el conflicto, así que un delta negativo hacía fallar
       * `stock_non_negative_check` aunque hubiera existencias de sobra. Primero
       * se garantiza la fila en cero y después se aplica el delta: así el
       * `CHECK` mide el saldo real, que es lo que debe impedir vender lo que
       * no hay.
       */
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

      const row = await tx.inventoryMovement.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          branchId: input.branchId,
          productId: input.productId,
          movementType: T[input.movementType],
          quantityDelta: input.quantityDelta,
          reason: input.reason ?? null,
          posSaleId: input.posSaleId ?? null,
          createdByUserId: input.createdByUserId,
          businessDate: input.businessDate,
        },
        select: {
          id: true, branchId: true, productId: true, movementType: true,
          quantityDelta: true, reason: true, posSaleId: true, at: true,
        },
      });
      return row as MovementRecord;
    });
  }

  /**
   * EL LIBRO DE INVENTARIO de una sede, del movimiento más reciente al más
   * viejo (8-02): compras, ventas, ajustes por conteo, traspasos y mermas, con
   * quién registró cada uno. Antes los movimientos se escribían y no había
   * dónde leerlos.
   */
  async movementsPage(opts: {
    branchId: string; productId?: string | undefined; movementType?: InventoryMovementType | undefined;
    limit: number; cursor: PartesDelCursor | null;
  }): Promise<{ items: MovementRow[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const filtro = this.scope({
      branchId: opts.branchId,
      ...(opts.productId ? { productId: opts.productId } : {}),
      ...(opts.movementType ? { movementType: T[opts.movementType] } : {}),
    });
    const desde = opts.cursor ? new Date(opts.cursor.orden) : null;
    const [filas, total] = await Promise.all([
      this.db.inventoryMovement.findMany({
        where: opts.cursor && desde
          ? { AND: [filtro, { OR: [{ at: { lt: desde } }, { at: desde, id: { lt: opts.cursor.id } }] }] }
          : filtro,
        select: {
          id: true, branchId: true, productId: true, movementType: true,
          quantityDelta: true, reason: true, posSaleId: true, at: true,
          createdByUserId: true, businessDate: true,
          product: { select: { sku: true, name: true, deletedAt: true } },
        },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: opts.limit + 1,
      }),
      this.db.inventoryMovement.count({ where: filtro }),
    ]);
    const nombres = await this.staffNames(filas.map((f) => f.createdByUserId));
    const pagina = cortarPagina(filas, opts.limit, (u) => armarCursor(u.at.toISOString(), u.id));
    return {
      ...pagina,
      total,
      items: pagina.items.map(({ product, ...m }) => ({
        ...(m as MovementRecord & { createdByUserId: string; businessDate: Date }),
        // Un producto borrado del catálogo deja su movimiento, sin nombre.
        sku: product.deletedAt ? null : product.sku,
        productName: product.deletedAt ? null : product.name,
        createdByName: nombres.get(m.createdByUserId) ?? null,
      })),
    };
  }

  private async staffNames(ids: readonly string[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) return new Map();
    const us = await this.db.user.findMany({ where: { id: { in: unicos }, organizationId: this.organizationId }, select: { id: true, fullName: true } });
    return new Map(us.map((u) => [u.id, u.fullName]));
  }
}
