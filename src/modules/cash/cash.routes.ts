import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  conflict, DomainError, formatMoney, forbidden, money, notFound,
} from '@gymflow/core';
import { OpenCashSessionsLite } from '@gymflow/core/contracts';
import { AuditService } from '../../platform/audit/audit.service.js';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { sedeDeConsulta } from '../../platform/http/branch-scope.js';
import { contar, registerModuleUsage } from '../../platform/modules/usage.js';
import { BranchRepository } from '../organization/index.js';
import { CashRegisterRepository, CashSessionRepository, type CashMovementRecord, type CashSessionRecord } from './cash.repository.js';
import { CashService, type ShiftReport } from './cash.service.js';
import { UserRepository } from '../identity/index.js';

const idParam = z.object({ id: z.string().uuid() });
const cents = (v: bigint): string => v.toString();
const iso = (d: Date): string => d.toISOString().slice(0, 10);

type Nombres = ReadonlyMap<string, string>;

/** Quién abrió y quién cerró: el corte responde por personas, no por ids. */
async function nombresDe(orgId: string, sessions: readonly CashSessionRecord[]): Promise<Nombres> {
  const ids = sessions.flatMap((s) => [s.openedByUserId, ...(s.closedByUserId ? [s.closedByUserId] : [])]);
  return new UserRepository(orgId).namesById(ids);
}

function serializeSession(s: CashSessionRecord, nombres: Nombres = new Map()) {
  return {
    id: s.id,
    branchId: s.branchId,
    cashRegisterId: s.cashRegisterId,
    status: s.status,
    shiftLabel: s.shiftLabel,
    businessDate: iso(s.businessDate),
    openedByUserId: s.openedByUserId,
    openedByName: nombres.get(s.openedByUserId) ?? null,
    closedByUserId: s.closedByUserId,
    closedByName: s.closedByUserId ? nombres.get(s.closedByUserId) ?? null : null,
    openingFloatCents: cents(s.openingFloatCents),
    expectedCashCents: s.expectedCashCents === null ? null : cents(s.expectedCashCents),
    countedCashCents: s.countedCashCents === null ? null : cents(s.countedCashCents),
    varianceCents: s.varianceCents === null ? null : cents(s.varianceCents),
    varianceReason: s.varianceReason,
    firstCountedCashCents: s.firstCountedCashCents === null ? null : cents(s.firstCountedCashCents),
    countAttempts: s.countAttempts,
    openedAt: s.openedAt.toISOString(),
    closedAt: s.closedAt?.toISOString() ?? null,
  };
}

function serializeMovement(m: CashMovementRecord) {
  return {
    id: m.id,
    movementType: m.movementType,
    amountCents: cents(m.amountCents),
    amountLabel: formatMoney(money(m.amountCents)),
    reason: m.reason,
    createdByUserId: m.createdByUserId,
    approvedByUserId: m.approvedByUserId,
    at: m.at.toISOString(),
  };
}

/**
 * `ciego`: el turno sigue abierto y quien pide es quien va a contarlo. El
 * corte ciego solo mide si el esperado NO llega a la pantalla antes del
 * conteo (MC-07): se omiten el esperado y lo cobrado en efectivo.
 */
function serializeReport(r: ShiftReport, nombres: Nombres, ciego = false) {
  const sinEfectivo = (xs: ReadonlyArray<{ method: string; amountCents: bigint }>) => xs.filter((x) => !ciego || x.method !== 'CASH');
  return {
    session: serializeSession(r.session, nombres),
    register: { id: r.register.id, code: r.register.code, name: r.register.name },
    byMethod: sinEfectivo(r.byMethod).map((x) => ({ method: x.method, amountCents: cents(x.amountCents) })),
    /** De dónde viene el dinero: cobros y, hoy, producto. Un solo documento. */
    contributions: r.contributions.map((c) => ({
      source: c.source,
      byMethod: sinEfectivo(c.byMethod).map((x) => ({ method: x.method, amountCents: cents(x.amountCents) })),
    })),
    totalCollectedCents: ciego ? null : cents(r.totalCollectedCents),
    cashCollectedCents: ciego ? null : cents(r.cashCollectedCents),
    movementsCents: cents(r.movementsCents),
    movements: r.movements.map(serializeMovement),
    expectedCashCents: ciego ? null : cents(r.expectedCashCents),
    expectedCashLabel: ciego ? null : formatMoney(money(r.expectedCashCents)),
    blind: ciego,
    countedCashCents: r.countedCashCents === null ? null : cents(r.countedCashCents),
    varianceCents: r.varianceCents === null ? null : cents(r.varianceCents),
  };
}

