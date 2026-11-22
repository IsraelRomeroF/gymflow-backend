import { uuidv7, venceHacerEfectiva, venceResponder, type CanalDeSolicitudArco, type ConsentType, type ResultadoDeSolicitudArco, type TipoDeSolicitudArco } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

export type PrivacyRequestKind = TipoDeSolicitudArco;
export type PrivacyRequestChannel = CanalDeSolicitudArco;

export type PrivacyRequestRecord = {
  id: string; memberId: string; kind: PrivacyRequestKind; channel: PrivacyRequestChannel; note: string | null;
  /** El permiso del que se opone o que revoca. */
  consentType: ConsentType | null;
  receivedAt: Date;
  /** Sin identidad acreditada el plazo no corre (21-18). */
  identityVerifiedAt: Date | null; identityVerifiedByUserId: string | null; identityNote: string | null;
  /** Vence responder: 20 días hábiles desde que corre el plazo, guardados como 28 naturales. */
  dueAt: Date;
  resolvedAt: Date | null; resolvedByUserId: string | null; outcome: ResultadoDeSolicitudArco | null; resolution: string | null;
  /** Vence hacer efectivo lo que procede: 15 días hábiles desde la respuesta (21 naturales). */
  effectiveDueAt: Date | null; effectedAt: Date | null; effectedByUserId: string | null; effectNote: string | null;
};

export type PrivacyRequestConSocio = PrivacyRequestRecord & { member: { firstName: string; lastName: string; memberCode: string; homeBranchId: string | null } };

const SELECT = {
  id: true, memberId: true, kind: true, channel: true, note: true, consentType: true, receivedAt: true,
  identityVerifiedAt: true, identityVerifiedByUserId: true, identityNote: true, dueAt: true,
  resolvedAt: true, resolvedByUserId: true, outcome: true, resolution: true,
  effectiveDueAt: true, effectedAt: true, effectedByUserId: true, effectNote: true,
} as const;

/** Lo que sigue VIVO: sin responder (con o sin identidad) o que procede y falta hacerlo efectivo. */
const VIVAS = { OR: [{ resolvedAt: null }, { outcome: 'GRANTED', effectedAt: null }] };

/**
 * Solicitudes ARCO (PS-07; ciclo completo en la auditoría 8, 21-03 y 21-18).
 * Las fechas son la prueba: cuándo entró, cuándo se acreditó quién la pide,
 * cuándo se respondió y cuándo quedó hecho. Los plazos se guardan ya
 * calculados con las reglas del núcleo (`venceResponder`, `venceHacerEfectiva`).
 */
export class PrivacyRequestRepository extends TenantRepository {
  async create(input: {
    memberId: string; kind: PrivacyRequestKind; channel: PrivacyRequestChannel; note: string | null; consentType: ConsentType | null;
    createdByUserId: string | null;
    /** Quién acreditó la identidad al registrar; null = queda «falta acreditar» y el plazo no corre. */
    identidad: { byUserId: string | null; note: string } | null;
  }): Promise<PrivacyRequestRecord> {
    const receivedAt = new Date();
    const row = await this.db.privacyRequest.create({
      data: {
        id: uuidv7(), organizationId: this.organizationId, memberId: input.memberId, kind: input.kind, channel: input.channel,
        note: input.note, consentType: input.consentType, receivedAt,
        // Sin identidad el plazo no corre: la fecha queda provisional y se recalcula al acreditarla.
        dueAt: venceResponder(receivedAt), createdByUserId: input.createdByUserId,
        ...(input.identidad ? { identityVerifiedAt: receivedAt, identityVerifiedByUserId: input.identidad.byUserId, identityNote: input.identidad.note } : {}),
      },
      select: SELECT,
    });
    return row as PrivacyRequestRecord;
  }

  async findById(id: string): Promise<PrivacyRequestRecord | null> {
    return this.db.privacyRequest.findFirst({ where: this.scope({ id }), select: SELECT }) as Promise<PrivacyRequestRecord | null>;
  }

  async forMember(memberId: string): Promise<PrivacyRequestRecord[]> {
    return this.db.privacyRequest.findMany({ where: this.scope({ memberId }), select: SELECT, orderBy: { receivedAt: 'desc' } }) as Promise<PrivacyRequestRecord[]>;
  }

  /** Las vivas, con el socio: la bandeja de cumplimiento. El orden por plazo lo pone quien llama. */
  async listLive(limit = 300): Promise<PrivacyRequestConSocio[]> {
    const rows = await this.db.privacyRequest.findMany({
      where: this.scope(VIVAS),
      select: { ...SELECT, member: { select: { firstName: true, lastName: true, memberCode: true, homeBranchId: true } } },
      orderBy: { receivedAt: 'asc' }, take: limit,
    });
    return rows as PrivacyRequestConSocio[];
  }

  /** Las vivas, solo con sus fechas: para las cifras de Inicio y de la dueña. */
  async liveDates(): Promise<PrivacyRequestRecord[]> {
    return this.db.privacyRequest.findMany({ where: this.scope(VIVAS), select: SELECT, take: 2000 }) as Promise<PrivacyRequestRecord[]>;
  }

  /** Las del socio que proceden y falta hacer efectivas, de un tipo (la descarga cierra ACCESS; anonimizar, CANCELLATION). */
  async porHacerEfectivas(memberId: string, kind: PrivacyRequestKind): Promise<PrivacyRequestRecord[]> {
    return this.db.privacyRequest.findMany({ where: this.scope({ memberId, kind, outcome: 'GRANTED', effectedAt: null }), select: SELECT }) as Promise<PrivacyRequestRecord[]>;
  }

  /** Acredita la identidad: desde este momento corre el plazo de respuesta. */
  async verifyIdentity(id: string, input: { byUserId: string | null; note: string }): Promise<boolean> {
    const ahora = new Date();
    const { count } = await this.db.privacyRequest.updateMany({
      where: this.scope({ id, identityVerifiedAt: null, resolvedAt: null }),
      data: { identityVerifiedAt: ahora, identityVerifiedByUserId: input.byUserId, identityNote: input.note, dueAt: venceResponder(ahora) },
    });
    return count > 0;
  }

  /** Responde: procede o no procede. `hecha`: lo que procede quedó hecho en el mismo acto. */
  async resolve(id: string, input: { resolvedByUserId: string; outcome: ResultadoDeSolicitudArco; resolution: string; consentType?: ConsentType | null; hecha?: { note: string } | null }): Promise<boolean> {
    const ahora = new Date();
    const { count } = await this.db.privacyRequest.updateMany({
      where: this.scope({ id, resolvedAt: null, identityVerifiedAt: { not: null } }),
      data: {
        resolvedAt: ahora, resolvedByUserId: input.resolvedByUserId, outcome: input.outcome, resolution: input.resolution,
        ...(input.consentType ? { consentType: input.consentType } : {}),
        ...(input.outcome === 'GRANTED' ? { effectiveDueAt: venceHacerEfectiva(ahora) } : {}),
        ...(input.outcome === 'GRANTED' && input.hecha ? { effectedAt: ahora, effectedByUserId: input.resolvedByUserId, effectNote: input.hecha.note } : {}),
      },
    });
    return count > 0;
  }

  /** Lo que procede ya quedó hecho. */
  async markEffected(id: string, input: { byUserId: string | null; note: string }): Promise<boolean> {
    const { count } = await this.db.privacyRequest.updateMany({
      where: this.scope({ id, outcome: 'GRANTED', effectedAt: null }),
      data: { effectedAt: new Date(), effectedByUserId: input.byUserId, effectNote: input.note },
    });
    return count > 0;
  }
}
