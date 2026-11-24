import { conflict, notFound, requiresCashSession, validation, type PaymentMethodType } from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnidadDeDinero } from '../../platform/db/unit-of-work.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { isModuleOnAt } from '../../platform/modules/module-state.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import type { RequestContext } from '../../platform/context.js';
import { CashService, CashSessionRepository } from '../cash/index.js';
import { PosSaleRepository, type PosSaleRecord } from './pos-sale.repository.js';
import { ProductRepository } from './product.repository.js';
import { PosCorrectionRepository, type FlagRecord, type ReturnRecord } from './correccion.repository.js';

/**
 * CORREGIR UNA VENTA DE LA TIENDA (D-13, auditoría 8, bloque 3.5).
 *
 *  · Recepción NO anula: marca la venta «por corregir», con motivo.
 *  · La gerencia la anula el MISMO día (`PosService.voidSale`, como siempre) o,
 *    si la venta es de otro día o su turno ya se cortó, registra su
 *    DEVOLUCIÓN: con la firma de la dueña, el dinero sale hoy (del turno
 *    abierto, o por transferencia con su referencia) y el producto vuelve al
 *    inventario. La venta original no se toca: su día ya se cortó y firmó; la
 *    devolución resta el día en que se hace.
 */
const audit = new AuditService();
const CON_REFERENCIA: ReadonlySet<PaymentMethodType> = new Set(['SPEI_TRANSFER', 'OXXO_REF']);

async function venta(orgId: string, saleId: string): Promise<PosSaleRecord> {
  const sale = await new PosSaleRepository(orgId).findById(saleId);
  if (!sale) throw notFound('Venta no encontrada');
  return sale;
}

/** Recepción avisa que esa venta está mal. No mueve dinero ni inventario. */
export async function marcarPorCorregir(ctx: RequestContext, input: { saleId: string; reason: string }): Promise<FlagRecord> {
  const orgId = ctx.tenant.organizationId;
  const userId = ctx.tenant.actorUserId;
  if (!userId) throw validation('Marcar una venta exige un usuario');
  return enUnidadDeDinero(orgId, async () => {
    const sale = await venta(orgId, input.saleId);
    if (sale.status === 'VOIDED') throw conflict('La venta ya está anulada', 'ALREADY_VOIDED');
    const repo = new PosCorrectionRepository(orgId);
    if (await repo.returnOf(sale.id)) throw conflict('Esa venta ya se devolvió', 'SALE_ALREADY_RETURNED');
    const marca = await repo.flag({ posSaleId: sale.id, branchId: sale.branchId, reason: input.reason, userId });
    await audit.record(ctx, {
      action: 'pos.sale.flag', resourceType: 'pos_sale', resourceId: sale.id, branchId: sale.branchId,
      afterState: { totalCents: sale.totalCents.toString(), folio: sale.folio }, reason: input.reason,
    });
    return marca;
  });
}

/** La gerencia revisó y no procedía: se quita la marca, con motivo. */
export async function descartarMarca(ctx: RequestContext, input: { saleId: string; reason: string }): Promise<void> {
  const orgId = ctx.tenant.organizationId;
  const userId = ctx.tenant.actorUserId;
  if (!userId) throw validation('Descartar una marca exige un usuario');
  await enUnidadDeDinero(orgId, async () => {
    const sale = await venta(orgId, input.saleId);
    const cerrada = await new PosCorrectionRepository(orgId).resolve(sale.id, 'DISMISSED', userId, input.reason);
    if (!cerrada) throw conflict('Esa venta no está marcada por corregir');
    await audit.record(ctx, {
      action: 'pos.sale.unflag', resourceType: 'pos_sale', resourceId: sale.id, branchId: sale.branchId, reason: input.reason,
    });
  });
}

