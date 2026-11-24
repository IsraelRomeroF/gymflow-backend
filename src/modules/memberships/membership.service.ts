import {
  addDays, applyFreeze, autoRenewFor, conflict, evaluateFreeze, findTransition,
  firstPeriod, nextPeriod, missedPeriods, prorationBasis, validation, notFound, MAX_MISSED_PERIODS,
  type MembershipTrigger, type Period, type PlanBillingModel, type PlanDuration,
} from '@gymflow/core';
import { BranchRepository } from '../organization/index.js';
import { MemberRepository } from '../members/index.js';
import { emitMembershipClosed } from './closed-hooks.js';
import { MembershipRepository, type MembershipRecord } from './membership.repository.js';
import { PlanRepository, type PlanRecord } from '../catalog/index.js';
import { enUnidadDeDinero } from '../../platform/db/unit-of-work.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { RequestContext } from '../../platform/context.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';

const EVENT_BY_TRIGGER: Record<MembershipTrigger, string> = {
  ACTIVATE: 'ACTIVATED',
  START_TRIAL: 'TRIAL_STARTED',
  TRIAL_CONVERTED: 'ACTIVATED',
  TRIAL_FAILED: 'PAST_DUE',
  CHARGE_OVERDUE: 'PAST_DUE',
  PAYMENT_SETTLED: 'REACTIVATED',
  GRACE_EXPIRED: 'SUSPENDED',
  FREEZE: 'FROZEN',
  UNFREEZE: 'UNFROZEN',
  FREEZE_LIMIT_EXCEEDED: 'EXPIRED',
  RENEW: 'RENEWED',
  PLAN_CHANGED: 'PLAN_CHANGED',
  PERIOD_ENDED: 'EXPIRED',
  RECOVERY_WINDOW_EXPIRED: 'EXPIRED',
  DEBT_RESUMED: 'DEBT_RESUMED',
  DEBT_FORGIVEN: 'DEBT_FORGIVEN',
  CANCEL: 'CANCELED',
};

function durationOf(plan: PlanRecord): PlanDuration {
  return { unit: plan.durationUnit as PlanDuration['unit'], value: plan.durationValue };
}

export class MembershipService {
  private readonly audit = new AuditService();

  private async businessDate(organizationId: string, branchId: string | null): Promise<Date> {
    return new BusinessCalendar(organizationId).today(branchId);
  }

