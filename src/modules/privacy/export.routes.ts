import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { route } from '../../platform/http/registry.js';
import { PrivacyService } from './privacy.service.js';
import { PrivacyRequestsService } from './privacy-requests.service.js';
import { idParam, sedeDe } from './privacy.serializers.js';

/** ARCO · acceso: la gerencia entrega al socio todo lo que el gimnasio guarda de él. */
export function registerExportRoutes(app: FastifyInstance): void {
  const service = new PrivacyService();

  /** ARCO · acceso, a petición del socio ante la gerencia. */
  route(app, {
    method: 'GET',
    url: '/members/:id/export',
    security: { kind: 'permission', permission: 'members:export' },
    handler: async (request, reply) => {
      const { id } = idParam.parse(request.params);
      // `requestId`: la solicitud de acceso que esta descarga atiende; queda hecha al entregarla (1.10, 21-03).
      const { reason, requestId } = z.object({ reason: z.string().min(3).max(300), requestId: z.string().uuid().optional() }).parse(request.query);
      const sede = await sedeDe(request.ctx!.tenant.organizationId, id);
      request.authorize('members:export', { branchId: sede, reason });
      // La salud va solo si quien exporta puede leerla en esa sede.
      const datos = await service.export(request.ctx!, id, 'staff', request.holds('members:health:read', sede));
      if (requestId) await new PrivacyRequestsService().alHacerse(request.ctx!, id, 'ACCESS', 'Se descargaron sus datos para entregárselos', requestId);
      return reply.header('content-disposition', `attachment; filename="datos-socio-${id}.json"`).send(datos);
    },
  });
}
