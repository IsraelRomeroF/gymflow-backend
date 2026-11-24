import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '@gymflow/core';
import { CoachOptions, MemberCoachSet } from '@gymflow/core/contracts';
import { respuesta } from '../../platform/http/respuesta.js';
import { exigirCoachActivo } from './coach-valido.js';
import { route } from '../../platform/http/registry.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { MemberRepository } from './member.repository.js';
import { idParam } from './members.serializers.js';

/** El coach de cada socio (2026-10-09): quién puede ser y quién es. */
export function registerCoachRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  /**
   * Los coaches del gimnasio, para elegir el de un socio. Lo ve quien inscribe
   * (gerencia y recepción): recepción lo elige al dar de alta (D-29).
   */
  route(app, {
    method: 'GET',
    url: '/members/coaches',
    security: { kind: 'permission', permission: 'members:create' },
    schema: respuesta(200, CoachOptions),
    handler: async (request): Promise<CoachOptions> => {
      const { StaffRepository } = await import('../identity/index.js');
      const gente = await new StaffRepository(request.ctx!.tenant.organizationId).list();
      return {
        coaches: gente.filter((u) => u.isActive && u.assignments.some((a) => a.roleKey === 'COACH'))
          .map((u) => ({ id: u.id, fullName: u.fullName, branchIds: u.assignments.map((a) => a.branchId).filter((b): b is string => !!b) })),
      };
    },
  });

  /**
   * EL COACH DE UN SOCIO (2026-10-09; D-29, fase 3). Recepción lo elige AL
   * ALTA (`POST /members`, o al aprobar un alta digital). Después lo pone, lo
   * cambia o lo quita (`null`) solo la gerencia: pasar socios de un coach a
   * otro es reasignar clientes. El coach se suma a un socio sin coach con el
   * código que el socio le dicta (`POST /coach/claim`).
   */
  route(app, {
    method: 'PUT',
    url: '/members/:id/coach',
    security: { kind: 'permission', permission: 'members:coach:assign' },
    schema: respuesta(200, MemberCoachSet),
    handler: async (request): Promise<MemberCoachSet> => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({ coachUserId: z.string().uuid().nullable() }).parse(request.body);
      const repo = new MemberRepository(ctx.tenant.organizationId);
      const member = await repo.findById(id);
      if (!member) throw notFound('Socio no encontrado');
      request.authorize('members:coach:assign', { branchId: member.homeBranchId });
      if (body.coachUserId) await exigirCoachActivo(ctx.tenant.organizationId, body.coachUserId);
      const antes = await repo.coachOf(id);
      await repo.setCoach(id, body.coachUserId);
      await audit.record(ctx, { action: 'member.coach', resourceType: 'Member', resourceId: id, branchId: member.homeBranchId, beforeState: { coachUserId: antes }, afterState: { coachUserId: body.coachUserId } });
      return { coachUserId: body.coachUserId };
    },
  });
}
