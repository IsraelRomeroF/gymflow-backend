import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  conflict, DomainError, formatMoney, forbidden, money, notFound, validation, LIMITES_DE_LOS_TOPES_DEL_CAJON, type CashMovementType,
} from '@gymflow/core';
import {
  CashAlerts, CashLimits, CashMovement, CashSession, CashSessionList, CashShiftAllowance, CloseCashSessionResult,
  OpenCashSessionsLite, OwnerDrawFromDrawer, ShiftReport as ShiftReportContract,
} from '@gymflow/core/contracts';
import { CashSettingsRepository } from './cash-settings.repository.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { sedeDeConsulta } from '../../platform/http/branch-scope.js';
import { contar, registerModuleUsage } from '../../platform/modules/usage.js';
import { BranchRepository } from '../organization/index.js';
import { CashRegisterRepository, CashSessionRepository, type CashMovementRecord, type CashSessionRecord } from './cash.repository.js';
import { CashService, type ShiftReport } from './cash.service.js';
import { CashAlertsService } from './cash-alerts.service.js';
import { UserRepository } from '../identity/index.js';

const idParam = z.object({ id: z.string().uuid() });

/** El cursor de `GET /cash-sessions` (bloque 4.11): hora de apertura e id del último turno de la página anterior. */
function leerCursorDeTurnos(texto: string): { openedAt: Date; id: string } {
  try {
    const partes: unknown = JSON.parse(Buffer.from(texto, 'base64url').toString('utf8'));
    const [cuando, id] = z.tuple([z.string().datetime(), z.string().uuid()]).parse(partes);
    return { openedAt: new Date(cuando), id };
  } catch {
    throw validation('Esa página ya no existe. Vuelve a abrir la lista.');
  }
}
const cents = (v: bigint): string => v.toString();
const iso = (d: Date): string => d.toISOString().slice(0, 10);

type Nombres = ReadonlyMap<string, string>;

/** Quién abrió, quién cerró y quién revisó: el corte responde por personas, no por ids. */
async function nombresDe(orgId: string, sessions: readonly CashSessionRecord[]): Promise<Nombres> {
  const ids = sessions.flatMap((s) => [s.openedByUserId, ...(s.closedByUserId ? [s.closedByUserId] : []), ...(s.varianceReviewedByUserId ? [s.varianceReviewedByUserId] : [])]);
  return new UserRepository(orgId).namesById(ids);
}

function serializeSession(s: CashSessionRecord, nombres: Nombres = new Map()): CashSession {
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
    // D-17 (bloque 4.3): el descuadre es de quien abrió, y su revisión.
    responsibleUserId: s.openedByUserId,
    responsibleName: nombres.get(s.openedByUserId) ?? null,
    varianceStatus: s.varianceStatus,
    varianceReviewedByUserId: s.varianceReviewedByUserId,
    varianceReviewedByName: s.varianceReviewedByUserId ? nombres.get(s.varianceReviewedByUserId) ?? null : null,
    varianceReviewedAt: s.varianceReviewedAt?.toISOString() ?? null,
    varianceReviewNote: s.varianceReviewNote,
  };
}

function serializeMovement(m: CashMovementRecord): CashMovement {
  return {
    id: m.id,
    movementType: m.movementType,
    amountCents: cents(m.amountCents),
    amountLabel: formatMoney(money(m.amountCents)),
    reason: m.reason,
    createdByUserId: m.createdByUserId,
    approvedByUserId: m.approvedByUserId,
    at: m.at.toISOString(),
    ownerDraw: m.expenseId !== null,
  };
}

/**
 * `ciego`: el turno sigue abierto y quien pide es quien va a contarlo. El
 * corte ciego solo mide si el esperado NO llega a la pantalla antes del
 * conteo (MC-07): se omiten el esperado y lo cobrado en efectivo.
 */
