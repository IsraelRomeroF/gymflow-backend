import { SandboxPaymentProvider } from './sandbox.provider.js';
import { DisabledPaymentProvider } from './disabled.provider.js';
import { onlinePaymentsEnabled, paymentProviderKind } from '../../../platform/payments-mode.js';
import type { PaymentProvider } from './port.js';

/**
 * Elección del procesador.
 *
 * En producción, sin procesador contratado, corre `DisabledPaymentProvider`:
 * el cobro con tarjeta en línea se apaga y lo dice. La caja de arena solo
 * vive en desarrollo y pruebas (ver `PAYMENT_PROVIDER` en `env.ts`).
 *
 * Todavía no hay procesador real, y no es un descuido: **ADR-010 sigue siendo
 * provisional** y P4 —las cartas al procesador— no ha contestado. Añadir
 * Stripe aquí antes de saber qué contesta sería construir sobre una decisión
 * que todavía puede cambiar de proveedor.
 *
 * Lo que sí está construido es todo lo demás: el puerto, la idempotencia, los
 * estados y la conciliación. Enchufar el proveedor real es implementar esta
 * interfaz, no rehacer el módulo.
 */
let instance: PaymentProvider | undefined;

export function getPaymentProvider(secret: string): PaymentProvider {
  instance ??= paymentProviderKind() === 'none' ? new DisabledPaymentProvider() : new SandboxPaymentProvider(secret);
  return instance;
}

/** Solo pruebas. */
export function resetPaymentProvider(): void {
  instance = undefined;
}

export { ProviderTimeoutError } from './port.js';
export type {
  PaymentProvider, ChargeResult, ProviderCard, ProviderEvent, ProviderPayment,
  Settlement, SetupSession,
} from './port.js';
export { onlinePaymentsEnabled, paymentProviderKind };

export { SandboxPaymentProvider, isSandboxScenario } from './sandbox.provider.js';
