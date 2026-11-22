import {
  uuidv7, money, planAllocation, verifyAllocationPlan, statusOfCharge,
  type PaymentMethodType, type PaymentStatus, type AllocatableCharge, notFound, validation, conflict } from '@gymflow/core';
import { PrismaPaymentMethodType, PrismaPaymentStatus, PrismaChargeStatus, PrismaAdjustmentType } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';

const M = PrismaPaymentMethodType;
const P = PrismaPaymentStatus;
const C = PrismaChargeStatus;

export type PaymentRecord = {
  id: string;
  memberId: string;
  branchId: string | null;
  method: PaymentMethodType;
  status: PaymentStatus;
  amountCents: bigint;
  unappliedCents: bigint;
  idempotencyKey: string | null;
  externalRef: string | null;
  processorName: string | null;
  receivedAt: Date;
  businessDate: Date;
  cashSessionId: string | null;
  folio: string | null;
  reversesPaymentId: string | null;
  reversalReason: string | null;
  failureCode: string | null;
  failureReason: string | null;
  createdAt: Date;
};

const SELECT = {
  id: true, memberId: true, branchId: true, method: true, status: true,
  amountCents: true, unappliedCents: true, idempotencyKey: true,
  externalRef: true, processorName: true, receivedAt: true, businessDate: true,
  cashSessionId: true, folio: true,
  reversesPaymentId: true, reversalReason: true, failureCode: true,
  failureReason: true, createdAt: true,
} as const;

export type AllocationRecord = {
  id: string;
  paymentId: string;
  chargeId: string;
  amountCents: bigint;
  createdAt: Date;
};

export type RecordPaymentInput = {
  memberId: string;
  branchId?: string | null;
  method: PaymentMethodType;
  amountCents: bigint;
  businessDate: Date;
  idempotencyKey?: string | null;
  externalRef?: string | null;
  processorName?: string | null;
  createdByUserId?: string | null;
  /** Turno al que se imputa. Nulo si el cobro no pasa por mostrador. */
  cashSessionId?: string | null;
  folio?: string | null;
  /** Cargos concretos a cubrir. Vacío = deuda más antigua primero. */
  targetChargeIds?: string[] | undefined;
};

export type RecordPaymentResult = {
  payment: PaymentRecord;
  allocations: Array<{ chargeId: string; amountCents: bigint }>;
  /** Excedente que quedó como SALDO A FAVOR. Nunca un cargo negativo. */
  unappliedCents: bigint;
  /** false = el pago ya existía; se devolvió el original sin cobrar de nuevo. */
  created: boolean;
};

export class PaymentRepository extends TenantRepository {
  async findById(id: string): Promise<PaymentRecord | null> {
    const row = await this.db.payment.findFirst({ where: this.scope({ id }), select: SELECT });
    return row as PaymentRecord | null;
  }

  async findByIdempotencyKey(key: string): Promise<PaymentRecord | null> {
    const row = await this.db.payment.findFirst({ where: this.scope({ idempotencyKey: key }), select: SELECT });
    return row as PaymentRecord | null;
  }

  /**
   * Por la referencia del procesador. Lo consume el módulo de domiciliación
   * para aplicar un webhook al pago correcto sin tener que adivinar cuál es.
   */
  async findByExternalRef(externalRef: string): Promise<PaymentRecord | null> {
    const row = await this.db.payment.findFirst({
      where: this.scope({ externalRef }), select: SELECT,
    });
    return row as PaymentRecord | null;
  }

  /**
   * Cambia el ESTADO de un pago, nada más.
   *
   * Deliberadamente no toca importes ni asignaciones: un evento del
   * procesador informa de qué pasó con el cobro, no reparte dinero. Repartir
   * sigue siendo competencia de `record` y `reverse`.
   */
  async setStatus(id: string, status: PaymentStatus): Promise<void> {
    await this.db.payment.updateMany({
      where: this.scope({ id }), data: { status: P[status] },
    });
  }

