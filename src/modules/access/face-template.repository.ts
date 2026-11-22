import { TenantRepository } from '../../platform/db/tenant-repository.js';

/** Por qué una plantilla ya no tiene razón de existir (limpieza única, auditoría 8). */
export type MotivoHuerfana = 'ANONIMIZADO' | 'REVOCADO' | 'BAJA';

export type PlantillaHuerfana = {
  enrollmentId: string;
  memberId: string;
  branchId: string;
  /** El enrolamiento ya estaba revocado: solo falta borrar la plantilla. */
  revocado: boolean;
  motivo: MotivoHuerfana;
};

/** Plantillas faciales cifradas (2026-10-09). Solo las de enrolamientos vivos sirven para reconocer. */
export class FaceTemplateRepository extends TenantRepository {
  async save(input: { enrollmentId: string; branchId: string; memberId: string; embeddingEncrypted: string }): Promise<void> {
    await this.db.faceTemplate.create({ data: { ...input, organizationId: this.organizationId } });
  }

  /**
   * El padrón de la cámara: las de una sucursal, de enrolamientos sin revocar
   * y de socios VIGENTES. Quien se dio de baja deja de reconocerse en el acto
   * (6-07, D-32): su rostro ya no se compara con nadie. Si regresa dentro del
   * plazo, al reactivarlo vuelve a reconocerse sin enrolarlo otra vez; al
   * anonimizarlo la plantilla se borra (A1-N1).
   */
  async liveForBranch(branchId: string): Promise<Array<{ enrollmentId: string; memberId: string; embeddingEncrypted: string }>> {
    return this.db.faceTemplate.findMany({
      where: this.scope({ branchId, enrollment: { revokedAt: null, member: { deletedAt: null, anonymizedAt: null } } }),
      select: { enrollmentId: true, memberId: true, embeddingEncrypted: true },
    });
  }

  /**
   * El padrón contra el que compara la cámara de una sucursal (5-16, 6-13;
   * bloque 2.3). `branch` es lo de siempre: solo los rostros tomados ahí.
   * `organization`: los de todo el gimnasio, y que entre o no lo decide
   * después la regla de la puerta con su plan. Los mismos filtros en los dos:
   * enrolamiento sin revocar y socio vigente.
   */
  async padron(branchId: string, alcance: 'branch' | 'organization'): Promise<Array<{ enrollmentId: string; memberId: string; embeddingEncrypted: string }>> {
    if (alcance === 'branch') return this.liveForBranch(branchId);
    return this.db.faceTemplate.findMany({
      where: this.scope({ enrollment: { revokedAt: null, member: { deletedAt: null, anonymizedAt: null } } }),
      select: { enrollmentId: true, memberId: true, embeddingEncrypted: true },
    });
  }

  /** Borra la plantilla de verdad (no solo la marca): es lo que exige revocar. */
  async deleteForEnrollment(enrollmentId: string): Promise<boolean> {
    const { count } = await this.db.faceTemplate.deleteMany({ where: this.scope({ enrollmentId }) });
    return count > 0;
  }

  /** Borra TODAS las plantillas del socio, también las de enrolamientos ya revocados. Devuelve de qué enrolamientos eran. */
  async deleteForMember(memberId: string): Promise<string[]> {
    const filas = await this.db.faceTemplate.findMany({ where: this.scope({ memberId }), select: { enrollmentId: true } });
    if (filas.length === 0) return [];
    await this.db.faceTemplate.deleteMany({ where: this.scope({ memberId }) });
    return filas.map((f) => f.enrollmentId);
  }

  /**
   * Plantillas que quedaron sin razón de existir: de socios anonimizados
   * (antes de A1-N1 anonimizar solo revocaba), de enrolamientos ya revocados
   * y, si se pide `bajasAntesDe`, de socios dados de baja antes de esa fecha
   * sin regresar (D-32: el rostro se borra a los 30 días de la baja).
   */
  async huerfanas(opts: { bajasAntesDe?: Date | null } = {}): Promise<PlantillaHuerfana[]> {
    const filas = await this.db.faceTemplate.findMany({
      where: this.scope({
        OR: [
          { enrollment: { revokedAt: { not: null } } },
          { enrollment: { member: { anonymizedAt: { not: null } } } },
          ...(opts.bajasAntesDe ? [{ enrollment: { member: { deletedAt: { lt: opts.bajasAntesDe } } } }] : []),
        ],
      }),
      select: {
        enrollmentId: true, memberId: true, branchId: true,
        enrollment: { select: { revokedAt: true, member: { select: { anonymizedAt: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return filas.map((f) => ({
      enrollmentId: f.enrollmentId, memberId: f.memberId, branchId: f.branchId,
      revocado: f.enrollment.revokedAt !== null,
      motivo: f.enrollment.member.anonymizedAt ? 'ANONIMIZADO' : f.enrollment.revokedAt ? 'REVOCADO' : 'BAJA',
    }));
  }
}
