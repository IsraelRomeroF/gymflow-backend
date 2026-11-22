import { uuidv7, type BiometricModality } from '@gymflow/core';
import { PrismaBiometricModality } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';

const M = PrismaBiometricModality;

export type EnrollmentRecord = {
  id: string;
  memberId: string;
  modality: BiometricModality;
  branchId: string;
  templateRef: string;
  algorithmVendor: string;
  algorithmVersion: string | null;
  consentId: string;
  enrolledByUserId: string;
  enrolledAt: Date;
  revokedAt: Date | null;
  templateDeletedAt: Date | null;
};

const SELECT = {
  id: true, memberId: true, modality: true, branchId: true,
  templateRef: true, algorithmVendor: true, algorithmVersion: true,
  consentId: true, enrolledByUserId: true, enrolledAt: true,
  revokedAt: true, templateDeletedAt: true,
} as const;

/**
 * Enrolamientos biométricos. **Aquí NUNCA hay una plantilla.**
 *
 * El vector vive en el equipo de la sucursal y no sale de ahí (ADR-014,
 * ADR-032). Esta tabla guarda que existe, dónde vive, con qué algoritmo se
 * produjo, quién lo autorizó y con qué consentimiento — que es exactamente lo
 * que hace falta para poder ordenar su borrado y demostrar que hubo permiso.
 */
export class EnrollmentRepository extends TenantRepository {
  /** Para la pantalla de Módulos: enrolamientos biométricos vigentes. */
  async activeCount(): Promise<number> {
    return this.db.biometricEnrollment.count({ where: this.scope({ revokedAt: null }) });
  }

  async listForMember(memberId: string): Promise<EnrollmentRecord[]> {
    const rows = await this.db.biometricEnrollment.findMany({
      where: this.scope({ memberId }),
      select: SELECT,
      orderBy: { enrolledAt: 'desc' },
    });
    return rows as EnrollmentRecord[];
  }

  /** Como `listForMember`, con la versión del texto biométrico que ampara cada registro (pestaña Biometría, bloque 2.3). */
  async listForMemberConFirma(memberId: string): Promise<Array<EnrollmentRecord & { consentVersion: string | null }>> {
    const rows = await this.db.biometricEnrollment.findMany({
      where: this.scope({ memberId }),
      select: { ...SELECT, consent: { select: { documentVersion: true } } },
      orderBy: { enrolledAt: 'desc' },
    });
    return rows.map(({ consent, ...e }) => ({ ...(e as EnrollmentRecord), consentVersion: consent?.documentVersion ?? null }));
  }

  /** Uno, vivo o revocado; null si no es de esta organización. */
  async findById(id: string): Promise<EnrollmentRecord | null> {
    const row = await this.db.biometricEnrollment.findFirst({ where: this.scope({ id }), select: SELECT });
    return row as EnrollmentRecord | null;
  }

  /**
   * Las cifras reales de la pantalla Biometría (6-06; bloque 2.3). «Vivo» es
   * lo mismo que compara la cámara: sin revocar y de un socio vigente. Con
   * `branchIds`, solo esas sedes (quien no ve todo el gimnasio).
   */
  async resumen(desde: Date, branchIds?: readonly string[] | null): Promise<{
    vivos: Array<{ branchId: string; memberId: string; servidor: boolean }>;
    registrados: number; revocados: number;
  }> {
    const sede = branchIds ? { branchId: { in: [...branchIds] } } : {};
    const [vivos, registrados, revocados] = await Promise.all([
      this.db.biometricEnrollment.findMany({
        where: this.scope({ ...sede, revokedAt: null, member: { deletedAt: null, anonymizedAt: null } }),
        select: { branchId: true, memberId: true, templateRef: true },
      }),
      this.db.biometricEnrollment.count({ where: this.scope({ ...sede, enrolledAt: { gte: desde }, templateRef: { startsWith: 'servidor:' } }) }),
      this.db.biometricEnrollment.count({ where: this.scope({ ...sede, revokedAt: { gte: desde } }) }),
    ]);
    return { vivos: vivos.map((e) => ({ branchId: e.branchId, memberId: e.memberId, servidor: e.templateRef.startsWith('servidor:') })), registrados, revocados };
  }

