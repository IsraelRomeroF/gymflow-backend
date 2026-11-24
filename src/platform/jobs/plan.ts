import type { ModuleKey } from '@gymflow/core';
import type { BackendModule, GymJob, PlatformJob } from '../modules/types.js';
import type { JobCadence } from './types.js';

export type PlannedGymJob = Omit<GymJob, 'module' | 'cadence'> & { module: ModuleKey; origen: string; cadence: JobCadence };
export type PlannedPlatformJob = Omit<PlatformJob, 'cadence'> & { origen: string; cadence: JobCadence };
export type PlannedJob = PlannedGymJob | PlannedPlatformJob;

export const esDePlataforma = (job: PlannedJob): job is PlannedPlatformJob => job.scope === 'platform';

/** Todos los trabajos de todos los módulos, con el módulo de producto de cada uno. */
export function allJobs(modules: readonly BackendModule[]): Map<string, PlannedJob> {
  const salida = new Map<string, PlannedJob>();
  for (const mod of modules) {
    for (const j of mod.jobs ?? []) {
      if (salida.has(j.name)) throw new Error(`Dos módulos declaran el job ${j.name} (${salida.get(j.name)!.origen} y ${mod.name})`);
      salida.set(j.name, j.scope === 'platform'
        ? { ...j, origen: mod.name, cadence: j.cadence ?? 'daily' }
        : { ...j, module: j.module ?? mod.module, origen: mod.name, cadence: j.cadence ?? 'daily' });
    }
  }
  return salida;
}

/**
 * ¿Corre este trabajo para un gimnasio con estos módulos activos?
 *
 * Un módulo apagado deja de GENERAR: sus trabajos se saltan, salvo los que
 * cierran lo abierto o resuelven dinero en tránsito (ADR-036).
 */
export function runsFor(job: PlannedGymJob, activos: ReadonlySet<ModuleKey>): boolean {
  return activos.has(job.module) || job.whenDisabled === 'run';
}

/**
 * EL ORDEN DEL CIERRE DIARIO, por nombre y a propósito:
 *  1. Cerrar lo que ya no debe avanzar (prepagos que expiran, socios
 *     archivados) y reactivar congelados que ya cumplieron.
 *  2. Avanzar periodos con autorrenovación y emitir sus cuotas.
 *  3. Marcar cargos vencidos y, con ellos, la mora de la membresía.
 *  4. Suspender a quien agotó la gracia — DESPUÉS de marcar la mora, para
 *     que un atraso de varios días no gane un día extra de acceso.
 *  5. Lo demás, y la reconciliación de saldos al final.
 *  6. Verificar la bitácora: después de todo lo que escribe en ella.
 * Si un job diario nuevo no se lista aquí, el runner falla en lugar de omitirlo.
 */
export const ORDEN_DIARIO: readonly string[] = [
  'membership.expire', 'membership.expire-pending-sales', 'membership.close-archived', 'membership.unfreeze-scheduled',
  'billing.roll-periods', 'billing.generate-cycle-charges',
  'billing.mark-overdue', 'billing.mark-memberships-past-due',
  'membership.suspend-expired-grace', 'membership.expire-suspended',
  // Avisos al socio DESPUÉS de marcar mora y suspender: el "vencido" es de hoy (PS-03).
  'portal.notices',
  // La lista de mensajes por mandar (2.9), con la misma mora y suspensión de hoy.
  'outbound.generate',
  'visitpack.expire',
  'class.materialize-horizon',
  'payments.expire-cards',
  'billing.reconcile-balances',
  'privacy.retention',
  // Conservación (D-32, bloque 3.9): después de cerrar las membresías de quien
  // se dio de baja, y antes de verificar la bitácora (escribe en ella).
  'privacy.conservation',
  'audit.verify-hash-chain',
];

/**
 * EL CORREDOR DE 15 MINUTOS (11-09): lo que depende de la hora del día y no
 * puede esperar al cierre. Primero lo que mueve dinero, luego lo que cierra.
 * Todos corren también dentro del cierre diario, después de los diarios.
 */
export const ORDEN_FRECUENTE: readonly string[] = [
  'payments.process-webhooks',
  'payments.resolve-unknown',
  // D-16 (bloque 3.5): antes de cerrar clases, se liberan los lugares apartados sin pagar.
  'class.release-unpaid-holds',
  'class.close-finished',
  'approvals.expire-forgotten',
];

/** Los de PLATAFORMA: una vez por corrida, fuera del bucle por gimnasio (23-12). */
export const ORDEN_PLATAFORMA: readonly string[] = [
  // Los cambios de precio anunciados que ya llegaron a su fecha (D-38, 3.11): ANTES de emitir.
  'platform.prices.apply',
  'platform.invoices.issue',
  // Avisos de cobranza y suspensión automática a los 15 días (D-37, 3.11): DESPUÉS de emitir.
  'platform.collections',
  // La cadena de plataforma se verifica después de lo que la corrida asienta en ella.
  'audit.verify-platform-chain',
];

export type Ordenes = { diario: readonly string[]; frecuente: readonly string[]; plataforma: readonly string[] };
export const ORDENES: Ordenes = { diario: ORDEN_DIARIO, frecuente: ORDEN_FRECUENTE, plataforma: ORDEN_PLATAFORMA };

export type Planes = {
  /** Jobs de gimnasio de cadencia diaria, en orden. */
  diario: PlannedGymJob[];
  /** Jobs de gimnasio de cadencia frecuente, en orden. */
  frecuente: PlannedGymJob[];
  /** Jobs de plataforma, en orden. */
  plataforma: PlannedPlatformJob[];
};

/**
 * Arma los tres planes a partir de los módulos y comprueba que cada job
 * declarado tenga un lugar, y uno solo, en el orden que le toca por cadencia
 * y alcance. Un job sin lugar, o en el orden equivocado, revienta aquí: en el
 * arranque del runner, no una noche cualquiera. `ordenes` solo se cambia en
 * las pruebas del corredor.
 */
export function armarPlanes(modules: readonly BackendModule[], ordenes: Ordenes = ORDENES): Planes {
  const todos = allJobs(modules);
  const esperado = (j: PlannedJob) => (esDePlataforma(j) ? ordenes.plataforma : j.cadence === 'frequent' ? ordenes.frecuente : ordenes.diario);
  const nombre = (j: PlannedJob) => (esDePlataforma(j) ? 'de plataforma' : j.cadence === 'frequent' ? 'frecuente' : 'diario');
  const sinLugar = [...todos.values()].filter((j) => !esperado(j).includes(j.name));
  if (sinLugar.length) {
    throw new Error(`Jobs sin lugar en su orden: ${sinLugar.map((j) => `${j.name} (${nombre(j)})`).join(', ')}`);
  }
  const toma = <T extends PlannedJob>(orden: readonly string[], filtro: (j: PlannedJob) => j is T): T[] => orden.map((n) => {
    const job = todos.get(n);
    if (!job) throw new Error(`Job desconocido en el orden: ${n}`);
    if (!filtro(job)) throw new Error(`El job ${n} está en el orden equivocado: es ${nombre(job)}`);
    return job;
  });
  return {
    diario: toma(ordenes.diario, (j): j is PlannedGymJob => !esDePlataforma(j) && j.cadence === 'daily'),
    frecuente: toma(ordenes.frecuente, (j): j is PlannedGymJob => !esDePlataforma(j) && j.cadence === 'frequent'),
    plataforma: toma(ordenes.plataforma, (j): j is PlannedPlatformJob => esDePlataforma(j)),
  };
}
