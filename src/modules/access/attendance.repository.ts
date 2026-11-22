import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * La ASISTENCIA del socio (`attendance_events`, tabla de este módulo).
 *
 * Las últimas visitas las leen la pantalla de excepción (aquí mismo) y el
 * portal (el historial del socio). Vivían en `analytics` junto a la retención
 * y obligaban a `access` y a `portal` a depender de la analítica (A3-T12,
 * informe 15).
 */
export class AttendanceRepository extends TenantRepository {
  /** Últimas visitas de un socio: las leen la pantalla de excepción y el portal. */
  async recentVisits(memberId: string, limit = 5): Promise<Array<{ at: Date; branchId: string }>> {
    return this.db.$queryRaw`
      SELECT "at", "branchId" FROM "attendance_events"
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "memberId" = ${memberId}::uuid
      ORDER BY "at" DESC
      LIMIT ${limit}`;
  }

  /**
   * Las últimas entradas con el DÍA DE OPERACIÓN en que cuentan y los días
   * distintos con visita desde `desde` (fase 2, bloque 2.8 · 27-05, 25-16).
   * El día es el que guardó la puerta (`businessDate`, en la zona de la
   * sede): el portal ya no lo deduce con la hora del teléfono, y dos entradas
   * el mismo día son una visita.
   */
  async visitsWithDay(memberId: string, limit: number): Promise<Array<{ at: Date; branchId: string; businessDate: Date }>> {
    return this.db.$queryRaw`
      SELECT "at", "branchId", "businessDate" FROM "attendance_events"
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "memberId" = ${memberId}::uuid
      ORDER BY "at" DESC
      LIMIT ${limit}`;
  }

  async visitDays(memberId: string, desde: Date): Promise<Date[]> {
    const filas = await this.db.$queryRaw<Array<{ businessDate: Date }>>`
      SELECT DISTINCT "businessDate" FROM "attendance_events"
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "memberId" = ${memberId}::uuid
        AND "businessDate" >= ${desde}::date
      ORDER BY "businessDate" DESC`;
    return filas.map((f) => f.businessDate);
  }
}
