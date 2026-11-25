import {
  conflict, notFound, validation, breakdownTax, money, canEnterAfterPayment,
  cycleChargeKey, signupFeeKey, requiresMembership, canReverse, requiresCashSession,
  codigosDeMotivo, type AdjustmentType, type ChargeType, type MembershipStatus, type PaymentMethodType,
} from '@gymflow/core';
import { ChargeRepository, type ChargeRecord } from './charge.repository.js';
import { MemberRepository } from '../members/index.js';
import { MembershipRepository, VisitPackRepository } from '../memberships/index.js';
import { PaymentRepository, type PaymentRecord } from './payment.repository.js';
import { PlanRepository, registrarLlegadaDeAumento, type PlanRecord } from '../catalog/index.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { MembershipService } from '../memberships/index.js';
import { CashService } from '../cash/index.js';
import { OrganizationRepository } from '../organization/index.js';
import type { RequestContext } from '../../platform/context.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { enUnidadDeDinero } from '../../platform/db/unit-of-work.js';
import { precioDeCuotaPara } from './precio-de-cuota.js';
import { isModuleOnAt } from '../../platform/modules/module-state.js';
import * as sales from './sales.js';
import * as membership_billing from './membership-billing.js';

/** Los argumentos de una función de `sales.ts`/`membership-billing.ts` sin el servicio: la fachada no repite firmas. */
type Rest<F> = F extends (svc: BillingService, ...r: infer R) => unknown ? R : never;

/** Estado de cuenta: lo que recepción necesita ver antes de cobrar. */
export type MemberStatement = {
  memberId: string;
  outstandingCents: bigint;
  creditCents: bigint;
  /** Positivo = el socio DEBE. Negativo = tiene saldo a favor. */
  netBalanceCents: bigint;
  charges: ChargeRecord[];
  payments: PaymentRecord[];
  /** Fecha de negocio de su sede: «hoy le toca pagar» se dice con ella, no con el reloj de la computadora. */
  today: Date;
  /** Lo que el mostrador necesita al cobrar: si entra y cuánto falta para que entre (4-09). */
  cobro: EstadoParaCobro;
};

/**
 * La membresía que decide la puerta, vista desde el cobro (4-09, 4-18): si
 * hoy entra, hasta dónde está pagada y —si no entra— cuánto hay que cobrar
 * para que el cobro la reactive, con el saldo a favor ya descontado.
 */
export type EstadoParaCobro = {
  membership: { id: string; status: MembershipStatus; canEnter: boolean; paidThrough: Date | null } | null;
  /** Nulo si ya entra o si no hay membresía que reactivar. */
  toEnterCents: bigint | null;
  creditCents: bigint;
};

/**
 * Desglose fiscal de un plan.
 *
 * PENDIENTE Q-B-04: no está resuelto si las cuotas causan IVA ni si los
 * precios de lista lo llevan incluido. Mientras tanto `taxRateBps` es nulo y
 * el impuesto sale en cero — pero el cargo YA guarda subtotal e impuesto por
 * separado, así que la respuesta fiscal no obligará a migrar nada.
 */
export function amountsForPlan(plan: PlanRecord, priceCents: bigint): {
  subtotalCents: bigint; taxCents: bigint;
} {
  if (plan.taxRateBps === null) return { subtotalCents: priceCents, taxCents: 0n };
  const b = breakdownTax(money(priceCents), plan.taxRateBps, plan.priceIncludesTax);
  return { subtotalCents: b.subtotal.cents, taxCents: b.tax.cents };
}

export type SalePayment = {
  method: PaymentMethodType;
  cashSessionId?: string | null;
  externalRef?: string | null;
};

/**
 * Los códigos de motivo (`reasonCode`) que acepta un ajuste, del catálogo de
 * SU acción (`MOTIVOS` del núcleo; 20-08, bloque 1.2): descontar toma los de
 * «descuento» y condonar los de «condonación». Condonar acepta además los de
 * descuento, que es lo que el panel manda hoy al condonar; una corrección no
 * exige código y, si lo trae, vale cualquiera de los dos catálogos.
 */
export function codigosDeAjuste(tipo: AdjustmentType): readonly string[] {
  const descuento = codigosDeMotivo('descuento');
  return tipo === 'DISCOUNT' ? descuento : [...codigosDeMotivo('condonacion'), ...descuento];
}

export class BillingService {
  readonly audit = new AuditService();
  readonly memberships = new MembershipService();
  readonly cash = new CashService();

  /** @internal: lo usan `sales.ts` y `membership-billing.ts`. */
  async businessDate(organizationId: string, branchId: string | null): Promise<Date> {
    return new BusinessCalendar(organizationId).today(branchId);
  }

  // ── Consulta ──────────────────────────────────────────────────────────────

  async statement(ctx: RequestContext, memberId: string): Promise<MemberStatement> {
    const orgId = ctx.tenant.organizationId;
    const member = await new MemberRepository(orgId).findById(memberId);
    if (!member) throw notFound('Socio no encontrado');

    const charges = new ChargeRepository(orgId);
    const payments = new PaymentRepository(orgId);

    const [outstanding, credit, chargeList, paymentList, today, cobro] = await Promise.all([
      charges.outstandingTotalCents(memberId),
      payments.creditBalanceCents(memberId),
      charges.listForMember(memberId, { limit: 50 }),
      payments.listForMember(memberId, 50),
      this.businessDate(orgId, member.homeBranchId),
      this.estadoParaCobro(ctx, memberId),
    ]);

    return {
      memberId,
      outstandingCents: outstanding,
      creditCents: credit,
      netBalanceCents: outstanding - credit,
      charges: chargeList,
      payments: paymentList,
      today,
      cobro,
    };
  }

