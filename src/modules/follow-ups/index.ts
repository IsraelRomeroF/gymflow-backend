/**
 * Módulo SEGUIMIENTOS — «le llamé», «le escribí», con resultado y próximo paso.
 *
 * Tablas propias: `follow_ups` (solo se agrega: la base no da UPDATE ni DELETE
 * a la aplicación).
 *
 * Un seguimiento es de un prospecto o de un socio en riesgo, y el contrato de
 * «Contacto con {nombre}» es el mismo para los dos: lo comparten Prospectos y
 * Retención (A2, A3-T12, informes 10 y 15). Nació en la auditoría 8 (fase 1,
 * bloque 1.7) con lo que vivía en `members`. Aquí están las rutas del socio en
 * riesgo; las del prospecto viven en `prospects`, porque la lista de
 * prospectos lee el último contacto y, si vivieran aquí, los dos módulos se
 * necesitarían uno al otro (círculo, `test/module-boundaries.test.ts`).
 *
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerFollowUpRoutes } from './follow-ups.routes.js';

// Consumida por: prospects. Los contactos de cada prospecto y el último de
// cada uno en la lista, con el mismo contrato que el de un socio.
export { FollowUpRepository, type FollowUpRecord } from './follow-up.repository.js';
export { contactoBody, contactoDeInteresadoBody, contactoJson } from './contacto.js';
