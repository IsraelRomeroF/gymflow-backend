import { TenantRepository } from '../../platform/db/tenant-repository.js';

export type PorSede = { branchId: string | null; cents: bigint };
export type Conteo = { branchId: string | null; total: number };

/**
 * Las consultas del "pulso" de la dueña: lo que pasó en una ventana de
 * TIEMPO (no de fecha de negocio), para poder comparar "hoy hasta esta hora"
 * con "ayer hasta esta hora". Una consulta por pregunta, todas agregadas en
 * la base.
 */
export class PulseRepository extends TenantRepository {
  /** Lo que entró (LA definición: sin notas de crédito, con devoluciones restadas). */
  async entroEntre(desde: Date, hasta: Date): Promise<PorSede[]> {
    return this.db.$queryRaw<PorSede[]>`
      SELECT "branchId", SUM(c)::bigint AS cents FROM (
        SELECT COALESCE(p."branchId", m."homeBranchId") AS "branchId", p."amountCents" AS c
          FROM "payments" p JOIN "members" m ON m."id" = p."memberId"
         WHERE p."organizationId" = ${this.organizationId}::uuid AND p."status" IN ('SUCCEEDED','REVERSED')
           AND p."method" <> 'CREDIT_NOTE' AND p."receivedAt" >= ${desde} AND p."receivedAt" < ${hasta}
        UNION ALL
        SELECT s."branchId", s."totalCents"
          FROM "pos_sales" s
         WHERE s."organizationId" = ${this.organizationId}::uuid AND s."status" = 'COMPLETED' AND s."method" IS NOT NULL
           AND s."soldAt" >= ${desde} AND s."soldAt" < ${hasta}
      ) t GROUP BY 1`;
  }

  /** Lo que entró por hora local (0–23) de cada sede, para la gráfica del día. */
  async entroPorHora(desde: Date, hasta: Date, zona: string): Promise<Array<{ branchId: string | null; hora: number; cents: bigint }>> {
    return this.db.$queryRaw`
      SELECT "branchId", hora::int, SUM(c)::bigint AS cents FROM (
        SELECT COALESCE(p."branchId", m."homeBranchId") AS "branchId", EXTRACT(HOUR FROM p."receivedAt" AT TIME ZONE ${zona}) AS hora, p."amountCents" AS c
          FROM "payments" p JOIN "members" m ON m."id" = p."memberId"
         WHERE p."organizationId" = ${this.organizationId}::uuid AND p."status" IN ('SUCCEEDED','REVERSED')
           AND p."method" <> 'CREDIT_NOTE' AND p."receivedAt" >= ${desde} AND p."receivedAt" < ${hasta}
        UNION ALL
        SELECT s."branchId", EXTRACT(HOUR FROM s."soldAt" AT TIME ZONE ${zona}), s."totalCents"
          FROM "pos_sales" s
         WHERE s."organizationId" = ${this.organizationId}::uuid AND s."status" = 'COMPLETED' AND s."method" IS NOT NULL
           AND s."soldAt" >= ${desde} AND s."soldAt" < ${hasta}
      ) t GROUP BY 1, 2`;
  }

  /** Personas distintas que entraron al gimnasio en la ventana, por sede. */
  async entradas(desde: Date, hasta: Date): Promise<Conteo[]> {
    return this.db.$queryRaw<Conteo[]>`
      SELECT "branchId", COUNT(DISTINCT "memberId")::int AS total
        FROM "access_decisions"
       WHERE "organizationId" = ${this.organizationId}::uuid AND "outcome" = 'GRANTED'
         AND "at" >= ${desde} AND "at" < ${hasta}
       GROUP BY 1`;
  }

  /**
   * A qué hora abrió y hasta cuándo hubo movimiento en cada sede: la primera
   * y la última entrada del día. Es lo que la dueña mira desde su teléfono.
   */
  async puertas(desde: Date, hasta: Date): Promise<Array<{ branchId: string; firstAt: Date; lastAt: Date; total: number }>> {
    return this.db.$queryRaw`
      SELECT "branchId", MIN("at") AS "firstAt", MAX("at") AS "lastAt", COUNT(*)::int AS total
        FROM "attendance_events"
       WHERE "organizationId" = ${this.organizationId}::uuid AND "at" >= ${desde} AND "at" < ${hasta}
       GROUP BY 1`;
  }

