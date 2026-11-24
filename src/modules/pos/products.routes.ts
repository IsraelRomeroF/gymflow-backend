import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '@gymflow/core';
import { ProductList } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { MemberRepository } from '../members/index.js';
import { PosService } from './pos.service.js';
import { ProductRepository } from './product.repository.js';
import { idParam, serializeProduct } from './pos.serializers.js';

/** El catálogo de productos: ver, dar de alta y cambiar precio o vigencia. */
export function registerProductRoutes(app: FastifyInstance): void {
  const service = new PosService();
  const importe = z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos');

  // ── Catálogo ──────────────────────────────────────────────────────────────
  route(app, {
    method: 'GET',
    url: '/products',
    security: { kind: 'permission', permission: 'catalog:read' },
    schema: respuesta(200, ProductList),
    handler: async (request): Promise<ProductList> => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const q = z.object({ includeInactive: z.coerce.boolean().default(false), memberId: z.string().uuid().optional() }).parse(request.query);
      const rows = await new ProductRepository(orgId).list(!q.includeInactive);
      // El costo solo lo ve quien administra el catálogo (D-21): el mostrador no.
      const conCosto = request.holds('pos:product:manage', null);
      // Con socio: ¿le toca hoy el precio de socio? La pantalla muestra así el total que el servidor va a cobrar.
      let memberPricing: ProductList['memberPricing'] = null;
      if (q.memberId) {
        if (!await new MemberRepository(orgId).findById(q.memberId)) throw notFound('Socio no encontrado');
        memberPricing = { memberId: q.memberId, applies: await service.precioDeSocioAplica(orgId, q.memberId) };
      }
      return { products: rows.map((p) => serializeProduct(p, conCosto)), memberPricing };
    },
  });

  route(app, {
    method: 'POST',
    url: '/products',
    security: { kind: 'permission', permission: 'pos:product:manage' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = z.object({
        sku: z.string().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/),
        name: z.string().min(2).max(120),
        priceCents: importe,
        // D-21, los dos opcionales: precio para socios con membresía vigente y lo que le cuesta al gimnasio.
        memberPriceCents: importe.nullish(),
        costCents: importe.nullish(),
        tracksInventory: z.boolean().optional(),
      }).parse(request.body);

      const product = await service.createProduct(ctx, {
        sku: body.sku,
        name: body.name,
        priceCents: BigInt(body.priceCents),
        ...(body.memberPriceCents != null ? { memberPriceCents: BigInt(body.memberPriceCents) } : {}),
        ...(body.costCents != null ? { costCents: BigInt(body.costCents) } : {}),
        ...(body.tracksInventory !== undefined ? { tracksInventory: body.tracksInventory } : {}),
      });
      return reply.status(201).send(serializeProduct(product, true));
    },
  });

  route(app, {
    method: 'PATCH',
    url: '/products/:id',
    security: { kind: 'permission', permission: 'pos:product:manage' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        name: z.string().min(2).max(120).optional(),
        priceCents: importe.optional(),
        // `null` lo quita; ausente no lo toca.
        memberPriceCents: importe.nullable().optional(),
        costCents: importe.nullable().optional(),
        isActive: z.boolean().optional(),
      }).parse(request.body);

      const updated = await service.updateProduct(ctx, id, {
        ...(body.name ? { name: body.name } : {}),
        ...(body.priceCents ? { priceCents: BigInt(body.priceCents) } : {}),
        ...(body.memberPriceCents !== undefined ? { memberPriceCents: body.memberPriceCents === null ? null : BigInt(body.memberPriceCents) } : {}),
        ...(body.costCents !== undefined ? { costCents: body.costCents === null ? null : BigInt(body.costCents) } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      });
      return serializeProduct(updated, true);
    },
  });
}
