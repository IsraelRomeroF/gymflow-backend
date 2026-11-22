import { uuidv7 } from '@gymflow/core';
import { GlobalRepository } from '../db/tenant-repository.js';
import { isUniqueViolation } from '../db/prisma-errors.js';
import type { JobResult } from './types.js';

/** El corredor: cierre diario o cada 15 minutos. Son candados distintos. */
export type Runner = 'DAILY' | 'FREQUENT';
export type RunStatus = 'RUNNING' | 'OK' | 'WITH_ERRORS' | 'FAILED' | 'ABANDONED';

export type JobRunRow = {
  id: string; runner: Runner; status: RunStatus; startedAt: Date; heartbeatAt: Date; finishedAt: Date | null;
  host: string; perfil: string | null; summary: unknown; note: string | null;
};

export type JobRunStepRow = {
  id: string; runId: string; organizationId: string | null; job: string; businessDate: Date; status: RunStatus;
  startedAt: Date; finishedAt: Date | null; processed: number; skipped: number; batches: number; truncated: boolean;
  errors: unknown; error: string | null;
};

/**
 * Corridas de los jobs (`job_runs`, `job_run_steps`): el candado, el «ya
 * corrió hoy» y el rastro de lo que se quedó a medias (28-15). Es global: una
 * corrida recorre todos los gimnasios.
 */
export class JobRunRepository extends GlobalRepository {
  /** La corrida RUNNING de ese corredor, si la hay. */
  running(runner: Runner): Promise<JobRunRow | null> {
    return this.db.jobRun.findFirst({ where: { runner, status: 'RUNNING' } }) as Promise<JobRunRow | null>;
  }

  /**
   * Toma el candado: inserta la corrida RUNNING. Si otra ganó en ese mismo
   * instante, el índice único parcial lo dice y se devuelve null.
   */
  async start(input: { runner: Runner; host: string; perfil: string | null }): Promise<JobRunRow | null> {
    try {
      return await this.db.jobRun.create({ data: { id: uuidv7(), status: 'RUNNING', ...input } }) as JobRunRow;
    } catch (e) {
      if (isUniqueViolation(e)) return null;
      throw e;
    }
  }

  /** Corridas RUNNING, de cualquier corredor, sin señal de vida desde `antesDe`. */
  stale(antesDe: Date): Promise<JobRunRow[]> {
    return this.db.jobRun.findMany({ where: { status: 'RUNNING', heartbeatAt: { lt: antesDe } }, orderBy: { startedAt: 'asc' } }) as Promise<JobRunRow[]>;
  }

  /** Señal de vida. `false` si la corrida ya no es RUNNING: otra la dio por cortada. */
  async heartbeat(runId: string): Promise<boolean> {
    const r = await this.db.jobRun.updateMany({ where: { id: runId, status: 'RUNNING' }, data: { heartbeatAt: new Date() } });
    return r.count > 0;
  }

  /**
   * Da por abandonada una corrida sin señal de vida, con sus pasos a medias.
   * Solo si sigue RUNNING: si su proceso la cerró en este instante, se respeta.
   */
  async abandon(runId: string, note: string): Promise<boolean> {
    const ahora = new Date();
    const r = await this.db.jobRun.updateMany({ where: { id: runId, status: 'RUNNING' }, data: { status: 'ABANDONED', finishedAt: ahora, note } });
    if (r.count === 0) return false;
    await this.db.jobRunStep.updateMany({
      where: { runId, status: 'RUNNING' },
      data: { status: 'ABANDONED', finishedAt: ahora, error: 'Se quedó a medias: la corrida se cortó sin terminar este job' },
    });
    return true;
  }

  /** Cierra la corrida y suelta el candado. `false` si ya no era RUNNING (otra la dio por cortada). */
  async finish(runId: string, status: Exclude<RunStatus, 'RUNNING' | 'ABANDONED'>, summary: object, note: string | null = null): Promise<boolean> {
    const r = await this.db.jobRun.updateMany({ where: { id: runId, status: 'RUNNING' }, data: { status, finishedAt: new Date(), summary, note } });
    return r.count > 0;
  }