  /** Ver `EstadoParaCobro`. Lo usan el estado de cuenta y la respuesta de un cobro. */
  async estadoParaCobro(ctx: RequestContext, memberId: string): Promise<EstadoParaCobro> {
    const orgId = ctx.tenant.organizationId;
    const membresias = new MembershipRepository(orgId);
    const [m, abiertos, credito, politica] = await Promise.all([
      membresias.findCurrentForMember(memberId),
      new ChargeRepository(orgId).listOutstanding(memberId),
      new PaymentRepository(orgId).creditBalanceCents(memberId),
      new OrganizationRepository(orgId).accessSettings(),
    ]);
    if (!m) return { membership: null, toEnterCents: null, creditCents: credito };
    const paidThrough = (await membresias.paidThroughFor([m.id])).get(m.id) ?? null;
    // La misma regla que la puerta y el resumen de acceso, en el núcleo
    // (`canEnterAfterPayment`): lo que la deja fuera es lo mismo que mira el
    // cobro para activarla (`membershipHasOpenDues`).
    const { canEnter, toEnterCents } = canEnterAfterPayment({
      status: m.status,
      allowAccessWhilePastDue: politica.allowAccessWhilePastDue,
      charges: abiertos.map((c) => ({
        chargeId: c.id, dueDate: c.dueDate, balanceCents: saldo(c),
        blocksAccess: c.membershipId === m.id
          && (c.chargeType === 'MEMBERSHIP_PERIOD' || c.chargeType === 'SIGNUP_FEE')
          && (c.periodStart === null || c.periodStart.getTime() <= m.currentPeriodStart.getTime()),
      })),
      creditCents: credito,
      paymentCents: 0n,
    });
    return { membership: { id: m.id, status: m.status, canEnter, paidThrough }, toEnterCents, creditCents: credito };
  }

  // ── Cargos ────────────────────────────────────────────────────────────────

  /**
   * Cargo de un periodo de membresía. Idempotente por (membresía, periodo):
   * ejecutar el job dos veces el mismo día no duplica la cuota.
   */
  async createPeriodCharge(ctx: RequestContext, input: {
    membershipId: string;
    billingCycleId?: string | null;
    /** Otro periodo que el actual: los atrasados al reanudar un adeudo. */
    period?: { start: Date; end: Date };
  }): Promise<{ charge: ChargeRecord; created: boolean }> {
    const orgId = ctx.tenant.organizationId;
    // Una unidad de dinero: la cuota y el saldo a favor que la cubre se
    // confirman juntos, y dos corridas a la vez no se pisan.
    return enUnidadDeDinero(orgId, async () => {
    const membership = await new MembershipRepository(orgId).findById(input.membershipId);
    if (!membership) throw notFound('Membresía no encontrada');

    const plan = await new PlanRepository(orgId).findById(membership.planId);
    if (!plan) throw notFound('Plan no encontrado');

    const start = input.period?.start ?? membership.currentPeriodStart;
    const end = input.period?.end ?? membership.currentPeriodEnd;
    // La cuota de ese periodo se BUSCA antes de insertarla: dentro de una
    // transacción, chocar con su clave única la abortaría entera.
    const key = cycleChargeKey(membership.id, start);
    const previa = await new ChargeRepository(orgId).findByIdempotencyKey(key);
    if (previa) return { charge: previa, created: false };

    // Una sola regla (`precioDeCuota`, 16-04): lo pactado al vender manda
    // (DM-05) y, sin pactado, el precio del plan en su sede aunque la sede ya
    // no lo venda a socios nuevos. Ya no hay «sin precio»: dejar de vender un
    // plan en una sede no rompe la renovación de quien lo compró ahí.
    // 4.20 (P-14): un aumento guardado llega solo a la cuota que EMPIEZA y SE EMITE desde su
    // «rige desde» (15 días después de guardarlo); la de antes sale al precio de antes.
    const emitidaEl = await new BusinessCalendar(orgId).today(membership.soldAtBranchId);
    const { precio, llegan } = await precioDeCuotaPara(orgId, membership, plan, { inicio: start, emitidaEl });
    const { subtotalCents, taxCents } = amountsForPlan(plan, precio);

    const result = await new ChargeRepository(orgId).create({
      memberId: membership.memberId,
      membershipId: membership.id,
      branchId: membership.soldAtBranchId,
      billingCycleId: input.billingCycleId ?? null,
      chargeType: 'MEMBERSHIP_PERIOD',
      concept: `${plan.name} · ${isoDay(start)} a ${isoDay(end)}`,
      subtotalCents,
      taxCents,
      periodStart: start,
      periodEnd: end,
      dueDate: start,
      idempotencyKey: key,
      createdByUserId: ctx.tenant.actorUserId ?? null,
    });

    // Con la cuota ya emitida al precio nuevo, el aumento queda llegado (4.20).
    if (result.created && llegan.length > 0) await registrarLlegadaDeAumento(orgId, membership.id, llegan, result.charge.id, precio);

    // Lo que el socio tenga a favor cubre la cuota nueva antes de que nadie se la cobre (DM-02).
    // Sin activar aquí: a media decisión de adeudo, activar movería la
    // membresía antes de su transición. La activa quien cierra la operación
    // (el cobro, la venta o `cobrarAhora`).
    if (result.created) await this.applyCredit(ctx, membership.memberId, { activar: false });
    return result;
    });
  }

  /** Cotización de una venta: lo que el socio pagaría HOY por ese plan en esa sucursal. Usa el mismo cálculo que lo */
  quote(...a: Rest<typeof sales.quote>) { return sales.quote(this, ...a); }

