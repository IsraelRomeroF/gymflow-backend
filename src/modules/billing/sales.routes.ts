import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { route } from '../../platform/http/registry.js';
import { PlanRepository } from '../catalog/index.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { BillingService } from './billing.service.js';
import { idParam, iso, serializeCharge, serializePayment, sedeDeMembresia, pagoBody, aPago, serializarMembresia, dia } from './billing.serializers.js';
import { conflict, validation, money, discountPercentOf } from '@gymflow/core';
import { MembershipRepository } from '../memberships/index.js';
import { perdonDisponible } from './perdon.js';

/** Ventas: cotizar, vender membresías y paquetes, renovar, cambiar de plan, decidir adeudos. */
export function registerSalesRoutes(app: FastifyInstance): void {
  const service = new BillingService();
  /**
   * Venta de un paquete de visitas.
   *
   * Vive aquí y no en membresías porque crea el CARGO que la financia. El
   * paquete en sí lo sigue gobernando el módulo de membresías.
   */
  route(app, {
    method: 'POST',
    url: '/members/:id/visit-packs',
    security: { kind: 'permission', permission: 'memberships:visitpack:manage' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        planId: z.string().uuid(),
        soldAtBranchId: z.string().uuid().optional(),
        payment: pagoBody,
        // OBLIGATORIA (fase 1.3): la genera la pantalla una vez por venta. Es
        // lo único que distingue «el mismo paquete enviado dos veces» de «dos
        // paquetes»; sin ella, un doble clic vendía y cobraba dos.
        saleKey: z.string().min(8).max(80),
      }).parse(request.body);

      request.authorize('memberships:visitpack:manage', { branchId: body.soldAtBranchId ?? null });
      if (body.payment) request.authorize('payments:record', { branchId: body.soldAtBranchId ?? null });

      const { pack, charge, payment } = await service.sellVisitPack(ctx, {
        memberId: id,
        planId: body.planId,
        soldAtBranchId: body.soldAtBranchId ?? null,
        payment: aPago(body.payment),
        saleKey: body.saleKey,
      });
      return reply.status(201).send({
        id: pack.id,
        memberId: pack.memberId,
        planId: pack.planId,
        visitsPurchased: pack.visitsPurchased,
        purchasedOn: iso(pack.purchasedOn),
        expiresOn: pack.expiresOn ? iso(pack.expiresOn) : null,
        status: pack.status,
        balance: pack.visitsPurchased,
        charge: serializeCharge(charge),
        payment: payment ? serializePayment(payment) : null,
      });
    },
  });
  /** Lo que costaría hoy: el mismo cálculo que los cargos reales. */
  route(app, {
    method: 'GET',
    url: '/plans/:id/quote',
    security: { kind: 'permission', permission: 'catalog:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const { branchId } = z.object({ branchId: z.string().uuid().optional() }).parse(request.query);
      const q = await service.quote(ctx, id, branchId ?? null);
      return {
        available: q.available,
        totalCents: q.totalCents.toString(),
        lines: q.lines.map((l) => ({
          concept: l.concept,
          subtotalCents: l.subtotalCents.toString(),
          taxCents: l.taxCents.toString(),
          totalCents: l.totalCents.toString(),
        })),
      };
    },
  });
  /**
   * Vende una membresía de principio a fin: la crea, genera sus cargos y, si
   * se cobra en el momento, registra el pago —que la activa—.
   */
  route(app, {
    method: 'POST',
    url: '/members/:id/memberships/sale',
    security: { kind: 'permission', permission: 'memberships:create' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        planId: z.string().uuid(),
        branchId: z.string().uuid(),
        startDate: z.string().date().optional(),
        autoRenew: z.boolean().optional(),
        saleKey: z.string().min(8).max(100).optional(),
        /** Obligatorio si la venta empieza más de 7 días atrás (payments:backdate) o lleva precio pactado. */
        reason: z.string().min(3).max(300).optional(),
        /** Precio pactado por periodo, en centavos (DM-05): convenio, promoción respetada, precio viejo. */
        agreedPriceCents: z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos').optional(),
        payment: z.object({
          method: z.enum(['CASH', 'CARD_TERMINAL', 'SPEI_TRANSFER']),
          cashSessionId: z.string().uuid().optional(),
          externalRef: z.string().trim().max(120).optional(),
        }).refine((p) => p.method !== 'SPEI_TRANSFER' || !!p.externalRef, {
          message: 'Una transferencia necesita su referencia o clave de rastreo', path: ['externalRef'],
        }).nullable().default(null),
      }).parse(request.body);

      request.authorize('memberships:create', { branchId: body.branchId });
      // Un precio distinto al de lista es un descuento con nombre y motivo (DM-05).
      let pactado: bigint | null = null;
      if (body.agreedPriceCents !== undefined) {
        pactado = BigInt(body.agreedPriceCents);
        const lista = await new PlanRepository(ctx.tenant.organizationId).effectivePriceCents(body.planId, body.branchId);
        if (lista !== null && pactado !== lista) {
          if (!body.reason) throw validation('Un precio distinto al de lista necesita motivo');
          // Por debajo de lista es un descuento: pasa por el tope del rol como cualquier otro.
          const descuento = lista - pactado;
          if (descuento > 0n) {
            request.authorize('billing:discount:apply', {
              branchId: body.branchId, reason: body.reason, amountCents: descuento,
              ...(lista > 0n ? { percent: discountPercentOf(money(descuento), money(lista)) } : {}),
            });
          }
        }
      }
      // Cobrar es otro permiso: se puede vender y dejar el cobro a caja.
      if (body.payment) request.authorize('payments:record', { branchId: body.branchId });
      let fechadaAtras = false;
      // Un inicio retroactivo mueve vigencia, corte e ingresos del mes (MC-10, DM-14):
      // más de 7 días atrás exige su permiso y su motivo; más de 30 adelante no tiene sentido.
      if (body.startDate) {
        const hoy = await new BusinessCalendar(ctx.tenant.organizationId).today(body.branchId);
        const inicio = new Date(`${body.startDate}T00:00:00.000Z`);
        const dias = Math.round((inicio.getTime() - hoy.getTime()) / 86_400_000);
        if (dias > 30) throw validation('La membresía no puede empezar más de 30 días después de hoy');
        if (dias < -7) {
          if (!body.reason) throw validation('Una venta que empieza hace más de 7 días necesita motivo');
          request.authorize('payments:backdate', { branchId: body.branchId, reason: body.reason });
          fechadaAtras = true;
        }
      }

      const r = await service.sellMembership(ctx, {
        ...(fechadaAtras ? { backdated: true } : {}),
        memberId: id,
        planId: body.planId,
        branchId: body.branchId,
        ...(body.startDate ? { startDate: new Date(`${body.startDate}T00:00:00.000Z`) } : {}),
        ...(body.autoRenew !== undefined ? { autoRenew: body.autoRenew } : {}),
        ...(body.saleKey ? { saleKey: body.saleKey } : {}),
        ...(pactado !== null ? { agreedPriceCents: pactado } : {}),
        payment: body.payment
          ? {
            method: body.payment.method,
            cashSessionId: body.payment.cashSessionId ?? null,
            externalRef: body.payment.externalRef ?? null,
          }
          : null,
      });
      return reply.status(r.created ? 201 : 200).send({
        created: r.created,
        membership: {
          id: r.membership.id,
          status: r.membership.status,
          currentPeriodStart: iso(r.membership.currentPeriodStart),
          currentPeriodEnd: iso(r.membership.currentPeriodEnd),
        },
        totalCents: r.totalCents.toString(),
        /** Lo que cubrió su saldo a favor: no se le cobró (4-18). Lo cobrado es `payment.amountCents`. */
        creditAppliedCents: r.creditAppliedCents.toString(),
        charges: r.charges.map(serializeCharge),
        payment: r.payment ? serializePayment(r.payment) : null,
      });
    },
  });
  /** Renovar por adelantado, COBRANDO el periodo siguiente. */
  route(app, {
    method: 'POST',
    url: '/memberships/:id/renewal',
    security: { kind: 'permission', permission: 'memberships:create' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({
        payment: pagoBody,
        // El periodo que vio la pantalla: la llave de la renovación. OBLIGATORIO
        // (fase 1.3): un reintento tras un corte de red responde 409 en lugar
        // de renovar y cobrar un segundo periodo.
        expectedPeriodStart: z.string().date(),
      }).parse(request.body ?? {});
      const sede = await sedeDeMembresia(request.ctx!.tenant.organizationId, id);
      request.authorize('memberships:create', { branchId: sede });
      if (body.payment) request.authorize('payments:record', { branchId: sede });
      const r = await service.renewMembership(request.ctx!, {
        membershipId: id, payment: aPago(body.payment),
        expectedPeriodStart: new Date(`${body.expectedPeriodStart}T00:00:00.000Z`),
      });
      return {
        membership: serializarMembresia(r.membership),
        charge: serializeCharge(r.charge),
        payment: r.payment ? serializePayment(r.payment) : null,
      };
    },
  });
  /** Suspendida que vuelve: cuánto cuesta reanudar el adeudo u olvidarlo. */
  route(app, {
    method: 'GET',
    url: '/memberships/:id/debt-options',
    security: { kind: 'permission', permission: 'billing:statement:read' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      request.requirePermission('billing:statement:read', await sedeDeMembresia(request.ctx!.tenant.organizationId, id));
      const o = await service.suspendedDebtOptions(request.ctx!, id);
      return {
        today: dia(o.today), planName: o.planName, periodCents: o.periodCents.toString(),
        openCharges: o.openCharges.map(serializeCharge), openCents: o.openCents.toString(),
        missedPeriods: o.missedPeriods.map((p) => ({ start: dia(p.start), end: dia(p.end) })),
        resumeTotalCents: o.resumeTotalCents.toString(),
        forgiveNewPeriod: o.forgiveNewPeriod ? { start: dia(o.forgiveNewPeriod.start), end: dia(o.forgiveNewPeriod.end) } : null,
      };
    },
  });
  /**
   * La decisión: REANUDAR el adeudo (se cobran los periodos que no pagó) u
   * OLVIDARLO (se condona, con autorización, y arranca un periodo hoy).
   */
  route(app, {
    method: 'POST',
    url: '/memberships/:id/debt-decision',
    security: { kind: 'permission', permission: 'billing:charge:create' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({
        decision: z.enum(['RESUME', 'FORGIVE']),
        reason: z.string().min(3).max(300),
        approvalToken: z.string().min(20).max(200).optional(),
        payment: pagoBody,
      }).parse(request.body);
      const sede = await sedeDeMembresia(request.ctx!.tenant.organizationId, id);
      request.authorize('billing:charge:create', { branchId: sede, reason: body.reason });
      let aprobador: string | null = null;
      if (body.decision === 'FORGIVE') {
        // El límite de condonación del rol se mide contra lo que se perdona.
        const { openCents, missedPeriods } = await service.suspendedDebtOptions(request.ctx!, id);
        // Sin meses atrasados no hay adeudo que olvidar (4-08), y se dice
        // antes de pedir la firma de nadie.
        if (missedPeriods.length === 0) {
          throw conflict('Su periodo sigue en curso: no hay meses atrasados que olvidar. Cóbrale lo que debe');
        }
        aprobador = await request.verifyApprover(body.approvalToken, 'billing:waiver:apply', {
          branchId: sede, resourceType: 'Membership', resourceId: id, amountCents: openCents,
        });
        // D-12: olvidar el adeudo es perdonar con monto; dentro de una mensualidad del socio no pide firma.
        const socioId = (await new MembershipRepository(request.ctx!.tenant.organizationId).findById(id))?.memberId;
        const tope = socioId ? await perdonDisponible(request.ctx!.tenant.organizationId, socioId) : null;
        request.authorize('billing:waiver:apply', {
          branchId: sede, reason: body.reason, amountCents: openCents,
          ...(tope ? { waiverAllowanceCents: tope.disponibleCents } : {}),
          ...(aprobador ? { approvedByUserId: aprobador } : {}),
        });
      }
      if (body.payment) request.authorize('payments:record', { branchId: sede });
      const r = await service.resolveSuspendedDebt(request.ctx!, {
        membershipId: id, decision: body.decision, reason: body.reason,
        approvedByUserId: aprobador, payment: aPago(body.payment),
      });
      return {
        membership: serializarMembresia(r.membership),
        charges: r.charges.map(serializeCharge),
        forgivenCents: r.forgivenCents.toString(),
        payment: r.payment ? serializePayment(r.payment) : null,
      };
    },
  });
  /** Cambio de plan COBRADO, con crédito por los días pagados y no usados. */
  route(app, {
    method: 'POST',
    url: '/memberships/:id/plan-change',
    security: { kind: 'permission', permission: 'memberships:change_plan' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({
        planId: z.string().uuid(), reason: z.string().min(3).max(300), payment: pagoBody,
      }).parse(request.body);
      const sede = await sedeDeMembresia(request.ctx!.tenant.organizationId, id);
      request.authorize('memberships:change_plan', { reason: body.reason, branchId: sede });
      if (body.payment) request.authorize('payments:record', { branchId: sede });
      const r = await service.changeMembershipPlan(request.ctx!, {
        membershipId: id, planId: body.planId, reason: body.reason, payment: aPago(body.payment),
      });
      return {
        membership: serializarMembresia(r.membership),
        proration: r.proration,
        creditCents: r.creditCents.toString(),
        /** Lo que sobró del crédito y quedó a favor del socio (4-05). */
        creditToBalanceCents: r.creditToBalanceCents.toString(),
        charge: serializeCharge(r.charge),
        payment: r.payment ? serializePayment(r.payment) : null,
      };
    },
  });
}
