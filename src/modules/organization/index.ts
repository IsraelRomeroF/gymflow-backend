/**
 * Módulo ORGANIZACIÓN — organizaciones y sucursales.
 *
 * Tablas propias: `organizations`, `branches`.
 *
 * Este archivo es la ÚNICA puerta del módulo: ningún otro módulo puede
 * importar sus archivos internos, y una prueba lo verifica. Esa restricción
 * es lo que permite que mañana este módulo se convierta en un servicio sin
 * tocar a quien lo consume: se cambia la implementación detrás de esta puerta
 * por un cliente HTTP y nadie más se entera.
 */

// ── Montaje (solo app.ts) ───────────────────────────────────────────────────
export { registerOrganizationRoutes } from './organization.routes.js';

// ── Superficie pública ──────────────────────────────────────────────────────
// Consumida por: memberships, billing, cash (zona horaria efectiva y sucursal).
export { OrganizationRepository } from './organization.repository.js';
export { BranchRepository } from './branch.repository.js';
