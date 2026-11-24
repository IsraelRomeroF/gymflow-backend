import { TenantRepository } from '../../platform/db/tenant-repository.js';

export type CorteConDiferencia = {
  id: string; branchId: string; branchName: string; registerName: string; varianceCents: bigint; varianceReason: string | null;
  closedAt: Date; openedByName: string | null; closedByName: string | null;
};
export type SolicitudPorVencer = { id: string; etapa: 'answer' | 'effect'; kind: string; vence: Date };
export type FirmaDelAvisoPendiente = { id: string; version: string | null; reason: string; requestedAt: Date; requestedByName: string | null };
export type AsientoParaAvisar = {
  id: string; action: string; at: Date; businessDate: Date; branchId: string | null; actorUserId: string | null; actorName: string | null;
  resourceId: string | null; reason: string | null; beforeState: unknown; afterState: unknown;
};

/**
 * DE DÓNDE SALEN LOS AVISOS (bloque 4.2). Solo lee tablas de otros módulos,
 * como hace `analytics`: no escribe en ninguna y de aquí no sale el nombre de
 * ningún socio (sí el del personal: es lo que la dueña lee dentro del panel).
 *
 * Las cajas que amanecieron sin cortar y el tope de pases NO están aquí: ya
 * tienen su definición en `cash` (`CashAlertsService.unclosed`) y en la
 * bitácora (`AuditService.exceptionSummary`), y se usa esa.
 */
export class ScanSourcesRepository extends TenantRepository {
  /** Cortes cerrados desde `desde` con más de la tolerancia de diferencia y todavía sin revisar (D-17). */
  async cortesPorRevisar(desde: Date): Promise<CorteConDiferencia[]> {
    return this.db.$queryRaw<CorteConDiferencia[]>`
      SELECT s."id"::text AS "id", s."branchId"::text AS "branchId", b."name" AS "branchName", r."name" AS "registerName",
             s."varianceCents", s."varianceReason", s."closedAt", ab."fullName" AS "openedByName", ce."fullName" AS "closedByName"
        FROM "cash_sessions" s
        JOIN "branches" b ON b."id" = s."branchId"
        JOIN "cash_registers" r ON r."id" = s."cashRegisterId"
        LEFT JOIN "users" ab ON ab."id" = s."openedByUserId"
        LEFT JOIN "users" ce ON ce."id" = s."closedByUserId"
       WHERE s."organizationId" = ${this.organizationId}::uuid AND s."varianceStatus" = 'PENDING'
         AND s."closedAt" >= ${desde}
       ORDER BY s."closedAt", s."id"`;
  }

  /**
   * Solicitudes de privacidad cuyo plazo de ley vence antes de `limite`: la
   * respuesta (el plazo corre desde que se acreditó la identidad) y, si
   * procedió, hacerla efectiva.
   */
  async solicitudesPorVencer(limite: Date): Promise<SolicitudPorVencer[]> {
    return this.db.$queryRaw<SolicitudPorVencer[]>`
      SELECT p."id"::text AS "id", 'answer' AS "etapa", p."kind", p."dueAt" AS "vence"
        FROM "privacy_requests" p
       WHERE p."organizationId" = ${this.organizationId}::uuid AND p."resolvedAt" IS NULL AND p."identityVerifiedAt" IS NOT NULL AND p."dueAt" < ${limite}
      UNION ALL
      SELECT p."id"::text, 'effect', p."kind", p."effectiveDueAt"
        FROM "privacy_requests" p
       WHERE p."organizationId" = ${this.organizationId}::uuid AND p."outcome" = 'GRANTED' AND p."effectedAt" IS NULL AND p."effectiveDueAt" IS NOT NULL AND p."effectiveDueAt" < ${limite}
       ORDER BY 4, 1`;
  }

  /** El aviso de privacidad que la gerencia pidió publicar y espera la firma de la dueña (D-25). */
  async firmasDelAvisoPendientes(): Promise<FirmaDelAvisoPendiente[]> {
    return this.db.$queryRaw<FirmaDelAvisoPendiente[]>`
      SELECT q."id"::text AS "id", d."version" AS "version", q."reason", q."requestedAt", u."fullName" AS "requestedByName"
        FROM "consent_signature_requests" q
        JOIN "consent_documents" d ON d."id" = q."documentId"
        LEFT JOIN "users" u ON u."id" = q."requestedByUserId"
       WHERE q."organizationId" = ${this.organizationId}::uuid AND q."status" = 'PENDING'
       ORDER BY q."requestedAt", q."id"`;
  }

  /** Los asientos de la bitácora de estas acciones desde `desde`, del más viejo al más nuevo. */
  async asientos(acciones: readonly string[], desde: Date): Promise<AsientoParaAvisar[]> {
    const filas = await this.db.auditLog.findMany({
      where: this.scope({ action: { in: [...acciones] }, at: { gte: desde } }),
      select: {
        id: true, action: true, at: true, businessDate: true, branchId: true, actorUserId: true, resourceId: true, reason: true,
        beforeState: true, afterState: true, actor: { select: { fullName: true } },
      },
      orderBy: [{ at: 'asc' }, { id: 'asc' }], take: 500,
    });
    return filas.map(({ actor, ...f }) => ({ ...f, actorName: actor?.fullName ?? null }));
  }

  async sedes(): Promise<Map<string, string>> {
    const filas = await this.db.branch.findMany({ where: this.scope({}), select: { id: true, name: true } });
    return new Map(filas.map((f) => [f.id, f.name]));
  }

  async planes(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const filas = await this.db.plan.findMany({ where: this.scope({ id: { in: [...ids] } }), select: { id: true, name: true } });
    return new Map(filas.map((f) => [f.id, f.name]));
  }

  async personas(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const filas = await this.db.user.findMany({ where: { organizationId: this.organizationId, id: { in: [...ids] } }, select: { id: true, fullName: true } });
    return new Map(filas.map((f) => [f.id, f.fullName]));
  }
}
