import type { RequestContext } from '../context.js';

/**
 * LO QUE HAY QUE RESOLVER ANTES DE DAR DE BAJA A ALGUIEN DEL PERSONAL
 * (auditoría 8, fase 2, bloque 2.6; hallazgo 12-07).
 *
 * `identity` da de baja; no sabe qué deja pendiente esa persona en los demás
 * módulos. Cada módulo que tenga algo que decir se inscribe aquí al arrancar
 * (como los ganchos de entrada y de uso de módulos) y corre DENTRO de la
 * transacción de la baja: si lanza, la baja no ocurre.
 *
 * Hoy: `training` pregunta a quién pasan los socios de un coach.
 */
export type OpcionesDeBaja = {
  /** A quién pasan los socios del coach: otro coach, o `null` = se quedan sin coach. */
  coachHandover?: { toUserId: string | null } | undefined;
};
type AntesDeLaBaja = (ctx: RequestContext, userId: string, opciones: OpcionesDeBaja) => Promise<void>;

const ganchos: AntesDeLaBaja[] = [];

export function registrarAntesDeLaBaja(fn: AntesDeLaBaja): void { ganchos.push(fn); }

/** Lo llama `identity` dentro de la transacción de la baja. */
export async function antesDeLaBaja(ctx: RequestContext, userId: string, opciones: OpcionesDeBaja): Promise<void> {
  for (const g of ganchos) await g(ctx, userId, opciones);
}
