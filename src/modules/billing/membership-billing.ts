/**
 * MEMBRESÍAS Y DINERO (fase 4, partido de `billing.service.ts`): renovar,
 * cambiar de plan, avanzar periodo y decidir adeudos de una suspendida.
 */
import { conflict, notFound, validation, cycleChargeKey, prorationBasis, prorate, firstPeriod, formatMoney, money } from '@gymflow/core';
import { ChargeRepository } from './charge.repository.js';
import { MembershipRepository, type MembershipRecord } from '../memberships/index.js';
import { PlanRepository } from '../catalog/index.js';
import type { RequestContext } from '../../platform/context.js';
import { enUnidadDeDinero } from '../../platform/db/unit-of-work.js';
import { precioDeCuotaDe } from './precio-de-cuota.js';
import { BillingService, amountsForPlan, saldo, type SalePayment } from './billing.service.js';

/**
 * La cuota del periodo que se va a abrir: la que ya existe con su clave o una
 * nueva. Se busca antes de insertar porque, dentro de una transacción, chocar
 * con la clave la abortaría entera.
 */
async function cuotaDelPeriodo(svc: BillingService, ctx: RequestContext, membershipId: string, period: { start: Date; end: Date }) {
  const previa = await new ChargeRepository(ctx.tenant.organizationId).findByIdempotencyKey(cycleChargeKey(membershipId, period.start));
  if (previa) {
    if (previa.status === 'VOID' || previa.status === 'WRITTEN_OFF') {
      throw conflict('La cuota de ese periodo ya existe y está anulada: revisa su estado de cuenta antes de renovar');
    }
    return previa;
  }
  return (await svc.createPeriodCharge(ctx, { membershipId, period })).charge;
}

/**
 * Con una cuota de la membresía sin pagar no se renueva ni se cambia de plan
 * (4-06): primero se cobra. El día de corte todas amanecen activas con la
 * cuota de hoy abierta, y «Renovar y cobrar» cobraba el periodo siguiente y
 * dejaba el actual debiendo; mañana el socio estaba en mora con dos cuotas.
 */
async function exigirAlCorriente(svc: BillingService, orgId: string, m: MembershipRecord, que: string): Promise<void> {
  const debe = (await svc.openMembershipCharges(orgId, m.memberId, m.id)).reduce((a, c) => a + saldo(c), 0n);
  if (debe > 0n) {
    throw conflict(`Primero cobra los ${formatMoney(money(debe))} que debe de su membresía: ${que} dejaría esa cuota abierta junto a la nueva`, 'DEBT_PENDING');
  }
}

/**
 * Lo que cuesta cada decisión sobre una SUSPENDIDA, para que recepción la
 * vea antes de elegir: lo que ya debe, los periodos que no pagó y el
 * periodo nuevo si se le olvida el adeudo.
 */
export async function suspendedDebtOptions(svc: BillingService, ctx: RequestContext, membershipId: string) {
  const orgId = ctx.tenant.organizationId;
  const m = await new MembershipRepository(orgId).findById(membershipId);
  if (!m) throw notFound('Membresía no encontrada');
  if (m.status !== 'SUSPENDED') throw conflict('Solo una membresía suspendida tiene adeudo por decidir');

  const { periods, today, plan } = await svc.memberships.missedPeriodsOf(ctx, m);
  // La misma regla que la cuota que se va a emitir (`precioDeCuota`): antes
  // esto cotizaba con el precio de lista y la cuota salía con el pactado.
  const precio = await precioDeCuotaDe(orgId, m, plan);
  const { subtotalCents, taxCents } = amountsForPlan(plan, precio);
  const cuota = subtotalCents + taxCents;

  const abiertos = await svc.openMembershipCharges(orgId, m.memberId, m.id);
  const adeudo = abiertos.reduce((a, c) => a + saldo(c), 0n);
  return {
    membership: m, today, planName: plan.name, periodCents: cuota,
    openCharges: abiertos, openCents: adeudo,
    missedPeriods: periods,
    resumeTotalCents: adeudo + cuota * BigInt(periods.length),
    forgiveNewPeriod: m.currentPeriodStart.getTime() < today.getTime()
      ? firstPeriod(today, { unit: plan.durationUnit as 'DAY' | 'WEEK' | 'MONTH', value: plan.durationValue })
      : null,
  };
}

