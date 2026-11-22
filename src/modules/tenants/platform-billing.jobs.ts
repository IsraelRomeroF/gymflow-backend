import type { JobResult, PlatformJobHandler } from '../../platform/jobs/types.js';
import type { PlatformJob } from '../../platform/modules/types.js';
import { DIAS_DE_GRACIA, hoyDeCobro } from './cobro-reglas.js';
import { PlatformBillingService } from './platform-billing.service.js';

/**
 * Factura del mes a las marcas (DP-03). Idempotente: la que ya tiene factura
 * viva del mes se salta; la que no tiene precios completos sale como error
 * para que la plataforma la vea, no se factura a ciegas.
 *
 * Es un job de PLATAFORMA (23-12, bloque 1.16): corre UNA vez por corrida y
 * `emitirMes` recorre las marcas.
 *
 * El día y el mes son los de la Ciudad de México (bloque 1.13): con el día
 * UTC, entre las 18:00 y las 24:00 del último día del mes ya era «día 1» y
 * se emitía el mes siguiente un día antes. Una marca que falla no corta el
 * lote: sale en `errors` con su nombre y las demás reciben su factura.
 */
export async function emitirElMes(ahora: Date = new Date()): Promise<JobResult> {
  const result: JobResult = { job: 'platform.invoices.issue', processed: 0, skipped: 0, batches: 1, truncated: false, errors: [] };
  const hoy = hoyDeCobro(ahora);
  if (Number(hoy.slice(8, 10)) > DIAS_DE_GRACIA) { result.skipped = 1; return result; }
  const r = await new PlatformBillingService().emitirMes(null, hoy.slice(0, 7), ahora);
  result.processed = r.issued.length;
  for (const saltada of r.skipped) {
    if (saltada.code === 'MISSING_PRICES') result.errors.push({ entityId: saltada.organizationId, error: saltada.reason });
    else result.skipped += 1;
  }
  for (const fallo of r.failed) result.errors.push({ entityId: fallo.organizationId, error: `${fallo.tradeName}: ${fallo.error}` });
  return result;
}

const issueMonthly: PlatformJobHandler = () => emitirElMes();

export const TENANT_JOBS: ReadonlyArray<PlatformJob> = [
  { name: 'platform.invoices.issue', scope: 'platform', handler: issueMonthly },
];
