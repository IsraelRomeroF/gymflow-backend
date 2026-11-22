import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { PosService } from './pos.service.js';
import { ProductRepository } from './product.repository.js';
import { idParam, serializeProduct } from './pos.serializers.js';

/** El catálogo de productos: ver, dar de alta y cambiar precio o vigencia. */
export function registerProductRoutes(app: FastifyInstance): void {
  const service = new PosService();
  const audit = new AuditService();

  // ── Catálogo ──────────────────────────────────────────────────────────────
  route(app, {
    method: 'GET',
    url: '/products',
    security: { kind: 'permission', permission: 'catalog:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const q = z.object({ includeInactive: z.coerce.boolean().default(false) }).parse(request.query);
      const rows = await new ProductRepository(ctx.tenant.organizationId).list(!q.includeInactive);
      return { products: rows.map(serializeProduct) };
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
        priceCents: z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos'),
        tracksInventory: z.boolean().optional(),
      }).parse(request.body);

      const product = await service.createProduct(ctx, {
        sku: body.sku,
        name: body.name,
        priceCents: BigInt(body.priceCents),
        ...(body.tracksInventory !== undefined ? { tracksInventory: body.tracksInventory } : {}),
      });
      return reply.status(201).send(serializeProduct(product));
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
        priceCents: z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos').optional(),
        isActive: z.boolean().optional(),
      }).parse(request.body);

      const repo = new ProductRepository(ctx.tenant.organizationId);
      const antes = (await repo.list(false)).find((p) => p.id === id);
      const updated = await repo.update(id, {
        ...(body.name ? { name: body.name } : {}),
        ...(body.priceCents ? { priceCents: BigInt(body.priceCents) } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      });
      if (!updated) throw notFound('Producto no encontrado');
      // Un cambio de precio queda con el antes y el después: es lo primero
      // que se pregunta cuando el corte de productos no cuadra.
      await audit.record(ctx, {
        action: 'pos.product.update', resourceType: 'product', resourceId: id,
        beforeState: antes ? { name: antes.name, priceCents: antes.priceCents.toString(), isActive: antes.isActive } : null,
        afterState: { name: updated.name, priceCents: updated.priceCents.toString(), isActive: updated.isActive },
      });
      return serializeProduct(updated);
    },
  });
}
