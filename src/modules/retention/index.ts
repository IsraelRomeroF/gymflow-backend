/**
 * Módulo RETENCIÓN — a quién llamar antes de que deje de venir (F-22).
 *
 * NO posee tablas: lee la asistencia, el padrón y las membresías y clasifica
 * el hábito de cada socio con las reglas del núcleo (`retention.ts` de
 * `@gymflow/core`). Lo que recepción anota al llamar vive en `follow-ups`.
 * Nació en la auditoría 8 (fase 1, bloque 1.7) con lo que estaba en
 * `analytics` (A3-T12, informe 15). Nadie depende de él.
 *
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerRetentionRoutes } from './retention.routes.js';

// Consumida por: analytics. La bandeja del Inicio (`GET /me/home`) dice cuántos
// socios están en riesgo con la misma cuenta que la pantalla de Retención (bloque 2.1).
export { RetentionService } from './retention.service.js';
