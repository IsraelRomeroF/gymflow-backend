import { conflict, notFound, validation, canAutoRenew, type PlanBillingModel } from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { systemContext } from '../../platform/jobs/types.js';
import type { RequestContext } from '../../platform/context.js';
import { PlanRepository } from '../catalog/index.js';
import { MembershipRepository, type MembershipRecord } from './membership.repository.js';

/**
 * EL PLAN PAGADO POR ADELANTADO VENCE Y SE VUELVE A VENDER (D-14, bloque 3.5).
 *
 * Desde la fase 0 una anualidad nueva nace «no se renueva» salvo que en la
 * venta se elija lo contrario (`autoRenewFor` del núcleo). Aquí está lo que
 * faltaba: (1) cambiar esa elección después, en una membresía que ya existe,
 * con motivo; y (2) las anualidades VIVAS que nacieron «se renueva sola» sin
 * que nadie lo eligiera: se listan y, cuando alguien lo decide, pasan a «no
 * se renueva», salvo las que se digan.
 */
const audit = new AuditService();

/** Cambia si la membresía se renueva sola. Con motivo; deja el antes y el después. */
export async function cambiarRenovacion(ctx: RequestContext, input: { membershipId: string; autoRenew: boolean; reason: string }): Promise<MembershipRecord> {
  const orgId = ctx.tenant.organizationId;
  const repo = new MembershipRepository(orgId);
  return enUnaTransaccion(async () => {
    const m = await repo.findById(input.membershipId);
    if (!m) throw notFound('Membresía no encontrada');
    if (m.status === 'CANCELED' || m.status === 'EXPIRED') throw conflict('Esa membresía ya terminó: no hay nada que renovar');
    const plan = await new PlanRepository(orgId).findById(m.planId);
    if (!plan) throw notFound('Plan no encontrado');
    if (input.autoRenew && !canAutoRenew(plan.billingModel as PlanBillingModel)) {
      throw validation('Una visita suelta o un paquete de visitas no se renuevan solos: se vuelven a vender');
    }
    if (m.autoRenew === input.autoRenew) return m;
    const despues = await repo.setAutoRenew(m.id, input.autoRenew);
    if (!despues) throw conflict('La membresía cambió mientras se guardaba: vuelve a intentarlo', 'CONCURRENT_CHANGE');
    await audit.record(ctx, {
      action: 'membership.auto_renew.set', resourceType: 'Membership', resourceId: m.id, branchId: m.soldAtBranchId,
      beforeState: { autoRenew: m.autoRenew }, afterState: { autoRenew: input.autoRenew, planName: plan.name }, reason: input.reason,
    });
    return despues;
  });
}

export type PrepagoQueSeRenueva = {
  id: string; memberId: string; memberCode: string; planName: string; status: string;
  currentPeriodEnd: Date; createdAt: Date; priceCents: bigint;
  /** `true` si quedaría como está: alguien la eligió (por su id o por la fecha de venta). */
  seConserva: boolean;
};

/**
 * LA LISTA (solo lectura): los planes pagados por adelantado vivos que hoy «se
 * renuevan solos». `conservar`: los ids que alguien eligió dejar así.
 * `elegidasDesde`: las vendidas desde ese día se toman por elegidas (desde la
 * fase 0 la venta ya pregunta, así que una anualidad vendida después con «se
 * renueva sola» lo trae porque alguien lo marcó).
 */
export async function prepagosQueSeRenuevan(organizationId: string, opts: { conservar?: ReadonlySet<string>; elegidasDesde?: Date | null } = {}): Promise<PrepagoQueSeRenueva[]> {
  const filas = await new MembershipRepository(organizationId).prepagosQueSeRenuevan();
  return filas.map((f) => ({
    ...f,
    seConserva: (opts.conservar?.has(f.id) ?? false) || (!!opts.elegidasDesde && f.createdAt.getTime() >= opts.elegidasDesde.getTime()),
  }));
}

/**
 * APLICA: pasa a «no se renueva» las de la lista que no se conservan. Cada una
 * queda en la bitácora (como acto del sistema, con el motivo). Repetible: la
 * segunda corrida ya no encuentra nada que cambiar. No toca cargos, periodos
 * ni estados: lo único que cambia es qué pasa el día que su periodo termine
 * (vence, en vez de emitirse otra anualidad).
 */
export async function apagarRenovacionDePrepagos(organizationId: string, opts: { conservar?: ReadonlySet<string>; elegidasDesde?: Date | null; reason: string }): Promise<{ cambiadas: PrepagoQueSeRenueva[]; conservadas: PrepagoQueSeRenueva[] }> {
  const lista = await prepagosQueSeRenuevan(organizationId, opts);
  const repo = new MembershipRepository(organizationId);
  const ctx = systemContext(organizationId);
  const cambiadas: PrepagoQueSeRenueva[] = [];
  for (const f of lista.filter((x) => !x.seConserva)) {
    await enUnaTransaccion(async () => {
      if (!await repo.setAutoRenew(f.id, false)) return;
      await audit.record(ctx, {
        action: 'membership.auto_renew.set', resourceType: 'Membership', resourceId: f.id,
        beforeState: { autoRenew: true }, afterState: { autoRenew: false, planName: f.planName, migration: 'D-14' }, reason: opts.reason,
      });
      cambiadas.push(f);
    });
  }
  return { cambiadas, conservadas: lista.filter((x) => x.seConserva) };
}
