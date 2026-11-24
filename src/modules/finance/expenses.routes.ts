import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { conflict, isoDate, notFound } from '@gymflow/core';
import { Expense, ExpenseList, ExpensePayees, FrecuenciaDeGasto, RecurringExpense, RecurringExpenseList, RecurringExpenseResult } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { CATEGORIAS_GASTO, ExpensesRepository, RETIRO_DEL_DUENO, esPagoAPersona, type Gasto } from './expenses.repository.js';
import { ExpensesService } from './expenses.service.js';
import { MonthlyCloseRepository } from './monthly-close.repository.js';
import { mesLargo } from './monthly-close.service.js';
import { RecurringExpensesRepository, type Recurrente } from './recurring.repository.js';

/** Los gastos los ve quien ve el dinero del gimnasio: son los del Tablero y Movimientos. */
const PERM = 'reports:financial:read' as const;
/** Cuánto se le paga a cada persona: solo quien tiene Movimientos (D-26). */
const VER_NOMINA = 'expenses:payroll:read' as const;

const aMes = (d: Date) => d.toISOString().slice(0, 7);
/** Los gastos que se pueden repetir: todos menos el retiro del dueño, que no es un gasto. */
const CATEGORIAS_QUE_SE_REPITEN = CATEGORIAS_GASTO.filter((c) => c !== RETIRO_DEL_DUENO) as [string, ...string[]];

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
 *
 * Fase 4, bloque 4.5 (D-26):
 *  - La nómina se anota POR PAGO: `paidOn`, a quién (`payeeUserId` o
 *    `payeeName`) y cuánto. Ya no se acepta «Nómina» sin fecha ni persona.
 *  - Lo que se repite se PROPONE cada periodo «por confirmar»
 *    (`/expenses/recurring…`): nada se anota solo, y lo no confirmado no es
 *    un gasto.
 *  - Cuánto se le paga a cada persona lo ve quien tiene Movimientos
 *    (`expenses:payroll:read`: la dueña y la gerencia con la sección
 *    liberada). A quien ve el dinero sin Movimientos (solo el Tablero) no se
 *    le entregan esos pagos: recibe cuántos son y cuánto suman.
 */
