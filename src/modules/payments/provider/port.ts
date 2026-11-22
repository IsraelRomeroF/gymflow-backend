import type { CardFingerprint } from '@gymflow/core';

/**
 * PUERTO del procesador de pagos (docs/07 §3.5, ADR-010).
 *
 * Nueve operaciones, y **ningún tipo del SDK las cruza**. El dominio habla de
 * centavos, identificadores y estados propios; nunca de objetos de Stripe ni
 * de Conekta. Esa es la única razón por la que cambiar de procesador puede
 * costar semanas en vez de meses — y ADR-010 sigue siendo *provisional*, así
 * que es una posibilidad real, no una hipótesis de manual.
 */

/** El proveedor no respondió. NO es un fallo de cobro: es "no sé". */
export class ProviderTimeoutError extends Error {
  constructor(readonly operation: string) {
    super(`El procesador no respondió a ${operation}`);
    this.name = 'ProviderTimeoutError';
  }
}

export type ProviderCustomer = { readonly id: string };

export type SetupSession = {
  readonly id: string;
  /** Lo que el navegador del SOCIO necesita para capturar su tarjeta. */
  readonly clientSecret: string;
  /** Presente solo si la integración es por redirección completa. */
  readonly redirectUrl: string | null;
  readonly status: 'requires_action' | 'succeeded';
};

export type ProviderCard = CardFingerprint & {
  readonly token: string;
  readonly customerId: string;
};

/** Resultado crudo de un intento. La traducción a estado la hace el dominio. */
export type ChargeResult = {
  readonly providerPaymentId: string;
  /** Estado TAL CUAL lo dice el proveedor. `statusFromProvider` lo traduce. */
  readonly status: string;
  readonly code: string | null;
  readonly message: string | null;
  /** Necesario para autenticar 3DS con el socio delante. */
  readonly clientSecret: string | null;
  readonly raw: unknown;
};

export type ProviderPayment = {
  readonly id: string;
  readonly status: string;
  readonly amountCents: bigint;
  readonly code: string | null;
  readonly raw: unknown;
};

export type PaymentReference = {
  readonly id: string;
  /** Referencia que el socio lleva a la tienda o al banco. */
  readonly reference: string;
  readonly expiresAt: Date;
};

export type RefundResult = {
  readonly id: string;
  readonly status: string;
  readonly raw: unknown;
};

/**
 * Línea del reporte de liquidación. **La conciliación se hace contra esto, no
 * contra los webhooks**: un webhook que nunca llegó no deja hueco visible, y
 * un `UNKNOWN` de más de 24 h solo se resuelve aquí.
 */
export type Settlement = {
  readonly date: Date;
  readonly providerPaymentId: string;
  readonly grossCents: bigint;
  readonly feeCents: bigint;
  readonly netCents: bigint;
};

export type ProviderEvent = {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: Date;
  readonly providerPaymentId: string | null;
  readonly payload: unknown;
};

export interface PaymentProvider {
  readonly name: string;

  createCustomer(input: { memberId: string; email: string | null }): Promise<ProviderCustomer>;

  /** Alta del método, ON-SESSION y con 3DS. El PAN se captura en el proveedor. */
  createSetupSession(input: { customerId: string; returnUrl: string }): Promise<SetupSession>;

  /** Se llama al volver del 3DS: entrega el token, nunca el número. */
  fetchCardFromSetup(setupId: string): Promise<ProviderCard>;

  /** MIT recurrente. `idempotencyKey` es OBLIGATORIA. */
  chargeOffSession(input: {
    customerId: string; token: string; amountCents: bigint;
    idempotencyKey: string; description: string;
  }): Promise<ChargeResult>;

  /** Primer cargo o recuperación de un 3DS, con el socio delante. */
  chargeOnSession(input: {
    customerId: string; token: string; amountCents: bigint;
    idempotencyKey: string; description: string; returnUrl: string;
  }): Promise<ChargeResult>;

  createPaymentReference(input: {
    customerId: string; amountCents: bigint; kind: 'SPEI' | 'OXXO'; expiresAt: Date;
  }): Promise<PaymentReference>;

  refund(input: {
    providerPaymentId: string; amountCents: bigint; idempotencyKey: string; reason: string;
  }): Promise<RefundResult>;

  /** Reconsulta canónica. Es lo que resuelve un `UNKNOWN`. */
  getPayment(providerPaymentId: string): Promise<ProviderPayment>;

  listSettlements(from: Date, to: Date): Promise<Settlement[]>;

  verifyWebhook(rawBody: string, signature: string | null): boolean;
  parseEvent(rawBody: string): ProviderEvent;
}
