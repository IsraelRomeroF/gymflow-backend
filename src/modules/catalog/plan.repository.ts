import { uuidv7 } from '@gymflow/core';
import { Prisma, PrismaMembershipStatus as MS, PrismaBillingModel, PrismaDurationUnit, PrismaBranchAccessScope } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

export type PlanRecord = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  billingModel: string;
  durationUnit: string;
  durationValue: number;
  priceCents: bigint;
  signupFeeCents: bigint;
  currency: string;
  taxRateBps: number | null;
  priceIncludesTax: boolean;
  branchAccessScope: string;
  /// ¿La cuota incluye las clases con cupo? Lo consume el módulo de clases.
  includesClasses: boolean;
  /// Con `includesClasses`: cuáles tipos de clase. Vacío = todas las incluibles (2026-10-09).
  includedClassTypeIds: string[];
  /// Ventanas horarias de acceso. Nulo = sin restricción horaria.
  /// Lo consume el motor de políticas del Sprint 7.
  accessTimeWindows: unknown;
  visitsIncluded: number | null;
  visitValidityDays: number | null;
  defaultGraceDays: number;
  allowFreeze: boolean;
  maxFreezeDaysPerYear: number;
  minFreezeDays: number;
  autoRenewDefault: boolean;
  isActive: boolean;
};

const SELECT = {
  id: true, code: true, name: true, description: true, billingModel: true,
  durationUnit: true, durationValue: true, priceCents: true, signupFeeCents: true,
  currency: true, taxRateBps: true, priceIncludesTax: true, branchAccessScope: true,
  accessTimeWindows: true, includesClasses: true, includedClassTypeIds: true,
  visitsIncluded: true, visitValidityDays: true, defaultGraceDays: true,
  allowFreeze: true, maxFreezeDaysPerYear: true, minFreezeDays: true,
  autoRenewDefault: true, isActive: true,
} as const;

export class PlanRepository extends TenantRepository {
  async list(opts: { activeOnly?: boolean; branchId?: string } = {}): Promise<PlanRecord[]> {
    const plans = await this.db.plan.findMany({
      where: this.scope({
        deletedAt: null,
        ...(opts.activeOnly === false ? {} : { isActive: true }),
        ...(opts.branchId
          ? { branchAvailability: { some: { branchId: opts.branchId, isAvailable: true } } }
          : {}),
      }),
      select: SELECT,
      orderBy: [{ billingModel: 'asc' }, { priceCents: 'asc' }],
    });
    return plans as PlanRecord[];
  }

