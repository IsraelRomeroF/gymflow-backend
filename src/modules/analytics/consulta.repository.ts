import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * LO QUE LA DUEÑA CONSULTA SIN OPERAR (3.7 · D-25): la tienda en cifras y el
 * resumen de a quién toca lo que va a firmar. Solo lee, como todo `analytics`,
 * y nunca devuelve un nombre de socio.
 */
export class ConsultaRepository extends TenantRepository {
  /** Ventas cobradas (y anuladas) de la tienda en `[from, to)`, por fecha de negocio. */
  async ventas(from: Date, to: Date, sedes: readonly string[] | null): Promise<{ sales: number; totalCents: bigint; voided: number }> {
    const [r] = await this.db.$queryRaw<Array<{ sales: number; totalCents: bigint; voided: number }>>`
      SELECT COUNT(*) FILTER (WHERE s."status" = 'COMPLETED')::int AS "sales",
             COALESCE(SUM(s."totalCents") FILTER (WHERE s."status" = 'COMPLETED'), 0)::bigint AS "totalCents",
             COUNT(*) FILTER (WHERE s."status" = 'VOIDED')::int AS "voided"
        FROM "pos_sales" s
       WHERE s."organizationId" = ${this.organizationId}::uuid
         AND s."businessDate" >= ${from}::date AND s."businessDate" < ${to}::date
         AND (${sedes === null} OR s."branchId" = ANY(${(sedes ?? []) as string[]}::uuid[]))`;
    return r ?? { sales: 0, totalCents: 0n, voided: 0 };
  }

  /** Lo más vendido en `[from, to)`, por importe. */
  async masVendido(from: Date, to: Date, sedes: readonly string[] | null, limite = 8): Promise<Array<{ productId: string; name: string; quantity: number; totalCents: bigint }>> {
    return this.db.$queryRaw`
      SELECT p."id" AS "productId", p."name", SUM(l."quantity")::int AS "quantity", SUM(l."lineTotalCents")::bigint AS "totalCents"
        FROM "pos_sale_lines" l
        JOIN "pos_sales" s ON s."id" = l."posSaleId"
        JOIN "products" p ON p."id" = l."productId"
       WHERE s."organizationId" = ${this.organizationId}::uuid AND s."status" = 'COMPLETED'
         AND s."businessDate" >= ${from}::date AND s."businessDate" < ${to}::date
         AND (${sedes === null} OR s."branchId" = ANY(${(sedes ?? []) as string[]}::uuid[]))
       GROUP BY p."id", p."name"
       ORDER BY 4 DESC, p."name" ASC
       LIMIT ${limite}`;
  }

  /** Existencias de los productos activos que llevan inventario, de menos a más. */
  async existencias(sedes: readonly string[] | null, limite = 40): Promise<Array<{ productId: string; branchId: string; name: string; stock: number }>> {
    return this.db.$queryRaw`
      SELECT p."id" AS "productId", st."branchId", p."name", st."quantityOnHand" AS "stock"
        FROM "inventory_stock" st
        JOIN "products" p ON p."id" = st."productId"
        JOIN "branches" b ON b."id" = st."branchId" AND b."isActive" AND b."deletedAt" IS NULL
       WHERE st."organizationId" = ${this.organizationId}::uuid
         AND p."isActive" AND p."deletedAt" IS NULL AND p."tracksInventory"
         AND (${sedes === null} OR st."branchId" = ANY(${(sedes ?? []) as string[]}::uuid[]))
       ORDER BY st."quantityOnHand" ASC, p."name" ASC
       LIMIT ${limite}`;
  }

