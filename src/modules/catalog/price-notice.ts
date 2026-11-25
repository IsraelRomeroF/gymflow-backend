import { PriceChangeRepository } from './price-change.repository.js';

/**
 * EL AVISO DEL RECIBO (D-19, bloque 3.6; 4.20, P-14): qué dice el
 * comprobante de un pago sobre el último cambio de precio que tocó a esa
 * membresía.
 *
 *  - `UPCOMING`: el pago es posterior al cambio pero cubre cuotas al precio
 *    anterior: «a partir del <día>, tu plan cuesta…». `startsOn` es la
 *    previsión del primer pago al precio nuevo (o, sin ella, desde cuándo
 *    rige); `null` en bajadas y cambios anteriores a 4.20 («desde tu
 *    siguiente pago»).
 *  - `APPLIED`: el pago cubre la PRIMERA cuota al precio nuevo: «tu plan
 *    cambió de precio: de… a…».
 *  - `null`: el pago es anterior al cambio (un comprobante reimpreso no dice
 *    lo que pasó después), o ya no es el primero al precio nuevo.
 *
 * Un aumento con 15 días de aviso (4.20) sabe con qué cuota llegó
 * (`membership_price_applications`); mientras no llega, todo pago es «lo que
 * viene». Una bajada, o un cambio anterior a 4.20, rige al guardarse: la
 * primera cuota emitida después es la del precio nuevo, como en 3.6.
 *
 * `cuotas` son las cuotas de periodo de la membresía: cuándo se emitió cada
 * una, cuál es y si este pago la cubre. Las da `billing`, que es dueño de los cargos.
 */
export async function avisoDePrecioEnRecibo(organizationId: string, input: {
  membershipId: string; pagadoEn: Date; cuotas: ReadonlyArray<{ id?: string; createdAt: Date; cubierta: boolean }>;
}): Promise<{ kind: 'UPCOMING' | 'APPLIED'; fromPriceCents: bigint; toPriceCents: bigint; startsOn: Date | null } | null> {
  const cambio = await new PriceChangeRepository(organizationId).ultimoDe(input.membershipId);
  if (!cambio || input.pagadoEn.getTime() < cambio.createdAt.getTime()) return null;
  const cubiertas = input.cuotas.filter((c) => c.cubierta);
  if (cubiertas.length === 0) return null;
  const precios = { fromPriceCents: cambio.fromPriceCents, toPriceCents: cambio.toPriceCents };
  const porVenir = { kind: 'UPCOMING' as const, ...precios, startsOn: cambio.firstChargeOn ?? cambio.appliesFrom };

  if (cambio.appliesFrom !== null) {
    // Aumento con aviso (4.20): ¿ya llegó, y con qué cuota?
    if (!cambio.aplicado) return porVenir;
    const llego = input.cuotas.find((c) => c.id !== undefined && c.id === cambio.aplicadoConCuota);
    if (llego?.cubierta) return { kind: 'APPLIED', ...precios, startsOn: null };
    if (llego && cubiertas.every((c) => c.createdAt.getTime() < llego.createdAt.getTime())) return porVenir;
    return null;
  }

  const despues = (c: { createdAt: Date }) => c.createdAt.getTime() > cambio.createdAt.getTime();
  const nuevas = cubiertas.filter(despues);
  if (nuevas.length === 0) return { kind: 'UPCOMING', ...precios, startsOn: null };
  // ¿Alguna de las que cubre es la primera cuota emitida después del cambio?
  const primera = Math.min(...input.cuotas.filter(despues).map((c) => c.createdAt.getTime()));
  return nuevas.some((c) => c.createdAt.getTime() === primera) ? { kind: 'APPLIED', ...precios, startsOn: null } : null;
}
