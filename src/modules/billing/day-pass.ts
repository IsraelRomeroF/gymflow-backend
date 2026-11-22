/**
 * PASE DEL DÍA (bloque 1.8; auditoría 8, 4-01; D-20).
 *
 * La visita suelta dejó de ser una membresía de un día. Antes nacía una
 * membresía que había que vencer esa noche (y que, hasta la fase 0, se
 * renovaba sola y convertía al visitante en moroso). Ahora es lo que el
 * mostrador siempre entendió: se cobra y entra hoy.
 *
 *   · Un cargo `DAY_PASS` y su cobro, en UNA unidad de dinero con su asiento.
 *   · Sin membresía, sin periodo que renovar, sin inscripción (D-20).
 *   · Vale el día de operación de la sede donde se vendió.
 *   · No queda a deber: se cobra en el acto (o lo cubre su saldo a favor). Un
 *     pase sin pagar sería una deuda de alguien que quizá no vuelve.
 *
 * Recibe el servicio como primer argumento, como `sales.ts`.
 */
import { addDays, conflict, notFound, validation } from '@gymflow/core';
import type { RequestContext } from '../../platform/context.js';
import { enUnidadDeDinero } from '../../platform/db/unit-of-work.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { PlanRepository } from '../catalog/index.js';
import { MemberRepository } from '../members/index.js';
import { MembershipRepository } from '../memberships/index.js';
import { amountsForPlan, type BillingService, type SalePayment } from './billing.service.js';
import { ChargeRepository } from './charge.repository.js';
import { DayPassRepository, conceptoDelPase, type DayPassRecord } from './day-pass.repository.js';
import { PaymentRepository, type PaymentRecord } from './payment.repository.js';

export type DayPassView = DayPassRecord & { paid: boolean; validToday: boolean };

/** La llave del cargo y la del cobro de una venta de pase. */
const llaveDelCargo = (saleKey: string) => `daypass-${saleKey}`;
const llaveDelCobro = (saleKey: string) => `daypass-pay-${saleKey}`;

/** Un pase con lo que la pantalla pregunta: ¿está pagado?, ¿vale hoy? */
export async function verPase(orgId: string, pase: DayPassRecord): Promise<DayPassView> {
  const hoy = await new BusinessCalendar(orgId).today(pase.branchId);
  const paid = pase.status === 'PAID';
  return { ...pase, paid, validToday: paid && pase.validOn.getTime() === hoy.getTime() };
}

