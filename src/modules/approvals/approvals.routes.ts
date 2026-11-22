import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { APPROVAL_RESOURCE_TYPES, PERMISSIONS, type PermissionKey } from '@gymflow/core';
import { ApprovalApprovers, ApprovalHistory, ApprovalInbox, ApprovalRequest, ApprovalRequestState } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { ApprovalService } from './approval.service.js';
import { RemoteApprovalService } from './remote-approval.service.js';
import type { Env } from '../../platform/env.js';

/**
 * Las firmas del segundo usuario: en el mostrador (`POST /approvals`) y a
 * distancia (`/approvals/requests…`). Vivían en `identity/auth.routes.ts`;
 * ni las URL ni las respuestas cambian (auditoría 8, bloque 1.7; A4).
 * `app.auth` es el servicio de sesión de `identity`: comprueba la contraseña.
 */
export function registerApprovalRoutes(app: FastifyInstance, env: Env): void {
  /**
   * El SEGUNDO usuario autoriza en el mismo mostrador tecleando su contraseña
   * (sin código: no hay 2FA desde el 2026-10-09). Devuelve un token de un solo uso, atado a
   * este permiso, a quien lo pidió y a cinco minutos, que la operación manda
   * en `approvalToken`. Con límite por IP: aquí se prueban contraseñas.
   */
  route(app, {
    method: 'POST',
    url: '/approvals',
    security: { kind: 'session' },
    config: { rateLimit: { max: env.AUTH_ATTEMPTS_PER_IP, timeWindow: '5 minutes' } },
    handler: async (request) => {
      const ctx = request.ctx!;
      const body = z.object({
        // Quién firma: su correo o, si el diálogo ya lo sabe por «Pueden autorizar», su id (20-14).
        email: z.string().email().optional(),
        approverUserId: z.string().uuid().optional(),
        password: z.string().min(1),
        permission: z.string().refine((p) => PERMISSIONS.some((x) => x.key === p), 'Permiso desconocido'),
        branchId: z.string().uuid().optional(),
        // A qué operación y hasta qué importe (SEC2-05), y de qué registro se trata (29-01).
        resourceType: z.enum(APPROVAL_RESOURCE_TYPES).optional(),
        resourceId: z.string().uuid().optional(),
        amountCents: z.coerce.bigint().min(0n).max(999_999_999_999n).optional(),
      }).refine((b) => !!b.email !== !!b.approverUserId, { message: 'Di quién autoriza: su correo o su nombre de la lista, uno de los dos', path: ['email'] })
        .parse(request.body);
      const r = await new ApprovalService().issue(ctx, app.auth, {
        email: body.email, approverUserId: body.approverUserId, password: body.password,
        permission: body.permission as PermissionKey, branchId: body.branchId,
        resourceType: body.resourceType, resourceId: body.resourceId, amountCents: body.amountCents,
      });
      return { approvalToken: r.approvalToken, approverName: r.approverName, expiresAt: r.expiresAt.toISOString() };
    },
  });

  /** Quién puede autorizar esta operación: el diálogo lo dice desde el principio (UXB-04). */
  route(app, {
    method: 'GET',
    url: '/approvals/approvers',
    security: { kind: 'session' },
    schema: respuesta(200, ApprovalApprovers),
    handler: async (request) => {
      const q = z.object({
        permission: z.string().refine((p) => PERMISSIONS.some((x) => x.key === p), 'Permiso desconocido'),
        branchId: z.string().uuid().optional(),
        amountCents: z.coerce.bigint().min(0n).optional(),
      }).parse(request.query);
      return new ApprovalService().whoCanApprove(request.ctx!, q.permission as PermissionKey, {
        branchId: q.branchId, amountCents: q.amountCents,
      });
    },
  });

  // ── Autorización a distancia ──────────────────────────────────────────────
  const remotas = new RemoteApprovalService();
  const solicitudJson = (r: Awaited<ReturnType<RemoteApprovalService['request']>>) => ({
    id: r.id, permission: r.permission, branchId: r.branchId, resourceType: r.resourceType, resourceId: r.resourceId,
    amountCents: r.amountCents?.toString() ?? null, summary: r.summary, reason: r.reason, status: r.status,
    decidedAt: r.decidedAt?.toISOString() ?? null, rejectReason: r.rejectReason,
    expiresAt: r.expiresAt.toISOString(), createdAt: r.createdAt.toISOString(),
    // La cuenta regresiva la lleva el servidor (29-06): lo que le queda a una pendiente.
    secondsLeft: r.status === 'PENDING' ? Math.max(0, Math.ceil((r.expiresAt.getTime() - Date.now()) / 1000)) : 0,
    // Si quien firma la pudo ver (29-05): a cuántos teléfonos salió el aviso y cuándo la mostró su bandeja.
    notifiedCount: r.notifiedCount, seenAt: r.seenAt?.toISOString() ?? null,
  });

  /** Quien opera pide la firma; quien puede darla la ve en su teléfono. */
  route(app, {
    method: 'POST',
    url: '/approvals/requests',
    security: { kind: 'session' },
    schema: respuesta(201, ApprovalRequest),
    handler: async (request, reply) => {
      const body = z.object({
        permission: z.string().refine((p) => PERMISSIONS.some((x) => x.key === p), 'Permiso desconocido'),
        branchId: z.string().uuid().optional(),
        // De qué registro se trata (29-01). Hoy el servidor lo deduce si falta;
        // cuando panel y portal lo manden siempre, pasa a obligatorio. El cierre
        // de mes manda el id fijo de su mes (20-01), así que `resourceId` sigue obligatorio.
        resourceType: z.enum(APPROVAL_RESOURCE_TYPES).optional(),
        resourceId: z.string().uuid(),
        amountCents: z.coerce.bigint().min(0n).max(999_999_999_999n).optional(),
        summary: z.string().trim().min(3).max(200),
        reason: z.string().trim().max(300).optional(),
      }).parse(request.body);
      const r = await remotas.request(request.ctx!, {
        permission: body.permission as PermissionKey, branchId: body.branchId ?? null, resourceType: body.resourceType,
        resourceId: body.resourceId, amountCents: body.amountCents, summary: body.summary, reason: body.reason,
      });
      return reply.status(201).send(solicitudJson(r));
    },
  });

  /** Estado para quien la pidió. Aprobada, trae la firma mientras no se use ni venza (29-03). */
  route(app, {
    method: 'GET',
    url: '/approvals/requests/:id',
    security: { kind: 'session' },
    schema: respuesta(200, ApprovalRequestState),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const r = await remotas.status(request.ctx!, id);
      // `delivery`: la firma de una aprobada sigue lista, ya se usó o venció (29-03).
      return { ...solicitudJson(r), approverName: r.approverName, approvalToken: r.approvalToken, delivery: r.delivery };
    },
  });

  route(app, {
    method: 'POST',
    url: '/approvals/requests/:id/cancel',
    security: { kind: 'session' },
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await remotas.cancel(request.ctx!, id);
      return { ok: true };
    },
  });

  /**
   * Lo que ESTA persona puede autorizar ahora mismo. Con `?seen=1` la pantalla
   * dice que las está mostrando: se anota la primera vez, y el mostrador que
   * espera lee «la vio a las 15:31» en vez de «nadie la contestó» (29-05). El
   * contador del marco consulta sin `seen` y no cuenta como haberla visto.
   */
  route(app, {
    method: 'GET',
    url: '/approvals/inbox',
    security: { kind: 'session' },
    schema: respuesta(200, ApprovalInbox),
    handler: async (request) => {
      const q = z.object({ seen: z.enum(['1']).optional() }).parse(request.query);
      const lista = await remotas.inbox(request.ctx!, { vistas: q.seen === '1' });
      return { requests: lista.map((r) => ({ ...solicitudJson(r), requesterName: r.requesterName, context: r.context })) };
    },
  });

  /**
   * «Resueltas hoy» (20-05): lo aprobado, rechazado, vencido y cancelado de las
   * últimas 24 horas. Quien da la segunda firma ve todo lo que podía firmar;
   * los demás, lo que pidieron. Solo lectura.
   */
  route(app, {
    method: 'GET',
    url: '/approvals/history',
    security: { kind: 'session' },
    schema: respuesta(200, ApprovalHistory),
    handler: async (request) => {
      const h = await remotas.history(request.ctx!);
      return {
        scope: h.scope, windowHours: h.windowHours,
        requests: h.requests.map((r) => ({
          id: r.id, permission: r.permission, branchId: r.branchId, resourceType: r.resourceType, resourceId: r.resourceId,
          amountCents: r.amountCents?.toString() ?? null, summary: r.summary, context: r.context, reason: r.reason,
          status: r.status, requesterName: r.requesterName, approverName: r.approverName, mine: r.mine,
          createdAt: r.createdAt.toISOString(), resolvedAt: r.resolvedAt.toISOString(), rejectReason: r.rejectReason,
          delivery: r.delivery, seenAt: r.seenAt?.toISOString() ?? null, notifiedCount: r.notifiedCount,
        })),
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/approvals/requests/:id/approve',
    security: { kind: 'session' },
    // Pide contraseña: el mismo límite que el resto de las autorizaciones.
    config: { rateLimit: { max: env.AUTH_ATTEMPTS_PER_IP, timeWindow: '5 minutes' } },
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({ password: z.string().min(1) }).parse(request.body);
      await remotas.approve(request.ctx!, app.auth, id, { password: body.password });
      return { ok: true };
    },
  });

  route(app, {
    method: 'POST',
    url: '/approvals/requests/:id/reject',
    security: { kind: 'session' },
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(request.body);
      await remotas.reject(request.ctx!, id, reason);
      return { ok: true };
    },
  });
}