/**
 * La decisión del dueño sobre una suspendida que vuelve tarde.
 *
 *   · REANUDAR: se emite una cuota por cada periodo que no pagó y debe
 *     todo para volver a entrar. Es lo que pasaba antes en silencio: el job
 *     la ponía al día a la noche siguiente de que pagara lo viejo.
 *   · OLVIDAR: lo que debía se CONDONA (con autorización, motivo de
 *     catálogo RETENCION) y arranca un periodo nuevo hoy; paga solo ese.
 *
 * En los dos casos sigue suspendida hasta que pague: el cobro, si se hace
 * ahora, la reactiva por el camino normal de liquidación.
 */
export async function resolveSuspendedDebt(svc: BillingService, ctx: RequestContext, input: {
  membershipId: string; decision: 'RESUME' | 'FORGIVE'; reason: string;
  approvedByUserId?: string | null; payment: SalePayment | null;
}) {
  const orgId = ctx.tenant.organizationId;
  const vista = await new MembershipRepository(orgId).findById(input.membershipId);
  if (!vista) throw notFound('Membresía no encontrada');
  if (vista.status !== 'SUSPENDED') throw conflict('Solo una membresía suspendida tiene adeudo por decidir');

  // El cobro se valida ANTES de tocar nada (BE2-05): con dos cajas abiertas
  // y sin decir cuál, responde 422 sin haber tomado turno ni movido nada.
  const pago = await svc.cobroValidado(ctx, vista.soldAtBranchId, input.payment);

  // UNA unidad de dinero (fase 1.3; 28-09, 28-10): las cuotas atrasadas (o la
  // condonación), el salto de periodo, el cobro, la reactivación y sus
  // asientos se confirman juntos o no ocurre nada. Antes eran hasta nueve
  // transacciones sueltas que se completaban «reintentando»; con dos cajas y
  // varias decisiones a la vez se esperaban unas a otras y la base cortaba a
  // una a la mitad (500), con el periodo ya movido y sin cobrar.
  return enUnidadDeDinero(orgId, async () => {
  // Se vuelve a leer CON el turno tomado: el doble envío ya la encuentra decidida.
  const antes = await new MembershipRepository(orgId).findById(input.membershipId);
  if (!antes) throw notFound('Membresía no encontrada');
  if (antes.status !== 'SUSPENDED') throw conflict('Solo una membresía suspendida tiene adeudo por decidir');

  let condonadoCents = 0n;
  if (input.decision === 'RESUME') {
    // Primero las cuotas (una por membresía y periodo), después la transición:
    // la bitácora queda al final de la unidad. Si ya se reanudó sin cobrar y
    // solo falta el cobro, no hay nada que mover.
    const { periods } = await svc.memberships.missedPeriodsOf(ctx, antes);
    for (const p of periods) await svc.createPeriodCharge(ctx, { membershipId: antes.id, period: p });
    if (periods.length > 0) await svc.memberships.resumeDebt(ctx, antes.id, input.reason);
    else if ((await svc.openMembershipCharges(orgId, antes.memberId, antes.id)).length === 0) {
      throw conflict('No hay adeudo por reanudar');
    }
  } else {
    // Si ya se olvidó sin cobrar (el periodo arranca hoy), solo falta el cobro:
    // no se condona dos veces.
    const hoy = await svc.businessDate(orgId, antes.soldAtBranchId);
    const yaOlvidado = antes.currentPeriodStart.getTime() === hoy.getTime();
    if (!yaOlvidado) {
      // Sin meses atrasados no hay adeudo que olvidar (4-08): condonar la
      // cuota en curso y cobrar otra igual solo movía el día de corte.
      if ((await svc.memberships.missedPeriodsOf(ctx, antes)).periods.length === 0) {
        throw conflict('Su periodo sigue en curso: no hay meses atrasados que olvidar. Cóbrale lo que debe');
      }
      for (const c of await svc.openMembershipCharges(orgId, antes.memberId, antes.id)) {
        condonadoCents += saldo(c);
        await svc.adjustCharge(ctx, {
          chargeId: c.id, adjustmentType: 'WAIVER', amountCents: saldo(c),
          reason: `Adeudo olvidado al volver: ${input.reason}`, reasonCode: 'RETENCION',
          approvedByUserId: input.approvedByUserId ?? null,
        });
      }
      await svc.memberships.forgiveDebt(ctx, antes.id, input.reason);
    }
    // Idempotente: si el periodo nuevo ya tenía su cuota, la devuelve.
    await svc.createPeriodCharge(ctx, { membershipId: antes.id });
  }

  const charges = await svc.openMembershipCharges(orgId, antes.memberId, antes.id);
  const payment = await svc.cobrarAhora(ctx, {
    memberId: antes.memberId, branchId: antes.soldAtBranchId, charges,
    // La clave sale de lo que se cobra, no del periodo (que ya se movió).
    key: `debt-${antes.id}-${charges.map((c) => c.id).sort().join('.').slice(-60)}`,
  }, pago);
  // Si su saldo a favor cubrió todo lo decidido, ya no debe nada: se reactiva
  // como con un cobro (4-18). Las cuotas lo usaron sin activarla a media decisión.
  if ((await svc.openMembershipCharges(orgId, antes.memberId, antes.id)).length === 0) {
    await svc.memberships.settleByPayment(ctx, antes.id);
  }
  await svc.refreshCachedBalance(orgId, antes.memberId);

  const membership = await new MembershipRepository(orgId).findById(antes.id);
  return { membership: membership!, charges, payment, forgivenCents: condonadoCents };
  });
}

