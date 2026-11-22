import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * LA BANDEJA DEL INICIO (auditoría 8, bloque 2.1; 1-01): las cuentas de «Hoy
 * te toca». Solo lee, como todo `analytics`, y siempre acotado a las sedes
 * que la ruta ya decidió que esta persona puede resolver.
 *
 * Los rechazos de la puerta y los socios en riesgo NO se cuentan aquí: los
 * dan `access` y `retention` con la misma definición que sus pantallas.
 */
export class HomeRepository extends TenantRepository {
  /** Firmas que pidió esta persona y siguen esperando: cuántas y cuándo vence la primera. */
  async firmasPedidas(userId: string, ahora: Date): Promise<{ total: number; vence: Date | null }> {
    const r = await this.db.approvalRequest.aggregate({
      where: { organizationId: this.organizationId, requestedByUserId: userId, status: 'PENDING', expiresAt: { gt: ahora } },
      _count: { _all: true }, _min: { expiresAt: true },
    });
    return { total: r._count._all, vence: r._min.expiresAt };
  }

  /** Cajas abiertas en un día de negocio anterior al de hoy de su sede. `dias` va en el orden de `sedes`. */
  async cajasDeAyer(sedes: readonly string[], dias: readonly Date[]): Promise<string[]> {
    if (sedes.length === 0) return [];
    const fechas = dias.map((d) => d.toISOString().slice(0, 10));
    const filas = await this.db.$queryRaw<Array<{ nombre: string }>>`
      SELECT r."name" || ' (' || b."name" || ')' AS "nombre"
        FROM "cash_sessions" s
        JOIN unnest(${sedes as string[]}::uuid[], ${fechas}::date[]) AS h("branchId", "dia") ON h."branchId" = s."branchId"
        JOIN "cash_registers" r ON r."id" = s."cashRegisterId"
        JOIN "branches" b ON b."id" = s."branchId"
       WHERE s."organizationId" = ${this.organizationId}::uuid AND s."status" = 'OPEN' AND s."businessDate" < h."dia"
       ORDER BY s."openedAt"`;
    return filas.map((f) => f.nombre);
  }

  /**
   * Suspendidas con periodos atrasados (4-08, A1-T9): su periodo ya terminó y
   * siguen suspendidas, así que alguien tiene que decidir el adeudo. Una
   * suspendida dentro de su periodo se resuelve cobrando: no cuenta aquí.
   */
  async suspendidasPorDecidir(sedes: readonly string[], hoy: Date): Promise<number> {
    if (sedes.length === 0) return 0;
    const [r] = await this.db.$queryRaw<Array<{ total: number }>>`
      SELECT COUNT(*)::int AS "total"
        FROM "memberships" ms JOIN "members" m ON m."id" = ms."memberId"
       WHERE ms."organizationId" = ${this.organizationId}::uuid AND ms."status" = 'SUSPENDED'
         AND ms."currentPeriodEnd" < ${hoy}::date
         AND m."deletedAt" IS NULL AND m."status" <> 'ARCHIVED' AND m."homeBranchId" = ANY(${sedes as string[]}::uuid[])`;
    return r?.total ?? 0;
  }

  /** Tipos de texto con una versión publicada. */
  async textosPublicados(): Promise<Set<string>> {
    const filas = await this.db.consentDocument.findMany({
      where: { organizationId: this.organizationId, status: 'PUBLISHED' }, select: { consentType: true }, distinct: ['consentType'],
    });
    return new Set(filas.map((f) => f.consentType as string));
  }

  /** Clases que faltan hoy (o están en curso) y no tienen coach. */
  async clasesSinCoach(sedes: readonly string[], desde: Date, hasta: Date): Promise<number> {
    if (sedes.length === 0) return 0;
    return this.db.classSchedule.count({
      where: { organizationId: this.organizationId, status: 'SCHEDULED', coachUserId: null, endsAt: { gt: desde }, startsAt: { lt: hasta }, branchId: { in: [...sedes] } },
    });
  }

  async altasPorRevisar(sedes: readonly string[]): Promise<number> {
    if (sedes.length === 0) return 0;
    return this.db.memberIntake.count({ where: { organizationId: this.organizationId, status: 'SUBMITTED', branchId: { in: [...sedes] } } });
  }
}
