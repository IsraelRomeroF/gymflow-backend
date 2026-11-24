import { systemContext, type JobResult } from '../../platform/jobs/types.js';
import { ClassService } from './class.service.js';

/**
 * Jobs de clases.
 *
 * Los dos son idempotentes: generar el horizonte no duplica clases
 * (`occurrenceKey`) y cerrar las terminadas solo toca las que siguen abiertas.
 */

const LOTE = 200;

/**
 * El horizonte respeta la sede (19-04): el runner salta el trabajo cuando el
 * gimnasio apagó Clases, y aquí se saltan los horarios de una sede que dejó de
 * usarlas o se cerró. `skipped` cuenta esos horarios.
 */
async function generarHorizonte(organizationId: string): Promise<JobResult> {
  const r = await new ClassService().materializeHorizon(organizationId, { days: 21 });
  return {
    job: 'class.materialize-horizon',
    processed: r.created,
    skipped: r.skipped,
    batches: 1,
    truncated: false,
    errors: r.shifted > 0
      ? [{ entityId: 'horizonte', error: `${r.shifted} clases movidas por el cambio de hora` }]
      : [],
  };
}

async function cerrarTerminadas(organizationId: string): Promise<JobResult> {
  const r = await new ClassService().closeFinished(organizationId, new Date(), LOTE);
  return {
    job: 'class.close-finished',
    processed: r.closed,
    skipped: 0,
    batches: 1,
    truncated: r.closed === LOTE,
    errors: [],
  };
}

/** D-16 (bloque 3.5): libera los lugares apartados sin pagar una hora antes de su clase. No dejan deuda ni falta. */
async function liberarApartados(organizationId: string): Promise<JobResult> {
  const r = await new ClassService().releaseUnpaidHolds(organizationId, new Date(), LOTE);
  return { job: 'class.release-unpaid-holds', processed: r.released, skipped: r.kept, batches: 1, truncated: r.truncated, errors: [] };
}

export const CLASS_JOBS = [
  { name: 'class.materialize-horizon', handler: generarHorizonte },
  // Cada 15 minutos (11-09): asistió, faltó y el bloqueo se resuelven al
  // terminar la clase, no hasta el siguiente cierre diario.
  { name: 'class.close-finished', handler: cerrarTerminadas, cadence: 'frequent' },
  // Cada 15 minutos (D-16): el apartado sin pagar se libera una hora antes de la clase.
  { name: 'class.release-unpaid-holds', handler: liberarApartados, cadence: 'frequent' },
] as const;

export { systemContext };
