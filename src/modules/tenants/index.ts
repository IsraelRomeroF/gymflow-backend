/**
 * Módulo PLATAFORMA · MARCAS: dar de alta y acompañar gimnasios.
 *
 * Es el único que escribe en varios gimnasios, porque su trabajo es crear el
 * siguiente. Lo opera una cuenta sin gimnasio (`request.platform`); nunca el
 * personal de una marca.
 */
export { registerTenantRoutes } from './tenants.routes.js';
export { TENANT_JOBS } from './platform-billing.jobs.js';