export function registerCashRoutes(app: FastifyInstance): void {
  const service = new CashService();

  // Lo vivo antes de apagar Caja, en el gimnasio o en una sede (19-01, D19-05):
  // con un turno abierto no se apaga, porque el corte es donde se cuenta el
  // cajón y apagarlo dejaba ese efectivo sin cuadrar.
  registerModuleUsage('cash', async (orgId, branchId) => {
    const [cajas, abiertos] = await Promise.all([
      new CashRegisterRepository(orgId).countActive(branchId),
      new CashSessionRepository(orgId).countOpen(branchId),
    ]);
    return {
      inUse: contar(cajas, 'caja en uso', 'cajas en uso'),
      blockers: contar(abiertos, 'turno de caja abierto', 'turnos de caja abiertos'),
    };
  });

  // ── Cajas ─────────────────────────────────────────────────────────────────
  route(app, {
    method: 'GET',
    url: '/cash-registers',
    security: { kind: 'permission', permission: 'cash:session:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const q = z.object({ branchId: z.string().uuid().optional() }).parse(request.query);
      const sede = sedeDeConsulta(request, 'cash:session:read', q.branchId);
      const rows = await new CashRegisterRepository(ctx.tenant.organizationId).list(sede ?? undefined);
      return { registers: rows };
    },
  });

  /** Renombrar o retirar una caja (DP-09). Con turno abierto no se retira. */
  route(app, {
    method: 'PATCH',
    url: '/cash-registers/:id',
    security: { kind: 'permission', permission: 'settings:branch' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({ name: z.string().trim().min(2).max(60).optional(), isActive: z.boolean().optional() }).parse(request.body);
      const registros = new CashRegisterRepository(ctx.tenant.organizationId);
      const antes = await registros.findById(id);
      if (!antes) throw notFound('Caja no encontrada');
      request.requirePermission('settings:branch', antes.branchId);
      if (body.isActive === false && await new CashSessionRepository(ctx.tenant.organizationId).findOpenForRegister(id)) {
        throw conflict('Esa caja tiene un turno abierto: ciérralo antes de retirarla');
      }
      // La última caja de una sede que usa Caja no se retira (19-07): sin caja no
      // hay turno ni cobro en efectivo. Si la sede ya no corta cajón, el camino es
      // dejar de usar Caja ahí (Módulos), y entonces sus cajas ni se tocan: la
      // puerta de la sede responde «Caja no se usa en esta sucursal».
      if (body.isActive === false && antes.isActive && await registros.countActive(antes.branchId) <= 1) {
        const sede = await new BranchRepository(ctx.tenant.organizationId).findById(antes.branchId);
        throw new DomainError('CONFLICT', `${antes.name} es la única caja de ${sede?.name ?? 'la sucursal'}: sin caja no se cobra en efectivo. Si ahí ya no se corta cajón, deja de usar Caja en esa sucursal desde Módulos.`, 'LAST_REGISTER');
      }
      const r = await registros.update(id, body);
      await new AuditService().record(ctx, {
        action: 'cash.register.update', resourceType: 'cash_register', resourceId: id, branchId: antes.branchId,
        beforeState: { name: antes.name, isActive: antes.isActive }, afterState: { name: r?.name, isActive: r?.isActive },
      });
      return r;
    },
  });

  route(app, {
    method: 'POST',
    url: '/cash-registers',
    security: { kind: 'permission', permission: 'settings:branch' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = z.object({
        branchId: z.string().uuid(),
        code: z.string().min(1).max(8).regex(/^[A-Za-z0-9]+$/),
        name: z.string().min(2).max(60),
      }).parse(request.body);
      request.authorize('settings:branch', { branchId: body.branchId });
      return reply.status(201).send(await service.createRegister(ctx, body));
    },
  });

  // ── Turno ─────────────────────────────────────────────────────────────────
  route(app, {
    method: 'POST',
    url: '/cash-sessions',
    security: { kind: 'permission', permission: 'cash:session:open' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = z.object({
        cashRegisterId: z.string().uuid(),
        openingFloatCents: z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos'),
        shiftLabel: z.enum(['MORNING', 'EVENING', 'NIGHT']).optional(),
      }).parse(request.body);

      const register = await new CashRegisterRepository(ctx.tenant.organizationId)
        .findById(body.cashRegisterId);
      if (!register) throw notFound('Caja no encontrada');
      request.authorize('cash:session:open', { branchId: register.branchId });

      const session = await service.openSession(ctx, {
        cashRegisterId: body.cashRegisterId,
        openingFloatCents: BigInt(body.openingFloatCents),
        ...(body.shiftLabel ? { shiftLabel: body.shiftLabel } : {}),
      });
      return reply.status(201).send(serializeSession(session, await nombresDe(ctx.tenant.organizationId, [session])));
    },
  });

  route(app, {
    method: 'GET',
    url: '/cash-sessions',
    security: { kind: 'permission', permission: 'cash:session:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const q = z.object({
        branchId: z.string().uuid().optional(),
        status: z.enum(['OPEN', 'CLOSED', 'RECONCILED']).optional(),
        businessDate: z.string().date().optional(),
      }).parse(request.query);
      const sede = sedeDeConsulta(request, 'cash:session:read', q.branchId);

      const rows = await new CashSessionRepository(ctx.tenant.organizationId).list({
        branchId: sede ?? undefined,
        status: q.status,
        businessDate: q.businessDate ? new Date(`${q.businessDate}T00:00:00.000Z`) : undefined,
      });
      const nombres = await nombresDe(ctx.tenant.organizationId, rows);
      return { sessions: rows.map((s) => serializeSession(s, nombres)) };
    },
  });

  /**
   * A QUÉ CAJÓN ENTRA EL COBRO (7-03, fase 1.4). Las cajas abiertas de la sede
   * para quien cobra, lleve Caja o no: solo nombres (qué caja, quién la abrió
   * y desde cuándo), sin cortes, fondo ni esperado. Antes, quien cobraba sin
   * llevar Caja no podía elegir y, con dos cajas abiertas, cada cobro suyo
   * respondía 422 «indica en cuál» sin tener dónde indicarlo.
   */
  route(app, {
    method: 'GET',
    url: '/cash-sessions/open-lite',
    security: { kind: 'permission', permission: 'payments:record', anyOf: ['pos:sale:create'] },
    schema: respuesta(200, OpenCashSessionsLite),
    handler: async (request) => {
      const ctx = request.ctx!;
      const q = z.object({ branchId: z.string().uuid() }).parse(request.query);
      // En esa sede tiene que poder cobrar (la mensualidad o la tienda).
      if (!request.holds('pos:sale:create', q.branchId)) request.requirePermission('payments:record', q.branchId);
      const orgId = ctx.tenant.organizationId;
      const [abiertas, cajas] = await Promise.all([
        new CashSessionRepository(orgId).listOpenForBranch(q.branchId),
        new CashRegisterRepository(orgId).list(q.branchId),
      ]);
      const nombres = await nombresDe(orgId, abiertas);
      const caja = new Map(cajas.map((c) => [c.id, c]));
      return {
        sessions: abiertas.map((s) => ({
          id: s.id,
          cashRegisterId: s.cashRegisterId,
          registerCode: caja.get(s.cashRegisterId)?.code ?? '',
          registerName: caja.get(s.cashRegisterId)?.name ?? 'Caja',
          openedByUserId: s.openedByUserId,
          openedByName: nombres.get(s.openedByUserId) ?? null,
          openedAt: s.openedAt.toISOString(),
        })),
      } satisfies OpenCashSessionsLite;
    },
  });

  /** Documento del turno. Es lo que recepción revisa antes de contar. */
  route(app, {
    method: 'GET',
    url: '/cash-sessions/:id',
    security: { kind: 'permission', permission: 'cash:session:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const reporte = await service.shiftReport(ctx, id);
      // El corte de otra sucursal no es asunto de esta recepción.
      request.requirePermission('cash:session:read', reporte.session.branchId);
      // Turno abierto: el esperado solo lo ve quien aprueba descuadres (la gerencia), nunca quien cuenta.
      const ciego = reporte.session.status === 'OPEN' && !request.holds('cash:variance:approve', reporte.session.branchId);
      return serializeReport(reporte, await nombresDe(ctx.tenant.organizationId, [reporte.session]), ciego);
    },
  });

  route(app, {
    method: 'POST',
    url: '/cash-sessions/:id/close',
    security: { kind: 'permission', permission: 'cash:session:close' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        countedCashCents: z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos'),
        varianceReason: z.string().min(3).max(300).optional(),
      }).parse(request.body);

      const session = await new CashSessionRepository(ctx.tenant.organizationId).findById(id);
      if (!session) throw notFound('Turno no encontrado');
      request.authorize('cash:session:close', { branchId: session.branchId });
      // El turno es de quien lo abrió (UX5-M-06): recepción y caja cortan el
      // SUYO. Cortar el de otra persona es de quien aprueba descuadres
      // (encargado o gerente), porque el faltante queda a nombre del otro.
      if (session.openedByUserId !== ctx.tenant.actorUserId && !request.holds('cash:variance:approve', session.branchId)) {
        throw forbidden('Este turno lo abrió otra persona: el corte lo hace ella o el gerente.');
      }

      const { session: cerrada, varianceCents } = await service.closeSession(ctx, {
        sessionId: id,
        countedCashCents: BigInt(body.countedCashCents),
        varianceReason: body.varianceReason ?? null,
      });
      return {
        ...serializeSession(cerrada, await nombresDe(ctx.tenant.organizationId, [cerrada])),
        varianceCents: cents(varianceCents),
        varianceLabel: formatMoney(money(varianceCents)),
        varianceKind: varianceCents === 0n ? 'EXACT' : varianceCents < 0n ? 'SHORT' : 'OVER',
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/cash-sessions/:id/movements',
    security: { kind: 'permission', permission: 'cash:withdraw' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        movementType: z.enum(['FLOAT_IN', 'WITHDRAWAL', 'EXPENSE', 'DEPOSIT', 'CORRECTION']),
        amountCents: z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos'),
        reason: z.string().min(3).max(300),
        sign: z.union([z.literal(1), z.literal(-1)]).optional(),
        approvalToken: z.string().min(20).max(200).optional(),
      }).parse(request.body);

      const session = await new CashSessionRepository(ctx.tenant.organizationId).findById(id);
      if (!session) throw notFound('Turno no encontrado');

      // El límite de retiro por turno es acumulado, no por movimiento: si no,
      // bastaría partir un retiro grande en varios pequeños para esquivarlo.
      const yaRetirado = await new CashSessionRepository(ctx.tenant.organizationId)
        .withdrawnByUserCents(id, ctx.tenant.actorUserId ?? '00000000-0000-0000-0000-000000000000');
      const acumulado = yaRetirado + BigInt(body.amountCents);

      const aprobador = await request.verifyApprover(body.approvalToken, 'cash:withdraw', { branchId: session.branchId, resourceType: 'CashSession', resourceId: session.id, amountCents: BigInt(body.amountCents) });
      request.authorize('cash:withdraw', {
        branchId: session.branchId,
        reason: body.reason,
        amountCents: acumulado,
        ...(aprobador ? { approvedByUserId: aprobador } : {}),
      });

      const movimiento = await service.addMovement(ctx, {
        sessionId: id,
        movementType: body.movementType,
        amountCents: BigInt(body.amountCents),
        reason: body.reason,
        ...(body.sign ? { sign: body.sign } : {}),
        approvedByUserId: aprobador,
      });
      return reply.status(201).send(serializeMovement(movimiento));
    },
  });

  // La cartera (`GET /portfolio`) y los motivos de descuento (`GET /discount-reasons`)
  // son de cobranza: viven en `billing/portfolio.routes.ts` (28-07).
}
