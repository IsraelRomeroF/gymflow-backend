import type { FastifyInstance } from 'fastify';
import { registerMonthlyCloseRoutes } from './monthly-close.routes.js';
import { registerExpenseRoutes } from './expenses.routes.js';

/**
 * Las rutas de finanzas, en dos archivos por lo que hacen: el cierre de mes y
 * los gastos fijos. Vivían en `analytics.routes.ts`; ni las URL ni las
 * respuestas cambian (auditoría 8, bloque 1.7).
 */
export function registerFinanceRoutes(app: FastifyInstance): void {
  registerMonthlyCloseRoutes(app);
  registerExpenseRoutes(app);
}