  /** VENDER una membresía, en el orden que exige el modelo: 1. La membresía nace PENDIENTE (no da acceso). 2. Se ge */
  sellMembership(...a: Rest<typeof sales.sellMembership>) { return sales.sellMembership(this, ...a); }

  /** Cobra en el momento lo que dejó una operación, con clave idempotente. */
  /** @internal: lo usan `sales.ts` y `membership-billing.ts`. */
  async cobrarAhora(
    ctx: RequestContext,
    input: { memberId: string; branchId: string | null; charges: ChargeRecord[]; key: string },
    payment: SalePayment | null,
  ): Promise<PaymentRecord | null> {
    if (!payment) return null;
    const orgId = ctx.tenant.organizationId;
    // Lo que el socio tiene a favor va PRIMERO (4-18), y lo que falta se mide
    // con los saldos de AHORA: con los del cargo recién emitido se cobraba la
    // cuota completa y el crédito se volvía a quedar a favor.
    await this.applyCredit(ctx, input.memberId);
    const repo = new ChargeRepository(orgId);
    const frescos = (await Promise.all(input.charges.map((c) => repo.findById(c.id)))).filter((c): c is ChargeRecord => !!c);
    const total = frescos.reduce((a, c) => a + (saldo(c) > 0n ? saldo(c) : 0n), 0n);
    // Nada por cobrar: el reintento de una operación ya cobrada devuelve su pago.
    if (total <= 0n) return new PaymentRepository(orgId).findByIdempotencyKey(input.key);
    const r = await this.recordPayment(ctx, {
      memberId: input.memberId,
      method: payment.method,
      amountCents: total,
      branchId: input.branchId,
      cashSessionId: payment.cashSessionId ?? null,
      externalRef: payment.externalRef ?? null,
      targetChargeIds: frescos.map((c) => c.id),
      idempotencyKey: input.key,
    });
    return r.payment;
  }

  /**
   * Deja dinero A FAVOR del socio sin que entre dinero nuevo: una nota de
   * crédito (pago `CREDIT_NOTE`, sin caja) que queda sin asignar. Así se
   * guarda lo pagado y no usado al bajar de plan (4-05): antes se topaba al
   * cargo nuevo y el resto desaparecía. Si en ese momento debe algo, lo cubre
   * en el acto (DM-02); el resto espera al siguiente cobro o cuota. Movimientos
   * la muestra aparte y no la cuenta como ingreso.
   */
  async abonarSaldoAFavor(ctx: RequestContext, input: {
    memberId: string; branchId: string | null; amountCents: bigint; key: string;
  }): Promise<PaymentRecord> {
    const orgId = ctx.tenant.organizationId;
    if (input.amountCents <= 0n) throw validation('El saldo a favor debe ser positivo');
    return enUnidadDeDinero(orgId, async () => {
    const r = await new PaymentRepository(orgId).record({
      memberId: input.memberId, branchId: input.branchId, method: 'CREDIT_NOTE', amountCents: input.amountCents,
      businessDate: await this.businessDate(orgId, input.branchId), idempotencyKey: input.key,
      createdByUserId: ctx.tenant.actorUserId ?? null,
    });
    if (r.created && r.allocations.length > 0) await this.activateSettledMemberships(ctx, r.allocations.map((a) => a.chargeId));
    await this.refreshCachedBalance(orgId, input.memberId);
    return r.payment;
    });
  }

  /** Lo que cuesta cada decisión sobre una SUSPENDIDA, para que recepción la vea antes de elegir: lo que ya debe, l */
  suspendedDebtOptions(...a: Rest<typeof membership_billing.suspendedDebtOptions>) { return membership_billing.suspendedDebtOptions(this, ...a); }

  /** La decisión del dueño sobre una suspendida que vuelve tarde. · REANUDAR: se emite una cuota por cada periodo q */
  resolveSuspendedDebt(...a: Rest<typeof membership_billing.resolveSuspendedDebt>) { return membership_billing.resolveSuspendedDebt(this, ...a); }

  /**
   * ¿Esta sede lleva Caja? Sin el módulo (ADR-036), el efectivo y la terminal
   * se registran igual, pero sin turno ni corte: es la elección del gimnasio
   * que cobra por transferencia o que no corta cajón.
   */
  /** @internal: lo usan `sales.ts` y `membership-billing.ts`. */
  async conCaja(ctx: RequestContext, branchId: string | null | undefined): Promise<boolean> {
    return ctx.modules ? ctx.modules.at(branchId).has('cash') : isModuleOnAt(ctx.tenant.organizationId, branchId, 'cash');
  }

  /**
   * Resuelve la caja de un cobro de mostrador AHORA, antes de cambiar estado:
   * "hay dos cajas abiertas" o "no hay caja" deben salir antes de mover
   * membresías y emitir cargos, no después.
   */
  /** @internal: lo usan `sales.ts` y `membership-billing.ts`. */
  async cobroValidado(ctx: RequestContext, branchId: string | null, payment: SalePayment | null): Promise<SalePayment | null> {
    if (!payment || !requiresCashSession(payment.method)) return payment;
    if (!(await this.conCaja(ctx, branchId))) return { ...payment, cashSessionId: null };
    if (!branchId) throw validation('Un cobro en caja exige sucursal');
    const sesion = await this.cash.resolveSessionForPayment(ctx, { branchId, cashSessionId: payment.cashSessionId ?? null });
    return { ...payment, cashSessionId: sesion.id };
  }

  /** @internal: lo usan `sales.ts` y `membership-billing.ts`. */
  async openMembershipCharges(orgId: string, memberId: string, membershipId: string): Promise<ChargeRecord[]> {
    return (await new ChargeRepository(orgId).listOutstanding(memberId))
      .filter((c) => c.membershipId === membershipId && saldo(c) > 0n);
  }

