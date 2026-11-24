import { uuidv7 } from '@gymflow/core';
import { createHash } from 'node:crypto';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { PrismaConsentType } from '@gymflow/db';

export type ConsentRecord = {
  id: string;
  consentType: string;
  documentVersion: string;
  granted: boolean;
  grantedAt: Date;
  revokedAt: Date | null;
  channel: string | null;
  evidenceHash: string | null;
};

export type ConsentDetail = ConsentRecord & { ip: string | null };

export type ConsentInput = {
  memberId: string;
  branchId?: string | null;
  consentType: string;
  documentVersion: string;
  documentText?: string | null;
  granted: boolean;
  ip?: string | null;
  userAgent?: string | null;
  channel?: string | null;
  assistedByUserId?: string | null;
  /**
   * Cuándo firmó el SOCIO.
   *
   * Por omisión es ahora, que es lo correcto cuando firma delante de
   * recepción. Deja de serlo en el alta digital: ahí firmó en su teléfono y
   * recepción solo lo aprueba después, a veces al día siguiente. El sello de
   * tiempo de la evidencia es el de la firma, no el del visto bueno.
   */
  grantedAt?: Date | null;
  /**
   * Quién firmó POR el socio (bloque 3.4, D-10): el tutor de un menor. La
   * aceptación queda a su nombre, con su celular.
   */
  signedByName?: string | null;
  signedByPhoneE164?: string | null;
};

/**
 * Evidencia de consentimiento. El hash sella el conjunto para que una
 * alteración posterior sea detectable, y el trigger de la base impide
 * reescribir lo que el socio aceptó (docs/07 §6.4).
 */
export class ConsentRepository extends TenantRepository {
  async record(input: ConsentInput): Promise<ConsentRecord> {
    const grantedAt = input.grantedAt ?? new Date();
    const evidenceHash = createHash('sha256')
      .update([
        input.memberId, input.consentType, input.documentVersion,
        input.documentText ?? '', String(input.granted),
        grantedAt.toISOString(), input.ip ?? '', input.userAgent ?? '',
        // Solo cuando firmó un tutor: el sello de las firmas de siempre no cambia.
        ...(input.signedByName ? [input.signedByName, input.signedByPhoneE164 ?? ''] : []),
      ].join('\u0000'))
      .digest('hex');

    return this.db.memberConsent.create({
      data: {
        id: uuidv7(),
        organizationId: this.organizationId,
        memberId: input.memberId,
        branchId: input.branchId ?? null,
        consentType: input.consentType as PrismaConsentType,
        documentVersion: input.documentVersion,
        documentText: input.documentText ?? null,
        granted: input.granted,
        grantedAt,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        channel: input.channel ?? null,
        assistedByUserId: input.assistedByUserId ?? null,
        evidenceHash,
        signedByName: input.signedByName ?? null,
        signedByPhoneE164: input.signedByPhoneE164 ?? null,
      },
      select: {
        id: true, consentType: true, documentVersion: true, granted: true,
        grantedAt: true, revokedAt: true, channel: true, evidenceHash: true,
      },
    });
  }

  async listForMember(memberId: string): Promise<ConsentDetail[]> {
    return this.db.memberConsent.findMany({
      where: this.scope({ memberId }),
      select: {
        id: true, consentType: true, documentVersion: true, granted: true,
        grantedAt: true, revokedAt: true, channel: true, ip: true, evidenceHash: true,
      },
      orderBy: { grantedAt: 'desc' },
    });
  }

  /** Vigente = otorgado, no revocado, y el más reciente de su tipo. */
  async currentFor(
    memberId: string,
    consentType: string,
  ): Promise<{ id: string; documentVersion: string; grantedAt: Date } | null> {
    return this.db.memberConsent.findFirst({
      where: this.scope({ memberId, consentType: consentType as PrismaConsentType, granted: true, revokedAt: null }),
      orderBy: { grantedAt: 'desc' },
      select: { id: true, documentVersion: true, grantedAt: true },
    });
  }