/**
 * AUTORRENOVACIÓN: el periodo terminó y la membresía pasa al siguiente con
 * su cuota emitida. Es lo que hace el job diario; sin esto, una membresía
 * mensual caía en mora al acabar el mes sin que existiera nada que pagar.
 *
 * No cobra: la cuota queda abierta y, si nadie la paga, el job de mora la
 * encuentra vencida al día siguiente. Condicionada al periodo leído, así que
 * dos corridas simultáneas no avanzan dos periodos.
 */
export async function advancePeriod(svc: BillingService, ctx: RequestContext, membershipId: string, expectedPeriodStart: Date) {
  // Periodo nuevo y su cuota en UNA transacción (A3-N1). Antes se renovaba y
  // después se emitía la cuota: si la cuota fallaba (el plan ya no tiene
  // precio en la sede), el socio quedaba con periodo nuevo, sin cuota y sin
  // mora, y entraba gratis. Ahora, si la cuota no se emite, no avanza.
  // La cuota va primero y la transición al final: la bitácora, que toma su
  // candado, queda al cierre de la unidad.
  return enUnidadDeDinero(ctx.tenant.organizationId, async () => {
    const { membership: m, period } = await svc.memberships.periodoSiguiente(ctx, membershipId);
    if (m.currentPeriodStart.getTime() !== expectedPeriodStart.getTime()) {
      throw conflict('La membresía cambió mientras se procesaba (¿ya se renovó?). Recarga y revisa');
    }
    const charge = await cuotaDelPeriodo(svc, ctx, membershipId, period);
    const renovada = await svc.memberships.renew(ctx, membershipId, expectedPeriodStart);
    return { membership: renovada, charge };
  });
}

/**
 * Renovar por adelantado: el periodo siguiente arranca donde termina el
 * actual, y SE COBRA. `MembershipService.renew` solo mueve fechas; usado a
 * solas regalaba un periodo entero.
 */
