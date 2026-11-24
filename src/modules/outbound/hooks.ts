import { registerPlanPriceChangedHook } from '../catalog/index.js';
import { OutboundService } from './outbound.service.js';

/**
 * Cuando cambia el precio de un plan (D-19, bloque 3.6), los avisos a los
 * socios tocados nacen en ese momento y quedan en «Mensajes» para que
 * recepción los mande. Si esto falla, el job diario `outbound.generate` los
 * arma en su siguiente corrida. Se registra al montar el módulo (modules.ts).
 */
export function registerOutboundHooks(): void {
  registerPlanPriceChangedHook(async (e) => {
    await new OutboundService().avisarCambiosDePrecio(e.organizationId);
  });
}
