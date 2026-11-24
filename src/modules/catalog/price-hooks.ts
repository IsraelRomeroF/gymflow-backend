/**
 * «Cambió el precio de un plan» (D-19, bloque 3.6): lo que otros módulos
 * hacen DESPUÉS de que el cambio quedó confirmado. `catalog` no sabe quién
 * escucha; hoy se registra la bandeja de salida, que arma el aviso al
 * teléfono de cada socio tocado. Mismo patrón que `memberships/closed-hooks`.
 */
export type PlanPriceChanged = { organizationId: string; planId: string; priceChangeId: string };

type Hook = (evento: PlanPriceChanged) => Promise<void>;
const ganchos: Hook[] = [];

export function registerPlanPriceChangedHook(fn: Hook): void {
  if (!ganchos.includes(fn)) ganchos.push(fn);
}

export async function emitPlanPriceChanged(evento: PlanPriceChanged): Promise<void> {
  for (const g of ganchos) await g(evento);
}
