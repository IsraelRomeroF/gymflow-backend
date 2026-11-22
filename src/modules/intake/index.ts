/**
 * Módulo ALTA DIGITAL — el borrador que manda el socio y el texto que firma.
 *
 * Tablas propias: `member_intakes`, `consent_documents`.
 *
 * Consume: `members` (crear el socio al aprobar, con su deduplicación y su
 * código) y `organization` (resolver la sucursal del enlace público).
 *
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerIntakeRoutes } from './intake.routes.js';

// Consumida por: access (el enrolamiento biométrico registra el consentimiento
// Consumida por: privacy (la retención borra los datos de altas ya revisadas).
export { IntakeRepository } from './intake.repository.js';
