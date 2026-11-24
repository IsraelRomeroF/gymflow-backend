import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONSERVACION, mesesDeConservacion } from '@gymflow/core';
import { PrivacySettings } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { OrganizationRepository } from '../organization/index.js';
import { PrivacyService } from './privacy.service.js';
import { idParam, respuesta, sedeDe } from './privacy.serializers.js';

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

  /**
   * El plazo para anonimizar (D-32): 24 meses tras la baja si el gimnasio no
   * fijó otro. `monthsAfterArchive` es lo que fijó (null = no fijó nada) y
   * `effectiveMonths` el que rige.
   */
  route(app, {
    method: 'GET',
    url: '/privacy/settings',
    security: { kind: 'permission', permission: 'members:consent:read' },
    schema: respuesta(200, PrivacySettings),
    handler: async (request) => {
      request.requirePermission('members:consent:read', null);
      const { monthsAfterArchive } = await new OrganizationRepository(request.ctx!.tenant.organizationId).privacySettings();
      return { monthsAfterArchive, effectiveMonths: mesesDeConservacion(monthsAfterArchive) };
    },
  });

  /** La gerencia ajusta el plazo de su gimnasio; `null` vuelve al de por omisión. Queda en la bitácora con el antes y el después. */
  route(app, {
    method: 'PUT',
    url: '/privacy/settings',
    security: { kind: 'permission', permission: 'settings:org' },
    schema: respuesta(200, PrivacySettings),
    handler: async (request) => {
      const ctx = request.ctx!;
      const { monthsAfterArchive } = z.object({
        monthsAfterArchive: z.number().int().min(CONSERVACION.mesesMinimos).max(CONSERVACION.mesesMaximos).nullable(),
      }).parse(request.body);
      request.requirePermission('settings:org', null);
      const repo = new OrganizationRepository(ctx.tenant.organizationId);
      const antes = (await repo.privacySettings()).monthsAfterArchive;
      await repo.setPrivacyMonths(monthsAfterArchive);
      await new AuditService().record(ctx, {
        action: 'settings.privacy.update', resourceType: 'Organization', resourceId: ctx.tenant.organizationId,
        beforeState: { monthsAfterArchive: antes, effectiveMonths: mesesDeConservacion(antes) },
        afterState: { monthsAfterArchive, effectiveMonths: mesesDeConservacion(monthsAfterArchive) },
      });
      return { monthsAfterArchive, effectiveMonths: mesesDeConservacion(monthsAfterArchive) };
    },
  });

  /**
   * Exsocios que ya cumplieron el plazo que el gimnasio FIJÓ (PS-08): se
   * proponen para anonimizarlos uno por uno desde su ficha. Desde D-32 la
   * pantalla usa `GET /privacy/conservation` (la lista mensual, con el plazo
   * por omisión); esta ruta se conserva tal cual para quien todavía la lea.
   */
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
