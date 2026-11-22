import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { estadoDeSolicitud, folioDeSolicitud, notFound, plazoVigente, solicitudVencida, UNLIMITED_LIMITS } from '@gymflow/core';
import type { PrivacyRequest } from '@gymflow/core/contracts';
import type { RequestContext } from '../../platform/context.js';
import { MemberRepository } from '../members/index.js';
import type { PrivacyRequestRecord } from './privacy-request.repository.js';

/**
 * Lo que comparten las rutas de privacidad: el parámetro `:id`, la sede de
 * casa del socio, cómo se pinta una solicitud ARCO y el contexto con que el
 * socio actúa desde su teléfono. Qué permisos retira cada quién ya no vive
 * aquí: `REVOCABLES_POR_EL_SOCIO` y `REVOCABLES_EN_RECEPCION`, del núcleo.
 */
export const idParam = z.object({ id: z.string().uuid() });

/** El contrato del núcleo como `schema.response`: una sola forma para toda la API (`platform/http/respuesta.ts`, bloque 1.2). */
export { respuesta } from '../../platform/http/respuesta.js';

/** La sede de casa del socio (también de quien ya se dio de baja); 404 si no es de este gimnasio. */
export async function sedeDe(orgId: string, memberId: string): Promise<string | null> {
  const m = await new MemberRepository(orgId).findByIdIncludingArchived(memberId);
  if (!m) throw notFound('Socio no encontrado');
  return m.homeBranchId;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Una solicitud como la dice el contrato `PrivacyRequest`: el estado, el plazo que corre y si venció los calcula el núcleo. */
export function serializarSolicitud(r: PrivacyRequestRecord, ahora: Date = new Date()): PrivacyRequest {
  const plazo = plazoVigente(r);
  return {
    id: r.id, folio: folioDeSolicitud(r.id, r.receivedAt), memberId: r.memberId, kind: r.kind, channel: r.channel,
    consentType: r.consentType, note: r.note, receivedAt: r.receivedAt.toISOString(),
    status: estadoDeSolicitud(r),
    identityVerifiedAt: iso(r.identityVerifiedAt), identityNote: r.identityNote,
    dueAt: r.dueAt.toISOString(),
    resolvedAt: iso(r.resolvedAt), outcome: r.outcome, resolution: r.resolution,
    effectiveDueAt: iso(r.effectiveDueAt), effectedAt: iso(r.effectedAt), effectNote: r.effectNote,
    deadlineAt: iso(plazo),
    /** Pasó el plazo que corre hoy: lo que la gerencia y la dueña deben ver en rojo. */
    overdue: solicitudVencida(r, ahora),
  };
}

/** El socio actúa por sí mismo: la bitácora lo dice (`MEMBER`), igual que al descargar sus datos. */
export function ctxDeSocio(request: FastifyRequest, organizationId: string): RequestContext {
  return {
    requestId: request.id, ip: request.ip, userAgent: request.headers['user-agent'],
    tenant: { organizationId, actorType: 'MEMBER', grants: [], limits: UNLIMITED_LIMITS, branchScopeHint: null, requestId: request.id },
  } as RequestContext;
}
