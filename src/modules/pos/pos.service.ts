import {
  affectsDrawer, canVoidSale, conflict, money, notFound, priceSale, validation,
  inventoryRequiresReason, inventorySignIsValid,
  type InventoryMovementType, type PaymentMethodType, type SaleLineInput,
} from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { CashService, CashSessionRepository } from '../cash/index.js';
import { MemberRepository } from '../members/index.js';
import { enUnidadDeDinero } from '../../platform/db/unit-of-work.js';
import { InventoryRepository } from './inventory.repository.js';
import { ProductRepository, type ProductRecord } from './product.repository.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { PosSaleRepository, type PosSaleLineRecord, type PosSaleRecord } from './pos-sale.repository.js';
import type { RequestContext } from '../../platform/context.js';

export type SaleDetail = {
  sale: PosSaleRecord;
  lines: PosSaleLineRecord[];
};

export class PosService {
  private readonly audit = new AuditService();
  private readonly cash = new CashService();

  // ── Catálogo ──────────────────────────────────────────────────────────────

  async createProduct(ctx: RequestContext, input: {
    sku: string; name: string; priceCents: bigint; tracksInventory?: boolean;
  }): Promise<ProductRecord> {
    const orgId = ctx.tenant.organizationId;
    if (input.priceCents < 0n) throw validation('El precio no puede ser negativo');

    const product = await new ProductRepository(orgId).create(input);
    await this.audit.record(ctx, {
      action: 'pos.product.create',
      resourceType: 'product',
      resourceId: product.id,
      afterState: { sku: product.sku, priceCents: product.priceCents.toString() },
    });
    return product;
  }

  // ── Venta ─────────────────────────────────────────────────────────────────

