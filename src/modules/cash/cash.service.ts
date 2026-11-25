import {
  canClose, computeVariance, conflict, expectedCash, formatMoney, money,
  movementSignIsValid, notFound, signedMovementAmount,
  summarizeShift, validation, DomainError, reglaDelCajon, topeDeRetiroDelPuesto, retiroDisponibleDelPuesto,
  type CashMovementType, type Money, type PaymentMethodType, type TopeDeRetiroDelPuesto,
} from '@gymflow/core';
import { BranchRepository } from '../organization/index.js';
import { CashRegisterRepository, CashSessionRepository, type CashMovementRecord, type CashRegisterRecord, type CashSessionRecord } from './cash.repository.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { RequestContext } from '../../platform/context.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { conPuntoDeRetorno, enUnidadDeDinero } from '../../platform/db/unit-of-work.js';
import { CashSettingsRepository } from './cash-settings.repository.js';
import { ExpensesRepository, MonthlyCloseService } from '../finance/index.js';

/** Documento del turno: lo que recepción firma al cerrar. */
export type ShiftReport = {
  session: CashSessionRecord;
  register: CashRegisterRecord;
  byMethod: Array<{ method: PaymentMethodType; amountCents: bigint }>;
  totalCollectedCents: bigint;
  cashCollectedCents: bigint;
  movementsCents: bigint;
  movements: CashMovementRecord[];
  /** Aportes de otros módulos (hoy: producto). Ver `shift-contributors.ts`. */
  contributions: Array<{ source: string; byMethod: Array<{ method: PaymentMethodType; amountCents: bigint }> }>;
  expectedCashCents: bigint;
  /** Nulo mientras la sesión está abierta: ver `close()`. */
  countedCashCents: bigint | null;
  varianceCents: bigint | null;
};

/** Lo que a una persona le queda por mover en un turno (bloque 4.3). */
export type ShiftAllowance = {
  sessionId: string;
  withdrawal: { role: TopeDeRetiroDelPuesto; limitCents: bigint | null; usedCents: bigint; remainingCents: bigint | null };
  petty: { limitCents: bigint; floatInRemainingCents: bigint; expenseRemainingCents: bigint };
};

/** El «Retiro del dueño» en Movimientos (`operating_expenses.category`). */
const RETIRO_DEL_DUENO = 'OWNER_DRAW';

export class CashService {
  private readonly audit = new AuditService();

  private async businessDate(organizationId: string, branchId: string | null): Promise<Date> {
    return new BusinessCalendar(organizationId).today(branchId);
  }

  // ── Cajas ─────────────────────────────────────────────────────────────────

  async createRegister(ctx: RequestContext, input: {
    branchId: string; code: string; name: string;
  }): Promise<CashRegisterRecord> {
    const orgId = ctx.tenant.organizationId;
    const branch = await new BranchRepository(orgId).findById(input.branchId);
    if (!branch) throw notFound('Sucursal no encontrada');

    const register = await new CashRegisterRepository(orgId).create(input);
    await this.audit.record(ctx, {
      action: 'cash.register.create',
      resourceType: 'cash_register',
      resourceId: register.id,
      afterState: { code: register.code, name: register.name },
      branchId: input.branchId,
    });
    return register;
  }

  // ── Turno ─────────────────────────────────────────────────────────────────

  /**
   * Abre turno. El fondo se declara al abrir, no se hereda del cierre
   * anterior: heredarlo arrastraría un faltante de ayer al corte de hoy y lo
   * volvería inatribuible.
   */
  async openSession(ctx: RequestContext, input: {
    cashRegisterId: string; openingFloatCents: bigint; shiftLabel?: string | null;
  }): Promise<CashSessionRecord> {
    const orgId = ctx.tenant.organizationId;
    const userId = ctx.tenant.actorUserId;
    if (!userId) throw validation('Abrir caja exige un usuario: el turno responde por una persona');

    const register = await new CashRegisterRepository(orgId).findById(input.cashRegisterId);
    if (!register) throw notFound('Caja no encontrada');
    if (!register.isActive) throw validation('La caja está inactiva');
    if (input.openingFloatCents < 0n) throw validation('El fondo no puede ser negativo');

    const sessions = new CashSessionRepository(orgId);
    const abierta = await sessions.findOpenForRegister(input.cashRegisterId);
    if (abierta) {
      throw conflict(
        `La caja ${register.code} ya tiene un turno abierto desde ${abierta.openedAt.toISOString()}. ` +
        'Ciérralo antes de abrir otro',
      );
    }

    const session = await sessions.open({
      branchId: register.branchId,
      cashRegisterId: register.id,
      openedByUserId: userId,
      openingFloatCents: input.openingFloatCents,
      businessDate: await this.businessDate(orgId, register.branchId),
      shiftLabel: input.shiftLabel ?? null,
    });

    await this.audit.record(ctx, {
      action: 'cash.session.open',
      resourceType: 'cash_session',
      resourceId: session.id,
      afterState: { register: register.code, openingFloatCents: session.openingFloatCents.toString() },
      branchId: register.branchId,
    });
    return session;
  }

