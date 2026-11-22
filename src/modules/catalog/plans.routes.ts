import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '@gymflow/core';
import { PlanImpact } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { PlanRepository, type PlanRecord } from './plan.repository.js';
import { CatalogService } from './catalog.service.js';
import { serializePlan } from './catalog.serializers.js';

const idParam = z.object({ id: z.string().uuid() });
const centavos = z.string().regex(/^[0-9]+$/, 'Importe en centavos');

/** Campos editables de un plan. El código solo se fija al crearlo. */
const planFields = {
  name: z.string().min(1).max(80),
  description: z.string().max(300).nullish().transform((v) => v ?? null),
  billingModel: z.enum(['RECURRING', 'PREPAID_PERIOD', 'VISIT_PACK', 'DAY_PASS']),
  durationUnit: z.enum(['DAY', 'WEEK', 'MONTH', 'VISIT']),
  durationValue: z.number().int(),
  priceCents: centavos,
  signupFeeCents: centavos.default('0'),
  taxRateBps: z.number().int().nullable().default(null),
  priceIncludesTax: z.boolean().default(true),
  branchAccessScope: z.enum(['HOME_BRANCH', 'LISTED_BRANCHES', 'ALL_BRANCHES']).default('HOME_BRANCH'),
  includesClasses: z.boolean().default(false),
  /** Cuáles clases incluye; vacío = todas las que se pueden incluir en un plan. */
  includedClassTypeIds: z.array(z.string().uuid()).max(100).default([]),
  visitsIncluded: z.number().int().nullable().default(null),
  visitValidityDays: z.number().int().nullable().default(null),
  defaultGraceDays: z.number().int().default(5),
  allowFreeze: z.boolean().default(true),
  maxFreezeDaysPerYear: z.number().int().default(30),
  minFreezeDays: z.number().int().default(7),
  autoRenewDefault: z.boolean().default(true),
  isActive: z.boolean().default(true),
};

/** Sucursales donde se vende. Ausente al crear = en todas. */
const branchIdsField = z.array(z.string().uuid()).min(1, 'Se tiene que vender en al menos una sucursal');

