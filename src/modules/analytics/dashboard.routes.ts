import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatMoney, money, validation } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { claveDeSedes, recordar } from '../../platform/cache.js';
import { MonthlyCloseRepository } from '../finance/index.js';
import { AnalyticsService } from './analytics.service.js';
import { MS_DIA, VIGENCIA_TABLERO_MS } from './report-scope.js';

const cents = (v: bigint): string => v.toString();

export function registerDashboardRoutes(app: FastifyInstance): void {
  const service = new AnalyticsService();

  /**
   * Tablero del dueño. Pensado para el teléfono: una sola llamada devuelve
   * todo lo que hay que ver, porque tres peticiones en una red mala son tres
   * oportunidades de que la pantalla quede a medias.
   */
  route(app, {
    method: 'GET',
    url: '/dashboard',
    security: { kind: 'permission', permission: 'reports:financial:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const q = z.object({
        from: z.string().date().optional(),
        to: z.string().date().optional(),
        days: z.coerce.number().int().min(1).max(366).optional(),
        branchId: z.string().uuid().optional(),
        // `mes`: contra las mismas fechas del mes anterior (UXD-02).
        compare: z.enum(['periodo', 'mes']).default('periodo'),
        fresh: z.coerce.boolean().optional(),
      }).parse(request.query);
      if (q.branchId) request.requirePermission('reports:financial:read', q.branchId);

      let range = await service.todayRange(ctx);
      if (q.from && q.to) {
        const from = new Date(`${q.from}T00:00:00.000Z`);
        const to = new Date(`${q.to}T00:00:00.000Z`);
        if (to <= from) throw validation('El rango debe terminar después de empezar');
        range = { from, to };
      } else if (q.days) {
        // `to` es EXCLUSIVO, así que "7 días" incluye hoy y los seis anteriores.
        range = { from: new Date(range.to.getTime() - q.days * MS_DIA), to: range.to };
      }

      // Un gerente de dos sedes ve SUS sedes; el dueño, todo.
      const sedes = q.branchId ? [q.branchId] : request.branchScope('reports:financial:read');
      const clave = `dashboard:${ctx.tenant.organizationId}:${claveDeSedes(sedes)}:${range.from.toISOString()}:${range.to.toISOString()}:${q.compare}`;
      return recordar(clave, q.fresh ? 0 : VIGENCIA_TABLERO_MS, async () => {
      const d = await service.dashboard(ctx, range, sedes, q.compare);
      // Cierre de mes (fase 4): si el rango es un mes cerrado, se dice; y lo que
      // entró en el rango pero pertenece a meses cerrados se etiqueta aparte.
      const cierres = new MonthlyCloseRepository(ctx.tenant.organizationId);
      const esMes = range.from.getUTCDate() === 1 && range.to.getTime() === Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth() + 1, 1);
      const cerrado = esMes ? await cierres.find(range.from) : null;
      const ajustes = await cierres.priorAdjustmentsCents(range.from, range.to);

      return {
        range: d.range,
        closed: cerrado ? { closedAt: cerrado.closedAt.toISOString(), closedByUserId: cerrado.closedByUserId, note: cerrado.note } : null,
        priorAdjustmentsCents: ajustes.toString(),
        /**
         * Las tres cifras, juntas y con su explicación: el dueño tiene que
         * poder ver de un vistazo que cobrar y ganar no son lo mismo.
         */
        money: {
          collectedCents: cents(d.collectedCents),
          collectedLabel: formatMoney(money(d.collectedCents)),
          accruedCents: cents(d.accruedCents),
          accruedLabel: formatMoney(money(d.accruedCents)),
          deferredCents: cents(d.deferredCents),
          deferredLabel: formatMoney(money(d.deferredCents)),
          mrrCents: cents(d.mrrCents),
          mrrLabel: formatMoney(money(d.mrrCents)),
          cashExpensesCents: cents(d.cashExpensesCents),
          /** Sobrantes de los cortes: no suman a la utilidad, se informan «por aclarar» (13-05). */
          cashOverageCents: cents(d.cashOverageCents),
          fixedExpensesCents: cents(d.fixedExpensesCents),
          profitCents: cents(d.profitCents),
        },
        previous: {
          from: d.previous.from, to: d.previous.to,
          collectedCents: cents(d.previous.collectedCents), accruedCents: cents(d.previous.accruedCents), profitCents: cents(d.previous.profitCents),
        },
        portfolio: {
          outstandingCents: cents(d.outstandingCents),
          overdueCents: cents(d.overdueCents),
          delinquencyRate: d.delinquencyRate,
          // En socios, no en pesos: "24 de 248 atrasados" dice más que "vencido 100 %".
          membersBehind: d.membersBehind,
          membersBase: d.membersBase,
        },
        activeMembers: d.activeMembers,
        openCashSessions: d.openCashSessions.map((s) => ({
          id: s.id,
          branchId: s.branchId,
          registerCode: s.registerCode,
          openedAt: s.openedAt.toISOString(),
          openingFloatCents: cents(s.openingFloatCents),
        })),
        /** Ordenadas por DEVENGADO, no por cobrado. Ver `rankBranches`. */
        branches: d.branches.map((b) => ({
          branchId: b.branchId,
          collectedCents: cents(b.collectedCents),
          accruedCents: cents(b.accruedCents),
          activeMembers: b.activeMembers,
          outstandingCents: cents(b.outstandingCents),
        })),
        notes: {
          packsValuedByListPrice: d.packsValuedByListPrice,
          ...(d.packsValuedByListPrice > 0
            ? {
              warning:
                `${d.packsValuedByListPrice} paquete(s) de visitas sin cargo enlazado se valoraron ` +
                'a precio de lista. La cifra devengada es aproximada para esos paquetes.',
            }
            : {}),
        },
      };
      });
    },
  });
}
