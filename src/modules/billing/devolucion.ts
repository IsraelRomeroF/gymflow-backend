import { conflict, notFound, requiresCashSession, validation, type PaymentMethodType } from '@gymflow/core';
import { enUnidadDeDinero } from '../../platform/db/unit-of-work.js';
import type { RequestContext } from '../../platform/context.js';
import { MemberRepository } from '../members/index.js';
import { PaymentRepository, type PaymentRecord } from './payment.repository.js';
import type { BillingService } from './billing.service.js';

/**
 * DEVOLVER DINERO (D-13, auditoría 8, bloque 3.5).
 *
 *  · Una PARTE de un cobro de mostrador: siempre con la firma de la dueña. El
 *    efectivo (o el total de la terminal) sale del turno abierto HOY; la
 *    transferencia lleva la clave de rastreo de la devolución. Lo devuelto
 *    deja de cobrarse: el cargo no vuelve a deber por ese importe.
 *  · El SALDO A FAVOR que el socio pide (lo pagado y no usado al cancelar):
 *    igual, con firma, en efectivo del turno abierto o por transferencia.
 *
 * «Todo el cobro» sigue siendo la reversa de siempre (`reversePayment`): el
 * cargo vuelve a quedar pendiente. El reembolso de una tarjeta en línea pasa
 * por el procesador (`payments/`).
 */

/** Los métodos por los que el gimnasio regresa dinero en el mostrador. */
const CON_REFERENCIA: ReadonlySet<PaymentMethodType> = new Set(['SPEI_TRANSFER', 'OXXO_REF']);

/**
 * Por dónde sale el dinero de una devolución hecha por `method` en esa sede:
 * el turno abierto y su folio (efectivo o terminal, si la sede lleva Caja) o
 * la referencia de la transferencia.
 */
async function salida(svc: BillingService, ctx: RequestContext, input: {
  method: PaymentMethodType; branchId: string | null; cashSessionId?: string | null; returnRef?: string | null;
}): Promise<{ cashSessionId: string | null; folio: string | null; returnRef: string | null }> {
  const returnRef = input.returnRef?.trim() || null;
  if (CON_REFERENCIA.has(input.method) && !returnRef) {
    throw validation('Una devolución por transferencia lleva su referencia o clave de rastreo', undefined, 'RETURN_REFERENCE_REQUIRED');
  }
  if (requiresCashSession(input.method) && input.branchId && await svc.conCaja(ctx, input.branchId)) {
    const session = await svc.cash.resolveSessionForPayment(ctx, { branchId: input.branchId, cashSessionId: input.cashSessionId ?? null });
    return { cashSessionId: session.id, folio: await svc.cash.nextFolio(ctx, session), returnRef };
  }
  return { cashSessionId: null, folio: null, returnRef };
}

