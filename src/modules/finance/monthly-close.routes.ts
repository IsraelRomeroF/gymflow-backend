import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError, monthlyCloseResourceId, validation } from '@gymflow/core';
import { MonthlyClose, MonthlyCloseList, MonthlyClosePreview } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { ApprovalService } from '../approvals/index.js';
import { AuthUserRepository } from '../identity/index.js';
import { MonthlyCloseService } from './monthly-close.service.js';

const MES = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes como AAAA-MM');

/**
 * Cierre de mes (fase 4; auditoría 8, bloque 1.9): la lista de meses cerrados
 * y por cerrar, lo que va a pasar antes de cerrar, y el cierre, que firma el
 * dueño. Las respuestas son los contratos del núcleo (`contracts/reports.ts`).
 */
export function registerMonthlyCloseRoutes(app: FastifyInstance): void {
  const service = new MonthlyCloseService();
  /**
   * ¿Cierra sola, con su contraseña (D-23)? Quien tiene la segunda firma (la
   * dueña) Y el permiso de cerrar, que la sesión solo le da cuando no hay un
   * gerente que administre (`identity/session.repository.ts`). Nadie se firma
   * a sí mismo: por eso su cierre no pasa por una segunda firma, sino por su
   * contraseña, y la bitácora dice que cerró sola.
   */
  const cierraSola = (request: { holds(p: 'approvals:grant' | 'reports:month:close', b: string | null): boolean }): boolean =>
    request.holds('approvals:grant', null) && request.holds('reports:month:close', null);

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
      return service.vistaPrevia(request.ctx!, q.month, cierraSola(request) ? 'own-password' : 'approver');
    },
  });

  /**
   * El gerente cierra y el dueño firma: la foto del mes queda y no se
   * reescribe. Sin gerente que administre, cierra la dueña con su contraseña
   * (`password`, D-23).
   */
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
        /** La contraseña de la dueña cuando cierra sola (sin gerente, D-23). */
        password: z.string().min(1).max(200).optional(),
      }).parse(request.body);
      // Antes de pedir la firma: un mes que no terminó, ya está cerrado o tiene una caja abierta no la gasta.
      await service.comprobar(ctx, body.month);

      if (cierraSola(request) && !body.approvalToken) {
        if (!body.password) throw validation('Escribe tu contraseña para cerrar el mes');
        const yo = await new AuthUserRepository().findById(ctx.tenant.actorUserId!);
        if (!yo || !yo.isActive) throw new DomainError('UNAUTHENTICATED', 'Tu cuenta ya no está activa');
        // Su contraseña, con la escalera de las firmas (24-11): un error de dedo no la saca del panel.
        await new ApprovalService().comprobarContrasena(ctx, yo, body.password, { branchId: null }, { canal: 'telefono', asentarFallo: async () => undefined });
        request.requirePermission('reports:month:close', null);
        const propio: MonthlyClose = await service.cerrar(ctx, { month: body.month, reason: body.reason, note: body.note ?? null, aprobador: null, conContrasenaPropia: true });
        return reply.status(201).send(propio);
      }
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
