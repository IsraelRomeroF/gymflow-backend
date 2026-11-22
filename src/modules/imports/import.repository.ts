import { uuidv7, type DatoDudoso } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { Prisma } from '@gymflow/db';

export type ImportKind = 'NEW' | 'MATCH' | 'REVIEW' | 'FILE_DUP' | 'INVALID';
export type ImportDecision = 'PENDING' | 'CREATE' | 'MERGE' | 'SKIP';
/** Qué se decidió con los datos dudosos de una fila (D18-02). */
export type DataStatus = 'PENDING' | 'WITHOUT' | 'FIXED';

export type ImportRecord = {
  id: string; branchId: string; fileName: string; status: string; cutoffDate: Date;
  planMap: Record<string, string | null>; branchMap: Record<string, string | null>;
  totalRows: number; createdByUserId: string; createdAt: Date; appliedAt: Date | null; canceledAt: Date | null; reason: string | null;
};

export type ImportRowRecord = {
  id: string; rowNumber: number; raw: Record<string, unknown>;
  firstName: string; lastName: string; phoneE164: string | null; email: string | null; curp: string | null;
  birthDate: Date | null; joinedAt: Date | null; periodEnd: Date | null;
  legacyCode: string | null; branchLabel: string | null; planLabel: string | null; notes: string | null;
  balanceCents: bigint | null; problems: string[];
  kind: ImportKind; matchMemberId: string | null; matchRowId: string | null; matchScore: number | null; matchReason: string | null;
  decision: ImportDecision; decidedByUserId: string | null; decidedAt: Date | null;
  appliedMemberId: string | null; appliedAt: Date | null; applyNote: string | null;
  balanceLoadedCents: bigint | null;
  doubtful: DatoDudoso[]; dataStatus: DataStatus | null; dataDecidedByUserId: string | null; dataDecidedAt: Date | null;
};

export type NewImportRow = Omit<ImportRowRecord,
  'id' | 'decidedByUserId' | 'decidedAt' | 'appliedMemberId' | 'appliedAt' | 'applyNote' | 'balanceLoadedCents' | 'dataDecidedByUserId' | 'dataDecidedAt'
> & { id?: string };

/** Un saldo inicial que un socio ya recibió por una importación (D18-01). */
export type SaldoCargado = {
  id: string; importId: string; rowNumber: number; branchLabel: string | null; legacyCode: string | null;
  balanceLoadedCents: bigint; appliedAt: Date;
};

/** Etiqueta con la que se guardan en `planMap` las vigencias que el archivo trae sin plan. */
export const SIN_PLAN = '';

const IMPORT_SELECT = {
  id: true, branchId: true, fileName: true, status: true, cutoffDate: true, planMap: true, branchMap: true,
  totalRows: true, createdByUserId: true, createdAt: true, appliedAt: true, canceledAt: true, reason: true,
} as const;

/** Tablas `member_imports` y `member_import_rows`: la importación en revisión, antes de tocar el padrón. */
export class MemberImportRepository extends TenantRepository {
  async create(input: { fileName: string; branchId: string; cutoffDate: Date; totalRows: number; createdByUserId: string; branchMap: Record<string, string | null> }): Promise<string> {
    const id = uuidv7();
    await this.db.memberImport.create({
      data: {
        id, organizationId: this.organizationId, fileName: input.fileName, branchId: input.branchId,
        cutoffDate: input.cutoffDate, totalRows: input.totalRows, createdByUserId: input.createdByUserId, branchMap: input.branchMap,
      },
    });
    return id;
  }

