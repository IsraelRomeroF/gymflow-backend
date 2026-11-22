/**
 * Módulo PUNTO DE VENTA — catálogo, venta de mostrador y existencias.
 *
 * Tablas propias: `products`, `pos_sales`, `pos_sale_lines`,
 * `inventory_stock`, `inventory_movements`.
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerPosRoutes } from './pos.routes.js';
export { registerPosShiftContributor } from './shift-contributor.js';

// Consumida por: cash (el corte suma producto además de membresías) y
// analytics (el ingreso de producto se reconoce en el acto).