  /**
   * Documento del turno.
   *
   * Mientras la sesión está ABIERTA se devuelve el detalle por método pero
   * `expectedCashCents` también, porque recepción necesita saber cuánto
   * debería haber para hacer un retiro. Lo que NO se hace es rellenar el
   * conteo: eso lo teclea una persona mirando el cajón.
   */
  async shiftReport(ctx: RequestContext, sessionId: string): Promise<ShiftReport> {
    const orgId = ctx.tenant.organizationId;
    const sessions = new CashSessionRepository(orgId);

    const session = await sessions.findById(sessionId);
    if (!session) throw notFound('Turno no encontrado');

    const register = await new CashRegisterRepository(orgId).findById(session.cashRegisterId);
    if (!register) throw notFound('Caja no encontrada');

    const totales = await sessions.paymentTotals(sessionId);
    const aportes = await sessions.contributions(sessionId);
    const movimientos = await sessions.movementTotalCents(sessionId);

    // UN SOLO DOCUMENTO: membresías y producto en la misma cuenta. Separarlos
    // obligaría a recepción a sumar dos papeles a mano, que es exactamente lo
    // que hace hoy y por lo que los cortes no cuadran.
    const todo = [
      ...totales,
      ...aportes.flatMap((a) => a.byMethod),
    ];
    const resumen = summarizeShift(todo.map((t) => ({ method: t.method, amount: money(t.amountCents) })));

    const esperado = session.expectedCashCents ?? expectedCash({
      openingFloat: money(session.openingFloatCents),
      cashCollected: resumen.cashCollected,
      movements: [money(movimientos)],
    }).cents;

    return {
      session,
      register,
      byMethod: [...resumen.byMethod].map(([method, amount]) => ({ method, amountCents: amount.cents })),
      contributions: aportes,
      totalCollectedCents: resumen.total.cents,
      cashCollectedCents: resumen.cashCollected.cents,
      movementsCents: movimientos,
      movements: await sessions.listMovements(sessionId),
      expectedCashCents: esperado,
      countedCashCents: session.countedCashCents,
      varianceCents: session.varianceCents,
    };
  }

  /**
   * Cierra turno con conteo obligatorio.
   *
   * El esperado se calcula AQUÍ, después de recibir el conteo. Si la pantalla
   * mostrara el esperado antes, el cajero teclearía esa cifra y el corte
   * dejaría de medir nada.
   */
  async closeSession(ctx: RequestContext, input: {
    sessionId: string; countedCashCents: bigint; varianceReason?: string | null;
  }): Promise<{ session: CashSessionRecord; varianceCents: bigint }> {
    const orgId = ctx.tenant.organizationId;
    const userId = ctx.tenant.actorUserId;
    if (!userId) throw validation('Cerrar caja exige un usuario');

    const sessions = new CashSessionRepository(orgId);
    const session = await sessions.findById(input.sessionId);
    if (!session) throw notFound('Turno no encontrado');
    if (input.countedCashCents < 0n) throw validation('El conteo no puede ser negativo');

    if (session.status !== 'OPEN') throw validation('Ese turno ya está cerrado');

    // D-17 (bloque 4.3): el cierre y su asiento se confirman juntos, en el turno de dinero del gimnasio.
    // Bloque 4.16: el conteo también va dentro del turno (antes iba suelto, antes de pedirlo, y peleaba la
    // fila del turno con el cierre en curso: el reintento de un corte lento caía en 500 «lock timeout»).
    // Sigue conservándose aunque el cierre se rechace: el cierre corre tras un punto de retorno y, si
    // falla, se deshace solo él; el conteo se confirma y el error se lanza después.
    const r = await enUnidadDeDinero(orgId, async () => {
      // El conteo se anota ANTES de decir si cuadra (UXA-02): ver cuánto debía
      // haber y recontar exactamente esa cifra ya no tapa un faltante.
      const primero = await sessions.recordCount(input.sessionId, input.countedCashCents);
      if (primero === null) return { ok: false as const, error: validation('Ese turno ya está cerrado') };
      const esReconteo = primero !== input.countedCashCents;
      if (esReconteo && !input.varianceReason?.trim()) {
        return {
          ok: false as const,
          error: validation(
            `Es un segundo conteo: el primero fue de ${formatMoney(money(primero))}. ` +
            'Explica por qué cambió; los dos conteos quedan en el corte',
          ),
        };
      }
      return conPuntoDeRetorno(() => this.cerrarConConteo(ctx, session, userId, input, primero));
    });
    if (!r.ok) throw r.error;
    return r.valor;
  }

