import {
  applyFreeze, type MembershipStatus, type Period,
} from '@gymflow/core';
import { MembershipRepository } from './membership.repository.js';
import { VisitPackRepository } from './visitpack.repository.js';
import { emitMembershipClosed } from './closed-hooks.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { RequestContext } from '../../platform/context.js';
import { systemContext, type JobHandler, type JobResult } from '../../platform/jobs/types.js';
import { BusinessCalendar, type DiaDeSedes, type SedesDelDia } from '../../platform/time/business-calendar.js';
import { plazosDe } from '../../platform/plazos/plazos-del-socio.repository.js';

/**
 * Jobs del motor de membresías (§29).
 *
 * TODOS son IDEMPOTENTES por construcción: la transición solo se aplica si la
 * membresía sigue en el estado esperado (`updateMany ... where status`), así
 * que reejecutar un job el mismo día no produce efectos dobles. Eso importa
 * porque BullMQ es *at-least-once* (ADR-017, condición 4).
 *
 * La infraestructura de colas llega con los sprints de facturación. Hasta
 * entonces se invocan con `pnpm --filter @gymflow/api jobs:daily`.
 */


/**
 * Tope de seguridad. El job DRENA la cola por lotes en lugar de procesar uno
 * solo: con ~3,000 membresías vigentes, un job diario limitado a 500 tardaría
 * seis días en ponerse al corriente y nunca alcanzaría. El tope evita un
 * bucle infinito si una transición falla siempre sin cambiar de estado.
 */
const MAX_BATCHES = 200;


/**
 * «Hoy» por sede (2.13): cada membresía se decide con el día de operación de
 * la sede donde se vendió, no con el del gimnasio. Una membresía de Tijuana en
 * un gimnasio de la Ciudad de México vencía una o dos horas antes de que
 * terminara su último día pagado. Casi siempre es un solo grupo (todas las
 * sedes en la misma fecha) y la consulta sale sin filtro, igual que antes.
 */
async function dias(organizationId: string): Promise<readonly DiaDeSedes[]> {
  return (await new BusinessCalendar(organizationId).dias()).grupos;
}

