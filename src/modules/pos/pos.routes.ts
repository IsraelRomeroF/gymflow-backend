import type { FastifyInstance } from 'fastify';
import { contar, registerModuleUsage } from '../../platform/modules/usage.js';
import { ProductRepository } from './product.repository.js';
import { registerProductRoutes } from './products.routes.js';
import { registerSaleRoutes } from './sales.routes.js';
import { registerInventoryRoutes } from './inventory.routes.js';
import { registerMemberSalesRoutes } from './member-sales.routes.js';

/**
 * Las rutas del punto de venta, en tres archivos por lo que hacen (auditoría
 * 8, bloque 1.7): catálogo, venta y existencias. Ni las URL ni las respuestas
 * cambian.
 */
export function registerPosRoutes(app: FastifyInstance): void {
  registerModuleUsage('pos', async (orgId) => ({
    inUse: contar(await new ProductRepository(orgId).activeCount(), 'producto en el catálogo', 'productos en el catálogo'),
    blockers: [],
  }));
  registerProductRoutes(app);
  registerSaleRoutes(app);
  registerInventoryRoutes(app);
  // Las compras de un socio, para su ficha (bloque 2.2; 8-01).
  registerMemberSalesRoutes(app);
}