  /** Quién entró hace un momento, por nombre: las últimas entradas del día. */
  async ultimasEntradas(desde: Date, hasta: Date, limite = 12): Promise<Array<{ branchId: string; memberId: string; memberName: string; memberCode: string; at: Date }>> {
    return this.db.$queryRaw`
      SELECT e."branchId", e."memberId", m."firstName" || ' ' || m."lastName" AS "memberName", m."memberCode", e."at"
        FROM "attendance_events" e JOIN "members" m ON m."id" = e."memberId"
       WHERE e."organizationId" = ${this.organizationId}::uuid AND e."at" >= ${desde} AND e."at" < ${hasta}
       ORDER BY e."at" DESC LIMIT ${limite}`;
  }

  /** Cuándo se abrió la primera caja y se cerró la última, por sede, en el día. */
  async horarioDeCaja(desde: Date, hasta: Date): Promise<Array<{ branchId: string; openedAt: Date; closedAt: Date | null }>> {
    return this.db.$queryRaw`
      SELECT "branchId", MIN("openedAt") AS "openedAt",
             CASE WHEN COUNT(*) FILTER (WHERE "status" = 'OPEN') > 0 THEN NULL ELSE MAX("closedAt") END AS "closedAt"
        FROM "cash_sessions"
       WHERE "organizationId" = ${this.organizationId}::uuid AND "openedAt" >= ${desde} AND "openedAt" < ${hasta}
       GROUP BY 1`;
  }

  /** Socios nuevos por su fecha de alta. */
  async altas(desdeDia: Date, hastaDia: Date): Promise<Conteo[]> {
    return this.db.$queryRaw<Conteo[]>`
      SELECT "homeBranchId" AS "branchId", COUNT(*)::int AS total
        FROM "members"
       WHERE "organizationId" = ${this.organizationId}::uuid AND "joinedAt" >= ${desdeDia} AND "joinedAt" < ${hastaDia}
       GROUP BY 1`;
  }

  /** Bajas: socios dados de baja en la ventana. */
  async bajas(desde: Date, hasta: Date): Promise<Conteo[]> {
    return this.db.$queryRaw<Conteo[]>`
      SELECT "homeBranchId" AS "branchId", COUNT(*)::int AS total
        FROM "members"
       WHERE "organizationId" = ${this.organizationId}::uuid AND "deletedAt" >= ${desde} AND "deletedAt" < ${hasta}
       GROUP BY 1`;
  }

  /** Socios con pago atrasado (en gracia o suspendidos). */
  async enMora(): Promise<Conteo[]> {
    return this.db.$queryRaw<Conteo[]>`
      SELECT m."homeBranchId" AS "branchId", COUNT(DISTINCT m."id")::int AS total
        FROM "members" m JOIN "memberships" ms ON ms."memberId" = m."id" AND ms."status" IN ('PAST_DUE','SUSPENDED')
       WHERE m."organizationId" = ${this.organizationId}::uuid AND m."deletedAt" IS NULL
       GROUP BY 1`;
  }

  /** Cortes cerrados con faltante en la ventana: caja y quién la cerró. */
  async cortesConFaltante(desde: Date): Promise<Array<{ id: string; branchId: string; registerName: string; closedByName: string | null; varianceCents: bigint; reason: string | null; closedAt: Date }>> {
    return this.db.$queryRaw`
      SELECT s."id", s."branchId", r."name" AS "registerName", u."fullName" AS "closedByName",
             s."varianceCents", s."varianceReason" AS reason, s."closedAt"
        FROM "cash_sessions" s
        JOIN "cash_registers" r ON r."id" = s."cashRegisterId"
        LEFT JOIN "users" u ON u."id" = s."closedByUserId"
       WHERE s."organizationId" = ${this.organizationId}::uuid AND s."status" <> 'OPEN'
         AND s."varianceCents" < 0 AND s."closedAt" >= ${desde}
       ORDER BY s."closedAt" DESC LIMIT 10`;
  }

