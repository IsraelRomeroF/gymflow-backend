/**
 * Módulo CATÁLOGO — planes y su precio efectivo por sucursal.
 *
 * Tablas propias: `plans`, `plan_branch_availability`.
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerCatalogRoutes } from './catalog.routes.js';

// Consumida por: memberships (alta y cambio de plan), billing (importe de la cuota).
export { PlanRepository, type PlanRecord } from './plan.repository.js';
