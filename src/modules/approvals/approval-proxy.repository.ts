import { isApprovalProxyEndReason, uuidv7, type ApprovalProxyEndReason } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

/** Un nombramiento de apoderado temporal (D-02). */
export type Nombramiento = {
  id: string; grantedByUserId: string; proxyUserId: string; note: string | null;
  endsAt: Date; endedAt: Date | null; endReason: ApprovalProxyEndReason | null; endedByUserId: string | null; createdAt: Date;
};

const SELECT = {
  id: true, grantedByUserId: true, proxyUserId: true, note: true, endsAt: true, endedAt: true, endReason: true, endedByUserId: true, createdAt: true,
} as const;

function fila(r: Omit<Nombramiento, 'endReason'> & { endReason: string | null }): Nombramiento {
  return { ...r, endReason: r.endReason && isApprovalProxyEndReason(r.endReason) ? r.endReason : null };
}

/**
 * Nombramientos de apoderado (`approval_proxies`). Uno solo abierto por
 * gimnasio (índice único parcial); vigente = abierto y con su fecha de fin
 * por delante. Nunca se borran: son la constancia de quién pudo firmar.
 */
export class ApprovalProxyRepository extends TenantRepository {
  /** El que sigue abierto, aunque su fecha ya haya pasado y nadie lo haya cerrado. */
  async abierto(): Promise<Nombramiento | null> {
    const r = await this.db.approvalProxy.findFirst({ where: this.scope({ endedAt: null }), select: SELECT });
    return r ? fila(r) : null;
  }

  /** El vigente del gimnasio en este instante. */
  async vigente(ahora = new Date()): Promise<Nombramiento | null> {
    const r = await this.db.approvalProxy.findFirst({ where: this.scope({ endedAt: null, endsAt: { gt: ahora } }), select: SELECT });
    return r ? fila(r) : null;
  }

  /** El nombramiento vigente de ESTA persona, si lo tiene. */
  async vigenteDe(proxyUserId: string, ahora = new Date()): Promise<Nombramiento | null> {
    const r = await this.db.approvalProxy.findFirst({ where: this.scope({ proxyUserId, endedAt: null, endsAt: { gt: ahora } }), select: SELECT });
    return r ? fila(r) : null;
  }

  async create(input: { grantedByUserId: string; proxyUserId: string; note: string | null; endsAt: Date }): Promise<Nombramiento> {
    return fila(await this.db.approvalProxy.create({ data: { id: uuidv7(), organizationId: this.organizationId, ...input }, select: SELECT }));
  }

  /** Lo cierra si sigue abierto. Devuelve si fue esta llamada la que lo cerró. */
  async terminar(id: string, data: { reason: ApprovalProxyEndReason; at: Date; byUserId: string | null }): Promise<boolean> {
    const { count } = await this.db.approvalProxy.updateMany({
      where: this.scope({ id, endedAt: null }),
      data: { endedAt: data.at, endReason: data.reason, endedByUserId: data.byUserId },
    });
    return count > 0;
  }

  /** Los últimos nombramientos, el más reciente primero. */
  async historia(limit = 10): Promise<Nombramiento[]> {
    const filas = await this.db.approvalProxy.findMany({ where: this.scope({}), select: SELECT, orderBy: { createdAt: 'desc' }, take: limit });
    return filas.map(fila);
  }

  /** Quién nombró en cada nombramiento, por id: para decir «como apoderado de …». */
  async duenosDe(ids: readonly string[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) return new Map();
    const filas = await this.db.approvalProxy.findMany({ where: this.scope({ id: { in: unicos } }), select: { id: true, grantedByUserId: true } });
    return new Map(filas.map((f) => [f.id, f.grantedByUserId]));
  }

  /** Cuántas firmas dio y cuántas solicitudes rechazó con cada nombramiento. */
  async uso(ids: readonly string[]): Promise<Map<string, { firmadas: number; rechazadas: number }>> {
    const out = new Map<string, { firmadas: number; rechazadas: number }>(ids.map((id) => [id, { firmadas: 0, rechazadas: 0 }]));
    if (ids.length === 0) return out;
    const [firmas, rechazos] = await Promise.all([
      this.db.approvalGrant.groupBy({ by: ['proxyId'], where: this.scope({ proxyId: { in: [...ids] } }), _count: { _all: true } }),
      this.db.approvalRequest.groupBy({ by: ['proxyId'], where: this.scope({ proxyId: { in: [...ids] }, status: 'REJECTED' }), _count: { _all: true } }),
    ]);
    for (const f of firmas) if (f.proxyId) out.get(f.proxyId)!.firmadas = f._count._all;
    for (const r of rechazos) if (r.proxyId) out.get(r.proxyId)!.rechazadas = r._count._all;
    return out;
  }
}
