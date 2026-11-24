import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PrivacyBatchSigned, PrivacyConservation } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { ConservacionService } from './conservacion.service.js';
import { respuesta } from './privacy.serializers.js';

/**
 * CONSERVACIÓN (D-32; bloque 3.9): los plazos, los rostros de exsocios que
 * siguen guardados y la lista mensual de exsocios por anonimizar.
 *
 * La lista es de TODO el gimnasio (un exsocio ya no es de una sede): la ven
 * la gerencia, que puede sacar a alguien con motivo, y quien da la segunda
 * firma (el dueño), que la firma UNA vez con su contraseña. Sin esa firma no
 * se anonimiza a nadie de la lista; eso lo cuida también la base.
 */
export function registerConservationRoutes(app: FastifyInstance): void {
  const service = new ConservacionService();

  route(app, {
    method: 'GET',
    url: '/privacy/conservation',
    security: { kind: 'permission', permission: 'members:anonymize', anyOf: ['approvals:grant'] },
    schema: respuesta(200, PrivacyConservation),
    handler: async (request) => {
      const firma = request.holds('approvals:grant', null);
      const gestiona = request.holds('members:anonymize', null);
      if (!firma) request.requirePermission('members:anonymize', null);
      return service.estado(request.ctx!.tenant.organizationId, { firmar: firma, sacar: gestiona });
    },
  });

  /**
   * La firma de la lista. No es maker-checker entre dos personas: la lista la
   * arma el sistema y la firma quien tiene la segunda firma, con su sesión y
   * su contraseña (la misma escalera de fallos de las demás firmas).
   */
  route(app, {
    method: 'POST',
    url: '/privacy/conservation/sign',
    security: { kind: 'permission', permission: 'approvals:grant' },
    schema: respuesta(200, PrivacyBatchSigned),
    handler: async (request) => {
      const { batchId, password } = z.object({ batchId: z.string().uuid(), password: z.string().min(1).max(200) }).parse(request.body);
      request.requirePermission('approvals:grant', null);
      return { batch: await service.firmar(request.ctx!, batchId, password) };
    },
  });

  /** La gerencia saca a un exsocio de la lista en espera (tiene un adeudo, una reclamación…). No lo anonimiza ni lo reactiva. */
  route(app, {
    method: 'POST',
    url: '/privacy/conservation/exclude',
    security: { kind: 'permission', permission: 'members:anonymize' },
    handler: async (request, reply) => {
      const { batchId, memberId, reason } = z.object({
        batchId: z.string().uuid(), memberId: z.string().uuid(), reason: z.string().trim().min(3).max(300),
      }).parse(request.body);
      // Sacar de la lista NO anonimiza: por eso no pide la segunda firma que `members:anonymize` exige al anonimizar.
      request.requirePermission('members:anonymize', null);
      await service.sacar(request.ctx!, batchId, memberId, reason);
      return reply.status(204).send();
    },
  });
}
