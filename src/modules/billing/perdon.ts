import {
  DIAS_DEL_TOPE_DE_PERDON, conflict, mensualidadDe, notFound, perdonSinFirma, type PlanDuration,
} from '@gymflow/core';
import { enUnidadDeDinero } from '../../platform/db/unit-of-work.js';
import type { RequestContext } from '../../platform/context.js';
import { PlanRepository } from '../catalog/index.js';
import { MemberRepository } from '../members/index.js';
import { MembershipRepository } from '../memberships/index.js';
import { ChargeRepository, type ChargeRecord } from './charge.repository.js';
import { precioDeCuotaDe } from './precio-de-cuota.js';
import { saldo, type BillingService } from './billing.service.js';

/**
 * PERDONAR DINERO (D-12, auditoría 8, bloque 3.5).
 *
 * Nada se borra solo: una deuda deja de cobrarse porque alguien la cobró, la
 * perdonó con su nombre y su monto, o porque una regla escrita la anula
 * (`cuotaAlCerrar` del núcleo). La gerencia perdona sola hasta una
 * mensualidad del socio; arriba de eso firma la dueña.
 */

export type PerdonDisponible = {
  /** Una mensualidad del socio; `null` si nunca tuvo plan. */
  mensualidadCents: bigint | null;
  /** Lo ya perdonado SIN firma en la ventana. */
  usadoCents: bigint;
  disponibleCents: bigint;
};

/**
 * Cuánto se le puede perdonar a este socio sin firma, HOY.
 *
 * La mensualidad sale de su membresía vigente o suspendida; si ya no tiene,
 * de la última que tuvo (el que se dio de baja debiendo también tiene tope).
 * Lo gastado son las condonaciones de los últimos 30 días que nadie firmó.
 */
export async function perdonDisponible(organizationId: string, memberId: string, ahora = new Date()): Promise<PerdonDisponible> {
  const membresias = new MembershipRepository(organizationId);
  const m = await membresias.findCurrentForMember(memberId) ?? (await membresias.listForMember(memberId))[0] ?? null;
  let mensualidadCents: bigint | null = null;
  if (m) {
    const plan = await new PlanRepository(organizationId).findById(m.planId);
    if (plan) {
      mensualidadCents = mensualidadDe(await precioDeCuotaDe(organizationId, m, plan),
        { unit: plan.durationUnit as PlanDuration['unit'], value: plan.durationValue });
    }
  }
  const desde = new Date(ahora.getTime() - DIAS_DEL_TOPE_DE_PERDON * 86_400_000);
  const usadoCents = await new ChargeRepository(organizationId).waivedWithoutApprovalSince(memberId, desde);
  const { disponibleCents } = perdonSinFirma({ mensualidadCents, perdonadoSinFirmaCents: usadoCents, montoCents: 0n });
  return { mensualidadCents, usadoCents, disponibleCents };
}

/** Los cargos con deuda de un socio (o solo los de una membresía suya). */
export async function cargosConDeuda(organizationId: string, memberId: string, membershipId?: string | null): Promise<ChargeRecord[]> {
  return (await new ChargeRepository(organizationId).listOutstanding(memberId))
    .filter((c) => saldo(c) > 0n && (!membershipId || c.membershipId === membershipId));
}

/**
 * PERDONAR EL ADEUDO de un socio (todo, o el de una membresía): una
 * condonación por cargo, cada una con su monto y su motivo de catálogo, en
 * UNA unidad de dinero con su asiento. Es lo que elige quien da de baja o
 * cancela cuando decide «perdonarla»; por omisión la deuda se queda.
 *
 * Idempotente por estado: repetida, ya no encuentra deuda y responde 409.
 */
export async function condonarAdeudo(svc: BillingService, ctx: RequestContext, input: {
  memberId: string; membershipId?: string | null; reason: string; reasonCode: string; approvedByUserId?: string | null;
}): Promise<{ charges: Array<{ charge: ChargeRecord; forgivenCents: bigint }>; forgivenCents: bigint }> {
  const orgId = ctx.tenant.organizationId;
  return enUnidadDeDinero(orgId, async () => {
    if (!await new MemberRepository(orgId).findById(input.memberId)) throw notFound('Socio no encontrado');
    const abiertos = await cargosConDeuda(orgId, input.memberId, input.membershipId);
    if (abiertos.length === 0) throw conflict('No debe nada: no hay adeudo que perdonar', 'NO_DEBT');
    const hechos: Array<{ charge: ChargeRecord; forgivenCents: bigint }> = [];
    let total = 0n;
    for (const c of abiertos) {
      const monto = saldo(c);
      const charge = await svc.adjustCharge(ctx, {
        chargeId: c.id, adjustmentType: 'WAIVER', amountCents: monto,
        reason: input.reason, reasonCode: input.reasonCode, approvedByUserId: input.approvedByUserId ?? null,
      });
      hechos.push({ charge, forgivenCents: monto });
      total += monto;
    }
    await svc.audit.record(ctx, {
      action: 'billing.debt.waive', resourceType: 'Member', resourceId: input.memberId,
      afterState: { amountCents: total.toString(), charges: hechos.length, ...(input.membershipId ? { membershipId: input.membershipId } : {}) },
      reason: input.reason, approvedByUserId: input.approvedByUserId ?? null,
    });
    await svc.refreshCachedBalance(orgId, input.memberId);
    return { charges: hechos, forgivenCents: total };
  });
}
