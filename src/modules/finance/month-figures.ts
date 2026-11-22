import type { DateRange } from '@gymflow/core';
import type { RequestContext } from '../../platform/context.js';

/**
 * LAS CIFRAS QUE CONGELA EL CIERRE DE MES (fase 4).
 *
 * Son las del Tablero de ese mes para toda la organización y las calcula la
 * analítica. Pero `analytics` lee de aquí los gastos y los cierres: si
 * `finance` la importara, cada uno necesitaría al otro y ninguno se podría
 * extraer (círculo, `test/module-boundaries.test.ts`). Como `pos` con el corte
 * de `cash`, la analítica se registra al montarse (`src/modules.ts`) y
 * `finance` no sabe quién calcula.
 */
export type MonthFigures = {
  readonly collectedCents: bigint;
  readonly accruedCents: bigint;
  readonly deferredCents: bigint;
  readonly mrrCents: bigint;
  readonly outstandingCents: bigint;
  readonly overdueCents: bigint;
  readonly activeMembers: number;
  /** Gastos de caja y faltantes de los cortes (negativo). */
  readonly cashExpensesCents: bigint;
  /** Gastos fijos prorrateados a la ventana (negativo). */
  readonly fixedExpensesCents: bigint;
  /** Utilidad contable: lo ganado menos los gastos. */
  readonly profitCents: bigint;
  readonly branches: ReadonlyArray<{
    readonly branchId: string | null;
    readonly collectedCents: bigint;
    readonly accruedCents: bigint;
    readonly outstandingCents: bigint;
    readonly activeMembers: number;
  }>;
};

/** Las cifras de TODA la organización en la ventana `[from, to)`. */
export type MonthFiguresSource = (ctx: RequestContext, range: DateRange) => Promise<MonthFigures>;

let fuente: MonthFiguresSource | null = null;

export function registerMonthFiguresSource(fn: MonthFiguresSource): void {
  fuente = fn;
}

export function monthFigures(ctx: RequestContext, range: DateRange): Promise<MonthFigures> {
  if (!fuente) throw new Error('Nadie calcula las cifras del mes: falta montar analytics (src/modules.ts)');
  return fuente(ctx, range);
}
