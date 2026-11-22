import { addDays } from '@gymflow/core';
import { BillingCycleRepository } from './billing-cycle.repository.js';
import { MembershipRepository } from '../memberships/index.js';
import { PlanRepository } from '../catalog/index.js';
import { ChargeRepository } from './charge.repository.js';
import { BillingService } from './billing.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { RequestContext } from '../../platform/context.js';
import { systemContext, type JobHandler, type JobResult } from '../../platform/jobs/types.js';
import { BusinessCalendar, type DiaDeSedes } from '../../platform/time/business-calendar.js';

/**
 * Jobs del libro financiero (§29).
 *
 * La idempotencia NO se apoya en "consultar antes de insertar": se apoya en
 * índices únicos del motor. Dos ejecuciones simultáneas del generador pasarían
 * las dos por cualquier comprobación previa; ninguna pasa por el índice.
 */

const BATCH = 500;
const MAX_BATCHES = 200;

/**
 * «Hoy» por sede (2.13): cada membresía se decide con el día de la sede donde
 * se vendió y cada cargo con el de la suya. Casi siempre es un solo grupo
 * (todas las sedes en la misma fecha) y las consultas salen sin filtro.
 */
async function dias(organizationId: string): Promise<readonly DiaDeSedes[]> {
  return (await new BusinessCalendar(organizationId).dias()).grupos;
}

/**
 * 0. AUTORRENOVACIÓN: pasa al periodo siguiente cada membresía vigente con
 *    autorrenovación cuyo periodo ya terminó, y emite su cuota.
 *
 * Corre DESPUÉS de expirar los prepagos sin autorrenovación (job de
 * memberships) y ANTES de marcar mora: la mora ahora se decide por la cuota
 * vencida, y esa cuota es justo la que se emite aquí.
 *
 * Una membresía atrasada varios periodos (el job no corrió unos días) avanza
 * uno por vuelta hasta ponerse al día, con una cuota por periodo.
 */
export async function rollPeriods(organizationId: string): Promise<JobResult> {
  const result: JobResult = {
    job: 'billing.roll-periods', processed: 0, skipped: 0, batches: 0, truncated: false, errors: [],
  };
  const repo = new MembershipRepository(organizationId);
  const service = new BillingService();
  const ctx = systemContext(organizationId);
  // Por membresía Y periodo: la misma membresía vuelve con el periodo
  // siguiente si sigue atrasada, pero un fallo no se reintenta en bucle.
  const vistas = new Set<string>();

  for (const { day, sedes } of await dias(organizationId))
  while (result.batches < MAX_BATCHES) {
    const lote = (await repo.dueForRenewal(day, BATCH, sedes))
      .filter((m) => !vistas.has(`${m.id}:${m.currentPeriodStart.toISOString()}`));
    if (lote.length === 0) break;
    result.batches++;
    let avanzo = false;
    for (const m of lote) {
      vistas.add(`${m.id}:${m.currentPeriodStart.toISOString()}`);
      try {
        await service.advancePeriod(ctx, m.id, m.currentPeriodStart);
        result.processed++;
        avanzo = true;
      } catch (error) {
        const mensaje = error instanceof Error ? error.message : String(error);
        result.errors.push({ entityId: m.id, error: mensaje });
        // La membresía no avanzó (A3-N1): que la gerencia lo vea en la bitácora,
        // no solo en el resultado del job. Una vez por periodo, no cada noche.
        await avisarSinRenovar(ctx, m.id, m.soldAtBranchId, m.currentPeriodEnd, mensaje).catch(() => undefined);
      }
    }
    if (!avanzo) break;
  }
  result.truncated = result.batches >= MAX_BATCHES;
  return result;
}

/**
 * Deja en la bitácora que una membresía NO se pudo renovar y por qué (la
 * cuota no se emitió; casi siempre, su plan ya no tiene precio en la sede).
 * Una sola vez por periodo: el job lo reintenta cada noche hasta que se
 * corrija, y repetir el asiento solo llenaría la bitácora.
 */
