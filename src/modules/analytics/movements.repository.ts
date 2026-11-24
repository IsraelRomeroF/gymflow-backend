import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * El dinero de cada día, movimiento por movimiento.
 *
 * Fuente: lo que REALMENTE entró y salió, por día de negocio de la sede:
 *   · pagos de socios (los negativos son reversas y reembolsos),
 *   · ventas del punto de venta cobradas en el momento,
 *   · movimientos de caja (gastos, retiros, depósitos, fondo),
 *   · descuadres al cerrar caja, UNO POR CORTE: la regla de qué cuenta
 *     (`descuadreQueCuenta` del núcleo) se aplica corte por corte; sumarlos
 *     por día antes de mirar el signo dejaba que un sobrante tapara un
 *     faltante (13-05).
 * Las notas de crédito NO son dinero nuevo (aplican un saldo a favor que ya
 * se contó cuando entró): se MUESTRAN para que nadie salde un adeudo con una
 * a escondidas (SEC2-16), pero no suman a la ganancia.
 * Un pago sin sede (los del portal) se atribuye a la sede de casa del socio:
 * si no, desaparecía al filtrar por sucursal.
 */

export type FilaDia = { day: Date; branchId: string | null; kind: string; method: string | null; amountCents: bigint };

export type Movimiento = {
  id: string; at: Date; day: Date; branchId: string | null;
  kind: 'PAYMENT' | 'REFUND' | 'CREDIT_NOTE' | 'POS_SALE' | 'POS_VOID' | 'CASH_EXPENSE' | 'CASH_WITHDRAWAL' | 'CASH_DEPOSIT' | 'CASH_FLOAT_IN' | 'CASH_CORRECTION' | 'CASH_VARIANCE';
  method: string | null; amountCents: bigint; concept: string | null; folio: string | null;
  memberId: string | null; memberName: string | null; memberCode: string | null; userName: string | null;
};

export class MovementsRepository extends TenantRepository {
  /** Totales por día, sede, tipo y método, sumados en la base; los descuadres, uno por corte. */
  async porDia(from: Date, to: Date): Promise<FilaDia[]> {
    return this.db.$queryRaw<FilaDia[]>`
      SELECT p."businessDate" AS day, COALESCE(p."branchId", mb."homeBranchId") AS "branchId",
             CASE WHEN p."method" = 'CREDIT_NOTE' THEN 'CREDIT_NOTE'
                  WHEN p."amountCents" < 0 THEN 'REFUND' ELSE 'PAYMENT' END AS kind,
             p."method"::text AS method, SUM(p."amountCents")::bigint AS "amountCents"
        FROM "payments" p JOIN "members" mb ON mb."id" = p."memberId"
       WHERE p."organizationId" = ${this.organizationId}::uuid
         AND p."status" IN ('SUCCEEDED','REVERSED')
         AND p."businessDate" >= ${from}::date AND p."businessDate" < ${to}::date
       GROUP BY 1, 2, 3, 4
      UNION ALL
      SELECT s."businessDate", s."branchId", 'POS_SALE', s."method"::text, SUM(s."totalCents")::bigint
        FROM "pos_sales" s
       WHERE s."organizationId" = ${this.organizationId}::uuid
         AND s."status" = 'COMPLETED' AND s."method" IS NOT NULL
         AND s."businessDate" >= ${from}::date AND s."businessDate" < ${to}::date
       GROUP BY 1, 2, 3, 4
      UNION ALL
      -- Bloque 3.5 (D-13; edición puntual): la devolución de una venta de tienda de otro día
      -- resta, como reembolso, el día en que se devuelve. La venta original no se mueve.
      SELECT r."businessDate", r."branchId", 'REFUND', r."method"::text, (-SUM(r."amountCents"))::bigint
        FROM "pos_sale_returns" r
       WHERE r."organizationId" = ${this.organizationId}::uuid
         AND r."businessDate" >= ${from}::date AND r."businessDate" < ${to}::date
       GROUP BY 1, 2, 3, 4
      UNION ALL
      SELECT m."businessDate", cs."branchId", 'CASH_' || m."movementType"::text, 'CASH', SUM(m."amountCents")::bigint
        FROM "cash_movements" m JOIN "cash_sessions" cs ON cs."id" = m."cashSessionId"
       WHERE m."organizationId" = ${this.organizationId}::uuid
         AND m."businessDate" >= ${from}::date AND m."businessDate" < ${to}::date
       GROUP BY 1, 2, 3, 4
      UNION ALL
      SELECT cs."businessDate", cs."branchId", 'CASH_VARIANCE', 'CASH', cs."varianceCents"::bigint
        FROM "cash_sessions" cs
       WHERE cs."organizationId" = ${this.organizationId}::uuid
         AND cs."status" <> 'OPEN' AND cs."varianceCents" IS NOT NULL AND cs."varianceCents" <> 0
         AND cs."businessDate" >= ${from}::date AND cs."businessDate" < ${to}::date
    `;
  }

