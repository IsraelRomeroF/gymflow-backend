import { Prisma } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * A QUIÉN LE FALTA EL ROSTRO (auditoría 8, fase 3, bloque 3.3; D-06).
 *
 * Las cuentas que la gerencia necesita antes de encender «nadie entra sin su
 * rostro»: cuántos socios pueden entrar hoy con su plan o su paquete y, de
 * ellos, cuántos (y quiénes) no tienen rostro ni huella vigente en su sucursal.
 * Solo lee.
 */
type Fila = { memberId: string; memberCode: string; fullName: string; lastVisitOn: Date | null };

export class FaceRuleRepository extends TenantRepository {
  /**
   * Socios de esa sucursal de casa que hoy pueden entrar con su plan o su
   * paquete (misma idea que la puerta: membresía que habilita o paquete activo)
   * y, de ellos, los que NO tienen rostro ni huella vigente en esa sucursal.
   */
  async cuentas(branchId: string): Promise<{ canEnter: number; withoutFace: number }> {
    const [f] = await this.db.$queryRaw<Array<{ canEnter: number; withoutFace: number }>>`
      WITH entran AS (${this.entranSql(branchId)})
      SELECT COUNT(*)::int AS "canEnter",
             COUNT(*) FILTER (WHERE NOT e."conRostro")::int AS "withoutFace"
        FROM entran e`;
    return f ?? { canEnter: 0, withoutFace: 0 };
  }

  /** A quiénes les falta, los que vinieron más recientemente primero: son los que van a llegar mañana. */
  async sinRostro(branchId: string, limit: number): Promise<Fila[]> {
    return this.db.$queryRaw<Fila[]>`
      WITH entran AS (${this.entranSql(branchId)})
      SELECT e."memberId", e."memberCode", e."fullName",
             (SELECT MAX(a."businessDate") FROM "attendance_events" a
               WHERE a."organizationId" = ${this.organizationId}::uuid AND a."memberId" = e."memberId") AS "lastVisitOn"
        FROM entran e
       WHERE NOT e."conRostro"
       ORDER BY "lastVisitOn" DESC NULLS LAST, e."fullName" ASC
       LIMIT ${limit}`;
  }

  private entranSql(branchId: string) {
    return Prisma.sql`
      SELECT m."id" AS "memberId", m."memberCode", (m."firstName" || ' ' || m."lastName") AS "fullName",
             EXISTS (SELECT 1 FROM "biometric_enrollments" b
                      WHERE b."organizationId" = m."organizationId" AND b."memberId" = m."id"
                        AND b."branchId" = ${branchId}::uuid AND b."revokedAt" IS NULL) AS "conRostro"
        FROM "members" m
       WHERE m."organizationId" = ${this.organizationId}::uuid AND m."homeBranchId" = ${branchId}::uuid
         AND m."deletedAt" IS NULL AND m."anonymizedAt" IS NULL AND m."status" <> 'ARCHIVED'
         AND (EXISTS (SELECT 1 FROM "memberships" s
                       WHERE s."organizationId" = m."organizationId" AND s."memberId" = m."id"
                         AND s."status" IN ('ACTIVE', 'TRIALING', 'PAST_DUE'))
           OR EXISTS (SELECT 1 FROM "visit_packs" v
                       WHERE v."organizationId" = m."organizationId" AND v."memberId" = m."id" AND v."status" = 'ACTIVE'))`;
  }
}
