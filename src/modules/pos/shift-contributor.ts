import { registerShiftContributor, type ShiftContribution } from '../cash/index.js';
import { PosSaleRepository } from './pos-sale.repository.js';

/**
 * Aporte del punto de venta al corte de caja.
 *
 * `pos` se registra en `cash`, y no al revés: la dependencia va en la
 * dirección que ya existía (una venta necesita turno). Así el corte suma
 * producto sin que `cash` sepa que `pos` existe.
 */
export function registerPosShiftContributor(): void {
  registerShiftContributor({
    source: 'POS',
    async totalsForSession(organizationId: string, cashSessionId: string): Promise<ShiftContribution> {
      const totales = await new PosSaleRepository(organizationId).cashTotalsForSession(cashSessionId);
      return { source: 'POS', byMethod: totales };
    },
  });
}
