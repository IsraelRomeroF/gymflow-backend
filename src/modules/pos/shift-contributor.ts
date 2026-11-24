import { registerShiftContributor, type ShiftContribution } from '../cash/index.js';
import { PosSaleRepository } from './pos-sale.repository.js';
import { PosCorrectionRepository } from './correccion.repository.js';

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
  // D-13 (bloque 3.5): la devolución de una venta de OTRO día saca su dinero del turno abierto
  // hoy. Va aparte y en negativo para que el corte la diga con su nombre.
  registerShiftContributor({
    source: 'POS_RETURNS',
    async totalsForSession(organizationId: string, cashSessionId: string): Promise<ShiftContribution> {
      const devuelto = await new PosCorrectionRepository(organizationId).returnTotalsForSession(cashSessionId);
      return { source: 'POS_RETURNS', byMethod: devuelto.map((d) => ({ method: d.method, amountCents: -d.amountCents })) };
    },
  });
}
