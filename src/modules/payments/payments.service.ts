import {
  attemptIdempotencyKey, canApplyEvent, cardExpired, classifyDecline, conflict,
  isAutoRetriable, mandateAllowsOffSession, mandateGaps, maxRefundableCents,
  formatMoney, money, notFound, refundDenial, refundIdempotencyKey, statusFromProvider, textoDelMandato, validation,
  type DeclineKind, type Mandate, type PaymentStatus,
} from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { BillingService, ChargeRepository, PaymentRepository, precioDeCuotaDe } from '../billing/index.js';
import { PlanRepository } from '../catalog/index.js';
import { MembershipRepository } from '../memberships/index.js';
import { systemContext } from '../../platform/jobs/types.js';
import { ConsentRepository, MemberRepository, firmarConsentimiento } from '../members/index.js';
import { AttemptRepository, type AttemptOutcome } from './attempt.repository.js';
import { PaymentMethodRepository, type PaymentMethodRecord } from './payment-method.repository.js';
import { RefundRepository } from './refund.repository.js';
import { getPaymentProvider, ProviderTimeoutError, type PaymentProvider } from './provider/index.js';
import type { RequestContext } from '../../platform/context.js';

/**
 * Cobro con tarjeta en archivo.
 *
 * Todo el módulo obedece una regla: **ante la duda, no se cobra otra vez.**
 * De ahí el orden de cada operación —escribir el intento, después llamar— y
 * de ahí que un timeout no se traduzca nunca a "falló".
 */

export type ChargeAttemptResult = {
  status: PaymentStatus;
  paymentId: string | null;
  attemptId: string;
  declineKind: DeclineKind | null;
  /** Presente solo si hay que autenticar con el socio delante. */
  clientSecret: string | null;
  retriable: boolean;
};

export class PaymentsService {
  private readonly audit = new AuditService();

  constructor(private readonly provider: PaymentProvider) {}

  static withDefaults(webhookSecret: string): PaymentsService {
    return new PaymentsService(getPaymentProvider(webhookSecret));
  }

  // ── Alta del método ───────────────────────────────────────────────────────

  /**
   * Abre la sesión donde el SOCIO captura su tarjeta.
   *
   * El PAN se captura en el proveedor, nunca aquí. Lo que vuelve es un
   * `clientSecret` y una URL de redirección: cuál de los dos se usa depende de
   * P4 —si el procesador confirma por escrito la protección contra ataques de
   * scripts, iframe; si no, redirección completa (docs/07 §4.2)— y por eso el
   * puerto devuelve los dos.
   */
  async startSetup(orgId: string, memberId: string, returnUrl: string): Promise<{
    setupId: string; clientSecret: string; redirectUrl: string | null;
  }> {
    const member = await new MemberRepository(orgId).findById(memberId);
    if (!member) throw notFound('Socio no encontrado');

    const methods = new PaymentMethodRepository(orgId);
    const existing = (await methods.listForMember(memberId)).find((m) => m.providerCustomerId);

    const customer = existing?.providerCustomerId
      ? { id: existing.providerCustomerId }
      : await this.provider.createCustomer({ memberId, email: member.email });

    const session = await this.provider.createSetupSession({ customerId: customer.id, returnUrl });
    return {
      setupId: session.id,
      clientSecret: session.clientSecret,
      redirectUrl: session.redirectUrl,
    };
  }

