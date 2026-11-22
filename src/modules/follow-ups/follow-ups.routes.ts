import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '@gymflow/core';
import { FollowUpContact, FollowUpLatest } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { MemberRepository } from '../members/index.js';
import { FollowUpRepository } from './follow-up.repository.js';
import { contactoBody, contactoJson } from './contacto.js';

const idParam = z.object({ id: z.string().uuid() });

/** Seguimiento de socios en riesgo (Retención): «Le llamé» y el último contacto de cada uno. */
export function registerFollowUpRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  // ── Seguimiento de socios en riesgo (Retención) ───────────────────────────
  /**
   * "Le llamé" desde Retención: queda en la ficha y la lista deja de pedir que
   * se le llame. Anotarlo es ESCRIBIR: pide `retention:followup:write`, no el
   * permiso de ver reportes (28-04, auditoría 8).
   */
  route(app, {
    method: 'POST',
    url: '/members/:id/follow-ups',
    module: 'retention',
    security: { kind: 'permission', permission: 'retention:followup:write' },
    schema: respuesta(201, FollowUpContact),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = contactoBody.parse(request.body);
      const m = await new MemberRepository(ctx.tenant.organizationId).findById(id);
      if (!m) throw notFound('Socio no encontrado');
      // La sede del socio manda. Sin sede de casa solo lo anota quien tiene
      // alcance de todo el gimnasio: antes el chequeo se saltaba (15-13).
      request.requirePermission('retention:followup:write', m.homeBranchId ?? null);
      const f = await new FollowUpRepository(ctx.tenant.organizationId).create({
        memberId: id, branchId: m.homeBranchId ?? null, channel: body.channel, outcome: body.outcome,
        note: body.note ?? null, nextStepOn: body.nextStepOn ? new Date(`${body.nextStepOn}T00:00:00Z`) : null,
        createdByUserId: ctx.tenant.actorUserId!,
      });
      await audit.record(ctx, { action: 'member.follow_up', resourceType: 'Member', resourceId: id, branchId: m.homeBranchId ?? null, afterState: { channel: body.channel, outcome: body.outcome, nextStepOn: body.nextStepOn ?? null } });
      return reply.status(201).send(contactoJson(f));
    },
  });

  /**
   * El último contacto de varios socios: lo que pinta la lista de Retención.
   * Solo vienen los socios de las sedes donde quien pide ve la lista (15-13);
   * un id de otra sede no da error, simplemente no viene, igual que el que
   * nunca fue contactado: la respuesta no confirma que el socio exista.
   *
   * Contrato: `FollowUpLatest` (`@gymflow/core/contracts`).
   */
  route(app, {
    method: 'GET',
    url: '/members/follow-ups/latest',
    module: 'retention',
    security: { kind: 'permission', permission: 'reports:branch:read' },
    schema: respuesta(200, FollowUpLatest),
    handler: async (request): Promise<FollowUpLatest> => {
      const ctx = request.ctx!;
      const { ids } = z.object({
        ids: z.string().transform((v) => v.split(',').filter(Boolean)).pipe(z.array(z.string().uuid()).max(500)),
      }).parse(request.query);
      const ultimos = await new FollowUpRepository(ctx.tenant.organizationId).latest('member', ids, {
        memberBranchIds: request.branchScope('reports:branch:read'),
      });
      return { latest: [...ultimos.entries()].map(([memberId, u]) => ({ memberId, count: u.count, last: contactoJson(u.last) })) };
    },
  });
}
