import { uuidv7 } from '@gymflow/core';
import { GlobalRepository } from '../../platform/db/tenant-repository.js';

/** Lo que un cambio guarda de un precio suelto y de un plan. */
export type ValorDePrecio = { monthlyCents: string | null };
export type ValorDePlan = { monthlyCents: string | null; modules: string[] };
/** La versión del plan que una marca tiene (`organizations.platformPlanSnapshot`). */
export type VersionDePlan = { planId: string; name: string; monthlyCents: string | null; modules: string[]; since: string };

export type CambioAnunciado = {
  id: string; kind: 'PRICE' | 'PLAN'; moduleKey: string | null; planId: string | null;
  before: ValorDePlan; after: ValorDePlan;
  effectiveFrom: Date; announcedOn: Date; createdAt: Date; createdByUserId: string | null;
  appliedAt: Date | null; canceledAt: Date | null; canceledByUserId: string | null; cancelReason: string | null;
};

const SELECT = {
  id: true, kind: true, moduleKey: true, planId: true, before: true, after: true, effectiveFrom: true, announcedOn: true, createdAt: true, createdByUserId: true,
  appliedAt: true, canceledAt: true, canceledByUserId: true, cancelReason: true,
} as const;
const dia = (fecha: string): Date => new Date(`${fecha}T00:00:00.000Z`);
const valor = (j: unknown): ValorDePlan => {
  const o = (j && typeof j === 'object' ? j : {}) as { monthlyCents?: unknown; modules?: unknown };
  return { monthlyCents: typeof o.monthlyCents === 'string' ? o.monthlyCents : null, modules: Array.isArray(o.modules) ? (o.modules as string[]) : [] };
};
const normalizar = (r: Omit<CambioAnunciado, 'before' | 'after' | 'kind'> & { kind: string; before: unknown; after: unknown }): CambioAnunciado => ({ ...r, kind: r.kind as 'PRICE' | 'PLAN', before: valor(r.before), after: valor(r.after) });

export function versionDePlan(j: unknown): VersionDePlan | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Partial<VersionDePlan>;
  if (typeof o.planId !== 'string') return null;
  return { planId: o.planId, name: typeof o.name === 'string' ? o.name : 'Plan', monthlyCents: typeof o.monthlyCents === 'string' ? o.monthlyCents : null, modules: Array.isArray(o.modules) ? o.modules : [], since: typeof o.since === 'string' ? o.since : '' };
}

/**
 * CAMBIOS ANUNCIADOS de precios y planes de GymFlow (D-38, bloque 3.11).
 * Global. Un cambio no se borra: se aplica en su fecha o se cancela antes.
 */
export class PlatformPriceChangeRepository extends GlobalRepository {
  /** Todos los no cancelados (pendientes y ya aplicados): con ellos se sabe qué valía cada cosa en cada mes. */
  async vigentes(): Promise<CambioAnunciado[]> {
    return (await this.db.platformPriceChange.findMany({ where: { canceledAt: null }, select: SELECT, orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }] })).map(normalizar);
  }

  async pendientes(): Promise<CambioAnunciado[]> {
    return (await this.db.platformPriceChange.findMany({ where: { canceledAt: null, appliedAt: null }, select: SELECT, orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }] })).map(normalizar);
  }

  /** Los últimos, de cualquier estado, para la pantalla. */
  async recientes(limite = 40): Promise<CambioAnunciado[]> {
    return (await this.db.platformPriceChange.findMany({ select: SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limite })).map(normalizar);
  }

  async find(id: string): Promise<CambioAnunciado | null> {
    const r = await this.db.platformPriceChange.findUnique({ where: { id }, select: SELECT });
    return r ? normalizar(r) : null;
  }

  /** Anuncia varios cambios de una vez: o quedan todos o ninguno. Un precio o un plan con un cambio pendiente no admite otro (índice único). */
  async anunciar(cambios: ReadonlyArray<{ kind: 'PRICE' | 'PLAN'; moduleKey?: string | null; planId?: string | null; before: ValorDePlan | ValorDePrecio; after: ValorDePlan | ValorDePrecio; effectiveFrom: string }>, announcedOn: string, byUserId: string | null): Promise<CambioAnunciado[]> {
    return this.db.$transaction(async (tx) => {
      const creados: CambioAnunciado[] = [];
      for (const c of cambios) {
        creados.push(normalizar(await tx.platformPriceChange.create({
          data: {
            id: uuidv7(), kind: c.kind, moduleKey: c.moduleKey ?? null, planId: c.planId ?? null, before: c.before, after: c.after,
            effectiveFrom: dia(c.effectiveFrom), announcedOn: dia(announcedOn), createdByUserId: byUserId,
          },
          select: SELECT,
        })));
      }
      return creados;
    });
  }

  async cancelar(id: string, byUserId: string | null, reason: string, ahora: Date): Promise<boolean> {
    const { count } = await this.db.platformPriceChange.updateMany({ where: { id, appliedAt: null, canceledAt: null }, data: { canceledAt: ahora, canceledByUserId: byUserId, cancelReason: reason } });
    return count > 0;
  }

  /**
   * Aplica un cambio cuya fecha ya llegó, en UNA transacción: el catálogo pasa
   * a valer lo nuevo y, si es de un plan, cada marca que lo tiene recibe su
   * versión nueva. Devuelve las marcas tocadas, o null si otro proceso ya lo aplicó.
   */
  async aplicar(c: CambioAnunciado, hoy: string, ahora: Date): Promise<{ organizations: Array<{ id: string; tradeName: string }> } | null> {
    return this.db.$transaction(async (tx) => {
      const { count } = await tx.platformPriceChange.updateMany({ where: { id: c.id, appliedAt: null, canceledAt: null }, data: { appliedAt: ahora } });
      if (count === 0) return null;
      if (c.kind === 'PRICE') {
        const cents = BigInt(c.after.monthlyCents ?? '0');
        await tx.platformPrice.upsert({
          where: { moduleKey: c.moduleKey! },
          create: { moduleKey: c.moduleKey!, monthlyCents: cents, updatedByUserId: c.createdByUserId },
          update: { monthlyCents: cents, updatedByUserId: c.createdByUserId, updatedAt: ahora },
        });
        return { organizations: [] };
      }
      const plan = await tx.platformPlan.update({
        where: { id: c.planId! }, data: { monthlyCents: c.after.monthlyCents === null ? null : BigInt(c.after.monthlyCents), modules: c.after.modules },
        select: { id: true, name: true },
      });
      const marcas = await tx.organization.findMany({ where: { platformPlanId: plan.id, deletedAt: null }, select: { id: true, tradeName: true } });
      const version: VersionDePlan = { planId: plan.id, name: plan.name, monthlyCents: c.after.monthlyCents, modules: c.after.modules, since: hoy };
      if (marcas.length > 0) await tx.organization.updateMany({ where: { id: { in: marcas.map((m) => m.id) } }, data: { platformPlanSnapshot: version } });
      return { organizations: marcas };
    });
  }
}
