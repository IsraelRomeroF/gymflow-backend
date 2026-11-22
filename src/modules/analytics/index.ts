/**
 * Módulo ANALÍTICA — indicadores del negocio: el Tablero, Movimientos, el
 * pulso de la dueña y «Mi turno».
 *
 * NO posee tablas: solo lee. Desde la auditoría 8 (A3-T12) es cierto otra vez:
 * los gastos y el cierre de mes, que escribía, pasaron a `finance`, y las
 * alertas de retención a `retention`. Por eso puede depender de varios módulos
 * sin crear acoplamiento de escritura: nadie depende de él. Las cifras que
 * congela el cierre de mes las aporta por el registro de `finance`
 * (`month-figures.ts`), sin que `finance` la importe.
 *
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerAnalyticsRoutes } from './analytics.routes.js';
export { registerAnalyticsMonthFigures } from './month-figures.js';
