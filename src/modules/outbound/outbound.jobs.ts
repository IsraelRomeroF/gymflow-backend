import type { JobHandler } from '../../platform/jobs/types.js';
import { OutboundService } from './outbound.service.js';

/**
 * Los mensajes de hoy (bloque 2.9): corre en el cierre diario DESPUÉS de
 * marcar la mora y suspender, igual que los avisos del portal, para que el
 * «vencido» y la suspensión sean de hoy. Solo arma la lista: mandar es de
 * recepción (D-34).
 */
const generate: JobHandler = (organizationId) => new OutboundService().generar(organizationId);

export const OUTBOUND_JOBS: ReadonlyArray<{ name: string; handler: JobHandler }> = [
  { name: 'outbound.generate', handler: generate },
];