  /** AUTORRENOVACIÓN: el periodo terminó y la membresía pasa al siguiente con su cuota emitida. Es lo que hace el j */
  advancePeriod(...a: Rest<typeof membership_billing.advancePeriod>) { return membership_billing.advancePeriod(this, ...a); }

  /** Renovar por adelantado: el periodo siguiente arranca donde termina el actual, y SE COBRA. `MembershipService.r */
  renewMembership(...a: Rest<typeof membership_billing.renewMembership>) { return membership_billing.renewMembership(this, ...a); }

  /** Cambio de plan, COBRADO. El periodo nuevo arranca hoy con el plan nuevo (así lo hace el dominio) y se cobra co */
  changeMembershipPlan(...a: Rest<typeof membership_billing.changeMembershipPlan>) { return membership_billing.changeMembershipPlan(this, ...a); }

  /** Inscripción. Una sola vez por membresía, garantizado por la clave. */
  async createSignupCharge(ctx: RequestContext, membershipId: string): Promise<{ charge: ChargeRecord; created: boolean } | null> {
    const orgId = ctx.tenant.organizationId;
    const membership = await new MembershipRepository(orgId).findById(membershipId);
    if (!membership) throw notFound('Membresía no encontrada');

    const plan = await new PlanRepository(orgId).findById(membership.planId);
    if (!plan) throw notFound('Plan no encontrado');
    if (plan.signupFeeCents <= 0n) return null;

    const { subtotalCents, taxCents } = amountsForPlan(plan, plan.signupFeeCents);

    return new ChargeRepository(orgId).create({
      memberId: membership.memberId,
      membershipId: membership.id,
      branchId: membership.soldAtBranchId,
      chargeType: 'SIGNUP_FEE',
      concept: `Inscripción · ${plan.name}`,
      subtotalCents,
      taxCents,
      dueDate: membership.startDate,
      idempotencyKey: signupFeeKey(membership.id),
      createdByUserId: ctx.tenant.actorUserId ?? null,
    });
  }

  /** Vende un paquete de visitas CON su cargo. Vive en billing y no en memberships porque vender es una operación d */
  sellVisitPack(...a: Rest<typeof sales.sellVisitPack>) { return sales.sellVisitPack(this, ...a); }

  /**
   * Aplica el saldo a favor del socio a su deuda viva (DM-02) y lo deja en la
   * bitácora si movió algo. Idempotente: sin crédito o sin deuda no hace nada.
   */
  async applyCredit(ctx: RequestContext, memberId: string, opts: { activar?: boolean; branchId?: string | null } = {}): Promise<bigint> {
    const orgId = ctx.tenant.organizationId;
    // El reparto, la activación, el saldo y su asiento: juntos o nada (28-10).
    return enUnidadDeDinero(orgId, async () => {
    // El día de la sede donde se aplica (la puerta); sin sede, el del gimnasio (2.13).
    const hoy = await this.businessDate(orgId, opts.branchId ?? null);
    const { aplicadoCents: aplicado, chargeIds } = await new PaymentRepository(orgId).aplicarSaldoAFavor(memberId, hoy, ctx.tenant.actorUserId ?? null);
    if (aplicado > 0n) {
      // Si el crédito liquidó una cuota, la membresía se activa como con un cobro (4-18).
      if (opts.activar !== false) await this.activateSettledMemberships(ctx, chargeIds);
      await this.audit.record(ctx, {
        action: 'billing.credit.apply', resourceType: 'Member', resourceId: memberId,
        afterState: { appliedCents: aplicado.toString() }, reason: 'Saldo a favor aplicado a la deuda',
      });
      await this.refreshCachedBalance(orgId, memberId);
    }
    return aplicado;
    });
  }

  /** Cargo capturado a mano. Exige motivo (permiso `billing:charge:create`). */
  async createManualCharge(ctx: RequestContext, input: {
    memberId: string;
    chargeType: ChargeType;
    concept: string;
    subtotalCents: bigint;
    taxCents?: bigint;
    discountCents?: bigint;
    branchId?: string | null;
    membershipId?: string | null;
    dueDate?: Date;
    reason: string;
    /** Llave del envío: el mismo formulario enviado dos veces es UN cargo. */
    requestKey?: string | null;
  }): Promise<ChargeRecord> {
    const orgId = ctx.tenant.organizationId;

    if (requiresMembership(input.chargeType) && !input.membershipId) {
      throw validation(`Un cargo de tipo ${input.chargeType} exige una membresía`);
    }
    const member = await new MemberRepository(orgId).findById(input.memberId);
    if (!member) throw notFound('Socio no encontrado');

    const branchId = input.branchId ?? ctx.tenant.branchScopeHint ?? null;
    const hoy = await this.businessDate(orgId, branchId);

    // El cargo y su asiento en una unidad (28-10): sin bitácora no hay cargo.
    return enUnidadDeDinero(orgId, async () => {
    const key = input.requestKey ? `manual-${input.memberId}-${input.requestKey}` : null;
    if (key) {
      // El reintento del mismo envío devuelve el cargo que ya existe, sin asentar otra vez.
      const previo = await new ChargeRepository(orgId).findByIdempotencyKey(key);
      if (previo) return previo;
    }
    const { charge } = await new ChargeRepository(orgId).create({
      memberId: input.memberId,
      membershipId: input.membershipId ?? null,
      branchId,
      chargeType: input.chargeType,
      concept: input.concept,
      subtotalCents: input.subtotalCents,
      ...(input.taxCents !== undefined ? { taxCents: input.taxCents } : {}),
      ...(input.discountCents !== undefined ? { discountCents: input.discountCents } : {}),
      dueDate: input.dueDate ?? hoy,
      ...(key ? { idempotencyKey: key } : {}),
      createdByUserId: ctx.tenant.actorUserId ?? null,
    });

    await this.audit.record(ctx, {
      action: 'billing.charge.create',
      resourceType: 'charge',
      resourceId: charge.id,
      afterState: { type: charge.chargeType, amountCents: charge.amountCents.toString(), concept: charge.concept },
      reason: input.reason,
      branchId,
    });

    return charge;
    });
  }

