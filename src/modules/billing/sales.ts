/**
 * VENTAS (fase 4, partido de `billing.service.ts`): cotizar, vender membresías
 * y paquetes. Reciben el servicio como primer argumento: la fachada
 * `BillingService` sigue siendo la única puerta para el resto del sistema.
 */
import { addDays, conflict, notFound, validation, type PaymentMethodType } from '@gymflow/core';
import { ChargeRepository, type ChargeRecord } from './charge.repository.js';
import { MemberRepository } from '../members/index.js';
import { MembershipRepository, VisitPackRepository, type VisitPackRecord, type MembershipRecord } from '../memberships/index.js';
import { PaymentRepository, type PaymentRecord } from './payment.repository.js';
import { PlanRepository } from '../catalog/index.js';
import type { RequestContext } from '../../platform/context.js';
import { enUnidadDeDinero } from '../../platform/db/unit-of-work.js';
import { BillingService, amountsForPlan, type SalePayment } from './billing.service.js';
import { conceptoDelPase } from './day-pass.repository.js';

/**
 * Cotización de una venta: lo que el socio pagaría HOY por ese plan en esa
 * sucursal. Usa el mismo cálculo que los cargos reales, así el total que ve
 * recepción es exactamente el que se cobra.
 */
export async function quote(svc: BillingService, ctx: RequestContext, planId: string, branchId: string | null): Promise<{
  lines: Array<{ concept: string; subtotalCents: bigint; taxCents: bigint; totalCents: bigint }>;
  totalCents: bigint;
  available: boolean;
}> {
  const repo = new PlanRepository(ctx.tenant.organizationId);
  const plan = await repo.findById(planId);
  if (!plan) throw notFound('Plan no encontrado');
  const precio = await repo.effectivePriceCents(plan.id, branchId);
  if (precio === null) return { lines: [], totalCents: 0n, available: false };

  const linea = (concept: string, cents: bigint) => {
    const { subtotalCents, taxCents } = amountsForPlan(plan, cents);
    return { concept, subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
  };
  // La visita suelta es un pase del día (1.8): un solo renglón y NUNCA inscripción (D-20), la traiga o no el plan.
  const sinInscripcion = plan.billingModel === 'VISIT_PACK' || plan.billingModel === 'DAY_PASS';
  const lines = [
    ...(plan.signupFeeCents > 0n && !sinInscripcion ? [linea('Inscripción', plan.signupFeeCents)] : []),
    linea(plan.billingModel === 'VISIT_PACK' ? `Paquete de ${plan.visitsIncluded} visitas`
      : plan.billingModel === 'DAY_PASS' ? conceptoDelPase(plan.name) : `Primer periodo · ${plan.name}`, precio),
  ];
  return { lines, totalCents: lines.reduce((a, l) => a + l.totalCents, 0n), available: true };
}

/**
 * VENDER una membresía, en el orden que exige el modelo:
 *
 *   1. La membresía nace PENDIENTE (no da acceso).
 *   2. Se generan la inscripción —si el plan la tiene— y el primer periodo.
 *   3. Si recepción cobra en ese momento, el pago liquida los cargos y la
 *      liquidación ACTIVA la membresía (`settleByPayment`).
 *
 * Sin cobro, queda pendiente con sus cargos abiertos: se puede cobrar
 * después desde el estado de cuenta, y se activa en ese momento. Nunca se
 * activa "a mano" antes de pagar: eso es regalar acceso sin que quede
 * registro de por qué.
 *
 * Cada paso es idempotente (claves de cargo y de pago), así que un fallo a
 * medias se completa repitiendo la venta de los cargos, no duplicándolos.
 */
export async function sellMembership(svc: BillingService, ctx: RequestContext, input: {
  memberId: string;
  planId: string;
  branchId: string | null;
  startDate?: Date;
  /** La venta empieza más de 7 días atrás (usó `payments:backdate`): va a «Para revisar» (20-03). */
  backdated?: boolean;
  autoRenew?: boolean;
  /** Clave de la venta (DM-08): el mismo mostrador reintentando recibe la misma venta. */
  saleKey?: string | null;
  /** Precio pactado distinto al de lista (DM-05); la ruta ya exigió permiso y motivo. */
  agreedPriceCents?: bigint | null;
  payment: null | {
    method: PaymentMethodType;
    cashSessionId?: string | null;
    externalRef?: string | null;
  };
}): Promise<{
  membership: MembershipRecord; charges: ChargeRecord[]; payment: PaymentRecord | null; totalCents: bigint; created: boolean;
  /** Lo que cubrió el saldo a favor que ya tenía (4-18): eso NO se le cobra. */
  creditAppliedCents: bigint;
}> {
  const orgId = ctx.tenant.organizationId;
  // La visita suelta ya no es una membresía (1.8, 4-01): se vende como pase del
  // día en `POST /members/:id/day-passes`. Se dice antes de tocar la caja.
  const planPedido = await new PlanRepository(orgId).findById(input.planId);
  if (planPedido?.billingModel === 'DAY_PASS') {
    throw validation('La visita suelta se vende como pase del día, no como membresía', undefined, 'SOLD_AS_DAY_PASS');
  }
  // La caja, antes de tomar turno: "hay dos cajas abiertas" debe salir antes
  // de crear la membresía, no después (BE2-05). El turno resuelto viaja al cobro.
  if (input.payment) {
    const pago = await svc.cobroValidado(ctx, input.branchId, { ...input.payment, cashSessionId: input.payment.cashSessionId ?? null, externalRef: input.payment.externalRef ?? null });
    input = { ...input, payment: pago };
  }

  // Membresía, cargos, cobro y bitácora en UNA unidad de dinero (DM-08): antes
  // eran tres commits y un corte de red dejaba la membresía sin cuota ni cobro.
  // La llave de la venta se mira YA con el turno tomado: el doble clic espera
  // a que termine el primero y recibe esa misma venta.
  return enUnidadDeDinero(orgId, async () => {
  if (input.saleKey) {
    const hecha = await new MembershipRepository(orgId).findBySaleKey(input.saleKey);
    if (hecha) {
      // Ya se vendió: se devuelve tal cual, sin cobrar ni crear nada otra vez.
      const charges = (await new ChargeRepository(orgId).listForMember(hecha.memberId)).filter((c) => c.membershipId === hecha.id);
      const payment = await new PaymentRepository(orgId).findByIdempotencyKey(`sale-${hecha.id}`);
      return { membership: hecha, charges, payment, totalCents: charges.reduce((a, c) => a + c.amountCents, 0n), created: false, creditAppliedCents: 0n };
    }
  }
  // Antes de crear NADA: si el plan no se vende en esa sucursal, la
  // membresía nacería y el cargo fallaría después, dejándola huérfana.
  const precioVigente = await new PlanRepository(ctx.tenant.organizationId).effectivePriceCents(input.planId, input.branchId);
  if (precioVigente === null) {
    throw conflict('Ese plan no se vende en la sucursal elegida', 'PLAN_NOT_SOLD_AT_BRANCH');
  }
  const membership = await svc.memberships.create(ctx, {
    memberId: input.memberId,
    planId: input.planId,
    soldAtBranchId: input.branchId,
    ...(input.startDate ? { startDate: input.startDate } : {}),
    ...(input.autoRenew !== undefined ? { autoRenew: input.autoRenew } : {}),
    saleKey: input.saleKey ?? null,
    // El precio queda escrito en la membresía (DM-05): el de lista puede cambiar; este no.
    agreedPriceCents: input.agreedPriceCents ?? precioVigente,
  });

  const inscripcion = await svc.createSignupCharge(ctx, membership.id);
  const periodo = await svc.createPeriodCharge(ctx, { membershipId: membership.id });
  const emitidos = [inscripcion?.charge, periodo.charge].filter((c): c is ChargeRecord => !!c);
  const total = emitidos.reduce((a, c) => a + c.amountCents, 0n);
  // Los cargos como quedaron: si tenía saldo a favor, ya los cubrió en parte
  // (DM-02), y eso no se le vuelve a cobrar (4-18). Antes se cobraba el total
  // y el crédito se quedaba otra vez a favor.
  const cargos = new ChargeRepository(orgId);
  const charges = (await Promise.all(emitidos.map((c) => cargos.findById(c.id)))).map((c, i) => c ?? emitidos[i]!);
  const porCobrar = charges.reduce((a, c) => a + (c.amountCents - c.allocatedCents - c.adjustedCents), 0n);

  // Si su saldo a favor cubrió toda la venta, ya está pagada: se activa sin cobrar nada.
  if (porCobrar <= 0n) await svc.activateSettledMemberships(ctx, charges.map((c) => c.id));

  let payment: PaymentRecord | null = null;
  if (input.payment && porCobrar > 0n) {
    const r = await svc.recordPayment(ctx, {
      memberId: input.memberId,
      method: input.payment.method,
      amountCents: porCobrar,
      branchId: input.branchId,
      cashSessionId: input.payment.cashSessionId ?? null,
      externalRef: input.payment.externalRef ?? null,
      targetChargeIds: charges.map((c) => c.id),
      // La misma venta cobrada dos veces (doble clic, reintento) es UN pago.
      idempotencyKey: `sale-${membership.id}`,
    });
    payment = r.payment;
  }

  const final = await new MembershipRepository(ctx.tenant.organizationId).findById(membership.id);
  await svc.audit.record(ctx, {
    action: 'membership.sale',
    resourceType: 'Membership',
    resourceId: membership.id,
    branchId: input.branchId,
    afterState: {
      planId: input.planId,
      totalCents: total.toString(),
      paid: payment !== null,
      method: input.payment?.method ?? null,
      status: final?.status ?? membership.status,
      ...(input.backdated ? { backdated: true } : {}),
    },
  });
  return { membership: final ?? membership, charges, payment, totalCents: total, created: true, creditAppliedCents: total - porCobrar };
  });
}

/**
 * Vende un paquete de visitas CON su cargo.
 *
 * Vive en billing y no en memberships porque vender es una operación de
 * dinero, y porque la dirección contraria sería un ciclo: billing ya depende
 * de memberships para liquidar cuotas, y dos módulos que se importan
 * mutuamente no se pueden extraer ninguno de los dos.
 *
 * El enlace `VisitPack.chargeId` es lo que permite valorar la visita por lo
 * que el socio PAGÓ y no por el precio de lista, que es distinto si hubo
 * descuento o precio por sucursal (ADR-024).
 */
export async function sellVisitPack(svc: BillingService, ctx: RequestContext, input: {
  memberId: string; planId: string; soldAtBranchId: string | null;
  /** Cobrar en el acto. Sin cobro el paquete queda pendiente y NO da acceso. */
  payment?: SalePayment | null;
  /**
   * Una por venta (UXA-18): antes paquete y cobro eran dos llamadas y, si
   * el cobro fallaba, reintentar creaba un segundo paquete.
   */
  saleKey?: string | null;
}): Promise<{ pack: VisitPackRecord; charge: ChargeRecord; payment: PaymentRecord | null }> {
  const orgId = ctx.tenant.organizationId;
  const pago = await svc.cobroValidado(ctx, input.soldAtBranchId, input.payment ?? null);

  const member = await new MemberRepository(orgId).findById(input.memberId);
  if (!member) throw notFound('Socio no encontrado');

  const plans = new PlanRepository(orgId);
  const plan = await plans.findById(input.planId);
  if (!plan) throw notFound('Plan no encontrado');
  if (plan.billingModel !== 'VISIT_PACK') throw validation('El plan no es un paquete de visitas');
  if (!plan.visitsIncluded || plan.visitsIncluded <= 0) {
    throw validation('El plan no declara visitas incluidas');
  }

  const precio = await plans.effectivePriceCents(plan.id, input.soldAtBranchId);
  if (precio === null) {
    throw conflict(`El plan ${plan.code} no está disponible en esa sucursal`, 'PLAN_NOT_SOLD_AT_BRANCH');
  }
  const { subtotalCents, taxCents } = amountsForPlan(plan, precio);

  const hoy = await svc.businessDate(orgId, input.soldAtBranchId);
  const visitas = plan.visitsIncluded;

  // Cargo, paquete, bitácora y cobro en UNA unidad de dinero (28-09, 28-10):
  // antes eran cuatro pasos sueltos y, si el cobro fallaba, quedaba un paquete
  // sin cobrar que el reintento tenía que encontrar.
  return enUnidadDeDinero(orgId, async () => {
  // El reintento de la misma venta se BUSCA por su llave (insertar y chocar abortaría la unidad).
  const clave = input.saleKey ? `vpsale-${input.saleKey}` : null;
  const previo = clave ? await new ChargeRepository(orgId).findByIdempotencyKey(clave) : null;
  const { charge, created } = previo ? { charge: previo, created: false } : await new ChargeRepository(orgId).create({
    memberId: input.memberId,
    branchId: input.soldAtBranchId,
    chargeType: 'VISIT_PACK',
    concept: `${plan.name} · ${visitas} visitas`,
    subtotalCents,
    taxCents,
    dueDate: hoy,
    createdByUserId: ctx.tenant.actorUserId ?? null,
    ...(clave ? { idempotencyKey: clave } : {}),
  });

  // El reintento de la misma venta: el paquete ya existe, solo falta cobrar.
  const existente = created ? null : await new VisitPackRepository(orgId).findByChargeId(charge.id);
  if (existente) {
    const payment = await svc.cobrarAhora(ctx, {
      memberId: input.memberId, branchId: input.soldAtBranchId, charges: [charge], key: `vpsale-pay-${input.saleKey}`,
    }, pago);
    return { pack: (await new VisitPackRepository(orgId).findById(existente.id))!, charge, payment };
  }

  const pack = await new VisitPackRepository(orgId).sell({
    memberId: input.memberId,
    planId: input.planId,
    soldAtBranchId: input.soldAtBranchId,
    visits: visitas,
    purchasedOn: hoy,
    expiresOn: plan.visitValidityDays ? addDays(hoy, plan.visitValidityDays) : null,
    createdByUserId: ctx.tenant.actorUserId!,
    businessDate: hoy,
    chargeId: charge.id,
  });

  await svc.audit.record(ctx, {
    action: 'visitpack.sell',
    resourceType: 'VisitPack',
    resourceId: pack.id,
    branchId: input.soldAtBranchId,
    afterState: {
      plan: plan.code,
      visits: visitas,
      chargeId: charge.id,
      amountCents: charge.amountCents.toString(),
    },
  });

  const payment = await svc.cobrarAhora(ctx, {
    memberId: input.memberId, branchId: input.soldAtBranchId, charges: [charge],
    key: input.saleKey ? `vpsale-pay-${input.saleKey}` : `vpsale-pay-${pack.id}`,
  }, pago);
  const final = payment ? await new VisitPackRepository(orgId).findById(pack.id) : null;
  return { pack: final ?? pack, charge: (await new ChargeRepository(orgId).findById(charge.id)) ?? charge, payment };
  });
}
