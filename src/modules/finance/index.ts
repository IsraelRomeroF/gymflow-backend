/**
 * Módulo FINANZAS — gastos del gimnasio y cierre de mes.
 *
 * Tablas propias: `operating_expenses`, `monthly_closes`, `recurring_expenses`,
 * `recurring_expense_skips` (D-26, bloque 4.5: lo que se repite se propone
 * «por confirmar» y no cuenta hasta que alguien lo confirma).
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
export { ExpensesRepository, prorrateoDiario, retirosDelDueno, ajustesPorMes, restaDeLaGanancia } from './expenses.repository.js';
export type { CifrasDeCaja, CifrasDelMes } from './month-figures.js';

// Para quien necesite impedir algo con fecha en un mes CERRADO (D-22):
// `new MonthlyCloseService().assertOpen(organizationId, fechaDeNegocio)`
// responde 409 `MONTH_CLOSED`. Lo tardío se anota en el mes en curso.
export { MonthlyCloseService } from './monthly-close.service.js';

// Consumida por: analytics. El Tablero y Movimientos dicen si el mes ya está
// cerrado y, si lo está, sirven sus cifras desde la foto (D-22).
export { MonthlyCloseRepository } from './monthly-close.repository.js';
