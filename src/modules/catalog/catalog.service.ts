import { conflict, notFound, planIssues, validation, type PlanDraft } from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { enUnidadDeDinero } from '../../platform/db/unit-of-work.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import type { PlanImpact, PlanPriceChangePreview, PriceProtectionResult, ProtectedPrices } from '@gymflow/core/contracts';
import type { RequestContext } from '../../platform/context.js';
import { PlanRepository, type PlanRecord } from './plan.repository.js';
import { PriceChangeRepository } from './price-change.repository.js';
import { emitPlanPriceChanged } from './price-hooks.js';
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
   * A quién toca un cambio en el plan, por sucursal de venta (16-04). Con
   * `nuevoPrecio` dice además lo que haría ese cambio de precio (D-19): a
   * cuántos les cambia en su siguiente pago, cuánto, y cuántos conservan el
   * suyo. Solo cuenta: nada se escribe aquí.
   */
  async impacto(ctx: RequestContext, id: string, nuevoPrecio?: bigint): Promise<PlanImpact> {
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
      priceChange: nuevoPrecio !== undefined && nuevoPrecio !== plan.priceCents ? await this.vistaDelCambio(ctx, plan, nuevoPrecio) : null,
    };
  }

  /** Lo que haría cambiar el precio de lista de `plan` a `nuevo` (D-19). */
  private async vistaDelCambio(ctx: RequestContext, plan: PlanRecord, nuevo: bigint): Promise<PlanPriceChangePreview> {
    const orgId = ctx.tenant.organizationId;
    const hoy = await new BusinessCalendar(orgId).today(null);
    const c = await new PriceChangeRepository(orgId).contar(plan.id, plan.priceCents, nuevo, hoy);
    return {
      fromPriceCents: plan.priceCents.toString(), toPriceCents: nuevo.toString(), deltaCents: (nuevo - plan.priceCents).toString(),
      touched: c.touched, touchedAtListPrice: c.atList, touchedAtOtherPrice: c.touched - c.atList, touchedDeltaCents: c.touchedDelta.toString(),
      protected: c.protegidas, protectedDeltaCents: c.protectedDelta.toString(),
      atOwnPriceBranches: c.enSedesConPrecioPropio,
      firstPaymentOn: c.firstPaymentOn ? c.firstPaymentOn.toISOString().slice(0, 10) : null,
      touchedWithoutPhone: c.sinCelular,
    };
  }

  // ── «Conserva su precio» (D-19) ──────────────────────────────────────────

  /** Quiénes conservan su precio en un plan. */
  async preciosProtegidos(ctx: RequestContext, planId: string): Promise<ProtectedPrices> {
    const orgId = ctx.tenant.organizationId;
    if (!await new PlanRepository(orgId).findById(planId)) throw notFound('Plan no encontrado');
    const { total, filas } = await new PriceChangeRepository(orgId).protegidas(planId, 200);
    return {
      total,
      items: filas.map((f) => ({
        membershipId: f.membershipId, memberId: f.memberId, memberCode: f.memberCode, memberName: `${f.firstName} ${f.lastName}`.trim(),
        branchId: f.branchId, agreedPriceCents: f.agreedPriceCents.toString(), listPriceCents: f.listPriceCents.toString(), reason: f.reason,
      })),
    };
  }

  /**
   * Pone o quita la marca «conserva su precio» a UNA membresía viva, con
   * motivo y en la bitácora. Ponerla deja escrito lo que paga hoy (si pagaba
   * el de lista sin pactado, ese). Quitarla no le cambia el precio: solo hace
   * que el siguiente cambio de precio del plan también le toque.
   */
  async marcarPrecio(ctx: RequestContext, membershipId: string, protegida: boolean, reason: string): Promise<PriceProtectionResult> {
    const orgId = ctx.tenant.organizationId;
    return enUnidadDeDinero(orgId, async () => {
      const repo = new PriceChangeRepository(orgId);
      const m = await repo.paraMarcar(membershipId);
      if (!m) throw notFound('Membresía no encontrada');
      if (m.status === 'CANCELED' || m.status === 'EXPIRED') throw conflict('Esa membresía ya terminó: no tiene un precio que conservar', 'MEMBERSHIP_NOT_ACTIVE');
      if (m.priceProtected === protegida) {
        return { membershipId, priceProtected: protegida, agreedPriceCents: m.agreedPriceCents?.toString() ?? null, reason: m.priceProtectedReason };
      }
      const paga = m.agreedPriceCents ?? await new PlanRepository(orgId).listPriceAt(m.planId, m.soldAtBranchId);
      if (paga === null) throw notFound('Plan no encontrado');
      await repo.marcar(membershipId, { protegida, reason: protegida ? reason : null, agreedPriceCents: protegida ? paga : null });
      await this.audit.record(ctx, {
        action: protegida ? 'catalog.price_protection.set' : 'catalog.price_protection.clear',
        resourceType: 'Member', resourceId: m.memberId, branchId: m.soldAtBranchId, reason,
        beforeState: { membershipId, priceProtected: m.priceProtected, agreedPriceCents: m.agreedPriceCents?.toString() ?? null },
        afterState: { membershipId, priceProtected: protegida, agreedPriceCents: paga.toString() },
      });
      return { membershipId, priceProtected: protegida, agreedPriceCents: protegida ? paga.toString() : m.agreedPriceCents?.toString() ?? null, reason: protegida ? reason : null };
    });
  }

  /**
   * Edita un plan. `patch` trae solo lo que cambia, ya con el dinero en
   * centavos; `branchIds`, si viene, reemplaza dónde se vende.
   *
   * CAMBIAR EL PRECIO LE CAMBIA A TODOS EN SU SIGUIENTE PAGO (D-19): en la
   * misma transacción que el precio de lista se mueve el precio pactado de
   * las membresías vivas del plan (la misma diferencia a cada una). Las que
   * conservan su precio no cambian solas: si las hay, el pedido debe decir
   * qué se decide (`cambio.includeProtected`); sin esa decisión no se cambia
   * nada. `cambio.fromPriceCents` es el precio que vio quien confirma: si ya
   * no es ese, tampoco se cambia nada (doble envío, dos personas a la vez).
   * Lo ya cobrado y las cuotas ya emitidas no se tocan.
   */
  async editarPlan(
    ctx: RequestContext, id: string, pedido: Record<string, unknown>, branchIds: string[] | undefined, reason: string,
    cambio: { includeProtected?: boolean | undefined; fromPriceCents?: bigint | undefined } = {},
  ): Promise<PlanRecord> {
    const orgId = ctx.tenant.organizationId;
    const visto = await new PlanRepository(orgId).findById(id);
    if (!visto) throw notFound('Plan no encontrado');
    const cambiaPrecio = typeof pedido.priceCents === 'bigint' && pedido.priceCents !== visto.priceCents;
    if (!cambiaPrecio) return this.editarSinPrecio(ctx, id, pedido, branchIds, reason);

    const nuevo = pedido.priceCents as bigint;
    const hecho = await enUnidadDeDinero(orgId, async () => {
      // Con el turno tomado se vuelve a leer: el segundo de dos envíos ya ve el precio nuevo.
      const antes = await new PlanRepository(orgId).findById(id);
      if (!antes) throw notFound('Plan no encontrado');
      if (cambio.fromPriceCents !== undefined && cambio.fromPriceCents !== antes.priceCents) {
        throw conflict('El precio de este plan cambió mientras lo revisabas. Vuelve a abrirlo para ver a quién toca', 'PRICE_CHANGED_MEANWHILE');
      }
      if (antes.priceCents === nuevo) return { plan: await this.editarSinPrecio(ctx, id, pedido, branchIds, reason), cambioId: null as string | null };
      const cambios = new PriceChangeRepository(orgId);
      const hoy = await new BusinessCalendar(orgId).today(null);
      const cuenta = await cambios.contar(id, antes.priceCents, nuevo, hoy);
      if (cuenta.protegidas > 0 && cambio.includeProtected === undefined) {
        throw conflict(
          `${cuenta.protegidas} ${cuenta.protegidas === 1 ? 'socio conserva' : 'socios conservan'} su precio en este plan: decide si también les cambia antes de guardar`,
          'PRICE_CHANGE_NEEDS_DECISION',
        );
      }
      const incluir = cambio.includeProtected === true;
      const plan = await this.editarSinPrecio(ctx, id, pedido, branchIds, reason);
      const acto = await cambios.aplicar({
        planId: id, fromPriceCents: antes.priceCents, toPriceCents: nuevo, includeProtected: incluir,
        reason, userId: ctx.tenant.actorUserId ?? null, protectedKept: incluir ? 0 : cuenta.protegidas,
      });
      await this.audit.record(ctx, {
        action: 'catalog.plan.price_change', resourceType: 'plan', resourceId: id, reason,
        beforeState: { priceCents: antes.priceCents.toString() },
        afterState: {
          priceCents: nuevo.toString(), priceChangeId: acto.id, touched: acto.touched,
          protectedKept: incluir ? 0 : cuenta.protegidas, includedProtected: incluir, atOwnPriceBranches: cuenta.enSedesConPrecioPropio,
        },
      });
      return { plan, cambioId: acto.touched > 0 ? acto.id : null };
    });
    // El aviso al teléfono (bandeja de salida) nace ya confirmado el cambio. Si
    // falla, el cambio queda hecho y el job diario arma los avisos que falten.
    if (hecho.cambioId) await emitPlanPriceChanged({ organizationId: orgId, planId: id, priceChangeId: hecho.cambioId }).catch(() => undefined);
    return hecho.plan;
  }

  /** La edición de siempre: escribe lo que cambia, dónde se vende y su asiento. */
  private async editarSinPrecio(ctx: RequestContext, id: string, pedido: Record<string, unknown>, branchIds: string[] | undefined, reason: string): Promise<PlanRecord> {
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
