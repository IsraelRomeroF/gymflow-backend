/**
 * Módulo CATÁLOGO — planes y su precio efectivo por sucursal.
 *
 * Tablas propias: `plans`, `plan_branch_availability`, `plan_price_changes`,
 * `membership_price_changes` (D-19, bloque 3.6). De `memberships` escribe solo
 * el precio: `agreedPriceCents` al cambiar el precio de un plan y la marca
 * `priceProtected` («conserva su precio»).
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerCatalogRoutes } from './catalog.routes.js';

// Consumida por: memberships (alta y cambio de plan), billing (importe de la cuota).
export { PlanRepository, type PlanRecord } from './plan.repository.js';

// Consumida por: outbound, que se registra para armar el aviso al teléfono
// cuando cambia el precio de un plan (D-19). `catalog` no sabe quién escucha.
export { registerPlanPriceChangedHook, type PlanPriceChanged } from './price-hooks.js';

// Consumida por: billing (la línea del recibo que avisa del cambio de precio).
export { avisoDePrecioEnRecibo } from './price-notice.js';
