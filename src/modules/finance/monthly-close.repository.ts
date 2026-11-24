import { uuidv7 } from '@gymflow/core';
import type { MonthlyClose, TotalesDelCierre } from '@gymflow/core/contracts';
import { Prisma } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

export type MonthlyCloseRecord = {
  id: string; month: Date; totals: TotalesDelCierre; byBranch: MonthlyClose['byBranch'];
  closedByUserId: string; approvedByUserId: string | null; closedAt: Date; note: string | null;
};

const SELECT = { id: true, month: true, totals: true, byBranch: true, closedByUserId: true, approvedByUserId: true, closedAt: true, note: true } as const;

/**
 * CIERRE DE MES (fase 4; auditoría 8, bloque 1.9): la foto que firma el
 * dueño. Append-only: un mes cerrado no se reescribe. La fila dice quién
 * cerró y quién firmó (14-04); el asiento de bitácora se escribe en la misma
 * transacción (13-19), desde `MonthlyCloseService`.
 */
export class MonthlyCloseRepository extends TenantRepository {
  async create(input: {
    month: Date; totals: TotalesDelCierre; byBranch: MonthlyClose['byBranch'];
    closedByUserId: string; approvedByUserId: string | null; note: string | null;
  }): Promise<MonthlyCloseRecord> {
    const row = await this.db.monthlyClose.create({
      data: {
        id: uuidv7(), organizationId: this.organizationId, month: input.month,
        totals: input.totals as Prisma.InputJsonValue, byBranch: input.byBranch as Prisma.InputJsonValue,
        closedByUserId: input.closedByUserId, approvedByUserId: input.approvedByUserId, note: input.note,
      },
      select: SELECT,
    });
    return row as unknown as MonthlyCloseRecord;
  }

  async find(month: Date): Promise<MonthlyCloseRecord | null> {
    return this.db.monthlyClose.findFirst({ where: this.scope({ month }), select: SELECT }) as unknown as Promise<MonthlyCloseRecord | null>;
  }

  async list(limit = 24): Promise<MonthlyCloseRecord[]> {
    return this.db.monthlyClose.findMany({ where: this.scope({}), select: SELECT, orderBy: { month: 'desc' }, take: limit }) as unknown as Promise<MonthlyCloseRecord[]>;
  }

  /** Los nombres de quienes cerraron y firmaron, para decirlos sin ir a la bitácora. */
  async nombres(userIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const filas = await this.db.user.findMany({ where: { organizationId: this.organizationId, id: { in: ids } }, select: { id: true, fullName: true } });
    return new Map(filas.map((u) => [u.id, u.fullName]));
  }

  /** Las sucursales abiertas, con su zona (null = la del gimnasio): «hoy» se cuenta en cada una. */
  async sedesVivas(): Promise<Array<{ id: string; name: string; timezone: string | null }>> {
    return this.db.branch.findMany({ where: this.scope({ isActive: true }), select: { id: true, name: true, timezone: true }, orderBy: { code: 'asc' } });
  }

  /** Cajas de ese mes (por fecha de negocio) que siguen abiertas: la foto no las incluye. */
  async cajasAbiertasDelMes(from: Date, to: Date): Promise<Array<{ id: string; branchId: string; registerCode: string; openedAt: Date }>> {
    return this.db.$queryRaw`
      SELECT s."id", s."branchId", r."code" AS "registerCode", s."openedAt"
        FROM "cash_sessions" s
        JOIN "cash_registers" r ON r."id" = s."cashRegisterId"
       WHERE s."organizationId" = ${this.organizationId}::uuid AND s."status" = 'OPEN'
         AND s."businessDate" >= ${from} AND s."businessDate" < ${to}
       ORDER BY s."openedAt" ASC`;
  }

  /** El primer mes con dinero (fecha de negocio del primer cobro): desde ahí hay meses que cerrar. */
  async primerMesConMovimiento(): Promise<Date | null> {
    const rows = await this.db.$queryRaw<Array<{ primero: Date | null }>>`
      SELECT date_trunc('month', MIN("businessDate"))::date AS primero
        FROM "payments"
       WHERE "organizationId" = ${this.organizationId}::uuid AND "status" = 'SUCCEEDED'`;
    return rows[0]?.primero ?? null;
  }

  /** Los cierres cuyo mes cae en `[from, to)`: para decir «octubre está cerrado» en un periodo que lo toca. */
  async cerradosEntre(from: Date, to: Date): Promise<MonthlyCloseRecord[]> {
    const primerMes = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    return this.db.monthlyClose.findMany({ where: this.scope({ month: { gte: primerMes, lt: to } }), select: SELECT, orderBy: { month: 'asc' } }) as unknown as Promise<MonthlyCloseRecord[]>;
  }

  /** El mes cerrado en el que cae esa fecha de negocio, o null. */
  async cierreDe(fecha: Date): Promise<MonthlyCloseRecord | null> {
    return this.find(new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), 1)));
  }
}