  /**
   * Descuento o condonación. No modifica el importe original: añade un asiento
   * de ajuste. Así la pregunta "¿cuánto se dejó de cobrar y quién lo autorizó?"
   * tiene respuesta, que es justo lo que un `UPDATE` al cargo destruiría.
   */
  async adjustCharge(ctx: RequestContext, input: {
    chargeId: string;
    adjustmentType: AdjustmentType;
    amountCents: bigint;
    reason: string;
    /** Motivo de CATÁLOGO. Obligatorio en descuentos y condonaciones. */
    reasonCode?: string | null;
    approvedByUserId?: string | null;
  }): Promise<ChargeRecord> {
    // Una unidad: si la bitácora no se escribe, la operación no ocurre (OPT2-14).
    return enUnidadDeDinero(ctx.tenant.organizationId, async () => {
      const orgId = ctx.tenant.organizationId;
      const repo = new ChargeRepository(orgId);

      const charge = await repo.findById(input.chargeId);
      if (!charge) throw notFound('Cargo no encontrado');
      if (charge.status === 'VOID' || charge.status === 'WRITTEN_OFF') {
        throw conflict(`Un cargo en ${charge.status} ya no admite ajustes`);
      }

      const pendiente = charge.amountCents - charge.allocatedCents - charge.adjustedCents;
      if (input.amountCents > 0n && input.amountCents > pendiente) {
        throw validation(
          `El ajuste (${input.amountCents}) supera el saldo pendiente (${pendiente}). ` +
          'Un excedente debe devolverse como reembolso, no como ajuste',
        );
      }

      if ((input.adjustmentType === 'DISCOUNT' || input.adjustmentType === 'WAIVER')
          && !codigosDeAjuste(input.adjustmentType).includes(input.reasonCode ?? '')) {
        throw validation(
          'Un descuento o condonación exige un motivo del catálogo: ' +
          'el texto libre produce "desc" y "autorizado", y nada analizable',
        );
      }

      const hoy = await this.businessDate(orgId, charge.branchId);
      const updated = await repo.adjust({
        chargeId: input.chargeId,
        adjustmentType: input.adjustmentType,
        amountCents: input.amountCents,
        reason: input.reason,
        reasonCode: input.reasonCode ?? null,
        approvedByUserId: input.approvedByUserId ?? null,
        createdByUserId: ctx.tenant.actorUserId ?? null,
        today: hoy,
      });

      await this.audit.record(ctx, {
        action: input.adjustmentType === 'WAIVER' ? 'billing.waiver.apply' : 'billing.discount.apply',
        resourceType: 'charge',
        resourceId: input.chargeId,
        beforeState: { adjustedCents: charge.adjustedCents.toString(), status: charge.status },
        afterState: {
          adjustedCents: updated.adjustedCents.toString(),
          status: updated.status,
          reasonCode: input.reasonCode ?? null,
        },
        reason: input.reason,
        approvedByUserId: input.approvedByUserId ?? null,
        branchId: charge.branchId,
      });

      return updated;
    });
  }

  /** Anulación: el cargo nunca debió existir. Sin cobros aplicados. */
  async voidCharge(ctx: RequestContext, input: {
    chargeId: string; reason: string; approvedByUserId?: string | null;
  }): Promise<ChargeRecord> {
    // Una unidad: si la bitácora no se escribe, la operación no ocurre (OPT2-14).
    return enUnidadDeDinero(ctx.tenant.organizationId, async () => {
      const orgId = ctx.tenant.organizationId;
      const repo = new ChargeRepository(orgId);

      const charge = await repo.findById(input.chargeId);
      if (!charge) throw notFound('Cargo no encontrado');
      if (charge.allocatedCents > 0n) {
        throw conflict('El cargo ya tiene pagos aplicados. Revierte el pago antes de anularlo', 'CHARGE_HAS_PAYMENTS');
      }
      if (charge.status === 'VOID') throw conflict('El cargo ya está anulado', 'ALREADY_VOIDED');

      const updated = await repo.voidCharge(input.chargeId, input.reason);
      if (!updated) throw conflict('El cargo cambió mientras se anulaba: ya tiene pagos o ya estaba anulado');

      await this.audit.record(ctx, {
        action: 'billing.charge.void',
        resourceType: 'charge',
        resourceId: input.chargeId,
        beforeState: { status: charge.status, amountCents: charge.amountCents.toString() },
        afterState: { status: updated.status },
        reason: input.reason,
        approvedByUserId: input.approvedByUserId ?? null,
        branchId: charge.branchId,
      });

      return updated;
    });
  }

  // ── Pagos ─────────────────────────────────────────────────────────────────

