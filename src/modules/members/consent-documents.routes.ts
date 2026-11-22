import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConsentDocumentReview } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { borrarBorrador, corregirBorrador, revisionDeTexto } from './consent-document.service.js';
import { idParam } from './members.serializers.js';

/**
 * Textos de consentimiento: revisar antes de publicar y cuidar los borradores
 * (auditoría 8, bloque 1.10; 21-07, 21-08). Listar, crear, publicar y retirar
 * siguen en `intake/intake.routes.ts`, con sus URL de siempre.
 */
export function registerConsentDocumentRoutes(app: FastifyInstance): void {
  /** «Revisar y publicar»: el texto, el vigente que reemplazaría, los corchetes y la lista de verificación. */
  route(app, {
    method: 'GET',
    url: '/consent-documents/:id/review',
    module: 'core',
    security: { kind: 'permission', permission: 'members:consent:read' },
    schema: respuesta(200, ConsentDocumentReview),
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      return revisionDeTexto(request.ctx!.tenant.organizationId, id);
    },
  });

  /** Corregir un borrador. Lo publicado no se edita: se reemplaza con otra versión. */
  route(app, {
    method: 'PATCH',
    url: '/consent-documents/:id',
    module: 'core',
    security: { kind: 'permission', permission: 'settings:consent:manage' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({
        version: z.string().trim().min(1).max(40).optional(),
        title: z.string().trim().min(3).max(200).optional(),
        bodyText: z.string().min(20).max(60_000).optional(),
      }).refine((b) => Object.keys(b).length > 0, 'No hay nada que cambiar').parse(request.body);
      request.requirePermission('settings:consent:manage', null);
      const doc = await corregirBorrador(request.ctx!, id, body);
      return { id: doc.id, status: doc.status, version: doc.version, title: doc.title };
    },
  });

  /** Borrar un borrador que nadie va a publicar. */
  route(app, {
    method: 'DELETE',
    url: '/consent-documents/:id',
    module: 'core',
    security: { kind: 'permission', permission: 'settings:consent:manage' },
    handler: async (request, reply) => {
      const { id } = idParam.parse(request.params);
      request.requirePermission('settings:consent:manage', null);
      await borrarBorrador(request.ctx!, id);
      return reply.status(204).send();
    },
  });
}
