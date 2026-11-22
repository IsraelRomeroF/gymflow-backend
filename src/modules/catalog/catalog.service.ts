import { conflict, notFound, planIssues, validation, type PlanDraft } from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import type { PlanImpact } from '@gymflow/core/contracts';
import type { RequestContext } from '../../platform/context.js';
import { PlanRepository, type PlanRecord } from './plan.repository.js';
import { pick, serializePlan } from './catalog.serializers.js';

function draftOf(p: Omit<PlanRecord, 'id'>): PlanDraft {
  return {
    code: p.code, name: p.name,
    billingModel: p.billingModel as PlanDraft['billingModel'],
    durationUnit: p.durationUnit as PlanDraft['durationUnit'],
    durationValue: p.durationValue, priceCents: p.priceCents, signupFeeCents: p.signupFeeCents,
    taxRateBps: p.taxRateBps, visitsIncluded: p.visitsIncluded, visitValidityDays: p.visitValidityDays,
    defaultGraceDays: p.defaultGraceDays, allowFreeze: p.allowFreeze,
    maxFreezeDaysPerYear: p.maxFreezeDaysPerYear, minFreezeDays: p.minFreezeDays,
  };
}

/** Todos los problemas juntos, con el campo: el formulario marca cada uno. */
function exigirCoherencia(p: Omit<PlanRecord, 'id'>): void {
  const issues = planIssues(draftOf(p));
  if (issues.length > 0) throw validation(issues[0]!.message, JSON.stringify(issues));
}

/**
 * La visita suelta se vende como pase del día (bloque 1.8): vale el día en que
 * se compra, nunca cobra inscripción (D-20) y no tiene gracia, congelamiento
 * ni renovación. Esos campos ya no se ofrecen en el formulario (16-08, 16-11)
 * y aquí se guardan en su valor neutro, los mande quien los mande: un plan de
 * visita con «5 días de gracia» prometía en el catálogo algo que no pasa.
 */
export const NEUTRO_DE_VISITA_SUELTA = {
  durationUnit: 'DAY', durationValue: 1, signupFeeCents: 0n, defaultGraceDays: 0,
  allowFreeze: false, autoRenewDefault: false, visitsIncluded: null, visitValidityDays: null,
} as const;

/** Todas las sucursales vigentes de la organización. */
async function sedesDe(repo: PlanRepository): Promise<string[]> {
  return repo.activeBranchIds();
}

/**
 * EL CATÁLOGO DE PLANES: dar de alta y editar con las reglas del núcleo
 * (`planIssues`) y su rastro en la bitácora. Vivía dentro de las rutas; las
 * rutas ahora solo traducen la petición (auditoría 8, bloque 1.7; A3). Aquí
 * crecerán los precios por sede y el impacto de un plan (informe 16).
 */
export class CatalogService {
  private readonly audit = new AuditService();

  /** Alta de un plan y de las sucursales donde se vende (todas, si no se dicen). */
  async crearPlan(ctx: RequestContext, pedido: Omit<PlanRecord, 'id'>, branchIds: string[] | undefined, reason: string): Promise<PlanRecord> {
    const plan = pedido.billingModel === 'DAY_PASS' ? { ...pedido, ...NEUTRO_DE_VISITA_SUELTA } : pedido;
    exigirCoherencia(plan);

    let creado: PlanRecord;
    try {
      creado = await new PlanRepository(ctx.tenant.organizationId).create(plan);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`Ya existe un plan con el código ${plan.code}`);
      throw err;
    }
    const repo = new PlanRepository(ctx.tenant.organizationId);
    await repo.setAvailability(creado.id, branchIds ?? await sedesDe(repo));

