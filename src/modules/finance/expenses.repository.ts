import { uuidv7 } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * «Retiro del dueño» (D-23): lo que la dueña se lleva del negocio. Se anota y
 * se ve en Movimientos, pero NO es un gasto: no resta de la ganancia ni de la
 * utilidad. Vive en la misma tabla para compartir mes, sucursal, anulación con
 * motivo y bitácora.
 */
export const RETIRO_DEL_DUENO = 'OWNER_DRAW';
export const CATEGORIAS_GASTO = ['RENT', 'PAYROLL', 'UTILITIES', 'SERVICES', 'MAINTENANCE', 'MARKETING', 'TAXES', 'OTHER', RETIRO_DEL_DUENO] as const;
export type CategoriaGasto = (typeof CATEGORIAS_GASTO)[number];

export type Gasto = {
  id: string; branchId: string | null; category: string; description: string; amountCents: bigint;
  periodMonth: Date; createdByUserId: string; createdAt: Date;
  voidedAt: Date | null; voidReason: string | null;
  /** «Ajuste de ‹mes›» (D-22): el mes cerrado al que corresponde; cuenta en `periodMonth`. */
  adjustsMonth: Date | null;
  /** El gasto del mes cerrado que este ajuste corrige (en negativo). */
  adjustsExpenseId: string | null;
  /** D-26 (4.5): un PAGO de nómina lleva su fecha y a quién. La nómina anotada antes como un total no los trae. */
  paidOn: Date | null;
  payeeUserId: string | null;
  payeeName: string | null;
  /** La propuesta (gasto que se repite y su fecha) de la que salió, si alguien la confirmó. */
  recurringId: string | null;
  recurringDue: Date | null;
};

const SELECT = {
  id: true, branchId: true, category: true, description: true, amountCents: true, periodMonth: true,
  createdByUserId: true, createdAt: true, voidedAt: true, voidReason: true, adjustsMonth: true, adjustsExpenseId: true,
  paidOn: true, payeeUserId: true, payeeName: true, recurringId: true, recurringDue: true,
} as const;

export const NOMINA = 'PAYROLL';
/**
 * ¿Es un pago de nómina A UNA PERSONA? Eso solo lo ve quien tiene Movimientos
 * (`expenses:payroll:read`, D-26). La nómina de antes, un total sin nombre, no.
 */
export const esPagoAPersona = (g: Pick<Gasto, 'payeeName'>): boolean => g.payeeName !== null;

/** ¿Resta de la ganancia? Todo menos el retiro del dueño. */
export const restaDeLaGanancia = (g: Pick<Gasto, 'category'>): boolean => g.category !== RETIRO_DEL_DUENO;

/** Gastos fijos por mes. No se borran: se anulan con motivo (la base lo impide). */
export class ExpensesRepository extends TenantRepository {
  async create(input: {
    branchId: string | null; category: string; description: string; amountCents: bigint; periodMonth: Date; createdByUserId: string;
    adjustsMonth?: Date | null; adjustsExpenseId?: string | null;
    paidOn?: Date | null; payeeUserId?: string | null; payeeName?: string | null;
    recurringId?: string | null; recurringDue?: Date | null;
  }): Promise<Gasto> {
    return this.db.operatingExpense.create({
      data: { id: uuidv7(), organizationId: this.organizationId, ...input },
      select: SELECT,
    });
  }

  /** El ajuste vigente que ya corrigió cada uno de estos gastos (de un mes cerrado), por id del gasto corregido. */
  async correccionesDe(ids: readonly string[]): Promise<Map<string, Gasto>> {
    if (ids.length === 0) return new Map();
    const filas = await this.db.operatingExpense.findMany({ where: this.scope({ adjustsExpenseId: { in: [...ids] }, voidedAt: null }), select: SELECT });
    return new Map(filas.map((f) => [f.adjustsExpenseId!, f]));
  }

  async findById(id: string): Promise<Gasto | null> {
    return this.db.operatingExpense.findFirst({ where: this.scope({ id }), select: SELECT });
  }

