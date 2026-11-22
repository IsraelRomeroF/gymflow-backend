import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatMoney, money, notFound } from '@gymflow/core';
import { AccessException, CollectAndOpenResult } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { AccessRepository } from './access.repository.js';
import { ExceptionService } from './exception.service.js';
import { idParam, respuesta } from './access.serializers.js';

/** La pantalla de excepción: qué pasó con el rechazo y «Cobrar y abrir». */
export function registerExceptionRoutes(app: FastifyInstance): void {
  const exception = new ExceptionService();

  // ── Pantalla de excepción ─────────────────────────────────────────────────
  /**
   * TODO lo que recepción necesita, en UNA llamada.
   *
   * Con un socio delante y una cola detrás, tres peticiones encadenadas son
   * tres formas de que la pantalla se quede a medias — y ahí se pierde el
   * criterio de resolver el rechazo en veinte segundos.
   */
  route(app, {
    method: 'GET',
    url: '/access/decisions/:id/exception',
    security: { kind: 'permission', permission: 'access:monitor' },
    schema: respuesta(200, AccessException),
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const v = await exception.view(ctx, id);
      request.requirePermission('access:monitor', v.decision.branchId);

      return {
        decision: {
          id: v.decision.id,
          outcome: v.decision.outcome,
          reason: v.decision.denialReason,
          at: v.decision.at.toISOString(),
          branchId: v.decision.branchId,
        },
        member: {
          ...v.member,
          joinedAt: v.member.joinedAt.toISOString().slice(0, 10),
        },
        membershipStatus: v.membershipStatus,
        outstandingCents: v.outstandingCents.toString(),
        outstandingLabel: formatMoney(money(v.outstandingCents)),
        creditCents: v.creditCents.toString(),
        minimumCents: v.minimumCents?.toString() ?? null,
        periodsOwed: v.periodsOwed,
        recentVisits: v.recentVisits.map((x) => ({
          at: x.at.toISOString(), branchId: x.branchId,
        })),
        /** Tres como mucho. Un menú no se resuelve en veinte segundos. */
        options: v.options,
        /** Ya resuelto (5-10): cobrar o dejar pasar responde 409. */
        resolution: v.resolution ? { decisionId: v.resolution.decisionId, at: v.resolution.at.toISOString(), byName: v.resolution.byName } : null,
      };
    },
  });

  /** Cobrar y abrir. El botón principal ante una deuda. */
  route(app, {
    method: 'POST',
    url: '/access/decisions/:id/collect',
    security: { kind: 'permission', permission: 'payments:record' },
    schema: respuesta(201, CollectAndOpenResult),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        method: z.enum(['CASH', 'CARD_TERMINAL', 'SPEI_TRANSFER']),
        amountCents: z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos'),
        cashSessionId: z.string().uuid().optional(),
        externalRef: z.string().trim().max(120).optional(),
      }).refine((b) => b.method !== 'SPEI_TRANSFER' || !!b.externalRef, {
        message: 'Una transferencia necesita su referencia o clave de rastreo', path: ['externalRef'],
      }).parse(request.body);

      const decision = await new AccessRepository(ctx.tenant.organizationId).findDecision(id);
      if (!decision) throw notFound('Decisión no encontrada');
      request.authorize('payments:record', {
        branchId: decision.branchId, amountCents: BigInt(body.amountCents),
      });

      const r = await exception.collectAndOpen(ctx, {
        decisionId: id,
        method: body.method,
        amountCents: BigInt(body.amountCents),
        ...(body.cashSessionId ? { cashSessionId: body.cashSessionId } : {}),
        ...(body.externalRef ? { externalRef: body.externalRef } : {}),
      });
      const m = r.estado.membership;
      return reply.status(201).send({
        paymentId: r.paymentId, folio: r.folio, decisionId: r.decisionId, attendanceId: r.attendanceId,
        creditAppliedCents: r.creditAppliedCents.toString(),
        membership: m && { id: m.id, status: m.status, canEnter: m.canEnter, paidThrough: m.paidThrough ? m.paidThrough.toISOString().slice(0, 10) : null },
        toEnterCents: r.estado.toEnterCents?.toString() ?? null,
      });
    },
  });
}
