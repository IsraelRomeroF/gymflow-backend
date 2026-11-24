import type { DateRange } from '@gymflow/core';
import type { RequestContext } from '../../platform/context.js';

/**
 * LAS CIFRAS QUE CONGELA EL CIERRE DE MES (fase 4; foto completa en 3.7).
 *
 * Son las del Tablero y las de Movimientos de ese mes, para toda la
 * organización y para cada sucursal, y las calcula la analítica. Pero
 * `analytics` lee de aquí los gastos y los cierres: si `finance` la importara,
 * cada uno necesitaría al otro y ninguno se podría extraer (círculo,
 * `test/module-boundaries.test.ts`). Como `pos` con el corte de `cash`, la
 * analítica se registra al montarse (`src/modules.ts`) y `finance` no sabe
 * quién calcula.
 */

/** Lo de Movimientos (caja) del mes: los mismos nombres y signos que `GET /reports/daily`. */
export type CifrasDeCaja = {
  readonly incomeCents: bigint;
  readonly refundsCents: bigint;
  readonly expensesCents: bigint;
  readonly shortageCents: bigint;
  readonly overageCents: bigint;
  readonly netCents: bigint;
  readonly toBankCents: bigint;
  readonly creditNotesCents: bigint;
  readonly fixedExpensesCents: bigint;
  readonly profitCents: bigint;
  readonly byMethod: Readonly<Record<string, bigint>>;
};

/** Todo lo que el Tablero y Movimientos dicen de un mes, para un alcance (todo el gimnasio o una sucursal). */
export type CifrasDelMes = {
  readonly collectedCents: bigint;
  readonly accruedCents: bigint;
  readonly deferredCents: bigint;
  readonly mrrCents: bigint;
  readonly outstandingCents: bigint;
  readonly overdueCents: bigint;
  readonly activeMembers: number;
  /** Gastos de caja y faltantes de los cortes (negativo). */
  readonly cashExpensesCents: bigint;
  /** Sobrantes de los cortes (positivo): no suman. */
  readonly cashOverageCents: bigint;
  /** Gastos fijos prorrateados a la ventana (negativo). */
  readonly fixedExpensesCents: bigint;
  /** Utilidad contable: lo ganado menos los gastos. */
  readonly profitCents: bigint;
  /** Retiros del dueño del mes (positivo): no restan. */
  readonly ownerDrawsCents: bigint;
  /** Costo de lo vendido en la tienda (negativo): la utilidad ya lo resta (D-21). */
  readonly costOfGoodsCents: bigint;
  readonly membersBehind: number;
  readonly membersBase: number;
  readonly cash: CifrasDeCaja;
};

export type MonthFigures = CifrasDelMes & {
  /**
   * Por sucursal. `completa` es la foto entera de esa sede (lo que vería quien
   * solo la tiene a ella); el cajón «sin sucursal» (`null`) no la lleva.
   */
  readonly branches: ReadonlyArray<{
    readonly branchId: string | null;
    readonly collectedCents: bigint;
    readonly accruedCents: bigint;
    readonly outstandingCents: bigint;
    readonly activeMembers: number;
    readonly completa?: CifrasDelMes | undefined;
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
