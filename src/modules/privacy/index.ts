/**
 * Módulo PRIVACIDAD — derechos ARCO y retención (LFPDPPP).
 *
 * NO posee tablas: decide CUÁNDO y QUÉ se borra o se entrega, y cada módulo
 * dueño de los datos lo ejecuta con sus propios métodos. Es transversal por
 * naturaleza, como analítica, y nadie depende de él.
 */
export { PRIVACY_JOBS, RETENCION } from './privacy.jobs.js';
export { registerPrivacyRoutes } from './privacy.routes.js';