export async function sellDayPass(svc: BillingService, ctx: RequestContext, input: {
  memberId: string;
  planId: string;
  branchId: string;
  /** Una por venta: el reintento devuelve el mismo pase sin cobrar otra vez. */
  saleKey: string;
  /** El cobro. `null` solo sirve si su saldo a favor cubre el pase completo. */
  payment: SalePayment | null;
}): Promise<{ pass: DayPassView; payment: PaymentRecord | null; creditAppliedCents: bigint; created: boolean }> {
  const orgId = ctx.tenant.organizationId;
  // La caja, antes de tomar turno (como toda venta): «no hay caja abierta» sale sin haber creado nada.
  const pago = await svc.cobroValidado(ctx, input.branchId, input.payment);

  return enUnidadDeDinero(orgId, async () => {
    const cargos = new ChargeRepository(orgId);
    const pases = new DayPassRepository(orgId);
    const pagos = new PaymentRepository(orgId);

    // El reintento de la MISMA venta se busca por su llave, ya con el turno
    // tomado: el doble clic espera al primero y recibe ese mismo pase.
    const previo = await cargos.findByIdempotencyKey(llaveDelCargo(input.saleKey));
    if (previo) {
      const pase = await pases.findById(previo.id);
      if (!pase || pase.memberId !== input.memberId) throw conflict('Esa clave de venta ya se usó en otra operación');
      const payment = await pagos.findByIdempotencyKey(llaveDelCobro(input.saleKey));
      return {
        pass: await verPase(orgId, pase), payment, created: false,
        creditAppliedCents: pase.amountCents - (payment?.amountCents ?? 0n),
      };
    }

    const member = await new MemberRepository(orgId).findById(input.memberId);
    if (!member) throw notFound('Socio no encontrado');
    if (member.status === 'ARCHIVED') throw conflict('Ese socio está dado de baja: reactívalo antes de venderle un pase');

    const planes = new PlanRepository(orgId);
    const plan = await planes.findById(input.planId);
    if (!plan) throw notFound('Plan no encontrado');
    if (plan.billingModel !== 'DAY_PASS') throw validation('Ese plan no es una visita suelta: se vende como membresía o como paquete');
    if (!plan.isActive) throw validation('El plan no está activo');
    const precio = await planes.effectivePriceCents(plan.id, input.branchId);
    if (precio === null) throw conflict('Ese plan no se vende en la sucursal elegida');

    // Quien ya tiene membresía no compra un pase (como hasta hoy): la puerta
    // mira primero su membresía y el pase no le serviría de nada.
    const viva = await new MembershipRepository(orgId).findLiveForMember(input.memberId);
    if (viva) throw conflict('Ya tiene una membresía vigente: el pase del día es para quien viene sin plan', 'MEMBERSHIP_ALREADY_ACTIVE');

    const hoy = await new BusinessCalendar(orgId).today(input.branchId);
    if (await pases.vivoDelDia(input.memberId, input.branchId, hoy)) {
      throw conflict('Ya tiene su pase de hoy en esta sucursal', 'DAY_PASS_ALREADY_SOLD');
    }

    // Sin inscripción, la traiga o no el plan (D-20): un solo cargo.
    const { subtotalCents, taxCents } = amountsForPlan(plan, precio);
    const { charge } = await cargos.create({
      memberId: input.memberId,
      branchId: input.branchId,
      chargeType: 'DAY_PASS',
      concept: conceptoDelPase(plan.name),
      subtotalCents,
      taxCents,
      periodStart: hoy,
      periodEnd: addDays(hoy, 1),
      dueDate: hoy,
      idempotencyKey: llaveDelCargo(input.saleKey),
      createdByUserId: ctx.tenant.actorUserId ?? null,
    });

    // Su saldo a favor va primero; lo que falte se cobra ahora.
    let payment: PaymentRecord | null = null;
    if (pago) {
      payment = await svc.cobrarAhora(ctx, {
        memberId: input.memberId, branchId: input.branchId, charges: [charge], key: llaveDelCobro(input.saleKey),
      }, pago);
    } else {
      await svc.applyCredit(ctx, input.memberId);
    }
    const final = await pases.findById(charge.id);
    if (!final || final.status !== 'PAID') {
      // Lanzar deshace la unidad entera: no queda cargo, ni saldo aplicado, ni asiento.
      throw validation('El pase del día se cobra al venderlo: elige cómo paga', undefined, 'DAY_PASS_MUST_BE_PAID');
    }

    await svc.audit.record(ctx, {
      action: 'daypass.sell',
      resourceType: 'Charge',
      resourceId: charge.id,
      branchId: input.branchId,
      afterState: {
        memberId: input.memberId,
        plan: plan.code,
        validOn: hoy.toISOString().slice(0, 10),
        amountCents: charge.amountCents.toString(),
        method: payment ? pago?.method ?? null : null,
        paidCents: (payment?.amountCents ?? 0n).toString(),
      },
    });

    return {
      pass: await verPase(orgId, final), payment, created: true,
      creditAppliedCents: charge.amountCents - (payment?.amountCents ?? 0n),
    };
  });
}

/** El pase de hoy (en cualquier sede) y los que lleva. */
export async function dayPassesOf(ctx: RequestContext, memberId: string): Promise<{ today: DayPassView | null; total: number; recent: DayPassView[] }> {
  const orgId = ctx.tenant.organizationId;
  const member = await new MemberRepository(orgId).findByIdIncludingArchived(memberId);
  if (!member) throw notFound('Socio no encontrado');
  const repo = new DayPassRepository(orgId);
  const [recientes, total] = await Promise.all([repo.recientes(memberId, 20), repo.totalPagados(memberId)]);
  const recent = await Promise.all(recientes.map((p) => verPase(orgId, p)));
  return { today: recent.find((p) => p.validToday) ?? null, total, recent };
}
