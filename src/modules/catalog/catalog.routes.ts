import type { FastifyInstance } from 'fastify';
import { registerPlanRoutes } from './plans.routes.js';

/**
 * Catálogo comercial: planes y su precio efectivo por sucursal. Las rutas de
 * planes viven en `plans.routes.ts` y su lógica en `catalog.service.ts`
 * (auditoría 8, bloque 1.7); aquí se sumarán las de precios y descuentos
 * cuando existan. Ni las URL ni las respuestas cambian.
 */
export function registerCatalogRoutes(app: FastifyInstance): void {
  registerPlanRoutes(app);
}
