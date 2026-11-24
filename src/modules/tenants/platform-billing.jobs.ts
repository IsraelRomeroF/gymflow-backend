import type { JobResult, PlatformJobHandler } from '../../platform/jobs/types.js';
import type { PlatformJob } from '../../platform/modules/types.js';
import { DIAS_DE_GRACIA, hoyDeCobro } from './cobro-reglas.js';
import { PlatformBillingService } from './platform-billing.service.js';
import { PlatformCollectionsService } from './cobranza.service.js';
import { PlatformPricingService } from './platform-pricing.service.js';

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

/**
 * Cambios de precio y de plan anunciados (D-38, bloque 3.11): aplica los que
 * ya llegaron a su fecha y pone al día los avisos de los que siguen
 * anunciados. Va ANTES de emitir: la factura del mes sale con lo vigente.
 * Idempotente: un cambio se aplica una sola vez (lo marca la base).
 */
export async function aplicarCambiosDePrecio(ahora: Date = new Date()): Promise<JobResult> {
  const r = await new PlatformPricingService().correr(ahora);
  return {
    job: 'platform.prices.apply', processed: r.applied + r.notices, skipped: 0, batches: 1, truncated: false,
    errors: r.errors.map((e) => ({ entityId: e.id, error: e.error })),
  };
}

/**
 * Escalera de cobranza (D-37, bloque 3.11; ADR-046): los avisos al dueño que
 * falten (factura emitida, factura vencida) y la SUSPENSIÓN AUTOMÁTICA de la
 * marca que lleva 15 días de atraso avisado. Va DESPUÉS de emitir. Repetirlo
 * el mismo día no duplica avisos ni vuelve a suspender. Una marca con adeudo
 * vencido a la que no se le suspende porque su aviso no tiene constancia de
 * entrega NO es un error de la corrida (cuenta como saltada): la consola la
 * muestra en Cobranza → «Avisos por mandar» para que alguien se lo mande.
 */
export async function cobrarALasMarcas(ahora: Date = new Date()): Promise<JobResult> {
  const r = await new PlatformCollectionsService().correr(ahora);
  return {
    job: 'platform.collections', processed: r.noticesIssued + r.noticesOverdue + r.suspended.length, skipped: r.onHold.length + r.withoutDelivery.length, batches: 1, truncated: false,
    errors: r.failed.map((f) => ({ entityId: f.organizationId, error: `${f.tradeName}: ${f.error}` })),
  };
}

export const TENANT_JOBS: ReadonlyArray<PlatformJob> = [
  { name: 'platform.prices.apply', scope: 'platform', handler: () => aplicarCambiosDePrecio() },
  { name: 'platform.invoices.issue', scope: 'platform', handler: issueMonthly },
  { name: 'platform.collections', scope: 'platform', handler: () => cobrarALasMarcas() },
];
