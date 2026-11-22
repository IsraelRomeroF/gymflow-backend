import type { FastifyInstance } from 'fastify';
import type { ModuleKey } from '@gymflow/core';
import type { Env } from '../env.js';
import type { JobCadence, JobHandler, PlatformJobHandler } from '../jobs/types.js';

/**
 * Lo que un módulo de código le declara a la plataforma (ADR-036).
 *
 * `module` es el módulo de PRODUCTO —el que el gimnasio enciende o apaga— al
 * que pertenecen sus rutas. No siempre coincide con la carpeta: por ejemplo,
 * `GET /members/follow-ups/latest` vive en `follow-ups` y es del módulo
 * Retención; esas rutas lo dicen una a una con `module` en su declaración.
 */
export type BackendModule = {
  /** La carpeta bajo `src/modules`, o `platform`. */
  readonly name: string;
  readonly module: ModuleKey;
  register(app: FastifyInstance, env: Env): void;
  readonly jobs?: ReadonlyArray<ModuleJob>;
};

/**
 * Un trabajo declarado por un módulo. Lo que aquí se declara es CÓMO corre
 * (cadencia, alcance, qué pasa con el módulo apagado); su lógica vive en el
 * módulo. El orden entre jobs lo fija `platform/jobs/plan.ts`.
 */
export type ModuleJob = GymJob | PlatformJob;

/** Corre una vez por gimnasio. */
export type GymJob = {
  readonly name: string;
  readonly handler: JobHandler;
  readonly scope?: 'organization';
  /** El módulo de producto del trabajo, si no es el de su carpeta. */
  readonly module?: ModuleKey;
  /**
   * Qué hacer cuando el gimnasio tiene el módulo apagado. Por omisión se
   * salta: apagar deja de GENERAR. `run` es para lo que CIERRA o resuelve
   * dinero en tránsito, que no puede quedarse a medias.
   */
  readonly whenDisabled?: 'skip' | 'run';
  /** Por omisión, `daily` (ver `JobCadence`). */
  readonly cadence?: JobCadence;
};

/** Corre UNA vez por corrida, fuera del bucle por gimnasio (23-12). */
export type PlatformJob = {
  readonly name: string;
  readonly scope: 'platform';
  readonly handler: PlatformJobHandler;
  readonly cadence?: JobCadence;
};
