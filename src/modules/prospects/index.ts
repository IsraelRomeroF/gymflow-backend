/**
 * Módulo PROSPECTOS — quien preguntó y todavía no se inscribe.
 *
 * Tablas propias: `prospects`. Su seguimiento («le llamé») se guarda en
 * `follow-ups`, con el mismo contrato que el de un socio en riesgo; al
 * inscribirse queda ligado al socio que se dio de alta. Nació en la auditoría
 * 8 (fase 1, bloque 1.7) con lo que vivía en `members` (A2, informe 10). Sus
 * rutas son del módulo de producto Prospectos.
 *
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerProspectRoutes } from './prospects.routes.js';

// Consumida por: privacy. El prospecto que se convirtió en socio también se anonimiza con él (PS-08).
export { ProspectRepository } from './prospect.repository.js';

// Consumida por: intake. Aprobar o vincular un alta digital convierte al interesado
// con el mismo celular (o correo) y nombre, y la bandeja de altas dice «Era interesado» (bloque 2.4).
export { ProspectService } from './prospects.service.js';