function serializeReport(r: ShiftReport, nombres: Nombres, ciego = false): ShiftReportContract {
  const sinEfectivo = <M extends string>(xs: ReadonlyArray<{ method: M; amountCents: bigint }>) => xs.filter((x) => !ciego || x.method !== 'CASH');
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
    schema: respuesta(201, CashSession),
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
    schema: respuesta(200, CashSessionList),
    handler: async (request): Promise<CashSessionList> => {
      const ctx = request.ctx!;
      const q = z.object({
        branchId: z.string().uuid().optional(),
        status: z.enum(['OPEN', 'CLOSED', 'RECONCILED']).optional(),
        businessDate: z.string().date().optional(),
        // Vista «Cortes» (D-17, bloque 4.3): por rango de días, por quién abrió y por su diferencia
        // (`PENDING` por revisar, `REVIEWED` revisados, `ANY` todo el que no cuadró).
        from: z.string().date().optional(),
        to: z.string().date().optional(),
        openedByUserId: z.string().uuid().optional(),
        variance: z.enum(['PENDING', 'REVIEWED', 'ANY']).optional(),
        limit: z.coerce.number().int().min(1).max(300).optional(),
        /** Página siguiente (bloque 4.11): el `nextCursor` de la respuesta anterior, con los mismos filtros. */
        cursor: z.string().max(200).optional(),
      }).parse(request.query);
      const antesDe = q.cursor ? leerCursorDeTurnos(q.cursor) : undefined;
      const limite = q.limit ?? 100;
      const sede = sedeDeConsulta(request, 'cash:session:read', q.branchId);
      const dia = (d: string | undefined) => (d ? new Date(`${d}T00:00:00.000Z`) : undefined);

      // Uno de más para saber si hay otra página sin contar toda la tabla.
      const leidos = await new CashSessionRepository(ctx.tenant.organizationId).list({
        branchId: sede ?? undefined,
        status: q.status,
        businessDate: dia(q.businessDate),
        from: dia(q.from), to: dia(q.to),
        openedByUserId: q.openedByUserId,
        variance: q.variance,
        limit: limite + 1,
        before: antesDe,
      });
      const rows = leidos.slice(0, limite);
      const ultimo = leidos.length > limite ? rows.at(-1) : undefined;
      const nombres = await nombresDe(ctx.tenant.organizationId, rows);
      return {
        sessions: rows.map((s) => serializeSession(s, nombres)),
        nextCursor: ultimo ? Buffer.from(JSON.stringify([ultimo.openedAt.toISOString(), ultimo.id])).toString('base64url') : null,
      };
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
    schema: respuesta(200, ShiftReportContract),
    handler: async (request): Promise<ShiftReportContract> => {
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
    schema: respuesta(200, CloseCashSessionResult),
    handler: async (request): Promise<CloseCashSessionResult> => {
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
      // (encargado o gerente), y el faltante sigue siendo de quien abrió (D-17).
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

  /**
   * MOVIMIENTOS DEL CAJÓN (D-15, bloque 3.5), en dos rutas porque son dos
   * permisos y una escritura dice con UNO lo que autoriza:
   *
   *  · `/petty-movements` (`cash:petty:record`): entrada de fondo y gasto
   *    chico. Con motivo y sin firma hasta el tope del gimnasio por turno.
   *  · `/movements` (`cash:withdraw`): retiro, depósito y corrección, siempre
   *    con firma. Sigue aceptando fondo y gasto de quien tiene los dos permisos.
   *
   * Cuándo se pide la firma y hasta cuánto lo decide el servicio con
   * `reglaDelCajon`, que ve el turno y los topes; aquí van el permiso, la
   * sede, el motivo y que la firma, si viene, sea para ESTE turno.
   */
  const cuerpoDeMovimiento = <T extends [string, ...string[]]>(tipos: T) => z.object({
    movementType: z.enum(tipos),
    amountCents: z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos'),
    reason: z.string().min(3).max(300),
    sign: z.union([z.literal(1), z.literal(-1)]).optional(),
    approvalToken: z.string().min(20).max(200).optional(),
  });
  const esChico = (t: string) => t === 'FLOAT_IN' || t === 'EXPENSE';

  async function turnoDe(request: FastifyRequest, id: string): Promise<CashSessionRecord> {
    const session = await new CashSessionRepository(request.ctx!.tenant.organizationId).findById(id);
    if (!session) throw notFound('Turno no encontrado');
    return session;
  }

  async function mover(request: FastifyRequest, session: CashSessionRecord, body: { movementType: string; amountCents: string; reason: string; sign?: 1 | -1 | undefined; approvalToken?: string | undefined }) {
    const ctx = request.ctx!;
    const id = session.id;
    const aprobador = await request.verifyApprover(body.approvalToken, 'cash:withdraw', { branchId: session.branchId, resourceType: 'CashSession', resourceId: session.id, amountCents: BigInt(body.amountCents) });
    request.authorize(esChico(body.movementType) ? 'cash:petty:record' : 'cash:withdraw', {
      branchId: session.branchId,
      reason: body.reason,
      amountCents: BigInt(body.amountCents),
      ...(aprobador ? { approvedByUserId: aprobador } : {}),
    });
    return serializeMovement(await service.addMovement(ctx, {
      sessionId: id,
      movementType: body.movementType as CashMovementType,
      amountCents: BigInt(body.amountCents),
      reason: body.reason,
      ...(body.sign ? { sign: body.sign } : {}),
      approvedByUserId: aprobador,
    }));
  }

  route(app, {
    method: 'POST',
    url: '/cash-sessions/:id/movements',
    security: { kind: 'permission', permission: 'cash:withdraw' },
    schema: respuesta(201, CashMovement),
    handler: async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = cuerpoDeMovimiento(['FLOAT_IN', 'WITHDRAWAL', 'EXPENSE', 'DEPOSIT', 'CORRECTION']).parse(request.body);
      const session = await turnoDe(request, id);
      // La sede del turno: quien retira en una sucursal no mueve el cajón de otra.
      request.requirePermission('cash:withdraw', session.branchId);
      return reply.status(201).send(await mover(request, session, body));
    },
  });

  route(app, {
    method: 'POST',
    url: '/cash-sessions/:id/petty-movements',
    security: { kind: 'permission', permission: 'cash:petty:record' },
    schema: respuesta(201, CashMovement),
    handler: async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = cuerpoDeMovimiento(['FLOAT_IN', 'EXPENSE']).parse(request.body);
      const session = await turnoDe(request, id);
      request.requirePermission('cash:petty:record', session.branchId);
      return reply.status(201).send(await mover(request, session, body));
    },
  });

  // ── D-17 · Caja, fase 4 (bloque 4.3) ─────────────────────────────────────

  /**
   * LA GERENCIA REVISA UN DESCUADRE Y LO CIERRA CON SU NOTA (D-17 b). Solo los
   * cortes «por revisar» (más de $20 de diferencia). El descuadre sigue siendo
   * de quien abrió el turno; la nota dice qué se resolvió. No descuenta nada.
   */
  route(app, {
    method: 'POST',
    url: '/cash-sessions/:id/variance/review',
    security: { kind: 'permission', permission: 'cash:variance:approve' },
    schema: respuesta(200, CashSession),
    handler: async (request): Promise<CashSession> => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({ note: z.string().trim().min(3).max(500) }).parse(request.body);
      const session = await turnoDe(request, id);
      request.authorize('cash:variance:approve', { branchId: session.branchId, reason: body.note });
      const revisada = await service.reviewVariance(ctx, { sessionId: id, note: body.note });
      return serializeSession(revisada, await nombresDe(ctx.tenant.organizationId, [revisada]));
    },
  });

  /**
   * CUÁNTO LE QUEDA A ESTA PERSONA EN ESTE TURNO (defecto D1 de 3.13): la
   * pantalla lo dice ANTES de pedir la firma, en vez de que el 403 llegue
   * cuando la dueña ya tecleó su contraseña. Topes y lo ya anotado; nada del
   * efectivo del cajón (el corte sigue ciego).
   */
  route(app, {
    method: 'GET',
    url: '/cash-sessions/:id/allowance',
    security: { kind: 'permission', permission: 'cash:withdraw', anyOf: ['cash:petty:record'] },
    schema: respuesta(200, CashShiftAllowance),
    handler: async (request): Promise<CashShiftAllowance> => {
      const { id } = idParam.parse(request.params);
      const session = await turnoDe(request, id);
      // En la sede del turno tiene que poder mover el cajón (retirar o anotar gasto chico).
      if (!request.holds('cash:petty:record', session.branchId)) request.requirePermission('cash:withdraw', session.branchId);
      const a = await service.allowance(request.ctx!, session);
      const c = (v: bigint | null) => (v === null ? null : cents(v));
      return {
        sessionId: a.sessionId,
        withdrawal: { role: a.withdrawal.role, limitCents: c(a.withdrawal.limitCents), usedCents: cents(a.withdrawal.usedCents), remainingCents: c(a.withdrawal.remainingCents) },
        petty: { limitCents: cents(a.petty.limitCents), floatInRemainingCents: cents(a.petty.floatInRemainingCents), expenseRemainingCents: cents(a.petty.expenseRemainingCents) },
      };
    },
  });

  /**
   * «RETIRO DEL DUEÑO» DESDE EL CAJÓN: el retiro y su anotación en Movimientos
   * en un solo acto (ver `CashService.ownerDraw`). Para el cajón es un retiro:
   * mismo permiso, misma firma de la dueña y mismo tope por turno (D-15).
   */
  route(app, {
    method: 'POST',
    url: '/cash-sessions/:id/owner-draw',
    security: { kind: 'permission', permission: 'cash:withdraw' },
    schema: respuesta(201, OwnerDrawFromDrawer),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        amountCents: z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos'),
        reason: z.string().trim().min(3).max(200),
        approvalToken: z.string().min(20).max(200).optional(),
      }).parse(request.body);
      const session = await turnoDe(request, id);
      request.requirePermission('cash:withdraw', session.branchId);
      const amountCents = BigInt(body.amountCents);
      const aprobador = await request.verifyApprover(body.approvalToken, 'cash:withdraw', { branchId: session.branchId, resourceType: 'CashSession', resourceId: session.id, amountCents });
      request.authorize('cash:withdraw', { branchId: session.branchId, reason: body.reason, amountCents, ...(aprobador ? { approvedByUserId: aprobador } : {}) });
      const r = await service.ownerDraw(ctx, { sessionId: id, amountCents, reason: body.reason, approvedByUserId: aprobador });
      return reply.status(201).send({
        movement: serializeMovement(r.movement), expenseId: r.expenseId, month: r.periodMonth.toISOString().slice(0, 7),
      } satisfies OwnerDrawFromDrawer);
    },
  });

  /**
   * LO QUE LA CAJA TIENE SIN RESOLVER, en las sedes de quien pregunta: cajas
   * abiertas (y cuáles amanecieron sin cortar) y descuadres por revisar. Es de
   * solo lectura: lo ve quien ve los cortes (la dueña incluida).
   */
  route(app, {
    method: 'GET',
    url: '/cash/alerts',
    security: { kind: 'permission', permission: 'cash:session:read' },
    schema: respuesta(200, CashAlerts),
    handler: async (request): Promise<CashAlerts> => {
      const orgId = request.ctx!.tenant.organizationId;
      const q = z.object({ branchId: z.string().uuid().optional() }).parse(request.query);
      if (q.branchId) request.requirePermission('cash:session:read', q.branchId);
      // Sin sede: todas las suyas (nulo = todo el gimnasio).
      const sedes = q.branchId ? [q.branchId] : request.branchScope('cash:session:read');
      const avisos = new CashAlertsService();
      const [abiertas, porRevisar] = await Promise.all([avisos.open(orgId, sedes), avisos.pendingVariances(orgId, sedes)]);
      const nombres = await new UserRepository(orgId).namesById(abiertas.map((a) => a.openedByUserId));
      return {
        asOf: new Date().toISOString(),
        open: abiertas.map((a) => ({
          id: a.id, branchId: a.branchId, branchName: a.branchName, registerName: a.registerName,
          openedByUserId: a.openedByUserId, openedByName: nombres.get(a.openedByUserId) ?? null,
          openedAt: a.openedAt.toISOString(), businessDate: iso(a.businessDate), stale: a.stale,
        })),
        staleCount: abiertas.filter((a) => a.stale).length,
        pendingVariances: {
          count: porRevisar.count, shortageCents: cents(porRevisar.shortageCents), overageCents: cents(porRevisar.overageCents),
          oldestBusinessDate: porRevisar.oldestBusinessDate ? iso(porRevisar.oldestBusinessDate) : null,
        },
      };
    },
  });

  // ── Los topes del cajón (D-15, bloque 3.5) ───────────────────────────────
  const serializarTopes = (t: { pettyLimitCents: bigint; withdrawalShiftLimitCents: bigint; isDefault: boolean }): CashLimits => ({
    pettyLimitCents: cents(t.pettyLimitCents), withdrawalShiftLimitCents: cents(t.withdrawalShiftLimitCents), isDefault: t.isDefault,
    max: { pettyLimitCents: cents(LIMITES_DE_LOS_TOPES_DEL_CAJON.pettyMaxCents), withdrawalShiftLimitCents: cents(LIMITES_DE_LOS_TOPES_DEL_CAJON.withdrawalMaxCents) },
  });

  /** Los ve quien ve la caja: el diálogo de movimientos dice hasta cuánto se anota sin firma. */
  route(app, {
    method: 'GET',
    url: '/cash/limits',
    security: { kind: 'permission', permission: 'cash:session:read', anyOf: ['cash:petty:record', 'cash:withdraw'] },
    schema: respuesta(200, CashLimits),
    handler: async (request): Promise<CashLimits> => serializarTopes(await new CashSettingsRepository(request.ctx!.tenant.organizationId).get()),
  });

  /**
   * Cambiarlos es de la gerencia, SIEMPRE con la firma de la dueña: son los
   * topes que limitan a la propia gerencia. Valen para todo el gimnasio.
   */
  route(app, {
    method: 'PUT',
    url: '/cash/limits',
    security: { kind: 'permission', permission: 'cash:limits:set' },
    schema: respuesta(200, CashLimits),
    handler: async (request): Promise<CashLimits> => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const importe = (max: bigint) => z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos').refine((v) => BigInt(v) <= max, 'Pasa del máximo permitido');
      const body = z.object({
        pettyLimitCents: importe(LIMITES_DE_LOS_TOPES_DEL_CAJON.pettyMaxCents),
        withdrawalShiftLimitCents: importe(LIMITES_DE_LOS_TOPES_DEL_CAJON.withdrawalMaxCents),
        reason: z.string().min(3).max(300),
        approvalToken: z.string().min(20).max(200).optional(),
      }).parse(request.body);
      const aprobador = await request.verifyApprover(body.approvalToken, 'cash:limits:set', { branchId: null, resourceType: 'CashLimits', resourceId: orgId });
      request.authorize('cash:limits:set', { branchId: null, reason: body.reason, ...(aprobador ? { approvedByUserId: aprobador } : {}) });
      const repo = new CashSettingsRepository(orgId);
      const despues = await enUnaTransaccion(async () => {
        const antes = await repo.get();
        const nuevo = await repo.set({ pettyLimitCents: BigInt(body.pettyLimitCents), withdrawalShiftLimitCents: BigInt(body.withdrawalShiftLimitCents), userId: ctx.tenant.actorUserId ?? null });
        await new AuditService().record(ctx, {
          action: 'cash.limits.update', resourceType: 'Organization', resourceId: orgId,
          beforeState: { pettyLimitCents: antes.pettyLimitCents.toString(), withdrawalShiftLimitCents: antes.withdrawalShiftLimitCents.toString() },
          afterState: { pettyLimitCents: nuevo.pettyLimitCents.toString(), withdrawalShiftLimitCents: nuevo.withdrawalShiftLimitCents.toString() },
          reason: body.reason, approvedByUserId: aprobador,
        });
        return nuevo;
      });
      return serializarTopes(despues);
    },
  });

  // La cartera (`GET /portfolio`) y los motivos de descuento (`GET /discount-reasons`)
  // son de cobranza: viven en `billing/portfolio.routes.ts` (28-07).
}
