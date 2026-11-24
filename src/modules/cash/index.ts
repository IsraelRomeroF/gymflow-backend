/**
 * Módulo CAJA — cajas, turnos, conteo y movimientos de efectivo.
 *
 * Tablas propias: `cash_registers`, `cash_sessions`, `cash_movements`.
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerCashRoutes } from './cash.routes.js';

// Consumida por: billing.
//   Un cobro de mostrador tiene que imputarse a un turno y consumir folio.
//   Solo se exponen esas dos operaciones, no el servicio entero.
export { CashService } from './cash.service.js';
//   Y el registro de contribuyentes, por el que otros módulos suman su dinero
//   al corte sin que caja los conozca. Ver `shift-contributors.ts`.
export { registerShiftContributor, type ShiftContribution } from './shift-contributors.js';
// Consumida por: pos (no se anula una venta de un turno ya cerrado).
export { CashSessionRepository } from './cash.repository.js';
// Consumida por: analytics (el Inicio de la gerencia) y, en la oleada B, por los avisos al
// teléfono de la dueña (bloque 4.2). Cajas que amanecieron sin cortar y descuadres por revisar (D-17).
export { CashAlertsService, type CajaSinCortar } from './cash-alerts.service.js';
export type { DescuadresPorRevisar } from './cash.repository.js';
