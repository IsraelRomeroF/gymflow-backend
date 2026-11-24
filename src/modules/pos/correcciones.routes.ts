import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '@gymflow/core';
import { FlaggedPosSales, PosSale } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { sedeDeConsulta } from '../../platform/http/branch-scope.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { CashSessionRepository } from '../cash/index.js';
import { PosSaleRepository, type PosSaleRecord } from './pos-sale.repository.js';
import { PosCorrectionRepository } from './correccion.repository.js';
import { descartarMarca, devolverVenta, marcarPorCorregir } from './correccion.js';
import { cents, idParam, serializeSale } from './pos.serializers.js';

const motivo = z.object({ reason: z.string().min(3).max(300) });

/** La venta con su corrección y lo que hoy se puede hacer con ella (D-13). */
export async function ventaConCorreccion(organizationId: string, sale: PosSaleRecord): Promise<PosSale> {
  const ventas = new PosSaleRepository(organizationId);
  const repo = new PosCorrectionRepository(organizationId);
  const [lineas, marca, devolucion, hoy, turno] = await Promise.all([
    ventas.lines(sale.id), repo.flagOf(sale.id), repo.returnOf(sale.id),
    new BusinessCalendar(organizationId).today(sale.branchId),
    new CashSessionRepository(organizationId).findById(sale.cashSessionId),
  ]);
  const nombres = await ventas.sellerNames([marca?.flaggedByUserId, devolucion?.approvedByUserId].filter((x): x is string => !!x));
  const viva = sale.status === 'COMPLETED' && !devolucion;
  const delDia = sale.businessDate.getTime() === hoy.getTime() && turno?.status === 'OPEN';
  return {
    ...serializeSale(sale, lineas),
    correction: {
      flag: marca && !marca.resolvedAt ? { reason: marca.reason, flaggedAt: marca.flaggedAt.toISOString(), flaggedByName: nombres.get(marca.flaggedByUserId) ?? null } : null,
      returned: devolucion ? {
        amountCents: cents(devolucion.amountCents), method: devolucion.method, businessDate: devolucion.businessDate.toISOString().slice(0, 10),
        reason: devolucion.reason, returnRef: devolucion.returnRef, approvedByName: nombres.get(devolucion.approvedByUserId) ?? null,
      } : null,
    },
    canVoid: viva && delDia,
    // La que se cargó a la cuenta del socio se corrige en su estado de cuenta.
    canReturn: viva && !delDia && sale.method !== null,
  };
}

/**
 * CORREGIR UNA VENTA DE TIENDA (D-13, bloque 3.5). Recepción marca «por
 * corregir»; la gerencia anula el mismo día (`POST /pos/sales/:id/void`, sin
 * cambios) o registra la devolución de otro día, con la firma de la dueña.
 */
export function registerPosCorrectionRoutes(app: FastifyInstance): void {
  async function ventaDe(orgId: string, id: string): Promise<PosSaleRecord> {
    const sale = await new PosSaleRepository(orgId).findById(id);
    if (!sale) throw notFound('Venta no encontrada');
    return sale;
  }

  /** Lo que la gerencia tiene por corregir. Antes que `/pos/sales/:id` no hace falta: la ruta es literal. */
  route(app, {
    method: 'GET',
    url: '/pos/flagged-sales',
    security: { kind: 'permission', permission: 'pos:sale:create' },
    schema: respuesta(200, FlaggedPosSales),
    handler: async (request): Promise<FlaggedPosSales> => {
      const orgId = request.ctx!.tenant.organizationId;
      const q = z.object({ branchId: z.string().uuid().optional() }).parse(request.query);
      const sede = sedeDeConsulta(request, 'pos:sale:create', q.branchId);
      const alcance = sede ? [sede] : request.branchScope('pos:sale:create');
      const marcas = await new PosCorrectionRepository(orgId).openFlags(alcance);
      const ventas = new PosSaleRepository(orgId);
      const nombres = await ventas.sellerNames(marcas.map((m) => m.flaggedByUserId));
      const cal = new BusinessCalendar(orgId);
      const hoyDe = new Map<string, number>();
      const items: FlaggedPosSales['items'] = [];
      for (const m of marcas) {
        const v = await ventas.findById(m.posSaleId);
        if (!v || v.status !== 'COMPLETED') continue;
        if (!hoyDe.has(v.branchId)) hoyDe.set(v.branchId, (await cal.today(v.branchId)).getTime());
        const turno = await new CashSessionRepository(orgId).findById(v.cashSessionId);
        items.push({
          saleId: v.id, branchId: v.branchId, folio: v.folio, totalCents: cents(v.totalCents), method: v.method,
          businessDate: v.businessDate.toISOString().slice(0, 10), soldAt: v.soldAt.toISOString(), memberId: v.memberId,
          reason: m.reason, flaggedAt: m.flaggedAt.toISOString(), flaggedByName: nombres.get(m.flaggedByUserId) ?? null,
          sameDay: v.businessDate.getTime() === hoyDe.get(v.branchId) && turno?.status === 'OPEN',
        });
      }
      return { items };
    },
  });

  route(app, {
    method: 'POST',
    url: '/pos/sales/:id/flag',
    security: { kind: 'permission', permission: 'pos:sale:create' },
    schema: respuesta(201, PosSale),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const { reason } = motivo.parse(request.body);
      const sale = await ventaDe(ctx.tenant.organizationId, id);
      request.requirePermission('pos:sale:create', sale.branchId);
      await marcarPorCorregir(ctx, { saleId: id, reason });
      return reply.status(201).send(await ventaConCorreccion(ctx.tenant.organizationId, sale));
    },
  });

  route(app, {
    method: 'POST',
    url: '/pos/sales/:id/flag/dismiss',
    security: { kind: 'permission', permission: 'pos:sale:void' },
    schema: respuesta(200, PosSale),
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const { reason } = motivo.parse(request.body);
      const sale = await ventaDe(ctx.tenant.organizationId, id);
      request.authorize('pos:sale:void', { branchId: sale.branchId, reason });
      await descartarMarca(ctx, { saleId: id, reason });
      return ventaConCorreccion(ctx.tenant.organizationId, sale);
    },
  });

  route(app, {
    method: 'POST',
    url: '/pos/sales/:id/return',
    security: { kind: 'permission', permission: 'pos:sale:return' },
    schema: respuesta(201, PosSale),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        reason: z.string().min(3).max(300),
        approvalToken: z.string().min(20).max(200).optional(),
        /** El turno abierto del que sale el dinero. Obligatorio si hay varias cajas abiertas. */
        cashSessionId: z.string().uuid().optional(),
        /** Clave de rastreo de la devolución. Obligatoria si la venta se pagó por transferencia. */
        returnRef: z.string().trim().min(3).max(120).optional(),
      }).parse(request.body);
      const sale = await ventaDe(ctx.tenant.organizationId, id);
      const aprobador = await request.verifyApprover(body.approvalToken, 'pos:sale:return', { branchId: sale.branchId, resourceType: 'PosSale', resourceId: sale.id, amountCents: sale.totalCents });
      request.authorize('pos:sale:return', { branchId: sale.branchId, reason: body.reason, ...(aprobador ? { approvedByUserId: aprobador } : {}) });
      await devolverVenta(ctx, { saleId: id, reason: body.reason, approvedByUserId: aprobador!, cashSessionId: body.cashSessionId ?? null, returnRef: body.returnRef ?? null });
      return reply.status(201).send(await ventaConCorreccion(ctx.tenant.organizationId, sale));
    },
  });
}