export function registerExpenseRoutes(app: FastifyInstance): void {
  const audit = new AuditService();
  const servicio = new ExpensesService();

  const gastoJson = (g: Gasto, correccion?: Gasto | undefined): Expense => ({
    id: g.id, branchId: g.branchId, category: g.category, description: g.description,
    amountCents: g.amountCents.toString(), month: aMes(g.periodMonth),
    createdAt: g.createdAt.toISOString(), voidedAt: g.voidedAt?.toISOString() ?? null, voidReason: g.voidReason,
    adjustsMonth: g.adjustsMonth ? aMes(g.adjustsMonth) : null, adjustsExpenseId: g.adjustsExpenseId,
    correctedInMonth: correccion ? aMes(correccion.periodMonth) : null,
    paidOn: g.paidOn ? isoDate(g.paidOn) : null, payeeUserId: g.payeeUserId, payeeName: g.payeeName, recurringId: g.recurringId,
  });
  const recurrenteJson = (r: Recurrente): RecurringExpense => ({
    id: r.id, branchId: r.branchId, category: r.category, description: r.description, amountCents: r.amountCents.toString(),
    frequency: r.frequency, startsOn: isoDate(r.startsOn), payeeUserId: r.payeeUserId, payeeName: r.payeeName, payeeInactive: false,
    createdAt: r.createdAt.toISOString(), endedAt: r.endedAt?.toISOString() ?? null,
  });
  const mes = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes como AAAA-MM');
  const dia = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Fecha como AAAA-MM-DD')
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`)) && new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v, 'Esa fecha no existe');
  const importe = z.coerce.bigint().positive().max(99_999_999_999n);
  const aQuien = { payeeUserId: z.string().uuid().nullish(), payeeName: z.string().trim().max(120).nullish() };
  const cerrado = (g: { month: string }) => conflict(
    `${mesLargo(g.month, true)} ya está cerrado y sus cifras no cambian. Anótalo en el mes en curso como «ajuste de ${mesLargo(g.month)}».`, 'MONTH_CLOSED');
  /** ¿Quien pide ve cuánto se le paga a cada persona? */
  const veLaNomina = (request: FastifyRequest): boolean => {
    const sedes = request.branchScope(VER_NOMINA);
    return sedes === null || sedes.length > 0;
  };

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
      const [todos, cierre, hoy] = await Promise.all([repo.vigentes(desde, hasta, true), new MonthlyCloseRepository(orgId).find(desde), servicio.hoy(orgId)]);
      const delMes = todos
        .filter((g) => g.periodMonth.getTime() === desde.getTime())
        // Quien ve solo sus sedes no ve los gastos de todo el gimnasio.
        .filter((g) => sedes === null || (g.branchId !== null && sedes.includes(g.branchId)));
      // D-26: los pagos de nómina por persona, solo a quien tiene Movimientos. Los demás saben cuántos son y cuánto suman.
      const conNomina = veLaNomina(request);
      const gastos = conNomina ? delMes : delMes.filter((g) => !esPagoAPersona(g));
      const ocultos = conNomina ? [] : delMes.filter((g) => esPagoAPersona(g) && !g.voidedAt);
      // En un mes cerrado, cada gasto dice si ya se corrigió con un ajuste.
      const correcciones = cierre ? await repo.correccionesDe(gastos.map((g) => g.id)) : new Map<string, Gasto>();
      return {
        month: q.month, closed: !!cierre, currentMonth: aMes(hoy), today: isoDate(hoy),
        expenses: gastos.map((g) => gastoJson(g, correcciones.get(g.id))),
        hiddenPayroll: ocultos.length > 0 ? { count: ocultos.length, amountCents: ocultos.reduce((a, g) => a + g.amountCents, 0n).toString() } : null,
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/expenses',
    security: { kind: 'permission', permission: 'expenses:manage' },
    schema: respuesta(201, Expense),
    handler: async (request, reply) => {
      const body = z.object({
        category: z.enum(CATEGORIAS_GASTO),
        /** En la nómina es una nota opcional (por omisión «Pago de nómina»). */
        description: z.string().trim().max(200).optional(),
        amountCents: importe,
        /** En un pago de nómina sale de `paidOn`. */
        month: mes.optional(),
        branchId: z.string().uuid().nullable(),
        /** El mes está cerrado: anótalo en el mes en curso como «ajuste de ‹mes›» (D-22). */
        asAdjustment: z.boolean().optional(),
        /** D-26: la nómina es por pago. */
        paidOn: dia.optional(),
        ...aQuien,
        /** Además, que se proponga cada periodo «por confirmar». */
        repeat: FrecuenciaDeGasto.optional(),
      }).parse(request.body);
      // Un gasto de todo el gimnasio exige alcance organizacional.
      request.authorize('expenses:manage', { reason: body.description || 'Pago de nómina', branchId: body.branchId });
      const g = await servicio.anotar(request.ctx!, body);
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
      const hoy = await servicio.hoy(orgId);
      const periodMonth = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1));
      const ajuste = await enUnaTransaccion(async () => {
        const nuevo = await repo.create({
          branchId: g.branchId, category: g.category, description: `Se anuló «${g.description}»`.slice(0, 200), amountCents: -g.amountCents,
          periodMonth, createdByUserId: ctx.tenant.actorUserId!, adjustsMonth: g.periodMonth, adjustsExpenseId: g.id,
          // El ajuste de un pago de nómina sigue siendo de esa persona (y sigue viéndolo solo quien ve la nómina).
          paidOn: g.paidOn, payeeUserId: g.payeeUserId, payeeName: g.payeeName,
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

  // ── D-26 (4.5): a quién se le paga y lo que se repite ─────────────────────

  /** A quién se le puede anotar un pago de nómina: el personal del gimnasio, activo o no. Nombre y puesto, nada más. */
  route(app, {
    method: 'GET',
    url: '/expenses/payees',
    security: { kind: 'permission', permission: 'expenses:manage' },
    schema: respuesta(200, ExpensePayees),
    handler: async (request): Promise<ExpensePayees> => {
      // Los nombres de todo el personal: de quien anota para todo el gimnasio (la dueña y la gerencia).
      request.requirePermission('expenses:manage', null);
      return { payees: await new RecurringExpensesRepository(request.ctx!.tenant.organizationId).personal() };
    },
  });

  /** Lo que se repite y lo que propone para ese mes: por confirmar, confirmado o descartado. */
  route(app, {
    method: 'GET',
    url: '/expenses/recurring',
    security: { kind: 'permission', permission: PERM },
    schema: respuesta(200, RecurringExpenseList),
    handler: async (request): Promise<RecurringExpenseList> => {
      const q = z.object({ month: mes }).parse(request.query);
      return servicio.propuestas(request.ctx!.tenant.organizationId, q.month, request.branchScope(PERM), veLaNomina(request));
    },
  });

  /** Deja un gasto para que se proponga cada periodo, sin anotar ninguno ahora. */
  route(app, {
    method: 'POST',
    url: '/expenses/recurring',
    security: { kind: 'permission', permission: 'expenses:manage' },
    schema: respuesta(201, RecurringExpense),
    handler: async (request, reply) => {
      const body = z.object({
        category: z.enum(CATEGORIAS_QUE_SE_REPITEN),
        description: z.string().trim().max(200).optional(),
        amountCents: importe,
        branchId: z.string().uuid().nullable(),
        frequency: FrecuenciaDeGasto,
        /** La primera fecha en que se propone. */
        startsOn: dia,
        ...aQuien,
      }).parse(request.body);
      request.authorize('expenses:manage', { reason: body.description || 'Pago de nómina', branchId: body.branchId });
      const r = await servicio.dejarQueSeRepita(request.ctx!, body);
      return reply.status(201).send(recurrenteJson(r));
    },
  });

  // La propuesta es un par (gasto que se repite, día): va en el cuerpo.

  /** Confirma una propuesta: nace el gasto, con el importe de la plantilla o el corregido. */
  route(app, {
    method: 'POST',
    url: '/expenses/recurring/confirm',
    security: { kind: 'permission', permission: 'expenses:manage' },
    schema: respuesta(201, Expense),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = z.object({
        recurringId: z.string().uuid(),
        dueOn: dia,
        /** Corrige el importe de esta vez… */
        amountCents: importe.optional(),
        /** …y, si se pide, el de las siguientes. */
        keepAmount: z.boolean().optional(),
        /** Nómina: el día en que de verdad se pagó (por omisión, el que tocaba). */
        paidOn: dia.optional(),
        asAdjustment: z.boolean().optional(),
      }).parse(request.body);
      const r = await servicio.recurrente(ctx.tenant.organizationId, body.recurringId);
      request.authorize('expenses:manage', { reason: r.description, branchId: r.branchId });
      const g = await servicio.confirmar(ctx, r, body);
      return reply.status(201).send(gastoJson(g));
    },
  });

  /** Descarta una propuesta: esta vez no se pagó. No se anota nada. */
  route(app, {
    method: 'POST',
    url: '/expenses/recurring/skip',
    security: { kind: 'permission', permission: 'expenses:manage' },
    schema: respuesta(200, RecurringExpenseResult),
    handler: async (request): Promise<RecurringExpenseResult> => {
      const ctx = request.ctx!;
      const body = z.object({ recurringId: z.string().uuid(), dueOn: dia, reason: z.string().trim().max(300).optional() }).parse(request.body);
      const r = await servicio.recurrente(ctx.tenant.organizationId, body.recurringId);
      request.authorize('expenses:manage', { reason: body.reason || r.description, branchId: r.branchId });
      await servicio.descartar(ctx, r, body);
      return { ok: true };
    },
  });

  /** Deja de repetirse: no propone nada más. Los gastos ya confirmados no cambian. */
  route(app, {
    method: 'POST',
    url: '/expenses/recurring/end',
    security: { kind: 'permission', permission: 'expenses:manage' },
    schema: respuesta(200, RecurringExpenseResult),
    handler: async (request): Promise<RecurringExpenseResult> => {
      const ctx = request.ctx!;
      const body = z.object({ recurringId: z.string().uuid(), reason: z.string().trim().min(3).max(300) }).parse(request.body);
      const r = await servicio.recurrente(ctx.tenant.organizationId, body.recurringId);
      request.authorize('expenses:manage', { reason: body.reason, branchId: r.branchId });
      await servicio.dejarDeRepetir(ctx, r, body.reason);
      return { ok: true };
    },
  });
}