async function run(
  job: string,
  organizationId: string,
  fetch: (repo: MembershipRepository, day: Date, sedes: SedesDelDia | null) => Promise<Array<{ id: string; status: MembershipStatus }>>,
  apply: (input: {
    repo: MembershipRepository; ctx: RequestContext; day: Date;
    membership: { id: string; status: MembershipStatus };
  }) => Promise<boolean>,
): Promise<JobResult> {
  const repo = new MembershipRepository(organizationId);
  const ctx = systemContext(organizationId);
  const result: JobResult = { job, processed: 0, skipped: 0, batches: 0, truncated: false, errors: [] };
  const seen = new Set<string>();

  // Un grupo por fecha: las sedes que hoy comparten día de operación.
  for (const { day, sedes } of await dias(organizationId)) {
    while (result.batches < MAX_BATCHES) {
      const candidates = await fetch(repo, day, sedes);
      // Si vuelven los mismos que ya fallaron, la cola no avanza: se corta.
      const pendientes = candidates.filter((c) => !seen.has(c.id));
      if (pendientes.length === 0) break;

      result.batches++;
      let avanzo = false;
      for (const membership of pendientes) {
        seen.add(membership.id);
        try {
          const done = await apply({ repo, ctx, day, membership });
          if (done) { result.processed++; avanzo = true; }
          else result.skipped++;
        } catch (error) {
          // Un fallo en un socio no puede detener el lote: se registra y sigue.
          result.errors.push({ entityId: membership.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (!avanzo) break;
    }
  }
  result.truncated = result.batches >= MAX_BATCHES;
  return result;
}

/**
 * 1. Expiración de prepagos SIN autorrenovación.
 *
 * Corre ANTES que `markPastDue`: si no, una anualidad que no se renueva
 * pasaría a morosa en vez de expirar, y se le reclamaría un dinero que el
 * socio nunca acordó pagar.
 */
export const expireMemberships: JobHandler = (organizationId) =>
  run('membership.expire', organizationId,
    (repo, day, sedes) => repo.dueForExpiry(day, 500, sedes),
    async ({ repo, day, membership }) => {
      await repo.transition({
        membershipId: membership.id,
        fromStatus: 'ACTIVE',
        toStatus: 'EXPIRED',
        eventType: 'EXPIRED',
        data: { endedAt: new Date() },
        payload: { motivo: 'Fin de vigencia sin autorrenovación' },
        businessDate: day,
      });
      return true;
    });

// La MORA ya no vive aquí: la decide billing (`billing.mark-memberships-past-
// due`), porque depende de si hay una cuota vencida y este módulo no ve los
// cargos. Antes bastaba con que terminara el periodo, aunque nunca se
// hubiera emitido la cuota siguiente.

/**
 * 3. Se agotó la gracia: suspensión.
 *
 * SUSPENDED no extiende el periodo —a diferencia de FROZEN— porque el socio
 * perdió esos días por mora. La deuda NO se borra.
 */
export const suspendExpiredGrace: JobHandler = (organizationId) =>
  run('membership.suspend-expired-grace', organizationId,
    (repo, day, sedes) => repo.dueForSuspension(day, 500, sedes),
    async ({ repo, day, membership }) => {
      await repo.transition({
        membershipId: membership.id,
        fromStatus: 'PAST_DUE',
        toStatus: 'SUSPENDED',
        eventType: 'SUSPENDED',
        payload: { motivo: 'Gracia agotada', nota: 'La deuda persiste; el periodo NO se extiende' },
        businessDate: day,
      });
      return true;
    });

/** 4. Fin del congelamiento programado: reactiva y EXTIENDE el periodo. */
export const unfreezeScheduled: JobHandler = (organizationId) =>
  run('membership.unfreeze-scheduled', organizationId,
    (repo, day, sedes) => repo.dueForUnfreeze(day, 500, sedes),
    async ({ repo, day, membership }) => {
      const full = await repo.findById(membership.id);
      if (!full) return false;
      const since = full.frozenSince ?? day;
      const effectiveDays = Math.max(0, Math.round((day.getTime() - since.getTime()) / 86_400_000));
      const period: Period = { start: full.currentPeriodStart, end: full.currentPeriodEnd };
      const extended = applyFreeze(period, effectiveDays);

      await repo.transition({
        membershipId: membership.id,
        fromStatus: 'FROZEN',
        toStatus: 'ACTIVE',
        eventType: 'UNFROZEN',
        data: { currentPeriodEnd: extended.end, frozenSince: null, frozenUntil: null },
        payload: { effectiveDays, periodEndAfter: extended.end.toISOString().slice(0, 10) },
        businessDate: day,
      });
      return true;
    });

/**
 * 5. Caducidad de paquetes de visitas.
 *
 * La caducidad es un EVENTO CON FECHA y deja un asiento en el libro por las
 * visitas perdidas: sin eso no hay registro de cuánto se perdió ni cuándo, y
 * el reconocimiento de ingreso diferido es imposible (ADR-024).
 */
export async function expireVisitPacks(organizationId: string): Promise<JobResult> {
  const packs = new VisitPackRepository(organizationId);
  const audit = new AuditService();
  const ctx = systemContext(organizationId);

  const result: JobResult = { job: 'visitpack.expire', processed: 0, skipped: 0, batches: 0, truncated: false, errors: [] };
  for (const { day, sedes } of await dias(organizationId))
  for (const pack of await packs.dueForExpiry(day, 5000, sedes)) {
    try {
      const balance = await packs.balance(pack.id);
      if (balance > 0) {
        await packs.addEntry({
          visitPackId: pack.id,
          entryType: 'EXPIRE',
          delta: -balance,
          reason: `Caducidad del paquete el ${day.toISOString().slice(0, 10)}`,
          businessDate: day,
        });
      }
      await packs.setStatus(pack.id, 'EXPIRED', new Date());
      await audit.record(ctx, {
        action: 'visitpack.expire',
        resourceType: 'VisitPack',
        resourceId: pack.id,
        afterState: { visitasPerdidas: balance, expiresOn: pack.expiresOn?.toISOString().slice(0, 10) ?? null },
      });
      result.processed++;
    } catch (error) {
      result.errors.push({ entityId: pack.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/**
 * 6. Cierra las membresías de socios ARCHIVADOS.
 *
 * Archivar un socio no cancelaba su membresía. Al ejecutar la plataforma
 * aparecieron **15,073 membresías vivas de socios archivados**: el 88% del MRR
 * era ingreso fantasma, y sin la regla del motor de acceso habrían abierto el
 * torniquete.
 *
 * Es un job y no una cascada en el momento de archivar porque `members` no
 * puede depender de `memberships` —`memberships` ya depende de `members`, y el
 * ciclo dejaría inextraíbles a los dos módulos (ADR-026)—. El job vive del
 * lado que sí puede mirar a los dos.
 */
const closeArchivedMembers: JobHandler = (organizationId) =>
  run('membership.close-archived', organizationId,
    async (repo, _day, sedes) => repo.liveForArchivedMembers(500, sedes),
    async ({ repo, day, membership }) => {
      await repo.transition({
        membershipId: membership.id,
        fromStatus: membership.status,
        toStatus: 'CANCELED',
        eventType: 'CANCELED',
        // `cancellationReason` va en la MEMBRESÍA, no solo en el evento: la
        // base exige motivo para cancelar y lo comprueba con un CHECK.
        data: {
          canceledAt: new Date(),
          endedAt: new Date(),
          cancellationReason: 'El socio fue archivado',
        },
        reason: 'El socio fue archivado',
        payload: { motivo: 'Cierre automático: el socio está archivado' },
        businessDate: day,
      });
      await emitMembershipClosed({ organizationId, membershipId: membership.id, memberId: (await repo.findById(membership.id))!.memberId, outcome: 'CANCELED', reason: 'El socio fue archivado', fromStatus: membership.status, actorUserId: null });
      return true;
    });

/**
 * LOS DOS PLAZOS DE ESTOS JOBS SON DEL GIMNASIO (D-18, bloque 4.4): cuántos
 * días puede quedarse una venta sin cobrar antes de cancelarse sola (de
 * fábrica 7; antes eran 14, escritos aquí) y cuántos lleva una suspendida sin
 * pagar antes de terminar (de fábrica 90). Su única definición es
 * `PLAZOS_DEL_SOCIO` del núcleo; lo ajustado por el gimnasio (con la firma de
 * la dueña) se lee en cada corrida.
 */

/**
 * Una venta sin cobro no es un contrato: al plazo del gimnasio se cancela y
 * sus cuotas dejan de ser deuda (DM-07; es la regla escrita `cuotaAlCerrar`,
 * no un perdón: nunca se cobró ni dio acceso). Antes quedaba PENDING para
 * siempre, inflaba la cartera y bloqueaba una venta nueva.
 */
export const expirePendingSales: JobHandler = async (organizationId) => {
  const { unpaidSaleDays } = await plazosDe(organizationId);
  return run('membership.expire-pending-sales', organizationId,
    (repo, day, sedes) => repo.pendingOlderThan(day, unpaidSaleDays, 500, sedes),
    async ({ repo, day, membership }) => {
      const motivo = `Venta sin cobro en ${unpaidSaleDays} días`;
      await repo.transition({
        membershipId: membership.id, fromStatus: 'PENDING', toStatus: 'CANCELED', eventType: 'CANCELED',
        data: { canceledAt: new Date(), endedAt: new Date(), cancellationReason: motivo },
        reason: motivo, payload: { motivo: 'Cierre automático: nunca se cobró' }, businessDate: day,
      });
      await emitMembershipClosed({ organizationId, membershipId: membership.id, memberId: (await repo.findById(membership.id))!.memberId, outcome: 'CANCELED', reason: motivo, fromStatus: membership.status, actorUserId: null });
      return true;
    });
};

/**
 * Una suspendida que lleva el plazo del gimnasio sin pagar termina (DM-07).
 * La deuda que dejó NO se borra ni se condona (D-12): desde esa noche se da
 * por perdida (`billing.mark-lost-debt`, el job que sigue): sale de «Por
 * cobrar», se queda en el estado de cuenta del socio y se puede cobrar.
 */
export const expireSuspended: JobHandler = async (organizationId) => {
  const { lostDebtDays } = await plazosDe(organizationId);
  return run('membership.expire-suspended', organizationId,
    (repo, day, sedes) => repo.suspendedOlderThan(day, lostDebtDays, 500, sedes),
    async ({ repo, day, membership }) => {
      await repo.transition({
        membershipId: membership.id, fromStatus: 'SUSPENDED', toStatus: 'EXPIRED', eventType: 'EXPIRED',
        data: { endedAt: new Date() },
        reason: `${lostDebtDays} días suspendida sin pagar`, payload: { motivo: 'Ventana de recuperación agotada' }, businessDate: day,
      });
      await emitMembershipClosed({ organizationId, membershipId: membership.id, memberId: (await repo.findById(membership.id))!.memberId, outcome: 'EXPIRED', reason: 'Ventana de recuperación agotada', fromStatus: membership.status, actorUserId: null });
      return true;
    });
};

/** Orden deliberado: expirar antes de que billing avance periodos o marque mora. */
export const MEMBERSHIP_JOBS: ReadonlyArray<{ name: string; handler: JobHandler }> = [
  { name: 'membership.expire', handler: expireMemberships },
  { name: 'membership.suspend-expired-grace', handler: suspendExpiredGrace },
  { name: 'membership.unfreeze-scheduled', handler: unfreezeScheduled },
  { name: 'visitpack.expire', handler: expireVisitPacks },
  { name: 'membership.close-archived', handler: closeArchivedMembers },
  { name: 'membership.expire-pending-sales', handler: expirePendingSales },
  { name: 'membership.expire-suspended', handler: expireSuspended },
];