  /**
   * Registra un cobro y lo aplica a la deuda más antigua.
   * El excedente queda como SALDO A FAVOR: nunca se crea un cargo negativo.
   */
  async recordPayment(ctx: RequestContext, input: {
    memberId: string;
    method: PaymentMethodType;
    amountCents: bigint;
    branchId?: string | null;
    idempotencyKey?: string | null;
    externalRef?: string | null;
    targetChargeIds?: string[] | undefined;
    /** Caja donde se recibe. Solo para cobros de mostrador. */
    cashSessionId?: string | null;
  }): Promise<{
    payment: PaymentRecord;
    allocations: Array<{ chargeId: string; amountCents: bigint }>;
    unappliedCents: bigint;
    created: boolean;
    /** Saldo a favor que se aplicó a su deuda antes de repartir este cobro (4-18). */
    creditAppliedCents: bigint;
  }> {
    const orgId = ctx.tenant.organizationId;

    if (input.amountCents <= 0n) throw validation('El importe debe ser positivo');

    // Una unidad: folio, pago, activación de la membresía, saldo y bitácora
    // se confirman juntos. Antes eran tres transacciones y dos escrituras
    // sueltas: un pago podía quedar sin bitácora o con folio gastado (OPT3-05).
    return enUnidadDeDinero(orgId, async () => {
    // A un socio dado de baja también se le cobra lo que quedó debiendo (D-12; bloque 4.11):
    // su deuda sigue en «Por cobrar» y esta es una de sus tres salidas.
    const member = await new MemberRepository(orgId).findByIdIncludingArchived(input.memberId);
    if (!member) throw notFound('Socio no encontrado');

    const branchId = input.branchId ?? ctx.tenant.branchScopeHint ?? null;
    const pagos = new PaymentRepository(orgId);

    // La llave se mira ANTES que la caja y el folio (1.1 §7-4): el reintento
    // de un cobro que ya quedó registrado es ese mismo cobro. Antes buscaba
    // caja y gastaba un folio primero: con la caja ya cerrada respondía 409
    // («no hay caja abierta») a un cobro que sí se había hecho, y con la caja
    // abierta dejaba un hueco en la numeración.
    const reintento = input.idempotencyKey ? await pagos.findByIdempotencyKey(input.idempotencyKey) : null;
    if (reintento) {
      const hecho = await pagos.record({
        memberId: input.memberId, branchId, method: input.method, amountCents: input.amountCents,
        businessDate: reintento.businessDate, idempotencyKey: input.idempotencyKey ?? null,
      });
      return { ...hecho, creditAppliedCents: 0n };
    }

    // Un cobro de mostrador SIEMPRE pertenece a un turno. Sin esto el efectivo
    // entra al sistema sin entrar a ningún cajón, y el corte deja de cuadrar
    // contra la realidad física, que es lo único que el corte mide.
    let cashSessionId: string | null = null;
    let folio: string | null = null;
    if (requiresCashSession(input.method) && await this.conCaja(ctx, branchId)) {
      if (!branchId) {
        throw validation(`Un cobro en ${input.method} exige sucursal: sin ella no hay corte de caja posible`);
      }
      const session = await this.cash.resolveSessionForPayment(ctx, {
        branchId,
        cashSessionId: input.cashSessionId ?? null,
      });
      cashSessionId = session.id;
      folio = await this.cash.nextFolio(ctx, session);
    }

    const hoy = await this.businessDate(orgId, branchId);

    // El saldo a favor se aplica ANTES de repartir el cobro (4-18, DM-02):
    // antes solo cubría la cuota que nacía después, y si el crédito llegaba
    // con la cuota ya emitida se cobraba completa. Un reintento con la misma
    // clave es el mismo cobro y ya respondió arriba: no vuelve a tocar nada.
    const credito = await pagos.aplicarSaldoAFavor(input.memberId, hoy, ctx.tenant.actorUserId ?? null);

    const result = await pagos.record({
      memberId: input.memberId,
      branchId,
      method: input.method,
      amountCents: input.amountCents,
      businessDate: hoy,
      idempotencyKey: input.idempotencyKey ?? null,
      externalRef: input.externalRef ?? null,
      targetChargeIds: input.targetChargeIds,
      cashSessionId,
      folio,
      createdByUserId: ctx.tenant.actorUserId ?? null,
    });

    // Un reintento idempotente NO vuelve a auditar: sería un segundo cobro
    // aparente en la bitácora que el dueño leería como duplicado.
    if (result.created) {
      await this.audit.record(ctx, {
        action: 'payments.record',
        resourceType: 'payment',
        resourceId: result.payment.id,
        afterState: {
          amountCents: result.payment.amountCents.toString(),
          method: result.payment.method,
          allocations: result.allocations.length,
          unappliedCents: result.unappliedCents.toString(),
          folio: result.payment.folio,
          ...(credito.aplicadoCents > 0n ? { creditAppliedCents: credito.aplicadoCents.toString() } : {}),
        },
        branchId,
      });
    }

    // Cobrar y NO abrir el torniquete es la queja nº1 del sistema actual.
    // Por eso la liquidación del cargo dispara la transición de la membresía
    // en el mismo flujo, no en un job nocturno.
    if (result.created) {
      await this.activateSettledMemberships(ctx, [...new Set([...credito.chargeIds, ...result.allocations.map((a) => a.chargeId)])]);
    }

    await this.refreshCachedBalance(orgId, input.memberId);
    return { ...result, creditAppliedCents: credito.aplicadoCents };
    });
  }

  /**
   * Lo mismo que hace `recordPayment` después de registrar el dinero, para
   * los pagos que NO pasan por el mostrador: la tarjeta domiciliada desde el
   * portal y el intento que se resuelve después.
   *
   * Sin esto, el socio pagaba desde su teléfono, el cargo quedaba PAGADO y su
   * membresía seguía SUSPENDIDA: pagó y el torniquete no lo dejaba pasar.
   */
  async settleExternalPayment(ctx: RequestContext, memberId: string, chargeIds: string[]): Promise<void> {
    await enUnidadDeDinero(ctx.tenant.organizationId, async () => {
      await this.activateSettledMemberships(ctx, chargeIds);
      await this.refreshCachedBalance(ctx.tenant.organizationId, memberId);
    });
  }