  /** Cajas abiertas ahora: desde cuándo y quién. */
  async cajasAbiertas(): Promise<Array<{ id: string; branchId: string; registerName: string; openedByName: string | null; openedByUserId: string | null; openedAt: Date }>> {
    return this.db.$queryRaw`
      SELECT s."id", s."branchId", r."name" AS "registerName", u."fullName" AS "openedByName", s."openedByUserId", s."openedAt"
        FROM "cash_sessions" s
        JOIN "cash_registers" r ON r."id" = s."cashRegisterId"
        LEFT JOIN "users" u ON u."id" = s."openedByUserId"
       WHERE s."organizationId" = ${this.organizationId}::uuid AND s."status" = 'OPEN'
       ORDER BY s."openedAt" ASC`;
  }

  /**
   * El equipo hoy (ADR-039, "monitoreo de personal"): cada persona activa con
   * su puesto, su sede, su último acceso, su última acción en la bitácora y
   * cuántos cobros y entradas registró en la ventana. La dueña vigila a su
   * personal sin ver un solo expediente de socio.
   */
  async equipo(desde: Date, hasta: Date): Promise<Array<{
    userId: string; fullName: string; roleKey: string; roleName: string; branchId: string | null;
    lastLoginAt: Date | null; lastActionAt: Date | null; actionsToday: number; paymentsToday: number; entriesToday: number;
  }>> {
    return this.db.$queryRaw`
      SELECT DISTINCT ON (u."id") u."id" AS "userId", u."fullName", r."key" AS "roleKey", r."name" AS "roleName",
             -- Con varias sedes (el encargado de Centro y Norte) sale UNA vez, sin sede fija (UX5-D-08).
             CASE WHEN COUNT(*) OVER (PARTITION BY u."id") > 1 THEN NULL ELSE ra."branchId" END AS "branchId", u."lastLoginAt",
             (SELECT MAX(a."at") FROM "audit_logs" a WHERE a."actorUserId" = u."id" AND a."at" >= ${desde} AND a."at" < ${hasta}) AS "lastActionAt",
             (SELECT COUNT(*)::int FROM "audit_logs" a WHERE a."actorUserId" = u."id" AND a."at" >= ${desde} AND a."at" < ${hasta}) AS "actionsToday",
             (SELECT COUNT(*)::int FROM "payments" p WHERE p."createdByUserId" = u."id" AND p."createdAt" >= ${desde} AND p."createdAt" < ${hasta}) AS "paymentsToday",
             (SELECT COUNT(*)::int FROM "access_decisions" d WHERE d."overriddenByUserId" = u."id" AND d."at" >= ${desde} AND d."at" < ${hasta}) AS "entriesToday"
        FROM "users" u
        JOIN "role_assignments" ra ON ra."userId" = u."id" AND ra."revokedAt" IS NULL
        JOIN "roles" r ON r."id" = ra."roleId"
       WHERE u."organizationId" = ${this.organizationId}::uuid AND u."deletedAt" IS NULL AND u."isActive" = true AND r."key" <> 'OWNER'
       ORDER BY u."id"`;
  }

  /** Devoluciones (pagos negativos) de la ventana. */
  async devoluciones(desde: Date, hasta: Date): Promise<Array<{ branchId: string | null; total: number; cents: bigint }>> {
    return this.db.$queryRaw`
      SELECT COALESCE(p."branchId", m."homeBranchId") AS "branchId", COUNT(*)::int AS total, SUM(p."amountCents")::bigint AS cents
        FROM "payments" p JOIN "members" m ON m."id" = p."memberId"
       WHERE p."organizationId" = ${this.organizationId}::uuid AND p."amountCents" < 0 AND p."method" <> 'CREDIT_NOTE'
         AND p."receivedAt" >= ${desde} AND p."receivedAt" < ${hasta}
       GROUP BY 1`;
  }

  /** Firmas que el mostrador espera de la gerencia. */
  async firmasPendientes(): Promise<Array<{ branchId: string | null; total: number; desde: Date }>> {
    return this.db.$queryRaw`
      SELECT "branchId", COUNT(*)::int AS total, MIN("createdAt") AS desde
        FROM "approval_requests"
       WHERE "organizationId" = ${this.organizationId}::uuid AND "status" = 'PENDING' AND "expiresAt" > now()
       GROUP BY 1`;
  }
}