  /**
   * Purga las corridas del corredor de 15 minutos que no dejaron ningún paso
   * (no encontraron nada que hacer) y terminaron antes de `antesDe`. Las
   * recientes se quedan: dicen que el corredor sigue vivo.
   */
  async purgeEmptyFrequent(antesDe: Date): Promise<number> {
    const r = await this.db.jobRun.deleteMany({
      where: { runner: 'FREQUENT', status: { not: 'RUNNING' }, startedAt: { lt: antesDe }, steps: { none: {} } },
    });
    return r.count;
  }

  /** Los jobs que ya terminaron OK para ese gimnasio (null = plataforma) en esa fecha de negocio. */
  async okOn(organizationId: string | null, businessDate: Date): Promise<Set<string>> {
    const filas = await this.db.jobRunStep.findMany({
      where: { organizationId, businessDate, status: 'OK' }, select: { job: true }, distinct: ['job'],
    });
    return new Set(filas.map((f) => f.job));
  }

  /**
   * Abre el paso: el candado POR JOB. Si otra corrida tiene ese mismo job
   * RUNNING para ese mismo gimnasio, el índice único parcial lo dice y se
   * devuelve null (el job se omite en esta corrida).
   */
  async startStep(input: { runId: string; organizationId: string | null; job: string; businessDate: Date }): Promise<string | null> {
    const id = uuidv7();
    try {
      await this.db.jobRunStep.create({ data: { id, status: 'RUNNING', ...input } });
    } catch (e) {
      if (isUniqueViolation(e)) return null;
      throw e;
    }
    return id;
  }

  async finishStep(id: string, status: 'OK' | 'WITH_ERRORS', result: JobResult): Promise<void> {
    await this.db.jobRunStep.update({
      where: { id },
      data: {
        status, finishedAt: new Date(), processed: result.processed, skipped: result.skipped, batches: result.batches,
        truncated: result.truncated, errors: result.errors,
      },
    });
  }

  async failStep(id: string, error: string): Promise<void> {
    await this.db.jobRunStep.update({ where: { id }, data: { status: 'FAILED', finishedAt: new Date(), error } });
  }

  async deleteStep(id: string): Promise<void> {
    await this.db.jobRunStep.deleteMany({ where: { id } });
  }

  /** Los gimnasios vivos que recorre una corrida, con su zona (la fecha de negocio sale de ella). */
  organizations(only?: readonly string[]): Promise<Array<{ id: string; tradeName: string; timezone: string }>> {
    return this.db.organization.findMany({
      where: { deletedAt: null, ...(only ? { id: { in: [...only] } } : {}) },
      select: { id: true, tradeName: true, timezone: true }, orderBy: { createdAt: 'asc' },
    });
  }

  find(runId: string): Promise<JobRunRow | null> {
    return this.db.jobRun.findUnique({ where: { id: runId } }) as Promise<JobRunRow | null>;
  }

  /** Las últimas corridas, la más reciente primero. */
  recent(limit = 20, runner?: Runner): Promise<JobRunRow[]> {
    return this.db.jobRun.findMany({ where: runner ? { runner } : {}, orderBy: { startedAt: 'desc' }, take: limit }) as Promise<JobRunRow[]>;
  }

  steps(runId: string): Promise<JobRunStepRow[]> {
    return this.db.jobRunStep.findMany({ where: { runId }, orderBy: { startedAt: 'asc' } }) as Promise<JobRunStepRow[]>;
  }

  /** Los pasos de una fecha de negocio, para «¿qué corrió hoy?». */
  stepsOn(businessDate: Date, organizationId: string | null): Promise<JobRunStepRow[]> {
    return this.db.jobRunStep.findMany({ where: { businessDate, organizationId }, orderBy: { startedAt: 'asc' } }) as Promise<JobRunStepRow[]>;
  }

  /** Lo que quedó ABANDONED, FAILED o con errores por entidad: lo que alguien tiene que mirar. */
  pendingAttention(since: Date): Promise<JobRunStepRow[]> {
    return this.db.jobRunStep.findMany({
      where: { startedAt: { gte: since }, status: { in: ['ABANDONED', 'FAILED', 'WITH_ERRORS'] } }, orderBy: { startedAt: 'desc' },
    }) as Promise<JobRunStepRow[]>;
  }
}
