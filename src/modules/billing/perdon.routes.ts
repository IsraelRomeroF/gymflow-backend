import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DIAS_DEL_TOPE_DE_PERDON, codigosDeMotivo, notFound, perdonSinFirma } from '@gymflow/core';
import { DebtWaiverResult, MemberDebt } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { MemberRepository } from '../members/index.js';
import { BillingService, saldo } from './billing.service.js';
import { ChargeRepository } from './charge.repository.js';
import { PaymentRepository } from './payment.repository.js';
import { cents, idParam, iso } from './billing.serializers.js';
import { cargosConDeuda, condonarAdeudo, perdonDisponible } from './perdon.js';

/**
 * EL ADEUDO DE UN SOCIO Y SU PERDÓN (D-12, bloque 3.5).
 *
 * Quien da de baja o cancela ve lo que el socio debe y elige: cobrarlo,
 * dejarlo registrado (por omisión: no se llama a nada) o perdonarlo aquí, con
 * motivo de catálogo y monto. Dentro de una mensualidad del socio la gerencia
 * lo hace sola; arriba, con la firma de la dueña.
 */
export function registerPerdonRoutes(app: FastifyInstance): void {
  const service = new BillingService();

  route(app, {
    method: 'GET',
    url: '/members/:id/debt',
    security: { kind: 'permission', permission: 'billing:statement:read' },
    schema: respuesta(200, MemberDebt),
    handler: async (request): Promise<MemberDebt> => {
      const orgId = request.ctx!.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const { membershipId } = z.object({ membershipId: z.string().uuid().optional() }).parse(request.query);
      const socio = await new MemberRepository(orgId).findById(id);
      if (!socio) throw notFound('Socio no encontrado');
      // Como el estado de cuenta: el expediente del socio es uno en todo el gimnasio (se le cobra en cualquier sede).
      const [abiertos, credito, tope] = await Promise.all([
        cargosConDeuda(orgId, id, membershipId),
        new PaymentRepository(orgId).creditBalanceCents(id),
        perdonDisponible(orgId, id),
      ]);
      const debe = abiertos.reduce((a, c) => a + saldo(c), 0n);
      return {
        memberId: id,
        outstandingCents: cents(debe),
        creditCents: cents(credito),
        charges: abiertos.map((c) => ({ id: c.id, membershipId: c.membershipId, concept: c.concept, dueDate: iso(c.dueDate), balanceCents: cents(saldo(c)) })),
        waiver: {
          monthlyCents: tope.mensualidadCents === null ? null : cents(tope.mensualidadCents),
          usedCents: cents(tope.usadoCents), availableCents: cents(tope.disponibleCents), windowDays: DIAS_DEL_TOPE_DE_PERDON,
        },
        waiveAllNeedsApproval: debe > 0n && !perdonSinFirma({ mensualidadCents: tope.mensualidadCents, perdonadoSinFirmaCents: tope.usadoCents, montoCents: debe }).sinFirma,
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/members/:id/debt/waiver',
    security: { kind: 'permission', permission: 'billing:waiver:apply' },
    schema: respuesta(201, DebtWaiverResult),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        /** Solo el adeudo de esa membresía (al cancelarla). Sin ella, todo lo que debe (al darlo de baja). */
        membershipId: z.string().uuid().optional(),
        reasonCode: z.string().min(1).max(40).refine((c) => codigosDeMotivo('condonacion').includes(c), 'Elige un motivo de la lista'),
        reason: z.string().min(3).max(300),
        approvalToken: z.string().min(20).max(200).optional(),
      }).parse(request.body);
      const socio = await new MemberRepository(orgId).findById(id);
      if (!socio) throw notFound('Socio no encontrado');

      const abiertos = await cargosConDeuda(orgId, id, body.membershipId);
      const debe = abiertos.reduce((a, c) => a + saldo(c), 0n);
      // La sede del perdón es la de los cargos (la de la venta); si son de varias, la de casa del socio.
      const sedes = [...new Set(abiertos.map((c) => c.branchId))];
      const sede = sedes.length === 1 ? sedes[0]! : socio.homeBranchId;
      const tope = await perdonDisponible(orgId, id);
      const aprobador = await request.verifyApprover(body.approvalToken, 'billing:waiver:apply', {
        branchId: sede, resourceType: 'Member', resourceId: id, amountCents: debe,
      });
      request.authorize('billing:waiver:apply', {
        branchId: sede, reason: body.reason, amountCents: debe, waiverAllowanceCents: tope.disponibleCents,
        ...(aprobador ? { approvedByUserId: aprobador } : {}),
      });

      const r = await condonarAdeudo(service, ctx, {
        memberId: id, membershipId: body.membershipId ?? null, reason: body.reason, reasonCode: body.reasonCode, approvedByUserId: aprobador,
      });
      return reply.status(201).send({
        memberId: id,
        forgivenCents: cents(r.forgivenCents),
        charges: r.charges.map((x) => ({ id: x.charge.id, concept: x.charge.concept, forgivenCents: cents(x.forgivenCents) })),
        approvedByUserId: aprobador,
        outstandingCents: cents(await new ChargeRepository(orgId).outstandingTotalCents(id)),
      } satisfies DebtWaiverResult);
    },
  });
}
