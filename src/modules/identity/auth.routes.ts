import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UNLOCK_EXEMPT_ROLES, normalizeUnlocked } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { opcionesDeCookie } from '../../platform/http/sesion.js';
import { moduleViewOf } from '../../platform/modules/module-state.js';
import { SESSION_COOKIE } from './auth.plugin.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { PlatformAuditService } from '../../platform/audit/platform-audit.service.js';
import { AuthUserRepository } from './user.repository.js';
import { PushSubscriptionRepository } from './push-subscription.repository.js';
import { GrantRepository } from './role.repository.js';
import { StaffRepository } from './staff.repository.js';
import type { Env } from '../../platform/env.js';

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * El equipo que sale manda su suscripción de avisos (`endpoint`): se borra
 * con la sesión, para que una tableta compartida o un teléfono prestado deje
 * de recibir «Autorización pendiente» con su resumen e importe (24-15).
 */
const cuerpoDeSalida = z.object({ endpoint: z.string().url().max(2000).optional() });

export function registerAuthRoutes(app: FastifyInstance, env: Env): void {
  const audit = new AuditService();
  const avisos = new PushSubscriptionRepository();

  route(app, {
    method: 'POST',
    url: '/auth/login',
    security: { kind: 'public', why: 'Es el endpoint que establece la sesión; no puede exigirla' },
    config: { rateLimit: { max: env.AUTH_ATTEMPTS_PER_IP, timeWindow: '5 minutes' } },
    handler: async (request, reply) => {
      const body = loginBody.parse(request.body);
      const result = await app.auth.login(body.email, body.password, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        // La sesión que este navegador traía se queda sin cookie: se cierra.
        anterior: request.cookies?.[SESSION_COOKIE],
      });

      // `Secure` también cuando llega por https (el túnel), no solo en producción.
      reply.setCookie(SESSION_COOKIE, result.token, opcionesDeCookie(request, env, result.expiresAt));

      // Entrar a la consola de plataforma queda en SU cadena, con desde dónde (24-19; bloque 1.13).
      if (!result.organizationId) {
        const ua = request.headers['user-agent'];
        await new PlatformAuditService().record(
          { userId: result.userId, ip: request.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null, requestId: String(request.id) },
          { action: 'platform.console.login', resourceType: 'User', resourceId: result.userId },
        );
      }

      // `platform`: la cuenta no es de ningún gimnasio; el panel la lleva a
      // la pantalla de marcas, no al inicio de un gimnasio.
      // `mustChangePassword`: entró con una temporal; el login le pide elegir
      // la suya ahí mismo, porque la temporal no sirve para nada más (A4-N1).
      // `secondsLeft`: cuánto dura esta sesión, contado por el servidor; el panel avisa antes de que se cierre (24-04).
      return reply.status(200).send({
        status: 'AUTHENTICATED', platform: !result.organizationId, mustChangePassword: result.mustChangePassword,
        secondsLeft: segundosHasta(result.expiresAt),
      });
    },
  });

  /**
   * Cambiar la propia contraseña: la temporal que dio la gerencia se cambia
   * aquí. Cierra las demás sesiones: si alguien más la conocía, queda fuera.
   * En el cambio obligatorio no se manda `current` (24-10); la regla de
   * longitud es una para todos y la aplica el servicio.
   */
  route(app, {
    method: 'POST',
    url: '/auth/password',
    security: { kind: 'session' },
    config: { rateLimit: { max: env.AUTH_ATTEMPTS_PER_IP, timeWindow: '5 minutes' } },
    handler: async (request) => {
      const ctx = request.ctx!;
      const body = z.object({ current: z.string().min(1).optional(), next: z.string() }).parse(request.body);
      const { obligatorio } = await app.auth.changePassword(ctx.tenant.actorUserId!, body.current, body.next, ctx.tenant.sessionId);
      await audit.record(ctx, {
        action: 'auth.password_change', resourceType: 'User', resourceId: ctx.tenant.actorUserId!,
        ...(obligatorio ? { afterState: { forced: true } } : {}),
      });
      return { ok: true };
    },
  });

  /** Salir en ESTE equipo: cierra la sesión y apaga sus avisos (24-15). */
  route(app, {
    method: 'POST',
    url: '/auth/logout',
    security: { kind: 'session' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { endpoint } = cuerpoDeSalida.parse(request.body ?? {});
      await app.auth.logout(ctx.tenant.sessionId!);
      const notificationsOff = endpoint && await avisos.remove(ctx.tenant.actorUserId!, endpoint) ? 1 : 0;
      reply.clearCookie(SESSION_COOKIE, opcionesDeCookie(request, env));
      return reply.send({ status: 'LOGGED_OUT', notificationsOff });
    },
  });

  /**
   * «Cerrar las demás» desde «Mis sesiones» (24-14): el teléfono perdido, la
   * PC de recepción donde se quedó abierta. Esta sesión sigue; las demás se
   * cierran y sus equipos dejan de recibir avisos. El que pide se queda con
   * los suyos (`endpoint`).
   */
  route(app, {
    method: 'POST',
    url: '/auth/logout-others',
    security: { kind: 'session' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { endpoint } = cuerpoDeSalida.parse(request.body ?? {});
      const closed = await app.auth.logoutOthers(ctx.tenant.actorUserId!, ctx.tenant.sessionId);
      const notificationsOff = await avisos.removeAllForUser(ctx.tenant.actorUserId!, endpoint);
      // Queda en la bitácora del gimnasio (24-14; la frase `session.revoke_others` ya está en el núcleo).
      await audit.record(ctx, { action: 'session.revoke_others', resourceType: 'User', resourceId: ctx.tenant.actorUserId!, afterState: { closed, notificationsOff } });
      return { closed, notificationsOff };
    },
  });

  /** Salir en todos los equipos, este incluido: ninguno sigue recibiendo avisos. */
  route(app, {
    method: 'POST',
    url: '/auth/logout-all',
    security: { kind: 'session' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const count = await app.auth.logoutEverywhere(ctx.tenant.actorUserId!);
      const notificationsOff = await avisos.removeAllForUser(ctx.tenant.actorUserId!);
      await audit.record(ctx, {
        action: 'session.revoke_all',
        resourceType: 'User',
        resourceId: ctx.tenant.actorUserId!,
        afterState: { revoked: count, notificationsOff },
      });
      reply.clearCookie(SESSION_COOKIE, opcionesDeCookie(request, env));
      return reply.send({ status: 'LOGGED_OUT', revoked: count, notificationsOff });
    },
  });

  route(app, {
    method: 'GET',
    url: '/auth/me',
    security: { kind: 'session' },
    handler: async (request) => {
      const ctx = request.ctx!;
      // Nombre y correo para que el panel diga quién está dentro. Nada más:
      // el hash y los contadores de bloqueo no salen de aquí.
      const user = ctx.tenant.actorUserId
        ? await new AuthUserRepository().findById(ctx.tenant.actorUserId)
        : null;
      // El rol se dice, no se adivina por los permisos (EST-10).
      const roleKeys = ctx.tenant.actorUserId ? await new GrantRepository().roleKeysForUser(ctx.tenant.actorUserId) : [];
      // Desde cuándo y hasta cuándo vale esta sesión: el panel dice a qué hora se cierra (24-04).
      const sesion = ctx.tenant.sessionId ? await app.auth.sesionActual(ctx.tenant.sessionId) : null;
      return {
        userId: ctx.tenant.actorUserId,
        fullName: user?.fullName ?? null,
        email: user?.email ?? null,
        // La puso otra persona: el panel pide cambiarla antes de seguir (SEC2-08).
        mustChangePassword: user?.mustChangePassword ?? false,
        organizationId: ctx.tenant.organizationId,
        roleKeys,
        permissions: [...new Set(ctx.tenant.grants.map((g) => g.permission))].sort(),
        // Lo que el gimnasio tiene encendido, y lo que cada sede dejó de usar:
        // de aquí arma el panel su menú (ADR-036).
        modules: [...(ctx.modules ?? await moduleViewOf(ctx.tenant.organizationId)).org],
        disabledByBranch: Object.fromEntries([...(ctx.modules ?? await moduleViewOf(ctx.tenant.organizationId)).branchDisabled].map(([b, keys]) => [b, [...keys]])),
        branchScopes: [...new Set(ctx.tenant.grants.map((g) => g.branchId))],
        // Lo que el dueño le liberó de Dirección y Cumplimiento; null = no tiene llave (es el dueño).
        // Al dueño solo lo limita la plataforma (2026-10-09); sin límite, null = ve todo.
        unlockedSections: roleKeys.some((k) => UNLOCK_EXEMPT_ROLES.has(k))
          ? await (async () => { const ps = await new StaffRepository(ctx.tenant.organizationId).platformSections(ctx.tenant.actorUserId!); return ps ? normalizeUnlocked(ps) : null; })()
          : normalizeUnlocked(await new StaffRepository(ctx.tenant.organizationId).unlockedSections(ctx.tenant.actorUserId!)),
        limits: serializeLimits(ctx.tenant.limits),
        session: sesion ? { startedAt: sesion.startedAt.toISOString(), endsAt: sesion.endsAt.toISOString(), secondsLeft: segundosHasta(sesion.endsAt) } : null,
      };
    },
  });

  /**
   * «Mis sesiones» (24-14): solo las vivas, con su equipo, su último uso y a
   * qué hora se cierran; `current` marca la de este equipo (24-05).
   */
  route(app, {
    method: 'GET',
    url: '/auth/sessions',
    security: { kind: 'session' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const sesiones = await app.auth.listSessions(ctx.tenant.actorUserId!);
      return sesiones.map((x) => ({
        id: x.id, current: x.id === ctx.tenant.sessionId, device: x.device, deviceLabel: x.deviceLabel, ip: x.ip,
        createdAt: x.createdAt.toISOString(), lastSeenAt: x.lastSeenAt.toISOString(),
        expiresAt: x.expiresAt.toISOString(), endsAt: x.endsAt.toISOString(),
      }));
    },
  });

}


/** Lo que falta para una hora, en segundos y nunca negativo: el panel cuenta con su propio reloj, como la cookie. */
function segundosHasta(d: Date): number {
  return Math.max(0, Math.round((d.getTime() - Date.now()) / 1000));
}

function serializeLimits(limits: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(limits).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
  );
}