  /**
   * Alta. Nace en PENDING: hasta que el primer cargo se liquide no otorga
   * acceso. El ancla de facturación se fija AQUÍ y no vuelve a calcularse.
   */
  async create(ctx: RequestContext, input: {
    memberId: string; planId: string; soldAtBranchId: string | null;
    startDate?: Date; billingAnchorDay?: number; autoRenew?: boolean; branchIds?: string[]; saleKey?: string | null;
    /** Precio pactado (DM-05): lo fija la venta y lo respetan todas las cuotas. */
    agreedPriceCents?: bigint | null;
  }): Promise<MembershipRecord> {
    const orgId = ctx.tenant.organizationId;

    const member = await new MemberRepository(orgId).findById(input.memberId);
    if (!member) throw notFound('Socio no encontrado');

    const plan = await new PlanRepository(orgId).findById(input.planId);
    if (!plan) throw notFound('Plan no encontrado');
    if (!plan.isActive) throw validation('El plan no está activo');
    if (plan.billingModel === 'VISIT_PACK') {
      throw validation('Un paquete de visitas se vende con /visit-packs, no crea membresía por periodo');
    }
    // La visita suelta es un pase del día (bloque 1.8, 4-01): un cargo y el
    // acceso de ese día, sin membresía. Ninguna puerta vuelve a crear una
    // membresía de un día (la venta, la corrección a mano).
    if (plan.billingModel === 'DAY_PASS') {
      throw validation('La visita suelta se vende como pase del día, no crea membresía', undefined, 'SOLD_AS_DAY_PASS');
    }

    const memberships = new MembershipRepository(orgId);
    const live = await memberships.findLiveForMember(input.memberId);
    if (live) {
      // La constraint parcial de la base también lo impide; aquí se explica.
      throw conflict('El socio ya tiene una membresía vigente. Cámbiala de plan o cancélala primero', 'MEMBERSHIP_ALREADY_ACTIVE');
    }

    if (input.soldAtBranchId) {
      const branch = await new BranchRepository(orgId).findById(input.soldAtBranchId);
      if (!branch) throw validation('La sucursal indicada no existe en esta organización');
    }

    const startDate = input.startDate ?? await this.businessDate(orgId, input.soldAtBranchId);
    const anchor = input.billingAnchorDay ?? startDate.getUTCDate();
    if (anchor < 1 || anchor > 31) throw validation('El día de corte debe estar entre 1 y 31');

    const period = firstPeriod(startDate, durationOf(plan), anchor);

    // La membresía y su asiento se confirman juntos (28-10).
    return enUnidadDeDinero(orgId, async () => {
    const membership = await memberships.create({
      memberId: input.memberId,
      planId: input.planId,
      soldAtBranchId: input.soldAtBranchId,
      startDate,
      periodStart: period.start,
      periodEnd: period.end,
      billingAnchorDay: anchor,
      // Por modelo de plan (4-01, 4-02, D-14): la visita suelta nunca se
      // renueva y el pago anticipado solo si se eligió en la venta.
      autoRenew: autoRenewFor(plan.billingModel as PlanBillingModel, input.autoRenew, plan.autoRenewDefault),
      branchIds: input.branchIds ?? [],
      createdByUserId: ctx.tenant.actorUserId!,
      saleKey: input.saleKey ?? null,
      agreedPriceCents: input.agreedPriceCents ?? null,
      // D-19 (bloque 3.6): un precio pactado distinto al de lista de su sede nace
      // marcado «conserva su precio»; el que es igual al de lista sigue al plan.
      priceProtected: input.agreedPriceCents != null
        && input.agreedPriceCents !== await new PlanRepository(orgId).listPriceAt(input.planId, input.soldAtBranchId),
    });

    await this.audit.record(ctx, {
      action: 'membership.create',
      resourceType: 'Membership',
      resourceId: membership.id,
      branchId: input.soldAtBranchId,
      afterState: {
        memberCode: member.memberCode, plan: plan.code, status: 'PENDING',
        period: { start: iso(period.start), end: iso(period.end) }, anchor,
      },
    });
    return membership;
    });
  }

  /** Aplica una transición validándola primero contra la máquina de estados. */
  private async apply(
    ctx: RequestContext,
    membership: MembershipRecord,
    trigger: MembershipTrigger,
    opts: {
      data?: Record<string, unknown>;
      payload?: Record<string, unknown>;
      reason?: string | null;
      branchId?: string | null;
      expectedPeriodStart?: Date;
    } = {},
  ): Promise<MembershipRecord> {
    const transition = findTransition(membership.status, trigger);
    if (!transition) {
      throw conflict(`No se puede aplicar ${trigger} a una membresía en estado ${membership.status}`);
    }
    if (transition.requiresReason && !opts.reason?.trim()) {
      throw validation(`La transición ${membership.status} → ${transition.to} exige un motivo`);
    }

    // La gracia solo existe en mora. Si sobreviviera al salir de PAST_DUE
    // (p. ej. pagar una suspendida), el siguiente movimiento del periodo
    // —cambio de plan, renovación— chocaría con `graceUntil >= inicio`.
    const data = transition.to === 'PAST_DUE' ? opts.data : { graceUntil: null, ...opts.data };

    const orgId = ctx.tenant.organizationId;
    const branchId = opts.branchId ?? membership.soldAtBranchId;
    // La transición y su asiento en UNA unidad (28-10, fase 1.3): antes la
    // membresía cambiaba y la bitácora se escribía después, por su cuenta; si
    // esa escritura fallaba, el cambio quedaba sin rastro. Es una unidad de
    // DINERO (toma primero el candado de la organización) porque los cobros
    // mueven estas mismas filas: con otro orden se esperarían entre sí.
    return enUnidadDeDinero(orgId, async () => {
    const updated = await new MembershipRepository(orgId).transition({
      membershipId: membership.id,
      fromStatus: membership.status,
      toStatus: transition.to,
      eventType: EVENT_BY_TRIGGER[trigger],
      ...(data ? { data } : {}),
      ...(opts.payload ? { payload: opts.payload } : {}),
      reason: opts.reason ?? null,
      actorUserId: ctx.tenant.actorUserId ?? null,
      branchId,
      businessDate: await this.businessDate(orgId, branchId),
      ...(opts.expectedPeriodStart ? { expectedPeriodStart: opts.expectedPeriodStart } : {}),
    });

    await this.audit.record(ctx, {
      action: `membership.${trigger.toLowerCase()}`,
      resourceType: 'Membership',
      resourceId: membership.id,
      branchId,
      beforeState: { status: membership.status, periodEnd: iso(membership.currentPeriodEnd) },
      afterState: { status: updated.status, periodEnd: iso(updated.currentPeriodEnd) },
      reason: opts.reason ?? null,
    });
    return updated;
    });
  }