  /**
   * Cierra el alta: recoge el token y **exige el mandato**.
   *
   * Sin mandato no se guarda la tarjeta. Guardarla "para pedirlo luego" es lo
   * que produce el cargo que nadie puede defender ante una disputa.
   */
  async completeSetup(
    ctx: RequestContext,
    input: {
      memberId: string; setupId: string; makeDefault: boolean;
      /** La versión del mandato que el socio LEYÓ; si ya no es la vigente, 409. El texto lo pone el servidor (21-05). */
      mandateVersion?: string | null;
      ip: string | null; userAgent: string | null;
      /** Pago único (UX 2026-10-08): sin mandato ni domiciliación; la tarjeta se retira al cobrar. */
      oneTime?: boolean;
    },
  ): Promise<PaymentMethodRecord> {
    const orgId = ctx.tenant.organizationId;
    const card = await this.provider.fetchCardFromSetup(input.setupId);
    if (input.oneTime) {
      // Sin consentimiento de cargo recurrente: esta tarjeta no se puede cobrar fuera de sesión (`mandateFor` la rechaza).
      return new PaymentMethodRepository(orgId).add({
        memberId: input.memberId, provider: this.provider.name, providerTokenRef: card.token, providerCustomerId: card.customerId,
        brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear, consentId: null, makeDefault: false,
      });
    }

    // La evidencia del mandato se escribe ANTES que la tarjeta: si algo falla
    // en medio, queda el consentimiento sin tarjeta —inofensivo— y nunca una
    // tarjeta cobrable sin consentimiento.
    // El texto es el VIGENTE publicado por el gimnasio más lo que agrega el
    // servidor (plan, importe y tarjeta): nunca lo que mande el navegador (21-05).
    const viva = await new MembershipRepository(orgId).findLiveForMember(input.memberId);
    const plan = viva ? await new PlanRepository(orgId).findById(viva.planId) : null;
    const importe = viva && plan ? formatMoney(money(await precioDeCuotaDe(orgId, viva, plan))) : null;
    const firmadoEl = new Intl.DateTimeFormat('es-MX', { dateStyle: 'long', timeZone: 'America/Mexico_City' }).format(new Date());
    const consent = await firmarConsentimiento(ctx, {
      memberId: input.memberId,
      consentType: 'RECURRING_CHARGE',
      channel: 'SELF_SERVICE',
      ip: input.ip,
      userAgent: input.userAgent,
      ...(input.mandateVersion ? { versionLeida: input.mandateVersion } : {}),
      motivo: 'Domiciliación de su tarjeta',
      componer: (t) => textoDelMandato(t, { plan: plan?.name ?? null, importe, tarjeta: `${card.brand} terminación ${card.last4}`, firmadoEl }),
    });

    const method = await new PaymentMethodRepository(orgId).add({
      memberId: input.memberId,
      provider: this.provider.name,
      providerTokenRef: card.token,
      providerCustomerId: card.customerId,
      brand: card.brand,
      last4: card.last4,
      expMonth: card.expMonth,
      expYear: card.expYear,
      consentId: consent.id,
      makeDefault: input.makeDefault,
    });

    await this.audit.record(ctx, {
      action: 'payment.method.add',
      resourceType: 'payment_method',
      resourceId: method.id,
      // Marca y últimos cuatro. Nada más entra en la bitácora.
      afterState: { brand: method.brand, last4: method.last4, isDefault: method.isDefault },
    });
    return method;
  }

  /** Cancelación en un clic. No pasa por recepción y no admite fricción. */
  async revokeMethod(ctx: RequestContext, methodId: string, reason: string): Promise<void> {
    const orgId = ctx.tenant.organizationId;
    const ok = await new PaymentMethodRepository(orgId).revoke(methodId, reason);
    if (!ok) throw conflict('Esa tarjeta ya no estaba activa');

    await this.audit.record(ctx, {
      action: 'payment.method.revoke',
      resourceType: 'payment_method',
      resourceId: methodId,
      reason,
    });
  }

  // ── Mandato ───────────────────────────────────────────────────────────────

  async mandateFor(orgId: string, memberId: string, method: PaymentMethodRecord): Promise<Mandate | null> {
    if (!method.consentId) return null;
    const consents = await new ConsentRepository(orgId).listForMember(memberId);
    const found = consents.find((c) => c.id === method.consentId);
    if (!found) return null;
    return {
      consentType: found.consentType,
      documentVersion: found.documentVersion,
      granted: found.granted,
      grantedAt: found.grantedAt,
      revokedAt: found.revokedAt,
      ip: found.ip,
      // `listForMember` no trae el user-agent; se toma del canal, que sí
      // distingue una firma del socio de una captura asistida.
      userAgent: found.channel === 'SELF_SERVICE' ? 'self-service' : null,
    };
  }

  // ── Cobro ─────────────────────────────────────────────────────────────────