  /** Cada movimiento de UN día, con quién y a quién, del más reciente al más viejo. */
  async delDia(day: Date): Promise<Movimiento[]> {
    const rows = await this.db.$queryRaw<Array<Omit<Movimiento, 'memberName' | 'memberCode' | 'userName'> & { userId: string | null }>>`
      SELECT p."id", p."receivedAt" AS at, p."businessDate" AS day, COALESCE(p."branchId", mb."homeBranchId") AS "branchId",
             CASE WHEN p."method" = 'CREDIT_NOTE' THEN 'CREDIT_NOTE'
                  WHEN p."amountCents" < 0 THEN 'REFUND' ELSE 'PAYMENT' END AS kind,
             p."method"::text AS method, p."amountCents", p."reversalReason" AS concept, p."folio",
             p."memberId", p."createdByUserId" AS "userId"
        FROM "payments" p JOIN "members" mb ON mb."id" = p."memberId"
       WHERE p."organizationId" = ${this.organizationId}::uuid
         AND p."status" IN ('SUCCEEDED','REVERSED')
         AND p."businessDate" = ${day}::date
      UNION ALL
      SELECT s."id", COALESCE(s."voidedAt", s."soldAt"), s."businessDate", s."branchId",
             CASE WHEN s."status" = 'VOIDED' THEN 'POS_VOID' ELSE 'POS_SALE' END,
             s."method"::text, CASE WHEN s."status" = 'VOIDED' THEN 0::bigint ELSE s."totalCents" END,
             s."voidReason", s."folio", s."memberId",
             CASE WHEN s."status" = 'VOIDED' THEN s."voidedByUserId" ELSE s."soldByUserId" END
        FROM "pos_sales" s
       WHERE s."organizationId" = ${this.organizationId}::uuid
         AND s."method" IS NOT NULL AND s."businessDate" = ${day}::date
      UNION ALL
      -- Bloque 3.5 (D-13; edición puntual): la devolución de una venta de tienda, el día en que se hizo.
      SELECT r."id", r."createdAt", r."businessDate", r."branchId", 'REFUND', r."method"::text, -r."amountCents",
             'Devolución de venta de tienda: ' || r."reason", s."folio", s."memberId", r."createdByUserId"
        FROM "pos_sale_returns" r JOIN "pos_sales" s ON s."id" = r."posSaleId"
       WHERE r."organizationId" = ${this.organizationId}::uuid AND r."businessDate" = ${day}::date
      UNION ALL
      SELECT m."id", m."at", m."businessDate", cs."branchId", 'CASH_' || m."movementType"::text, 'CASH',
             m."amountCents", m."reason", NULL, NULL, m."createdByUserId"
        FROM "cash_movements" m JOIN "cash_sessions" cs ON cs."id" = m."cashSessionId"
       WHERE m."organizationId" = ${this.organizationId}::uuid AND m."businessDate" = ${day}::date
      UNION ALL
      SELECT cs."id", cs."closedAt", cs."businessDate", cs."branchId", 'CASH_VARIANCE', 'CASH',
             cs."varianceCents", cs."varianceReason", NULL, NULL, cs."closedByUserId"
        FROM "cash_sessions" cs
       WHERE cs."organizationId" = ${this.organizationId}::uuid AND cs."status" <> 'OPEN'
         AND cs."varianceCents" IS NOT NULL AND cs."varianceCents" <> 0 AND cs."businessDate" = ${day}::date
       ORDER BY 2 DESC
    `;

    const socios = [...new Set(rows.map((r) => r.memberId).filter((x): x is string => !!x))];
    const usuarios = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
    const [ms, us] = await Promise.all([
      socios.length ? this.db.member.findMany({ where: { organizationId: this.organizationId, id: { in: socios } }, select: { id: true, firstName: true, lastName: true, memberCode: true } }) : [],
      usuarios.length ? this.db.user.findMany({ where: { id: { in: usuarios } }, select: { id: true, fullName: true } }) : [],
    ]);
    const socio = new Map(ms.map((m) => [m.id, m]));
    const usuario = new Map(us.map((u) => [u.id, u.fullName]));
    return rows.map(({ userId, ...r }) => {
      const m = r.memberId ? socio.get(r.memberId) : undefined;
      return {
        ...r,
        memberName: m ? `${m.firstName} ${m.lastName}` : null,
        memberCode: m?.memberCode ?? null,
        userName: userId ? usuario.get(userId) ?? null : null,
      };
    });
  }
}
