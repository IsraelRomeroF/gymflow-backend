import { TenantRepository } from '../../platform/db/tenant-repository.js';

/** Las acciones de la bitácora que cuentan como «descuento» y como «devolución» en el resumen de la semana. */
const DESCUENTOS = ['billing.discount.apply'];
const DEVOLUCIONES = ['payment.refund', 'payments.reverse', 'payments.return', 'payments.credit.return', 'pos.sale.return'];

export type PersonaDeLaSemana = { name: string; discounts: number; refunds: number; usual: number };

/**
 * LA SEMANA EN CIFRAS (fase 4, bloque 4.2; D-05): lo que el resumen del lunes
 * le dice a la dueña. Solo lee, como todo `analytics`, y solo cuenta: de aquí
 * no sale el nombre de ningún socio. Lo que ya tiene definición en otra
 * consulta (lo que entró, las entradas, las altas, las bajas, la cartera) NO
 * se vuelve a definir aquí: lo arma `WeeklyService` con esas mismas consultas.
 */
export class WeeklyRepository extends TenantRepository {
  /**
   * Entradas al gimnasio en esos días de operación: cada paso por la puerta
   * que contó como asistencia. (La cifra del Inicio es otra: PERSONAS distintas
   * que entraron hoy; en una semana esa cuenta diría cuánta gente, no cuántas entradas.)
   */
  async entradas(desdeDia: Date, hastaDia: Date): Promise<number> {
    return this.db.attendanceEvent.count({ where: this.scope({ businessDate: { gte: desdeDia, lt: hastaDia } }) });
  }

  /** Cortes de la semana con diferencia: cuántos, cuánto faltó, cuánto sobró y cuántos siguen por revisar. */
  async cortes(desdeDia: Date, hastaDia: Date): Promise<{ variances: number; shortCents: bigint; overCents: bigint; pendingReview: number }> {
    const [r] = await this.db.$queryRaw<Array<{ variances: number; short: bigint | null; over: bigint | null; pending: number }>>`
      SELECT COUNT(*) FILTER (WHERE s."varianceCents" <> 0)::int AS "variances",
             COALESCE(SUM(-s."varianceCents") FILTER (WHERE s."varianceCents" < 0), 0)::bigint AS "short",
             COALESCE(SUM(s."varianceCents") FILTER (WHERE s."varianceCents" > 0), 0)::bigint AS "over",
             COUNT(*) FILTER (WHERE s."varianceStatus" = 'PENDING')::int AS "pending"
        FROM "cash_sessions" s
       WHERE s."organizationId" = ${this.organizationId}::uuid AND s."status" = 'CLOSED'
         AND s."businessDate" >= ${desdeDia}::date AND s."businessDate" < ${hastaDia}::date`;
    return { variances: r?.variances ?? 0, shortCents: BigInt(r?.short ?? 0), overCents: BigInt(r?.over ?? 0), pendingReview: r?.pending ?? 0 };
  }

  /** Firmas pedidas a distancia en la semana y en qué acabaron. */
  async firmas(desde: Date, hasta: Date): Promise<{ requested: number; approved: number; rejected: number }> {
    const [r] = await this.db.$queryRaw<Array<{ requested: number; approved: number; rejected: number }>>`
      SELECT COUNT(*)::int AS "requested",
             COUNT(*) FILTER (WHERE "status" = 'APPROVED')::int AS "approved",
             COUNT(*) FILTER (WHERE "status" = 'REJECTED')::int AS "rejected"
        FROM "approval_requests"
       WHERE "organizationId" = ${this.organizationId}::uuid AND "createdAt" >= ${desde} AND "createdAt" < ${hasta}`;
    return { requested: r?.requested ?? 0, approved: r?.approved ?? 0, rejected: r?.rejected ?? 0 };
  }

