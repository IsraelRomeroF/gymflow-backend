import { computeVariance, conflict, expectedCash, formatFolio, money, notFound, type CashMovementType, type CashSessionStatus, type Money, type PaymentMethodType, uuidv7, validation } from '@gymflow/core';
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
};

const SESSION_SELECT = {
  id: true, branchId: true, cashRegisterId: true, openedByUserId: true,
  closedByUserId: true, shiftLabel: true, businessDate: true, status: true,
  openingFloatCents: true, expectedCashCents: true, countedCashCents: true,
  varianceCents: true, varianceReason: true, openedAt: true, closedAt: true,
  firstCountedCashCents: true, countAttempts: true,
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
};

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
    limit?: number | undefined;
  } = {}): Promise<CashSessionRecord[]> {
    const rows = await this.db.cashSession.findMany({
      where: this.scope({
        ...(opts.branchId ? { branchId: opts.branchId } : {}),
        ...(opts.status ? { status: S[opts.status] } : {}),
        ...(opts.businessDate ? { businessDate: opts.businessDate } : {}),
      }),
      select: SESSION_SELECT,
      orderBy: { openedAt: 'desc' },
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
  async recordCount(sessionId: string, countedCashCents: bigint): Promise<bigint> {
    await this.db.cashSession.updateMany({
      where: this.scope({ id: sessionId, status: S.OPEN, firstCountedCashCents: null }),
      data: { firstCountedCashCents: countedCashCents },
    });
    await this.db.cashSession.updateMany({
      where: this.scope({ id: sessionId, status: S.OPEN }),
      data: { countAttempts: { increment: 1 } },
    });
    const s = await this.db.cashSession.findFirstOrThrow({ where: this.scope({ id: sessionId }), select: { firstCountedCashCents: true } });
    return s.firstCountedCashCents ?? countedCashCents;
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
      },
      select: {
        id: true, cashSessionId: true, movementType: true, amountCents: true,
        reason: true, createdByUserId: true, approvedByUserId: true, at: true,
      },
    });
    return row as CashMovementRecord;
  }

  async listMovements(sessionId: string): Promise<CashMovementRecord[]> {
    const rows = await this.db.cashMovement.findMany({
      where: this.scope({ cashSessionId: sessionId }),
      select: {
        id: true, cashSessionId: true, movementType: true, amountCents: true,
        reason: true, createdByUserId: true, approvedByUserId: true, at: true,
      },
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
        AND "movementType" IN ('WITHDRAWAL','DEPOSIT','EXPENSE')`;
    return rows[0]?.total ?? 0n;
  }
}

export type { Money };
