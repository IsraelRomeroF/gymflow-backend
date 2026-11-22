import { uuidv7 } from '@gymflow/core';
import { GlobalRepository } from '../../platform/db/tenant-repository.js';

/**
 * PLANES DE LA PLATAFORMA (ADR-039): los paquetes de módulos que GymFlow
 * vende. Los define quien opera la plataforma; no se siembra ninguno y no se
 * borran: se desactivan, porque hay marcas que los contrataron.
 */
export type PlanDePlataforma = {
  id: string; name: string; description: string | null; modules: string[]; monthlyCents: bigint | null;
  isActive: boolean; sortOrder: number; createdAt: Date; updatedAt: Date;
};

const SELECT = { id: true, name: true, description: true, modules: true, monthlyCents: true, isActive: true, sortOrder: true, createdAt: true, updatedAt: true } as const;
const normalizar = (r: Omit<PlanDePlataforma, 'modules'> & { modules: unknown }): PlanDePlataforma => ({ ...r, modules: Array.isArray(r.modules) ? (r.modules as string[]) : [] });

export class PlatformPlanRepository extends GlobalRepository {
  async list(): Promise<Array<PlanDePlataforma & { organizations: number }>> {
    const [planes, cuentas] = await Promise.all([
      this.db.platformPlan.findMany({ select: SELECT, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      this.db.organization.groupBy({ by: ['platformPlanId'], where: { deletedAt: null, platformPlanId: { not: null } }, _count: { _all: true } }),
    ]);
    return planes.map((p) => ({ ...normalizar(p), organizations: cuentas.find((c) => c.platformPlanId === p.id)?._count._all ?? 0 }));
  }

  async find(id: string): Promise<PlanDePlataforma | null> {
    const r = await this.db.platformPlan.findUnique({ where: { id }, select: SELECT });
    return r ? normalizar(r) : null;
  }

  async create(input: { name: string; description: string | null; modules: string[]; monthlyCents: bigint | null; sortOrder: number }): Promise<PlanDePlataforma> {
    return normalizar(await this.db.platformPlan.create({ data: { id: uuidv7(), ...input }, select: SELECT }));
  }

  async update(id: string, input: Partial<{ name: string; description: string | null; modules: string[]; monthlyCents: bigint | null; isActive: boolean; sortOrder: number }>): Promise<PlanDePlataforma | null> {
    const { count } = await this.db.platformPlan.updateMany({ where: { id }, data: input });
    return count > 0 ? this.find(id) : null;
  }
}