  async insertRows(importId: string, rows: NewImportRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 1000) {
      await this.db.memberImportRow.createMany({
        data: rows.slice(i, i + 1000).map((r) => ({
          ...r, id: r.id ?? uuidv7(), organizationId: this.organizationId, importId,
          raw: r.raw as Prisma.InputJsonValue, problems: r.problems as Prisma.InputJsonValue,
          doubtful: r.doubtful as unknown as Prisma.InputJsonValue,
        })),
      });
    }
  }

  async find(id: string): Promise<ImportRecord | null> {
    return this.db.memberImport.findFirst({ where: this.scope({ id }), select: IMPORT_SELECT }) as Promise<ImportRecord | null>;
  }

  async list(limit = 30): Promise<ImportRecord[]> {
    return this.db.memberImport.findMany({ where: this.scope({}), select: IMPORT_SELECT, orderBy: { createdAt: 'desc' }, take: limit }) as Promise<ImportRecord[]>;
  }

  /**
   * Cuántas filas hay por tipo, por decisión y ya aplicadas. `dataPending`:
   * filas con datos dudosos sin decidir (las omitidas no cuentan). Los saldos:
   * cuántas filas cargaron el suyo y cuántas no lo volvieron a cargar porque
   * el socio ya lo tenía (D18-01).
   */
  async counts(importId: string): Promise<{
    byKind: Record<string, number>; byDecision: Record<string, number>; byData: Record<string, number>;
    applied: number; pendingApply: number; dataPending: number; balancesLoaded: number; balancesNotReloaded: number;
  }> {
    const [k, d, datos, applied, pendingApply, dataPending, balancesLoaded, balancesNotReloaded] = await Promise.all([
      this.db.memberImportRow.groupBy({ by: ['kind'], where: this.scope({ importId }), _count: { _all: true } }),
      this.db.memberImportRow.groupBy({ by: ['decision'], where: this.scope({ importId }), _count: { _all: true } }),
      this.db.memberImportRow.groupBy({ by: ['dataStatus'], where: this.scope({ importId, dataStatus: { not: null } }), _count: { _all: true } }),
      this.db.memberImportRow.count({ where: this.scope({ importId, appliedAt: { not: null } }) }),
      this.db.memberImportRow.count({ where: this.scope({ importId, appliedAt: null, decision: { in: ['CREATE', 'MERGE'] } }) }),
      this.db.memberImportRow.count({ where: this.scope({ importId, dataStatus: 'PENDING', decision: { not: 'SKIP' } }) }),
      this.db.memberImportRow.count({ where: this.scope({ importId, balanceLoadedCents: { not: null } }) }),
      this.db.memberImportRow.count({ where: this.scope({ importId, appliedAt: { not: null }, decision: { not: 'SKIP' }, balanceCents: { not: null }, balanceLoadedCents: null }) }),
    ]);
    return {
      byKind: Object.fromEntries(k.map((x) => [x.kind, x._count._all])),
      byDecision: Object.fromEntries(d.map((x) => [x.decision, x._count._all])),
      byData: Object.fromEntries(datos.map((x) => [x.dataStatus ?? '', x._count._all])),
      applied, pendingApply, dataPending, balancesLoaded, balancesNotReloaded,
    };
  }

  /**
   * Las sumas de dinero y de vigencias de lo que ENTRA (altas y uniones), para
   * el resumen que se coteja con el reporte de cartera (18-04). `hoy` es la
   * fecha de negocio: una vigencia que ya pasó no crea membresía.
   */
  async money(importId: string, hoy: Date): Promise<{
    debtCents: bigint; debtRows: number; creditCents: bigint; creditRows: number;
    expired: number; unreadBalances: number; loadedDebtCents: bigint; loadedCreditCents: bigint;
    vigentesPorPlan: Array<{ label: string; n: number }>;
  }> {
    const [sumas, vigentesPorPlan] = await Promise.all([
      this.db.$queryRaw<Array<{
        debt: bigint | null; debt_rows: number; credit: bigint | null; credit_rows: number; expired: number; unread: number;
        loaded_debt: bigint | null; loaded_credit: bigint | null;
      }>>`
        SELECT COALESCE(SUM("balanceCents") FILTER (WHERE "balanceCents" > 0), 0)::bigint AS debt,
               COUNT(*) FILTER (WHERE "balanceCents" > 0)::int AS debt_rows,
               COALESCE(SUM(-"balanceCents") FILTER (WHERE "balanceCents" < 0), 0)::bigint AS credit,
               COUNT(*) FILTER (WHERE "balanceCents" < 0)::int AS credit_rows,
               COUNT(*) FILTER (WHERE "periodEnd" IS NOT NULL AND "periodEnd" < ${hoy}::date)::int AS expired,
               COUNT(*) FILTER (WHERE "dataStatus" IN ('PENDING', 'WITHOUT') AND doubtful @> '[{"field":"balance"}]'::jsonb)::int AS unread,
               COALESCE(SUM("balanceLoadedCents") FILTER (WHERE "balanceLoadedCents" > 0), 0)::bigint AS loaded_debt,
               COALESCE(SUM(-"balanceLoadedCents") FILTER (WHERE "balanceLoadedCents" < 0), 0)::bigint AS loaded_credit
          FROM member_import_rows
         WHERE "organizationId" = ${this.organizationId}::uuid AND "importId" = ${importId}::uuid AND decision IN ('CREATE', 'MERGE')`,
      this.db.$queryRaw<Array<{ label: string; n: number }>>`
        SELECT COALESCE("planLabel", '') AS label, COUNT(*)::int AS n
          FROM member_import_rows
         WHERE "organizationId" = ${this.organizationId}::uuid AND "importId" = ${importId}::uuid AND decision IN ('CREATE', 'MERGE')
           AND "periodEnd" IS NOT NULL AND "periodEnd" >= ${hoy}::date
         GROUP BY 1`,
    ]);
    const s = sumas[0]!;
    return {
      debtCents: s.debt ?? 0n, debtRows: s.debt_rows, creditCents: s.credit ?? 0n, creditRows: s.credit_rows,
      expired: s.expired, unreadBalances: s.unread, loadedDebtCents: s.loaded_debt ?? 0n, loadedCreditCents: s.loaded_credit ?? 0n,
      vigentesPorPlan,
    };
  }

  /**
   * Planes y sucursales del archivo, con cuántas filas trae cada uno: para
   * asignarlos. Las vigencias que vienen SIN plan se agrupan con la etiqueta
   * `SIN_PLAN` (''), que ningún plan del archivo puede tener: también piden
   * una decisión (18-03).
   */
  async labels(importId: string): Promise<{ plans: Array<{ label: string; rows: number; vigentes: number }>; branches: Array<{ label: string; rows: number }> }> {
    const [plans, branches] = await Promise.all([
      this.db.$queryRaw<Array<{ label: string; rows: number; vigentes: number }>>`
        SELECT COALESCE("planLabel", '') AS label, COUNT(*)::int AS rows,
               COUNT(*) FILTER (WHERE "periodEnd" IS NOT NULL)::int AS vigentes
          FROM member_import_rows
         WHERE "organizationId" = ${this.organizationId}::uuid AND "importId" = ${importId}::uuid
           AND ("planLabel" IS NOT NULL OR "periodEnd" IS NOT NULL) AND decision <> 'SKIP'
         GROUP BY 1 ORDER BY 2 DESC`,
      this.db.$queryRaw<Array<{ label: string; rows: number }>>`
        SELECT "branchLabel" AS label, COUNT(*)::int AS rows
          FROM member_import_rows
         WHERE "organizationId" = ${this.organizationId}::uuid AND "importId" = ${importId}::uuid AND "branchLabel" IS NOT NULL
         GROUP BY 1 ORDER BY 2 DESC`,
    ]);
    return { plans, branches };
  }

  async rows(importId: string, opts: { kinds?: ImportKind[]; decisions?: ImportDecision[]; data?: DataStatus[]; q?: string; after?: number; limit: number }): Promise<ImportRowRecord[]> {
    const q = opts.q?.trim();
    return this.db.memberImportRow.findMany({
      where: this.scope({
        importId,
        ...(opts.kinds?.length ? { kind: { in: opts.kinds } } : {}),
        ...(opts.decisions?.length ? { decision: { in: opts.decisions } } : {}),
        ...(opts.data?.length ? { dataStatus: { in: opts.data } } : {}),
        ...(opts.after ? { rowNumber: { gt: opts.after } } : {}),
        ...(q ? { OR: [
          { firstName: { contains: q, mode: 'insensitive' as const } },
          { lastName: { contains: q, mode: 'insensitive' as const } },
          { legacyCode: { equals: q } },
          { phoneE164: { contains: q.replace(/\D/g, '') || q } },
        ] } : {}),
      }),
      orderBy: { rowNumber: 'asc' },
      take: opts.limit,
    }) as unknown as Promise<ImportRowRecord[]>;
  }

  async row(importId: string, rowId: string): Promise<ImportRowRecord | null> {
    return this.db.memberImportRow.findFirst({ where: this.scope({ importId, id: rowId }) }) as unknown as Promise<ImportRowRecord | null>;
  }

  async rowsByIds(importId: string, ids: string[]): Promise<ImportRowRecord[]> {
    if (ids.length === 0) return [];
    return this.db.memberImportRow.findMany({ where: this.scope({ importId, id: { in: ids } }) }) as unknown as Promise<ImportRowRecord[]>;
  }

  /** Solo cambia filas que todavía no se aplicaron. */
  async decide(importId: string, rowId: string, decision: ImportDecision, userId: string, matchMemberId?: string | null): Promise<boolean> {
    const { count } = await this.db.memberImportRow.updateMany({
      where: this.scope({ importId, id: rowId, appliedAt: null }),
      data: { decision, decidedByUserId: userId, decidedAt: new Date(), ...(matchMemberId !== undefined ? { matchMemberId } : {}) },
    });
    return count === 1;
  }

  /**
   * Decisión sobre los datos dudosos de una fila sin aplicar: deja cada dato
   * dudoso con el valor que corresponde (null = sin ese dato) y quién decidió.
   */
  async decideData(importId: string, rowId: string, status: Exclude<DataStatus, 'PENDING'>, userId: string, values: {
    balanceCents?: bigint | null; periodEnd?: Date | null; joinedAt?: Date | null;
  }): Promise<boolean> {
    const { count } = await this.db.memberImportRow.updateMany({
      where: this.scope({ importId, id: rowId, appliedAt: null, dataStatus: { not: null } }),
      data: { ...values, dataStatus: status, dataDecidedByUserId: userId, dataDecidedAt: new Date() },
    });
    return count === 1;
  }

  /** Decisión en bloque sobre las filas de un tipo que siguen con la decisión `from`. */
  async decideAll(importId: string, kind: ImportKind, from: ImportDecision[], decision: ImportDecision, userId: string): Promise<number> {
    const { count } = await this.db.memberImportRow.updateMany({
      where: this.scope({ importId, kind, decision: { in: from }, appliedAt: null }),
      data: { decision, decidedByUserId: userId, decidedAt: new Date() },
    });
    return count;
  }

  async setMaps(importId: string, maps: { planMap?: Record<string, string | null>; branchMap?: Record<string, string | null> }): Promise<void> {
    await this.db.memberImport.updateMany({
      where: this.scope({ id: importId, status: 'REVIEW' }),
      data: { ...(maps.planMap ? { planMap: maps.planMap } : {}), ...(maps.branchMap ? { branchMap: maps.branchMap } : {}) },
    });
  }

  /** Las siguientes filas por aplicar, en orden de renglón: la principal antes que sus repetidas. */
  async nextToApply(importId: string, limit: number): Promise<ImportRowRecord[]> {
    return this.db.memberImportRow.findMany({
      where: this.scope({ importId, appliedAt: null, decision: { in: ['CREATE', 'MERGE'] } }),
      orderBy: { rowNumber: 'asc' }, take: limit,
    }) as unknown as Promise<ImportRowRecord[]>;
  }

  /**
   * Aparta la fila para aplicarla en la transacción en curso. Dos «Aplicar» a
   * la vez (doble clic, dos pestañas) leen el mismo lote: el segundo espera
   * aquí a que el primero confirme y entonces ve la fila ya aplicada. Sin
   * esto, los dos creaban la ficha y cargaban el saldo.
   */
  async claim(rowId: string): Promise<boolean> {
    const filas = await this.db.$queryRaw<Array<{ appliedAt: Date | null }>>`
      SELECT "appliedAt" FROM member_import_rows
       WHERE "organizationId" = ${this.organizationId}::uuid AND id = ${rowId}::uuid
       FOR UPDATE`;
    return filas.length === 1 && filas[0]!.appliedAt === null;
  }

  /**
   * Un saldo inicial a la vez por socio, hasta que la transacción confirme:
   * dos importaciones que aplican al mismo socio no cargan las dos su saldo.
   */
  async lockMemberBalance(memberId: string): Promise<void> {
    await this.db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`import-opening:${this.organizationId}:${memberId}`}, 0))`;
  }

  /** Los saldos iniciales que el socio ya recibió por importaciones (de cualquier archivo). */
  async loadedBalancesOf(memberId: string): Promise<SaldoCargado[]> {
    return this.db.memberImportRow.findMany({
      where: this.scope({ appliedMemberId: memberId, balanceLoadedCents: { not: null } }),
      select: { id: true, importId: true, rowNumber: true, branchLabel: true, legacyCode: true, balanceLoadedCents: true, appliedAt: true },
      orderBy: { appliedAt: 'asc' },
    }) as unknown as Promise<SaldoCargado[]>;
  }

  async markApplied(rowId: string, memberId: string, note: string | null, balanceLoadedCents: bigint | null): Promise<void> {
    await this.db.memberImportRow.updateMany({
      where: this.scope({ id: rowId, appliedAt: null }),
      data: { appliedMemberId: memberId, appliedAt: new Date(), applyNote: note, balanceLoadedCents },
    });
  }

  async appliedMemberOf(rowId: string): Promise<string | null> {
    const r = await this.db.memberImportRow.findFirst({ where: this.scope({ id: rowId }), select: { appliedMemberId: true, decision: true } });
    return r?.appliedMemberId ?? null;
  }

  /** Cierra la importación. Devuelve si cambió: dos lotes que terminan juntos no la cierran (ni la asientan) dos veces. */
  async setStatus(importId: string, status: 'APPLIED' | 'CANCELED', userId: string, reason: string | null): Promise<boolean> {
    const { count } = await this.db.memberImport.updateMany({
      where: this.scope({ id: importId, status: 'REVIEW' }),
      data: status === 'APPLIED'
        ? { status, appliedAt: new Date(), appliedByUserId: userId, ...(reason ? { reason } : {}) }
        : { status, canceledAt: new Date(), ...(reason ? { reason } : {}) },
    });
    return count === 1;
  }
}