  /**
   * Cobra un cargo con la tarjeta en archivo.
   *
   * El orden es el del sprint: número de intento → clave DERIVADA → fila
   * persistida → llamada. Si el proceso muere en cualquier punto, el reintento
   * reconstruye la misma clave y el procesador reconoce la operación.
   */
  async chargeCharge(
    ctx: RequestContext,
    input: { chargeId: string; onSession?: boolean; returnUrl?: string; methodId?: string },
  ): Promise<ChargeAttemptResult> {
    const orgId = ctx.tenant.organizationId;
    const charge = await new ChargeRepository(orgId).findById(input.chargeId);
    if (!charge) throw notFound('Cargo no encontrado');

    const pendiente = charge.amountCents - charge.allocatedCents - charge.adjustedCents;
    if (pendiente <= 0n) throw conflict('Ese cargo ya no tiene saldo', 'ALREADY_PAID');

    const methods = new PaymentMethodRepository(orgId);
    // Con `methodId` (pago único) se cobra a esa tarjeta, que es del socio y está activa; si no, a la domiciliada.
    const elegida = input.methodId ? await methods.findById(input.methodId) : null;
    if (input.methodId && (!elegida || elegida.memberId !== charge.memberId || elegida.status !== 'ACTIVE')) throw conflict('Esa tarjeta no se puede usar');
    const method = elegida ?? await methods.defaultForMember(charge.memberId);
    if (!method) throw conflict('El socio no tiene una tarjeta domiciliada');

    if (cardExpired(method, new Date())) {
      await methods.markExpired(method.id);
      throw conflict('La tarjeta domiciliada está vencida');
    }

    const attempts = new AttemptRepository(orgId);
    const previos = await attempts.listForCharge(charge.id);

    // UNKNOWN bloquea. Es la regla que impide el doble cobro, y por eso se
    // comprueba antes de cualquier otra cosa.
    const ultimo = previos[previos.length - 1];
    if (ultimo && (ultimo.outcome === 'UNKNOWN' || ultimo.outcome === null)) {
      throw conflict(
        'Hay un intento sin resolver contra el procesador. No se reintenta hasta saber qué pasó.',
      );
    }
    if (ultimo?.outcome === 'HARD_DECLINE' && !input.onSession) {
      throw conflict('El último intento fue un rechazo duro: hace falta otra tarjeta');
    }

    if (!input.onSession) {
      const mandate = await this.mandateFor(orgId, charge.memberId, method);
      if (!mandateAllowsOffSession(mandate, null)) {
        throw conflict(`No hay mandato válido para cobrar: ${mandateGaps(mandate, null).join(', ')}`);
      }
    }

    const attemptNumber = previos.length + 1;
    const key = attemptIdempotencyKey(charge.id, attemptNumber);

    const attempt = await attempts.open({
      memberId: charge.memberId,
      chargeId: charge.id,
      attemptNumber,
      idempotencyKey: key,
    });
    if (!attempt) throw conflict('Ya hay un intento en curso para ese cargo');

    const peticion = {
      customerId: method.providerCustomerId ?? '',
      token: method.providerTokenRef,
      amountCents: pendiente,
      idempotencyKey: key,
      description: charge.concept,
    };

    let raw;
    try {
      raw = input.onSession
        ? await this.provider.chargeOnSession({ ...peticion, returnUrl: input.returnUrl ?? '' })
        : await this.provider.chargeOffSession(peticion);
    } catch (error) {
      // AQUÍ vive la regla. Un timeout NO es un fallo: el cargo puede haber
      // pasado. Se marca UNKNOWN, que bloquea reintentos, y lo resuelve la
      // reconsulta o la conciliación.
      if (error instanceof ProviderTimeoutError) {
        await attempts.resolve(attempt.id, {
          outcome: 'UNKNOWN',
          providerMessage: error.message,
        });
        return {
          status: 'UNKNOWN', paymentId: null, attemptId: attempt.id,
          declineKind: null, clientSecret: null, retriable: false,
        };
      }
      await attempts.resolve(attempt.id, {
        outcome: 'ERROR',
        providerMessage: error instanceof Error ? error.message : 'Error desconocido',
      });
      throw error;
    }

    const status = statusFromProvider(raw.status);
    const declineKind = status === 'FAILED' || status === 'REQUIRES_ACTION'
      ? classifyDecline(raw.code)
      : null;

    let paymentId: string | null = null;

    if (status === 'SUCCEEDED') {
      // El dinero lo registra BILLING, que es su dueño: una sola aplicación a
      // cargos, un solo lugar donde puede estar mal.
      const businessDate = await new BusinessCalendar(orgId).today(charge.branchId);
      const { payment } = await new PaymentRepository(orgId).record({
        memberId: charge.memberId,
        branchId: charge.branchId,
        method: 'CARD_ON_FILE',
        amountCents: pendiente,
        businessDate,
        idempotencyKey: key,
        externalRef: raw.providerPaymentId,
        processorName: this.provider.name,
        targetChargeIds: [charge.id],
      });
      paymentId = payment.id;
      await new BillingService().settleExternalPayment(ctx, charge.memberId, [charge.id]);
    }

    const outcome: AttemptOutcome =
      status === 'SUCCEEDED' ? 'SUCCESS'
      : status === 'REQUIRES_ACTION' ? 'AUTH_REQUIRED'
      : declineKind === 'SOFT' ? 'SOFT_DECLINE'
      : status === 'FAILED' ? 'HARD_DECLINE'
      : 'UNKNOWN';

    await attempts.resolve(attempt.id, {
      outcome,
      paymentId,
      providerCode: raw.code,
      providerMessage: raw.message,
      rawResponse: raw.raw,
    });

    return {
      status,
      paymentId,
      attemptId: attempt.id,
      declineKind,
      clientSecret: raw.clientSecret,
      retriable: declineKind !== null && isAutoRetriable(declineKind),
    };
  }

