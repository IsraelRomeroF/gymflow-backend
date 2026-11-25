import { computeVariance, conflict, descuadrePorRevisar, expectedCash, formatFolio, money, notFound, type CashMovementType, type CashSessionStatus, type Money, type PaymentMethodType, type VarianceReviewStatus, uuidv7, validation } from '@gymflow/core';
import { PrismaCashSessionStatus, PrismaCashMovementType } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { shiftContributors } from './shift-contributors.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';

const S = PrismaCashSessionStatus;

export type CashRegisterRecord = {
  id: string;
  branchId: string;
  code: string;
  name: string;
  isActive: boolean;
};

const REGISTER_SELECT = {
  id: true, branchId: true, code: true, name: true, isActive: true,
} as const;

export type CashSessionRecord = {
  id: string;
  branchId: string;
  cashRegisterId: string;
  openedByUserId: string;
  closedByUserId: string | null;
  shiftLabel: string | null;
  businessDate: Date;
  status: CashSessionStatus;
  openingFloatCents: bigint;
  expectedCashCents: bigint | null;
  countedCashCents: bigint | null;
  varianceCents: bigint | null;
  varianceReason: string | null;
  firstCountedCashCents: bigint | null;
  countAttempts: number;
  openedAt: Date;
  closedAt: Date | null;
  /** D-17 (bloque 4.3): la revisión de la diferencia. Nulo = nada que revisar. */
  varianceStatus: VarianceReviewStatus | null;
  varianceReviewedByUserId: string | null;
  varianceReviewedAt: Date | null;
  varianceReviewNote: string | null;
};

const SESSION_SELECT = {
  id: true, branchId: true, cashRegisterId: true, openedByUserId: true,
  closedByUserId: true, shiftLabel: true, businessDate: true, status: true,
  openingFloatCents: true, expectedCashCents: true, countedCashCents: true,
  varianceCents: true, varianceReason: true, openedAt: true, closedAt: true,
  firstCountedCashCents: true, countAttempts: true,
  varianceStatus: true, varianceReviewedByUserId: true, varianceReviewedAt: true, varianceReviewNote: true,
} as const;

export type CashMovementRecord = {
  id: string;
  cashSessionId: string;
  movementType: CashMovementType;
  amountCents: bigint;
  reason: string;
  createdByUserId: string;
  approvedByUserId: string | null;
  at: Date;
  /** «Retiro del dueño» (bloque 4.3): su anotación en Movimientos. */
  expenseId: string | null;
};

const MOVEMENT_SELECT = {
  id: true, cashSessionId: true, movementType: true, amountCents: true,
  reason: true, createdByUserId: true, approvedByUserId: true, at: true, expenseId: true,
} as const;

/** Qué cortes pedir por su diferencia (D-17): por revisar, ya revisados, o cualquiera que no cuadró. */
export type FiltroDeDescuadre = 'PENDING' | 'REVIEWED' | 'ANY';

/** Una caja abierta, con los nombres que necesita un aviso. */
export type CajaAbierta = {
  id: string; branchId: string; branchName: string; registerName: string;
  openedByUserId: string; openedAt: Date; businessDate: Date;
};

/** Los descuadres por revisar de un conjunto de sedes, sumados. */
export type DescuadresPorRevisar = { count: number; shortageCents: bigint; overageCents: bigint; oldestBusinessDate: Date | null };

export class CashRegisterRepository extends TenantRepository {
  async findById(id: string): Promise<CashRegisterRecord | null> {
    const row = await this.db.cashRegister.findFirst({
      where: this.scope({ id, deletedAt: null }), select: REGISTER_SELECT,
    });
    return row as CashRegisterRecord | null;
  }

  async list(branchId?: string): Promise<CashRegisterRecord[]> {
    const rows = await this.db.cashRegister.findMany({
      where: this.scope({ deletedAt: null, ...(branchId ? { branchId } : {}) }),
      select: REGISTER_SELECT,
      orderBy: [{ branchId: 'asc' }, { code: 'asc' }],
    });
    return rows as CashRegisterRecord[];
  }

  async create(input: { branchId: string; code: string; name: string }): Promise<CashRegisterRecord> {
    const row = await this.db.cashRegister.create({
      data: {
        id: uuidv7(),
        organizationId: this.organizationId,
        branchId: input.branchId,
        code: input.code.toUpperCase(),
        name: input.name,
      },
      select: REGISTER_SELECT,
    });
    return row as CashRegisterRecord;
  }

