/**
 * Módulo ENTRENAMIENTO — catálogo de ejercicios, rutinas y su asignación.
 *
 * Tablas propias: `exercises`, `workout_templates`, `workout_template_items`,
 * `workout_assignments`, `workout_logs`. Depende de members (el socio existe y
 * de qué coach es), identity (quién asignó) y portal (la sesión del socio).
 * Nadie depende de él: la baja de un coach le llega por `platform/staff/baja.ts`.
 * El inicio del coach lee `members` y `attendance_events` para contar (no los escribe).
 */
export { registerTrainingRoutes } from './training.routes.js';

// Consumida por: privacy. Las notas de la rutina se vacían al anonimizar (PS-08).
export { TrainingRepository } from './training.repository.js';
