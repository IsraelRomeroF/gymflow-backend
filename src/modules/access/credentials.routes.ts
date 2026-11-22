import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { MemberRepository } from '../members/index.js';
import { CredentialRepository } from './credential.repository.js';
import { CredentialService } from './credential.service.js';
import { idParam } from './access.serializers.js';
import type { Env } from '../../platform/env.js';

/** Credenciales del socio (tarjeta y PIN): emitir, consultar y revocar. */
export function registerCredentialRoutes(app: FastifyInstance, env: Env): void {
  const credentials = new CredentialService();

  // ── Credenciales ──────────────────────────────────────────────────────────
  route(app, {
    method: 'POST',
    url: '/members/:id/credentials',
    security: { kind: 'permission', permission: 'access:credential:manage' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        kind: z.enum(['RFID', 'PIN']),
        rfidCardId: z.string().min(4).max(64).optional(),
        pin: z.string().optional(),
      }).parse(request.body);

      request.authorize('access:credential:manage', { branchId: null });
      return reply.status(201).send(await credentials.issue(ctx, env, { memberId: id, ...body }));
    },
  });

  route(app, {
    method: 'GET',
    url: '/members/:id/credentials',
    security: { kind: 'permission', permission: 'members:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      // Se comprueba el socio ANTES: sin esto, un id de otra organización
      // devolvía 200 con lista vacía en vez de 404, y el contrato del sistema
      // es que un recurso ajeno no existe (ADR-001).
      const member = await new MemberRepository(ctx.tenant.organizationId).findById(id);
      if (!member) throw notFound('Socio no encontrado');

      const rows = await new CredentialRepository(ctx.tenant.organizationId).listForMember(id);
      return {
        credentials: rows.map((c) => ({
          id: c.id, kind: c.kind, rfidCardId: c.rfidCardId,
          revokedAt: c.revokedAt?.toISOString() ?? null,
          revokedReason: c.revokedReason,
          issuedAt: c.issuedAt.toISOString(),
        })),
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/credentials/:id/revoke',
    security: { kind: 'permission', permission: 'access:credential:manage' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({ reason: z.string().min(3).max(300) }).parse(request.body);
      request.authorize('access:credential:manage', { branchId: null, reason: body.reason });
      return credentials.revoke(ctx, { credentialId: id, reason: body.reason });
    },
  });
}