/** Devuelve una parte (o lo que quede) de un cobro de mostrador. Idempotente por `requestKey`. */
export async function devolverParteDeUnCobro(svc: BillingService, ctx: RequestContext, input: {
  paymentId: string; amountCents: bigint; reason: string; approvedByUserId: string;
  cashSessionId?: string | null; returnRef?: string | null; requestKey: string;
}): Promise<{ entry: PaymentRecord; created: boolean }> {
  const orgId = ctx.tenant.organizationId;
  if (input.amountCents <= 0n) throw validation('El importe a devolver debe ser mayor que cero');
  return enUnidadDeDinero(orgId, async () => {
    const repo = new PaymentRepository(orgId);
    const llave = `return-${input.paymentId}-${input.requestKey}`;
    // El reintento del mismo envío es la misma devolución: ni sale dinero dos veces ni se gasta otro folio.
    const previa = await repo.findByIdempotencyKey(llave);
    if (previa) return { entry: previa, created: false };

    const pago = await repo.findById(input.paymentId);
    if (!pago) throw notFound('Pago no encontrado');
    if (pago.amountCents <= 0n) throw conflict('Eso no es un cobro: no se devuelve una devolución');
    if (pago.status !== 'SUCCEEDED') throw conflict('El pago ya no admite devoluciones (fue revertido o no se completó)', 'ALREADY_REVERSED');
    if (pago.method === 'CARD_ON_FILE') throw validation('El cobro fue con tarjeta en línea: se reembolsa a su tarjeta, no desde la caja');
    if (pago.method === 'CREDIT_NOTE') throw validation('Eso es saldo a favor, no un cobro: se devuelve desde «Devolver saldo a favor»');

    const hoy = await svc.businessDate(orgId, pago.branchId);
    const por = await salida(svc, ctx, { method: pago.method, branchId: pago.branchId, cashSessionId: input.cashSessionId ?? null, returnRef: input.returnRef ?? null });
    const { refundEntry, chargeIds } = await repo.recordRefund({
      paymentId: pago.id, amountCents: input.amountCents, reason: input.reason, businessDate: hoy,
      createdByUserId: ctx.tenant.actorUserId ?? null,
      cashSessionId: por.cashSessionId, folio: por.folio, returnRef: por.returnRef, idempotencyKey: llave,
    });
    await svc.refreshCachedBalance(orgId, pago.memberId);
    await svc.audit.record(ctx, {
      action: 'payments.return', resourceType: 'payment', resourceId: pago.id, branchId: pago.branchId,
      beforeState: { amountCents: pago.amountCents.toString(), method: pago.method },
      afterState: {
        amountCents: input.amountCents.toString(), refundEntryId: refundEntry.id, folio: por.folio,
        ...(por.returnRef ? { returnRef: por.returnRef } : {}), charges: chargeIds.length,
      },
      reason: input.reason, approvedByUserId: input.approvedByUserId,
    });
    return { entry: refundEntry, created: true };
  });
}

/** Devuelve al socio, en dinero, saldo que tiene a favor. Idempotente por `requestKey`. */
export async function devolverSaldoAFavor(svc: BillingService, ctx: RequestContext, input: {
  memberId: string; amountCents: bigint; method: 'CASH' | 'SPEI_TRANSFER'; branchId: string; reason: string; approvedByUserId: string;
  cashSessionId?: string | null; returnRef?: string | null; requestKey: string;
}): Promise<{ entries: PaymentRecord[]; created: boolean; creditCents: bigint }> {
  const orgId = ctx.tenant.organizationId;
  if (input.amountCents <= 0n) throw validation('El importe a devolver debe ser mayor que cero');
  return enUnidadDeDinero(orgId, async () => {
    if (!await new MemberRepository(orgId).findByIdIncludingArchived(input.memberId)) throw notFound('Socio no encontrado');
    const repo = new PaymentRepository(orgId);
    const llave = `credit-return-${input.memberId}-${input.requestKey}`;
    const hoy = await svc.businessDate(orgId, input.branchId);
    // ¿Ya se hizo este mismo envío? Se mira antes de buscar caja y de gastar folio.
    const previas = await repo.findByIdempotencyPrefix(`${llave}#`);
    if (previas.length > 0) return { entries: previas, created: false, creditCents: await repo.creditBalanceCents(input.memberId) };
    const disponible = await repo.creditBalanceCents(input.memberId);
    if (input.amountCents > disponible) throw conflict('No tiene tanto saldo a favor que devolver', 'NO_CREDIT');

    const por = await salida(svc, ctx, { method: input.method, branchId: input.branchId, cashSessionId: input.cashSessionId ?? null, returnRef: input.returnRef ?? null });
    const r = await repo.returnCredit({
      memberId: input.memberId, amountCents: input.amountCents, method: input.method, branchId: input.branchId, reason: input.reason,
      businessDate: hoy, createdByUserId: ctx.tenant.actorUserId ?? null,
      cashSessionId: por.cashSessionId, folio: por.folio, returnRef: por.returnRef, idempotencyKey: llave,
    });
    await svc.refreshCachedBalance(orgId, input.memberId);
    await svc.audit.record(ctx, {
      action: 'payments.credit.return', resourceType: 'Member', resourceId: input.memberId, branchId: input.branchId,
      afterState: {
        amountCents: input.amountCents.toString(), method: input.method, folio: por.folio,
        ...(por.returnRef ? { returnRef: por.returnRef } : {}), entries: r.entries.map((e) => e.id),
      },
      reason: input.reason, approvedByUserId: input.approvedByUserId,
    });
    return { ...r, creditCents: await repo.creditBalanceCents(input.memberId) };
  });
}
