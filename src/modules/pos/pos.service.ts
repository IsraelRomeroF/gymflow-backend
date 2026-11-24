import {
  affectsDrawer, canVoidSale, conflict, money, notFound, priceSale, validation,
  inventoryRequiresReason, inventorySignIsValid, precioDeTienda, MEMBER_PRICE_STATUSES,
  type InventoryMovementType, type PaymentMethodType, type SaleLineInput,
} from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { CashService, CashSessionRepository } from '../cash/index.js';
import { MemberRepository } from '../members/index.js';
import { MembershipRepository } from '../memberships/index.js';
import { enUnidadDeDinero } from '../../platform/db/unit-of-work.js';
import { InventoryRepository } from './inventory.repository.js';
import { ProductRepository, type ProductRecord } from './product.repository.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { PosSaleRepository, type DatosDeLinea, type PosSaleLineRecord, type PosSaleRecord } from './pos-sale.repository.js';
import { PosCorrectionRepository } from './correccion.repository.js';
import { MonthlyCloseService } from '../finance/index.js';
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
    memberPriceCents?: bigint | null; costCents?: bigint | null;
  }): Promise<ProductRecord> {
    const orgId = ctx.tenant.organizationId;
    if (input.priceCents < 0n) throw validation('El precio no puede ser negativo');
    exigirPreciosCoherentes(input.priceCents, input.memberPriceCents ?? null);

    const product = await new ProductRepository(orgId).create(input);
    await this.audit.record(ctx, {
      action: 'pos.product.create',
      resourceType: 'product',
      resourceId: product.id,
      afterState: estadoDeProducto(product),
    });
    return product;
  }

  /**
   * Cambia un producto: nombre, vigencia, precio de público, precio de socio
   * y costo (D-21; los dos últimos opcionales, `null` los quita). Queda con el
   * antes y el después: es lo primero que se pregunta cuando el corte de
   * productos no cuadra. Lo ya vendido no cambia: cada línea guardó su precio
   * y su costo de ese día.
   */
  async updateProduct(ctx: RequestContext, id: string, patch: {
    name?: string; priceCents?: bigint; isActive?: boolean; memberPriceCents?: bigint | null; costCents?: bigint | null;
  }): Promise<ProductRecord> {
    const repo = new ProductRepository(ctx.tenant.organizationId);
    const antes = await repo.findById(id);
    if (!antes) throw notFound('Producto no encontrado');
    exigirPreciosCoherentes(patch.priceCents ?? antes.priceCents, patch.memberPriceCents !== undefined ? patch.memberPriceCents : antes.memberPriceCents);
    const despues = await repo.update(id, patch);
    if (!despues) throw notFound('Producto no encontrado');
    await this.audit.record(ctx, {
      action: 'pos.product.update', resourceType: 'product', resourceId: id,
      beforeState: estadoDeProducto(antes), afterState: estadoDeProducto(despues),
    });
    return despues;
  }

  /**
   * ¿A este socio le toca hoy el precio de socio? (D-21: socios con membresía
   * vigente; `MEMBER_PRICE_STATUSES` del núcleo). Lo usa la venta y lo
   * consulta la pantalla para mostrar el mismo total que se va a cobrar.
   */
  async precioDeSocioAplica(organizationId: string, memberId: string): Promise<boolean> {
    const viva = await new MembershipRepository(organizationId).findLiveForMember(memberId);
    return !!viva && MEMBER_PRICE_STATUSES.includes(viva.status);
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

    let esSocioVigente = false;
    if (input.memberId) {
      const member = await new MemberRepository(orgId).findById(input.memberId);
      if (!member) throw notFound('Socio no encontrado');
      esSocioVigente = await this.precioDeSocioAplica(orgId, input.memberId);
    }

    // El precio se toma del CATÁLOGO, nunca del cliente: aceptarlo del body
    // permitiría vender a cualquier precio desde una petición manipulada. El de
    // socio (D-21) lo decide aquí el servidor: producto que lo tiene y venta
    // ligada a un socio con membresía vigente. Cada línea guarda a qué precio
    // salió y lo que costaba el producto hoy (para la ganancia del Tablero).
    const lineData = new Map<string, DatosDeLinea>();
    const { lines, total } = priceSale(input.lines.map((l) => {
      const p = porId.get(l.productId)!;
      const precio = precioDeTienda(p, esSocioVigente);
      lineData.set(l.productId, { priceKind: precio.kind, unitCostCents: p.costCents });
      return { productId: l.productId, quantity: l.quantity, unitPrice: money(precio.unitPriceCents) };
    }));

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
          lineData,
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
            ...(esSocioVigente && [...lineData.values()].some((d) => d.priceKind === 'MEMBER') ? { memberPrice: true } : {}),
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
      throw conflict('El turno de esa venta ya se cerró: no se puede anular. Registra su devolución (con autorización): el dinero sale del turno abierto y el producto vuelve al inventario', 'CASH_SESSION_CLOSED');
    }

    const products = new ProductRepository(orgId);
    const lineas = await repo.lines(input.saleId);
    const conInventario = new Set<string>();
    for (const l of lineas) {
      const p = await products.findById(l.productId);
      if (p?.tracksInventory) conInventario.add(l.productId);
    }

    // Las cifras de un mes cerrado no cambian (D-22; pendiente de 3.7 que recoge el bloque 3.5).
    // Una venta solo se anula el mismo día, así que esto no debería ocurrir: es el candado.
    await new MonthlyCloseService().assertOpen(orgId, sale.businessDate);
    if (await new PosCorrectionRepository(orgId).returnOf(sale.id)) throw conflict('Esa venta ya se devolvió', 'SALE_ALREADY_RETURNED');

    // La anulación, el producto de vuelta, la marca «por corregir» resuelta y el asiento: juntos o nada (28-10).
    return enUnidadDeDinero(orgId, async () => {
      const anulada = await repo.voidWithRestock({
        saleId: input.saleId,
        branchId: sale.branchId,
        userId,
        reason: input.reason,
        businessDate: hoy,
        inventoryProductIds: conInventario,
      });
      if (!anulada) throw conflict('La venta ya estaba anulada', 'ALREADY_VOIDED');
      await new PosCorrectionRepository(orgId).resolve(sale.id, 'VOIDED', userId, input.reason);

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
    });
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

/** El precio de socio es un precio MENOR o igual al de público: uno mayor sería un error de captura. */
function exigirPreciosCoherentes(priceCents: bigint, memberPriceCents: bigint | null): void {
  if (memberPriceCents !== null && memberPriceCents > priceCents) {
    throw validation('El precio de socio no puede ser mayor que el precio de público');
  }
}

/** Lo que la bitácora guarda de un producto. */
function estadoDeProducto(p: ProductRecord) {
  return {
    sku: p.sku, name: p.name, priceCents: p.priceCents.toString(), isActive: p.isActive,
    memberPriceCents: p.memberPriceCents?.toString() ?? null, costCents: p.costCents?.toString() ?? null,
  };
}

/** La misma clave debe ser la misma venta: misma sede, método y socio (BE2-09). */
function mismaVenta(previa: { branchId: string; method: string | null; memberId: string | null }, pedido: { branchId: string; method: string; memberId?: string | null }): void {
  if (previa.branchId !== pedido.branchId || previa.method !== pedido.method || (previa.memberId ?? null) !== (pedido.memberId ?? null)) {
    throw validation('Esa clave de venta ya se usó para otra venta. Vuelve a cobrar desde el punto de venta');
  }
}
