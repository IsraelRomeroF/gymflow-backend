import { TenantRepository } from '../../platform/db/tenant-repository.js';
import type { AgingBucketKey } from '@gymflow/core';

/**
 * Cartera CONSOLIDADA (§18).
 *
 * Una sola cartera para toda la organización, no una por sucursal. Hoy el
 * dueño suma tres reportes a mano y por eso nunca sabe cuánto se le debe: la
 * consolidación es el entregable, no un extra.
 *
 * Todo se agrega en el MOTOR. Traer 4,000 cargos para sumarlos en memoria
 * funciona en desarrollo y se cae el día que la cartera crece.
 *
 * D-18 (fase 4, bloque 4.4): la cartera es LO COBRABLE. La deuda dada por
 * perdida (`charges.lostOn`: su membresía llevó suspendida el plazo del
 * gimnasio) no entra en el total, en lo vencido, en los tramos, en el reparto
 * por sede ni en la lista de deudores; se informa aparte (`lostCents`).
 *
 * D-12 (fase 4, bloque 4.11): la deuda de un socio DADO DE BAJA en su ficha
 * (`members.deletedAt`) SÍ cuenta. Dar de baja no borra lo que debe (3.5): sale
 * de «por cobrar» solo cuando se cobra, se condona con monto o se da por
 * perdida por plazo. Antes estas consultas filtraban a los socios vivos y la
 * deuda desaparecía de la cifra el día de la baja, sin que nadie lo decidiera.
 * (Otra cosa son las membresías VIVAS de socios dados de baja, que sí se
 * excluyen del ingreso recurrente: eso es `analytics.repository.ts`.)
 */

export type AgingRow = {
  bucket: AgingBucketKey | 'CURRENT';
  amountCents: bigint;
  charges: number;
  members: number;
};

export type BranchRow = {
  branchId: string | null;
  amountCents: bigint;
  members: number;
};

export type Portfolio = {
  totalOutstandingCents: bigint;
  overdueCents: bigint;
  membersWithDebt: number;
  /**
   * D-18 (bloque 4.4): la deuda dada por perdida (`charges.lostOn`). NO está en
   * ninguna de las cifras de arriba ni en los tramos: la cartera es lo
   * cobrable. Sigue en el estado de cuenta de cada socio y se puede cobrar.
   */
  lostCents: bigint;
  lostMembers: number;
  creditBalanceCents: bigint;
  byAging: AgingRow[];
  byBranch: BranchRow[];
};

/**
 * Tramos de antigüedad calculados en SQL.
 * `CURRENT` es deuda emitida que todavía no vence: no es morosidad y
 * mezclarla infla la cifra que el dueño usa para decidir.
 */
const BUCKET_SQL = `
  CASE
    WHEN c."dueDate" >= $2::date THEN 'CURRENT'
    WHEN $2::date - c."dueDate" <= 30 THEN '1-30'
    WHEN $2::date - c."dueDate" <= 60 THEN '31-60'
    WHEN $2::date - c."dueDate" <= 90 THEN '61-90'
    ELSE '90+'
  END`;

/** Una cifra de la lista de deudores (bloque 4.15). */
export type CifraRow = { outstandingCents: bigint; lostCents: bigint; members: number };

/** Toda la cartera de la consulta, partida en vivos / dados de baja / anonimizados, y lo que suma la lista. */
export type ResumenDeDeudores = { all: CifraRow; archived: CifraRow; anonymized: CifraRow; listed: CifraRow };

export type DeudorRow = {
  memberId: string; memberCode: string; fullName: string; homeBranchId: string | null; archived: boolean;
  outstandingCents: bigint; overdueCents: bigint; lostCents: bigint; oldestDueDate: Date; owedCents: bigint;
};

