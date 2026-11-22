import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { PosService } from './pos.service.js';
import { InventoryRepository } from './inventory.repository.js';
import { ProductRepository } from './product.repository.js';
import { validation } from '@gymflow/core';
import { INVENTORY_MOVEMENT_TYPES, PAGINA_MAXIMA, PAGINA_POR_OMISION, InventoryMovementList, leerCursor } from '@gymflow/core/contracts';

/** Existencias por sucursal y sus movimientos (compra, ajuste, traspaso, merma). */
export function registerInventoryRoutes(app: FastifyInstance): void {
  const service = new PosService();

  // ── Existencias ───────────────────────────────────────────────────────────
  route(app, {
    method: 'GET',
    url: '/inventory',
    security: { kind: 'permission', permission: 'catalog:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const q = z.object({ branchId: z.string().uuid() }).parse(request.query);
      request.requirePermission('catalog:read', q.branchId);
      const orgId = ctx.tenant.organizationId;

      const stock = await new InventoryRepository(orgId).stockFor(q.branchId);
      const products = await new ProductRepository(orgId).list(false);
      const porId = new Map(products.map((p) => [p.id, p]));

      return {
        branchId: q.branchId,
        stock: stock.map((s) => ({
          productId: s.productId,
          sku: porId.get(s.productId)?.sku ?? null,
          name: porId.get(s.productId)?.name ?? null,
          quantityOnHand: s.quantityOnHand,
        })),
      };
    },
  });

  /**
   * El libro de inventario de una sede (8-02): qué entró, qué salió, por qué
   * y quién lo registró. Lo lee quien ajusta existencias (gerencia) y quien
   * consulta el dinero (la dueña): «¿cuánto se mermó este mes y quién lo
   * anotó?» ya no exige ir a la bitácora.
   */
  route(app, {
    method: 'GET',
    url: '/inventory/movements',
    security: { kind: 'permission', permission: 'pos:inventory:adjust', anyOf: ['reports:financial:read'] },
    schema: respuesta(200, InventoryMovementList),
    handler: async (request): Promise<InventoryMovementList> => {
      const ctx = request.ctx!;
      const q = z.object({
        branchId: z.string().uuid(),
        productId: z.string().uuid().optional(),
        movementType: z.enum(INVENTORY_MOVEMENT_TYPES).optional(),
        cursor: z.string().max(400).optional(),
        limit: z.coerce.number().int().min(1).max(PAGINA_MAXIMA).default(PAGINA_POR_OMISION),
      }).parse(request.query);
      // En ESA sede: con uno de los dos permisos basta.
      if (!request.holds('reports:financial:read', q.branchId)) request.requirePermission('pos:inventory:adjust', q.branchId);
      const cursor = q.cursor === undefined ? null : leerCursor(q.cursor);
      if (q.cursor !== undefined && !cursor) throw validation('Esa página ya no existe. Vuelve a abrir la lista.');

      const pagina = await new InventoryRepository(ctx.tenant.organizationId).movementsPage({
        branchId: q.branchId, productId: q.productId, movementType: q.movementType, limit: q.limit, cursor,
      });
      // Contrato: `InventoryMovementList` (`@gymflow/core/contracts`).
      return {
        ...pagina,
        items: pagina.items.map((m) => ({
          id: m.id, branchId: m.branchId, productId: m.productId, sku: m.sku, productName: m.productName,
          movementType: m.movementType, quantityDelta: m.quantityDelta, reason: m.reason, posSaleId: m.posSaleId,
          createdByUserId: m.createdByUserId, createdByName: m.createdByName,
          at: m.at.toISOString(), businessDate: m.businessDate.toISOString().slice(0, 10),
        })),
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/inventory/movements',
    security: { kind: 'permission', permission: 'pos:inventory:adjust' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = z.object({
        branchId: z.string().uuid(),
        productId: z.string().uuid(),
        movementType: z.enum(['PURCHASE', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT', 'SHRINKAGE']),
        quantityDelta: z.number().int().refine((n) => n !== 0, 'El movimiento no puede ser cero'),
        reason: z.string().min(3).max(300),
      }).parse(request.body);

      request.authorize('pos:inventory:adjust', { branchId: body.branchId, reason: body.reason });

      return reply.status(201).send(await service.adjustInventory(ctx, body));
    },
  });
}
