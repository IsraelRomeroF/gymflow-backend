/**
 * Módulo LIBRO FINANCIERO — cargos, pagos, aplicación N:M y cartera.
 *
 * Tablas propias: `charges`, `charge_adjustments`, `payments`,
 * `payment_allocations`, `billing_cycles`.
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerBillingRoutes } from './billing.routes.js';
export { registerBillingHooks } from './hooks.js';
export { BILLING_JOBS } from './billing.jobs.js';

// Consumida por: analytics (el Tablero). `cash` ya no la lee: `GET /portfolio` vive aquí (28-07).
export { PortfolioRepository } from './portfolio.repository.js';
//   · `ChargeRepository.outstandingTotalCents` la consume `access`: cuando el
//     torniquete cierra la puerta por mora, tiene que decir CUÁNTO se debe.
//     Sin el importe, el rechazo es un "no" que el socio se lleva a casa; con
//     él, recepción cobra en el acto.
export { ChargeRepository } from './charge.repository.js';
//   · `BillingService.recordPayment` la consume `access`: el botón "cobrar y
//     abrir" de la pantalla de excepción cobra y deja pasar en una sola acción.
export { BillingService } from './billing.service.js';
//   · `PaymentRepository` la consume `portal` (el socio ve sus propios pagos)
//     y `payments`: la domiciliación registra el cobro AQUÍ, no por su cuenta,
//     para que exista una sola aplicación a cargos y un solo sitio donde
//     pueda estar mal.
export { PaymentRepository } from './payment.repository.js';
//   · La lectura del estado de cuenta por páginas y «cómo quedó saldado» las
//     consume `portal`: el socio ve sus cargos y pagos con la misma regla y
//     la misma palabra que recepción (bloque 1.6; 3-04, 3-06).
export { StatementRepository } from './statement.repository.js';
export { comoSeSaldo } from './statement.serializers.js';
export { precioDeCuotaDe } from './precio-de-cuota.js';
//   · El pase del día (1.8) lo consume `access`: la puerta pregunta si el
//     socio trae un pase pagado de hoy. El pase es su cargo, así que vive aquí.
export { DayPassRepository, type DayPassRecord } from './day-pass.repository.js';
// Consumida por: `access` (la puerta reconoce el pase de prueba de hoy; bloque 3.3, D-08).
export { TrialPassRepository, type TrialPassRecord } from './day-pass-prueba.repository.js';
export type { ChargeRecord } from './charge.repository.js';

// D-18 (fase 4, bloque 4.4): la deuda que se da por perdida. Lo consume
// `scripts/plazos-estado.ts` (lo que haría la primera corrida, sin escribir).
export { DeudaPerdidaRepository, type DeudaPorMarcar } from './deuda-perdida.js';
