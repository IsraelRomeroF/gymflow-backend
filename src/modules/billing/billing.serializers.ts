/** Lo que comparten las rutas de dinero: serializadores, cuerpos y el dinero como cadena (ADR-005). */
import { z } from 'zod';
import { MembershipRepository } from '../memberships/index.js';
import { type ChargeRecord, type AdjustmentRecord } from './charge.repository.js';
import { type PaymentRecord } from './payment.repository.js';
import { type EstadoParaCobro } from './billing.service.js';
import { notFound, formatMoney, money } from '@gymflow/core';

export const idParam = z.object({ id: z.string().uuid() });

/**
 * El dinero SALE COMO CADENA, siempre.
 *
 * `JSON.parse` convierte todo número a `double`: bastan importes del tamaño de
 * una anualidad multiplicada por un año de historial para empezar a perder
 * precisión en el cliente. La cadena cruza intacta.
 */
export const cents = (v: bigint): string => v.toString();

export function serializeCharge(c: ChargeRecord) {
  // Un cargo anulado o castigado ya NO se debe (1.1 §7-1, fase 1.3): su saldo
  // sale en cero, como en el portal. Antes salía importe − asignado − ajustado
  // sin mirar el estado, y la ficha lo sumaba a la deuda de la membresía.
  const yaNoSeDebe = c.status === 'VOID' || c.status === 'WRITTEN_OFF';
  const balance = yaNoSeDebe ? 0n : c.amountCents - c.allocatedCents - c.adjustedCents;
  return {
    id: c.id,
    memberId: c.memberId,
    membershipId: c.membershipId,
    branchId: c.branchId,
    chargeType: c.chargeType,
    status: c.status,
    concept: c.concept,
    subtotalCents: cents(c.subtotalCents),
    taxCents: cents(c.taxCents),
    discountCents: cents(c.discountCents),
    amountCents: cents(c.amountCents),
    allocatedCents: cents(c.allocatedCents),
    adjustedCents: cents(c.adjustedCents),
    balanceCents: cents(balance < 0n ? 0n : balance),
    amountLabel: formatMoney(money(c.amountCents)),
    periodStart: c.periodStart ? iso(c.periodStart) : null,
    periodEnd: c.periodEnd ? iso(c.periodEnd) : null,
    dueDate: iso(c.dueDate),
    createdAt: c.createdAt.toISOString(),
  };
}

export function serializePayment(p: PaymentRecord) {
  return {
    id: p.id,
    memberId: p.memberId,
    branchId: p.branchId,
    method: p.method,
    status: p.status,
    amountCents: cents(p.amountCents),
    unappliedCents: cents(p.unappliedCents),
    amountLabel: formatMoney(money(p.amountCents)),
    externalRef: p.externalRef,
    folio: p.folio,
    cashSessionId: p.cashSessionId,
    receivedAt: p.receivedAt.toISOString(),
    businessDate: iso(p.businessDate),
    reversesPaymentId: p.reversesPaymentId,
    reversalReason: p.reversalReason,
  };
}

/** Si entra, hasta dónde está pagado y cuánto le falta para entrar (4-09), con el dinero como cadena. */
export function serializeEstadoParaCobro(e: EstadoParaCobro) {
  return {
    membership: e.membership && {
      id: e.membership.id, status: e.membership.status, canEnter: e.membership.canEnter,
      paidThrough: e.membership.paidThrough ? iso(e.membership.paidThrough) : null,
    },
    toEnterCents: e.toEnterCents === null ? null : cents(e.toEnterCents),
  };
}

export function serializeAdjustment(a: AdjustmentRecord) {
  return {
    id: a.id,
    chargeId: a.chargeId,
    adjustmentType: a.adjustmentType,
    amountCents: cents(a.amountCents),
    reasonCode: a.reasonCode,
    reason: a.reason,
    approvedByUserId: a.approvedByUserId,
    createdAt: a.createdAt.toISOString(),
  };
}

export function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Venta de membresía ────────────────────────────────────────────────────



export const pagoBody = z.object({
  method: z.enum(['CASH', 'CARD_TERMINAL', 'SPEI_TRANSFER']),
  cashSessionId: z.string().uuid().optional(),
  externalRef: z.string().trim().max(120).optional(),
}).refine((p) => p.method !== 'SPEI_TRANSFER' || !!p.externalRef, {
  message: 'Una transferencia necesita su referencia o clave de rastreo', path: ['externalRef'],
}).nullable().default(null);
export const aPago = (p: z.infer<typeof pagoBody>) => (p ? {
  method: p.method, cashSessionId: p.cashSessionId ?? null, externalRef: p.externalRef ?? null,
} : null);
export const serializarMembresia = (m: { id: string; status: string; planId: string; currentPeriodStart: Date; currentPeriodEnd: Date }) => ({
  id: m.id, status: m.status, planId: m.planId,
  currentPeriodStart: iso(m.currentPeriodStart), currentPeriodEnd: iso(m.currentPeriodEnd),
});


export const dia = (d: Date) => d.toISOString().slice(0, 10);

/** Sucursal donde se vendió: es contra la que se autoriza operar la membresía. */
export async function sedeDeMembresia(orgId: string, membershipId: string): Promise<string | null> {
  const m = await new MembershipRepository(orgId).findById(membershipId);
  if (!m) throw notFound('Membresía no encontrada');
  return m.soldAtBranchId;
}
