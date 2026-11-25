import { PriceChangeRepository, type AumentoPorLlegar } from './price-change.repository.js';

export type { AumentoPorLlegar };

/**
 * LOS AUMENTOS POR LLEGAR (fase 4, bloque 4.20; P-14): la puerta de `catalog`
 * para quien emite o cotiza una cuota. Un aumento guardado no se le cobra a
 * nadie antes de 15 días: llega con la primera cuota que EMPIEZA y SE EMITE
 * desde su fecha «rige desde» (`precioConAumentos` del núcleo).
 */

/**
 * El precio de la cuota de esa membresía que empieza `inicio` y se emite
 * `emitidaEl`, partiendo de lo que paga hoy (`base`), y qué aumentos ya lleva.
 */
export async function precioDeLaCuotaConAumentos(
  organizationId: string, membershipId: string, base: bigint, cuota: { inicio: Date; emitidaEl: Date },
): Promise<{ precio: bigint; llegan: string[] }> {
  return new PriceChangeRepository(organizationId).paraCuota(membershipId, base, cuota);
}

/** La cuota `chargeId` salió a `precio` con esos aumentos: constancia y precio pactado nuevo, en la misma unidad. */
export async function registrarLlegadaDeAumento(
  organizationId: string, membershipId: string, aumentos: readonly string[], chargeId: string, precio: bigint,
): Promise<void> {
  await new PriceChangeRepository(organizationId).registrarLlegada(membershipId, aumentos, chargeId, precio);
}

/**
 * El aumento que todavía no le llega a esa membresía (para la ficha): a
 * cuánto pasa al final, desde cuándo rige el último y la previsión de su
 * primer cobro. `null` si no hay.
 */
export async function aumentoPendiente(
  organizationId: string, membershipId: string,
): Promise<{ toPriceCents: bigint; appliesFrom: Date; firstChargeOn: Date | null } | null> {
  const repo = new PriceChangeRepository(organizationId);
  const todos = await repo.porLlegar(membershipId);
  if (todos.length === 0) return null;
  const cambios = await repo.cambiosDe(membershipId);
  return { toPriceCents: cambios[cambios.length - 1]!.toPriceCents, appliesFrom: todos[todos.length - 1]!.appliesFrom, firstChargeOn: todos[0]!.firstChargeOn };
}
