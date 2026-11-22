import type { FastifyInstance } from 'fastify';
import { registerDashboardRoutes } from './dashboard.routes.js';
import { registerMovementsRoutes } from './movements.routes.js';
import { registerPulseRoutes } from './pulse.routes.js';
import { registerHomeRoutes } from './home.routes.js';

/**
 * Las rutas de la analítica, en tres archivos por lo que muestran (auditoría
 * 8, A3-T12): el Tablero, Movimientos y el pulso con «Mi turno». Solo leen:
 * los gastos y el cierre de mes se escriben en `finance` y las alertas de
 * retención viven en `retention`. Ni las URL ni las respuestas cambian.
 */
export function registerAnalyticsRoutes(app: FastifyInstance): void {
  registerDashboardRoutes(app);
  registerMovementsRoutes(app);
  registerPulseRoutes(app);
  // «Hoy te toca»: la bandeja del inicio de quien opera (bloque 2.1).
  registerHomeRoutes(app);
}
