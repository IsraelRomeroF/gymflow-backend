import type { PublicPlan } from '@gymflow/core/contracts';
import { PlanRepository } from '../catalog/index.js';

/**
 * LOS PLANES DE UNA SUCURSAL, PARA QUIEN ESCANEA EL QR (D-31, bloque 4.7).
 *
 * Quien escanea un cartel quiere saber cuánto cuesta antes de dar sus datos.
 * Se enseñan los planes activos que ESA sucursal vende, con su precio de
 * LISTA ahí (el propio de la sede si lo tiene): sin promociones, sin precios
 * acordados y sin nada interno del plan (días de gracia, reglas de
 * congelación, impuestos). Es lo mismo que recepción le diría en el mostrador.
 * Del más barato al más caro dentro de cada tipo, como en la venta.
 */
export async function planesPublicos(organizationId: string, branchId: string): Promise<PublicPlan[]> {
  const repo = new PlanRepository(organizationId);
  const planes = await repo.list({ activeOnly: true, branchId });
  const precios = await repo.effectivePricesAt(planes, branchId);
  return planes.flatMap((p) => {
    const precio = precios.get(p.id);
    if (precio === null || precio === undefined) return [];
    return [{
      id: p.id, name: p.name, description: p.description,
      billingModel: p.billingModel, durationUnit: p.durationUnit, durationValue: p.durationValue,
      priceCents: precio.toString(),
      // El pase del día no cobra inscripción aunque el plan la tenga escrita (así lo pinta Planes).
      signupFeeCents: p.billingModel === 'DAY_PASS' ? '0' : p.signupFeeCents.toString(),
      visitsIncluded: p.visitsIncluded,
    }];
  });
}