  /** El cierre propiamente dicho, ya con el turno de dinero y el conteo anotado (`closeSession`). */
  private async cerrarConConteo(
    ctx: RequestContext,
    session: CashSessionRecord,
    userId: string,
    input: { sessionId: string; countedCashCents: bigint; varianceReason?: string | null },
    primero: bigint,
  ): Promise<{ session: CashSessionRecord; varianceCents: bigint }> {
    const sessions = new CashSessionRepository(ctx.tenant.organizationId);
    {
      let esperadoCents = 0n;
      const cerrada: CashSessionRecord = await sessions.closeLocked({
        sessionId: input.sessionId,
        closedByUserId: userId,
        countedCashCents: input.countedCashCents,
        varianceReason: input.varianceReason ?? null,
        // Se calcula con el turno ya bloqueado: ningún cobro entra a medias.
        calcular: async () => {
          esperadoCents = await sessions.expectedCashCents(session);
          const veredicto = canClose({
            status: session.status,
            counted: money(input.countedCashCents),
            varianceReason: input.varianceReason ?? null,
            expected: money(esperadoCents),
          });
          if (!veredicto.ok) {
            const { variance } = computeVariance(money(esperadoCents), money(input.countedCashCents));
            throw validation(`${veredicto.reason} (diferencia: ${variance.cents} centavos)`);
          }
          return { expectedCashCents: esperadoCents };
        },
      });

      await this.audit.record(ctx, {
        action: 'cash.session.close',
        resourceType: 'cash_session',
        resourceId: cerrada.id,
        beforeState: { status: 'OPEN' },
        afterState: {
          expectedCashCents: esperadoCents.toString(),
          countedCashCents: input.countedCashCents.toString(),
          firstCountedCashCents: primero.toString(),
          varianceCents: cerrada.varianceCents?.toString() ?? '0',
          // D-17: el descuadre es de quien ABRIÓ, lo corte quien lo corte.
          responsibleUserId: session.openedByUserId,
          closedByOther: session.openedByUserId !== userId,
          varianceStatus: cerrada.varianceStatus,
        },
        reason: input.varianceReason ?? null,
        branchId: session.branchId,
      });

      return { session: cerrada, varianceCents: cerrada.varianceCents ?? 0n };
    }
  }

  /**
   * D-17 (b): la gerencia revisa un corte con más de $20 de diferencia y lo
   * cierra con su nota. No mueve dinero ni cambia la diferencia (que ya cuenta
   * en su día desde el corte): por eso se puede revisar aunque el mes del corte
   * ya esté cerrado. Qué se hace con el faltante (hablarlo, reponerlo) se
   * escribe en la nota; descontarlo del sueldo no lo hace el sistema.
   */
  async reviewVariance(ctx: RequestContext, input: { sessionId: string; note: string }): Promise<CashSessionRecord> {
    const orgId = ctx.tenant.organizationId;
    const userId = ctx.tenant.actorUserId;
    if (!userId) throw validation('Revisar un descuadre exige un usuario');
    const nota = input.note.trim();
    if (nota.length < 3) throw validation('Escribe la nota de la revisión');

    return enUnidadDeDinero(orgId, async () => {
      const sessions = new CashSessionRepository(orgId);
      const session = await sessions.findById(input.sessionId);
      if (!session) throw notFound('Turno no encontrado');
      const hecho = session.varianceStatus === 'PENDING'
        && await sessions.reviewVariance(session.id, { userId, note: nota, at: new Date() });
      if (!hecho) {
        throw conflict(
          session.varianceStatus === 'REVIEWED' ? 'Ese descuadre ya se revisó' : 'Ese corte no tiene una diferencia por revisar',
          'VARIANCE_NOT_PENDING',
        );
      }
      const v = session.varianceCents ?? 0n;
      await this.audit.record(ctx, {
        action: 'cash.variance.review',
        resourceType: 'cash_session',
        resourceId: session.id,
        beforeState: { varianceStatus: 'PENDING' },
        afterState: {
          varianceStatus: 'REVIEWED',
          varianceCents: v.toString(),
          amountCents: (v < 0n ? -v : v).toString(),
          responsibleUserId: session.openedByUserId,
          ownShift: session.openedByUserId === userId,
        },
        reason: nota,
        branchId: session.branchId,
      });
      const revisada = await sessions.findById(session.id);
      if (!revisada) throw notFound('Turno no encontrado');
      return revisada;
    });
  }

