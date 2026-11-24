import { uuidv7 } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

export type NoticeKind = 'PAYMENT_DUE_SOON' | 'PAYMENT_OVERDUE' | 'CLASS_TOMORROW' | 'INTAKE_APPROVED' | 'PRIVACY_NOTICE_UPDATED' | 'NEW_DEVICE' | 'MEMBERSHIP_SUSPENDED'
  // Solicitudes de privacidad (1.10, 21-02): la constancia de entrada, la respuesta y que ya quedó hecho.
  | 'PRIVACY_REQUEST_RECEIVED' | 'PRIVACY_REQUEST_RESOLVED' | 'PRIVACY_REQUEST_DONE'
  // Su lugar apartado sin pagar se liberó una hora antes de la clase (D-16; 3.16).
  | 'CLASS_HOLD_RELEASED'
  // Su celular o su correo cambió desde el portal (D-36; fase 4, bloque 4.8): si no fue él, que se entere.
  | 'CONTACT_CHANGED';

export type NoticeRecord = { id: string; kind: NoticeKind; title: string; body: string; createdAt: Date; readAt: Date | null };

/**
 * Avisos al socio (PS-03): lo que el portal le dice sin canal externo. La
 * clave de deduplicación hace idempotente al job: el mismo aviso no se
 * repite aunque el día corra dos veces.
 */
export class MemberNoticeRepository extends TenantRepository {
  /** Crea el aviso si no existe ya con esa clave. Devuelve cuántos creó (0 o 1). */
  async emit(input: { memberId: string; kind: NoticeKind; title: string; body: string; dedupeKey: string }): Promise<number> {
    const { count } = await this.db.memberNotice.createMany({
      data: { id: uuidv7(), organizationId: this.organizationId, memberId: input.memberId, kind: input.kind, title: input.title, body: input.body, dedupeKey: input.dedupeKey },
      skipDuplicates: true,
    });
    return count;
  }

  async listForMember(memberId: string, limit = 30): Promise<NoticeRecord[]> {
    return this.db.memberNotice.findMany({
      where: this.scope({ memberId }), select: { id: true, kind: true, title: true, body: true, createdAt: true, readAt: true },
      orderBy: { createdAt: 'desc' }, take: limit,
    }) as Promise<NoticeRecord[]>;
  }

  async unreadCount(memberId: string): Promise<number> {
    return this.db.memberNotice.count({ where: this.scope({ memberId, readAt: null }) });
  }

  async markRead(memberId: string, ids: readonly string[] | null): Promise<number> {
    const { count } = await this.db.memberNotice.updateMany({
      where: this.scope({ memberId, readAt: null, ...(ids ? { id: { in: [...ids] } } : {}) }), data: { readAt: new Date() },
    });
    return count;
  }

  /** RETENCIÓN: lo leído hace más de `antes` ya cumplió. */
  async purgeReadBefore(antes: Date): Promise<number> {
    const { count } = await this.db.memberNotice.deleteMany({ where: this.scope({ readAt: { lt: antes } }) });
    return count;
  }
}
