/**
 * Módulo DOMICILIACIÓN — tarjeta en archivo, cobro recurrente y eventos.
 *
 * Tablas propias: `payment_methods`, `payment_attempts`, `refunds`,
 * `chargebacks`, `webhook_events`.
 *
 * Consume: `billing` (el dinero se registra AHÍ, que es su dueño), `members`
 * (la evidencia del mandato vive con los demás consentimientos) y `portal`
 * (la sesión del socio que domicilia desde su teléfono).
 *
 * **El PAN no entra aquí ni de rebote.** Lo que cruza el puerto del
 * procesador es un token; lo que se guarda son marca y últimos cuatro.
 *
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerPaymentRoutes } from './payments.routes.js';
export { PAYMENT_JOBS } from './payments.jobs.js';
// Consumida por: privacy (la retención purga webhooks con firma inválida).
export { WebhookRepository } from './webhook.repository.js';

// Consumida por: privacy. Al anonimizar no queda ninguna tarjeta viva (PS-08).
export { PaymentMethodRepository } from './payment-method.repository.js';