  /**
   * La firma BIOMÉTRICA vigente (la más reciente, otorgada y sin retirar) de
   * cada socio que hoy tiene un rostro o una huella vivos y sigue siendo socio.
   * Es lo que se compara con el texto publicado para saber quién firmó uno
   * anterior (6-03, 21-09). El rostro vivo se ve desde el consentimiento: un
   * enrolamiento sin revocar cuelga de alguna de sus firmas BIOMETRIC.
   */
  async biometricasVigentesConRegistro(memberId?: string): Promise<Array<{
    id: string; memberId: string; documentVersion: string; grantedAt: Date;
    /** Sucursales donde tiene hoy un rostro o huella vivos. */
    branchIds: string[];
    member: { memberCode: string; firstName: string; lastName: string; homeBranchId: string | null };
  }>> {
    const conRegistro = await this.db.memberConsent.findMany({
      where: this.scope({
        consentType: PrismaConsentType.BIOMETRIC,
        ...(memberId ? { memberId } : {}),
        enrollments: { some: { revokedAt: null } },
        member: { is: { status: { not: 'ARCHIVED' as const }, anonymizedAt: null } },
      }),
      select: { memberId: true, enrollments: { where: { revokedAt: null }, select: { branchId: true } } },
    });
    if (conRegistro.length === 0) return [];
    const sedes = new Map<string, Set<string>>();
    for (const c of conRegistro) {
      const s = sedes.get(c.memberId) ?? new Set<string>();
      for (const e of c.enrollments) s.add(e.branchId);
      sedes.set(c.memberId, s);
    }
    const firmas = await this.db.memberConsent.findMany({
      where: this.scope({
        consentType: PrismaConsentType.BIOMETRIC, granted: true, revokedAt: null,
        memberId: { in: [...sedes.keys()] },
      }),
      select: {
        id: true, memberId: true, documentVersion: true, grantedAt: true,
        member: { select: { memberCode: true, firstName: true, lastName: true, homeBranchId: true } },
      },
      orderBy: [{ memberId: 'asc' }, { grantedAt: 'desc' }],
    });
    // La más reciente de cada socio: las anteriores quedaron superadas por ella.
    const vistas = new Set<string>();
    return firmas
      .filter((f) => (vistas.has(f.memberId) ? false : (vistas.add(f.memberId), true)))
      .map((f) => ({ ...f, branchIds: [...(sedes.get(f.memberId) ?? [])] }));
  }

  /** Una firma con el texto exacto que se aceptó: lo que se le enseña al socio ante un reclamo (3-21). */
  async findWithText(memberId: string, id: string): Promise<(ConsentRecord & { documentText: string | null }) | null> {
    return this.db.memberConsent.findFirst({
      where: this.scope({ id, memberId }),
      select: {
        id: true, consentType: true, documentVersion: true, granted: true, grantedAt: true, revokedAt: true,
        channel: true, evidenceHash: true, documentText: true,
      },
    });
  }

  /** Las firmas del socio que guardan su texto (el listado no lo trae: son hasta 60 KB cada una). */
  async idsConTexto(memberId: string): Promise<Set<string>> {
    const filas = await this.db.memberConsent.findMany({ where: this.scope({ memberId, documentText: { not: null } }), select: { id: true } });
    return new Set(filas.map((f) => f.id));
  }

  /** Todas las firmas VIVAS de un tipo (otorgadas y sin retirar): un permiso se retira entero, no firma por firma. */
  async vivosDeTipo(memberId: string, consentType: string): Promise<Array<{ id: string; documentVersion: string }>> {
    return this.db.memberConsent.findMany({
      where: this.scope({ memberId, consentType: consentType as PrismaConsentType, granted: true, revokedAt: null }),
      select: { id: true, documentVersion: true }, orderBy: { grantedAt: 'desc' },
    });
  }

  /** Marca retiradas varias firmas vivas a la vez; devuelve cuántas. */
  async revokeMany(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.db.memberConsent.updateMany({ where: this.scope({ id: { in: [...ids] }, revokedAt: null }), data: { revokedAt: new Date() } });
    return count;
  }

  /**
   * Socios con una firma BIOMETRIC viva y NINGÚN rostro ni huella vivos: el
   * permiso quedó «Aceptado» después de quitarle la biometría (21-10). Solo
   * cuenta quien llegó a tener un registro: una firma recién tomada, antes de
   * guardar la plantilla, no es huérfana.
   */
  async biometricosSinRegistro(memberId?: string): Promise<string[]> {
    const filas = await this.db.memberConsent.findMany({
      where: this.scope({ consentType: PrismaConsentType.BIOMETRIC, granted: true, revokedAt: null, ...(memberId ? { memberId } : {}) }),
      select: { memberId: true, enrollments: { select: { revokedAt: true } } },
    });
    const porSocio = new Map<string, { alguno: boolean; vivo: boolean }>();
    for (const f of filas) {
      const e = porSocio.get(f.memberId) ?? { alguno: false, vivo: false };
      if (f.enrollments.length > 0) e.alguno = true;
      if (f.enrollments.some((x) => x.revokedAt === null)) e.vivo = true;
      porSocio.set(f.memberId, e);
    }
    return [...porSocio].filter(([, e]) => e.alguno && !e.vivo).map(([id]) => id);
  }

  /** No se borra ni se reescribe: se marca revocado (art. 7 LFPDPPP). */
  async revoke(id: string): Promise<boolean> {
    const { count } = await this.db.memberConsent.updateMany({
      where: this.scope({ id, revokedAt: null }),
      data: { revokedAt: new Date() },
    });
    return count > 0;
  }
}