  /**
   * Lo que a ESTA persona le queda por mover en ESTE turno (bloque 4.3): la
   * pantalla lo dice antes de pedir la firma. Es la misma cuenta que hace
   * `addMovement` con `reglaDelCajon`; no revela nada del efectivo del cajón.
   */
  async allowance(ctx: RequestContext, session: CashSessionRecord): Promise<ShiftAllowance> {
    const orgId = ctx.tenant.organizationId;
    const userId = ctx.tenant.actorUserId;
    if (!userId) throw validation('Los topes del turno son de una persona');
    const sessions = new CashSessionRepository(orgId);
    const [topes, retirado, fondo, gasto] = await Promise.all([
      new CashSettingsRepository(orgId).get(),
      sessions.withdrawnByUserCents(session.id, userId),
      sessions.unsignedInSessionCents(session.id, 'FLOAT_IN'),
      sessions.unsignedInSessionCents(session.id, 'EXPENSE'),
    ]);
    const puesto = topeDeRetiroDelPuesto(ctx.tenant.limits.maxCashWithdrawalCents);
    const queda = (usado: bigint) => (topes.pettyLimitCents > usado ? topes.pettyLimitCents - usado : 0n);
    return {
      sessionId: session.id,
      withdrawal: {
        role: puesto,
        limitCents: puesto === 'CON_TOPE' ? topes.withdrawalShiftLimitCents : puesto === 'NO_PUEDE' ? 0n : null,
        usedCents: retirado,
        remainingCents: retiroDisponibleDelPuesto({ puesto, topeRetiroCents: topes.withdrawalShiftLimitCents, retiradoEnElTurnoCents: retirado }),
      },
      petty: { limitCents: topes.pettyLimitCents, floatInRemainingCents: queda(fondo), expenseRemainingCents: queda(gasto) },
    };
  }