  /** Lo que HOY espera la firma de la dueña: solicitudes vivas, el aviso de privacidad y la lista de exsocios. */
  async esperanFirma(ahora: Date): Promise<{ approvals: number; privacyNotice: number; exMembersList: number }> {
    const [r] = await this.db.$queryRaw<Array<{ approvals: number; notice: number; list: number }>>`
      SELECT (SELECT COUNT(*)::int FROM "approval_requests" WHERE "organizationId" = ${this.organizationId}::uuid AND "status" = 'PENDING' AND "expiresAt" > ${ahora}) AS "approvals",
             (SELECT COUNT(*)::int FROM "consent_signature_requests" WHERE "organizationId" = ${this.organizationId}::uuid AND "status" = 'PENDING') AS "notice",
             (SELECT COUNT(*)::int FROM "privacy_batches" b WHERE b."organizationId" = ${this.organizationId}::uuid AND b."status" = 'PENDING'
                AND EXISTS (SELECT 1 FROM "privacy_batch_items" i WHERE i."batchId" = b."id" AND i."status" = 'LISTED')) AS "list"`;
    return { approvals: r?.approvals ?? 0, privacyNotice: r?.notice ?? 0, exMembersList: r?.list ?? 0 };
  }

  /** Cuántos asientos de la bitácora hubo en la ventana, por acción. */
  async asientos(acciones: readonly string[], desde: Date, hasta: Date): Promise<Map<string, number>> {
    const filas = await this.db.auditLog.groupBy({
      by: ['action'], where: this.scope({ action: { in: [...acciones] }, at: { gte: desde, lt: hasta } }), _count: { _all: true },
    });
    return new Map(filas.map((f) => [f.action, f._count._all]));
  }

  /** Ventas de membresía fechadas hacia atrás en la ventana. */
  async ventasConFechaAnterior(desde: Date, hasta: Date): Promise<number> {
    return this.db.auditLog.count({ where: this.scope({ action: 'membership.sale', at: { gte: desde, lt: hasta }, afterState: { path: ['backdated'], equals: true } }) });
  }

  /** Lo que el cierre de la noche sacó de «Por cobrar» en la ventana (D-18). */
  async deudaPerdida(desde: Date, hasta: Date): Promise<bigint> {
    const filas = await this.db.auditLog.findMany({ where: this.scope({ action: 'billing.debt.lost.summary', at: { gte: desde, lt: hasta } }), select: { afterState: true } });
    return filas.reduce((a, f) => {
      const v = (f.afterState as { amountCents?: unknown } | null)?.amountCents;
      return a + (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : 0n);
    }, 0n);
  }

  /** Cambios de celular hechos desde el portal a un número que ya usa otro socio (D-36, D-09). */
  async celularesCompartidos(desde: Date, hasta: Date): Promise<number> {
    return this.db.memberContactChange.count({ where: this.scope({ field: 'PHONE', sharedPhone: true, createdAt: { gte: desde, lt: hasta } }) });
  }

  /**
   * DESCUENTOS Y DEVOLUCIONES POR PERSONA CONTRA LO NORMAL (D-05 c): cuántos
   * hizo cada quien en la semana y su promedio semanal de las cuatro
   * anteriores. Son nombres del PERSONAL y solo se leen dentro del panel.
   */
  async porPersona(desde: Date, hasta: Date): Promise<PersonaDeLaSemana[]> {
    const antes = new Date(desde.getTime() - 28 * 86_400_000);
    const filas = await this.db.$queryRaw<Array<{ name: string; discounts: number; refunds: number; before: number }>>`
      SELECT u."fullName" AS "name",
             COUNT(*) FILTER (WHERE a."at" >= ${desde} AND a."action" = ANY(${DESCUENTOS}::text[]))::int AS "discounts",
             COUNT(*) FILTER (WHERE a."at" >= ${desde} AND a."action" = ANY(${DEVOLUCIONES}::text[]))::int AS "refunds",
             COUNT(*) FILTER (WHERE a."at" < ${desde})::int AS "before"
        FROM "audit_logs" a JOIN "users" u ON u."id" = a."actorUserId"
       WHERE a."organizationId" = ${this.organizationId}::uuid AND a."at" >= ${antes} AND a."at" < ${hasta}
         AND a."action" = ANY(${[...DESCUENTOS, ...DEVOLUCIONES]}::text[])
       GROUP BY u."id", u."fullName"
      HAVING COUNT(*) FILTER (WHERE a."at" >= ${desde}) > 0
       ORDER BY 2 + 3 DESC, 1`;
    return filas.map((f) => ({ name: f.name, discounts: f.discounts, refunds: f.refunds, usual: Math.round((f.before / 4) * 10) / 10 }));
  }

  static readonly DESCUENTOS = DESCUENTOS;
}
