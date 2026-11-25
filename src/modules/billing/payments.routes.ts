import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { ChargeRepository } from './charge.repository.js';
import { MemberRepository } from '../members/index.js';
import { MembershipRepository } from '../memberships/index.js';
import { PlanRepository, avisoDePrecioEnRecibo } from '../catalog/index.js';
import { PaymentRepository } from './payment.repository.js';
import { BillingService } from './billing.service.js';
import { idParam, cents, iso, serializePayment, serializeEstadoParaCobro } from './billing.serializers.js';
import { notFound, paidThrough, validation } from '@gymflow/core';
import { ApplyCreditResult, PaymentReceipt, RecordPaymentResult } from '@gymflow/core/contracts';
import { StatementRepository } from './statement.repository.js';

/** Pagos: registrar, comprobante, lista y reversa. */
export function registerPaymentsRoutes(app: FastifyInstance): void {
  const service = new BillingService();
  // ── Pagos ─────────────────────────────────────────────────────────────────
  route(app, {
    method: 'POST',
    url: '/members/:id/payments',
    security: { kind: 'permission', permission: 'payments:record' },
    schema: respuesta([200, 201], RecordPaymentResult),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        /**
         * Del MOSTRADOR solo entra dinero que alguien tiene en la mano o puede
         * rastrear (BE2-02): efectivo, terminal y transferencia. La tarjeta
         * domiciliada y OXXO las registra el procesador; una "nota de crédito"
         * tecleada aquí saldaba adeudos sin dinero, sin caja y sin firma —
         * perdonar una deuda es una condonación, con su permiso y sus firmas.
         */
        method: z.enum(['CASH', 'CARD_TERMINAL', 'SPEI_TRANSFER']),
        amountCents: z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos'),
        branchId: z.string().uuid().optional(),
        externalRef: z.string().trim().max(120).optional(),
        // OBLIGATORIA: el cliente la genera una vez por cobro. Sin ella, un
        // doble clic o un reintento de red cobraba dos veces.
        idempotencyKey: z.string().min(8).max(120),
        targetChargeIds: z.array(z.string().uuid()).optional(),
        /** Obligatorio solo si la sucursal tiene más de una caja abierta. */
        cashSessionId: z.string().uuid().optional(),
      }).parse(request.body);

      const amount = BigInt(body.amountCents);
      if (amount <= 0n) throw validation('El importe debe ser positivo');
      if (body.method === 'SPEI_TRANSFER' && !body.externalRef) {
        throw validation('Una transferencia necesita su referencia o clave de rastreo: es lo que se cruza con el banco');
      }

      request.authorize('payments:record', { branchId: body.branchId ?? null, amountCents: amount });

      const result = await service.recordPayment(ctx, {
        memberId: id,
        method: body.method,
        amountCents: amount,
        ...(body.branchId ? { branchId: body.branchId } : {}),
        ...(body.externalRef ? { externalRef: body.externalRef } : {}),
        idempotencyKey: body.idempotencyKey,
        ...(body.cashSessionId ? { cashSessionId: body.cashSessionId } : {}),
        targetChargeIds: body.targetChargeIds,
      });
      // Lo que el mostrador le dice al socio al terminar (4-09): si ya entra,
      // hasta dónde quedó pagado y, si no le alcanzó, cuánto le falta.
      const estado = await service.estadoParaCobro(ctx, id);

      // Contrato `RecordPaymentResult` del núcleo (lo consume el mostrador, 1.4):
      // si la respuesta cambia un campo, esto deja de compilar.
      const cobro = serializeEstadoParaCobro(estado);
      const respuesta: RecordPaymentResult = {
        payment: serializePayment(result.payment),
        allocations: result.allocations.map((a) => ({
          chargeId: a.chargeId,
          amountCents: cents(a.amountCents),
        })),
        unappliedCents: cents(result.unappliedCents),
        /** Saldo a favor que cubrió deuda antes de repartir este cobro (4-18). */
        creditAppliedCents: cents(result.creditAppliedCents),
        created: result.created,
        toEnterCents: cobro.toEnterCents,
        // `findCurrentForMember` solo devuelve una membresía viva o suspendida: nunca cancelada ni vencida.
        membership: cobro.membership as RecordPaymentResult['membership'],
      };
      return reply.status(result.created ? 201 : 200).send(respuesta);
    },
  });
  /**
   * Comprobante de un pago: lo que el socio se lleva. Qué pagó, a qué cargos
   * se aplicó y cuánto le quedó a favor. Antes el folio solo aparecía en un
   * aviso de pocos segundos y recepción no tenía qué entregarle.
   */
  route(app, {
    method: 'GET',
    url: '/payments/:id/receipt',
    security: { kind: 'permission', permission: 'billing:statement:read' },
    schema: respuesta(200, PaymentReceipt),
    handler: async (request): Promise<PaymentReceipt> => {
      const orgId = request.ctx!.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const pagos = new PaymentRepository(orgId);
      const pago = await pagos.findById(id);
      if (!pago) throw notFound('Pago no encontrado');
      const socio = await new MemberRepository(orgId).findById(pago.memberId);
      const cargos = new ChargeRepository(orgId);
      const asignaciones = await pagos.listAllocations(id);
      const tocados = await Promise.all(asignaciones.map((a) => cargos.findById(a.chargeId)));
      const lineas = asignaciones.map((a, i) => ({ concept: tocados[i]?.concept ?? 'Cargo', amountCents: cents(a.amountCents) }));

      // «Pagado hasta» CON ESTE pago (3-01): las cuotas de su membresía como
      // quedaron al registrarlo, no como están hoy. Un comprobante reimpreso
      // no puede prometer lo que pagaron cobros posteriores.
      const membresiaId = tocados.find((c) => c?.membershipId && c.chargeType === 'MEMBERSHIP_PERIOD')?.membershipId
        ?? tocados.find((c) => c?.membershipId)?.membershipId ?? null;
      let coverage: { planName: string | null; paidThrough: string | null } | null = null;
      let priceNotice: PaymentReceipt['priceNotice'] = null;
      if (membresiaId && BigInt(pago.amountCents) > 0n) {
        const momento = new Date(Math.max(pago.createdAt.getTime(), ...asignaciones.map((a) => a.createdAt.getTime())));
        const m = await new MembershipRepository(orgId).findById(membresiaId);
        const plan = m ? await new PlanRepository(orgId).findById(m.planId) : null;
        const hasta = paidThrough(await cargos.cuotasAlMomento(membresiaId, momento));
        coverage = { planName: plan?.name ?? null, paidThrough: hasta ? iso(hasta) : null };
        // El aviso del cambio de precio de su plan (D-19, bloque 3.6): la regla es de `catalog`.
        const pagadas = new Set(tocados.filter((c) => c?.membershipId === membresiaId && c.chargeType === 'MEMBERSHIP_PERIOD').map((c) => c!.id));
        const cuotas = (await cargos.listForMember(pago.memberId))
          .filter((c) => c.membershipId === membresiaId && c.chargeType === 'MEMBERSHIP_PERIOD')
          .map((c) => ({ id: c.id, createdAt: c.createdAt, cubierta: pagadas.has(c.id) }));
        const aviso = await avisoDePrecioEnRecibo(orgId, { membershipId: membresiaId, pagadoEn: pago.createdAt, cuotas });
        // 4.20 (P-14): «a partir del <día>» cuando el aumento espera sus 15 días.
        priceNotice = aviso ? { kind: aviso.kind, planName: plan?.name ?? null, fromPriceCents: cents(aviso.fromPriceCents), toPriceCents: cents(aviso.toPriceCents), startsOn: aviso.startsOn ? iso(aviso.startsOn) : null } : null;
      }
      return {
        payment: serializePayment(pago),
        member: socio ? { id: socio.id, memberCode: socio.memberCode, fullName: `${socio.firstName} ${socio.lastName}` } : null,
        lines: lineas,
        coverage,
        priceNotice,
        // Quién lo cobró (3-05; bloque 2.2): el comprobante ya lo dice, como el estado de cuenta.
        collectedByName: await new StatementRepository(orgId).collectorOf(id),
      };
    },
  });
  /**
   * Aplicar el saldo a favor, SIN cobro (2.13; pendiente de 1.4). Cuando lo
   * que el socio tiene a favor cubre lo que debe, en la puerta no hay nada que
   * cobrar («Cobrar y abrir» responde 422): esto reparte su saldo entre sus
   * cargos abiertos, reactiva la membresía si quedó saldada (como un cobro) y
   * lo asienta (`billing.credit.apply`). No entra dinero y no abre la puerta:
   * la entrada se registra después y la puerta decide de verdad.
   * Repetirla no hace nada: sin saldo a favor o sin deuda, aplica 0.
   */
  route(app, {
    method: 'POST',
    url: '/members/:id/credit/apply',
    security: { kind: 'permission', permission: 'payments:record' },
    schema: respuesta(200, ApplyCreditResult),
    handler: async (request): Promise<ApplyCreditResult> => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const body = z.object({ branchId: z.string().uuid() }).parse(request.body);
      request.authorize('payments:record', { branchId: body.branchId });
      // También a un socio dado de baja (D-12; bloque 4.11): su saldo a favor paga lo que quedó debiendo.
      if (!await new MemberRepository(orgId).findByIdIncludingArchived(id)) throw notFound('Socio no encontrado');

      const aplicado = await service.applyCredit(ctx, id, { branchId: body.branchId });
      const [estado, credito, deuda] = await Promise.all([
        service.estadoParaCobro(ctx, id),
        new PaymentRepository(orgId).creditBalanceCents(id),
        new ChargeRepository(orgId).outstandingTotalCents(id),
      ]);
      const cobro = serializeEstadoParaCobro(estado);
      return {
        appliedCents: cents(aplicado), creditCents: cents(credito), outstandingCents: cents(deuda), toEnterCents: cobro.toEnterCents,
        // `findCurrentForMember` solo devuelve una membresía viva o suspendida: nunca cancelada ni vencida.
        membership: cobro.membership as ApplyCreditResult['membership'],
      };
    },
  });
  // `GET /members/:id/payments` se retiró (2.13): cortaba en 100 sin avisar y
  // ninguna pantalla la usaba. Los pagos de un socio se leen por páginas en
  // `GET /members/:id/statement/payments`.
  route(app, {
    method: 'POST',
    url: '/payments/:id/reverse',
    security: { kind: 'permission', permission: 'payments:reverse' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        reason: z.string().min(3).max(300),
        approvalToken: z.string().min(20).max(200).optional(),
        /** Caja de la que sale el dinero. Obligatoria si hay varias abiertas. */
        cashSessionId: z.string().uuid().optional(),
      }).parse(request.body);

      const original = await new PaymentRepository(ctx.tenant.organizationId).findById(id);
      if (!original) throw notFound('Pago no encontrado');

      const aprobador = await request.verifyApprover(body.approvalToken, 'payments:reverse', { branchId: original.branchId, resourceType: 'Payment', resourceId: original.id, amountCents: original.amountCents });
      request.authorize('payments:reverse', {
        branchId: original.branchId,
        reason: body.reason,
        ...(aprobador ? { approvedByUserId: aprobador } : {}),
        amountCents: original.amountCents,
      });

      const reversal = await service.reversePayment(ctx, {
        paymentId: id,
        reason: body.reason,
        approvedByUserId: aprobador,
        ...(body.cashSessionId ? { cashSessionId: body.cashSessionId } : {}),
      });
      return reply.status(201).send(serializePayment(reversal));
    },
  });
}
