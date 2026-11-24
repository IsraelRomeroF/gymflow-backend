/**
 * Resolución de sesión y autorización.
 *
 * Vive en el módulo de IDENTIDAD, no en plataforma: autenticar es su
 * responsabilidad. Plataforma declara la forma del contrato en
 * `platform/http/fastify.d.ts` y aquí se implementa. `verifyApprover` (la
 * firma del segundo usuario) lo pone `approvals` al montarse (bloque 1.7).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import fp from 'fastify-plugin';
import { DomainError, MODULE_BY_KEY, can, canPossess, isAllowed } from '@gymflow/core';
import { buildTenant, type RequestContext } from '../../platform/context.js';
import { opcionesDeCookie, sesionRequerida } from '../../platform/http/sesion.js';
import { AuthService, sirveConTemporal } from './auth.service.js';
import { finDeSesion } from './fin-de-sesion.js';
import type { Env } from '../../platform/env.js';
import { moduleViewOf } from '../../platform/modules/module-state.js';

export const SESSION_COOKIE = 'gf_session';


async function authPluginImpl(app: FastifyInstance, opts: { env: Env }) {
  const auth = new AuthService(opts.env);

  /**
   * Una sucursal puede haber dejado de usar el módulo de esta ruta aunque el
   * gimnasio lo tenga encendido (ADR-036). Se comprueba aquí, donde ya se
   * sabe la sede del recurso: "Clases no se usa en Norte".
   */
  function exigirModuloEnSede(request: FastifyRequest, branchId: string | null | undefined): void {
    const ctx = request.ctx;
    const key = request.routeModule;
    if (!ctx?.modules || !key || !branchId) return;
    const def = MODULE_BY_KEY.get(key);
    if (!def || def.kind !== 'optional' || def.scope !== 'branch') return;
    if (!ctx.modules.at(branchId).has(key)) throw new DomainError('MODULE_DISABLED', `${def.name} no se usa en esta sucursal`);
  }

  app.decorateRequest('ctx', undefined as RequestContext | undefined);
  app.decorateRequest('platform', undefined);
  app.decorateRequest('sessionEnd', undefined);
  app.decorateRequest('requirePermission', function (this: FastifyRequest, permission, branchId) {
    const ctx = this.ctx;
    if (!ctx) throw sesionRequerida(this);
    // Sin branchId explícito: basta con tener el permiso en cualquier alcance.
    const decision = canPossess(ctx.tenant, permission, {
      organizationId: ctx.tenant.organizationId,
      ...(branchId === undefined ? {} : { branchId }),
    });
    if (decision.outcome === 'DENY') {
      if (decision.code === 'CROSS_TENANT') throw new DomainError('NOT_FOUND', 'Recurso no encontrado');
      throw new DomainError('FORBIDDEN', 'Operación no permitida', decision.detail);
    }
    exigirModuloEnSede(this, branchId);
  });

  app.decorateRequest('branchScope', function (this: FastifyRequest, permission) {
    const ctx = this.ctx;
    if (!ctx) throw sesionRequerida(this);
    const suyos = ctx.tenant.grants.filter((g) => g.permission === permission);
    if (suyos.some((g) => g.branchId === null)) return null;
    return [...new Set(suyos.map((g) => g.branchId as string))];
  });

  app.decorateRequest('holds', function (this: FastifyRequest, permission, branchId) {
    const ctx = this.ctx;
    if (!ctx) return false;
    return isAllowed(canPossess(ctx.tenant, permission, {
      organizationId: ctx.tenant.organizationId, ...(branchId ? { branchId } : {}),
    }));
  });

  app.decorateRequest('authorize', function (this: FastifyRequest, permission, resource) {
    const ctx = this.ctx;
    if (!ctx) throw sesionRequerida(this);

    const decision = can(ctx.tenant, permission, {
      ...resource,
      organizationId: ctx.tenant.organizationId,
    });

    if (decision.outcome === 'REQUIRE_APPROVAL') {
      throw new DomainError('REQUIRE_APPROVAL', 'Se requiere autorización de un segundo usuario', decision.detail);
    }
    if (!isAllowed(decision)) {
      // CROSS_TENANT se traduce a 404 para no confirmar la existencia.
      if (decision.outcome === 'DENY' && decision.code === 'CROSS_TENANT') {
        throw new DomainError('NOT_FOUND', 'Recurso no encontrado');
      }
      throw new DomainError('FORBIDDEN', 'Operación no permitida', decision.outcome === 'DENY' ? decision.detail : undefined);
    }
    if (decision.outcome === 'ALLOW_WITH_ALERT') {
      // Se permite y se deja rastro: visibilidad, no prohibición.
      this.log.warn({ permission, alert: decision.alert, actor: ctx.tenant.actorUserId }, 'límite excedido');
    }
    exigirModuloEnSede(this, resource.branchId);
  });

  /**
   * Resuelve la sesión si hay cookie. No exige autenticación por sí solo.
   * Si la cookie ya no sirve, deja dicho por qué (`request.sessionEnd`): la
   * ruta que exige sesión lo manda en su 401 (24-06).
   */
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) return;

    // Sin 2FA desde el 2026-10-09 (ADR-008): toda sesión nace completa.
    const resolved = await auth.resolveSession(token, { userAgent: request.headers['user-agent'] });
    if (!resolved.ok) { request.sessionEnd = resolved.fin; return; }
    // El teléfono de la dueña (D-04): la sesión se renovó con este uso; su cookie se vuelve a poner con
    // la fecha nueva, la misma que quedó en la base. Es la MISMA sesión: revocarla la sigue cortando.
    if (resolved.renovadaHasta) reply.setCookie(SESSION_COOKIE, token, opcionesDeCookie(request, opts.env, resolved.renovadaHasta));
    if (!resolved.user.organizationId) {
      // Quien opera la plataforma no pertenece a ningún gimnasio: no tiene
      // `ctx` (nunca actúa como personal de nadie), solo `platform`.
      // Si la plataforma tiene IPs permitidas, desde otra la sesión no sirve.
      if (opts.env.platformAllowedIps.length > 0 && !opts.env.platformAllowedIps.includes(request.ip)) {
        request.log.warn({ ip: request.ip, userId: resolved.user.id }, 'plataforma: IP no permitida');
        request.sessionEnd = finDeSesion('NETWORK_NOT_ALLOWED');
        return;
      }
      request.platform = {
        userId: resolved.user.id, fullName: resolved.user.fullName, email: resolved.user.email,
        sessionId: resolved.session.id, stepUpUntil: resolved.session.stepUpUntil ?? null,
        mustChangePassword: resolved.user.mustChangePassword,
      };
      return;
    }

    const modules = await moduleViewOf(resolved.user.organizationId);
    // Servicio suspendido por la plataforma: la sesión que ya existía deja
    // de servir en la siguiente petición (ADR-037), y ahora dice por qué (24-07).
    if (modules.serviceStatus !== 'ACTIVE') {
      request.sessionEnd = finDeSesion(modules.serviceStatus === 'PENDING' ? 'SERVICE_PENDING' : 'SERVICE_SUSPENDED');
      return;
    }
    // Con la contraseña temporal solo se elige la propia (A4-N1): fuera de
    // esas rutas la sesión no trae contexto y la ruta responde 401 con ese motivo.
    if (resolved.user.mustChangePassword && !sirveConTemporal(request.method, request.routeOptions.url)) {
      request.sessionEnd = finDeSesion('TEMPORARY_PASSWORD');
      return;
    }
    request.ctx = {
      requestId: request.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      // Con memoria de diez segundos: no es una consulta por petición.
      modules,
      // Solo coach: ve únicamente a sus socios asignados (2026-10-09).
      coachOf: resolved.roleKeys.includes('COACH') && !resolved.roleKeys.some((k) => k !== 'COACH') ? resolved.user.id : undefined,
      tenant: buildTenant({
        organizationId: resolved.user.organizationId,
        actorUserId: resolved.user.id,
        sessionId: resolved.session.id,
        grants: resolved.grants,
        limits: resolved.limits,
        branchScopeHint: resolved.session.activeBranchId,
        requestId: request.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      }),
    };
  });

  app.decorate('auth', auth);
}

declare module 'fastify' {
  interface FastifyInstance {
    auth: AuthService;
  }
}

export const authPlugin = fp(authPluginImpl, { name: 'gymflow-auth' });
