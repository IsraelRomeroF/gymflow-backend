import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { route } from '../../platform/http/registry.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { OrganizationRepository } from '../organization/index.js';
import { PrivacyService } from './privacy.service.js';
import { idParam, sedeDe } from './privacy.serializers.js';

/** ARCO · cancelación y plazo de supresión: anonimizar, el plazo del gimnasio y quién ya lo cumplió. */
export function registerAnonymizeRoutes(app: FastifyInstance): void {
  const service = new PrivacyService();

  /** ARCO · cancelación: anonimizar a un socio ya dado de baja. */
  route(app, {
    method: 'POST',
    url: '/members/:id/anonymize',
    security: { kind: 'permission', permission: 'members:anonymize' },
    handler: async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({
        reason: z.string().min(3).max(300),
        approvalToken: z.string().min(20).max(200).optional(),
      }).parse(request.body);
      const sede = await sedeDe(request.ctx!.tenant.organizationId, id);
      const aprobador = await request.verifyApprover(body.approvalToken, 'members:anonymize', { branchId: sede, resourceType: 'Member', resourceId: id });
      request.authorize('members:anonymize', {
        branchId: sede, reason: body.reason, ...(aprobador ? { approvedByUserId: aprobador } : {}),
      });
      await service.anonymize(request.ctx!, id, body.reason, aprobador);
      return reply.status(204).send();
    },
  });

  // ── Plazo de supresión (PS-08) ────────────────────────────────────────────

  route(app, {
    method: 'GET',
    url: '/privacy/settings',
    security: { kind: 'permission', permission: 'members:consent:read' },
    handler: async (request) => {
      request.requirePermission('members:consent:read', null);
      return new OrganizationRepository(request.ctx!.tenant.organizationId).privacySettings();
    },
  });

  route(app, {
    method: 'PUT',
    url: '/privacy/settings',
    security: { kind: 'permission', permission: 'settings:org' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { monthsAfterArchive } = z.object({ monthsAfterArchive: z.number().int().min(1).max(120).nullable() }).parse(request.body);
      request.requirePermission('settings:org', null);
      await new OrganizationRepository(ctx.tenant.organizationId).setPrivacyMonths(monthsAfterArchive);
      await new AuditService().record(ctx, { action: 'settings.privacy.update', resourceType: 'Organization', resourceId: ctx.tenant.organizationId, afterState: { monthsAfterArchive } });
      return { monthsAfterArchive };
    },
  });

  /** Exsocios que ya cumplieron el plazo: se proponen, no se borran solos. */
  route(app, {
    method: 'GET',
    url: '/privacy/candidates',
    security: { kind: 'permission', permission: 'members:anonymize' },
    handler: async (request) => {
      request.requirePermission('members:anonymize', null);
      const r = await service.candidatos(request.ctx!.tenant.organizationId);
      return { monthsAfterArchive: r.monthsAfterArchive, members: r.members.map((m) => ({ ...m, archivedAt: m.archivedAt.toISOString() })) };
    },
  });
}
