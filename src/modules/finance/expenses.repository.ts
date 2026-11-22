import { uuidv7 } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

export const CATEGORIAS_GASTO = ['RENT', 'PAYROLL', 'UTILITIES', 'SERVICES', 'MAINTENANCE', 'MARKETING', 'TAXES', 'OTHER'] as const;
export type CategoriaGasto = (typeof CATEGORIAS_GASTO)[number];

export type Gasto = {
  id: string; branchId: string | null; category: string; description: string; amountCents: bigint;
  periodMonth: Date; createdByUserId: string; createdAt: Date;
  voidedAt: Date | null; voidReason: string | null;
};

const SELECT = {
  id: true, branchId: true, category: true, description: true, amountCents: true, periodMonth: true,
  createdByUserId: true, createdAt: true, voidedAt: true, voidReason: true,
} as const;

/** Gastos fijos por mes. No se borran: se anulan con motivo (la base lo impide). */
export class ExpensesRepository extends TenantRepository {
  async create(input: { branchId: string | null; category: CategoriaGasto; description: string; amountCents: bigint; periodMonth: Date; createdByUserId: string }): Promise<Gasto> {
    return this.db.operatingExpense.create({
      data: { id: uuidv7(), organizationId: this.organizationId, ...input },
      select: SELECT,
    });
  }

  async findById(id: string): Promise<Gasto | null> {
    return this.db.operatingExpense.findFirst({ where: this.scope({ id }), select: SELECT });
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