  async activate(ctx: RequestContext, membershipId: string): Promise<MembershipRecord> {
    const m = await this.require(ctx, membershipId);
    const trigger: MembershipTrigger = m.status === 'TRIALING' ? 'TRIAL_CONVERTED' : 'ACTIVATE';
    return this.apply(ctx, m, trigger);
  }

  /**
   * El cobro liquidó la cuota del periodo.
   *
   * Es lo que convierte un pago en ACCESO. Sin este paso el socio paga en el
   * mostrador y el torniquete sigue cerrado, que es exactamente la queja que
   * hoy llena el buzón de BDKGYM.
   *
   * Devuelve `null` cuando la membresía ya estaba vigente: pagar por
   * adelantado NO es una transición de estado.
   */
  async settleByPayment(ctx: RequestContext, membershipId: string): Promise<MembershipRecord | null> {
    const m = await this.require(ctx, membershipId);
    const trigger: MembershipTrigger | null =
      m.status === 'PENDING' ? 'ACTIVATE'
      : m.status === 'TRIALING' ? 'TRIAL_CONVERTED'
      : (m.status === 'PAST_DUE' || m.status === 'SUSPENDED') ? 'PAYMENT_SETTLED'
      : null;
    if (!trigger) return null;
    return this.apply(ctx, m, trigger);
  }

  /**
   * Congelamiento: EXTIENDE el periodo por los días pausados y NO mueve el
   * ancla. Si el ancla se moviera, las pausas repetidas desplazarían la fecha
   * de corte por todo el calendario y el socio dejaría de reconocer su día.
   */
  async freeze(ctx: RequestContext, membershipId: string, days: number, reason: string): Promise<MembershipRecord> {
    const orgId = ctx.tenant.organizationId;
    const m = await this.require(ctx, membershipId);
    const plan = await new PlanRepository(orgId).findById(m.planId);
    if (!plan) throw notFound('Plan no encontrado');

    const currentYear = new Date().getUTCFullYear();
    const usedThisYear = m.frozenDaysUsedYear === currentYear ? m.frozenDaysUsedThisYear : 0;

    const verdict = evaluateFreeze(
      { allowFreeze: plan.allowFreeze, minFreezeDays: plan.minFreezeDays, maxFreezeDaysPerYear: plan.maxFreezeDaysPerYear },
      days,
      usedThisYear,
    );
    if (!verdict.ok) throw validation(verdict.reason);

    const from = await this.businessDate(orgId, m.soldAtBranchId);
    return this.apply(ctx, m, 'FREEZE', {
      reason,
      data: {
        frozenSince: from,
        frozenUntil: addDays(from, days),
        frozenDaysUsedThisYear: usedThisYear + days,
        frozenDaysUsedYear: currentYear,
      },
      payload: { days, usedThisYear: usedThisYear + days, cupoAnual: plan.maxFreezeDaysPerYear },
    });
  }