async function avisarSinRenovar(ctx: RequestContext, membershipId: string, branchId: string | null, periodEnd: Date, mensaje: string): Promise<void> {
  const audit = new AuditService();
  const fin = periodEnd.toISOString().slice(0, 10);
  const previos = await audit.list(ctx.tenant.organizationId, { resourceId: membershipId, actions: ['membership.sin_renovar'], limit: 20 });
  if (previos.some((e) => (e.afterState as { periodEnd?: string } | null)?.periodEnd === fin)) return;
  await audit.record(ctx, {
    action: 'membership.sin_renovar',
    resourceType: 'Membership',
    resourceId: membershipId,
    branchId,
    afterState: { periodEnd: fin, motivo: mensaje, nota: 'La membresía no avanzó y no se emitió cuota: corrige el plan o su precio en la sucursal' },
  });
}

/**
 * 1. Genera la cuota del periodo en curso de cada membresía vigente.
 *
 * Ejecutarlo dos veces el mismo día NO duplica cargos: la pareja
 * (membresía, inicio de periodo) es única en la base.
 */
export async function generateCycleCharges(organizationId: string): Promise<JobResult> {
  const result: JobResult = {
    job: 'billing.generate-cycle-charges',
    processed: 0, skipped: 0, batches: 0, truncated: false, errors: [],
  };

  const cycles = new BillingCycleRepository(organizationId);
  const service = new BillingService();
  const ctx = systemContext(organizationId);
  const vistas = new Set<string>();

  // Una corrida de cobro por FECHA: con sedes en dos fechas, cada cuota queda
  // en la corrida del día de su sede (la del día anterior ya existe y acumula).
  for (const { day, sedes } of await dias(organizationId)) {
  const { cycle } = await cycles.start(day);
  let importe = 0n;
  const antes = { processed: result.processed, skipped: result.skipped };

  try {
    while (result.batches < MAX_BATCHES) {
      const pendientes = await cycles.membershipsNeedingPeriodCharge(day, BATCH, sedes);
      // Si vuelven los mismos que ya fallaron, la cola no avanza: se corta.
      const nuevos = pendientes.filter((p) => !vistas.has(p.membershipId));
      if (nuevos.length === 0) break;

      result.batches++;
      let avanzo = false;

      for (const pendiente of nuevos) {
        vistas.add(pendiente.membershipId);
        try {
          const { charge, created } = await service.createPeriodCharge(ctx, {
            membershipId: pendiente.membershipId,
            billingCycleId: cycle.id,
          });
          if (created) {
            result.processed++;
            importe += charge.amountCents;
            avanzo = true;
          } else {
            result.skipped++;
            avanzo = true;
          }
        } catch (error) {
          // Un plan mal configurado no puede dejar sin cobrar al resto del gimnasio.
          result.errors.push({
            entityId: pendiente.membershipId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!avanzo) break;
    }

    result.truncated = result.batches >= MAX_BATCHES;
    await cycles.complete(cycle.id, {
      chargesCreated: result.processed - antes.processed,
      chargesSkipped: result.skipped - antes.skipped,
      amountCents: importe,
    });
  } catch (error) {
    await cycles.fail(cycle.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
  }

  return result;
}

/**
 * 2. Marca vencidos los cargos que pasaron su fecha límite.
 *
 * El estado es DERIVADO del saldo, así que esto no decide nada: solo
 * materializa en la columna lo que la fecha ya volvió cierto, para que los
 * listados de cartera puedan filtrar por índice en vez de recalcular.
 */
export async function markOverdueCharges(organizationId: string): Promise<JobResult> {
  const result: JobResult = {
    job: 'billing.mark-overdue', processed: 0, skipped: 0, batches: 0, truncated: false, errors: [],
  };

  const charges = new ChargeRepository(organizationId);

  for (const { day, sedes } of await dias(organizationId))
  while (result.batches < MAX_BATCHES) {
    const lote = await charges.findDueForOverdue(day, BATCH, sedes);
    if (lote.length === 0) break;
    result.batches++;

    const marcados = await charges.markOverdue(lote.map((c) => c.id));
    result.processed += marcados;
    result.skipped += lote.length - marcados;
    // Si el lote no cambió ninguna fila, el filtro y la actualización
    // discrepan: seguir sería un bucle infinito.
    if (marcados === 0) break;
  }

  result.truncated = result.batches >= MAX_BATCHES;
  return result;
}

/**
 * 3. MORA: una membresía vigente con cuota o inscripción vencida entra en
 *    gracia (sigue entrando) desde su vencimiento más antiguo.
 *
 * Antes la mora la disparaba el fin del periodo, debiera o no algo el socio.
 */
export async function markMembershipsPastDue(organizationId: string): Promise<JobResult> {
  const result: JobResult = {
    job: 'billing.mark-memberships-past-due', processed: 0, skipped: 0, batches: 0, truncated: false, errors: [],
  };
  const cycles = new BillingCycleRepository(organizationId);
  const memberships = new MembershipRepository(organizationId);
  const plans = new PlanRepository(organizationId);
  const vistas = new Set<string>();

  for (const { day, sedes } of await dias(organizationId))
  while (result.batches < MAX_BATCHES) {
    const lote = (await cycles.membershipsWithOverdueDues(day, BATCH, sedes)).filter((r) => !vistas.has(r.membershipId));
    if (lote.length === 0) break;
    result.batches++;
    let avanzo = false;
    for (const { membershipId, oldestDueDate } of lote) {
      vistas.add(membershipId);
      try {
        const m = await memberships.findById(membershipId);
        if (!m) { result.skipped++; continue; }
        const graceDays = (await plans.findById(m.planId))?.defaultGraceDays ?? 5;
        const desdeVencimiento = addDays(oldestDueDate, graceDays);
        // La gracia nunca termina antes de que empiece el periodo en curso
        // (la base lo exige con un CHECK).
        const graceUntil = desdeVencimiento < m.currentPeriodStart ? m.currentPeriodStart : desdeVencimiento;
        await memberships.transition({
          membershipId,
          fromStatus: 'ACTIVE',
          toStatus: 'PAST_DUE',
          eventType: 'PAST_DUE',
          data: { graceUntil },
          payload: { graceDays, oldestDueDate: oldestDueDate.toISOString().slice(0, 10), graceUntil: graceUntil.toISOString().slice(0, 10) },
          businessDate: day,
        });
        result.processed++;
        avanzo = true;
      } catch (error) {
        result.errors.push({ entityId: membershipId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!avanzo) break;
  }
  result.truncated = result.batches >= MAX_BATCHES;
  return result;
}

/**
 * 3. Reconcilia el saldo cacheado del socio contra el derivado real.
 *
 * `processed` cuenta los socios que estaban DESVIADOS. En régimen debería ser
 * cero: si deja de serlo, hay un camino de escritura que no refresca la caché,
 * y esa es la señal que hay que vigilar.
 */
export async function reconcileBalances(organizationId: string): Promise<JobResult> {
  const drifted = await new BillingCycleRepository(organizationId).reconcileCachedBalances();
  return {
    job: 'billing.reconcile-balances',
    processed: drifted, skipped: 0, batches: 1, truncated: false, errors: [],
  };
}

/**
 * Orden deliberado: avanzar periodos y generar cuotas ANTES de marcar mora
 * (una cuota emitida hoy con vencimiento hoy no está vencida), la mora de la
 * membresía DESPUÉS de marcar vencidos los cargos, y reconciliar AL FINAL,
 * cuando el libro del día ya está cerrado.
 */
export const BILLING_JOBS: ReadonlyArray<{ name: string; handler: JobHandler }> = [
  { name: 'billing.roll-periods', handler: rollPeriods },
  { name: 'billing.generate-cycle-charges', handler: generateCycleCharges },
  { name: 'billing.mark-overdue', handler: markOverdueCharges },
  { name: 'billing.mark-memberships-past-due', handler: markMembershipsPastDue },
  { name: 'billing.reconcile-balances', handler: reconcileBalances },
];