export async function renewMembership(svc: BillingService, ctx: RequestContext, input: {
  membershipId: string; payment: SalePayment | null;
  /**
   * El inicio de periodo que vio la pantalla. OBLIGATORIO (fase 1.3): es la
   * llave de la renovación; sin él, un reintento tras un corte de red renovaba
   * y cobraba un segundo periodo.
   */
  expectedPeriodStart: Date;
}) {
  const orgId = ctx.tenant.organizationId;
  const vista = await new MembershipRepository(orgId).findById(input.membershipId);
  if (!vista) throw notFound('Membresía no encontrada');
  const pago = await svc.cobroValidado(ctx, vista.soldAtBranchId, input.payment);

  // Periodo, cuota y cobro en una sola unidad de dinero (A3-N1): o se renueva
  // con su cuota, o no pasa nada. Las comprobaciones van DENTRO, con el turno
  // tomado: la segunda de dos renovaciones a la vez ya ve el periodo movido.
  return enUnidadDeDinero(orgId, async () => {
    const antes = await new MembershipRepository(orgId).findById(input.membershipId);
    if (!antes) throw notFound('Membresía no encontrada');
    if (antes.status !== 'ACTIVE') throw conflict('Solo se renueva una membresía vigente. Si está en mora, primero se cobra el adeudo', 'MEMBERSHIP_NOT_ACTIVE');
    if (antes.currentPeriodStart.getTime() !== input.expectedPeriodStart.getTime()) {
      throw conflict('La membresía ya se renovó: su periodo cambió desde que se abrió la pantalla', 'MEMBERSHIP_ALREADY_RENEWED');
    }
    await exigirAlCorriente(svc, orgId, antes, 'renovar');
    const { period } = await svc.memberships.periodoSiguiente(ctx, antes.id);
    const charge = await cuotaDelPeriodo(svc, ctx, antes.id, period);
    const renovada = await svc.memberships.renew(ctx, antes.id, antes.currentPeriodStart);
    const payment = await svc.cobrarAhora(ctx, {
      memberId: renovada.memberId, branchId: renovada.soldAtBranchId, charges: [charge],
      key: `renew-${renovada.id}-${renovada.currentPeriodStart.toISOString().slice(0, 10)}`,
    }, pago);
    return { membership: renovada, charge: (await new ChargeRepository(orgId).findById(charge.id)) ?? charge, payment };
  });
}

/**
 * Cambio de plan, COBRADO.
 *
 * El periodo nuevo arranca hoy con el plan nuevo (así lo hace el dominio) y
 * se cobra completo. Lo que el socio YA PAGÓ del plan anterior y no va a
 * usar se le acredita como corrección sobre ese cargo: pagó 30 días, usó 10
 * y se cambia → se le reconocen 20/30 de lo pagado. Si el crédito pasa del
 * cargo nuevo (bajar de una anualidad a una mensualidad), lo que sobra queda
 * A FAVOR del socio (4-05): antes se perdía y solo quedaba en la bitácora.
 *
 * Antes el cambio solo calculaba el prorrateo y no cobraba nada: subir a un
 * plan más caro salía gratis.
 */