  async unfreeze(ctx: RequestContext, membershipId: string): Promise<MembershipRecord> {
    const orgId = ctx.tenant.organizationId;
    const m = await this.require(ctx, membershipId);
    if (m.status !== 'FROZEN') throw conflict('La membresía no está congelada');

    const today = await this.businessDate(orgId, m.soldAtBranchId);
    const since = m.frozenSince ?? today;
    // Solo se extiende por los días EFECTIVAMENTE pausados, no por los
    // solicitados: quien reactiva antes no regala días al gimnasio ni al revés.
    const effectiveDays = Math.max(0, Math.round((today.getTime() - since.getTime()) / 86_400_000));

    const period: Period = { start: m.currentPeriodStart, end: m.currentPeriodEnd };
    const extended = applyFreeze(period, effectiveDays);

    return this.apply(ctx, m, 'UNFREEZE', {
      data: { currentPeriodEnd: extended.end, frozenSince: null, frozenUntil: null },
      payload: { effectiveDays, periodEndBefore: iso(period.end), periodEndAfter: iso(extended.end) },
    });
  }

  /**
   * Cambio de plan con prorrateo por DÍAS REALES del ciclo.
   *
   * Devuelve la base de prorrateo para que el Sprint 4 genere el cargo o el
   * crédito de ajuste: aquí todavía no hay libro financiero, así que se
   * calcula y se deja registrado, pero no se cobra nada.
   */
  async changePlan(ctx: RequestContext, membershipId: string, newPlanId: string, reason: string) {
    const orgId = ctx.tenant.organizationId;
    const m = await this.require(ctx, membershipId);
    if (m.planId === newPlanId) throw validation('La membresía ya está en ese plan');

    const plans = new PlanRepository(orgId);
    const [oldPlan, newPlan] = await Promise.all([plans.findById(m.planId), plans.findById(newPlanId)]);
    if (!newPlan) throw notFound('Plan no encontrado');
    if (!newPlan.isActive) throw validation('El plan destino no está activo');
    if (newPlan.billingModel === 'VISIT_PACK') throw validation('No se puede cambiar a un paquete de visitas');
    // Una membresía no se convierte en visita suelta (4-05): eso la volvía
    // una membresía de un día y se perdía lo pagado. Se le vende aparte.
    if (newPlan.billingModel === 'DAY_PASS') throw validation('No se puede cambiar a una visita suelta: la visita se vende aparte');

    // El cambio PACTA el precio del plan nuevo (fase 1.3; 16-04, D-19): el que
    // se vende hoy en su sede. Antes quedaba sin pactado y cada cuota tomaba
    // el precio de lista del día; si la sede dejaba de venderlo, no renovaba.
    const pactado = await plans.effectivePriceCents(newPlanId, m.soldAtBranchId);
    if (pactado === null) throw conflict('Ese plan no se vende en la sucursal de la membresía', 'PLAN_NOT_SOLD_AT_BRANCH');

    const today = await this.businessDate(orgId, m.soldAtBranchId);
    const basis = prorationBasis({ start: m.currentPeriodStart, end: m.currentPeriodEnd }, today);

    // El nuevo periodo arranca hoy y conserva el ANCLA original.
    const period = firstPeriod(today, durationOf(newPlan), m.billingAnchorDay);

    // Con el mismo modelo se respeta lo que se eligió; al cambiar de modelo
    // manda la regla del nuevo (a pago anticipado, no se renueva: D-14).
    const autoRenew = autoRenewFor(
      newPlan.billingModel as PlanBillingModel,
      oldPlan && oldPlan.billingModel === newPlan.billingModel ? m.autoRenew : undefined,
      newPlan.autoRenewDefault,
    );
    const updated = await this.apply(ctx, m, 'PLAN_CHANGED', {
      reason,
      // El pactado anterior era del plan anterior: el nuevo queda pactado a su precio vigente de hoy.
      // La marca «conserva su precio» era del plan anterior: el nuevo queda al de lista y sigue al plan (D-19).
      data: { planId: newPlanId, currentPeriodStart: period.start, currentPeriodEnd: period.end, agreedPriceCents: pactado, autoRenew, priceProtected: false, priceProtectedReason: null },
      payload: {
        from: oldPlan?.code ?? m.planId,
        to: newPlan.code,
        agreedPriceCents: pactado.toString(),
        proration: basis,
        // Lo que se cobrará o acreditará cuando exista el libro (Sprint 4).
        pendingAdjustment: 'SPRINT_4',
      },
    });
    return { membership: updated, proration: basis };
  }

