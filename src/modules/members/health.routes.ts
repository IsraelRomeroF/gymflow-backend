import type { FastifyInstance } from 'fastify';
import { notFound } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { MemberRepository } from './member.repository.js';
import { idParam } from './members.serializers.js';

/** La nota de salud del socio: un dato sensible, con su propio permiso y su rastro. */
export function registerHealthRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  /**
   * Notas de salud: aparte y con su propio permiso. Recepción no las ve; el
   * coach y gerencia sí, porque son quienes tienen que actuar sobre ellas.
   */
  route(app, {
    method: 'GET',
    url: '/members/:id/health',
    security: { kind: 'permission', permission: 'members:health:read' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const repo = new MemberRepository(request.ctx!.tenant.organizationId);
      const socio = await repo.findById(id);
      if (!socio) throw notFound('Socio no encontrado');
      // Dato sensible: solo con autoridad sobre la sede de casa del socio.
      request.requirePermission('members:health:read', socio.homeBranchId);
      const notes = await repo.healthNotes(id);
      if (notes === undefined) throw notFound('Socio no encontrado');
      // Quién leyó un dato sensible y cuándo (SEC-08): sin esto, ante una
      // queja del socio no hay forma de saber quién vio su expediente.
      if (notes) {
        await audit.record(request.ctx!, {
          action: 'health.read', resourceType: 'Member', resourceId: id, branchId: socio.homeBranchId,
        });
      }
      return { healthNotes: notes };
    },
  });
}