export async function changeMembershipPlan(svc: BillingService, ctx: RequestContext, input: {
  membershipId: string; planId: string; reason: string; payment: SalePayment | null;
}) {
  const orgId = ctx.tenant.organizationId;
  const charges = new ChargeRepository(orgId);
  const vista = await new MembershipRepository(orgId).findById(input.membershipId);
  if (!vista) throw notFound('Membresía no encontrada');
  // Caja resuelta antes de cambiar el plan (BE2-11): un error de cobro ya no
  // deja la membresía en el plan nuevo sin su cuota.
  const pago = await svc.cobroValidado(ctx, vista.soldAtBranchId, input.payment);

  // Plan, cuota, crédito, saldo a favor, cobro y bitácora: todo o nada, en una
  // unidad de dinero. Todo se lee con el turno tomado: el doble envío ya ve
  // el plan cambiado («ya está en ese plan») y no cobra dos veces.
  return enUnidadDeDinero(orgId, async () => {
  const antes = await new MembershipRepository(orgId).findById(input.membershipId);
  if (!antes) throw notFound('Membresía no encontrada');

  const hoy = await svc.businessDate(orgId, antes.soldAtBranchId);
  const base = prorationBasis({ start: antes.currentPeriodStart, end: antes.currentPeriodEnd }, hoy);
  if (antes.currentPeriodStart.getTime() > hoy.getTime()) {
    // Renovó por adelantado: el periodo "actual" todavía no empieza y el que
    // está usando ya está pagado. Prorratear aquí mezclaría dos periodos.
    throw conflict(`Ya está renovada por adelantado desde el ${antes.currentPeriodStart.toISOString().slice(0, 10)}. ` +
      'Cambia el plan cuando empiece ese periodo', 'MEMBERSHIP_ALREADY_RENEWED');
  }
  if (base.usedDays === 0) {
    // El periodo nuevo empezaría el mismo día que el actual y ocuparía su
    // misma clave de cargo. Es el caso "se vendió el plan equivocado hoy".
    throw conflict('El periodo empezó hoy: cancela esta membresía con motivo y véndele el plan correcto');
  }
  const destino = await new PlanRepository(orgId).findById(input.planId);
  // Destinos válidos: recurrente y pago anticipado (4-05). A una visita suelta
  // la membresía se volvía de un día; a un paquete no hay periodo que cobrar.
  if (destino && (destino.billingModel === 'DAY_PASS' || destino.billingModel === 'VISIT_PACK')) {
    throw validation(destino.billingModel === 'DAY_PASS'
      ? 'No se puede cambiar a una visita suelta: la visita se vende aparte'
      : 'No se puede cambiar a un paquete de visitas: el paquete se vende aparte');
  }
  if (await new PlanRepository(orgId).effectivePriceCents(input.planId, antes.soldAtBranchId) === null) {
    throw conflict('Ese plan no se vende en la sucursal de la membresía', 'PLAN_NOT_SOLD_AT_BRANCH');
  }
  await exigirAlCorriente(svc, orgId, antes, 'cambiar de plan');

  const cargoAnterior = await charges.findByIdempotencyKey(cycleChargeKey(antes.id, antes.currentPeriodStart));
  // Sobre lo PAGADO de verdad (sin descuentos ni condonaciones), con el
  // prorrateo único del núcleo: redondeo al centavo, no truncado.
  const pagado = cargoAnterior ? cargoAnterior.allocatedCents : 0n;
  const credito = base.cycleDays > 0 && pagado > 0n ? prorate(money(pagado), base.remainingDays, base.cycleDays).cents : 0n;

  {
    const { membership, proration } = await svc.memberships.changePlan(ctx, input.membershipId, input.planId, input.reason);
    const emitido = await svc.createPeriodCharge(ctx, { membershipId: membership.id });
    // El cargo como quedó: si tenía saldo a favor de antes, ya se le aplicó.
    let charge = (await charges.findById(emitido.charge.id)) ?? emitido.charge;

    const pendiente = saldo(charge) > 0n ? saldo(charge) : 0n;
    const aplicado = credito > pendiente ? pendiente : credito;
    if (aplicado > 0n) {
      charge = await svc.adjustCharge(ctx, {
        chargeId: charge.id,
        adjustmentType: 'CORRECTION',
        amountCents: aplicado,
        reason: `Crédito por ${base.remainingDays} de ${base.cycleDays} días no usados del plan anterior`,
      });
    }
    // Lo que sobra del crédito es dinero del socio: queda a su favor (4-05).
    const aFavor = credito - aplicado;
    if (aFavor > 0n) {
      await svc.abonarSaldoAFavor(ctx, {
        memberId: membership.memberId, branchId: membership.soldAtBranchId, amountCents: aFavor,
        key: `plan-change-favor-${membership.id}-${hoy.toISOString().slice(0, 10)}`,
      });
    }

    const payment = await svc.cobrarAhora(ctx, {
      memberId: membership.memberId, branchId: membership.soldAtBranchId, charges: [charge],
      key: `plan-change-${membership.id}-${hoy.toISOString().slice(0, 10)}`,
    }, pago);

    await svc.audit.record(ctx, {
      action: 'membership.plan_change.billed',
      resourceType: 'Membership',
      resourceId: membership.id,
      branchId: membership.soldAtBranchId,
      reason: input.reason,
      afterState: {
        chargeId: charge.id, creditCents: aplicado.toString(),
        creditToBalanceCents: aFavor.toString(), paid: payment !== null,
      },
    });
    return {
      membership, proration, creditCents: aplicado, creditToBalanceCents: aFavor,
      charge: (await charges.findById(charge.id)) ?? charge, payment,
    };
  }
  });
}
