import { UNLIMITED_LIMITS } from '@gymflow/core';
import type { RequestContext } from '../context.js';

/**
 * Contrato común de los jobs, compartido por todos los módulos.
 *
 * Vive en `platform` y no en un módulo porque si viviera en uno, cualquier
 * otro que corriera jobs tendría que importarlo, y eso es exactamente el
 * acoplamiento que las fronteras de módulo existen para impedir.
 */
export type JobResult = {
  job: string;
  processed: number;
  skipped: number;
  batches: number;
  /** El lote se agotó sin vaciar la cola: quedan candidatos para la próxima. */
  truncated: boolean;
  /** `entityId` es la membresía, el paquete o el cargo que falló, según el job. */
  errors: Array<{ entityId: string; error: string }>;
};

/** Un job de GIMNASIO: corre una vez por organización. */
export type JobHandler = (organizationId: string) => Promise<JobResult>;

/**
 * Un job de PLATAFORMA: corre UNA vez por corrida, fuera del bucle por
 * gimnasio (23-12). No recibe organización; si toca a varias, las recorre él.
 */
export type PlatformJobHandler = () => Promise<JobResult>;

/**
 * Cada cuánto corre (auditoría 8, 1.16):
 *  - `daily`: en el cierre diario, una vez por fecha de negocio del gimnasio.
 *    Esa fecha es la que ya empezó en TODAS sus sedes abiertas (2.13): con
 *    sedes en dos zonas, el cierre espera a la más atrasada.
 *    Si el cierre vuelve a correr el mismo día, lo que ya corrió OK se salta.
 *  - `frequent`: en el corredor de 15 minutos (y también en el cierre diario,
 *    para que un gimnasio sin corredor no se quede sin ellos). Depende de la
 *    hora, así que nunca se salta por «ya corrió hoy».
 */
export type JobCadence = 'daily' | 'frequent';

/** Contexto de SISTEMA: los jobs no tienen usuario, y eso debe verse en la bitácora. */
export function systemContext(organizationId: string): RequestContext {
  const requestId = `job-${Date.now()}`;
  return {
    requestId,
    tenant: {
      organizationId,
      actorType: 'SYSTEM',
      grants: [],
      limits: UNLIMITED_LIMITS,
      branchScopeHint: null,
      requestId,
    },
  };
}
