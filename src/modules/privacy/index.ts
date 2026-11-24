/**
 * Módulo PRIVACIDAD — derechos ARCO y retención (LFPDPPP).
 *
 * Decide CUÁNDO y QUÉ se borra o se entrega, y cada módulo dueño de los datos
 * lo ejecuta con sus propios métodos. Es transversal por naturaleza, como
 * analítica, y nadie depende de él.
 *
 * Tablas propias (desde el bloque 3.9, D-32): `privacy_conservation_starts`,
 * `privacy_batches` y `privacy_batch_items` (la lista mensual de exsocios por
 * anonimizar y su firma). De las demás solo lee.
 */
export { PRIVACY_JOBS, RETENCION } from './privacy.jobs.js';
export { registerPrivacyRoutes } from './privacy.routes.js';

// Consumida por: las pruebas y los guiones de operación. La pasada diaria de
// conservación (rostros a los 30 días de la baja y la lista mensual, D-32).
export { ConservacionService, type PasadaDeConservacion, type VistaPreviaDeConservacion } from './conservacion.service.js';