  /**
   * ¿Ese gasto salió del cajón? (bloque 4.11). Un «Retiro del dueño» registrado desde Caja (4.3) trae su
   * movimiento de efectivo (`cash_movements.expenseId`): de qué caja y de qué día de operación.
   */
  async salioDelCajon(id: string): Promise<{ registerName: string; businessDate: Date; sessionOpen: boolean } | null> {
    const filas = await this.db.$queryRaw<Array<{ registerName: string; businessDate: Date; status: string }>>`
      SELECT r."name" AS "registerName", s."businessDate", s."status"::text AS "status"
        FROM "cash_movements" mv
        JOIN "cash_sessions" s ON s."id" = mv."cashSessionId" AND s."organizationId" = mv."organizationId"
        JOIN "cash_registers" r ON r."id" = s."cashRegisterId"
       WHERE mv."organizationId" = ${this.organizationId}::uuid AND mv."expenseId" = ${id}::uuid
       LIMIT 1`;
    const f = filas[0];
    return f ? { registerName: f.registerName, businessDate: f.businessDate, sessionOpen: f.status === 'OPEN' } : null;
  }

  async void(id: string, byUserId: string, reason: string): Promise<boolean> {
    const { count } = await this.db.operatingExpense.updateMany({
      where: this.scope({ id, voidedAt: null }),
      data: { voidedAt: new Date(), voidedByUserId: byUserId, voidReason: reason },
    });
    return count > 0;
  }

  /** Los gastos vigentes de los meses que tocan la ventana `[from, to)`. */
  async vigentes(from: Date, to: Date, incluirAnulados = false): Promise<Gasto[]> {
    const primerMes = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    return this.db.operatingExpense.findMany({
      where: this.scope({
        periodMonth: { gte: primerMes, lt: to },
        ...(incluirAnulados ? {} : { voidedAt: null }),
      }),
      select: SELECT,
      orderBy: [{ periodMonth: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Lo que RESTA de la ganancia en los meses que tocan la ventana: los gastos
   * vigentes sin los retiros del dueño (D-23). Es lo que prorratean el
   * Tablero, Movimientos y el pulso.
   */
  async paraLaGanancia(from: Date, to: Date): Promise<Gasto[]> {
    return (await this.vigentes(from, to)).filter(restaDeLaGanancia);
  }
}

/** Los retiros del dueño de una lista de gastos vigentes, sumados (positivo). No se prorratean: son del mes entero. */
export function retirosDelDueno(gastos: readonly Pick<Gasto, 'category' | 'amountCents' | 'branchId'>[], sedes: readonly string[] | null): bigint {
  return gastos
    .filter((g) => g.category === RETIRO_DEL_DUENO && (sedes === null || (g.branchId !== null && sedes.includes(g.branchId))))
    .reduce((a, g) => a + g.amountCents, 0n);
}

/**
 * Los «ajustes de ‹mes›» de una lista de gastos vigentes (D-22), agrupados por
 * el mes cerrado al que corresponden. `cents` con el signo del gasto.
 */
export function ajustesPorMes(gastos: readonly Pick<Gasto, 'adjustsMonth' | 'amountCents' | 'branchId' | 'category'>[], sedes: readonly string[] | null): Array<{ month: string; cents: bigint; count: number }> {
  const porMes = new Map<string, { cents: bigint; count: number }>();
  for (const g of gastos) {
    if (!g.adjustsMonth || !restaDeLaGanancia(g)) continue;
    if (sedes !== null && (g.branchId === null || !sedes.includes(g.branchId))) continue;
    const mes = g.adjustsMonth.toISOString().slice(0, 7);
    const previo = porMes.get(mes) ?? { cents: 0n, count: 0 };
    porMes.set(mes, { cents: previo.cents + g.amountCents, count: previo.count + 1 });
  }
  return [...porMes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v }));
}

const MS_DIA = 86_400_000;
const dia = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Reparte cada gasto mensual entre los días de su mes: la renta de octubre
 * pesa 1/31 en cada día de octubre. El residuo de centavos va al último día,
 * así que un mes completo suma exacto. Devuelve el gasto (negativo) por día.
 */
export function prorrateoDiario(gastos: readonly Pick<Gasto, 'amountCents' | 'periodMonth'>[], from: Date, to: Date): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const g of gastos) {
    const inicio = g.periodMonth;
    const fin = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() + 1, 1));
    const dias = Math.round((fin.getTime() - inicio.getTime()) / MS_DIA);
    const base = g.amountCents / BigInt(dias);
    const resto = g.amountCents - base * BigInt(dias);
    for (let t = Math.max(inicio.getTime(), from.getTime()); t < Math.min(fin.getTime(), to.getTime()); t += MS_DIA) {
      const esUltimo = t + MS_DIA >= fin.getTime();
      const d = dia(new Date(t));
      out.set(d, (out.get(d) ?? 0n) - (base + (esUltimo ? resto : 0n)));
    }
  }
  return out;
}
