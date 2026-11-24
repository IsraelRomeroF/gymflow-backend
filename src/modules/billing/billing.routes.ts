import type { FastifyInstance } from 'fastify';
import { registerChargesRoutes } from './charges.routes.js';
import { registerSalesRoutes } from './sales.routes.js';
import { registerPaymentsRoutes } from './payments.routes.js';
import { registerPortfolioRoutes } from './portfolio.routes.js';
import { registerDayPassRoutes } from './day-pass.routes.js';
import { registerPerdonRoutes } from './perdon.routes.js';
import { registerDevolucionRoutes } from './devolucion.routes.js';

/**
 * Las rutas del dinero, en tres archivos por lo que hacen (fase 4): cargos,
 * ventas y pagos. Antes eran 750 líneas en uno; el contrato HTTP no cambia.
 */
export function registerBillingRoutes(app: FastifyInstance): void {
  registerChargesRoutes(app);
  registerSalesRoutes(app);
  registerPaymentsRoutes(app);
  registerPortfolioRoutes(app);
  registerDayPassRoutes(app);
  // Fase 3, bloque 3.5: el adeudo y su perdón (D-12).
  registerPerdonRoutes(app);
  // Y las devoluciones: una parte de un cobro y el saldo a favor (D-13).
  registerDevolucionRoutes(app);
}
