/**
 * Módulo CLASES — catálogo, horarios recurrentes, cupo y reservas.
 *
 * Tablas propias: `class_types`, `class_templates`, `class_template_slots`,
 * `class_schedules`, `class_bookings`, `class_booking_blocks`.
 *
 * Consume: `catalog` (¿el plan incluye clases?), `memberships` (¿hasta cuándo
 * está cubierto?), `members` (¿está archivado?), `billing` (el cargo de la
 * clase suelta) y `portal` (la sesión del socio que reserva desde el teléfono).
 *
 * NADIE lo consume todavía, y esa es la señal de que la frontera está bien
 * puesta: si mañana las clases se extraen a servicio propio, lo único que se
 * quita de `app.ts` es su línea.
 *
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerClassRoutes } from './class.routes.js';
export { registerClassHooks } from './hooks.js';
export { CLASS_JOBS } from './class.jobs.js';
