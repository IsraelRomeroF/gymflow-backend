import { uuidv7, type OwnerAlertKind } from '@gymflow/core';
import type { Prisma } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

export type OwnerAlertRecord = {
  id: string; kind: string; dedupeKey: string; branchId: string | null;
  title: string; body: string; url: string; detail: unknown;
  occurredAt: Date; createdAt: Date; silent: boolean; pushedAt: Date | null; pushDevices: number; seenAt: Date | null;
};

const SELECT = {
  id: true, kind: true, dedupeKey: true, branchId: true, title: true, body: true, url: true, detail: true,
  occurredAt: true, createdAt: true, silent: true, pushedAt: true, pushDevices: true, seenAt: true,
} as const;

export type NuevoAviso = {
  kind: OwnerAlertKind; dedupeKey: string; branchId?: string | null;
  title: string; body: string; url: string; detail: Prisma.InputJsonObject; occurredAt: Date; silent: boolean;
};

/**
 * LOS AVISOS A LA DUEÑA (bloque 4.2; D-05). Tablas propias del módulo:
 * `owner_alerts` y `owner_alert_starts`. La aplicación no borra avisos: los
 * crea, los marca como mandados y como vistos.
 */
export class OwnerAlertRepository extends TenantRepository {
  /** Desde qué instante avisa este gimnasio, o null si el escaneo nunca ha corrido aquí. */
  async arranque(): Promise<Date | null> {
    const r = await this.db.ownerAlertStart.findUnique({ where: { organizationId: this.organizationId }, select: { startedAt: true } });
    return r?.startedAt ?? null;
  }

  /** Fija el arranque si no existía. Devuelve el que quedó y si lo acaba de fijar esta llamada. */
  async fijarArranque(ahora: Date): Promise<{ startedAt: Date; nuevo: boolean }> {
    const { count } = await this.db.ownerAlertStart.createMany({ data: { organizationId: this.organizationId, startedAt: ahora }, skipDuplicates: true });
    return { startedAt: (await this.arranque()) ?? ahora, nuevo: count > 0 };
  }

  /**
   * Crea el aviso si no existe ya con esa llave. Devuelve el aviso SOLO si lo
   * creó esta llamada: quien recibe null no manda nada (ya se mandó, o lo
   * está mandando otra corrida).
   */
  async crear(a: NuevoAviso): Promise<OwnerAlertRecord | null> {
    const id = uuidv7();
    const { count } = await this.db.ownerAlert.createMany({
      data: {
        id, organizationId: this.organizationId, kind: a.kind, dedupeKey: a.dedupeKey, branchId: a.branchId ?? null,
        title: a.title, body: a.body, url: a.url, detail: a.detail, occurredAt: a.occurredAt, silent: a.silent,
      },
      skipDuplicates: true,
    });
    if (count === 0) return null;
    return this.db.ownerAlert.findFirst({ where: this.scope({ id }), select: SELECT });
  }

  /** De estas llaves, cuáles ya tienen aviso (para no armar el detalle de lo ya avisado). */
  async yaAvisadas(llaves: readonly string[]): Promise<Set<string>> {
    if (llaves.length === 0) return new Set();
    const filas = await this.db.ownerAlert.findMany({ where: this.scope({ dedupeKey: { in: [...llaves] } }), select: { dedupeKey: true } });
    return new Set(filas.map((f) => f.dedupeKey));
  }

  async marcarMandado(id: string, equipos: number, ahora: Date): Promise<void> {
    await this.db.ownerAlert.updateMany({ where: this.scope({ id }), data: { pushedAt: ahora, pushDevices: equipos } });
  }

  /** Los avisos de la lista (sin los resúmenes), el más reciente primero. */
  async recientes(desde: Date, limite = 60): Promise<OwnerAlertRecord[]> {
    return this.db.ownerAlert.findMany({
      where: this.scope({ kind: { not: 'WEEKLY_SUMMARY' }, OR: [{ createdAt: { gte: desde } }, { seenAt: null }] }),
      select: SELECT, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: limite,
    });
  }

  async resumenes(limite = 4): Promise<OwnerAlertRecord[]> {
    return this.db.ownerAlert.findMany({ where: this.scope({ kind: 'WEEKLY_SUMMARY' }), select: SELECT, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: limite });
  }

  async sinVer(): Promise<number> {
    return this.db.ownerAlert.count({ where: this.scope({ seenAt: null }) });
  }

  async marcarVistos(userId: string, ahora: Date): Promise<number> {
    const { count } = await this.db.ownerAlert.updateMany({ where: this.scope({ seenAt: null }), data: { seenAt: ahora, seenByUserId: userId } });
    return count;
  }

  /** Las personas con el puesto Dueño, activas: a ellas les suena el teléfono. */
  async duenos(): Promise<string[]> {
    const filas = await this.db.user.findMany({
      where: { organizationId: this.organizationId, isActive: true, deletedAt: null, roleAssignments: { some: { revokedAt: null, role: { key: 'OWNER' } } } },
      select: { id: true }, orderBy: { createdAt: 'asc' },
    });
    return filas.map((f) => f.id);
  }

  async esDueno(userId: string): Promise<boolean> {
    return (await this.db.roleAssignment.count({
      where: { organizationId: this.organizationId, userId, revokedAt: null, role: { key: 'OWNER' }, user: { isActive: true, deletedAt: null } },
    })) > 0;
  }
}
