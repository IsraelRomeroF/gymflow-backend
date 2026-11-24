import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError } from '@gymflow/core';
import { ConsentDocumentPublishResult, NoticeSignatureRequests } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { ApprovalService } from '../approvals/index.js';
import { AuthUserRepository } from '../identity/index.js';
import { firmarAviso, noFirmarAviso, solicitudVigente, solicitudesDeFirma } from './aviso-firma.js';

const idParam = z.object({ id: z.string().uuid() });

/**
 * La firma de la dueña en el aviso de privacidad (fase 3, bloque 3.7 · D-25).
 * Ver `aviso-firma.ts`. Firma quien tiene la segunda firma de todo el gimnasio
 * (`approvals:grant`): la dueña, con su contraseña y la escalera de fallos de
 * las firmas (24-11).
 */
export function registerNoticeSignatureRoutes(app: FastifyInstance): void {
  /** Lo que espera firma y lo que no se firmó. Lo ve quien lee los textos. */
  route(app, {
    method: 'GET',
    url: '/consent-documents/signature-requests',
    module: 'core',
    security: { kind: 'permission', permission: 'members:consent:read', anyOf: ['settings:consent:read'] },
    schema: respuesta(200, NoticeSignatureRequests),
    handler: async (request): Promise<NoticeSignatureRequests> => ({
      requests: await solicitudesDeFirma(request.ctx!.tenant.organizationId),
      canSign: request.holds('approvals:grant', null),
    }),
  });

  route(app, {
    method: 'POST',
    url: '/consent-documents/:id/sign',
    module: 'core',
    security: { kind: 'permission', permission: 'approvals:grant' },
    schema: respuesta(200, ConsentDocumentPublishResult),
    handler: async (request): Promise<ConsentDocumentPublishResult> => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const { password } = z.object({ password: z.string().min(1).max(200) }).parse(request.body);
      // El aviso es de todo el gimnasio: lo firma quien firma por todo el gimnasio.
      request.requirePermission('approvals:grant', null);
      // Antes de mirar la contraseña: que el texto exista aquí y tenga una firma pedida.
      await solicitudVigente(ctx.tenant.organizationId, id);
      const yo = await new AuthUserRepository().findById(ctx.tenant.actorUserId!);
      if (!yo || !yo.isActive) throw new DomainError('UNAUTHENTICATED', 'Tu cuenta ya no está activa');
      await new ApprovalService().comprobarContrasena(ctx, yo, password, { branchId: null }, { canal: 'telefono', asentarFallo: async () => undefined });
      const doc = await firmarAviso(ctx, id);
      return { ok: true, status: doc.status as ConsentDocumentPublishResult['status'], publishedAt: doc.publishedAt?.toISOString() ?? null, awaitingSignature: false };
    },
  });

  route(app, {
    method: 'POST',
    url: '/consent-documents/:id/sign/reject',
    module: 'core',
    security: { kind: 'permission', permission: 'approvals:grant' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(request.body);
      request.requirePermission('approvals:grant', null);
      await noFirmarAviso(request.ctx!, id, reason);
      return { ok: true };
    },
  });
}
