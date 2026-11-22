import type { JobHandler, JobResult } from '../../platform/jobs/types.js';
import type { GymJob } from '../../platform/modules/types.js';
import { RemoteApprovalService } from './remote-approval.service.js';

/** Lo que `vencerOlvidadas` cierra por pasada (el tope de `pendingExpired`). */
const LOTE = 50;

/**
 * La pasada de las solicitudes de firma vencidas (pendiente de la fase 0,
 * bloque 0.9; la agrega 1.16). Una solicitud a distancia que venció sin
 * respuesta se cerraba y se asentaba solo cuando alguien volvía a leerla o
 * cuando quien firma abría su bandeja; si nadie lo hacía, se quedaba
 * PENDING y sin asiento. Este job llama al mismo servicio (`vencerOlvidadas`),
 * con la misma regla y el mismo asiento («el sistema dio por vencida…»).
 */
const expireForgotten: JobHandler = async (organizationId) => {
  const result: JobResult = { job: 'approvals.expire-forgotten', processed: 0, skipped: 0, batches: 1, truncated: false, errors: [] };
  result.processed = await new RemoteApprovalService().vencerOlvidadas(organizationId);
  result.truncated = result.processed >= LOTE;
  return result;
};

export const APPROVAL_JOBS: ReadonlyArray<GymJob> = [
  // Cada 15 minutos y también en el cierre diario: una solicitud vive minutos.
  { name: 'approvals.expire-forgotten', handler: expireForgotten, cadence: 'frequent' },
];