  /** Productos activos y cuántos están agotados (en alguna de esas sedes). */
  async productos(sedes: readonly string[] | null): Promise<{ active: number; outOfStock: number }> {
    const [r] = await this.db.$queryRaw<Array<{ active: number; outOfStock: number }>>`
      SELECT COUNT(*)::int AS "active",
             COUNT(*) FILTER (WHERE p."tracksInventory" AND EXISTS (
               SELECT 1 FROM "inventory_stock" st JOIN "branches" b ON b."id" = st."branchId" AND b."isActive" AND b."deletedAt" IS NULL
                WHERE st."productId" = p."id" AND st."quantityOnHand" = 0
                  AND (${sedes === null} OR st."branchId" = ANY(${(sedes ?? []) as string[]}::uuid[]))
             ))::int AS "outOfStock"
        FROM "products" p
       WHERE p."organizationId" = ${this.organizationId}::uuid AND p."isActive" AND p."deletedAt" IS NULL`;
    return r ?? { active: 0, outOfStock: 0 };
  }

  /**
   * A qué socio toca la operación que se firma: el registro de la solicitud
   * (un cobro, un cargo, una membresía, un paquete o el socio mismo). `null`
   * si el registro no es de este gimnasio o no es de un socio (caja, cierre).
   */
  async socioDeLaOperacion(resourceType: string, resourceId: string): Promise<{ id: string; homeBranchId: string | null; createdAt: Date } | null> {
    const tabla = ({ Payment: 'payments', Charge: 'charges', Membership: 'memberships', VisitPack: 'visit_packs' } as Record<string, string>)[resourceType];
    let memberId: string | null = resourceType === 'Member' ? resourceId : null;
    if (tabla) {
      // `tabla` sale de la lista cerrada de arriba, nunca de lo que llegó.
      const filas = await this.db.$queryRawUnsafe<Array<{ memberId: string }>>(
        `SELECT "memberId" FROM "${tabla}" WHERE "organizationId" = $1::uuid AND "id" = $2::uuid LIMIT 1`, this.organizationId, resourceId);
      memberId = filas[0]?.memberId ?? null;
    }
    if (!memberId) return null;
    return this.db.member.findFirst({ where: { organizationId: this.organizationId, id: memberId }, select: { id: true, homeBranchId: true, createdAt: true } });
  }

  /** Lo que debe hoy un socio (y cuánto de eso ya venció), con la definición de la cartera. */
  async deudaDelSocio(memberId: string, hoy: Date): Promise<{ outstandingCents: bigint; overdueCents: bigint }> {
    const [r] = await this.db.$queryRaw<Array<{ outstandingCents: bigint; overdueCents: bigint }>>`
      SELECT COALESCE(SUM(c."amountCents" - c."allocatedCents" - c."adjustedCents"), 0)::bigint AS "outstandingCents",
             COALESCE(SUM(c."amountCents" - c."allocatedCents" - c."adjustedCents") FILTER (WHERE c."dueDate" < ${hoy}::date), 0)::bigint AS "overdueCents"
        FROM "charges" c
       WHERE c."organizationId" = ${this.organizationId}::uuid AND c."memberId" = ${memberId}::uuid
         AND c."status" IN ('OPEN','PARTIALLY_PAID','OVERDUE')`;
    return r ?? { outstandingCents: 0n, overdueCents: 0n };
  }

  /**
   * Correcciones de dinero en la cuenta de un socio: cobros revertidos o
   * devueltos, cargos anulados y cargos con descuento o condonación. Cuántas
   * en total y cuántas desde `desde`.
   */
  async correccionesDelSocio(memberId: string, desde: Date): Promise<{ total: number; recientes: number }> {
    const [r] = await this.db.$queryRaw<Array<{ total: number; recientes: number }>>`
      SELECT COUNT(*)::int AS "total", COUNT(*) FILTER (WHERE t."cuando" >= ${desde})::int AS "recientes"
        FROM (
          SELECT p."receivedAt" AS "cuando" FROM "payments" p
           WHERE p."organizationId" = ${this.organizationId}::uuid AND p."memberId" = ${memberId}::uuid AND p."amountCents" < 0
          UNION ALL
          SELECT c."updatedAt" FROM "charges" c
           WHERE c."organizationId" = ${this.organizationId}::uuid AND c."memberId" = ${memberId}::uuid
             AND (c."status" = 'VOID' OR c."adjustedCents" > 0)
        ) t`;
    return { total: r?.total ?? 0, recientes: r?.recientes ?? 0 };
  }
}
