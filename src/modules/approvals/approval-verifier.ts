import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sesionRequerida } from '../../platform/http/sesion.js';
import { ApprovalService } from './approval.service.js';
import { ApprovalGrantRepository } from './approval.repository.js';

/** Las firmas que esta petición consumió fuera de una transacción (la ruta las verifica antes de operar). */
const CONSUMIDAS = new WeakMap<FastifyRequest, { organizationId: string; ids: string[] }>();

/**
 * `request.verifyApprover` (su forma está en `platform/http/fastify.d.ts`):
 * las rutas cuyo permiso pide la firma de un segundo usuario la consumen
 * contra la base ANTES de autorizar (`route-security.test.ts` lo vigila).
 *
 * Vivía en el plugin de sesión de `identity`, y eso obligaba a la identidad a
 * depender de las firmas mientras las firmas dependen de la identidad
 * (usuarios, permisos, avisos y contraseña). Ahora la pone este módulo al
 * montarse (`src/modules.ts`), antes que los módulos que la usan; la
 * dependencia va en un solo sentido, `approvals → identity`.
 */
export function registerApprovalVerifier(app: FastifyInstance): void {
  app.decorateRequest('verifyApprover', async function (
    this: FastifyRequest, approvalToken, permission, scope,
  ) {
    const ctx = this.ctx;
    if (!ctx) throw sesionRequerida(this);
    return new ApprovalService().verify(ctx, approvalToken, permission, scope ?? {}, (grantId) => {
      const previas = CONSUMIDAS.get(this) ?? { organizationId: ctx.tenant.organizationId, ids: [] };
      previas.ids.push(grantId);
      CONSUMIDAS.set(this, previas);
    });
  });

  // Una firma válida cuya operación terminó en error no se gastó: la operación
  // no existe (cada una es una sola transacción). Se devuelve para que quien
  // pidió pueda corregir y repetir con la misma firma, y para que «Resueltas
  // hoy» no diga que se registró algo que la caja rechazó (2.14, D1).
  app.addHook('onResponse', async (request, reply) => {
    const consumidas = CONSUMIDAS.get(request);
    if (!consumidas || reply.statusCode < 400) return;
    const repo = new ApprovalGrantRepository(consumidas.organizationId);
    for (const id of consumidas.ids) await repo.release(id).catch((e: unknown) => request.log.warn({ err: e, grantId: id }, 'no se pudo devolver la firma de una operación que falló'));
  });
}
