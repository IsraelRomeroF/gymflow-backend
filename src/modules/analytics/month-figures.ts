import { registerMonthFiguresSource, type CifrasDelMes } from '../finance/index.js';
import { AnalyticsService, type Dashboard } from './analytics.service.js';
import { MovementsService } from './movements.service.js';

/**
 * Las cifras que congela el cierre de mes son las del Tablero y las de
 * Movimientos de ese mes, para toda la organización y para cada sucursal
 * (foto completa, 3.7 · D-22). `finance` las pide sin conocer a la analítica:
 * esta se registra al montarse (`src/modules.ts`), como `pos` en el corte de
 * caja. Se calculan con LAS MISMAS funciones que sirven las pantallas, así
 * que la foto es lo que se veía al cerrar.
 */
export function registerAnalyticsMonthFigures(): void {
  const tablero = new AnalyticsService();
  const movimientos = new MovementsService();

  registerMonthFiguresSource(async (ctx, range) => {
    const orgId = ctx.tenant.organizationId;
    const de = async (sedes: readonly string[] | null, d?: Dashboard): Promise<CifrasDelMes> => {
      const [t, m] = await Promise.all([d ?? tablero.dashboard(ctx, range, sedes), movimientos.resumen(orgId, range.from, range.to, sedes)]);
      const { byMethod, ...caja } = m.totals;
      return {
        collectedCents: t.collectedCents, accruedCents: t.accruedCents, deferredCents: t.deferredCents, mrrCents: t.mrrCents,
        outstandingCents: t.outstandingCents, overdueCents: t.overdueCents, activeMembers: t.activeMembers,
        cashExpensesCents: t.cashExpensesCents, cashOverageCents: t.cashOverageCents, fixedExpensesCents: t.fixedExpensesCents,
        profitCents: t.profitCents, ownerDrawsCents: t.ownerDrawsCents, costOfGoodsCents: t.costOfGoodsCents, membersBehind: t.membersBehind, membersBase: t.membersBase,
        cash: {
          incomeCents: caja.incomeCents, refundsCents: caja.refundsCents, expensesCents: caja.expensesCents, shortageCents: caja.shortageCents,
          overageCents: caja.overageCents, netCents: caja.netCents, toBankCents: caja.toBankCents, creditNotesCents: caja.creditNotesCents,
          fixedExpensesCents: caja.fixedExpensesCents, profitCents: caja.profitCents, byMethod,
        },
      };
    };
    const todo = await tablero.dashboard(ctx, range, null);
    const total = await de(null, todo);
    // Una sucursal a la vez: cada una son ~25 consultas y el cierre pasa una vez al mes.
    const branches: Array<{ branchId: string | null; collectedCents: bigint; accruedCents: bigint; outstandingCents: bigint; activeMembers: number; completa?: CifrasDelMes }> = [];
    for (const b of todo.branches) {
      branches.push({
        branchId: b.branchId, collectedCents: b.collectedCents, accruedCents: b.accruedCents, outstandingCents: b.outstandingCents, activeMembers: b.activeMembers,
        ...(b.branchId ? { completa: await de([b.branchId]) } : {}),
      });
    }
    return { ...total, branches };
  });
}