  /** Cajas en uso (sin retirar), de todo el gimnasio o de una sede (19-01, 19-07). */
  async countActive(branchId?: string): Promise<number> {
    return this.db.cashRegister.count({ where: this.scope({ deletedAt: null, isActive: true, ...(branchId ? { branchId } : {}) }) });
  }

  /** Renombrar o retirar una caja (DP-09): el nombre sale en cortes y bitácora para siempre. */
  async update(id: string, patch: { name?: string | undefined; isActive?: boolean | undefined }): Promise<CashRegisterRecord | null> {
    const data = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const { count } = await this.db.cashRegister.updateMany({ where: this.scope({ id, deletedAt: null }), data });
    return count > 0 ? this.findById(id) : null;
  }

  /**
   * Reserva el siguiente folio de la caja.
   *
   * El `UPDATE ... RETURNING` es atómico: dos cobros simultáneos en la misma
   * caja obtienen números distintos sin que la aplicación coordine nada. Es
   * la misma razón por la que un `SELECT` seguido de `UPDATE` no sirve.
   */
  async nextFolio(cashRegisterId: string, branchCode: string): Promise<string> {
    const rows = await this.db.$queryRaw<Array<{ folioCounter: number; code: string }>>`
      UPDATE "cash_registers"
      SET "folioCounter" = "folioCounter" + 1
      WHERE "id" = ${cashRegisterId}::uuid AND "organizationId" = ${this.organizationId}::uuid
      RETURNING "folioCounter", "code"`;
    const row = rows[0];
    if (!row) throw notFound('Caja no encontrada');
    return formatFolio(branchCode, row.code, row.folioCounter);
  }
}

export class CashSessionRepository extends TenantRepository {
  async findById(id: string): Promise<CashSessionRecord | null> {
    const row = await this.db.cashSession.findFirst({ where: this.scope({ id }), select: SESSION_SELECT });
    return row as CashSessionRecord | null;
  }

  async findOpenForRegister(cashRegisterId: string): Promise<CashSessionRecord | null> {
    const row = await this.db.cashSession.findFirst({
      where: this.scope({ cashRegisterId, status: S.OPEN }), select: SESSION_SELECT,
    });
    return row as CashSessionRecord | null;
  }

  /** Turnos abiertos, de todo el gimnasio o de una sede: con alguno, Caja no se apaga (19-01). */
  async countOpen(branchId?: string): Promise<number> {
    return this.db.cashSession.count({ where: this.scope({ status: S.OPEN, ...(branchId ? { branchId } : {}) }) });
  }

  /** Turnos abiertos de una sucursal. Lo consume el cobro de mostrador. */
  async listOpenForBranch(branchId: string): Promise<CashSessionRecord[]> {
    const rows = await this.db.cashSession.findMany({
      where: this.scope({ branchId, status: S.OPEN }), select: SESSION_SELECT,
      orderBy: { openedAt: 'asc' },
    });
    return rows as CashSessionRecord[];
  }

