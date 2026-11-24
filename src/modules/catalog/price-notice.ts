import { PriceChangeRepository } from './price-change.repository.js';

/**
 * EL AVISO DEL RECIBO (D-19, bloque 3.6): qué dice el comprobante de un pago
 * sobre el último cambio de precio que tocó a esa membresía.
 *
 *  - `UPCOMING`: el pago es posterior al cambio pero cubre cuotas emitidas
 *    antes (al precio anterior): «desde tu siguiente pago, tu plan cuesta…».
 *  - `APPLIED`: el pago cubre la PRIMERA cuota emitida después del cambio:
 *    «tu plan cambió de precio: de… a…».
 *  - `null`: el pago es anterior al cambio (un comprobante reimpreso no dice
 *    lo que pasó después), o ya no es el primero al precio nuevo.
 *
 * `cuotas` son las cuotas de periodo de la membresía: cuándo se emitió cada
 * una y si este pago la cubre. Las da `billing`, que es dueño de los cargos.
 */
export async function avisoDePrecioEnRecibo(organizationId: string, input: {
  membershipId: string; pagadoEn: Date; cuotas: ReadonlyArray<{ createdAt: Date; cubierta: boolean }>;
}): Promise<{ kind: 'UPCOMING' | 'APPLIED'; fromPriceCents: bigint; toPriceCents: bigint } | null> {
  const cambio = await new PriceChangeRepository(organizationId).ultimoDe(input.membershipId);
  if (!cambio || input.pagadoEn.getTime() < cambio.createdAt.getTime()) return null;
  const cubiertas = input.cuotas.filter((c) => c.cubierta);
  if (cubiertas.length === 0) return null;
  const precios = { fromPriceCents: cambio.fromPriceCents, toPriceCents: cambio.toPriceCents };
  const despues = (c: { createdAt: Date }) => c.createdAt.getTime() > cambio.createdAt.getTime();
  const nuevas = cubiertas.filter(despues);
  if (nuevas.length === 0) return { kind: 'UPCOMING', ...precios };
  // ¿Alguna de las que cubre es la primera cuota emitida después del cambio?
  const primera = Math.min(...input.cuotas.filter(despues).map((c) => c.createdAt.getTime()));
  return nuevas.some((c) => c.createdAt.getTime() === primera) ? { kind: 'APPLIED', ...precios } : null;
}
