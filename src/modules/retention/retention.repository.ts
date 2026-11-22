import { RETENTION_THRESHOLDS } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * Datos de asistencia para las alertas de retención (F-22).
 *
 * Todo se agrega en el motor: la lista se calcula sobre el padrón completo y
 * traerlo a memoria para contar visitas no aguanta la primera sucursal real.
 */

export type EngagementRow = {
  phoneE164: string | null;
  memberId: string;
  memberCode: string;
  fullName: string;
  homeBranchId: string | null;
  joinedAt: Date;
  lastVisitAt: Date | null;
  totalVisits: number;
  /**
   * El día en que se descongeló su membresía, si fue DESPUÉS de su última
   * visita (D15-07): desde ahí se cuentan los días sin venir. `null` = sin
   * pausa que considerar.
   */
  resumedAt: Date | null;
  /**
   * Visitas por semana del socio, medidas EXCLUYENDO las dos últimas semanas.
   *
   * Si se incluyeran, dejar de venir bajaría su propia línea base y la alerta
   * no saltaría nunca: el socio que se va parecería siempre normal.
   */
  baselineVisitsPerWeek: number | null;
  monthlyValueCents: bigint;
};

/**
 * A quién mide Retención (15-05, D15-07): solo membresías que hoy dan derecho
 * a venir. El CONGELADO pidió pausa (llamarle «te extrañamos» en plena lesión
 * o viaje molesta) y vuelve a la lista una semana después de descongelar si no
 * ha venido; el alta SIN ACTIVAR (`PENDING`) es un tema de cobro, no de hábito.
 */
export const ESTADOS_QUE_SE_MIDEN = ['TRIALING', 'ACTIVE', 'PAST_DUE'] as const;
const ESTADOS_VIVOS = `(${ESTADOS_QUE_SE_MIDEN.map((e) => `'${e}'`).join(',')})`;

/** La ventana de la línea base, en días, con los plazos del núcleo (hoy 56 → 14 días atrás). */
const BASE_DESDE = RETENTION_THRESHOLDS.baselineWeeks * 7 + RETENTION_THRESHOLDS.baselineLagDays;
const BASE_HASTA = RETENTION_THRESHOLDS.baselineLagDays;

export class RetentionRepository extends TenantRepository {
  /**
   * TODOS los socios vivos, sin recorte: el recorte va después de clasificar
   * y priorizar. Antes se cortaba aquí a 500 por antigüedad y, con un padrón
   * mayor, quedaban fuera justo los nuevos —los que están en riesgo de no
   * arrancar—. Las visitas se cuentan del último año: reagregar toda la
   * historia en cada consulta crecía sin límite.
   */
  async engagement(today: Date, branchId?: string | null): Promise<EngagementRow[]> {
    const filtro = branchId ? `AND m."homeBranchId" = $3::uuid` : '';
    const params: unknown[] = [this.organizationId, today];
    if (branchId) params.push(branchId);

    return this.db.$queryRawUnsafe<EngagementRow[]>(`
      WITH base AS (
        SELECT a."memberId",
               COUNT(*)::float / ${RETENTION_THRESHOLDS.baselineWeeks}::float AS "visitsPerWeek"
        FROM "attendance_events" a
        WHERE a."organizationId" = $1::uuid
          AND a."businessDate" >= $2::date - ${BASE_DESDE}
          AND a."businessDate" <  $2::date - ${BASE_HASTA}
        GROUP BY a."memberId"
      ),
      totales AS (
        SELECT a."memberId", COUNT(*)::int AS "total", MAX(a."at") AS "last"
        FROM "attendance_events" a
        WHERE a."organizationId" = $1::uuid
          AND a."businessDate" >= $2::date - INTERVAL '365 days'
        GROUP BY a."memberId"
      )
      SELECT m."id" AS "memberId", m."memberCode",
             m."firstName" || ' ' || m."lastName" AS "fullName",
             m."homeBranchId", m."joinedAt", m."phoneE164",
             totales."last" AS "lastVisitAt",
             COALESCE(totales."total", 0) AS "totalVisits",
             base."visitsPerWeek" AS "baselineVisitsPerWeek",
             (SELECT MAX(e."businessDate")
                FROM "membership_events" e
               WHERE e."organizationId" = $1::uuid
                 AND e."membershipId" = ms."id"
                 AND e."eventType" = 'UNFROZEN'
                 AND (totales."last" IS NULL OR e."at" > totales."last")) AS "resumedAt",
             COALESCE(p."priceCents", 0)::bigint AS "monthlyValueCents"
      FROM "members" m
      JOIN "memberships" ms ON ms."memberId" = m."id" AND ms."status" IN ${ESTADOS_VIVOS}
      JOIN "plans" p ON p."id" = ms."planId"
      LEFT JOIN totales ON totales."memberId" = m."id"
      LEFT JOIN base ON base."memberId" = m."id"
      WHERE m."organizationId" = $1::uuid
        AND m."deletedAt" IS NULL
        ${filtro}
      ORDER BY m."joinedAt" ASC`, ...params);
  }
}