    await this.audit.record(ctx, {
      action: 'catalog.plan.create',
      resourceType: 'plan',
      resourceId: creado.id,
      reason,
      afterState: { code: creado.code, name: creado.name, priceCents: creado.priceCents.toString(), branchIds: branchIds ?? 'todas' },
    });
    return creado;
  }

  /**
   * A quién toca un cambio en el plan, por sucursal de venta (16-04). Solo
   * cuenta: la regla de precio no cambia aquí (`precioDeCuota`: el pactado, si
   * no el propio de la sede, si no el de lista; D-19 es de la fase 3).
   */
  async impacto(ctx: RequestContext, id: string): Promise<PlanImpact> {
    const repo = new PlanRepository(ctx.tenant.organizationId);
    const plan = await repo.findById(id);
    if (!plan) throw notFound('Plan no encontrado');
    const { sedes, disponibilidad, membresias, paquetes } = await repo.impactOf(id);
    const cuenta = (branchId: string | null) => {
      const con = membresias.find((m) => m.branchId === branchId && m.pactado)?.n ?? 0;
      const sin = membresias.find((m) => m.branchId === branchId && !m.pactado)?.n ?? 0;
      return { liveMemberships: con + sin, withAgreedPrice: con, withoutAgreedPrice: sin, livePacks: paquetes.find((p) => p.branchId === branchId)?.n ?? 0 };
    };
    const filas = sedes.map((b) => {
      const d = disponibilidad.find((x) => x.branchId === b.id);
      const propio = d?.priceOverrideCents ?? null;
      return {
        branchId: b.id as string | null, name: b.name, isOpen: b.isActive, isAvailable: b.isActive && plan.isActive && d?.isAvailable === true,
        listPriceCents: (propio ?? plan.priceCents).toString(), hasOwnPrice: propio !== null && propio !== plan.priceCents,
        ...cuenta(b.id),
      };
    }).filter((f) => f.isOpen || f.liveMemberships > 0 || f.livePacks > 0);
    const sinSede = cuenta(null);
    if (sinSede.liveMemberships > 0 || sinSede.livePacks > 0) {
      filas.push({ branchId: null, name: 'Sin sucursal de venta', isOpen: true, isAvailable: false, listPriceCents: plan.priceCents.toString(), hasOwnPrice: false, ...sinSede });
    }
    const suma = (k: 'liveMemberships' | 'withAgreedPrice' | 'withoutAgreedPrice' | 'livePacks') => filas.reduce((a, f) => a + f[k], 0);
    return {
      planId: plan.id, isActive: plan.isActive, priceCents: plan.priceCents.toString(),
      liveMemberships: suma('liveMemberships'), withAgreedPrice: suma('withAgreedPrice'), withoutAgreedPrice: suma('withoutAgreedPrice'), livePacks: suma('livePacks'),
      branches: filas,
    };
  }

  /**
   * Edita un plan. `patch` trae solo lo que cambia, ya con el dinero en
   * centavos; `branchIds`, si viene, reemplaza dónde se vende.
   */
  async editarPlan(ctx: RequestContext, id: string, pedido: Record<string, unknown>, branchIds: string[] | undefined, reason: string): Promise<PlanRecord> {
    const repo = new PlanRepository(ctx.tenant.organizationId);
    const antes = await repo.findById(id);
    if (!antes) throw notFound('Plan no encontrado');
    // Una visita suelta (o un plan que pasa a serlo) queda con sus campos neutros; solo se escribe lo que cambia.
    const patch: Record<string, unknown> = { ...pedido };
    if ((patch.billingModel ?? antes.billingModel) === 'DAY_PASS') {
      for (const [k, v] of Object.entries(NEUTRO_DE_VISITA_SUELTA)) {
        if (antes[k as keyof PlanRecord] !== v) patch[k] = v; else delete patch[k];
      }
    }

    const { id: _id, ...base } = antes;
    exigirCoherencia({ ...base, ...patch } as Omit<PlanRecord, 'id'>);

    const despues = Object.keys(patch).length > 0 ? await repo.update(id, patch as Partial<Omit<PlanRecord, 'id' | 'code'>>) : antes;
    if (!despues) throw notFound('Plan no encontrado');
    const sedesAntes = branchIds ? (await repo.availabilityFor(id)).filter((a) => a.isAvailable).map((a) => a.branchId) : null;
    if (branchIds) await repo.setAvailability(id, branchIds);

    await this.audit.record(ctx, {
      action: 'catalog.plan.update',
      resourceType: 'plan',
      resourceId: id,
      reason,
      beforeState: { ...pick(serializePlan(antes), Object.keys(patch)), ...(sedesAntes ? { branchIds: sedesAntes } : {}) },
      afterState: { ...pick(serializePlan(despues), Object.keys(patch)), ...(branchIds ? { branchIds } : {}) },
    });
    return despues;
  }
}
