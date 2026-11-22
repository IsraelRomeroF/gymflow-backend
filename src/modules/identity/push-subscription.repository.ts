import { uuidv7 } from '@gymflow/core';
import { GlobalRepository } from '../../platform/db/tenant-repository.js';

export type PushSubscriptionRecord = { id: string; endpoint: string; p256dh: string; auth: string };

/** Suscripciones Web Push del personal (DP-10). Globales: el endpoint es único en el mundo. */
export class PushSubscriptionRepository extends GlobalRepository {
  async upsert(input: { organizationId: string; userId: string; endpoint: string; p256dh: string; auth: string; userAgent: string | null }): Promise<void> {
    await this.db.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: { id: uuidv7(), organizationId: input.organizationId, userId: input.userId, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent },
      update: { userId: input.userId, organizationId: input.organizationId, p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent, failedAt: null },
    });
  }

  async remove(userId: string, endpoint: string): Promise<boolean> {
    const { count } = await this.db.pushSubscription.deleteMany({ where: { userId, endpoint } });
    return count > 0;
  }

  /**
   * Al cerrar las sesiones de los demás equipos, esos equipos dejan de
   * recibir avisos (24-15): un teléfono perdido no sigue mostrando
   * «Autorización pendiente» con su importe. `menos` es el del equipo que
   * pide, que se queda con los suyos.
   */
  async removeAllForUser(userId: string, menos?: string | undefined): Promise<number> {
    const { count } = await this.db.pushSubscription.deleteMany({ where: { userId, ...(menos ? { endpoint: { not: menos } } : {}) } });
    return count;
  }

  async countForUser(userId: string): Promise<number> {
    return this.db.pushSubscription.count({ where: { userId, failedAt: null } });
  }

  async forUsers(organizationId: string, userIds: readonly string[]): Promise<PushSubscriptionRecord[]> {
    if (userIds.length === 0) return [];
    return this.db.pushSubscription.findMany({
      where: { organizationId, userId: { in: [...userIds] }, failedAt: null },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
  }

  async markUsed(id: string): Promise<void> {
    await this.db.pushSubscription.updateMany({ where: { id }, data: { lastUsedAt: new Date() } });
  }

  /** El navegador dijo 404/410: la suscripción murió. */
  async markDead(id: string): Promise<void> {
    await this.db.pushSubscription.deleteMany({ where: { id } });
  }
}
