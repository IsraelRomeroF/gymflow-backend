import type { FastifyInstance } from 'fastify';
import { registerExportRoutes } from './export.routes.js';
import { registerAnonymizeRoutes } from './anonymize.routes.js';
import { registerRequestRoutes } from './requests.routes.js';
import { registerPortalPrivacyRoutes } from './portal-privacy.routes.js';
import { registerConservationRoutes } from './conservation.routes.js';
import { inscribirEfectosDeRetiro } from './efectos-de-retiro.js';

/**
 * Las rutas de privacidad, en cuatro archivos por lo que hacen (auditoría 8,
 * bloque 1.7; A4): acceso (la descarga), cancelación y plazo de supresión,
 * solicitudes ARCO y lo que el socio hace desde su teléfono. Ni las URL ni las
 * respuestas cambian.
 */
export function registerPrivacyRoutes(app: FastifyInstance): void {
  // Lo que apaga cada permiso al retirarse (tarjetas, rostros): se inscribe al arrancar (1.10).
  inscribirEfectosDeRetiro();
  registerExportRoutes(app);
  registerAnonymizeRoutes(app);
  // Conservación (D-32, bloque 3.9): plazos, rostros en espera y la lista mensual que firma el dueño.
  registerConservationRoutes(app);
  registerRequestRoutes(app);
  registerPortalPrivacyRoutes(app);
}
