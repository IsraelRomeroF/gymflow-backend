import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, validation } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { MemberRepository } from './member.repository.js';
import { idParam } from './members.serializers.js';

/** El coach de cada socio (2026-10-09): quién puede ser y quién es. */
export function registerCoachRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  /**
   * Los coaches del gimnasio, para elegir el de un socio. Lo ve quien inscribe
   * (gerencia y recepción).
   */
  route(app, {
    method: 'GET',
    url: '/members/coaches',
    security: { kind: 'permission', permission: 'members:create' },
    handler: async (request) => {
      const { StaffRepository } = await import('../identity/index.js');
      const gente = await new StaffRepository(request.ctx!.tenant.organizationId).list();
      return {
        coaches: gente.filter((u) => u.isActive && u.assignments.some((a) => a.roleKey === 'COACH'))
          .map((u) => ({ id: u.id, fullName: u.fullName, branchIds: u.assignments.map((a) => a.branchId).filter((b): b is string => !!b) })),
      };
    },
  });

  /**
   * COACH ASIGNADO (2026-10-09): el coach ve solo a sus socios. Lo asigna
   * quien inscribe (gerencia o recepción) desde la ficha; null lo quita y
   * entonces cuenta quien le asignó la rutina vigente.
   */
  route(app, {
    method: 'PUT',
    url: '/members/:id/coach',
    security: { kind: 'permission', permission: 'members:create' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({ coachUserId: z.string().uuid().nullable() }).parse(request.body);
      const repo = new MemberRepository(ctx.tenant.organizationId);
      const member = await repo.findById(id);
      if (!member) throw notFound('Socio no encontrado');
      request.authorize('members:create', { branchId: member.homeBranchId });
      if (body.coachUserId) {
        const { StaffRepository } = await import('../identity/index.js');
        const coach = await new StaffRepository(ctx.tenant.organizationId).find(body.coachUserId);
        if (!coach || !coach.isActive || !coach.assignments.some((a) => a.roleKey === 'COACH')) throw validation('Esa persona no es coach activo del gimnasio');
      }
      const antes = await repo.coachOf(id);
      await repo.setCoach(id, body.coachUserId);
      await audit.record(ctx, { action: 'member.coach', resourceType: 'Member', resourceId: id, beforeState: { coachUserId: antes }, afterState: { coachUserId: body.coachUserId } });
      return { coachUserId: body.coachUserId };
    },
  });
}