  async list(opts: {
    branchId?: string | undefined;
    status?: CashSessionStatus | undefined;
    businessDate?: Date | undefined;
    /** Rango de días de negocio, los dos incluidos (vista «Cortes»). */
    from?: Date | undefined;
    to?: Date | undefined;
    /** De quién es el turno: quien lo abrió (D-17). */
    openedByUserId?: string | undefined;
    variance?: FiltroDeDescuadre | undefined;
    limit?: number | undefined;
    /** Página siguiente (bloque 4.11): solo lo que abrió ANTES de ese turno, en el mismo orden. */
    before?: { openedAt: Date; id: string } | undefined;
  } = {}): Promise<CashSessionRecord[]> {
    const rango = opts.from || opts.to ? { businessDate: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } } : {};
    const rows = await this.db.cashSession.findMany({
      where: this.scope({
        ...(opts.branchId ? { branchId: opts.branchId } : {}),
        ...(opts.status ? { status: S[opts.status] } : {}),
        ...(opts.businessDate ? { businessDate: opts.businessDate } : rango),
        ...(opts.openedByUserId ? { openedByUserId: opts.openedByUserId } : {}),
        ...(opts.variance === 'ANY' ? { varianceCents: { not: 0n }, status: opts.status ? S[opts.status] : { not: S.OPEN } }
          : opts.variance ? { varianceStatus: opts.variance } : {}),
        ...(opts.before ? { OR: [{ openedAt: { lt: opts.before.openedAt } }, { openedAt: opts.before.openedAt, id: { lt: opts.before.id } }] } : {}),
      }),
      select: SESSION_SELECT,
      // El id desempata: dos turnos abiertos en el mismo instante no se repiten ni se pierden entre páginas.
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      take: opts.limit ?? 100,
    });
    return rows as CashSessionRecord[];
  }

  /**
   * Abre turno. El índice parcial garantiza una sola sesión abierta por caja;
   * aquí se traduce la violación a un error que recepción entiende.
   */
  async open(input: {
    branchId: string;
    cashRegisterId: string;
    openedByUserId: string;
    openingFloatCents: bigint;
    businessDate: Date;
    shiftLabel?: string | null;
  }): Promise<CashSessionRecord> {
    try {
      const row = await this.db.cashSession.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          branchId: input.branchId,
          cashRegisterId: input.cashRegisterId,
          openedByUserId: input.openedByUserId,
          openingFloatCents: input.openingFloatCents,
          businessDate: input.businessDate,
          shiftLabel: input.shiftLabel ?? null,
          status: S.OPEN,
        },
        select: SESSION_SELECT,
      });
      return row as CashSessionRecord;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('Esa caja ya tiene un turno abierto', 'REGISTER_ALREADY_OPEN');
      throw err;
    }
  }

  /**
   * Cobros del turno agregados por método.
   *
   * Incluye `SUCCEEDED` y `REVERSED` porque el contra-asiento vive en el turno
   * donde el dinero SALE del cajón, no en el original: si se excluyeran los
   * revertidos, un reverso de ayer descuadraría el corte de ayer, que ya está
   * cerrado y firmado.
   */
  async paymentTotals(sessionId: string): Promise<Array<{ method: PaymentMethodType; amountCents: bigint }>> {
    const rows = await this.db.$queryRaw<Array<{ method: PaymentMethodType; total: bigint }>>`
      SELECT "method", COALESCE(SUM("amountCents"), 0)::bigint AS total
      FROM "payments"
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "cashSessionId" = ${sessionId}::uuid
        AND "status" IN ('SUCCEEDED','REVERSED')
      GROUP BY "method"`;
    return rows.map((r) => ({ method: r.method, amountCents: r.total }));
  }

  async movementTotalCents(sessionId: string): Promise<bigint> {
    const rows = await this.db.$queryRaw<Array<{ total: bigint | null }>>`
      SELECT COALESCE(SUM("amountCents"), 0)::bigint AS total
      FROM "cash_movements"
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "cashSessionId" = ${sessionId}::uuid`;
    return rows[0]?.total ?? 0n;
  }

  /**
   * Aportes de otros módulos al turno (hoy: producto).
   * Caja no conoce a quién aporta: ver `shift-contributors.ts`.
   */
  async contributions(sessionId: string): Promise<Array<{
    source: string; byMethod: Array<{ method: PaymentMethodType; amountCents: bigint }>;
  }>> {
    const salida = [];
    for (const c of shiftContributors()) {
      const aporte = await c.totalsForSession(this.organizationId, sessionId);
      salida.push({ source: aporte.source, byMethod: [...aporte.byMethod] });
    }
    return salida;
  }

  /**
   * Efectivo esperado en el cajón AHORA.
   *
   * Suma el efectivo de los COBROS y el de las VENTAS DE PRODUCTO: el corte no
   * cuadra si el refresco entra al cajón y no a la cuenta. Solo el efectivo
   * cuenta; la terminal aparece en el documento pero no en el conteo.
   */
  async expectedCashCents(session: CashSessionRecord): Promise<bigint> {
    const totales = await this.paymentTotals(session.id);
    let efectivo = totales.find((t) => t.method === 'CASH')?.amountCents ?? 0n;

    for (const aporte of await this.contributions(session.id)) {
      efectivo += aporte.byMethod.find((m) => m.method === 'CASH')?.amountCents ?? 0n;
    }

    const movimientos = await this.movementTotalCents(session.id);
    return expectedCash({
      openingFloat: money(session.openingFloatCents),
      cashCollected: money(efectivo),
      movements: [money(movimientos)],
    }).cents;
  }

  /**
   * Anota un conteo del corte ciego ANTES de juzgarlo: el primero queda fijo
   * para siempre (solo se escribe si está vacío) y cada intento suma. Devuelve
   * el primer conteo, para saber si este es un reconteo.
   */
  async recordCount(sessionId: string, countedCashCents: bigint): Promise<bigint | null> {
    // Una sola escritura (bloque 4.16; antes, dos UPDATE sueltos y una lectura, cada uno con su
    // confirmación): con la base lenta para confirmar, cada UPDATE retenía la fila del turno mientras
    // confirmaba y el reintento de un corte caía en 500 «lock timeout». Ahora corre dentro del turno
    // de dinero del gimnasio (`CashService.closeSession`). `null` = el turno ya no está abierto.
    const [fila] = await this.db.$queryRaw<Array<{ primero: bigint }>>`
      UPDATE "cash_sessions"
         SET "firstCountedCashCents" = COALESCE("firstCountedCashCents", ${countedCashCents}),
             "countAttempts" = "countAttempts" + 1
       WHERE "id" = ${sessionId}::uuid AND "organizationId" = ${this.organizationId}::uuid AND "status"::text = 'OPEN'
       RETURNING "firstCountedCashCents" AS primero`;
    return fila ? BigInt(fila.primero) : null;
  }

  /**
   * Cierre bajo candado (BE2-13). El turno se toma FOR UPDATE ANTES de
   * calcular el esperado: un cobro que ya pasó el trigger (FOR SHARE) termina
   * primero y entra en la cuenta; uno que llega después espera y, al soltarse
   * el candado, encuentra el turno cerrado y se rechaza. `calcular` recibe el
   * turno ya bloqueado y devuelve el esperado y la diferencia a guardar.
   */
  async closeLocked(input: {
    sessionId: string;
    closedByUserId: string;
    countedCashCents: bigint;
    varianceReason: string | null;
    calcular: () => Promise<{ expectedCashCents: bigint }>;
  }): Promise<CashSessionRecord> {
    await this.db.$transaction(async (tx) => {
      const [fila] = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT "status"::text AS status FROM "cash_sessions"
         WHERE "id" = ${input.sessionId}::uuid AND "organizationId" = ${this.organizationId}::uuid FOR UPDATE`;
      if (!fila) throw notFound('Turno no encontrado');
      if (fila.status !== 'OPEN') throw validation('Ese turno ya está cerrado');
      const { expectedCashCents } = await input.calcular();
      const { variance } = computeVariance(money(expectedCashCents), money(input.countedCashCents));
      await tx.cashSession.update({
        where: { id: input.sessionId },
        data: {
          status: S.CLOSED,
          closedByUserId: input.closedByUserId,
          closedAt: new Date(),
          expectedCashCents,
          countedCashCents: input.countedCashCents,
          varianceCents: variance.cents,
          varianceReason: input.varianceReason,
          // D-17: más de $20 de diferencia (falte o sobre) nace «por revisar».
          varianceStatus: descuadrePorRevisar(variance.cents) ? 'PENDING' : null,
        },
      });
    }, { timeout: 15_000 });
    const row = await this.findById(input.sessionId);
    if (!row) throw notFound('Turno no encontrado');
    return row;
  }

  async addMovement(input: {
    cashSessionId: string;
    movementType: CashMovementType;
    amountCents: bigint;
    reason: string;
    createdByUserId: string;
    approvedByUserId?: string | null;
    /** Día de negocio de la sede al hacerlo (DM-10), no el del turno. */
    businessDate: Date;
    /** «Retiro del dueño»: la anotación en Movimientos creada en esta misma transacción. */
    expenseId?: string | null;
  }): Promise<CashMovementRecord> {
    const row = await this.db.cashMovement.create({
      data: {
        id: uuidv7(),
        organizationId: this.organizationId,
        cashSessionId: input.cashSessionId,
        movementType: PrismaCashMovementType[input.movementType],
        amountCents: input.amountCents,
        reason: input.reason,
        createdByUserId: input.createdByUserId,
        approvedByUserId: input.approvedByUserId ?? null,
        businessDate: input.businessDate,
        expenseId: input.expenseId ?? null,
      },
      select: MOVEMENT_SELECT,
    });
    return row as CashMovementRecord;
  }

  async listMovements(sessionId: string): Promise<CashMovementRecord[]> {
    const rows = await this.db.cashMovement.findMany({
      where: this.scope({ cashSessionId: sessionId }),
      select: MOVEMENT_SELECT,
      orderBy: { at: 'asc' },
    });
    return rows as CashMovementRecord[];
  }

  /** Retirado por un usuario en el turno, para el límite de `cash:withdraw`. */
  async withdrawnByUserCents(sessionId: string, userId: string): Promise<bigint> {
    const rows = await this.db.$queryRaw<Array<{ total: bigint | null }>>`
      SELECT COALESCE(SUM(-"amountCents"), 0)::bigint AS total
      FROM "cash_movements"
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "cashSessionId" = ${sessionId}::uuid
        AND "createdByUserId" = ${userId}::uuid
        AND "movementType" IN ('WITHDRAWAL','DEPOSIT')`;
    return rows[0]?.total ?? 0n;
  }

  /**
   * Lo anotado SIN firma en el turno, de ese tipo (fondo o gasto), en positivo
   * (D-15, bloque 3.5): lo que ya se gastó del tope chico. Es del turno, no de
   * la persona: el tope es del cajón.
   */
  async unsignedInSessionCents(sessionId: string, movementType: 'FLOAT_IN' | 'EXPENSE'): Promise<bigint> {
    const rows = await this.db.$queryRaw<Array<{ total: bigint | null }>>`
      SELECT COALESCE(SUM(ABS("amountCents")), 0)::bigint AS total
      FROM "cash_movements"
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "cashSessionId" = ${sessionId}::uuid
        AND "approvedByUserId" IS NULL
        AND "movementType"::text = ${movementType}`;
    return rows[0]?.total ?? 0n;
  }

  // ── D-17 · La revisión del descuadre (bloque 4.3) ────────────────────────

  /**
   * La gerencia cierra la revisión con su nota. Solo pasa de «por revisar» a
   * «revisado», una vez: la condición va en el `WHERE`, así dos revisiones a la
   * vez no se pisan (la segunda no encuentra nada que cambiar).
   */
  async reviewVariance(sessionId: string, input: { userId: string; note: string; at: Date }): Promise<boolean> {
    const { count } = await this.db.cashSession.updateMany({
      where: this.scope({ id: sessionId, varianceStatus: 'PENDING' }),
      data: { varianceStatus: 'REVIEWED', varianceReviewedByUserId: input.userId, varianceReviewedAt: input.at, varianceReviewNote: input.note },
    });
    return count > 0;
  }

  /** Los descuadres por revisar. `sedes` nulo = todo el gimnasio. */
  async pendingVariances(sedes: readonly string[] | null): Promise<DescuadresPorRevisar> {
    if (sedes !== null && sedes.length === 0) return { count: 0, shortageCents: 0n, overageCents: 0n, oldestBusinessDate: null };
    const filas = await this.db.cashSession.findMany({
      where: this.scope({ varianceStatus: 'PENDING', ...(sedes ? { branchId: { in: [...sedes] } } : {}) }),
      select: { varianceCents: true, businessDate: true },
    });
    let shortageCents = 0n; let overageCents = 0n; let oldestBusinessDate: Date | null = null;
    for (const f of filas) {
      const v = f.varianceCents ?? 0n;
      if (v < 0n) shortageCents += -v; else overageCents += v;
      if (!oldestBusinessDate || f.businessDate < oldestBusinessDate) oldestBusinessDate = f.businessDate;
    }
    return { count: filas.length, shortageCents, overageCents, oldestBusinessDate };
  }

  /** Las cajas abiertas, la más vieja primero, con el nombre de su caja y de su sede. `sedes` nulo = todo el gimnasio. */
  async openWithNames(sedes: readonly string[] | null): Promise<CajaAbierta[]> {
    if (sedes !== null && sedes.length === 0) return [];
    const filas = await this.db.cashSession.findMany({
      where: this.scope({ status: S.OPEN, ...(sedes ? { branchId: { in: [...sedes] } } : {}) }),
      select: {
        id: true, branchId: true, openedByUserId: true, openedAt: true, businessDate: true,
        cashRegister: { select: { name: true } }, branch: { select: { name: true } },
      },
      orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
    });
    return filas.map((f) => ({
      id: f.id, branchId: f.branchId, branchName: f.branch.name, registerName: f.cashRegister.name,
      openedByUserId: f.openedByUserId, openedAt: f.openedAt, businessDate: f.businessDate,
    }));
  }
}

export type { Money };