  async findLive(
    memberId: string, branchId: string, modality: BiometricModality,
  ): Promise<EnrollmentRecord | null> {
    const row = await this.db.biometricEnrollment.findFirst({
      where: this.scope({ memberId, branchId, modality: M[modality], revokedAt: null }),
      select: SELECT,
    });
    return row as EnrollmentRecord | null;
  }

  /**
   * Alta del enrolamiento. Falla si ya hay uno vivo para esa sede y modalidad.
   *
   * No se sustituye en silencio: dos plantillas del mismo socio en el mismo
   * equipo significan que nadie sabe cuál está en uso ni cuál hay que borrar.
   */
  async enroll(input: {
    memberId: string; modality: BiometricModality; branchId: string;
    templateRef: string; algorithmVendor: string; algorithmVersion: string | null;
    consentId: string; enrolledByUserId: string;
  }): Promise<EnrollmentRecord | null> {
    try {
      const row = await this.db.biometricEnrollment.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          memberId: input.memberId,
          modality: M[input.modality],
          branchId: input.branchId,
          templateRef: input.templateRef,
          algorithmVendor: input.algorithmVendor,
          algorithmVersion: input.algorithmVersion,
          consentId: input.consentId,
          enrolledByUserId: input.enrolledByUserId,
        },
        select: SELECT,
      });
      return row as EnrollmentRecord;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  /** Sucursal del enrolamiento; undefined si no existe en esta organización. */
  async branchOf(id: string): Promise<string | undefined> {
    const e = await this.db.biometricEnrollment.findFirst({ where: this.scope({ id }), select: { branchId: true } });
    return e?.branchId;
  }

  async revoke(id: string, reason: string): Promise<EnrollmentRecord | null> {
    const { count } = await this.db.biometricEnrollment.updateMany({
      where: this.scope({ id, revokedAt: null }),
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    if (count === 0) return null;
    const row = await this.db.biometricEnrollment.findFirst({ where: this.scope({ id }), select: SELECT });
    return row as EnrollmentRecord;
  }

  /** Confirma que la SUCURSAL borró la plantilla. Es la prueba, no la orden. */
  async confirmTemplateDeleted(id: string): Promise<boolean> {
    const { count } = await this.db.biometricEnrollment.updateMany({
      where: this.scope({ id, revokedAt: { not: null }, templateDeletedAt: null }),
      data: { templateDeletedAt: new Date() },
    });
    return count > 0;
  }

  /**
   * Revocados cuya plantilla sigue sin borrarse.
   *
   * Es una lista de obligaciones incumplidas, no una cola de trabajo: ADR-014
   * exige la supresión al terminar la relación, y sin este barrido el
   * enrolamiento se queda en el equipo de la sucursal para siempre porque
   * nada falla.
   */
  async pendingDeletion(limit: number): Promise<EnrollmentRecord[]> {
    const rows = await this.db.biometricEnrollment.findMany({
      where: this.scope({ revokedAt: { not: null }, templateDeletedAt: null }),
      select: SELECT,
      orderBy: { revokedAt: 'asc' },
      take: limit,
    });
    return rows as EnrollmentRecord[];
  }

  /**
   * Enrolamientos de la cámara (plantilla en el servidor) ya revocados cuya
   * plantilla ya no existe, pero sin el borrado asentado. Pasaba al anonimizar
   * antes de A1-N1: el borrado es un hecho y solo falta dejarlo confirmado, o
   * `/biometria` seguiría pidiendo confirmar algo que nadie puede confirmar.
   */
  async servidorSinConfirmar(memberId?: string): Promise<EnrollmentRecord[]> {
    const rows = await this.db.biometricEnrollment.findMany({
      where: this.scope({
        ...(memberId ? { memberId } : {}),
        revokedAt: { not: null }, templateDeletedAt: null,
        templateRef: { startsWith: 'servidor:' }, faceTemplate: { is: null },
      }),
      select: SELECT,
    });
    return rows as EnrollmentRecord[];
  }

  /** Enrolamientos vivos de una sucursal: lo que el gateway debe tener. */
  async liveForBranch(branchId: string): Promise<EnrollmentRecord[]> {
    const rows = await this.db.biometricEnrollment.findMany({
      where: this.scope({ branchId, revokedAt: null }),
      select: SELECT,
    });
    return rows as EnrollmentRecord[];
  }
}
