/**
 * Módulo PORTAL — la cara del socio.
 *
 * Tablas propias: `portal_invites`, `member_sessions`.
 *
 * Su sesión está SEPARADA de la del personal a propósito: un socio no es un
 * usuario (ADR-023), y mezclar ambas en una tabla significaría que un error de
 * resolución podría conceder permisos de personal. Un error así no revienta:
 * autoriza.
 *
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerPortalRoutes } from './portal.routes.js';
export { PORTAL_JOBS } from './notices.jobs.js';

// Consumida por: classes. Reservar desde el teléfono necesita resolver la
// sesión del SOCIO, y esa resolución vive aquí para que exista una sola.
// Duplicarla sería tener dos sitios donde equivocarse sobre quién es quién.
export { requireMemberSession } from './portal.routes.js';
// Consumida por: privacy (la retención purga sesiones viejas del socio).
export { PortalAuthRepository } from './portal.repository.js';
