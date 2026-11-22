import { conflict } from '@gymflow/core';
import type { PaymentProvider } from './port.js';

/** Lo que oye el socio (y recepción) cuando intenta pagar con tarjeta en línea. */
const SIN_PROCESADOR = 'El pago con tarjeta en línea todavía no está disponible en este gimnasio. Paga en recepción.';

/**
 * PROCESADOR APAGADO. Es lo que corre en producción mientras no haya un
 * procesador real contratado (P4): cualquier intento de cobrar, domiciliar o
 * reembolsar con tarjeta responde 409 con un mensaje claro, en lugar de que la
 * caja de arena diga "aprobado" sin mover un peso.
 */
export class DisabledPaymentProvider implements PaymentProvider {
  readonly name = 'none';
  private no(): never { throw conflict(SIN_PROCESADOR); }
  createCustomer(): never { return this.no(); }
  createSetupSession(): never { return this.no(); }
  fetchCardFromSetup(): never { return this.no(); }
  chargeOffSession(): never { return this.no(); }
  chargeOnSession(): never { return this.no(); }
  createPaymentReference(): never { return this.no(); }
  refund(): never { return this.no(); }
  getPayment(): never { return this.no(); }
  listSettlements(): never { return this.no(); }
  /** Sin procesador no hay webhook legítimo: todo se rechaza. */
  verifyWebhook(): boolean { return false; }
  parseEvent(): never { return this.no(); }
}