  async findByIds(ids: readonly string[]): Promise<Map<string, PlanRecord>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.plan.findMany({ where: this.scope({ id: { in: [...new Set(ids)] } }), select: SELECT });
    return new Map((rows as PlanRecord[]).map((p) => [p.id, p]));
  }

  async findById(id: string): Promise<PlanRecord | null> {
    const plan = await this.db.plan.findFirst({
      where: this.scope({ id, deletedAt: null }),
      select: SELECT,
    });
    return plan as PlanRecord | null;
  }

  /**
   * Precio efectivo en una sucursal: el override si existe, si no el del plan.
   * Es la excepción documentada de §25 — precio por sede sin duplicar el plan.
   */
  async effectivePriceCents(planId: string, branchId: string | null): Promise<bigint | null> {
    const plan = await this.findById(planId);
    if (!plan) return null;
    if (!branchId) return plan.priceCents;

    const availability = await this.db.planBranchAvailability.findFirst({
      where: { planId, branchId, organizationId: this.organizationId },
      select: { isAvailable: true, priceOverrideCents: true },
    });
    if (availability && !availability.isAvailable) return null;
    return availability?.priceOverrideCents ?? plan.priceCents;
  }

  /**
   * Precio efectivo de VARIOS planes en una sucursal, en una sola consulta.
   * Es la misma regla que `effectivePriceCents`; por plan costaba dos
   * consultas y el catálogo hacía 511 con 255 planes (OPT-04).
   */
  async effectivePricesAt(plans: readonly PlanRecord[], branchId: string): Promise<Map<string, bigint | null>> {
    const filas = await this.db.planBranchAvailability.findMany({
      where: { organizationId: this.organizationId, branchId, planId: { in: plans.map((p) => p.id) } },
      select: { planId: true, isAvailable: true, priceOverrideCents: true },
    });
    const porPlan = new Map(filas.map((f) => [f.planId, f]));
    return new Map(plans.map((p) => {
      const a = porPlan.get(p.id);
      return [p.id, a && !a.isAvailable ? null : a?.priceOverrideCents ?? p.priceCents];
    }));
  }

  async availabilityFor(planId: string) {
    return this.db.planBranchAvailability.findMany({
      where: { planId, organizationId: this.organizationId },
      select: { branchId: true, isAvailable: true, priceOverrideCents: true },
    });
  }

  /** Disponibilidad y socios vivos de MUCHOS planes en dos consultas (OPT2-01). */
  async detailsFor(planIds: readonly string[]) {
    const [disp, vivos, paquetes] = await Promise.all([
      this.db.planBranchAvailability.findMany({
        where: { organizationId: this.organizationId, planId: { in: [...planIds] } },
        select: { planId: true, branchId: true, isAvailable: true, priceOverrideCents: true },
      }),
      this.db.membership.groupBy({
        by: ['planId'],
        where: this.scope({ planId: { in: [...planIds] }, status: { notIn: [MS.CANCELED, MS.EXPIRED] } }),
        _count: { _all: true },
      }),
      // Los paquetes de visitas no son membresías: sin esto el catálogo decía «0 socios» de un paquete que se vende a diario (16-05).
      this.db.visitPack.groupBy({
        by: ['planId'],
        where: { organizationId: this.organizationId, planId: { in: [...planIds] }, status: { in: ['PENDING_PAYMENT', 'ACTIVE', 'FROZEN'] } },
        _count: { _all: true },
      }),
    ]);
    const conteo = new Map(vivos.map((v) => [v.planId, v._count._all]));
    const vivosDe = new Map(paquetes.map((v) => [v.planId, v._count._all]));
    return new Map(planIds.map((id) => [id, {
      availability: disp.filter((d) => d.planId === id).map(({ planId: _p, ...d }) => d),
      liveMemberships: conteo.get(id) ?? 0,
      livePacks: vivosDe.get(id) ?? 0,
    }]));
  }

  async create(input: Omit<PlanRecord, 'id'>): Promise<PlanRecord> {
    const plan = await this.db.plan.create({
      data: {
        id: uuidv7(), organizationId: this.organizationId, ...enumsDePlan(input),
        billingModel: input.billingModel as PrismaBillingModel, durationUnit: input.durationUnit as PrismaDurationUnit,
        branchAccessScope: input.branchAccessScope as PrismaBranchAccessScope, accessTimeWindows: jsonDePlan(input.accessTimeWindows),
      },
      select: SELECT,
    });
    return plan as PlanRecord;
  }

  /**
   * Edita un plan. El código NO cambia: es la clave con la que el resto del
   * sistema (y la gente) se refiere al plan, y reutilizarlo confunde el
   * historial de ventas.
   */
  async update(id: string, patch: Partial<Omit<PlanRecord, 'id' | 'code'>>): Promise<PlanRecord | null> {
    const { count } = await this.db.plan.updateMany({
      where: this.scope({ id, deletedAt: null }),
      data: { ...enumsDePlan(patch), ...(patch.accessTimeWindows !== undefined ? { accessTimeWindows: jsonDePlan(patch.accessTimeWindows) } : {}) },
    });
    return count === 0 ? null : this.findById(id);
  }

  /** Cuántas membresías vivas lo usan: lo que se afecta al cambiar su precio. */
  async liveMembershipCount(planId: string): Promise<number> {
    return this.db.membership.count({
      where: this.scope({ planId, status: { notIn: [MS.CANCELED, MS.EXPIRED] } }),
    });
  }

  /**
   * En qué sucursales se vende. Se escribe una fila por CADA sucursal de la
   * organización —disponible o no— porque el catálogo por sede filtra por
   * esas filas: un plan sin ellas no aparece a la venta en ningún lado.
   * El precio especial por sede (override) no se toca.
   */
  async setAvailability(planId: string, availableBranchIds: readonly string[]): Promise<void> {
    const sedes = await this.db.branch.findMany({
      where: this.scope({ deletedAt: null }), select: { id: true },
    });
    const si = new Set(availableBranchIds);
    for (const b of sedes) {
      await this.db.planBranchAvailability.upsert({
        where: { planId_branchId: { planId, branchId: b.id } },
        create: { planId, branchId: b.id, organizationId: this.organizationId, isAvailable: si.has(b.id) },
        update: { isAvailable: si.has(b.id) },
      });
    }
  }

  /**
   * Lo que un cambio en el plan se lleva por delante, por sucursal de venta
   * (16-04): membresías vivas —con precio pactado o sin él— y paquetes de
   * visitas vivos. Tres consultas agrupadas, sin recorrer socios.
   */
  async impactOf(planId: string): Promise<{
    sedes: Array<{ id: string; name: string; isActive: boolean }>;
    disponibilidad: Array<{ branchId: string; isAvailable: boolean; priceOverrideCents: bigint | null }>;
    membresias: Array<{ branchId: string | null; pactado: boolean; n: number }>;
    paquetes: Array<{ branchId: string | null; n: number }>;
  }> {
    const vivas = this.scope({ planId, status: { notIn: [MS.CANCELED, MS.EXPIRED] } });
    const [sedes, disponibilidad, todas, pactadas, paquetes] = await Promise.all([
      this.db.branch.findMany({ where: this.scope({ deletedAt: null }), select: { id: true, name: true, isActive: true }, orderBy: { code: 'asc' } }),
      this.availabilityFor(planId),
      this.db.membership.groupBy({ by: ['soldAtBranchId'], where: vivas, _count: { _all: true } }),
      this.db.membership.groupBy({ by: ['soldAtBranchId'], where: { ...vivas, agreedPriceCents: { not: null } }, _count: { _all: true } }),
      this.db.visitPack.groupBy({
        by: ['soldAtBranchId'],
        where: { organizationId: this.organizationId, planId, status: { in: ['PENDING_PAYMENT', 'ACTIVE', 'FROZEN'] } },
        _count: { _all: true },
      }),
    ]);
    const conPacto = new Map(pactadas.map((p) => [p.soldAtBranchId, p._count._all]));
    return {
      sedes, disponibilidad,
      membresias: todas.flatMap((t) => {
        const si = conPacto.get(t.soldAtBranchId) ?? 0;
        return [{ branchId: t.soldAtBranchId, pactado: true, n: si }, { branchId: t.soldAtBranchId, pactado: false, n: t._count._all - si }];
      }),
      paquetes: paquetes.map((x) => ({ branchId: x.soldAtBranchId, n: x._count._all })),
    };
  }

  async activeBranchIds(): Promise<string[]> {
    const rows = await this.db.branch.findMany({ where: this.scope({ deletedAt: null, isActive: true }), select: { id: true } });
    return rows.map((r) => r.id);
  }
}

/** Los tres campos que la base guarda como enum: el dominio los valida antes; aquí solo se les pone el tipo. */
function enumsDePlan<T extends Partial<Pick<PlanRecord, 'billingModel' | 'durationUnit' | 'branchAccessScope' | 'accessTimeWindows'>>>(p: T) {
  const { accessTimeWindows: _omitido, billingModel, durationUnit, branchAccessScope, ...resto } = p;
  void _omitido;
  return {
    ...resto,
    ...(billingModel !== undefined ? { billingModel: billingModel as PrismaBillingModel } : {}),
    ...(durationUnit !== undefined ? { durationUnit: durationUnit as PrismaDurationUnit } : {}),
    ...(branchAccessScope !== undefined ? { branchAccessScope: branchAccessScope as PrismaBranchAccessScope } : {}),
  };
}

function jsonDePlan(v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return v == null ? Prisma.JsonNull : (v as Prisma.InputJsonValue);
}
