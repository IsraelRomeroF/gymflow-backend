import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { REVOCABLES_POR_EL_SOCIO, SOLICITUDES_DESDE_EL_PORTAL, validation, type ConsentType, type TipoDeSolicitudArco } from '@gymflow/core';
import { CONSENT_TYPES, MemberPrivacyRequests, PortalConsents, PrivacyRequest } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { ConsentRepository, firmasBiometricasPorRenovar, retirarConsentimiento } from '../members/index.js';
import { requireMemberSession } from '../portal/index.js';
import { PrivacyService } from './privacy.service.js';
import { PrivacyRequestsService } from './privacy-requests.service.js';
import { PrivacyRequestRepository } from './privacy-request.repository.js';
import { ctxDeSocio, respuesta, serializarSolicitud } from './privacy.serializers.js';

/** El socio, desde su teléfono: descargar sus datos, ver y retirar permisos, pedir algo y ver qué pasó con lo que pidió. */
export function registerPortalPrivacyRoutes(app: FastifyInstance): void {
  const service = new PrivacyService();
  const solicitudes = new PrivacyRequestsService();

  /** ARCO · acceso, el titular desde su teléfono: sin pedírselo a nadie. */
  route(app, {
    method: 'GET',
    url: '/portal/me/export',
    security: { kind: 'member' },
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    handler: async (request, reply) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const datos = await service.export(ctxDeSocio(request, organizationId), memberId, 'self');
      return reply.header('content-disposition', 'attachment; filename="mis-datos.json"').send(datos);
    },
  });

  // ── El socio, desde su teléfono (PS-07) ──────────────────────────────────

  /** Lo que firmó y qué puede retirar él mismo. */
  route(app, {
    method: 'GET',
    url: '/portal/consents',
    security: { kind: 'member' },
    schema: respuesta(200, PortalConsents),
    handler: async (request) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const [consents, porRenovar] = await Promise.all([
        new ConsentRepository(organizationId).listForMember(memberId),
        firmasBiometricasPorRenovar(organizationId, memberId),
      ]);
      const vigentePorFirma = new Map(porRenovar.map((p) => [p.consentId, p.currentVersion]));
      return {
        consents: consents.map((c) => ({
          id: c.id, consentType: c.consentType, documentVersion: c.documentVersion, granted: c.granted,
          grantedAt: c.grantedAt.toISOString(), revokedAt: c.revokedAt ? c.revokedAt.toISOString() : null,
          /** Lo obligatorio (aviso, reglamento) no se retira sin dejar de ser socio, y la biometría se quita en recepción. */
          revocable: REVOCABLES_POR_EL_SOCIO.includes(c.consentType as ConsentType) && c.granted && !c.revokedAt,
          /** Firmó un texto biométrico anterior al vigente: lo vuelve a firmar en recepción (6-03, 21-09). */
          needsResign: vigentePorFirma.has(c.id),
          currentVersion: vigentePorFirma.get(c.id) ?? null,
        })),
      };
    },
  });

  /**
   * Retirar un permiso opcional. El mismo servicio que usa la ficha, con los
   * mismos efectos (21-11): salud borra la nota y el cargo recurrente deja
   * todas las tarjetas sin cobrar solas.
   */
  route(app, {
    method: 'POST',
    url: '/portal/consents/:type/revoke',
    security: { kind: 'member' },
    handler: async (request) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const { type } = z.object({ type: z.string().min(2).max(40) }).parse(request.params);
      if (!(CONSENT_TYPES as readonly string[]).includes(type) || !REVOCABLES_POR_EL_SOCIO.includes(type as ConsentType)) {
        throw validation('Ese permiso se retira en recepción: implica quitar tu rostro o dejar de ser socio.');
      }
      await retirarConsentimiento(ctxDeSocio(request, organizationId), {
        memberId, consentType: type as ConsentType, motivo: 'Lo retiró el socio desde su teléfono', via: 'portal', permitidos: REVOCABLES_POR_EL_SOCIO,
      });
      return { ok: true };
    },
  });

  /** Lo que pidió y qué pasó con ello (21-02): estado, hasta cuándo le responden y la respuesta. */
  route(app, {
    method: 'GET',
    url: '/portal/privacy-requests',
    security: { kind: 'member' },
    schema: respuesta(200, MemberPrivacyRequests),
    handler: async (request) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      return { requests: (await new PrivacyRequestRepository(organizationId).forMember(memberId)).map((r) => serializarSolicitud(r)) };
    },
  });

  /**
   * Pedir algo: una copia completa, corregir, borrar o que no usen sus datos
   * para algo. Nace con fecha y con la identidad acreditada por su sesión, sin
   * que nadie en recepción la teclee.
   */
  route(app, {
    method: 'POST',
    url: '/portal/privacy-requests',
    security: { kind: 'member' },
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    schema: respuesta(201, PrivacyRequest),
    handler: async (request, reply) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const body = z.object({
        kind: z.enum(SOLICITUDES_DESDE_EL_PORTAL as [TipoDeSolicitudArco, ...TipoDeSolicitudArco[]]),
        note: z.string().trim().min(3).max(500),
        consentType: z.enum(CONSENT_TYPES).optional(),
      }).parse(request.body);
      const r = await solicitudes.abrir(ctxDeSocio(request, organizationId), memberId, { kind: body.kind, channel: 'PORTAL', note: body.note, consentType: body.consentType });
      return reply.status(201).send(serializarSolicitud(r));
    },
  });
}
