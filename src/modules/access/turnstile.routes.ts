import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACCESS_POLICY_VERSION, notFound } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { sedeDeConsulta } from '../../platform/http/branch-scope.js';
import { MemberRepository } from '../members/index.js';
import { AccessRepository } from './access.repository.js';
import { AccessService } from './access.service.js';
import { RosterService } from './roster.service.js';
import { resueltosDe, serializeDecision, idParam } from './access.serializers.js';
import type { Env } from '../../platform/env.js';

/**
 * El torniquete (módulo Monitor de accesos): el monitor en vivo, el padrón
 * firmado, las revocaciones y los equipos de la entrada con su latido.
 */
export function registerTurnstileRoutes(app: FastifyInstance, env: Env): void {
  const service = new AccessService();
  const roster = new RosterService();

  /** Monitor en vivo: los últimos accesos de la sucursal. */
  route(app, {
    method: 'GET',
    url: '/access/monitor',
    module: 'turnstile',
    security: { kind: 'permission', permission: 'access:monitor' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const q = z.object({
        branchId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        since: z.coerce.date().optional(),
      }).parse(request.query);

      const orgId = ctx.tenant.organizationId;
      const accesos = new AccessRepository(orgId);
      const rows = await accesos.listDecisions({
        branchId: sedeDeConsulta(request, 'access:monitor', q.branchId) ?? undefined, limit: q.limit, since: q.since,
      });

      // Se resuelven los nombres aquí y no en el cliente: la pantalla de
      // monitor se mira de lejos y necesita el nombre, no un identificador.
      // Una consulta para todos: antes era una por fila, cada 5 s (OPT2-02).
      const [nombres, resueltos] = await Promise.all([
        new MemberRepository(orgId).namesByIds(rows.flatMap((d) => (d.memberId ? [d.memberId] : []))),
        resueltosDe(accesos, rows),
      ]);
      const decisions = rows.map((d) => {
        const m = d.memberId ? nombres.get(d.memberId) : undefined;
        return { ...serializeDecision(d, resueltos), memberName: m?.fullName ?? null, memberCode: m?.memberCode ?? null };
      });

      return { decisions };
    },
  });

  // ── Padrón firmado ────────────────────────────────────────────────────────
  /**
   * El padrón que el gateway descarga para decidir SIN RED.
   *
   * Va firmado con Ed25519: el gateway puede quedarse sin él —y entonces
   * degrada, que se nota— pero no puede recibir uno falso.
   */
  route(app, {
    method: 'GET',
    url: '/access/roster',
    module: 'turnstile',
    security: { kind: 'permission', permission: 'access:monitor' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const q = z.object({ branchId: z.string().uuid() }).parse(request.query);
      request.authorize('access:monitor', { branchId: q.branchId });
      const firmado = await roster.build(ctx, env, q.branchId);
      return {
        payload: firmado.payload,
        signature: firmado.signature,
        entries: firmado.payload.entries.length,
      };
    },
  });

  /** Clave pública con la que el gateway verifica el padrón. */
  route(app, {
    method: 'GET',
    url: '/access/roster/public-key',
    module: 'turnstile',
    security: { kind: 'permission', permission: 'access:monitor' },
    handler: async () => ({ publicKeyPem: roster.publicKey(env), algorithm: 'ed25519' }),
  });

  /**
   * Revocaciones. Canal SEPARADO y más rápido que el padrón, porque
   * **gana el NO**: retirar un acceso es urgente y reponerlo no.
   */
  route(app, {
    method: 'GET',
    url: '/access/revocations',
    module: 'turnstile',
    security: { kind: 'permission', permission: 'access:monitor' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const q = z.object({ sinceMs: z.coerce.number().int().min(0).optional() }).parse(request.query);
      const desde = new Date(q.sinceMs ?? Date.now() - 24 * 60 * 60 * 1000);
      const revocations = await roster.revocations(ctx, desde);
      return { since: desde.toISOString(), revocations, total: revocations.length };
    },
  });

  // ── Gateways ──────────────────────────────────────────────────────────────
  route(app, {
    method: 'GET',
    url: '/access/gateways',
    module: 'turnstile',
    security: { kind: 'permission', permission: 'access:monitor' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const q = z.object({ branchId: z.string().uuid().optional() }).parse(request.query);
      const rows = await new AccessRepository(ctx.tenant.organizationId)
        .listGateways(sedeDeConsulta(request, 'access:monitor', q.branchId) ?? undefined);
      return {
        cloudPolicyVersion: ACCESS_POLICY_VERSION,
        gateways: rows.map((g) => ({
          ...g,
          rosterVersion: g.rosterVersion?.toString() ?? null,
          lastHeartbeatAt: g.lastHeartbeatAt?.toISOString() ?? null,
          /** Lo que el monitor tiene que enseñar en rojo. */
          policyMatches: g.policyVersion === null ? null : g.policyVersion === ACCESS_POLICY_VERSION,
        })),
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/access/gateways',
    module: 'turnstile',
    security: { kind: 'permission', permission: 'settings:branch' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = z.object({
        branchId: z.string().uuid(),
        code: z.string().min(1).max(16).regex(/^[A-Za-z0-9._-]+$/),
        name: z.string().min(2).max(80),
      }).parse(request.body);
      request.authorize('settings:branch', { branchId: body.branchId });
      return reply.status(201).send(await service.createGateway(ctx, body));
    },
  });

  /**
   * Latido del gateway CON su versión de política.
   *
   * En producción llega por mTLS desde el gateway. La respuesta le dice si sus
   * reglas coinciden con las de la nube: si no, la puerta podría estar
   * decidiendo distinto que el servidor, y eso no produce ningún error por sí
   * solo. Es el entregable que la separación en repositorios hizo necesario.
   */
  route(app, {
    method: 'POST',
    url: '/access/gateways/:id/heartbeat',
    module: 'turnstile',
    security: { kind: 'permission', permission: 'access:monitor' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        policyVersion: z.string().min(1).max(32),
        rosterVersion: z.string().regex(/^[0-9]{1,18}$/).optional(),
        status: z.enum(['ONLINE', 'DEGRADED', 'OFFLINE']).optional(),
      }).parse(request.body);

      const gateway = await new AccessRepository(ctx.tenant.organizationId).findGateway(id);
      if (!gateway) throw notFound('Gateway no encontrado');
      request.requirePermission('access:monitor', gateway.branchId);

      const { gateway: actualizado, policy } = await service.heartbeat(ctx, {
        gatewayId: id,
        policyVersion: body.policyVersion,
        ...(body.rosterVersion ? { rosterVersion: BigInt(body.rosterVersion) } : {}),
        ...(body.status ? { status: body.status } : {}),
      });

      return {
        gatewayId: actualizado.id,
        cloudPolicyVersion: ACCESS_POLICY_VERSION,
        gatewayPolicyVersion: actualizado.policyVersion,
        policy: policy.ok
          ? { ok: true }
          : { ok: false, severity: policy.severity, detail: policy.detail },
        rosterVersion: actualizado.rosterVersion?.toString() ?? null,
      };
    },
  });
}