export class PortfolioRepository extends TenantRepository {
  async snapshot(today: Date, branchId?: string | null): Promise<Portfolio> {
    const filtroSucursal = branchId ? `AND c."branchId" = $3::uuid` : '';
    const params: unknown[] = [this.organizationId, today];
    if (branchId) params.push(branchId);

    const aging = await this.db.$queryRawUnsafe<Array<{
      bucket: string; amount: bigint; charges: bigint; members: bigint;
    }>>(`
      SELECT ${BUCKET_SQL} AS bucket,
             COALESCE(SUM(c."amountCents" - c."allocatedCents" - c."adjustedCents"), 0)::bigint AS amount,
             COUNT(*)::bigint AS charges,
             COUNT(DISTINCT c."memberId")::bigint AS members
      FROM "charges" c
      WHERE c."organizationId" = $1::uuid
        AND c."status" IN ('OPEN','PARTIALLY_PAID','OVERDUE')
        AND c."lostOn" IS NULL
        ${filtroSucursal}
      GROUP BY 1`, ...params);

    const porSucursal = await this.db.$queryRawUnsafe<Array<{
      branchId: string | null; amount: bigint; members: bigint;
    }>>(`
      SELECT c."branchId",
             COALESCE(SUM(c."amountCents" - c."allocatedCents" - c."adjustedCents"), 0)::bigint AS amount,
             COUNT(DISTINCT c."memberId")::bigint AS members
      FROM "charges" c
      WHERE c."organizationId" = $1::uuid
        AND c."status" IN ('OPEN','PARTIALLY_PAID','OVERDUE')
        AND c."lostOn" IS NULL
        AND $2::date IS NOT NULL
        ${filtroSucursal}
      GROUP BY c."branchId"
      ORDER BY amount DESC`, ...params);

    const totales = await this.db.$queryRawUnsafe<Array<{
      total: bigint; overdue: bigint; members: bigint;
    }>>(`
      SELECT COALESCE(SUM(c."amountCents" - c."allocatedCents" - c."adjustedCents"), 0)::bigint AS total,
             COALESCE(SUM(CASE WHEN c."dueDate" < $2::date
                               THEN c."amountCents" - c."allocatedCents" - c."adjustedCents"
                               ELSE 0 END), 0)::bigint AS overdue,
             COUNT(DISTINCT c."memberId")::bigint AS members
      FROM "charges" c
      WHERE c."organizationId" = $1::uuid
        AND c."status" IN ('OPEN','PARTIALLY_PAID','OVERDUE')
        AND c."lostOn" IS NULL
        ${filtroSucursal}`, ...params);

    // El saldo a favor NO se resta de la cartera: son dos cifras distintas y
    // netearlas escondería tanto la deuda real como el dinero por aplicar.
    const credito = await this.db.$queryRaw<Array<{ total: bigint | null }>>`
      SELECT COALESCE(SUM(
        CASE WHEN "amountCents" < 0 THEN -"unappliedCents" ELSE "unappliedCents" END
      ), 0)::bigint AS total
      FROM "payments"
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "status" IN ('SUCCEEDED','REVERSED')`;

    // Lo dado por perdido, aparte (también de socios dados de baja, como la cartera).
    const perdida = await this.db.$queryRawUnsafe<Array<{ total: bigint; members: bigint }>>(`
      SELECT COALESCE(SUM(c."amountCents" - c."allocatedCents" - c."adjustedCents"), 0)::bigint AS total,
             COUNT(DISTINCT c."memberId")::bigint AS members
      FROM "charges" c
      WHERE c."organizationId" = $1::uuid
        AND c."status" IN ('OPEN','PARTIALLY_PAID','OVERDUE')
        AND c."lostOn" IS NOT NULL
        AND $2::date IS NOT NULL
        ${filtroSucursal}`, ...params);

    const t = totales[0];
    return {
      totalOutstandingCents: t?.total ?? 0n,
      overdueCents: t?.overdue ?? 0n,
      membersWithDebt: Number(t?.members ?? 0n),
      lostCents: perdida[0]?.total ?? 0n,
      lostMembers: Number(perdida[0]?.members ?? 0n),
      creditBalanceCents: credito[0]?.total ?? 0n,
      byAging: aging.map((r) => ({
        bucket: r.bucket as AgingRow['bucket'],
        amountCents: r.amount,
        charges: Number(r.charges),
        members: Number(r.members),
      })),
      byBranch: porSucursal.map((r) => ({
        branchId: r.branchId,
        amountCents: r.amount,
        members: Number(r.members),
      })),
    };
  }

