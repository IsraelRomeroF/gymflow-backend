import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { money, notFound } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { PosService } from './pos.service.js';
import { PosSaleRepository } from './pos-sale.repository.js';
import { idParam, serializeSale } from './pos.serializers.js';

/** La venta de mostrador: cobrar, consultar las del día y anular con motivo. */
export function registerSaleRoutes(app: FastifyInstance): void {
  const service = new PosService();

  // ── Venta ─────────────────────────────────────────────────────────────────
  route(app, {
    method: 'POST',
    url: '/pos/sales',
    security: { kind: 'permission', permission: 'pos:sale:create' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = z.object({
        branchId: z.string().uuid(),
        method: z.enum(['CASH', 'CARD_TERMINAL', 'SPEI_TRANSFER']),
        memberId: z.string().uuid().optional(),
        cashSessionId: z.string().uuid().optional(),
        externalRef: z.string().trim().max(120).optional(),
        lines: z.array(z.object({
          productId: z.string().uuid(),
          quantity: z.number().int().min(1).max(999),
        })).min(1).max(50),
        // OBLIGATORIA: sin ella, un doble clic o un reintento cobra dos veces.
        idempotencyKey: z.string().min(8).max(120),
      }).refine((b) => b.method !== 'SPEI_TRANSFER' || !!b.externalRef, {
        message: 'Una transferencia necesita su referencia o clave de rastreo', path: ['externalRef'],
      }).parse(request.body);

      request.authorize('pos:sale:create', { branchId: body.branchId });

      const { sale, lines } = await service.sell(ctx, {
        branchId: body.branchId,
        method: body.method,
        // El precio unitario NO viene del cliente: lo pone el catálogo.
        lines: body.lines.map((l) => ({ ...l, unitPrice: money(0n) })),
        ...(body.memberId ? { memberId: body.memberId } : {}),
        ...(body.cashSessionId ? { cashSessionId: body.cashSessionId } : {}),
        ...(body.externalRef ? { externalRef: body.externalRef } : {}),
        idempotencyKey: body.idempotencyKey,
      });
      return reply.status(201).send(serializeSale(sale, lines));
    },
  });

  /** Las ventas de hoy en la sede: lo que recepción revisa para anular un error. */
  route(app, {
    method: 'GET',
    url: '/pos/sales',
    security: { kind: 'permission', permission: 'pos:sale:create' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const q = z.object({ branchId: z.string().uuid() }).parse(request.query);
      request.requirePermission('pos:sale:create', q.branchId);
      const repo = new PosSaleRepository(ctx.tenant.organizationId);
      const hoy = await new BusinessCalendar(ctx.tenant.organizationId).today(q.branchId);
      const ventas = await repo.listForDay(q.branchId, hoy);
      return { sales: await Promise.all(ventas.map(async (v) => serializeSale(v, await repo.lines(v.id)))) };
    },
  });

  route(app, {
    method: 'GET',
    url: '/pos/sales/:id',
    security: { kind: 'permission', permission: 'pos:sale:create' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const repo = new PosSaleRepository(ctx.tenant.organizationId);
      const sale = await repo.findById(id);
      if (!sale) throw notFound('Venta no encontrada');
      request.requirePermission('pos:sale:create', sale.branchId);
      return serializeSale(sale, await repo.lines(id));
    },
  });

  route(app, {
    method: 'POST',
    url: '/pos/sales/:id/void',
    security: { kind: 'permission', permission: 'pos:sale:void' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({ reason: z.string().min(3).max(300) }).parse(request.body);

      const repo = new PosSaleRepository(ctx.tenant.organizationId);
      const sale = await repo.findById(id);
      if (!sale) throw notFound('Venta no encontrada');

      // El límite de anulaciones por turno ALERTA, no bloquea (ADR-009).
      const delTurno = await repo.listForSession(sale.cashSessionId);
      request.authorize('pos:sale:void', {
        branchId: sale.branchId,
        reason: body.reason,
        shiftUsageCount: delTurno.filter((s) => s.status === 'VOIDED').length,
      });

      const anulada = await service.voidSale(ctx, { saleId: id, reason: body.reason });
      return serializeSale(anulada, await repo.lines(id));
    },
  });
}
