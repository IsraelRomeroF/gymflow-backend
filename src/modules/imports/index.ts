/**
 * Módulo IMPORTACIÓN — carga de la base de socios del sistema anterior.
 *
 * Tablas propias: `member_imports`, `member_import_rows`.
 *
 * Consume: `members` (fichas, deduplicación y códigos anteriores),
 * `memberships` (vigencias), `billing` (saldo inicial), `catalog` (planes) y
 * `organization` (sucursales). Nadie depende de él.
 *
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerImportRoutes } from './imports.routes.js';
