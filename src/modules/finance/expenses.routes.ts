import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict, notFound } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { CATEGORIAS_GASTO, ExpensesRepository, type Gasto } from './expenses.repository.js';

/** Los gastos los ve quien ve el dinero del gimnasio: son los del Tablero y Movimientos. */
const PERM = 'reports:financial:read' as const;

/** Gastos fijos del gimnasio (renta, nómina…): consultar, registrar y anular con motivo. */
export function registerExpenseRoutes(app: FastifyInstance): void {
  // ── Gastos fijos ──────────────────────────────────────────────────────────
  const audit = new AuditService();

  const gastoJson = (g: Gasto) => ({
    id: g.id, branchId: g.branchId, category: g.category, description: g.description,
    amountCents: g.amountCents.toString(), month: g.periodMonth.toISOString().slice(0, 7),
    createdAt: g.createdAt.toISOString(), voidedAt: g.voidedAt?.toISOString() ?? null, voidReason: g.voidReason,
  });
  const mes = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes como AAAA-MM');

  /** Los gastos fijos de un mes: lo que hace que "ganancia" sea ganancia (UXB-02). */
  route(app, {
    method: 'GET',
    url: '/expenses',
    security: { kind: 'permission', permission: PERM },
    handler: async (request) => {
      const q = z.object({ month: mes }).parse(request.query);
      const desde = new Date(`${q.month}-01T00:00:00.000Z`);
      const hasta = new Date(Date.UTC(desde.getUTCFullYear(), desde.getUTCMonth() + 1, 1));
      const sedes = request.branchScope(PERM);
      const gastos = (await new ExpensesRepository(request.ctx!.tenant.organizationId).vigentes(desde, hasta, true))
        .filter((g) => g.periodMonth.getTime() === desde.getTime())
        // Quien ve solo sus sedes no ve los gastos de todo el gimnasio.
        .filter((g) => sedes === null || (g.branchId !== null && sedes.includes(g.branchId)));
      return { month: q.month, expenses: gastos.map(gastoJson) };
    },
  });

  route(app, {
    method: 'POST',
    url: '/expenses',
    security: { kind: 'permission', permission: 'expenses:manage' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = z.object({
        category: z.enum(CATEGORIAS_GASTO),
        description: z.string().trim().min(3).max(200),
        amountCents: z.coerce.bigint().positive().max(99_999_999_999n),
        month: mes,
        branchId: z.string().uuid().nullable(),
      }).parse(request.body);
      // Un gasto de todo el gimnasio exige alcance organizacional.
      request.authorize('expenses:manage', { reason: body.description, branchId: body.branchId });
      const g = await enUnaTransaccion(async () => {
        const nuevo = await new ExpensesRepository(ctx.tenant.organizationId).create({
          branchId: body.branchId, category: body.category, description: body.description, amountCents: body.amountCents,
          periodMonth: new Date(`${body.month}-01T00:00:00.000Z`), createdByUserId: ctx.tenant.actorUserId!,
        });
        await audit.record(ctx, {
          action: 'expense.create', resourceType: 'OperatingExpense', resourceId: nuevo.id, branchId: body.branchId,
          reason: body.description, afterState: { category: body.category, amountCents: body.amountCents.toString(), month: body.month },
        });
        return nuevo;
      });
      return reply.status(201).send(gastoJson(g));
    },
  });

  route(app, {
    method: 'POST',
    url: '/expenses/:id/void',
    security: { kind: 'permission', permission: 'expenses:manage' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(request.body);
      const repo = new ExpensesRepository(ctx.tenant.organizationId);
      const g = await repo.findById(id);
      if (!g) throw notFound('Gasto no encontrado');
      request.authorize('expenses:manage', { reason, branchId: g.branchId });
      await enUnaTransaccion(async () => {
        if (!(await repo.void(id, ctx.tenant.actorUserId!, reason))) throw conflict('Ese gasto ya estaba anulado', 'ALREADY_VOIDED');
        await audit.record(ctx, {
          action: 'expense.void', resourceType: 'OperatingExpense', resourceId: id, branchId: g.branchId, reason,
          beforeState: { amountCents: g.amountCents.toString(), description: g.description },
        });
      });
      return { ok: true };
    },
  });
}
