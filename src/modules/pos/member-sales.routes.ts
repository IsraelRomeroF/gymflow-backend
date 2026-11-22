import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, validation } from '@gymflow/core';
import { MemberPosSales, PAGINA_MAXIMA, PAGINA_POR_OMISION, armarCursor, cortarPagina, leerCursor } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { MemberRepository } from '../members/index.js';
import { PosSaleRepository } from './pos-sale.repository.js';
import { cents, idParam } from './pos.serializers.js';

const paginaQuery = z.object({
  limit: z.coerce.number().int().min(1).max(PAGINA_MAXIMA).default(PAGINA_POR_OMISION),
  cursor: z.string().max(400).optional(),
});

/**
 * LAS COMPRAS DE UN SOCIO (auditoría 8, bloque 2.2; 8-01).
 *
 * El punto de venta liga la venta al socio («queda en su ficha») y hasta hoy
 * nada la leía. Es dinero del socio: la ve quien ve su estado de cuenta, en
 * cualquier sede (el expediente es uno), y no el coach. Vive bajo `/members`
 * pero es del módulo Tienda: con la Tienda apagada responde `MODULE_DISABLED`.
 */
export function registerMemberSalesRoutes(app: FastifyInstance): void {
  route(app, {
    method: 'GET',
    url: '/members/:id/pos-sales',
    security: { kind: 'permission', permission: 'billing:statement:read' },
    schema: respuesta(200, MemberPosSales),
    handler: async (request): Promise<MemberPosSales> => {
      const orgId = request.ctx!.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const q = paginaQuery.parse(request.query);
      const cursor = q.cursor === undefined ? null : leerCursor(q.cursor);
      if (q.cursor !== undefined && !cursor) throw validation('Esa página ya no existe. Vuelve a abrir la lista.');
      // También de quien se dio de baja: su historia sigue en la ficha.
      if (!await new MemberRepository(orgId).findByIdIncludingArchived(id)) throw notFound('Socio no encontrado');

      const repo = new PosSaleRepository(orgId);
      const { filas, total, spentCents } = await repo.pageForMember(id, q.limit, cursor);
      const pagina = cortarPagina(filas, q.limit, (u) => armarCursor(u.soldAt.toISOString(), u.id));
      const [lineas, nombres] = await Promise.all([
        repo.linesWithNames(pagina.items.map((v) => v.id)),
        repo.sellerNames(pagina.items.map((v) => v.soldByUserId)),
      ]);
      return {
        items: pagina.items.map((v) => ({
          id: v.id,
          branchId: v.branchId,
          status: v.status,
          totalCents: cents(v.totalCents),
          method: v.method,
          folio: v.folio,
          voidReason: v.voidReason,
          soldAt: v.soldAt.toISOString(),
          businessDate: v.businessDate.toISOString().slice(0, 10),
          soldByName: nombres.get(v.soldByUserId) ?? null,
          lines: (lineas.get(v.id) ?? []).map((l) => ({
            productId: l.productId, name: l.name, quantity: l.quantity,
            unitPriceCents: cents(l.unitPriceCents), lineTotalCents: cents(l.lineTotalCents),
          })),
        })),
        total,
        nextCursor: pagina.nextCursor,
        hasMore: pagina.hasMore,
        spentCents: cents(spentCents),
      };
    },
  });
}
