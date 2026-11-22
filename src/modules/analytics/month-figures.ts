import { registerMonthFiguresSource } from '../finance/index.js';
import { AnalyticsService } from './analytics.service.js';

/**
 * Las cifras que congela el cierre de mes son las del Tablero de ese mes para
 * toda la organización. `finance` las pide sin conocer a la analítica: esta se
 * registra al montarse (`src/modules.ts`), como `pos` en el corte de caja.
 */
export function registerAnalyticsMonthFigures(): void {
  const service = new AnalyticsService();
  registerMonthFiguresSource((ctx, range) => service.dashboard(ctx, range, null));
}