  /**
   * QUIÉN DEBE (bloque 4.15): por socio, lo que cuenta en «Por cobrar», lo
   * vencido, lo dado por perdido y el vencimiento más antiguo, con las mismas
   * reglas que `snapshot` (mismos estados, misma sede del CARGO, lo perdido
   * aparte). Los dados de baja entran si `incluirBajas`; las fichas
   * anonimizadas NUNCA salen como renglón: solo en `resumen` (no se dice de quién
   * es una deuda cuyo dueño ya no tiene nombre).
   *
   * Orden: lo que debe en total (cobrable + perdido), de más a menos, y el id
   * desempata; la página siguiente empieza después de `despuesDe`.
   */
  async debtors(opts: {
    today: Date; branchId: string | null; incluirBajas: boolean; limit: number;
    despuesDe?: { owedCents: bigint; memberId: string };
  }): Promise<{ resumen: ResumenDeDeudores; filas: DeudorRow[] }> {
    const params: unknown[] = [this.organizationId, opts.today];
    const filtroSucursal = opts.branchId ? `AND c."branchId" = $${params.push(opts.branchId)}::uuid` : '';
    const deudas = `
      WITH d AS (
        SELECT c."memberId",
               COALESCE(SUM(c."amountCents" - c."allocatedCents" - c."adjustedCents") FILTER (WHERE c."lostOn" IS NULL), 0)::bigint AS outstanding,
               COALESCE(SUM(c."amountCents" - c."allocatedCents" - c."adjustedCents") FILTER (WHERE c."lostOn" IS NULL AND c."dueDate" < $2::date), 0)::bigint AS overdue,
               COALESCE(SUM(c."amountCents" - c."allocatedCents" - c."adjustedCents") FILTER (WHERE c."lostOn" IS NOT NULL), 0)::bigint AS lost,
               MIN(c."dueDate") AS oldest
        FROM "charges" c
        WHERE c."organizationId" = $1::uuid
          AND c."status" IN ('OPEN','PARTIALLY_PAID','OVERDUE')
          ${filtroSucursal}
        GROUP BY c."memberId"
      )`;
    const categoria = `CASE WHEN m."anonymizedAt" IS NOT NULL THEN 'ANON' WHEN m."deletedAt" IS NOT NULL THEN 'BAJA' ELSE 'VIVO' END`;

    const porCategoria = await this.db.$queryRawUnsafe<Array<{ cat: string; outstanding: bigint; lost: bigint; members: bigint }>>(`
      ${deudas}
      SELECT ${categoria} AS cat,
             COALESCE(SUM(d.outstanding), 0)::bigint AS outstanding,
             COALESCE(SUM(d.lost), 0)::bigint AS lost,
             COUNT(*) FILTER (WHERE d.outstanding <> 0 OR d.lost <> 0)::bigint AS members
      FROM d JOIN "members" m ON m."id" = d."memberId" AND m."organizationId" = $1::uuid
      GROUP BY 1`, ...params);

    const filtroBajas = opts.incluirBajas ? '' : 'AND m."deletedAt" IS NULL';
    let filtroPagina = '';
    if (opts.despuesDe) {
      const owed = params.push(opts.despuesDe.owedCents);
      const id = params.push(opts.despuesDe.memberId);
      filtroPagina = `AND ((d.outstanding + d.lost) < $${owed}::bigint OR ((d.outstanding + d.lost) = $${owed}::bigint AND m."id" > $${id}::uuid))`;
    }
    const limite = params.push(opts.limit);
    const filas = await this.db.$queryRawUnsafe<DeudorRow[]>(`
      ${deudas}
      SELECT m."id" AS "memberId", m."memberCode",
             m."firstName" || ' ' || m."lastName" AS "fullName",
             m."homeBranchId", (m."deletedAt" IS NOT NULL) AS "archived",
             d.outstanding AS "outstandingCents", d.overdue AS "overdueCents", d.lost AS "lostCents",
             d.oldest AS "oldestDueDate", (d.outstanding + d.lost)::bigint AS "owedCents"
      FROM d JOIN "members" m ON m."id" = d."memberId" AND m."organizationId" = $1::uuid
      WHERE m."anonymizedAt" IS NULL
        AND (d.outstanding <> 0 OR d.lost <> 0)
        ${filtroBajas}
        ${filtroPagina}
      ORDER BY "owedCents" DESC, m."id" ASC
      LIMIT $${limite}`, ...params);

    const de = (cat: string): CifraRow => {
      const r = porCategoria.find((x) => x.cat === cat);
      return { outstandingCents: r?.outstanding ?? 0n, lostCents: r?.lost ?? 0n, members: Number(r?.members ?? 0n) };
    };
    const suma = (...cs: CifraRow[]): CifraRow => ({
      outstandingCents: cs.reduce((a, c) => a + c.outstandingCents, 0n),
      lostCents: cs.reduce((a, c) => a + c.lostCents, 0n),
      members: cs.reduce((a, c) => a + c.members, 0),
    });
    const vivos = de('VIVO'); const bajas = de('BAJA'); const anon = de('ANON');
    return {
      resumen: {
        all: suma(vivos, bajas, anon),
        archived: bajas,
        anonymized: anon,
        listed: opts.incluirBajas ? suma(vivos, bajas) : vivos,
      },
      filas,
    };
  }

  /** Socios con más deuda. Es la lista con la que se trabaja la cobranza. */
  async topDebtors(limit: number, branchId?: string | null): Promise<Array<{
    memberId: string; memberCode: string; fullName: string;
    branchId: string | null; outstandingCents: bigint; oldestDueDate: Date;
    /** Dado de baja en su ficha: sigue debiendo (D-12), pero ya no está en el padrón vivo. */
    archived: boolean;
  }>> {
    const filtro = branchId ? `AND c."branchId" = $3::uuid` : '';
    const params: unknown[] = [this.organizationId, limit];
    if (branchId) params.push(branchId);

    return this.db.$queryRawUnsafe(`
      SELECT m."id" AS "memberId", m."memberCode",
             m."firstName" || ' ' || m."lastName" AS "fullName",
             m."homeBranchId" AS "branchId", (m."deletedAt" IS NOT NULL) AS "archived",
             SUM(c."amountCents" - c."allocatedCents" - c."adjustedCents")::bigint AS "outstandingCents",
             MIN(c."dueDate") AS "oldestDueDate"
      FROM "charges" c
      JOIN "members" m ON m."id" = c."memberId"
      WHERE c."organizationId" = $1::uuid
        AND c."status" IN ('OPEN','PARTIALLY_PAID','OVERDUE')
        AND c."lostOn" IS NULL
        ${filtro}
      GROUP BY m."id", m."memberCode", m."firstName", m."lastName", m."homeBranchId", m."deletedAt"
      ORDER BY "outstandingCents" DESC
      LIMIT $2`, ...params);
  }
}
