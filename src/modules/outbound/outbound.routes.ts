import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound, type PermissionKey } from '@gymflow/core';
import { OUTBOUND_KINDS, OutboundMarked, OutboundMessages, OutboundSummary } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { moduleViewOf } from '../../platform/modules/module-state.js';
import { BranchRepository } from '../organization/index.js';
import { MemberRepository } from '../members/index.js';
import type { AlcanceDeMensajes } from './outbound.repository.js';
import { OutboundService } from './outbound.service.js';

/** Mandar mensajes desde la lista: recepción en su sede y gerencia en todas. Ni la dueña ni el coach (D-30). */
const MANDAR = 'members:message:send' as const satisfies PermissionKey;
/** Los «te extrañamos» anotan un contacto de Retención: además piden esto, en la sede del socio. */
const SEGUIMIENTO = 'retention:followup:write' as const satisfies PermissionKey;

const idParam = z.object({ id: z.string().uuid() });

/**
 * Qué mensajes le tocan a quien pide: los de las sedes donde manda mensajes
 * (todas, o la que pidió) y, de «te extrañamos», solo donde además anota
 * seguimientos y el módulo Retención está encendido. La llave del dueño ya
 * viene aplicada a la sesión. (El nombre empieza con `sedeDe` a propósito:
 * `route-security.test.ts` reconoce así que la ruta acota por sede.)
 */
async function sedeDeLosMensajes(request: FastifyRequest, branchId: string | undefined): Promise<AlcanceDeMensajes> {
  const orgId = request.ctx!.tenant.organizationId;
  if (branchId) request.requirePermission(MANDAR, branchId);
  const [todas, modulos] = await Promise.all([new BranchRepository(orgId).list(), moduleViewOf(orgId)]);
  const sedes = todas.filter((b) => (branchId ? b.id === branchId : request.holds(MANDAR, b.id))).map((b) => b.id);
  return {
    sedes,
    sedesDeRetencion: sedes.filter((s) => request.holds(SEGUIMIENTO, s) && modulos.at(s).has('retention')),
    // Los socios sin sede de casa solo los ve quien manda en todo el gimnasio y no pidió una sede.
    sinSede: !branchId && request.branchScope(MANDAR) === null,
  };
}

export function registerOutboundRoutes(app: FastifyInstance): void {
  const outbound = new OutboundService();

  /**
   * La lista de «Mensajes»: lo que está por mandar, lo más grave primero, y lo
   * mandado hoy. `limit` recorta cada motivo (las cifras van completas en
   * `counts`); `kind` trae un solo motivo (Retención pide solo los «te
   * extrañamos»). Contrato: `OutboundMessages` (`@gymflow/core/contracts`).
   */
  route(app, {
    method: 'GET',
    url: '/outbound/messages',
    security: { kind: 'permission', permission: MANDAR },
    schema: respuesta(200, OutboundMessages),
    handler: async (request): Promise<OutboundMessages> => {
      const q = z.object({
        branchId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        kind: z.enum(OUTBOUND_KINDS).optional(),
      }).parse(request.query);
      return outbound.lista(request.ctx!.tenant.organizationId, await sedeDeLosMensajes(request, q.branchId), { porMotivo: q.limit ?? 50, kind: q.kind });
    },
  });

  /**
   * Las cifras de la campana: cuántos por mandar de cada motivo, sin nombres.
   * Contrato: `OutboundSummary`.
   */
  route(app, {
    method: 'GET',
    url: '/outbound/summary',
    security: { kind: 'permission', permission: MANDAR },
    schema: respuesta(200, OutboundSummary),
    handler: async (request): Promise<OutboundSummary> => {
      const q = z.object({ branchId: z.string().uuid().optional() }).parse(request.query);
      return outbound.resumen(request.ctx!.tenant.organizationId, await sedeDeLosMensajes(request, q.branchId));
    },
  });

  /**
   * «Mandar por WhatsApp» (`as: SENT`) o «No mandar» (`as: DISMISSED`) un
   * mensaje de ESTE socio. El panel abre el enlace `wa.me` en el mismo toque;
   * aquí queda quién y cuándo, el texto que se mandó y, si es un «te
   * extrañamos», el contacto de Retención (15-08). La sede del socio manda.
   */
  route(app, {
    method: 'POST',
    url: '/members/:id/outbound-messages/mark',
    security: { kind: 'permission', permission: MANDAR },
    schema: respuesta(200, OutboundMarked),
    handler: async (request): Promise<OutboundMarked> => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({ messageId: z.string().uuid(), as: z.enum(['SENT', 'DISMISSED']) }).parse(request.body);
      const socio = await new MemberRepository(ctx.tenant.organizationId).findById(id);
      if (!socio) throw notFound('Socio no encontrado');
      // Sin sede de casa, solo quien manda en todo el gimnasio.
      request.requirePermission(MANDAR, socio.homeBranchId ?? null);
      const modulos = await moduleViewOf(ctx.tenant.organizationId);
      const message = await outbound.marcar(ctx, {
        memberId: id, messageId: body.messageId, como: body.as,
        puedeRetencion: !!socio.homeBranchId && request.holds(SEGUIMIENTO, socio.homeBranchId) && modulos.at(socio.homeBranchId).has('retention')
          || (!socio.homeBranchId && request.branchScope(SEGUIMIENTO) === null && modulos.org.has('retention')),
      });
      return { message };
    },
  });
}
