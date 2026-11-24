import type { JobHandler } from '../../platform/jobs/types.js';
import type { ModuleJob } from '../../platform/modules/types.js';
import { AnomalyScanService } from './anomaly-scan.service.js';
import { WeeklySummaryService } from './weekly-summary.service.js';

/**
 * LOS DOS JOBS DE LOS AVISOS A LA DUEÑA (bloque 4.2; D-05). Los dos son del
 * corredor de 15 minutos (`ORDEN_FRECUENTE`): un aviso «al momento» no puede
 * esperar al cierre de la noche y el resumen depende de la hora del gimnasio.
 * Como todo lo frecuente, corren también dentro del cierre diario.
 *
 * `skipped` va siempre en cero a propósito: lo ya avisado se vuelve a encontrar
 * en cada corrida, y un job frecuente que no hizo nada no debe dejar renglón
 * en `job_runs` cada 15 minutos.
 *
 * Son del módulo base y corren con cualquier módulo apagado: cada fuente
 * (caja, puerta, privacidad) simplemente no encuentra nada.
 */
const anomalyScan: JobHandler = async (organizationId) => {
  const r = await new AnomalyScanService().pasada(organizationId);
  return { job: 'audit.anomaly-scan', processed: r.nuevos, skipped: 0, batches: 1, truncated: false, errors: r.errores };
};

const weeklySummary: JobHandler = async (organizationId) => {
  const r = await new WeeklySummaryService().pasada(organizationId);
  return { job: 'alerts.weekly-summary', processed: r.estado === 'sent' ? 1 : 0, skipped: 0, batches: 1, truncated: false, errors: [] };
};

export const ALERT_JOBS: ReadonlyArray<ModuleJob> = [
  { name: 'audit.anomaly-scan', handler: anomalyScan, cadence: 'frequent' },
  { name: 'alerts.weekly-summary', handler: weeklySummary, cadence: 'frequent' },
];