/** Los planes: la lista con su precio por sede, el detalle, el alta y la edición. */
export function registerPlanRoutes(app: FastifyInstance): void {
  const service = new CatalogService();

  route(app, {
    method: 'GET',
    url: '/plans',
    security: { kind: 'permission', permission: 'catalog:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const query = z.object({
        branchId: z.string().uuid().optional(),
        includeInactive: z.coerce.boolean().default(false),
        // La pantalla de Planes pide todo junto: antes hacía una petición por plan (OPT2-01).
        include: z.enum(['details']).optional(),
      }).parse(request.query);

      const repo = new PlanRepository(ctx.tenant.organizationId);
      const plans = await repo.list({
        activeOnly: !query.includeInactive,
        ...(query.branchId ? { branchId: query.branchId } : {}),
      });

      // El precio efectivo depende de la sucursal: override si existe.
      const precios = query.branchId ? await repo.effectivePricesAt(plans, query.branchId) : null;
      const detalles = query.include === 'details' ? await repo.detailsFor(plans.map((p) => p.id)) : null;
      return plans.map((plan) => ({
        ...serializePlan(plan),
        effectivePriceCents: precios
          ? precios.get(plan.id)?.toString() ?? null
          : plan.priceCents.toString(),
        ...(detalles ? {
          availability: detalles.get(plan.id)!.availability.map((a) => ({
            ...a, priceOverrideCents: a.priceOverrideCents === null ? null : a.priceOverrideCents.toString(),
          })),
          liveMemberships: detalles.get(plan.id)!.liveMemberships,
          livePacks: detalles.get(plan.id)!.livePacks,
        } : {}),
      }));
    },
  });

  // ── Alta y edición ────────────────────────────────────────────────────────

  route(app, {
    method: 'POST',
    url: '/plans',
    security: { kind: 'permission', permission: 'catalog:manage' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = z.object({
        code: z.string().transform((v) => v.trim().toUpperCase()),
        ...planFields,
        branchIds: branchIdsField.optional(),
        reason: z.string().min(3).max(300),
      }).parse(request.body);
      // El precio y la disponibilidad de un plan valen para todo el gimnasio (SEC2-04).
      request.authorize('catalog:manage', { reason: body.reason, branchId: null });

      const { reason, branchIds, ...datos } = body;
      const plan: Omit<PlanRecord, 'id'> = {
        ...datos,
        priceCents: BigInt(datos.priceCents),
        signupFeeCents: BigInt(datos.signupFeeCents),
        currency: 'MXN',
        accessTimeWindows: null,
      };
      const creado = await service.crearPlan(ctx, plan, branchIds, reason);
      return reply.status(201).send(serializePlan(creado));
    },
  });

  /**
   * Edita un plan. Cambiar el precio no toca lo ya cobrado ni las cuotas de
   * quien ya tiene el plan: cada venta deja escrito su precio (DM-05,
   * `agreedPriceCents`, el de lista si no se pactó otro) y renueva con él. El
   * precio nuevo vale para las ventas nuevas y para quien quedó sin precio
   * pactado (un cambio de plan lo borra). Aun así exige motivo y queda en la
   * bitácora con el antes y el después.
   */
  route(app, {
    method: 'PATCH',
    url: '/plans/:id',
    security: { kind: 'permission', permission: 'catalog:manage' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        ...Object.fromEntries(Object.entries(planFields).map(([k, v]) => [k, v.optional()])),
        branchIds: branchIdsField.optional(),
        reason: z.string().min(3).max(300),
      }).parse(request.body) as Record<string, unknown> & { reason: string; branchIds?: string[] };
      // El precio y la disponibilidad de un plan valen para todo el gimnasio (SEC2-04).
      request.authorize('catalog:manage', { reason: body.reason, branchId: null });

      const { reason, branchIds, ...cambios } = body;
      const patch: Record<string, unknown> = { ...cambios };
      if (typeof cambios.priceCents === 'string') patch.priceCents = BigInt(cambios.priceCents);
      if (typeof cambios.signupFeeCents === 'string') patch.signupFeeCents = BigInt(cambios.signupFeeCents);
      for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];

      const despues = await service.editarPlan(ctx, id, patch, branchIds, reason);
      return serializePlan(despues);
    },
  });

  /**
   * Impacto de un cambio (16-04): cuántas membresías y paquetes vivos tiene el
   * plan en cada sucursal de venta, y cuántas renuevan a su precio pactado. Lo
   * lee el formulario antes de subir un precio, apagar una sede o desactivar
   * el plan. Es de quien arma el catálogo, y de todo el gimnasio.
   */
  route(app, {
    method: 'GET',
    url: '/plans/:id/impact',
    security: { kind: 'permission', permission: 'catalog:manage' },
    schema: respuesta(200, PlanImpact),
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      request.requirePermission('catalog:manage', null);
      return service.impacto(request.ctx!, id);
    },
  });

  route(app, {
    method: 'GET',
    url: '/plans/:id',
    security: { kind: 'permission', permission: 'catalog:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const repo = new PlanRepository(ctx.tenant.organizationId);
      const plan = await repo.findById(id);
      if (!plan) throw notFound('Plan no encontrado');
      return {
        ...serializePlan(plan),
        // El precio especial por sede es BigInt: sin convertirlo, la respuesta
        // entera fallaba con 500 en cuanto una sucursal tenía uno.
        availability: (await repo.availabilityFor(id)).map((a) => ({
          ...a, priceOverrideCents: a.priceOverrideCents === null ? null : a.priceOverrideCents.toString(),
        })),
        // Cuántos socios se afectan si cambia el precio o se desactiva.
        liveMemberships: await repo.liveMembershipCount(id),
      };
    },
  });
}
