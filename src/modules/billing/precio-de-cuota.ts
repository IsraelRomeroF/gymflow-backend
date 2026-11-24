import { precioDeCuota } from '@gymflow/core';
import { PlanRepository, type PlanRecord } from '../catalog/index.js';

/**
 * LA CUOTA de una membresía (fase 1.3; 16-04): la única puerta del servidor a
 * `precioDeCuota` del núcleo. La usan la cuota del periodo, el adeudo de una
 * suspendida («Decidir adeudo») y el cambio de plan.
 *
 * El pactado manda; sin pactado (membresías anteriores a DM-05), el precio
 * propio del plan en la sede de la venta y, si no tiene, el de lista. Que la
 * sede ya no VENDA el plan no cambia la cuota de quien lo compró ahí: antes
 * la renovación fallaba cada noche con 409 y el adeudo se cotizaba con el
 * precio de lista aunque la membresía tuviera otro pactado.
 *
 * D-19 (fase 3, bloque 3.6): la regla de aquí NO cambió. Lo que cambió es
 * quién escribe el pactado: cada cambio de precio de un plan lo mueve, en su
 * misma transacción, en las membresías vivas que no «conservan su precio»
 * (`catalog/price-change.repository.ts`). Por eso la siguiente cuota de cada
 * socio sale ya al precio nuevo sin que esta función sepa del cambio.
 */
export async function precioDeCuotaDe(
  organizationId: string,
  membresia: { agreedPriceCents: bigint | null; soldAtBranchId: string | null },
  plan: PlanRecord,
): Promise<bigint> {
  if (membresia.agreedPriceCents !== null) return membresia.agreedPriceCents;
  const sede = membresia.soldAtBranchId
    ? (await new PlanRepository(organizationId).availabilityFor(plan.id)).find((a) => a.branchId === membresia.soldAtBranchId)
    : undefined;
  return precioDeCuota({ agreedPriceCents: null, planPriceCents: plan.priceCents, branchPriceCents: sede?.priceOverrideCents ?? null });
}
