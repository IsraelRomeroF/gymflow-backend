import type { JobHandler, JobResult } from '../jobs/types.js';
import type { ModuleJob } from '../modules/types.js';
import { AuditService } from './audit.service.js';
import { PlatformAuditService } from './platform-audit.service.js';

/**
 * Verificación diaria de la cadena de la bitácora. Una fila alterada a mano
 * en la base rompe la cadena; esto lo detecta al día siguiente y lo deja en
 * la salida del runner, que es donde alguien lo va a ver.
 */
const verifyHashChain: JobHandler = async (organizationId) => {
  const result: JobResult = {
    job: 'audit.verify-hash-chain', processed: 0, skipped: 0, batches: 0, truncated: false, errors: [],
  };
  const r = await new AuditService().verifyChain(organizationId);
  result.processed = r.checked;
  result.batches = Math.ceil(r.checked / 1000);
  if (!r.ok) result.errors.push({ entityId: r.brokenAtId, error: r.reason });
  return result;
};


/**
 * Verificación de la CADENA DE PLATAFORMA y de su enlace con las cadenas de
 * las marcas (24-19, 23-09; bloque 1.11). Es de plataforma: corre una vez por
 * corrida, no una por gimnasio. Queda exportado para que el corredor lo
 * registre (`{ name: 'audit.verify-platform-chain', scope: 'platform', handler }`).
 */
export const verifyPlatformChainJob = async (): Promise<JobResult> => {
  const result: JobResult = { job: 'audit.verify-platform-chain', processed: 0, skipped: 0, batches: 0, truncated: false, errors: [] };
  const r = await new PlatformAuditService().verify();
  result.processed = r.entries;
  result.batches = Math.ceil(r.entries / 1000);
  // Lo anterior a la cadena que falta importar no es un error: se avisa como saltado.
  result.skipped = r.links.previous;
  if (!r.ok) result.errors.push({ entityId: r.brokenAtId ?? 'cadena-de-plataforma', error: r.reason ?? 'la cadena de plataforma no verifica' });
  return result;
};

export const AUDIT_JOBS: ReadonlyArray<ModuleJob> = [
  { name: 'audit.verify-hash-chain', handler: verifyHashChain },
  { name: 'audit.verify-platform-chain', scope: 'platform', handler: verifyPlatformChainJob },
];
