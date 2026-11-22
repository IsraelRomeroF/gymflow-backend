import type { FastifyInstance } from 'fastify';
import { registerLookupRoutes } from './lookup.routes.js';
import { registerCoachRoutes } from './coach.routes.js';
import { registerHealthRoutes } from './health.routes.js';
import { registerProfileRoutes } from './profile.routes.js';
import { registerConsentRoutes } from './consents.routes.js';
import { registerHistoryRoutes } from './history.routes.js';

/**
 * Las rutas del socio, en cinco archivos por lo que hacen (auditoría 8,
 * bloque 1.7): búsqueda y padrón, coach asignado, nota de salud, expediente
 * (alta, edición, baja y regreso) y consentimientos. Los prospectos pasaron a
 * `prospects` y el seguimiento de socios en riesgo a `follow-ups`. Antes eran
 * 780 líneas en un archivo; ni las URL ni las respuestas cambian.
 */
export function registerMemberRoutes(app: FastifyInstance): void {
  registerLookupRoutes(app);
  registerCoachRoutes(app);
  registerHealthRoutes(app);
  registerProfileRoutes(app);
  registerConsentRoutes(app);
  // La historia del socio, para su ficha (bloque 2.2; 3-11).
  registerHistoryRoutes(app);
}
