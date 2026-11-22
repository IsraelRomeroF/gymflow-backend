import { registerMembershipClosedHook } from '../memberships/index.js';
import { ChargeRepository } from './charge.repository.js';
import { BillingService } from './billing.service.js';

/**
 * Cuando una membresía se cancela, sus cuotas sin ningún pago dejan de ser
 * deuda (DM-03): se anulan con el motivo del cierre y el saldo cacheado se
 * recalcula. Al expirar una suspendida la deuda se queda: cobrarla o
 * condonarla es de la gerencia. Se registra al montar el módulo (modules.ts).
 */
export function registerBillingHooks(): void {
  registerMembershipClosedHook(async (e) => {
    if (e.outcome === 'CANCELED') {
      await new ChargeRepository(e.organizationId).voidUnpaidForMembership(e.membershipId, `Membresía cancelada: ${e.reason}`);
    }
    await new BillingService().refreshCachedBalance(e.organizationId, e.memberId);
  });
}
