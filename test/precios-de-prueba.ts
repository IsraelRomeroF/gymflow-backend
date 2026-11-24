import { getDb } from '../src/platform/db/client.js';

/**
 * PRECIOS DE GYMFLOW PARA UNA PRUEBA (bloque 3.11).
 *
 * Desde D-38, cambiar por la API un precio que ya existe NO lo cambia en el
 * acto: lo anuncia con un mes de aviso. Una prueba que necesita «lo básico
 * cuesta $1,500» para armar su escenario no está probando ese anuncio: pone
 * el catálogo directo en la base con esto, igual que una siembra.
 *
 * `platform_prices` es global: quien lo use guarda lo que había y lo devuelve
 * al terminar (`preciosActuales` / `ponerPrecios`).
 */
export async function ponerPrecios(precios: Readonly<Record<string, bigint>>): Promise<void> {
  const db = getDb();
  await cancelarCambiosAnunciados(Object.keys(precios));
  for (const [moduleKey, monthlyCents] of Object.entries(precios)) {
    await db.platformPrice.upsert({ where: { moduleKey }, create: { moduleKey, monthlyCents }, update: { monthlyCents } });
  }
}

export async function preciosActuales(): Promise<Record<string, bigint>> {
  return Object.fromEntries((await getDb().platformPrice.findMany({ select: { moduleKey: true, monthlyCents: true } })).map((p) => [p.moduleKey, p.monthlyCents]));
}

/** Cancela los cambios de precio anunciados y sin aplicar de esos conceptos (los que dejó una prueba, esta u otra). */
export async function cancelarCambiosAnunciados(claves: readonly string[]): Promise<void> {
  await getDb().platformPriceChange.updateMany({
    where: { kind: 'PRICE', moduleKey: { in: [...claves] }, appliedAt: null, canceledAt: null },
    data: { canceledAt: new Date(), cancelReason: 'Limpieza de una prueba' },
  });
}
