import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CANALES_DE_SOLICITUD_ARCO, RESULTADOS_DE_SOLICITUD_ARCO, TIPOS_DE_SOLICITUD_ARCO, notFound } from '@gymflow/core';
import { CONSENT_TYPES, MemberPrivacyRequests, PrivacyInbox, PrivacyRequest, PrivacyRequestReceipt, PrivacyRequestsSummary } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { MemberRepository } from '../members/index.js';
import { PrivacyRequestsService } from './privacy-requests.service.js';
import { PrivacyRequestRepository } from './privacy-request.repository.js';
import { idParam, respuesta, serializarSolicitud } from './privacy.serializers.js';

/**
 * Solicitudes ARCO (PS-07; ciclo completo en la auditoría 8, bloque 1.10): la
 * bandeja y sus cifras, las del socio, registrar, acreditar la identidad,
 * responder (procede o no procede), marcar hecha y la constancia.
 */
export function registerRequestRoutes(app: FastifyInstance): void {
  const service = new PrivacyRequestsService();

  /** La bandeja de cumplimiento: lo vivo (por acreditar, por responder y por hacer efectivo), primero lo que vence antes. */
  route(app, {
    method: 'GET',
    url: '/privacy/requests',
    security: { kind: 'permission', permission: 'members:consent:read' },
    schema: respuesta(200, PrivacyInbox),
    handler: async (request) => {
      const ctx = request.ctx!;
      request.requirePermission('members:consent:read', null);
      const filas = await service.bandeja(ctx.tenant.organizationId);
      return { requests: filas.map((r) => ({ ...serializarSolicitud(r), member: { fullName: `${r.member.firstName} ${r.member.lastName}`.trim(), memberCode: r.member.memberCode, homeBranchId: r.member.homeBranchId } })) };
    },
  });

  /**
   * Las cifras, sin nombres (21-01; D-25): cuántas hay vivas, cuántas vencidas
   * y cuál es el plazo más próximo. Para la tarjeta de Inicio de la gerencia y
   * para la dueña, que consulta con la bitácora y no ve expedientes.
   */
  route(app, {
    method: 'GET',
    url: '/privacy/requests/summary',
    security: { kind: 'permission', permission: 'members:consent:read', anyOf: ['audit:read'] },
    schema: respuesta(200, PrivacyRequestsSummary),
    handler: async (request) => {
      // Las cifras son de todo el gimnasio: las ve quien abarca todo el gimnasio.
      if (!request.holds('audit:read', null)) request.requirePermission('members:consent:read', null);
      return service.resumen(request.ctx!.tenant.organizationId);
    },
  });

  route(app, {
    method: 'GET',
    url: '/members/:id/privacy-requests',
    security: { kind: 'permission', permission: 'members:consent:read' },
    schema: respuesta(200, MemberPrivacyRequests),
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const m = await new MemberRepository(ctx.tenant.organizationId).findByIdIncludingArchived(id);
      if (!m) throw notFound('Socio no encontrado');
      request.requirePermission('members:consent:read', m.homeBranchId);
      return { requests: (await new PrivacyRequestRepository(ctx.tenant.organizationId).forMember(id)).map((r) => serializarSolicitud(r)) };
    },
  });

  /**
   * Registrar lo que el socio pide. Lo hace también recepción (21-04): es
   * atender, no modificar, y es lo que hace correr el plazo. En el mostrador
   * exige confirmar que se verificó su identidad; por correo o por escrito
   * puede quedar «falta acreditar identidad».
   */
  route(app, {
    method: 'POST',
    url: '/members/:id/privacy-requests',
    security: { kind: 'permission', permission: 'members:privacy:request' },
    schema: respuesta(201, PrivacyRequest),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        kind: z.enum(TIPOS_DE_SOLICITUD_ARCO),
        // Desde el teléfono las registra el socio (`POST /portal/privacy-requests`), no el personal.
        channel: z.enum(CANALES_DE_SOLICITUD_ARCO).exclude(['PORTAL']).default('FRONT_DESK'),
        note: z.string().trim().max(500).optional(),
        consentType: z.enum(CONSENT_TYPES).optional(),
        identityVerified: z.boolean().optional(),
        identityNote: z.string().trim().min(2).max(120).optional(),
      }).parse(request.body);
      const m = await new MemberRepository(ctx.tenant.organizationId).findByIdIncludingArchived(id);
      if (!m) throw notFound('Socio no encontrado');
      request.requirePermission('members:privacy:request', m.homeBranchId);
      const r = await service.abrir(ctx, id, {
        kind: body.kind, channel: body.channel, note: body.note || null, consentType: body.consentType,
        identityVerified: body.identityVerified, identityNote: body.identityNote,
      });
      return reply.status(201).send(serializarSolicitud(r));
    },
  });

  /** Acreditar que la pide el titular (INE, en persona): desde aquí corre el plazo. */
  route(app, {
    method: 'POST',
    url: '/privacy/requests/:id/identity',
    security: { kind: 'permission', permission: 'members:privacy:request' },
    schema: respuesta(200, PrivacyRequest),
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const { note } = z.object({ note: z.string().trim().min(2).max(120) }).parse(request.body);
      const sede = await sedeDeLaSolicitud(ctx.tenant.organizationId, id);
      request.requirePermission('members:privacy:request', sede);
      return serializarSolicitud(await service.acreditarIdentidad(ctx, id, note));
    },
  });

  /**
   * Responder: «procede» o «no procede», con lo que leerá el socio. Si lo que
   * pide es retirar un permiso, se retira en este mismo acto.
   */
  route(app, {
    method: 'POST',
    url: '/privacy/requests/:id/resolve',
    security: { kind: 'permission', permission: 'members:update' },
    schema: respuesta(200, PrivacyRequest),
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        outcome: z.enum(RESULTADOS_DE_SOLICITUD_ARCO),
        resolution: z.string().trim().min(3).max(500),
        consentType: z.enum(CONSENT_TYPES).optional(),
      }).parse(request.body);
      const sede = await sedeDeLaSolicitud(ctx.tenant.organizationId, id);
      request.requirePermission('members:update', sede);
      return serializarSolicitud(await service.resolver(ctx, id, body));
    },
  });

  /** «Ya quedó hecho»: lo que procede se hizo efectivo dentro del segundo plazo. */
  route(app, {
    method: 'POST',
    url: '/privacy/requests/:id/effect',
    security: { kind: 'permission', permission: 'members:update' },
    schema: respuesta(200, PrivacyRequest),
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const { note } = z.object({ note: z.string().trim().min(3).max(500) }).parse(request.body);
      const sede = await sedeDeLaSolicitud(ctx.tenant.organizationId, id);
      request.requirePermission('members:update', sede);
      return serializarSolicitud(await service.hacerEfectiva(ctx, id, note));
    },
  });

  /** La constancia para imprimir o dictar: folio, qué pidió, cuándo entró y hasta cuándo se responde. */
  route(app, {
    method: 'GET',
    url: '/privacy/requests/:id/receipt',
    security: { kind: 'permission', permission: 'members:consent:read' },
    schema: respuesta(200, PrivacyRequestReceipt),
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const c = await service.constancia(ctx.tenant.organizationId, id);
      request.requirePermission('members:consent:read', c.socio.homeBranchId);
      const solicitud = serializarSolicitud(c.solicitud);
      return {
        folio: solicitud.folio, gym: c.gym,
        member: { fullName: `${c.socio.firstName} ${c.socio.lastName}`.trim(), memberCode: c.socio.memberCode },
        request: solicitud, deadlines: c.deadlines, issuedAt: new Date().toISOString(),
      };
    },
  });
}

/** La sede de casa del socio de una solicitud; 404 si la solicitud no es de este gimnasio. */
async function sedeDeLaSolicitud(organizationId: string, id: string): Promise<string | null> {
  const r = await new PrivacyRequestRepository(organizationId).findById(id);
  if (!r) throw notFound('Solicitud no encontrada');
  const m = await new MemberRepository(organizationId).findByIdIncludingArchived(r.memberId);
  return m?.homeBranchId ?? null;
}