  /**
   * Para cada cargo de periodo que quedó LIQUIDADO, empuja su membresía al
   * estado que corresponde. Un fallo aquí no revierte el cobro: el dinero ya
   * entró y perderlo sería peor que dejar la membresía un paso atrás, así que
   * se registra y se deja al job diario reconciliar.
   */
  /** @internal: lo usan `sales.ts` (venta cubierta con saldo a favor) y el cobro. */
  async activateSettledMemberships(ctx: RequestContext, chargeIds: string[]): Promise<void> {
    if (chargeIds.length === 0) return;
    const orgId = ctx.tenant.organizationId;
    const repo = new ChargeRepository(orgId);

    const vistas = new Set<string>();
    const membresias = new MembershipRepository(orgId);
    for (const chargeId of chargeIds) {
      const charge = await repo.findById(chargeId);
      if (!charge || charge.status !== 'PAID') continue;
      // Un paquete de visitas pagado empieza a dar acceso (BE2-03).
      if (charge.chargeType === 'VISIT_PACK') {
        const pack = await new VisitPackRepository(orgId).findByChargeId(charge.id);
        if (pack) await new VisitPackRepository(orgId).activateIfPending(pack.id);
        continue;
      }
      if (charge.chargeType !== 'MEMBERSHIP_PERIOD' && charge.chargeType !== 'SIGNUP_FEE') continue;
      if (!charge.membershipId || vistas.has(charge.membershipId)) continue;
      vistas.add(charge.membershipId);

      // Se activa cuando la membresía YA NO DEBE nada de lo que da acceso,
      // no cuando se paga cualquiera de sus cargos: pagar solo la inscripción
      // daba el mes completo con la cuota pendiente.
      const m = await membresias.findById(charge.membershipId);
      if (!m || await repo.membershipHasOpenDues(m.id, m.currentPeriodStart)) continue;

      try {
        await this.memberships.settleByPayment(ctx, charge.membershipId);
      } catch (err) {
        await this.audit.record(ctx, {
          action: 'billing.settlement.deferred',
          resourceType: 'membership',
          resourceId: charge.membershipId,
          afterState: { chargeId, error: err instanceof Error ? err.message : String(err) },
          branchId: charge.branchId,
        });
      }
    }
  }

  /** Contra-asiento. Nunca borra: el histórico queda reconstruible. */
  async reversePayment(ctx: RequestContext, input: {
    paymentId: string;
    reason: string;
    approvedByUserId?: string | null;
    /** Caja de la que SALE el dinero. Obligatoria si hay varias abiertas. */
    cashSessionId?: string | null;
  }): Promise<PaymentRecord> {
    // Una unidad: si la bitácora no se escribe, la operación no ocurre (OPT2-14).
    return enUnidadDeDinero(ctx.tenant.organizationId, async () => {
      const orgId = ctx.tenant.organizationId;
      const repo = new PaymentRepository(orgId);

      const original = await repo.findById(input.paymentId);
      if (!original) throw notFound('Pago no encontrado');

      const verdict = canReverse(original.status, false);
      if (!verdict.ok) throw conflict(verdict.reason);
      // Con reembolsos ya hechos, revertir completo devolvería dos veces.
      if (await repo.hasCounterEntries(original.id)) {
        throw conflict('Ese pago ya tiene reembolsos: lo que queda se devuelve con otro reembolso, no con una reversa', 'PAYMENT_HAS_REFUNDS');
      }

      const hoy = await this.businessDate(orgId, original.branchId);

      // El dinero SALE del cajón hoy, no el día del cobro original: imputarlo al
      // turno original descuadraría un corte ya cerrado y firmado.
      let cashSessionId: string | null = null;
      let folio: string | null = null;
      if (requiresCashSession(original.method) && original.branchId && await this.conCaja(ctx, original.branchId)) {
        const session = await this.cash.resolveSessionForPayment(ctx, {
          branchId: original.branchId,
          cashSessionId: input.cashSessionId ?? null,
        });
        cashSessionId = session.id;
        folio = await this.cash.nextFolio(ctx, session);
      }

      const { reversal } = await repo.reverse({
        paymentId: input.paymentId,
        reason: input.reason,
        businessDate: hoy,
        cashSessionId,
        folio,
        createdByUserId: ctx.tenant.actorUserId ?? null,
      });

      // El cobro ya no existe: la membresía que se había activado con él vuelve
      // a deber. Antes seguía activa todo el periodo sin haber pagado.
      const cargos = (await repo.listAllocations(reversal.id)).map((a) => a.chargeId);
      await this.reevaluateAfterUnwind(ctx, cargos, hoy);

      // Un pase del día no queda a deber (1.8): si se revierte su cobro, su cargo
      // se anula en esta misma unidad. Sin esto el visitante entraba a cartera
      // debiendo un pase que ya no le abre.
      const cargosRepo = new ChargeRepository(orgId);
      for (const chargeId of cargos) {
        const c = await cargosRepo.findById(chargeId);
        if (c && c.chargeType === 'DAY_PASS' && c.membershipId === null && c.allocatedCents === 0n) {
          await cargosRepo.voidCharge(c.id, `Se revirtió su cobro: ${input.reason}`);
        }
      }

      await this.refreshCachedBalance(orgId, original.memberId);
      // La bitácora al final: toma el candado de la organización hasta confirmar.
      await this.audit.record(ctx, {
        action: 'payments.reverse',
        resourceType: 'payment',
        resourceId: input.paymentId,
        beforeState: { status: original.status, amountCents: original.amountCents.toString() },
        afterState: { status: 'REVERSED', reversalId: reversal.id },
        reason: input.reason,
        approvedByUserId: input.approvedByUserId ?? null,
        branchId: original.branchId,
      });
      return reversal;
    });
  }

