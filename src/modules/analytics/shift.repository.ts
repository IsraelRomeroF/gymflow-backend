import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * EL TURNO DE QUIEN ATIENDE (UX5-M-02, UX5-G-02): lo que recepción, caja y el
 * encargado necesitan ver al empezar, de SUS sucursales y sin una sola cifra
 * financiera del negocio. Solo lectura.
 */
export class ShiftRepository extends TenantRepository {
  /** Turnos de caja abiertos en estas sedes, con quién los abrió. */
  async cajasAbiertas(sedes: readonly string[]): Promise<Array<{ id: string; branchId: string; registerName: string; openedByUserId: string; openedByName: string | null; openedAt: Date }>> {
    if (sedes.length === 0) return [];
    return this.db.$queryRaw`
      SELECT s."id", s."branchId", r."name" AS "registerName", s."openedByUserId", u."fullName" AS "openedByName", s."openedAt"
        FROM "cash_sessions" s JOIN "cash_registers" r ON r."id" = s."cashRegisterId" LEFT JOIN "users" u ON u."id" = s."openedByUserId"
       WHERE s."organizationId" = ${this.organizationId}::uuid AND s."status" = 'OPEN' AND s."branchId" = ANY(${sedes as string[]}::uuid[])
       ORDER BY s."openedAt"`;
  }

  /** Cajas registradoras activas por sede (para ofrecer "Abrir turno"). */
  async cajas(sedes: readonly string[]): Promise<Array<{ id: string; branchId: string; name: string }>> {
    if (sedes.length === 0) return [];
    return this.db.cashRegister.findMany({ where: { organizationId: this.organizationId, isActive: true, deletedAt: null, branchId: { in: [...sedes] } }, select: { id: true, branchId: true, name: true }, orderBy: { code: 'asc' } });
  }

  /** Entradas de hoy por sede: personas distintas y la última. */
  async entradas(sedes: readonly string[], desde: Date): Promise<Array<{ branchId: string; total: number; ultima: Date | null }>> {
    if (sedes.length === 0) return [];
    return this.db.$queryRaw`
      SELECT "branchId", COUNT(DISTINCT "memberId")::int AS total, MAX("at") AS ultima
        FROM "attendance_events"
       WHERE "organizationId" = ${this.organizationId}::uuid AND "at" >= ${desde} AND "branchId" = ANY(${sedes as string[]}::uuid[])
       GROUP BY 1`;
  }

  async altasPorRevisar(sedes: readonly string[]): Promise<number> {
    if (sedes.length === 0) return 0;
    return this.db.memberIntake.count({ where: { organizationId: this.organizationId, status: 'SUBMITTED', branchId: { in: [...sedes] } } });
  }

  /** Las clases que faltan hoy en estas sedes, con su ocupación. La que ya empezó sigue aquí hasta que termina (MC-09). */
  async clasesDeHoy(sedes: readonly string[], desde: Date, hasta: Date): Promise<Array<{ id: string; branchId: string; name: string; startsAt: Date; capacity: number; booked: number }>> {
    if (sedes.length === 0) return [];
    return this.db.$queryRaw`
      SELECT s."id", s."branchId", t."name", s."startsAt", s."capacity", s."bookedCount" AS booked
        FROM "class_schedules" s JOIN "class_types" t ON t."id" = s."classTypeId"
       WHERE s."organizationId" = ${this.organizationId}::uuid AND s."status" = 'SCHEDULED'
         AND s."endsAt" > ${desde} AND s."startsAt" < ${hasta} AND s."branchId" = ANY(${sedes as string[]}::uuid[])
       ORDER BY s."startsAt" LIMIT 6`;
  }
}
