import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '@gymflow/core';
import { CreditReturnResult, PaymentReturnResult } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { MemberRepository } from '../members/index.js';
import { BillingService } from './billing.service.js';
import { PaymentRepository } from './payment.repository.js';
import { cents, idParam, serializePayment } from './billing.serializers.js';
import { devolverParteDeUnCobro, devolverSaldoAFavor } from './devolucion.js';

const importe = z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos').refine((v) => BigInt(v) > 0n, 'El importe debe ser mayor que cero');
const llave = z.string().min(8).max(100);

/**
 * DEVOLVER DINERO (D-13, bloque 3.5): una parte de un cobro de mostrador y el
 * saldo a favor que el socio pide. Las dos SIEMPRE con la firma de la dueña
 * (`payments:refund` la exige a todo importe): recepción no las tiene.
 */
export function registerDevolucionRoutes(app: FastifyInstance): void {
  const service = new BillingService();

  /** Lo que queda por devolver de un cobro: su importe menos sus contra-asientos. */
  async function quedaDe(orgId: string, pagoId: string, total: bigint): Promise<bigint> {
    const devuelto = await new PaymentRepository(orgId).returnedCents(pagoId);
    return total > devuelto ? total - devuelto : 0n;
  }

  route(app, {
    method: 'POST',
    url: '/payments/:id/return',
    security: { kind: 'permission', permission: 'payments:refund' },
    schema: respuesta([200, 201], PaymentReturnResult),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        amountCents: importe,
        reason: z.string().min(3).max(300),
        /** La genera la pantalla una vez por devolución: el doble clic no saca dinero dos veces. */
        requestKey: llave,
        approvalToken: z.string().min(20).max(200).optional(),
        /** El turno del que sale el efectivo. Obligatorio si hay varias cajas abiertas. */
        cashSessionId: z.string().uuid().optional(),
        /** Clave de rastreo de la devolución. Obligatoria si el cobro fue por transferencia. */
        returnRef: z.string().trim().min(3).max(120).optional(),
      }).parse(request.body);

      const repo = new PaymentRepository(orgId);
      const pago = await repo.findById(id);
      if (!pago) throw notFound('Pago no encontrado');
      request.requirePermission('payments:refund', pago.branchId);
      const amount = BigInt(body.amountCents);

      // El reintento del mismo envío responde lo ya hecho, sin pedir otra firma (la primera ya se usó).
      const previa = await repo.findByIdempotencyKey(`return-${id}-${body.requestKey}`);
      if (previa) {
        return reply.status(200).send({ entry: serializePayment(previa), remainingCents: cents(await quedaDe(orgId, id, pago.amountCents)) } satisfies PaymentReturnResult);
      }

      const aprobador = await request.verifyApprover(body.approvalToken, 'payments:refund', { branchId: pago.branchId, resourceType: 'Payment', resourceId: pago.id, amountCents: amount });
      request.authorize('payments:refund', {
        branchId: pago.branchId, reason: body.reason, amountCents: amount,
        ...(aprobador ? { approvedByUserId: aprobador } : {}),
      });
      const r = await devolverParteDeUnCobro(service, ctx, {
        paymentId: id, amountCents: amount, reason: body.reason, approvedByUserId: aprobador!,
        cashSessionId: body.cashSessionId ?? null, returnRef: body.returnRef ?? null, requestKey: body.requestKey,
      });
      return reply.status(r.created ? 201 : 200).send({
        entry: serializePayment(r.entry), remainingCents: cents(await quedaDe(orgId, id, pago.amountCents)),
      } satisfies PaymentReturnResult);
    },
  });

  route(app, {
    method: 'POST',
    url: '/members/:id/credit/return',
    security: { kind: 'permission', permission: 'payments:refund' },
    schema: respuesta([200, 201], CreditReturnResult),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        amountCents: importe,
        /** Por dónde se le regresa: efectivo del turno abierto, o transferencia con su referencia. */
        method: z.enum(['CASH', 'SPEI_TRANSFER']),
        branchId: z.string().uuid(),
        reason: z.string().min(3).max(300),
        requestKey: llave,
        approvalToken: z.string().min(20).max(200).optional(),
        cashSessionId: z.string().uuid().optional(),
        returnRef: z.string().trim().min(3).max(120).optional(),
      }).parse(request.body);

      if (!await new MemberRepository(orgId).findByIdIncludingArchived(id)) throw notFound('Socio no encontrado');
      request.requirePermission('payments:refund', body.branchId);
      const amount = BigInt(body.amountCents);
      const repo = new PaymentRepository(orgId);
      const responder = async (entries: Parameters<typeof serializePayment>[0][], codigo: 200 | 201) => reply.status(codigo).send({
        memberId: id,
        returnedCents: cents(entries.reduce((a, e) => a - e.amountCents, 0n)),
        entries: entries.map(serializePayment),
        creditCents: cents(await repo.creditBalanceCents(id)),
      } satisfies CreditReturnResult);

      const previas = await repo.findByIdempotencyPrefix(`credit-return-${id}-${body.requestKey}#`);
      if (previas.length > 0) return responder(previas, 200);

      const aprobador = await request.verifyApprover(body.approvalToken, 'payments:refund', { branchId: body.branchId, resourceType: 'Member', resourceId: id, amountCents: amount });
      request.authorize('payments:refund', {
        branchId: body.branchId, reason: body.reason, amountCents: amount,
        ...(aprobador ? { approvedByUserId: aprobador } : {}),
      });
      const r = await devolverSaldoAFavor(service, ctx, {
        memberId: id, amountCents: amount, method: body.method, branchId: body.branchId, reason: body.reason, approvedByUserId: aprobador!,
        cashSessionId: body.cashSessionId ?? null, returnRef: body.returnRef ?? null, requestKey: body.requestKey,
      });
      return responder(r.entries, r.created ? 201 : 200);
    },
  });
}