  /**
   * «RETIRO DEL DUEÑO» QUE SALE DEL CAJÓN (pendiente de 3.7 y 3.5; bloque 4.3).
   *
   * Un solo acto, una sola transacción: el retiro del cajón (para que el corte
   * cuadre) y su anotación en Movimientos como «Retiro del dueño» (que se ve y
   * no resta de la ganancia). Antes había que anotarlo en dos pantallas, y si
   * se olvidaba la de Caja el corte daba faltante a nombre de quien abrió.
   *
   * Para el cajón es un retiro como cualquier otro (D-15): siempre con la
   * firma de la dueña y, recepción, dentro de su tope por turno. Se anota en
   * el mes en curso de la sede; si ese mes o el del turno ya están cerrados,
   * 409 `MONTH_CLOSED` y no se mueve nada.
   */
  async ownerDraw(ctx: RequestContext, input: {
    sessionId: string; amountCents: bigint; reason: string; approvedByUserId?: string | null;
  }): Promise<{ movement: CashMovementRecord; expenseId: string; periodMonth: Date }> {
    const orgId = ctx.tenant.organizationId;
    const userId = ctx.tenant.actorUserId;
    if (!userId) throw validation('Un movimiento de caja exige un usuario');
    return enUnidadDeDinero(orgId, async () => {
      const session = await new CashSessionRepository(orgId).findById(input.sessionId);
      if (!session) throw notFound('Turno no encontrado');
      if (session.status !== 'OPEN') throw conflict('El turno ya está cerrado', 'CASH_SESSION_CLOSED');
      if (input.amountCents <= 0n) throw validation('El importe del retiro debe ser positivo');
      const hoy = await this.businessDate(orgId, session.branchId);
      // El retiro se anota en el mes de HOY: ese mes tiene que seguir abierto (el del turno lo mira `addMovement`).
      await new MonthlyCloseService().assertOpen(orgId, hoy);
      const periodMonth = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1));

      const gasto = await new ExpensesRepository(orgId).create({
        branchId: session.branchId, category: RETIRO_DEL_DUENO, description: input.reason.slice(0, 200),
        amountCents: input.amountCents, periodMonth, createdByUserId: userId,
      });
      await this.audit.record(ctx, {
        action: 'expense.create', resourceType: 'OperatingExpense', resourceId: gasto.id, branchId: session.branchId,
        reason: input.reason,
        afterState: {
          category: RETIRO_DEL_DUENO, amountCents: input.amountCents.toString(), month: periodMonth.toISOString().slice(0, 7),
          fromCashSessionId: session.id,
        },
        approvedByUserId: input.approvedByUserId ?? null,
      });
      // Si el cajón lo rechaza (falta la firma, pasa del tope, no hay tanto efectivo), la anotación de arriba se deshace con él.
      const movement = await this.addMovement(ctx, {
        sessionId: session.id, movementType: 'WITHDRAWAL', amountCents: input.amountCents, reason: input.reason,
        approvedByUserId: input.approvedByUserId ?? null, expenseId: gasto.id,
      });
      return { movement, expenseId: gasto.id, periodMonth };
    });
  }

  /**
   * Movimiento de efectivo que NO es un cobro.
   *
   * El cajero teclea una magnitud positiva; el signo lo pone el sistema según
   * el tipo. Así un "retiro" no puede acabar sumando al cajón por un descuido
   * de captura.
   */
  async addMovement(ctx: RequestContext, input: {
    sessionId: string;
    movementType: CashMovementType;
    amountCents: bigint;
    reason: string;
    sign?: 1 | -1;
    approvedByUserId?: string | null;
    /** «Retiro del dueño»: su anotación en Movimientos, creada en esta misma unidad (`ownerDraw`). */
    expenseId?: string | null;
  }): Promise<CashMovementRecord> {
    // Una unidad de dinero (bloque 4.3; antes, una transacción suelta): toma el turno del gimnasio antes
    // de leer nada, así dos retiros a la vez no leen el mismo «retirado en el turno» ni el mismo efectivo
    // disponible; y si la bitácora no se escribe, la operación no ocurre (OPT2-14).
    return enUnidadDeDinero(ctx.tenant.organizationId, async () => {
      const orgId = ctx.tenant.organizationId;
      const userId = ctx.tenant.actorUserId;
      if (!userId) throw validation('Un movimiento de caja exige un usuario');

      const sessions = new CashSessionRepository(orgId);
      const session = await sessions.findById(input.sessionId);
      if (!session) throw notFound('Turno no encontrado');
      if (session.status !== 'OPEN') throw conflict('El turno ya está cerrado', 'CASH_SESSION_CLOSED');

      // Las cifras de un mes cerrado no cambian (D-22; pendiente de 3.7 que recoge el bloque 3.5):
      // un turno que quedó abierto de un mes ya cerrado no recibe movimientos; se corta y se abre otro.
      await new MonthlyCloseService().assertOpen(orgId, session.businessDate);

      // D-15: quién firma qué en el cajón. Fondo y gasto, sin firma hasta el tope chico del
      // gimnasio (por turno); retiro y depósito, siempre con firma y, recepción, hasta su tope
      // por turno; corrección, solo la gerencia y con firma. Una sola regla: `reglaDelCajon`.
      const topes = await new CashSettingsRepository(orgId).get();
      const regla = reglaDelCajon({
        tipo: input.movementType,
        montoCents: input.amountCents,
        sinFirmaEnElTurnoCents: input.movementType === 'FLOAT_IN' || input.movementType === 'EXPENSE'
          ? await sessions.unsignedInSessionCents(session.id, input.movementType) : 0n,
        retiradoEnElTurnoCents: await sessions.withdrawnByUserCents(session.id, userId),
        topeChicoCents: topes.pettyLimitCents,
        topeRetiroCents: topes.withdrawalShiftLimitCents,
        puesto: topeDeRetiroDelPuesto(ctx.tenant.limits.maxCashWithdrawalCents),
        firmado: !!input.approvedByUserId,
      });
      if (regla.outcome === 'DENY') throw new DomainError('FORBIDDEN', regla.porQue, undefined, 'CASH_LIMIT_FORBIDDEN');
      if (regla.outcome === 'REQUIRE_APPROVAL') throw new DomainError('REQUIRE_APPROVAL', 'Se requiere autorización de un segundo usuario', regla.porQue);

      const firmado = signedMovementAmount(
        input.movementType, money(input.amountCents), input.sign,
      );
      if (!movementSignIsValid(input.movementType, firmado)) {
        throw validation('El signo del movimiento no corresponde con su tipo');
      }

      // No se puede sacar del cajón más de lo que hay.
      if (firmado.cents < 0n) {
        const disponible = await sessions.expectedCashCents(session);
        if (-firmado.cents > disponible) {
          throw validation(
            `No hay tanto efectivo en la caja: hay ${formatMoney(money(disponible))} y se intenta sacar ${formatMoney(money(-firmado.cents))}`,
          );
        }
      }

      const movimiento = await sessions.addMovement({
        cashSessionId: input.sessionId,
        movementType: input.movementType,
        amountCents: firmado.cents,
        reason: input.reason,
        createdByUserId: userId,
        approvedByUserId: input.approvedByUserId ?? null,
        // El día de la SEDE en este instante (DM-10): un turno que cruza la
        // medianoche reparte sus gastos entre los dos días, como los pagos.
        businessDate: await new BusinessCalendar(orgId).today(session.branchId),
        expenseId: input.expenseId ?? null,
      });

      await this.audit.record(ctx, {
        action: input.movementType === 'WITHDRAWAL' ? 'cash.withdraw' : 'cash.movement.create',
        resourceType: 'cash_movement',
        resourceId: movimiento.id,
        afterState: {
          type: input.movementType, amountCents: firmado.cents.toString(),
          ...(input.expenseId ? { ownerDraw: true, expenseId: input.expenseId } : {}),
        },
        reason: input.reason,
        approvedByUserId: input.approvedByUserId ?? null,
        branchId: session.branchId,
      });

      return movimiento;
    });
  }

  /**
   * Turno abierto donde imputar un cobro de mostrador.
   *
   * Si hay varias cajas abiertas en la sucursal se exige elegir: adivinar
   * repartiría el efectivo en el cajón equivocado y haría que dos cortes
   * descuadraran a la vez.
   */
  async resolveSessionForPayment(ctx: RequestContext, input: {
    branchId: string; cashSessionId?: string | null;
  }): Promise<CashSessionRecord> {
    const orgId = ctx.tenant.organizationId;
    const sessions = new CashSessionRepository(orgId);

    if (input.cashSessionId) {
      const s = await sessions.findById(input.cashSessionId);
      if (!s) throw notFound('Turno no encontrado');
      if (s.status !== 'OPEN') throw conflict('El turno indicado ya está cerrado', 'CASH_SESSION_CLOSED');
      if (s.branchId !== input.branchId) {
        throw validation('El turno pertenece a otra sucursal que la del cobro');
      }
      return s;
    }

    const abiertas = await sessions.listOpenForBranch(input.branchId);
    if (abiertas.length === 0) {
      throw conflict('No hay ninguna caja abierta en esta sucursal: abre turno antes de cobrar', 'NO_OPEN_REGISTER');
    }
    if (abiertas.length > 1) {
      throw validation(
        `Hay ${abiertas.length} cajas abiertas en la sucursal: indica en cuál se recibe el cobro`,
        undefined, 'MULTIPLE_OPEN_REGISTERS',
      );
    }
    return abiertas[0]!;
  }

  /** Folio de mostrador para un cobro, reservado de forma atómica. */
  async nextFolio(ctx: RequestContext, session: CashSessionRecord): Promise<string> {
    const orgId = ctx.tenant.organizationId;
    const branch = await new BranchRepository(orgId).findById(session.branchId);
    if (!branch) throw notFound('Sucursal no encontrada');
    return new CashRegisterRepository(orgId).nextFolio(session.cashRegisterId, branch.code);
  }
}

export type { Money };
