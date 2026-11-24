import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict, notFound, validation } from '@gymflow/core';
import { Expense, ExpenseList } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { CATEGORIAS_GASTO, ExpensesRepository, type Gasto } from './expenses.repository.js';
import { MonthlyCloseRepository } from './monthly-close.repository.js';
import { mesLargo } from './monthly-close.service.js';

/** Los gastos los ve quien ve el dinero del gimnasio: son los del Tablero y Movimientos. */
const PERM = 'reports:financial:read' as const;

const aMes = (d: Date) => d.toISOString().slice(0, 7);

/**
 * Gastos del gimnasio (renta, nómina…) y retiros del dueño: consultar,
 * registrar y anular con motivo.
 *
 * Quién anota (D-23): la dueña siempre, haya o no gerente, y la gerencia con
 * Movimientos liberado; los dos con `expenses:manage` (la sesión se lo da a la
 * dueña, `identity/session.repository.ts`).
 *
 * Un mes cerrado no se toca (D-22): lo que llega tarde —un gasto que faltó, o
 * uno que sobraba— se anota en el mes en curso como «ajuste de ‹mes›», a la
 * vista. Primero se responde 409 `MONTH_CLOSED` para que la pantalla lo
 * ofrezca; con `asAdjustment` se anota.
 */
