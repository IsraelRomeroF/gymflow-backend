/**
 * Módulo FINANZAS — gastos del gimnasio y cierre de mes.
 *
 * Tablas propias: `operating_expenses`, `monthly_closes`.
 *
 * Nació en la auditoría 8 (fase 1, bloque 1.7) con lo que escribía
 * `analytics`, que vuelve a ser de solo lectura (A3-T12). Aquí vive la
 * respuesta a «¿este mes está cerrado?»: la foto de cada mes cerrado. Las
 * cifras que se congelan las calcula la analítica y llegan por un registro
 * (`month-figures.ts`), así que este módulo no depende de ella.
 *
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerFinanceRoutes } from './finance.routes.js';

// La analítica se registra como la que calcula las cifras que congela el
// cierre de mes (`src/modules.ts`). Ver `month-figures.ts`.
export { registerMonthFiguresSource, type MonthFigures } from './month-figures.js';

// Consumida por: analytics. El Tablero, Movimientos y el pulso restan los
// gastos fijos prorrateados por día.
export { ExpensesRepository, prorrateoDiario } from './expenses.repository.js';

// Consumida por: analytics. El Tablero dice si el mes ya está cerrado y separa
// lo que llegó tarde a un mes cerrado («ajuste de meses anteriores»).
export { MonthlyCloseRepository } from './monthly-close.repository.js';