  /**
   * Resuelve un intento que quedó sin respuesta.
   *
   * Es el único camino de salida de `UNKNOWN`, y por eso reconsulta al
   * procesador en vez de suponer. Suponer aquí es cobrar dos veces.
   */
  async resolveUnknown(orgId: string, attemptId: string): Promise<PaymentStatus> {
    const attempts = new AttemptRepository(orgId);
    const attempt = (await attempts.unresolved(500)).find((a) => a.id === attemptId);
    if (!attempt) throw notFound('Intento no encontrado o ya resuelto');

    const found = 'findByIdempotencyKey' in this.provider
      ? await (this.provider as unknown as {
          findByIdempotencyKey(k: string): Promise<{ id: string; status: string } | null>;
        }).findByIdempotencyKey(attempt.idempotencyKey)
      : null;

    if (!found) {
      // El procesador no conoce la operación: NO se cobró. Ahora sí es un
      // fallo, y el reintento vuelve a estar permitido.
      await attempts.resolve(attempt.id, { outcome: 'ERROR', providerMessage: 'No existe en el procesador' });
      return 'FAILED';
    }

    const status = statusFromProvider(found.status);
    if (status !== 'SUCCEEDED') {
      await attempts.resolve(attempt.id, { outcome: 'HARD_DECLINE', providerMessage: found.status });
      return status;
    }

    // Sí se cobró. Se registra ahora, con la MISMA clave: si el registro ya
    // existiera, `record` devuelve el original en vez de duplicarlo.
    const charge = attempt.chargeId
      ? await new ChargeRepository(orgId).findById(attempt.chargeId)
      : null;
    if (!charge) {
      await attempts.resolve(attempt.id, { outcome: 'SUCCESS', providerMessage: 'sin cargo asociado' });
      return 'SUCCEEDED';
    }

    const businessDate = await new BusinessCalendar(orgId).today(charge.branchId);
    const { payment } = await new PaymentRepository(orgId).record({
      memberId: charge.memberId,
      branchId: charge.branchId,
      method: 'CARD_ON_FILE',
      amountCents: charge.amountCents - charge.allocatedCents - charge.adjustedCents,
      businessDate,
      idempotencyKey: attempt.idempotencyKey,
      externalRef: found.id,
      processorName: this.provider.name,
      targetChargeIds: [charge.id],
    });
    // Lo resuelve un job, no una persona: el actor es el sistema.
    await new BillingService().settleExternalPayment(systemContext(orgId), charge.memberId, [charge.id]);

    await attempts.resolve(attempt.id, { outcome: 'SUCCESS', paymentId: payment.id });
    return 'SUCCEEDED';
  }

  // ── Reembolsos ────────────────────────────────────────────────────────────

