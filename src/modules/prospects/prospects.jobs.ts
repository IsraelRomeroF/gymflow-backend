import type { JobHandler } from '../../platform/jobs/types.js';
import { ProspectAutoCloseService } from './auto-close.service.js';

/**
 * EL CIERRE SOLO (D-31, bloque 4.7): cada noche, los interesados abiertos con
 * 60 días sin contacto ni fecha pendiente se cierran solos (reabribles). La
 * primera corrida en un gimnasio no cierra a nadie: fija desde qué día cierra.
 * Es del módulo Prospectos: con el módulo apagado se salta (nadie ve la lista).
 */
const autoClose: JobHandler = async (organizationId) => {
  const r = await new ProspectAutoCloseService().pasada(organizationId);
  return { job: 'prospects.auto-close', processed: r.cerrados + (r.arranco ? 1 : 0), skipped: r.enEspera, batches: 1, truncated: r.truncated, errors: r.errores };
};

export const PROSPECT_JOBS: ReadonlyArray<{ name: string; handler: JobHandler }> = [
  { name: 'prospects.auto-close', handler: autoClose },
];