export function registerExpenseRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  const gastoJson = (g: Gasto, correccion?: Gasto | undefined): Expense => ({
    id: g.id, branchId: g.branchId, category: g.category, description: g.description,
    amountCents: g.amountCents.toString(), month: aMes(g.periodMonth),
    createdAt: g.createdAt.toISOString(), voidedAt: g.voidedAt?.toISOString() ?? null, voidReason: g.voidReason,
    adjustsMonth: g.adjustsMonth ? aMes(g.adjustsMonth) : null, adjustsExpenseId: g.adjustsExpenseId,
    correctedInMonth: correccion ? aMes(correccion.periodMonth) : null,
  });
  const mes = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes como AAAA-MM');
  /** El mes en curso del gimnasio (su fecha de negocio, no la del servidor). */
  const mesEnCurso = async (organizationId: string): Promise<Date> => {
    const hoy = await new BusinessCalendar(organizationId).today(null);
    return new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1));
  };
  const cerrado = (g: { month: string }) => conflict(
    `${mesLargo(g.month, true)} ya está cerrado y sus cifras no cambian. Anótalo en el mes en curso como «ajuste de ${mesLargo(g.month)}».`, 'MONTH_CLOSED');

  /** Los gastos de un mes: lo que hace que "ganancia" sea ganancia (UXB-02). */
  route(app, {
    method: 'GET',
    url: '/expenses',
    security: { kind: 'permission', permission: PERM },
    schema: respuesta(200, ExpenseList),
    handler: async (request): Promise<ExpenseList> => {
      const q = z.object({ month: mes }).parse(request.query);
      const orgId = request.ctx!.tenant.organizationId;
      const desde = new Date(`${q.month}-01T00:00:00.000Z`);
      const hasta = new Date(Date.UTC(desde.getUTCFullYear(), desde.getUTCMonth() + 1, 1));
      const sedes = request.branchScope(PERM);
      const repo = new ExpensesRepository(orgId);
      const [todos, cierre, enCurso] = await Promise.all([repo.vigentes(desde, hasta, true), new MonthlyCloseRepository(orgId).find(desde), mesEnCurso(orgId)]);
      const gastos = todos
        .filter((g) => g.periodMonth.getTime() === desde.getTime())
        // Quien ve solo sus sedes no ve los gastos de todo el gimnasio.
        .filter((g) => sedes === null || (g.branchId !== null && sedes.includes(g.branchId)));
      // En un mes cerrado, cada gasto dice si ya se corrigió con un ajuste.
      const correcciones = cierre ? await repo.correccionesDe(gastos.map((g) => g.id)) : new Map<string, Gasto>();
      return { month: q.month, closed: !!cierre, currentMonth: aMes(enCurso), expenses: gastos.map((g) => gastoJson(g, correcciones.get(g.id))) };
    },
  });

  route(app, {
    method: 'POST',
    url: '/expenses',
    security: { kind: 'permission', permission: 'expenses:manage' },
    schema: respuesta(201, Expense),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const body = z.object({
        category: z.enum(CATEGORIAS_GASTO),
        description: z.string().trim().min(3).max(200),
        amountCents: z.coerce.bigint().positive().max(99_999_999_999n),
        month: mes,
        branchId: z.string().uuid().nullable(),
        /** El mes está cerrado: anótalo en el mes en curso como «ajuste de ‹mes›» (D-22). */
        asAdjustment: z.boolean().optional(),
      }).parse(request.body);
      // Un gasto de todo el gimnasio exige alcance organizacional.
      request.authorize('expenses:manage', { reason: body.description, branchId: body.branchId });

      const delMes = new Date(`${body.month}-01T00:00:00.000Z`);
      const cierre = await new MonthlyCloseRepository(orgId).find(delMes);
      if (cierre && !body.asAdjustment) throw cerrado(body);
      if (!cierre && body.asAdjustment) throw validation('Ese mes sigue abierto: el gasto se anota en él, no como ajuste');
      const periodMonth = cierre ? await mesEnCurso(orgId) : delMes;

      const g = await enUnaTransaccion(async () => {
        const nuevo = await new ExpensesRepository(orgId).create({
          branchId: body.branchId, category: body.category, description: body.description, amountCents: body.amountCents,
          periodMonth, createdByUserId: ctx.tenant.actorUserId!, adjustsMonth: cierre ? delMes : null,
        });
        await audit.record(ctx, {
          action: cierre ? 'expense.adjust' : 'expense.create', resourceType: 'OperatingExpense', resourceId: nuevo.id, branchId: body.branchId,
          reason: body.description,
          afterState: { category: body.category, amountCents: body.amountCents.toString(), month: aMes(periodMonth), ...(cierre ? { adjustsMonth: body.month } : {}) },
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
      const orgId = ctx.tenant.organizationId;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { reason, asAdjustment } = z.object({
        reason: z.string().trim().min(3).max(300),
        /** El gasto es de un mes cerrado: se corrige con un ajuste en el mes en curso (D-22). */
        asAdjustment: z.boolean().optional(),
      }).parse(request.body);
      const repo = new ExpensesRepository(orgId);
      const g = await repo.findById(id);
      if (!g) throw notFound('Gasto no encontrado');
      request.authorize('expenses:manage', { reason, branchId: g.branchId });

      const cierre = await new MonthlyCloseRepository(orgId).find(g.periodMonth);
      if (!cierre) {
        await enUnaTransaccion(async () => {
          if (!(await repo.void(id, ctx.tenant.actorUserId!, reason))) throw conflict('Ese gasto ya estaba anulado', 'ALREADY_VOIDED');
          await audit.record(ctx, {
            action: 'expense.void', resourceType: 'OperatingExpense', resourceId: id, branchId: g.branchId, reason,
            beforeState: { amountCents: g.amountCents.toString(), description: g.description },
          });
        });
        return { ok: true, adjustment: null };
      }

      // Mes cerrado: el gasto se queda como está en su mes y la corrección se
      // anota, en negativo, en el mes en curso.
      const mesDelGasto = aMes(g.periodMonth);
      if (!asAdjustment) throw cerrado({ month: mesDelGasto });
      if (g.voidedAt) throw conflict('Ese gasto ya estaba anulado', 'ALREADY_VOIDED');
      if ((await repo.correccionesDe([id])).has(id)) throw conflict('Ese gasto ya se corrigió con un ajuste', 'ALREADY_VOIDED');
      const periodMonth = await mesEnCurso(orgId);
      const ajuste = await enUnaTransaccion(async () => {
        const nuevo = await repo.create({
          branchId: g.branchId, category: g.category, description: `Se anuló «${g.description}»`.slice(0, 200), amountCents: -g.amountCents,
          periodMonth, createdByUserId: ctx.tenant.actorUserId!, adjustsMonth: g.periodMonth, adjustsExpenseId: g.id,
        });
        await audit.record(ctx, {
          action: 'expense.adjust', resourceType: 'OperatingExpense', resourceId: nuevo.id, branchId: g.branchId, reason,
          beforeState: { expenseId: g.id, amountCents: g.amountCents.toString(), description: g.description, month: mesDelGasto },
          afterState: { amountCents: nuevo.amountCents.toString(), month: aMes(periodMonth), adjustsMonth: mesDelGasto, adjustsExpenseId: g.id },
        });
        return nuevo;
      });
      return { ok: true, adjustment: gastoJson(ajuste) };
    },
  });
}