  /**
   * Venta de mostrador.
   *
   * Todo pasa en el mismo flujo: precio congelado, turno resuelto, folio,
   * existencias descontadas. Si algo falla, no queda una venta a medias — y
   * eso importa porque una venta a medias descuadra el corte sin dejar pista.
   */
  async sell(ctx: RequestContext, input: {
    branchId: string;
    lines: readonly SaleLineInput[];
    method: PaymentMethodType;
    memberId?: string | null;
    cashSessionId?: string | null;
    /** Autorización de la terminal o clave de rastreo (UXA-09). */
    externalRef?: string | null;
    /** Una por venta, generada por el cliente: el reintento devuelve la misma. */
    idempotencyKey?: string | null;
  }): Promise<SaleDetail> {
    const orgId = ctx.tenant.organizationId;
    const userId = ctx.tenant.actorUserId;
    if (!userId) throw validation('Vender exige un usuario: la venta responde por una persona');
    if (input.lines.length === 0) throw validation('La venta necesita al menos una línea');

    // Se busca ANTES de resolver turno y folio: un reintento no consume otro
    // folio ni descuenta existencias otra vez.
    const repo = new PosSaleRepository(orgId);
    if (input.idempotencyKey) {
      const previa = await repo.findByIdempotencyKey(input.idempotencyKey);
      if (previa) { mismaVenta(previa, input); return { sale: previa, lines: await repo.lines(previa.id) }; }
    }

    const products = new ProductRepository(orgId);
    const catalogo = await products.findManyByIds(input.lines.map((l) => l.productId));
    const porId = new Map(catalogo.map((p) => [p.id, p]));

    for (const linea of input.lines) {
      const p = porId.get(linea.productId);
      if (!p) throw notFound(`Producto ${linea.productId} no encontrado`);
      if (!p.isActive) throw validation(`El producto ${p.sku} no está activo`);
    }

    if (input.memberId) {
      const member = await new MemberRepository(orgId).findById(input.memberId);
      if (!member) throw notFound('Socio no encontrado');
    }

    // El precio se toma del CATÁLOGO, nunca del cliente: aceptarlo del body
    // permitiría vender a cualquier precio desde una petición manipulada.
    const { lines, total } = priceSale(input.lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      unitPrice: money(porId.get(l.productId)!.priceCents),
    })));

    // Turno, folio, venta, existencias y asiento en UNA unidad de dinero (1.3):
    // toma primero el candado de la organización, como el cobro, y así una
    // venta de tienda simultánea a un cobro en la misma caja ya no se cruza
    // «folio → bitácora» con «bitácora → folio».
    let sale: PosSaleRecord;
    try {
      sale = await enUnidadDeDinero(orgId, async () => {
        const session = await this.cash.resolveSessionForPayment(ctx, {
          branchId: input.branchId,
          cashSessionId: input.cashSessionId ?? null,
        });
        const folio = affectsDrawer(input.method) || input.method === 'CARD_TERMINAL'
          ? await this.cash.nextFolio(ctx, session)
          : null;

        const businessDate = await new BusinessCalendar(orgId).today(input.branchId);

        const conInventario = new Set(
          catalogo.filter((p) => p.tracksInventory).map((p) => p.id),
        );

        const creada = await repo.create({
          branchId: input.branchId,
          cashSessionId: session.id,
          memberId: input.memberId ?? null,
          totalCents: total.cents,
          method: input.method,
          folio,
          externalRef: input.externalRef ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          soldByUserId: userId,
          businessDate,
          lines,
          // Venta y descuento de existencias van en la MISMA transacción: si el
          // stock no alcanza, no queda una venta a medias contando producto que
          // nunca salió del estante.
          inventoryProductIds: conInventario,
        });
        await this.audit.record(ctx, {
          action: 'pos.sale.create',
          resourceType: 'pos_sale',
          resourceId: creada.id,
          afterState: {
            totalCents: total.cents.toString(),
            method: input.method,
            folio,
            lines: lines.length,
          },
          branchId: input.branchId,
        });
        return creada;
      });
    } catch (err) {
      // Dos envíos simultáneos con la misma clave: gana uno y el otro
      // devuelve esa misma venta. La transacción del perdedor no dejó nada.
      if (input.idempotencyKey && isUniqueViolation(err)) {
        const ganadora = await repo.findByIdempotencyKey(input.idempotencyKey);
        if (ganadora) { mismaVenta(ganadora, input); return { sale: ganadora, lines: await repo.lines(ganadora.id) }; }
      }
      throw err;
    }

    return { sale, lines: await repo.lines(sale.id) };
  }

  /**
   * Anulación. Solo el MISMO día de operación: después el corte ya cerró y
   * corregirlo hacia atrás movería una cifra ya firmada.
   */
  async voidSale(ctx: RequestContext, input: {
    saleId: string; reason: string;
  }): Promise<PosSaleRecord> {
    const orgId = ctx.tenant.organizationId;
    const userId = ctx.tenant.actorUserId;
    if (!userId) throw validation('Anular exige un usuario');

    const repo = new PosSaleRepository(orgId);
    const sale = await repo.findById(input.saleId);
    if (!sale) throw notFound('Venta no encontrada');

    const hoy = await new BusinessCalendar(orgId).today(sale.branchId);
    const mismoDia = sale.businessDate.getTime() === hoy.getTime();

    const veredicto = canVoidSale(sale.status, mismoDia);
    if (!veredicto.ok) throw conflict(veredicto.reason);
    // Tras el corte, anularla la quitaba del turno YA firmado mientras el
    // efectivo salía del cajón de otro turno (BE2-12). La base también lo
    // impide; aquí se explica qué hacer.
    const turno = await new CashSessionRepository(orgId).findById(sale.cashSessionId);
    if (turno && turno.status !== 'OPEN') {
      throw conflict('El turno de esa venta ya se cerró: no se puede anular. Si devuelves el dinero, regístralo como gasto de caja, con motivo, en el turno abierto', 'CASH_SESSION_CLOSED');
    }

    const products = new ProductRepository(orgId);
    const lineas = await repo.lines(input.saleId);
    const conInventario = new Set<string>();
    for (const l of lineas) {
      const p = await products.findById(l.productId);
      if (p?.tracksInventory) conInventario.add(l.productId);
    }

    const anulada = await repo.voidWithRestock({
      saleId: input.saleId,
      branchId: sale.branchId,
      userId,
      reason: input.reason,
      businessDate: hoy,
      inventoryProductIds: conInventario,
    });
    if (!anulada) throw conflict('La venta ya estaba anulada', 'ALREADY_VOIDED');

    await this.audit.record(ctx, {
      action: 'pos.sale.void',
      resourceType: 'pos_sale',
      resourceId: input.saleId,
      beforeState: { status: sale.status, totalCents: sale.totalCents.toString() },
      afterState: { status: 'VOIDED' },
      reason: input.reason,
      branchId: sale.branchId,
    });

    return anulada;
  }

  // ── Inventario ────────────────────────────────────────────────────────────

  async adjustInventory(ctx: RequestContext, input: {
    branchId: string;
    productId: string;
    movementType: InventoryMovementType;
    quantityDelta: number;
    reason: string;
  }): Promise<{ movementId: string; quantityOnHand: number }> {
    const orgId = ctx.tenant.organizationId;
    const userId = ctx.tenant.actorUserId;
    if (!userId) throw validation('Un movimiento de inventario exige un usuario');

    if (!inventorySignIsValid(input.movementType, input.quantityDelta)) {
      throw validation(`El signo no corresponde con un movimiento de tipo ${input.movementType}`);
    }
    if (inventoryRequiresReason(input.movementType) && input.reason.trim().length < 3) {
      throw validation(`Un movimiento de tipo ${input.movementType} exige un motivo`);
    }

    const product = await new ProductRepository(orgId).findById(input.productId);
    if (!product) throw notFound('Producto no encontrado');
    if (!product.tracksInventory) throw validation(`El producto ${product.sku} no lleva existencias`);

    const inventory = new InventoryRepository(orgId);
    const movimiento = await inventory.move({
      branchId: input.branchId,
      productId: input.productId,
      movementType: input.movementType,
      quantityDelta: input.quantityDelta,
      reason: input.reason,
      createdByUserId: userId,
      businessDate: await new BusinessCalendar(orgId).today(input.branchId),
    });

    await this.audit.record(ctx, {
      action: 'pos.inventory.adjust',
      resourceType: 'inventory_movement',
      resourceId: movimiento.id,
      afterState: { type: input.movementType, delta: input.quantityDelta, sku: product.sku },
      reason: input.reason,
      branchId: input.branchId,
    });

    const [stock] = await inventory.stockFor(input.branchId, [input.productId]);
    return { movementId: movimiento.id, quantityOnHand: stock?.quantityOnHand ?? 0 };
  }
}

/** La misma clave debe ser la misma venta: misma sede, método y socio (BE2-09). */
function mismaVenta(previa: { branchId: string; method: string | null; memberId: string | null }, pedido: { branchId: string; method: string; memberId?: string | null }): void {
  if (previa.branchId !== pedido.branchId || previa.method !== pedido.method || (previa.memberId ?? null) !== (pedido.memberId ?? null)) {
    throw validation('Esa clave de venta ya se usó para otra venta. Vuelve a cobrar desde el punto de venta');
  }
}
