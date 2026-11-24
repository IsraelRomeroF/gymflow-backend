import { notFound } from '@gymflow/core';
import type { PortalOffer, PortalOfferPlan } from '@gymflow/core/contracts';
import { isModuleOn } from '../../platform/modules/module-state.js';
import { precioDeCuotaDe } from '../billing/index.js';
import { PlanRepository, type PlanRecord } from '../catalog/index.js';
import { MemberRepository } from '../members/index.js';
import { MembershipRepository } from '../memberships/index.js';
import { BranchRepository } from '../organization/index.js';
import { PortalRepository } from './portal.repository.js';

/**
 * LO QUE EL SOCIO PUEDE RENOVAR O COMPRAR, A PRECIO DE LISTA (fase 3, bloque
 * 3.10; D-35 opción c, la parte que NO depende del procesador de pagos).
 *
 * D-35 dice que el socio renovará, cambiará de plan y comprará paquetes y
 * clases sueltas desde su teléfono «cuando haya cobro en línea», que es de la
 * fase 5. Mientras tanto esto es SOLO LECTURA: le dice qué hay y cuánto
 * cuesta para que llegue al mostrador sabiéndolo. No vende, no aparta, no
 * crea cargos y no mueve dinero: aquí no hay ninguna escritura.
 *
 * Los precios son los de LISTA en su sede de casa (el propio de la sede si lo
 * tiene). Las promociones y los descuentos de estudiante o de familia NO se
 * calculan aquí: «eso sigue en el mostrador» (D-35). La única excepción es
 * renovar su mismo plan mientras su membresía sigue viva: ahí el precio es el
 * que ya tiene (`precioDeCuotaDe`, la misma puerta que emite su cuota), porque
 * decirle otro sería decirle algo falso.
 */

const TIPO: Readonly<Record<string, PortalOfferPlan['kind']>> = {
  RECURRING: 'PLAN', PREPAID_PERIOD: 'PLAN', VISIT_PACK: 'VISIT_PACK', DAY_PASS: 'DAY_PASS',
};
const ORDEN: Readonly<Record<PortalOfferPlan['kind'], number>> = { PLAN: 0, VISIT_PACK: 1, DAY_PASS: 2 };
/** Una membresía que todavía es suya: renovar es pagar su siguiente periodo. */
const VIVA = new Set(['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'FROZEN']);
const fecha = (d: Date) => d.toISOString().slice(0, 10);

export async function ofertaPara(organizationId: string, memberId: string): Promise<PortalOffer> {
  const socio = await new MemberRepository(organizationId).findById(memberId);
  if (!socio) throw notFound('Socio no encontrado');
  const planes = new PlanRepository(organizationId);
  const sede = socio.homeBranchId;

  const [enVenta, membresias, sedes, conClases] = await Promise.all([
    // Con sede de casa: lo que se vende AHÍ. Sin sede: el catálogo del gimnasio a precio de lista.
    planes.list(sede ? { branchId: sede } : {}),
    new MembershipRepository(organizationId).listForMember(memberId),
    new BranchRepository(organizationId).list(),
    isModuleOn(organizationId, 'classes'),
  ]);
  const precios = sede ? await planes.effectivePricesAt(enVenta, sede) : new Map(enVenta.map((p) => [p.id, p.priceCents] as const));

  // Su plan: el de la membresía que todavía es suya o, si no hay, el de la última que tuvo.
  const actual = membresias.find((m) => VIVA.has(m.status)) ?? null;
  const ultima = actual ?? membresias.find((m) => m.status === 'EXPIRED' || m.status === 'CANCELED') ?? null;

  const plans: PortalOfferPlan[] = enVenta
    .map((p): PortalOfferPlan | null => {
      const precio = precios.get(p.id) ?? null;
      const kind = TIPO[p.billingModel];
      if (precio === null || !kind) return null;
      return {
        id: p.id, name: p.name, description: p.description, kind,
        priceCents: precio.toString(), signupFeeCents: p.signupFeeCents.toString(),
        durationUnit: p.durationUnit as PortalOfferPlan['durationUnit'], durationValue: p.durationValue,
        visitsIncluded: p.visitsIncluded, visitValidityDays: p.visitValidityDays,
        includesClasses: p.includesClasses, current: ultima?.planId === p.id,
      };
    })
    .filter((p): p is PortalOfferPlan => p !== null)
    .sort((a, b) => ORDEN[a.kind] - ORDEN[b.kind] || Number(BigInt(a.priceCents) - BigInt(b.priceCents)) || a.name.localeCompare(b.name, 'es'));

  return {
    branchName: sede ? sedes.find((b) => b.id === sede)?.name ?? null : null,
    // Comprar desde el teléfono llega con el cobro en línea (fase 5). Hoy siempre se paga en recepción.
    purchasable: false,
    renewal: await renovacion(organizationId, planes, actual, ultima, plans),
    plans,
    classes: conClases
      ? (await new PortalRepository(organizationId).clasesConPrecio()).map((c) => ({ id: c.id, name: c.name, dropInPriceCents: c.dropInPriceCents.toString() }))
      : [],
  };
}

/** Renovar su mismo plan (D-35 b, que la opción c incluye): al precio que tiene si sigue viva; al de lista si ya terminó. */
async function renovacion(
  organizationId: string, planes: PlanRepository,
  actual: { planId: string; currentPeriodEnd: Date; autoRenew: boolean; agreedPriceCents: bigint | null; soldAtBranchId: string | null } | null,
  ultima: { planId: string } | null, enVenta: readonly PortalOfferPlan[],
): Promise<PortalOffer['renewal']> {
  if (actual) {
    const plan: PlanRecord | null = await planes.findById(actual.planId);
    // Un paquete o un pase no se «renuevan»: se compra otro, y está en la lista.
    if (!plan || TIPO[plan.billingModel] !== 'PLAN') return null;
    return {
      planId: plan.id, planName: plan.name, priceKind: 'AGREED',
      priceCents: (await precioDeCuotaDe(organizationId, actual, plan)).toString(),
      from: fecha(actual.currentPeriodEnd), autoRenew: actual.autoRenew,
    };
  }
  // Ya terminó: vuelve a su plan al precio de lista, si todavía se vende en su sede.
  const elSuyo = ultima ? enVenta.find((p) => p.id === ultima.planId && p.kind === 'PLAN') : undefined;
  return elSuyo ? { planId: elSuyo.id, planName: elSuyo.name, priceKind: 'LIST', priceCents: elSuyo.priceCents, from: null, autoRenew: false } : null;
}