  /**
   * El periodo que sigue al actual, sin moverlo: billing emite su cuota ANTES
   * de renovar, en la misma transacción (A3-N1). Es el mismo cálculo que
   * `renew`, así que la cuota y el periodo coinciden.
   */
  async periodoSiguiente(ctx: RequestContext, membershipId: string): Promise<{ membership: MembershipRecord; period: Period }> {
    const m = await this.require(ctx, membershipId);
    const plan = await new PlanRepository(ctx.tenant.organizationId).findById(m.planId);
    if (!plan) throw notFound('Plan no encontrado');
    return { membership: m, period: nextPeriod({ start: m.currentPeriodStart, end: m.currentPeriodEnd }, durationOf(plan), m.billingAnchorDay) };
  }

  /**
   * Avanza al periodo siguiente. Si se pasa `expectedPeriodStart` y la
   * membresía ya no arranca ahí, falla con 409: así un reintento no renueva
   * dos veces. Aun sin él, la transición se condiciona al periodo que se
   * leyó, lo que resuelve dos renovaciones simultáneas.
   */
  async renew(ctx: RequestContext, membershipId: string, expectedPeriodStart?: Date): Promise<MembershipRecord> {
    const orgId = ctx.tenant.organizationId;
    const m = await this.require(ctx, membershipId);
    if (expectedPeriodStart && m.currentPeriodStart.getTime() !== expectedPeriodStart.getTime()) {
      throw conflict('La membresía ya se renovó: su periodo cambió desde que se abrió la pantalla', 'MEMBERSHIP_ALREADY_RENEWED');
    }
    const plan = await new PlanRepository(orgId).findById(m.planId);
    if (!plan) throw notFound('Plan no encontrado');

    const period = nextPeriod(
      { start: m.currentPeriodStart, end: m.currentPeriodEnd },
      durationOf(plan),
      m.billingAnchorDay,
    );
    return this.apply(ctx, m, 'RENEW', {
      data: { currentPeriodStart: period.start, currentPeriodEnd: period.end, graceUntil: null },
      payload: { period: { start: iso(period.start), end: iso(period.end) } },
      expectedPeriodStart: m.currentPeriodStart,
    });
  }

  /**
   * Periodos que una suspendida dejó de recorrer hasta hoy. Mientras está
   * suspendida el job no la renueva, así que su periodo se queda atrás.
   */
  async missedPeriodsOf(ctx: RequestContext, m: MembershipRecord): Promise<{ periods: Period[]; today: Date; plan: PlanRecord }> {
    const orgId = ctx.tenant.organizationId;
    const plan = await new PlanRepository(orgId).findById(m.planId);
    if (!plan) throw notFound('Plan no encontrado');
    const today = await this.businessDate(orgId, m.soldAtBranchId);
    let periods: Period[];
    try {
      periods = missedPeriods({ start: m.currentPeriodStart, end: m.currentPeriodEnd }, durationOf(plan), m.billingAnchorDay, today);
    } catch {
      // Tres años sin pagar no se "reanudan": se cancela y se vende de nuevo (DM-07).
      throw conflict('Lleva demasiados periodos sin pagar para reanudar el adeudo: cancela la membresía y vende una nueva');
    }
    return { periods, today, plan };
  }

  /**
   * Cuántos periodos lleva sin recorrer una suspendida (0 si su periodo sigue
   * en curso o si no está suspendida). Con más del tope responde el tope + 1:
   * la ficha solo necesita saber si hay atrasos para ofrecer «Decidir adeudo»
   * (4-08), y la decisión misma responde 409 con lo que hay que hacer.
   */
  async cuantosPeriodosAtrasados(ctx: RequestContext, m: MembershipRecord): Promise<number> {
    if (m.status !== 'SUSPENDED') return 0;
    try {
      return (await this.missedPeriodsOf(ctx, m)).periods.length;
    } catch {
      return MAX_MISSED_PERIODS + 1;
    }
  }