/** La devolución de una venta de otro día (o de un turno ya cortado). Siempre con firma. */
export async function devolverVenta(ctx: RequestContext, input: {
  saleId: string; reason: string; approvedByUserId: string; cashSessionId?: string | null; returnRef?: string | null;
}): Promise<{ sale: PosSaleRecord; devolucion: ReturnRecord }> {
  const orgId = ctx.tenant.organizationId;
  const userId = ctx.tenant.actorUserId;
  if (!userId) throw validation('Devolver una venta exige un usuario');
  return enUnidadDeDinero(orgId, async () => {
    const sale = await venta(orgId, input.saleId);
    if (sale.status === 'VOIDED') throw conflict('La venta está anulada: no hay nada que devolver', 'ALREADY_VOIDED');
    const repo = new PosCorrectionRepository(orgId);
    if (await repo.returnOf(sale.id)) throw conflict('Esa venta ya se devolvió', 'SALE_ALREADY_RETURNED');
    if (sale.method === null) {
      // Se cargó a la cuenta del socio: el dinero (si lo hubo) está en su estado de cuenta.
      throw validation('Esa venta se cargó a la cuenta del socio: corrígela desde su estado de cuenta (anula o devuelve el cargo)');
    }

    const hoy = await new BusinessCalendar(orgId).today(sale.branchId);
    const turnoDeLaVenta = await new CashSessionRepository(orgId).findById(sale.cashSessionId);
    // La del día con su turno abierto se ANULA: es más simple y no deja dos renglones.
    if (sale.businessDate.getTime() === hoy.getTime() && turnoDeLaVenta?.status === 'OPEN') {
      throw conflict('Esa venta es de hoy y su turno sigue abierto: anúlala en vez de devolverla', 'SALE_SAME_DAY');
    }

    const returnRef = input.returnRef?.trim() || null;
    if (CON_REFERENCIA.has(sale.method) && !returnRef) {
      throw validation('Una devolución por transferencia lleva su referencia o clave de rastreo', undefined, 'RETURN_REFERENCE_REQUIRED');
    }
    // El efectivo (o el total de la terminal) sale del turno abierto HOY, no del de la venta, que ya se cortó.
    let cashSessionId: string | null = null;
    const conCaja = ctx.modules ? ctx.modules.at(sale.branchId).has('cash') : await isModuleOnAt(orgId, sale.branchId, 'cash');
    if (requiresCashSession(sale.method) && conCaja) {
      cashSessionId = (await new CashService().resolveSessionForPayment(ctx, { branchId: sale.branchId, cashSessionId: input.cashSessionId ?? null })).id;
      if (sale.method === 'CASH') {
        const turno = (await new CashSessionRepository(orgId).findById(cashSessionId))!;
        const hay = await new CashSessionRepository(orgId).expectedCashCents(turno);
        if (sale.totalCents > hay) throw validation('No hay tanto efectivo en la caja para devolver esa venta');
      }
    }

    const productos = new ProductRepository(orgId);
    const restock: Array<{ productId: string; quantity: number }> = [];
    for (const l of await new PosSaleRepository(orgId).lines(sale.id)) {
      if ((await productos.findById(l.productId))?.tracksInventory) restock.push({ productId: l.productId, quantity: l.quantity });
    }

    let devolucion: ReturnRecord;
    try {
      devolucion = await repo.createReturn({
        posSaleId: sale.id, branchId: sale.branchId, amountCents: sale.totalCents, method: sale.method,
        cashSessionId, returnRef, reason: input.reason, approvedByUserId: input.approvedByUserId, createdByUserId: userId,
        businessDate: hoy, restock,
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Esa venta ya se devolvió', 'SALE_ALREADY_RETURNED');
      throw e;
    }
    await repo.resolve(sale.id, 'RETURNED', userId, input.reason);
    await audit.record(ctx, {
      action: 'pos.sale.return', resourceType: 'pos_sale', resourceId: sale.id, branchId: sale.branchId,
      beforeState: { soldOn: sale.businessDate.toISOString().slice(0, 10), folio: sale.folio },
      afterState: {
        amountCents: sale.totalCents.toString(), method: sale.method, returnId: devolucion.id,
        restocked: restock.reduce((a, l) => a + l.quantity, 0), ...(returnRef ? { returnRef } : {}),
      },
      reason: input.reason, approvedByUserId: input.approvedByUserId,
    });
    return { sale, devolucion };
  });
}