  /**
   * CONTRACARGO: el banco ya se llevó el dinero. Se asienta como una reversa
   * (sin caja: no sale del cajón) y la membresía vuelve a deber. Antes el pago
   * solo cambiaba de estado: el cargo seguía pagado y el socio, activo.
   *
   * Si el pago ya tenía reembolsos, revertirlo completo contaría dos veces:
   * se deja registrado para revisión manual en lugar de adivinar.
   */
  async recordChargeback(ctx: RequestContext, paymentId: string): Promise<'UNWOUND' | 'NEEDS_REVIEW'> {
    const orgId = ctx.tenant.organizationId;
    // La reversa, la membresía que vuelve a deber, el saldo y el asiento: una unidad (28-10).
    return enUnidadDeDinero(orgId, async () => {
    const repo = new PaymentRepository(orgId);
    const pago = await repo.findById(paymentId);
    if (!pago) throw notFound('Pago no encontrado');
    if (await repo.hasCounterEntries(paymentId)) {
      await this.audit.record(ctx, {
        action: 'payments.chargeback.needs_review', resourceType: 'payment', resourceId: paymentId,
        afterState: { motivo: 'El pago ya tenía reembolsos; el contracargo se revisa a mano' }, branchId: pago.branchId,
      });
      return 'NEEDS_REVIEW' as const;
    }
    const hoy = await this.businessDate(orgId, pago.branchId);
    const { reversal } = await repo.reverse({
      paymentId, reason: 'Contracargo del banco', businessDate: hoy, cashSessionId: null, folio: null, createdByUserId: null,
    });
    await this.reevaluateAfterUnwind(ctx, (await repo.listAllocations(reversal.id)).map((a) => a.chargeId), hoy);
    await this.refreshCachedBalance(orgId, pago.memberId);
    await this.audit.record(ctx, {
      action: 'payments.chargeback', resourceType: 'payment', resourceId: paymentId,
      afterState: { reversalId: reversal.id }, branchId: pago.branchId,
    });
    return 'UNWOUND' as const;
    });
  }

  /**
   * Reembolso ya confirmado por el procesador: se asienta en el libro (ver
   * `PaymentRepository.recordRefund`). Lo llama el módulo de pagos.
   */
  async recordRefund(ctx: RequestContext, input: { paymentId: string; amountCents: bigint; reason: string }): Promise<void> {
    const orgId = ctx.tenant.organizationId;
    // El contra-asiento, el saldo y la bitácora: una unidad (28-10).
    await enUnidadDeDinero(orgId, async () => {
    const repo = new PaymentRepository(orgId);
    const pago = await repo.findById(input.paymentId);
    if (!pago) throw notFound('Pago no encontrado');
    const hoy = await this.businessDate(orgId, pago.branchId);
    const { refundEntry } = await repo.recordRefund({
      paymentId: input.paymentId, amountCents: input.amountCents, reason: input.reason,
      businessDate: hoy, createdByUserId: ctx.tenant.actorUserId ?? null,
    });
    await this.audit.record(ctx, {
      action: 'payments.refund.ledger', resourceType: 'payment', resourceId: input.paymentId,
      afterState: { refundEntryId: refundEntry.id, amountCents: input.amountCents.toString() },
      reason: input.reason, branchId: pago.branchId,
    });
    await this.refreshCachedBalance(orgId, pago.memberId);
    });
  }

  /**
   * Tras deshacer un cobro: si una membresía vigente vuelve a deber su
   * inscripción o su cuota, pasa a mora con la gracia vencida (mañana la
   * suspende el job si nadie paga). No hay transición de "activa" a "por
   * activar", y dejarla activa era regalar el periodo.
   */
  private async reevaluateAfterUnwind(ctx: RequestContext, chargeIds: string[], hoy: Date): Promise<void> {
    const orgId = ctx.tenant.organizationId;
    const cargos = new ChargeRepository(orgId);
    const membresias = new MembershipRepository(orgId);
    const ids = new Set<string>();
    for (const id of chargeIds) {
      const c = await cargos.findById(id);
      if (c?.membershipId && (c.chargeType === 'MEMBERSHIP_PERIOD' || c.chargeType === 'SIGNUP_FEE')) ids.add(c.membershipId);
    }
    for (const id of ids) {
      const m = await membresias.findById(id);
      if (!m || m.status !== 'ACTIVE' || !(await cargos.membershipHasOpenDues(m.id, m.currentPeriodStart))) continue;
      const graceUntil = hoy < m.currentPeriodStart ? m.currentPeriodStart : hoy;
      await membresias.transition({
        membershipId: m.id, fromStatus: 'ACTIVE', toStatus: 'PAST_DUE', eventType: 'PAST_DUE',
        data: { graceUntil }, payload: { motivo: 'Se deshizo el cobro que la había pagado' },
        actorUserId: ctx.tenant.actorUserId ?? null, businessDate: hoy,
      });
    }
  }

  /**
   * Actualiza el saldo CACHEADO del socio (ADR-005).
   * Es caché para listados; ninguna pantalla de decisión financiera lo lee, y
   * un job diario lo reconcilia contra el derivado real.
   */
  async refreshCachedBalance(organizationId: string, memberId: string): Promise<bigint> {
    const outstanding = await new ChargeRepository(organizationId).outstandingTotalCents(memberId);
    const credit = await new PaymentRepository(organizationId).creditBalanceCents(memberId);
    const neto = outstanding - credit;
    await new MemberRepository(organizationId).setCachedBalance(memberId, neto);
    return neto;
  }
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Lo que falta por cubrir de un cargo. */
export function saldo(c: ChargeRecord): bigint {
  return c.amountCents - c.allocatedCents - c.adjustedCents;
}