  async listForMember(memberId: string, limit = 100): Promise<PaymentRecord[]> {
    const rows = await this.db.payment.findMany({
      where: this.scope({ memberId }),
      select: SELECT,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows as PaymentRecord[];
  }

  async listAllocations(paymentId: string): Promise<AllocationRecord[]> {
    const rows = await this.db.paymentAllocation.findMany({
      where: this.scope({ paymentId }),
      select: { id: true, paymentId: true, chargeId: true, amountCents: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows as AllocationRecord[];
  }

  /**
   * Registra un cobro y lo aplica a la deuda, TODO en una transacción.
   *
   * El `FOR UPDATE` sobre los cargos del socio es lo que impide que dos cajas
   * cobrando al mismo socio a la vez apliquen ambas contra el mismo saldo. Sin
   * él, el `CHECK` de no-sobrepago rechazaría una de las dos con un error
   * ininteligible en el mostrador; con él, la segunda simplemente espera y ve
   * el saldo ya actualizado.
   */
  async record(input: RecordPaymentInput): Promise<RecordPaymentResult> {
    if (input.amountCents <= 0n) throw validation('El importe del pago debe ser mayor que cero');

    if (input.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        mismoCobro(existing, input);
        const allocs = await this.listAllocations(existing.id);
        return {
          payment: existing,
          allocations: allocs.map((a) => ({ chargeId: a.chargeId, amountCents: a.amountCents })),
          unappliedCents: existing.unappliedCents,
          created: false,
        };
      }
    }

    try {
      return await this.db.$transaction(async (tx) => {
        // Serializa por socio: el orden de aplicación deja de ser una carrera.
        const locked = await tx.$queryRaw<Array<{
          id: string; dueDate: Date; amountCents: bigint;
          allocatedCents: bigint; adjustedCents: bigint; issuedAt: Date | null;
        }>>`
          SELECT "id", "dueDate", "amountCents", "allocatedCents", "adjustedCents", "issuedAt"
          FROM "charges"
          WHERE "organizationId" = ${this.organizationId}::uuid
            AND "memberId" = ${input.memberId}::uuid
            AND "status" IN ('OPEN','PARTIALLY_PAID','OVERDUE')
          ORDER BY "dueDate" ASC, "id" ASC
          FOR UPDATE`;

        const elegibles = input.targetChargeIds?.length
          ? locked.filter((c) => input.targetChargeIds!.includes(c.id))
          : locked;

        const candidatos: AllocatableCharge[] = elegibles.map((c) => ({
          chargeId: c.id,
          dueDate: c.dueDate,
          balance: money(c.amountCents - c.allocatedCents - c.adjustedCents),
        }));

        const plan = planAllocation(money(input.amountCents), candidatos);
        // Cinturón y tirantes: si esto fallara, se perdería dinero en el reparto.
        if (!verifyAllocationPlan(money(input.amountCents), plan)) {
          throw conflict('El reparto del pago no cuadra con su importe; no se registró nada');
        }

        const payment = await tx.payment.create({
          data: {
            id: uuidv7(),
            organizationId: this.organizationId,
            memberId: input.memberId,
            branchId: input.branchId ?? null,
            method: M[input.method],
            status: P.SUCCEEDED,
            amountCents: input.amountCents,
            unappliedCents: plan.unapplied.cents,
            idempotencyKey: input.idempotencyKey ?? null,
            externalRef: input.externalRef ?? null,
            processorName: input.processorName ?? null,
            businessDate: input.businessDate,
            cashSessionId: input.cashSessionId ?? null,
            folio: input.folio ?? null,
            createdByUserId: input.createdByUserId ?? null,
          },
          select: SELECT,
        });

        const byId = new Map(locked.map((c) => [c.id, c]));
        for (const alloc of plan.allocations) {
          await tx.paymentAllocation.create({
            data: {
              id: uuidv7(),
              organizationId: this.organizationId,
              paymentId: payment.id,
              chargeId: alloc.chargeId,
              amountCents: alloc.amount.cents,
              createdByUserId: input.createdByUserId ?? null,
            },
          });

          const prev = byId.get(alloc.chargeId)!;
          const nuevoAplicado = prev.allocatedCents + alloc.amount.cents;
          const status = statusOfCharge({
            amountTotalCents: prev.amountCents,
            allocatedCents: nuevoAplicado,
            adjustedCents: prev.adjustedCents,
            issued: prev.issuedAt !== null,
            dueDate: prev.dueDate,
            today: input.businessDate,
          });

          await tx.charge.update({
            where: { id: alloc.chargeId },
            data: { allocatedCents: nuevoAplicado, status: C[status] },
          });
        }

        return {
          payment: payment as PaymentRecord,
          allocations: plan.allocations.map((a) => ({ chargeId: a.chargeId, amountCents: a.amount.cents })),
          unappliedCents: plan.unapplied.cents,
          created: true,
        };
      });
    } catch (err) {
      // Dos cajas con la misma clave a la vez: gana una, la otra lee el original.
      if (isUniqueViolation(err) && input.idempotencyKey) {
        const existing = await this.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          mismoCobro(existing, input);
          const allocs = await this.listAllocations(existing.id);
          return {
            payment: existing,
            allocations: allocs.map((a) => ({ chargeId: a.chargeId, amountCents: a.amountCents })),
            unappliedCents: existing.unappliedCents,
            created: false,
          };
        }
      }
      throw err;
    }
  }

  /**
   * Aplica el SALDO A FAVOR del socio a su deuda viva (DM-02). Los pagos con
   * `unappliedCents` se reparten, del más antiguo al más nuevo, sobre los
   * cargos abiertos por vencimiento, con el mismo plan de asignación que un
   * cobro. Antes el crédito quedaba muerto: el socio pagaba la mensualidad
   * completa mientras tenía dinero a favor que nadie veía.
   */
  async applyUnappliedCredit(memberId: string, today: Date, createdByUserId: string | null = null): Promise<bigint> {
    return (await this.aplicarSaldoAFavor(memberId, today, createdByUserId)).aplicadoCents;
  }

  /**
   * Lo mismo que `applyUnappliedCredit`, diciendo además QUÉ cargos tocó: si
   * el saldo a favor liquida una cuota, su membresía tiene que activarse igual
   * que con un cobro (4-18). Antes el crédito podía saldar la cuota de una
   * venta y la membresía se quedaba «por activar».
   */
  async aplicarSaldoAFavor(memberId: string, today: Date, createdByUserId: string | null = null): Promise<{ aplicadoCents: bigint; chargeIds: string[] }> {
    return this.db.$transaction(async (tx) => {
      const creditos = await tx.$queryRaw<Array<{ id: string; unappliedCents: bigint }>>`
        SELECT "id", "unappliedCents" FROM "payments"
        WHERE "organizationId" = ${this.organizationId}::uuid AND "memberId" = ${memberId}::uuid
          AND "status" = 'SUCCEEDED' AND "amountCents" > 0 AND "unappliedCents" > 0
        ORDER BY "receivedAt" ASC, "id" ASC
        FOR UPDATE`;
      if (creditos.length === 0) return { aplicadoCents: 0n, chargeIds: [] };
      const abiertos = await tx.$queryRaw<Array<{
        id: string; dueDate: Date; amountCents: bigint; allocatedCents: bigint; adjustedCents: bigint; issuedAt: Date | null;
      }>>`
        SELECT "id", "dueDate", "amountCents", "allocatedCents", "adjustedCents", "issuedAt"
        FROM "charges"
        WHERE "organizationId" = ${this.organizationId}::uuid AND "memberId" = ${memberId}::uuid
          AND "status" IN ('OPEN','PARTIALLY_PAID','OVERDUE')
        ORDER BY "dueDate" ASC, "id" ASC
        FOR UPDATE`;
      if (abiertos.length === 0) return { aplicadoCents: 0n, chargeIds: [] };
      const saldo = new Map(abiertos.map((c) => [c.id, { ...c, balance: c.amountCents - c.allocatedCents - c.adjustedCents }]));
      let aplicado = 0n;
      const tocados = new Set<string>();
      for (const cr of creditos) {
        const candidatos: AllocatableCharge[] = [...saldo.values()].filter((c) => c.balance > 0n)
          .map((c) => ({ chargeId: c.id, dueDate: c.dueDate, balance: money(c.balance) }));
        if (candidatos.length === 0) break;
        const plan = planAllocation(money(cr.unappliedCents), candidatos);
        if (!verifyAllocationPlan(money(cr.unappliedCents), plan)) throw conflict('El reparto del saldo a favor no cuadra; no se aplicó nada');
        for (const a of plan.allocations) {
          await tx.paymentAllocation.create({
            data: { id: uuidv7(), organizationId: this.organizationId, paymentId: cr.id, chargeId: a.chargeId, amountCents: a.amount.cents, createdByUserId },
          });
          const c = saldo.get(a.chargeId)!;
          c.allocatedCents += a.amount.cents;
          c.balance -= a.amount.cents;
          const status = statusOfCharge({
            amountTotalCents: c.amountCents, allocatedCents: c.allocatedCents, adjustedCents: c.adjustedCents,
            issued: c.issuedAt !== null, dueDate: c.dueDate, today,
          });
          await tx.charge.update({ where: { id: a.chargeId }, data: { allocatedCents: c.allocatedCents, status: C[status] } });
          aplicado += a.amount.cents;
          tocados.add(a.chargeId);
        }
        const usado = cr.unappliedCents - plan.unapplied.cents;
        if (usado > 0n) await tx.payment.update({ where: { id: cr.id }, data: { unappliedCents: { decrement: usado } } });
      }
      return { aplicadoCents: aplicado, chargeIds: [...tocados] };
    });
  }

  /**
   * Contra-asiento. NO borra ni edita: crea un pago negativo con asignaciones
   * negativas que espejan las originales. El histórico queda aritméticamente
   * reconstruible, que es justo lo que el borrado silencioso destruye.
   */
  async reverse(input: {
    paymentId: string;
    reason: string;
    businessDate: Date;
    createdByUserId?: string | null;
    /**
     * Turno donde el dinero SALE del cajón, que NO es el del pago original:
     * si se imputara al original, revertir hoy descuadraría un corte de ayer
     * que ya está cerrado y firmado.
     */
    cashSessionId?: string | null;
    folio?: string | null;
  }): Promise<{ reversal: PaymentRecord; original: PaymentRecord }> {
    return this.db.$transaction(async (tx) => {
      const original = await tx.payment.findFirst({
        where: { id: input.paymentId, organizationId: this.organizationId },
        select: SELECT,
      });
      if (!original) throw notFound('Pago no encontrado');
      if (original.status !== P.SUCCEEDED) throw conflict('El pago ya no se puede revertir (ya se revirtió o no se completó)', 'ALREADY_REVERSED');

      const allocs = await tx.paymentAllocation.findMany({
        where: { paymentId: original.id, organizationId: this.organizationId },
        select: { chargeId: true, amountCents: true },
      });

      const reversal = await tx.payment.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          memberId: original.memberId,
          branchId: original.branchId,
          method: original.method,
          status: P.SUCCEEDED,
          amountCents: -original.amountCents,
          unappliedCents: original.unappliedCents,
          businessDate: input.businessDate,
          cashSessionId: input.cashSessionId ?? null,
          folio: input.folio ?? null,
          reversesPaymentId: original.id,
          reversalReason: input.reason,
          createdByUserId: input.createdByUserId ?? null,
        },
        select: SELECT,
      });

      for (const a of allocs) {
        await tx.paymentAllocation.create({
          data: {
            id: uuidv7(),
            organizationId: this.organizationId,
            paymentId: reversal.id,
            chargeId: a.chargeId,
            amountCents: -a.amountCents,
            createdByUserId: input.createdByUserId ?? null,
          },
        });

        const charge = await tx.charge.findUniqueOrThrow({
          where: { id: a.chargeId },
          select: {
            amountCents: true, allocatedCents: true, adjustedCents: true,
            issuedAt: true, dueDate: true, voidReason: true, writeOffReason: true,
          },
        });
        const nuevoAplicado = charge.allocatedCents - a.amountCents;
        const status = statusOfCharge({
          amountTotalCents: charge.amountCents,
          allocatedCents: nuevoAplicado,
          adjustedCents: charge.adjustedCents,
          issued: charge.issuedAt !== null,
          dueDate: charge.dueDate,
          today: input.businessDate,
          voided: charge.voidReason !== null,
          writtenOff: charge.writeOffReason !== null,
        });
        await tx.charge.update({
          where: { id: a.chargeId },
          data: { allocatedCents: nuevoAplicado, status: C[status] },
        });
      }

      const updated = await tx.payment.update({
        where: { id: original.id },
        data: { status: P.REVERSED },
        select: SELECT,
      });

      return { reversal: reversal as PaymentRecord, original: updated as PaymentRecord };
    });
  }

