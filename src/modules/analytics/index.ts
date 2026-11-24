/**
 * Módulo ANALÍTICA — indicadores del negocio: el Tablero, Movimientos, el
 * pulso de la dueña y «Mi turno».
 *
 * NO posee tablas: solo lee. Desde la auditoría 8 (A3-T12) es cierto otra vez:
 * los gastos y el cierre de mes, que escribía, pasaron a `finance`, y las
 * alertas de retención a `retention`. Por eso puede depender de varios módulos
 * sin crear acoplamiento de escritura. Solo depende de él `alerts`, que le
 * pide la semana en cifras para el resumen del lunes (bloque 4.2). Las cifras que
 * congela el cierre de mes las aporta por el registro de `finance`
 * (`month-figures.ts`), sin que `finance` la importe.
 *
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerAnalyticsRoutes } from './analytics.routes.js';
export { registerAnalyticsMonthFigures } from './month-figures.js';

// Consumida por: alerts. La semana en cifras del resumen del lunes de la dueña (D-05, bloque 4.2).
export { WeeklyService, type SemanaEnCifras } from './weekly.service.js';
