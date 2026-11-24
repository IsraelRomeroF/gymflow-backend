import { cuotaAlCerrar, cycleChargeKey, money, prorate, prorationBasis } from '@gymflow/core';
import { registerMembershipClosedHook, MembershipRepository, type MembershipClosed } from '../memberships/index.js';
import { PlanRepository } from '../catalog/index.js';
import { systemContext } from '../../platform/jobs/types.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import type { RequestContext } from '../../platform/context.js';
import { ChargeRepository } from './charge.repository.js';
import { BillingService } from './billing.service.js';

/**
 * QUÉ PASA CON EL DINERO CUANDO UNA MEMBRESÍA SE CIERRA (D-12 y D-13, bloque 3.5).
 *
 * Nada se borra solo. Al CANCELAR (una persona, la baja del socio o la venta
 * que nunca se cobró):
 *
 *  1. Las cuotas sin pagos se quedan como deuda, salvo las que una regla
 *     escrita anula (`cuotaAlCerrar`): la venta jamás cobrada ni activada
 *     (D-18) y el periodo que todavía no empieza. Antes se anulaban todas,
 *     sin firma: dar de baja a quien debía tres meses borraba los tres meses.
 *  2. Lo pagado y no usado queda A FAVOR del socio (D-13): los días que
 *     faltan del periodo en curso, prorrateados sobre lo que de verdad pagó, y
 *     entero lo de un periodo que no ha empezado. Si debe algo, ese saldo lo
 *     cubre primero (DM-02). Devolvérselo en dinero es otra operación, con la
 *     firma de la dueña (`POST /members/:id/credit/return`).
 *
 * Al EXPIRAR una suspendida no cambia nada: la deuda se queda, como antes.
 * Corre dentro de la unidad de dinero de quien cerró la membresía.
 */
export function registerBillingHooks(): void {
  registerMembershipClosedHook(async (e) => {
    const svc = new BillingService();
    if (e.outcome === 'CANCELED') {
      const m = await new MembershipRepository(e.organizationId).findById(e.membershipId);
      const hoy = await new BusinessCalendar(e.organizationId).today(m?.soldAtBranchId ?? null);
      const nuncaActiva = e.fromStatus === 'PENDING';
      const cargos = new ChargeRepository(e.organizationId);
      if (cuotaAlCerrar({ nuncaActiva, periodStart: null, today: hoy }) === 'VOID') {
        await cargos.voidUnpaidForMembership(e.membershipId, `Venta que nunca se cobró: ${e.reason}`);
      } else {
        await cargos.voidUnpaidForMembership(e.membershipId, `Periodo que no llegó a empezar: ${e.reason}`, { soloDesde: hoy });
      }
      if (m) await abonarLoNoUsado(svc, e, m, hoy);
    }
    await svc.refreshCachedBalance(e.organizationId, e.memberId);
  });
}

/** Lo pagado y no usado de una membresía que se cancela, al saldo a favor del socio (D-13). Idempotente por su llave. */
async function abonarLoNoUsado(
  svc: BillingService, e: MembershipClosed,
  m: { id: string; memberId: string; planId: string; soldAtBranchId: string | null; currentPeriodStart: Date; currentPeriodEnd: Date },
  hoy: Date,
): Promise<void> {
  const plan = await new PlanRepository(e.organizationId).findById(m.planId);
  // Una visita suelta o un paquete no son un periodo que se pueda partir en días.
  if (!plan || plan.billingModel === 'DAY_PASS' || plan.billingModel === 'VISIT_PACK') return;
  const cargos = new ChargeRepository(e.organizationId);
  let aFavor = 0n;
  let dias: { restantes: number; ciclo: number } | null = null;
  // El periodo en curso: los días que faltan, sobre lo PAGADO de verdad (sin descuentos ni condonaciones).
  const actual = await cargos.findByIdempotencyKey(cycleChargeKey(m.id, m.currentPeriodStart));
  if (actual && actual.allocatedCents > 0n && actual.status !== 'VOID') {
    if (m.currentPeriodStart.getTime() > hoy.getTime()) aFavor += actual.allocatedCents;
    else {
      const base = prorationBasis({ start: m.currentPeriodStart, end: m.currentPeriodEnd }, hoy);
      if (base.cycleDays > 0 && base.remainingDays > 0) {
        aFavor += prorate(money(actual.allocatedCents), base.remainingDays, base.cycleDays).cents;
        dias = { restantes: base.remainingDays, ciclo: base.cycleDays };
      }
    }
  }
  if (aFavor <= 0n) return;
  const base = systemContext(e.organizationId);
  const ctx: RequestContext = e.actorUserId ? { ...base, tenant: { ...base.tenant, actorType: 'USER', actorUserId: e.actorUserId } } : base;
  const nota = await svc.abonarSaldoAFavor(ctx, {
    memberId: m.memberId, branchId: m.soldAtBranchId, amountCents: aFavor, key: `cancel-unused-${m.id}`,
  });
  await svc.audit.record(ctx, {
    action: 'billing.credit.unused', resourceType: 'Member', resourceId: m.memberId, branchId: m.soldAtBranchId,
    afterState: {
      membershipId: m.id, amountCents: aFavor.toString(), paymentId: nota.id,
      ...(dias ? { remainingDays: dias.restantes, cycleDays: dias.ciclo } : {}),
    },
    reason: `Lo pagado y no usado al cancelar: ${e.reason}`.slice(0, 300),
  });
}
