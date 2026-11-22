import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validation } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { MovementsService } from './movements.service.js';
import { MS_DIA, PERM, sedeDeReporte } from './report-scope.js';

export function registerMovementsRoutes(app: FastifyInstance): void {
  // ── Movimientos y ganancia real por día ───────────────────────────────────
  const movimientos = new MovementsService();
  const texto = (v: bigint) => v.toString();

  /** Un renglón por día del periodo: entró, devoluciones, gastos, neto. */
  route(app, {
    method: 'GET',
    url: '/reports/daily',
    security: { kind: 'permission', permission: PERM },
    handler: async (request) => {
      const q = z.object({ from: z.string().date(), to: z.string().date(), branchId: z.string().uuid().optional() }).parse(request.query);
      const from = new Date(`${q.from}T00:00:00.000Z`);
      // `to` llega INCLUSIVO, como lo elige la dueña en el calendario.
      const to = new Date(new Date(`${q.to}T00:00:00.000Z`).getTime() + MS_DIA);
      if (to <= from) throw validation('El periodo debe terminar el mismo día o después de empezar');
      if (to.getTime() - from.getTime() > 186 * MS_DIA) throw validation('Elige un periodo de hasta seis meses');
      const r = await movimientos.resumen(request.ctx!.tenant.organizationId, from, to, sedeDeReporte(request, q.branchId));
      const plano = (d: typeof r.totals) => ({
        incomeCents: texto(d.incomeCents), refundsCents: texto(d.refundsCents), expensesCents: texto(d.expensesCents),
        varianceCents: texto(d.varianceCents), shortageCents: texto(d.shortageCents), overageCents: texto(d.overageCents),
        netCents: texto(d.netCents), toBankCents: texto(d.toBankCents),
        creditNotesCents: texto(d.creditNotesCents), fixedExpensesCents: texto(d.fixedExpensesCents), profitCents: texto(d.profitCents),
        byMethod: Object.fromEntries(Object.entries(d.byMethod).map(([k, v]) => [k, texto(v)])),
      });
      return { from: q.from, to: q.to, totals: plano(r.totals), days: r.days.map((d) => ({ date: d.date, ...plano(d) })) };
    },
  });

  /** Todos los movimientos de UN día, con quién los hizo. */
  route(app, {
    method: 'GET',
    url: '/reports/movements',
    security: { kind: 'permission', permission: PERM },
    handler: async (request) => {
      const q = z.object({ date: z.string().date(), branchId: z.string().uuid().optional() }).parse(request.query);
      const rows = await movimientos.delDia(request.ctx!.tenant.organizationId, new Date(`${q.date}T00:00:00.000Z`), sedeDeReporte(request, q.branchId));
      return {
        date: q.date,
        movements: rows.map((m) => ({
          id: m.id, at: m.at.toISOString(), branchId: m.branchId, kind: m.kind, method: m.method,
          amountCents: texto(BigInt(m.amountCents)), concept: m.concept, folio: m.folio,
          memberId: m.memberId, memberName: m.memberName, memberCode: m.memberCode, userName: m.userName,
        })),
      };
    },
  });
}