  /**
   * REANUDAR el adeudo: la membresía salta al periodo que contiene hoy, con
   * su ancla de siempre, y devuelve los periodos que recorrió para que
   * billing emita una cuota por cada uno. Sigue suspendida hasta que pague.
   */
  async resumeDebt(ctx: RequestContext, membershipId: string, reason: string): Promise<{ membership: MembershipRecord; periods: Period[] }> {
    const m = await this.require(ctx, membershipId);
    const { periods } = await this.missedPeriodsOf(ctx, m);
    const last = periods.at(-1);
    if (!last) throw conflict('Su periodo sigue en curso: basta con cobrarle el adeudo');
    const membership = await this.apply(ctx, m, 'DEBT_RESUMED', {
      reason,
      data: { currentPeriodStart: last.start, currentPeriodEnd: last.end },
      payload: { periods: periods.map((p) => ({ start: iso(p.start), end: iso(p.end) })) },
      expectedPeriodStart: m.currentPeriodStart,
    });
    return { membership, periods };
  }

  /**
   * OLVIDAR el adeudo: arranca un periodo nuevo HOY y el ancla pasa a ser
   * hoy, porque el socio vuelve ese día. Condonar lo que debía es de billing
   * y ocurre antes; aquí solo se mueve el calendario.
   */
  async forgiveDebt(ctx: RequestContext, membershipId: string, reason: string): Promise<MembershipRecord> {
    const m = await this.require(ctx, membershipId);
    const { today, plan } = await this.missedPeriodsOf(ctx, m);
    if (m.currentPeriodStart.getTime() >= today.getTime()) {
      // La cuota nueva ocuparía la misma clave que la que se acaba de condonar.
      throw conflict('Su periodo empezó hoy: condona el cargo desde el estado de cuenta');
    }
    const period = firstPeriod(today, durationOf(plan));
    return this.apply(ctx, m, 'DEBT_FORGIVEN', {
      reason,
      data: { currentPeriodStart: period.start, currentPeriodEnd: period.end, billingAnchorDay: today.getUTCDate() },
      payload: {
        from: { start: iso(m.currentPeriodStart), end: iso(m.currentPeriodEnd) },
        period: { start: iso(period.start), end: iso(period.end) },
      },
      expectedPeriodStart: m.currentPeriodStart,
    });
  }

  async cancel(ctx: RequestContext, membershipId: string, reason: string): Promise<MembershipRecord> {
    const m = await this.require(ctx, membershipId);
    // La membresía y lo que pase con sus cuotas (DM-03) se confirman juntos.
    return enUnidadDeDinero(ctx.tenant.organizationId, async () => {
      const r = await this.apply(ctx, m, 'CANCEL', {
        reason,
        data: { canceledAt: new Date(), cancellationReason: reason, endedAt: new Date() },
      });
      await emitMembershipClosed({ organizationId: ctx.tenant.organizationId, membershipId: m.id, memberId: m.memberId, outcome: 'CANCELED', reason });
      return r;
    });
  }

  /** Reactivación comercial: CREA una membresía nueva, enlazada a la anterior. */
  async reactivate(ctx: RequestContext, previousMembershipId: string, planId: string): Promise<MembershipRecord> {
    const orgId = ctx.tenant.organizationId;
    const previous = await this.require(ctx, previousMembershipId);
    if (previous.status !== 'CANCELED' && previous.status !== 'EXPIRED') {
      throw conflict('Solo se reactiva una membresía terminada. La antigüedad del socio no se pierde');
    }
    // La nueva y su enlace con la anterior, juntas.
    return enUnidadDeDinero(orgId, async () => {
    const created = await this.create(ctx, {
      memberId: previous.memberId,
      planId,
      soldAtBranchId: previous.soldAtBranchId,
    });
    await new MembershipRepository(orgId).transition({
      membershipId: created.id,
      fromStatus: 'PENDING',
      toStatus: 'PENDING',
      eventType: 'CREATED',
      data: { replacesMembershipId: previousMembershipId },
      payload: { replaces: previousMembershipId },
      actorUserId: ctx.tenant.actorUserId ?? null,
      businessDate: await this.businessDate(orgId, previous.soldAtBranchId),
    });
    return created;
    });
  }

  private async require(ctx: RequestContext, id: string): Promise<MembershipRecord> {
    const m = await new MembershipRepository(ctx.tenant.organizationId).findById(id);
    if (!m) throw notFound('Membresía no encontrada');
    return m;
  }

  // ── Paquetes de visitas ───────────────────────────────────────────────────

}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
