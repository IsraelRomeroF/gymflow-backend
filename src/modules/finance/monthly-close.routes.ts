import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { monthlyCloseResourceId } from '@gymflow/core';
import { MonthlyClose, MonthlyCloseList, MonthlyClosePreview } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { MonthlyCloseService } from './monthly-close.service.js';

const MES = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes como AAAA-MM');

/**
 * Cierre de mes (fase 4; auditoría 8, bloque 1.9): la lista de meses cerrados
 * y por cerrar, lo que va a pasar antes de cerrar, y el cierre, que firma el
 * dueño. Las respuestas son los contratos del núcleo (`contracts/reports.ts`).
 */
export function registerMonthlyCloseRoutes(app: FastifyInstance): void {
  const service = new MonthlyCloseService();

  /** Los meses cerrados con quién cerró y quién firmó, y los terminados sin cerrar (14-04). */
  route(app, {
    method: 'GET',
    url: '/reports/monthly-closes',
    security: { kind: 'permission', permission: 'reports:financial:read' },
    schema: respuesta(200, MonthlyCloseList),
    handler: async (request): Promise<MonthlyCloseList> => {
      request.requirePermission('reports:financial:read', null);
      return service.lista(request.ctx!);
    },
  });

  /** Lo que va a pasar al cerrar ese mes: bloqueos, avisos y la foto que quedaría (13-01, 14-05). */
  route(app, {
    method: 'GET',
    url: '/reports/monthly-close/preview',
    security: { kind: 'permission', permission: 'reports:financial:read' },
    schema: respuesta(200, MonthlyClosePreview),
    handler: async (request): Promise<MonthlyClosePreview> => {
      // Las cifras son de TODO el gimnasio: no las ve quien solo tiene una sede.
      request.requirePermission('reports:financial:read', null);
      const q = z.object({ month: MES }).parse(request.query);
      return service.vistaPrevia(request.ctx!, q.month);
    },
  });

  /** El gerente cierra y el dueño firma: la foto del mes queda y no se reescribe. */
  route(app, {
    method: 'POST',
    url: '/reports/monthly-close',
    security: { kind: 'permission', permission: 'reports:month:close' },
    schema: respuesta(201, MonthlyClose),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = z.object({
        month: MES,
        reason: z.string().min(3).max(300),
        note: z.string().trim().max(300).optional(),
        approvalToken: z.string().min(20).max(200).optional(),
      }).parse(request.body);
      // Antes de pedir la firma: un mes que no terminó o ya está cerrado no la gasta.
      await service.comprobar(ctx, body.month);
      // La firma va atada a ESTE mes (20-01): la de octubre no cierra septiembre.
      // La que no dice mes —de un panel anterior— todavía vale (fase 0).
      const aprobador = await request.verifyApprover(body.approvalToken, 'reports:month:close', {
        branchId: null, resourceType: 'MonthlyClose', resourceId: monthlyCloseResourceId(body.month),
      });
      request.authorize('reports:month:close', { branchId: null, reason: body.reason, ...(aprobador ? { approvedByUserId: aprobador } : {}) });

      const cierre: MonthlyClose = await service.cerrar(ctx, { month: body.month, reason: body.reason, note: body.note ?? null, aprobador: aprobador ?? null });
      return reply.status(201).send(cierre);
    },
  });
}