  /** ¿Ya tiene contra-asientos (reversa o reembolsos)? Impide devolver dos veces. */
  async hasCounterEntries(paymentId: string): Promise<boolean> {
    const n = await this.db.payment.count({ where: this.scope({ reversesPaymentId: paymentId }) });
    return n > 0;
  }

  /**
   * CONTRA-ASIENTO DE UN REEMBOLSO (parcial o total) de un pago con tarjeta.
   *
   * Antes el reembolso solo quedaba en su tabla y en el procesador: el pago
   * seguía como cobrado completo, el saldo del socio no cambiaba y, después,
   * se podía REVERTIR el mismo pago y devolver el dinero dos veces.
   *
   * El orden importa: primero se devuelve lo que ese pago dejó A FAVOR (no
   * pagó nada); el resto sale de los cargos que cubrió, del más reciente al
   * más antiguo, y esos cargos se ajustan por lo mismo —reembolsar es dejar de
   * cobrarlo—, así que el socio no queda debiendo lo que se le devolvió.
   */
  async recordRefund(input: {
    paymentId: string; amountCents: bigint; reason: string; businessDate: Date; createdByUserId: string | null;
  }): Promise<{ refundEntry: PaymentRecord; chargeIds: string[] }> {
    return this.db.$transaction(async (tx) => {
      const [bloqueo] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "payments" WHERE "id" = ${input.paymentId}::uuid AND "organizationId" = ${this.organizationId}::uuid FOR UPDATE`;
      if (!bloqueo) throw notFound('Pago no encontrado');
      const original = await tx.payment.findFirstOrThrow({ where: { id: input.paymentId }, select: SELECT });
      if (original.status !== P.SUCCEEDED) throw conflict('El pago ya no admite reembolsos (fue revertido o no se completó)', 'ALREADY_REVERSED');

      const previos = await tx.payment.findMany({
        where: { organizationId: this.organizationId, reversesPaymentId: original.id },
        select: { id: true, amountCents: true, unappliedCents: true },
      });
      const yaDevuelto = previos.reduce((a, p) => a - p.amountCents, 0n);
      if (input.amountCents <= 0n || input.amountCents > original.amountCents - yaDevuelto) {
        throw validation('El reembolso excede lo que queda de ese pago');
      }

      // 1. Lo que quedó a favor.
      const aFavorDevuelto = previos.reduce((a, p) => a + p.unappliedCents, 0n);
      const deFavor = [original.unappliedCents - aFavorDevuelto, input.amountCents].reduce((a, b) => (a < b ? a : b));
      let resto = input.amountCents - (deFavor > 0n ? deFavor : 0n);

      const entrada = await tx.payment.create({
        data: {
          id: uuidv7(), organizationId: this.organizationId, memberId: original.memberId, branchId: original.branchId,
          method: original.method, status: P.SUCCEEDED, amountCents: -input.amountCents,
          unappliedCents: deFavor > 0n ? deFavor : 0n, businessDate: input.businessDate,
          reversesPaymentId: original.id, reversalReason: `Reembolso: ${input.reason}`, isRefund: true,
          createdByUserId: input.createdByUserId,
        },
        select: SELECT,
      });

      // 2. Lo que pagó cargos: del más reciente al más antiguo, sin pasar de
      //    lo que ese pago les aplicó (menos lo que ya se devolvió antes).
      const aplicado = await tx.paymentAllocation.groupBy({
        by: ['chargeId'], where: { organizationId: this.organizationId, paymentId: { in: [original.id, ...previos.map((p) => p.id)] } },
        _sum: { amountCents: true },
      });
      const orden = await tx.paymentAllocation.findMany({
        where: { organizationId: this.organizationId, paymentId: original.id }, select: { chargeId: true }, orderBy: { createdAt: 'desc' },
      });
      const restantes = new Map(aplicado.map((a) => [a.chargeId, a._sum.amountCents ?? 0n]));
      const tocados: string[] = [];
      for (const { chargeId } of orden) {
        if (resto <= 0n) break;
        const disponible = restantes.get(chargeId) ?? 0n;
        if (disponible <= 0n) continue;
        const parte = disponible < resto ? disponible : resto;
        resto -= parte;
        tocados.push(chargeId);
        await tx.paymentAllocation.create({
          data: { id: uuidv7(), organizationId: this.organizationId, paymentId: entrada.id, chargeId, amountCents: -parte, createdByUserId: input.createdByUserId },
        });
        await tx.chargeAdjustment.create({
          data: {
            id: uuidv7(), organizationId: this.organizationId, chargeId, adjustmentType: PrismaAdjustmentType.CORRECTION,
            amountCents: parte, reason: `Reembolsado: ${input.reason}`, createdByUserId: input.createdByUserId,
          },
        });
        // Menos aplicado y el mismo tanto ajustado: el saldo del cargo no cambia.
        await tx.charge.update({
          where: { id: chargeId },
          data: { allocatedCents: { decrement: parte }, adjustedCents: { increment: parte } },
        });
      }
      if (resto > 0n) throw conflict('No se pudo repartir el reembolso entre los cargos de ese pago');
      return { refundEntry: entrada as PaymentRecord, chargeIds: tocados };
    });
  }

  /**
   * Saldo a favor del socio.
   * Incluye los REVERSED a propósito: su contra-asiento ya los neutraliza,
   * y excluirlos restaría dos veces.
   */
  async creditBalanceCents(memberId: string): Promise<bigint> {
    const rows = await this.db.$queryRaw<Array<{ total: bigint | null }>>`
      SELECT COALESCE(SUM(
        CASE WHEN "amountCents" < 0 THEN -"unappliedCents" ELSE "unappliedCents" END
      ), 0)::bigint AS total
      FROM "payments"
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "memberId" = ${memberId}::uuid
        AND "status" IN ('SUCCEEDED','REVERSED')`;
    return rows[0]?.total ?? 0n;
  }
}

/**
 * Un reintento con la MISMA clave debe ser el mismo cobro. Antes, la clave de
 * un pago de $1 por transferencia a un socio devolvía ese pago a otro socio
 * que pagaba $1,200 en efectivo: recepción creía haber cobrado y el efectivo
 * entraba al cajón sin registro (BE2-09).
 */
function mismoCobro(existente: { memberId: string; amountCents: bigint; method: string }, pedido: { memberId: string; amountCents: bigint; method: string }): void {
  if (existente.memberId !== pedido.memberId || existente.amountCents !== pedido.amountCents || existente.method !== pedido.method) {
    throw validation('Esa clave de cobro ya se usó para otro cobro (otro socio, importe o método). Vuelve a intentarlo desde la pantalla de cobro');
  }
}
