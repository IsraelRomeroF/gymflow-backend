import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { REVOCABLES_EN_RECEPCION, forbidden, notFound } from '@gymflow/core';
import { MemberConsentText, MemberConsents } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { ConsentRepository } from './consent.repository.js';
import { firmarConsentimiento, retirarConsentimiento } from './consent.service.js';
import { registerConsentDocumentRoutes } from './consent-documents.routes.js';
import { registerNoticeSignatureRoutes } from './aviso-firma.routes.js';
import { ConsentDocumentRepository } from './consent-document.repository.js';
import { MemberRepository } from './member.repository.js';
import { firmaBiometricaPorRenovarDe, firmasBiometricasPorRenovar, renovarFirmaBiometrica } from './biometric-renewal.js';
import { consentSchema, idParam } from './members.serializers.js';

/** Los consentimientos del socio: consultar, firmar, retirar y volver a firmar el biométrico. */
export function registerConsentRoutes(app: FastifyInstance): void {
  // Los textos (revisar, corregir y borrar borradores) van con sus firmas.
  registerConsentDocumentRoutes(app);
  // La firma de la dueña en el aviso de privacidad (3.7, D-25).
  registerNoticeSignatureRoutes(app);

  // ── Consentimientos ───────────────────────────────────────────────────────
  /**
   * Retirar un permiso (PS-07; 21-10, 21-11): la ley lo permite en cualquier
   * momento y aquí queda la fecha. Es el MISMO acto que desde el portal, con
   * los mismos efectos: salud borra la nota, el cargo recurrente apaga las
   * tarjetas y la biometría revoca el rostro y borra la plantilla. Se retira
   * el permiso entero (todas sus firmas vivas), no una firma suelta. Lo
   * obligatorio (aviso, reglamento) solo se retira con la baja.
   */
  route(app, {
    method: 'POST',
    url: '/members/:id/consents/:cid/revoke',
    security: { kind: 'permission', permission: 'members:update' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id, cid } = z.object({ id: z.string().uuid(), cid: z.string().uuid() }).parse(request.params);
      const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(request.body);
      const member = await new MemberRepository(ctx.tenant.organizationId).findById(id);
      if (!member) throw notFound('Socio no encontrado');
      request.requirePermission('members:update', member.homeBranchId);
      const r = await retirarConsentimiento(ctx, { memberId: id, consentId: cid, motivo: reason, via: 'ficha', permitidos: REVOCABLES_EN_RECEPCION });
      return { ok: true, consentType: r.consentType, revoked: r.consentIds.length, effects: r.efectos };
    },
  });

  route(app, {
    method: 'GET',
    url: '/members/:id/consents',
    security: { kind: 'permission', permission: 'members:consent:read' },
    schema: respuesta(200, MemberConsents),
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const member = await new MemberRepository(ctx.tenant.organizationId).findById(id);
      if (!member) throw notFound('Socio no encontrado');
      // Quien firmó un texto biométrico anterior al vigente (6-03, 21-09) lo
      // ve marcado: la ficha lo dice y recepción le toma la firma nueva.
      const consents = new ConsentRepository(ctx.tenant.organizationId);
      const [firmas, porRenovar, conTexto] = await Promise.all([
        consents.listForMember(id),
        firmasBiometricasPorRenovar(ctx.tenant.organizationId, id),
        consents.idsConTexto(id),
      ]);
      const vigentePorFirma = new Map(porRenovar.map((p) => [p.consentId, p.currentVersion]));
      return firmas.map((c) => ({
        id: c.id, consentType: c.consentType, documentVersion: c.documentVersion, granted: c.granted,
        grantedAt: c.grantedAt.toISOString(), revokedAt: c.revokedAt ? c.revokedAt.toISOString() : null,
        channel: c.channel, ip: c.ip, evidenceHash: c.evidenceHash,
        needsResign: vigentePorFirma.has(c.id), currentVersion: vigentePorFirma.get(c.id) ?? null,
        hasText: conTexto.has(c.id),
      }));
    },
  });

  /** El texto exacto que firmó (3-21): lo que recepción le enseña al socio ante un reclamo. */
  route(app, {
    method: 'GET',
    url: '/members/:id/consents/:cid',
    security: { kind: 'permission', permission: 'members:consent:read' },
    schema: respuesta(200, MemberConsentText),
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id, cid } = z.object({ id: z.string().uuid(), cid: z.string().uuid() }).parse(request.params);
      const member = await new MemberRepository(ctx.tenant.organizationId).findByIdIncludingArchived(id);
      if (!member) throw notFound('Socio no encontrado');
      request.requirePermission('members:consent:read', member.homeBranchId);
      const c = await new ConsentRepository(ctx.tenant.organizationId).findWithText(id, cid);
      if (!c) throw notFound('Consentimiento no encontrado');
      return {
        id: c.id, consentType: c.consentType, documentVersion: c.documentVersion, grantedAt: c.grantedAt.toISOString(),
        documentText: c.documentText, evidenceHash: c.evidenceHash,
      };
    },
  });

  /**
   * Volver a firmar el texto biométrico VIGENTE (6-03, 21-09). Lo hace quien
   * registra rostros en una de las sucursales donde el socio tiene el suyo:
   * es la misma firma que al enrolar, sin volver a capturar. El texto lo pone
   * el servidor. No bloquea la entrada de nadie (eso es D-06, fase 3).
   */
  route(app, {
    method: 'POST',
    url: '/members/:id/consents/renew-biometric',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'access:biometric:enroll' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      // La versión que se le mostró: el TEXTO lo sigue poniendo el servidor (PS-06).
      const { documentVersion } = z.object({ documentVersion: z.string().min(1).max(40).optional() }).parse(request.body ?? {});
      const member = await new MemberRepository(ctx.tenant.organizationId).findById(id);
      if (!member) throw notFound('Socio no encontrado');
      const porRenovar = await firmaBiometricaPorRenovarDe(ctx.tenant.organizationId, id);
      const sede = [...porRenovar.branchIds, member.homeBranchId].find((b): b is string => !!b && request.holds('access:biometric:enroll', b));
      if (!sede) throw forbidden('La firma la toma quien registra rostros en la sucursal donde el socio tiene el suyo');
      request.authorize('access:biometric:enroll', { branchId: sede, reason: 'Firma del texto biométrico vigente' });
      const r = await renovarFirmaBiometrica(ctx, porRenovar, sede, documentVersion);
      return reply.status(201).send({ ...r.consent, previousVersion: r.previousVersion });
    },
  });

  /**
   * Quién tiene rostro o huella con una firma de un texto biométrico anterior
   * al vigente: lo que falta por volver a firmar (6-03, 21-09). Lo consulta la
   * pantalla Biometría; sin texto publicado, nadie.
   */
  route(app, {
    method: 'GET',
    url: '/members/biometric-renewals',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'members:consent:read', anyOf: ['audit:read'] },
    handler: async (request) => {
      const ctx = request.ctx!;
      // Con la bitácora (dueño y gerencia) se ve todo el gimnasio; con solo
      // consentimientos, las sedes de quien consulta.
      const alcance = request.holds('audit:read', null) ? null : request.branchScope('members:consent:read');
      const vigente = await new ConsentDocumentRepository(ctx.tenant.organizationId).findPublished('BIOMETRIC');
      const lista = (await firmasBiometricasPorRenovar(ctx.tenant.organizationId))
        .filter((p) => alcance === null || p.branchIds.some((b) => alcance.includes(b)) || (!!p.member.homeBranchId && alcance.includes(p.member.homeBranchId)));
      return {
        currentVersion: vigente?.version ?? null,
        members: lista.map((p) => ({
          memberId: p.memberId, memberCode: p.member.memberCode, fullName: `${p.member.firstName} ${p.member.lastName}`.trim(),
          homeBranchId: p.member.homeBranchId, branchIds: p.branchIds,
          signedVersion: p.signedVersion, signedAt: p.signedAt.toISOString(),
        })),
      };
    },
  });

  /**
   * Firmar un texto en el mostrador (21-06). El servidor toma la versión
   * VIGENTE y su texto; `documentVersion`, si viene, es la que el socio leyó:
   * si ya no es la vigente no se firma otra en su lugar (409). Sin texto
   * publicado, 409.
   */
  route(app, {
    method: 'POST',
    url: '/members/:id/consents',
    security: { kind: 'permission', permission: 'members:update' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = consentSchema.extend({ documentVersion: z.string().min(1).max(40).optional() }).parse(request.body);

      const member = await new MemberRepository(ctx.tenant.organizationId).findById(id);
      if (!member) throw notFound('Socio no encontrado');
      request.requirePermission('members:update', member.homeBranchId);

      const consent = await firmarConsentimiento(ctx, {
        memberId: id, branchId: member.homeBranchId, consentType: body.consentType, granted: body.granted,
        channel: 'ASSISTED', versionLeida: body.documentVersion,
      });
      return reply.status(201).send(consent);
    },
  });
}
