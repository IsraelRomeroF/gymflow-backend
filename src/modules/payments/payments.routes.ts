import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatMoney, money, notFound } from '@gymflow/core';
import { keepModule, route } from '../../platform/http/registry.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { requireMemberSession } from '../portal/index.js';
import { ChargeRepository, PaymentRepository } from '../billing/index.js';
import { PaymentMethodRepository } from './payment-method.repository.js';
import { RefundRepository } from './refund.repository.js';
import { WebhookRepository } from './webhook.repository.js';
import { PaymentsService } from './payments.service.js';
import { getPaymentProvider, isSandboxScenario, SandboxPaymentProvider } from './provider/index.js';
import type { Env } from '../../platform/env.js';

const idParam = z.object({ id: z.string().uuid() });
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function registerPaymentRoutes(app: FastifyInstance, env: Env): void {
  /** A dónde puede volver el socio después del 3DS: solo al portal (SEC-13). */
  const regresoPermitido = (url: string) => {
    if (env.portalOrigins.length === 0) return env.NODE_ENV !== 'production';
    try { return env.portalOrigins.includes(new URL(url).origin); } catch { return false; }
  };
  const returnUrlSeguro = z.string().url().refine(regresoPermitido, 'La dirección de regreso no es la del portal');

  const provider = getPaymentProvider(env.PAYMENT_WEBHOOK_SECRET);
  const service = new PaymentsService(provider);
  const audit = new AuditService();

  // ── El socio domicilia desde su teléfono ──────────────────────────────────

  route(app, {
    method: 'POST',
    url: '/portal/payment-methods/setup',
    security: { kind: 'member' },
    handler: async (request, reply) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const body = z.object({
        returnUrl: returnUrlSeguro,
        // Solo la caja de arena lo mira. En un procesador real el escenario
        // lo decide la tarjeta, que nunca pasa por aquí.
        scenario: z.string().optional(),
      }).parse(request.body ?? {});

      if (body.scenario && provider instanceof SandboxPaymentProvider && isSandboxScenario(body.scenario)) {
        provider.nextScenario = body.scenario;
      }

      const session = await service.startSetup(organizationId, memberId, body.returnUrl);
      return reply.status(201).send(session);
    },
  });

  route(app, {
    method: 'POST',
    url: '/portal/payment-methods',
    security: { kind: 'member' },
    handler: async (request, reply) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const body = z.object({
        setupId: z.string().min(6).max(120),
        makeDefault: z.boolean().default(true),
        /** La versión del mandato que el socio leyó. El texto firmado lo arma el servidor con el vigente (21-05). */
        mandateVersion: z.string().min(1).max(40).optional(),
      }).parse(request.body);

      const ctx = {
        requestId: request.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        tenant: {
          organizationId, actorType: 'MEMBER' as const, grants: [],
          limits: (await import('@gymflow/core')).UNLIMITED_LIMITS,
          branchScopeHint: null, requestId: request.id,
        },
      };

      const method = await service.completeSetup(ctx, {
        memberId,
        setupId: body.setupId,
        makeDefault: body.makeDefault,
        mandateVersion: body.mandateVersion ?? null,
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      });

      // Marca y últimos cuatro. Nada más sale de aquí.
      return reply.status(201).send({
        id: method.id, brand: method.brand, last4: method.last4,
        expMonth: method.expMonth, expYear: method.expYear, isDefault: method.isDefault,
      });
    },
  });

  route(app, {
    method: 'GET',
    url: '/portal/payment-methods',
    security: { kind: 'member' },
    handler: async (request) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const rows = await new PaymentMethodRepository(organizationId).listForMember(memberId);
      return {
        methods: rows.map((m) => ({
          id: m.id, brand: m.brand, last4: m.last4,
          expMonth: m.expMonth, expYear: m.expYear,
          isDefault: m.isDefault, status: m.status,
        })),
      };
    },
  });

  /**
   * Cancelación en UN clic.
   *
   * Sin confirmaciones encadenadas y sin pasar por recepción: una baja difícil
   * no retiene a nadie, produce un contracargo — que además cuesta más que la
   * mensualidad que intentaba salvar.
   */
  route(app, {
    method: 'DELETE',
    url: '/portal/payment-methods/:id',
    security: { kind: 'member' },
    handler: async (request) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const { id } = idParam.parse(request.params);

      const method = await new PaymentMethodRepository(organizationId).findById(id);
      if (!method || method.memberId !== memberId) throw notFound('Tarjeta no encontrada');

      const ctx = {
        requestId: request.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        tenant: {
          organizationId, actorType: 'MEMBER' as const, grants: [],
          limits: (await import('@gymflow/core')).UNLIMITED_LIMITS,
          branchScopeHint: null, requestId: request.id,
        },
      };
      await service.revokeMethod(ctx, id, 'Cancelada por el socio desde el portal');
      return { ok: true };
    },
  });

  /** Pago en línea puntual: el socio liquida un cargo desde su teléfono. */
  route(app, {
    method: 'POST',
    url: '/portal/charges/:id/pay',
    security: { kind: 'member' },
    handler: async (request) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const { id } = idParam.parse(request.params);
      const body = z.object({
        returnUrl: returnUrlSeguro.optional(),
        /** Pago único: la tarjeta recién capturada se usa una vez y no se guarda (UX 2026-10-08). */
        setupId: z.string().min(6).max(120).optional(),
      }).parse(request.body ?? {});

      const { ChargeRepository } = await import('../billing/index.js');
      const charge = await new ChargeRepository(organizationId).findById(id);
      if (!charge || charge.memberId !== memberId) throw notFound('Cargo no encontrado');

      const ctx = {
        requestId: request.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        tenant: {
          organizationId, actorType: 'MEMBER' as const, grants: [],
          limits: (await import('@gymflow/core')).UNLIMITED_LIMITS,
          branchScopeHint: null, requestId: request.id,
        },
      };

      // On-session: el socio está delante, así que un 3DS se puede resolver
      // en el acto en vez de dejar el cargo esperando.
      let unaVez: string | null = null;
      if (body.setupId) {
        const m = await service.completeSetup(ctx, {
          memberId, setupId: body.setupId, makeDefault: false,
          ip: request.ip ?? null, userAgent: request.headers['user-agent'] ?? null, oneTime: true,
        });
        unaVez = m.id;
      }
      const r = await service.chargeCharge(ctx, {
        chargeId: id, onSession: true, returnUrl: body.returnUrl ?? '', ...(unaVez ? { methodId: unaVez } : {}),
      }).finally(async () => {
        // Solo esta vez: la tarjeta no queda guardada pase lo que pase con el cobro.
        if (unaVez) {
          const { PaymentMethodRepository } = await import('./payment-method.repository.js');
          await new PaymentMethodRepository(organizationId).revoke(unaVez, 'Pago único: no se guarda');
        }
      });
      return {
        status: r.status,
        clientSecret: r.clientSecret,
        paymentId: r.paymentId,
      };
    },
  });

  // ── Mostrador ─────────────────────────────────────────────────────────────

  route(app, {
    method: 'GET',
    url: '/members/:id/payment-methods',
    // Ver la tarjeta guardada es parte del estado de cuenta; guardarla o quitarla, no.
    security: { kind: 'permission', permission: 'billing:statement:read' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const orgId = request.ctx!.tenant.organizationId;

      const { MemberRepository } = await import('../members/index.js');
      if (!await new MemberRepository(orgId).findById(id)) throw notFound('Socio no encontrado');

      const rows = await new PaymentMethodRepository(orgId).listForMember(id);
      return {
        methods: rows.map((m) => ({
          id: m.id, brand: m.brand, last4: m.last4,
          expMonth: m.expMonth, expYear: m.expYear, isDefault: m.isDefault, status: m.status,
        })),
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/charges/:id/charge-card',
    security: { kind: 'permission', permission: 'payments:record' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const cargo = await new ChargeRepository(request.ctx!.tenant.organizationId).findById(id);
      if (!cargo) throw notFound('Cargo no encontrado');
      request.requirePermission('payments:record', cargo.branchId);
      const r = await service.chargeCharge(request.ctx!, { chargeId: id });
      return {
        status: r.status,
        paymentId: r.paymentId,
        declineKind: r.declineKind,
        retriable: r.retriable,
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/payments/:id/refund',
    security: { kind: 'permission', permission: 'payments:refund' },
    handler: async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({
        amountCents: z.coerce.bigint().positive().max(999_999_999_999n),
        reason: z.string().min(3).max(300),
        /**
         * Maker-checker. `payments:refund` exige SIEMPRE un segundo usuario,
         * no solo al pasar un límite: devolver dinero es la operación con la
         * que se sacaría dinero de la caja sin que se note, y ADR-018 la trata
         * como tal.
         */
        approvalToken: z.string().min(20).max(200).optional(),
      }).parse(request.body);

      const pago = await new PaymentRepository(request.ctx!.tenant.organizationId).findById(id);
      if (!pago) throw notFound('Pago no encontrado');
      const aprobador = await request.verifyApprover(body.approvalToken, 'payments:refund', { branchId: pago.branchId, resourceType: 'Payment', resourceId: pago.id, amountCents: body.amountCents });
      request.authorize('payments:refund', {
        branchId: pago.branchId,
        reason: body.reason,
        amountCents: body.amountCents,
        ...(aprobador ? { approvedByUserId: aprobador } : {}),
      });
      const r = await service.refund(request.ctx!, {
        paymentId: id,
        amountCents: body.amountCents,
        reason: body.reason,
        approvedByUserId: aprobador,
      });
      return reply.status(201).send(r);
    },
  });

  route(app, {
    method: 'GET',
    url: '/payments/:id/refunds',
    security: { kind: 'permission', permission: 'payments:reconciliation:read' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const repo = new RefundRepository(request.ctx!.tenant.organizationId);
      const rows = await repo.listForPayment(id);
      return {
        refundedCents: (await repo.totalForPayment(id)).toString(),
        refunds: rows.map((r) => ({
          id: r.id,
          amountCents: r.amountCents.toString(),
          amountLabel: formatMoney(money(r.amountCents)),
          status: r.status,
          reason: r.reason,
          createdAt: iso(r.createdAt),
        })),
      };
    },
  });

  route(app, {
    method: 'GET',
    url: '/payments/chargebacks',
    security: { kind: 'permission', permission: 'payments:reconciliation:read' },
    handler: async (request) => {
      // Bandeja de TODA la organización: solo con alcance organizacional.
      request.requirePermission('payments:reconciliation:read', null);
      const rows = await new RefundRepository(request.ctx!.tenant.organizationId).listChargebacks();
      return {
        chargebacks: rows.map((c) => ({
          id: c.id, paymentId: c.paymentId,
          amountCents: c.amountCents.toString(),
          status: c.status, reasonCode: c.reasonCode,
          openedAt: iso(c.openedAt), dueByAt: iso(c.dueByAt),
        })),
      };
    },
  });

  /** Bandeja de eventos que no se pudieron procesar. Nadie los auto-resuelve. */
  route(app, {
    method: 'GET',
    url: '/payments/webhooks/dead-letters',
    security: { kind: 'permission', permission: 'payments:reconciliation:read' },
    handler: async (request) => {
      // Bandeja de TODA la organización: solo con alcance organizacional.
      request.requirePermission('payments:reconciliation:read', null);
      const rows = await new WebhookRepository().deadLetters();
      return {
        events: rows.map((e) => ({
          id: e.id, provider: e.provider, eventType: e.eventType,
          providerEventId: e.providerEventId, receivedAt: iso(e.receivedAt),
          processAttempts: e.processAttempts,
        })),
      };
    },
  });

  // ── Ingesta de eventos ────────────────────────────────────────────────────

  /**
   * Webhook del procesador.
   *
   * **Responde 200 y encola. Nunca procesa en línea.** Un webhook procesado
   * dentro de la propia petición se pierde entero si el proceso falla a la
   * mitad, y el proveedor deja de reintentarlo mucho antes de que nadie se dé
   * cuenta de que faltan pagos.
   */
  // La firma se verifica sobre los BYTES que mandó el procesador. Antes se
  // re-serializaba el JSON ya parseado: cualquier diferencia de espacios u
  // orden invalidaba una firma buena (SEC-05). Solo en esta ruta: el resto
  // de la API sigue recibiendo JSON parseado.
  // El plugin corre después de montar el módulo: se le recuerda de quién es.
  const enEsteModulo = keepModule();
  void app.register(async (crudo) => {
    crudo.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    enEsteModulo(() => route(crudo, {
      method: 'POST',
      url: '/webhooks/payments',
      security: {
        kind: 'public',
        why: 'Lo llama el procesador, que no tiene sesión; la autenticidad la da la FIRMA, no una cookie',
      },
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      handler: async (request, reply) => {
        const rawBody = typeof request.body === 'string' ? request.body : '';
        const signature = request.headers['x-gymflow-signature'];
        const valid = provider.verifyWebhook(rawBody, typeof signature === 'string' ? signature : null);

        let event;
        try {
          event = provider.parseEvent(rawBody);
        } catch {
          // Ni siquiera es JSON. Se responde 200 igualmente: reintentar esto no
          // lo va a arreglar, y un 4xx hace que el proveedor insista en balde.
          return reply.status(200).send({ received: true });
        }

        await new WebhookRepository().ingest({
          provider: provider.name,
          providerEventId: event.eventId,
          eventType: event.type,
          rawPayload: event.payload,
          signatureValid: valid,
          providerCreatedAt: event.occurredAt,
        });

        // Siempre lo mismo: ni "duplicado" ni "firma inválida". Decirle a quien
        // prueba firmas cuál pasó es ayudarlo (SEC-05). Un reenvío es un no-op.
        return reply.status(200).send({ received: true });
      },
    }));
  });

  route(app, {
    method: 'POST',
    url: '/payments/attempts/:id/resolve',
    security: { kind: 'permission', permission: 'payments:reconciliation:resolve' },
    handler: async (request) => {
      // Resolver ESCRIBE el estado del intento: no cuelga del permiso de ver
      // la conciliación, que tiene la dueña (28-04).
      // Bandeja de TODA la organización: solo con alcance organizacional.
      request.requirePermission('payments:reconciliation:resolve', null);
      const { id } = idParam.parse(request.params);
      const ctx = request.ctx!;
      const status = await service.resolveUnknown(ctx.tenant.organizationId, id);

      await audit.record(ctx, {
        action: 'payment.attempt.resolve',
        resourceType: 'payment_attempt',
        resourceId: id,
        afterState: { status },
      });
      return { status };
    },
  });
}