  async refund(
    ctx: RequestContext,
    input: {
      paymentId: string; amountCents: bigint; reason: string;
      approvedByUserId?: string | null;
    },
  ): Promise<{ refundId: string }> {
    const orgId = ctx.tenant.organizationId;
    const payment = await new PaymentRepository(orgId).findById(input.paymentId);
    if (!payment) throw notFound('Pago no encontrado');

    // El procesador solo devuelve lo que él cobró. Un pago en efectivo o de
    // terminal se corrige con una REVERSA en el mostrador.
    if (payment.method !== 'CARD_ON_FILE' || !payment.externalRef) {
      throw validation('Solo se reembolsan pagos con tarjeta en línea. Un cobro de mostrador se corrige revirtiéndolo');
    }
    const refunds = new RefundRepository(orgId);
    const yaReembolsado = await refunds.totalForPayment(payment.id);

    const denial = refundDenial({
      paymentStatus: payment.status,
      amountCents: input.amountCents,
      paymentAmountCents: payment.amountCents,
      alreadyRefundedCents: yaReembolsado,
      reason: input.reason,
    });
    if (denial) {
      throw validation(refundMessage(denial, maxRefundableCents(payment.amountCents, yaReembolsado)));
    }

    const sequence = await refunds.nextSequence(payment.id);
    const key = refundIdempotencyKey(payment.id, sequence);
    const refund = await refunds.open({
      paymentId: payment.id,
      branchId: payment.branchId,
      amountCents: input.amountCents,
      reason: input.reason,
      idempotencyKey: key,
      createdByUserId: ctx.tenant.actorUserId ?? null,
    });
    if (!refund) throw conflict('Ese reembolso ya estaba en curso');

    try {
      const result = await this.provider.refund({
        providerPaymentId: payment.externalRef ?? '',
        amountCents: input.amountCents,
        idempotencyKey: key,
        reason: input.reason,
      });
      await refunds.settle(refund.id, result.id);
    } catch (error) {
      await refunds.fail(refund.id);
      throw error;
    }
    // El dinero ya salió en el procesador: ahora el libro lo refleja. Si esto
    // fallara, el error NO puede invitar a repetir el reembolso (cada intento
    // devolvía otra vez, BE2-01): queda anotado para que alguien lo asiente.
    try {
      await new BillingService().recordRefund(ctx, { paymentId: payment.id, amountCents: input.amountCents, reason: input.reason });
    } catch (error) {
      await this.audit.record(ctx, {
        action: 'payment.refund.unrecorded', resourceType: 'refund', resourceId: refund.id,
        reason: input.reason, branchId: payment.branchId,
        afterState: { paymentId: payment.id, amountCents: input.amountCents.toString(), error: error instanceof Error ? error.message : String(error) },
      });
      throw conflict('El banco YA devolvió el dinero, pero no se pudo asentar en el estado de cuenta. No lo repitas: avisa a la gerencia para que lo registre');
    }

    await this.audit.record(ctx, {
      action: 'payment.refund',
      resourceType: 'refund',
      resourceId: refund.id,
      reason: input.reason,
      approvedByUserId: input.approvedByUserId ?? null,
      afterState: { paymentId: payment.id, amountCents: input.amountCents.toString() },
    });
    return { refundId: refund.id };
  }

  // ── Eventos ───────────────────────────────────────────────────────────────

  /**
   * Aplica un evento ya validado y encolado.
   *
   * `canApplyEvent` es la guarda que impide que un `payment_failed` atrasado
   * deshaga un cobro exitoso. Los webhooks llegan desordenados: es normal, no
   * una avería, y sin la guarda el socio paga y el torniquete le cierra igual.
   */
  async applyEvent(orgId: string, event: {
    type: string; providerPaymentId: string | null; payload: unknown;
  }): Promise<'APPLIED' | 'IGNORED'> {
    if (!event.providerPaymentId) return 'IGNORED';

    const payments = new PaymentRepository(orgId);
    const payment = await payments.findByExternalRef(event.providerPaymentId);
    if (!payment) return 'IGNORED';

    const incoming = eventToStatus(event.type);
    if (!incoming) return 'IGNORED';

    if (!canApplyEvent(payment.status, incoming)) return 'IGNORED';

    if (event.type === 'charge.dispute.created') {
      const p = event.payload as { reasonCode?: string; dueByAt?: string };
      await new RefundRepository(orgId).openChargeback({
        paymentId: payment.id,
        amountCents: payment.amountCents,
        providerCaseId: event.providerPaymentId,
        reasonCode: p.reasonCode ?? null,
        openedAt: new Date(),
        dueByAt: p.dueByAt ? new Date(p.dueByAt) : null,
      });
    }

    // Un contracargo se ASIENTA (reversa sin caja y membresía a mora); el
    // resto de los eventos solo actualizan el estado del pago.
    if (incoming === 'REVERSED' && payment.status === 'SUCCEEDED') {
      await new BillingService().recordChargeback(systemContext(orgId), payment.id);
      return 'APPLIED';
    }
    await payments.setStatus(payment.id, incoming);
    return 'APPLIED';
  }
}

function eventToStatus(type: string): PaymentStatus | null {
  switch (type) {
    case 'payment_intent.succeeded': return 'SUCCEEDED';
    case 'payment_intent.payment_failed': return 'FAILED';
    case 'payment_intent.requires_action': return 'REQUIRES_ACTION';
    case 'payment_intent.canceled': return 'CANCELED';
    case 'charge.dispute.created': return 'REVERSED';
    default: return null;
  }
}

function refundMessage(denial: string, maxCents: bigint): string {
  switch (denial) {
    case 'NOT_SUCCEEDED': return 'Solo se reembolsa un pago que se cobró de verdad';
    case 'NO_REASON': return 'Un reembolso exige motivo';
    case 'AMOUNT_NOT_POSITIVE': return 'El importe debe ser mayor que cero';
    default: return `El reembolso excede lo cobrado: quedan ${maxCents} centavos`;
  }
}
