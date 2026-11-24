import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DayPassSaleResult, MemberDayPasses, MemberTrialPass, TrialPassGrantResult, type DayPass, type TrialPass } from '@gymflow/core/contracts';
import { respuesta } from '../../platform/http/respuesta.js';
import { route } from '../../platform/http/registry.js';
import { BillingService } from './billing.service.js';
import { idParam, iso, pagoBody, aPago } from './billing.serializers.js';
import { dayPassesOf, sellDayPass, type DayPassView } from './day-pass.js';
import { grantTrialPass, trialPassOf, type TrialPassView } from './day-pass-prueba.js';
import { TrialPassRepository } from './day-pass-prueba.repository.js';

/** El pase de prueba como lo lee la pantalla: con el nombre de la sede y de quien lo dio. */
async function serializarPaseDePrueba(orgId: string, p: TrialPassView): Promise<TrialPass> {
  const n = await new TrialPassRepository(orgId).nombres(p);
  return {
    id: p.id, memberId: p.memberId, branchId: p.branchId, branchName: n.branchName, validOn: iso(p.validOn), validToday: p.validToday,
    phoneLast4: p.phoneLast4, grantedByName: n.grantedByName, grantedAt: p.createdAt.toISOString(),
  };
}

const serializarPase = (p: DayPassView): DayPass => ({
  id: p.id, memberId: p.memberId, branchId: p.branchId, validOn: iso(p.validOn), concept: p.concept,
  amountCents: p.amountCents.toString(), paid: p.paid, validToday: p.validToday,
});

/** Pase del día (bloque 1.8; 4-01): la visita suelta, sin membresía y sin inscripción. */
export function registerDayPassRoutes(app: FastifyInstance): void {
  const service = new BillingService();

  /**
   * Vende y cobra un pase del día. Mismo permiso que vender una membresía, y
   * el de cobrar: el pase no queda a deber.
   */
  route(app, {
    method: 'POST',
    url: '/members/:id/day-passes',
    security: { kind: 'permission', permission: 'memberships:create' },
    schema: respuesta([201, 200], DayPassSaleResult),
    handler: async (request, reply): Promise<DayPassSaleResult> => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        planId: z.string({ error: 'Elige la visita suelta que se vende' }).uuid('Ese plan no es válido'),
        branchId: z.string({ error: 'Falta la sucursal donde se vende el pase' }).uuid('Esa sucursal no es válida'),
        // OBLIGATORIA: la genera la pantalla una vez por venta. Es lo único que
        // distingue «el mismo pase enviado dos veces» de «dos pases».
        saleKey: z.string({ error: 'Falta la clave de la venta' }).min(8, 'La clave de la venta es demasiado corta').max(80, 'La clave de la venta es demasiado larga'),
        payment: pagoBody,
      }).parse(request.body);

      request.authorize('memberships:create', { branchId: body.branchId });
      // El pase siempre mueve dinero (o saldo a favor): pide el permiso de cobrar aunque lo cubra el saldo.
      request.authorize('payments:record', { branchId: body.branchId });

      const r = await sellDayPass(service, ctx, {
        memberId: id, planId: body.planId, branchId: body.branchId, saleKey: body.saleKey, payment: aPago(body.payment),
      });
      reply.status(r.created ? 201 : 200);
      return {
        created: r.created,
        pass: serializarPase(r.pass),
        payment: r.payment ? { id: r.payment.id, folio: r.payment.folio, amountCents: r.payment.amountCents.toString() } : null,
        creditAppliedCents: r.creditAppliedCents.toString(),
      };
    },
  });

  // ── Pase de prueba (fase 3, bloque 3.3; D-08) ─────────────────────────────

  /**
   * Da el pase de prueba: gratis, uno por persona (por celular), vale hoy en
   * esa sede. El mismo permiso que vender una visita suelta; no pide el de
   * cobrar porque no mueve dinero. La entrada la registra la puerta.
   */
  route(app, {
    method: 'POST',
    url: '/members/:id/trial-pass',
    security: { kind: 'permission', permission: 'memberships:create' },
    schema: respuesta([201, 200], TrialPassGrantResult),
    handler: async (request, reply): Promise<TrialPassGrantResult> => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        branchId: z.string({ error: 'Falta la sucursal donde entra a probar' }).uuid('Esa sucursal no es válida'),
      }).parse(request.body);
      request.authorize('memberships:create', { branchId: body.branchId });
      const r = await grantTrialPass(ctx, { memberId: id, branchId: body.branchId });
      reply.status(r.created ? 201 : 200);
      return { created: r.created, pass: await serializarPaseDePrueba(ctx.tenant.organizationId, r.pass) };
    },
  });

  /** Su pase de prueba (si ya lo usó) y, si no, si se le puede dar y por qué no. */
  route(app, {
    method: 'GET',
    url: '/members/:id/trial-pass',
    security: { kind: 'permission', permission: 'members:read' },
    schema: respuesta(200, MemberTrialPass),
    handler: async (request): Promise<MemberTrialPass> => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const r = await trialPassOf(ctx, id);
      return {
        pass: r.pass ? await serializarPaseDePrueba(ctx.tenant.organizationId, r.pass) : null,
        eligible: r.eligible, blockedBy: r.blockedBy, blockedText: r.blockedText,
      };
    },
  });

  /** El pase de hoy y los que lleva: lo que la ficha dice de quien viene suelto. */
  route(app, {
    method: 'GET',
    url: '/members/:id/day-passes',
    security: { kind: 'permission', permission: 'members:read' },
    schema: respuesta(200, MemberDayPasses),
    handler: async (request): Promise<MemberDayPasses> => {
      const { id } = idParam.parse(request.params);
      const r = await dayPassesOf(request.ctx!, id);
      return { today: r.today ? serializarPase(r.today) : null, total: r.total, recent: r.recent.map(serializarPase) };
    },
  });
}
