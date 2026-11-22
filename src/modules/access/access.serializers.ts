import { z } from 'zod';
import type { AccessRepository, DecisionRecord } from './access.repository.js';

/** Lo que comparten las rutas de la entrada: el parámetro `:id` y cómo se pinta una decisión. */
export const idParam = z.object({ id: z.string().uuid() });

/** El contrato del núcleo como `schema.response`: una sola forma para toda la API (`platform/http/respuesta.ts`, bloque 1.2). */
export { respuesta } from '../../platform/http/respuesta.js';

/**
 * `resueltos`: qué rechazos de la lista ya se resolvieron (5-10). Un rechazo
 * con `resolvedByDecisionId` ya no se levanta: la pantalla lo pinta resuelto.
 */
export function serializeDecision(d: DecisionRecord, resueltos?: Map<string, DecisionRecord>) {
  return {
    id: d.id,
    branchId: d.branchId,
    gatewayId: d.gatewayId,
    memberId: d.memberId,
    outcome: d.outcome,
    denialReason: d.denialReason,
    credentialKind: d.credentialKind,
    policyVersion: d.policyVersion,
    decidedOffline: d.decidedOffline,
    overrideReason: d.overrideReason,
    resolvesDecisionId: d.resolvesDecisionId,
    resolvedByDecisionId: resueltos?.get(d.id)?.id ?? null,
    at: d.at.toISOString(),
  };
}

/** Los rechazos de la lista ya resueltos, en una consulta. */
export async function resueltosDe(repo: AccessRepository, rows: readonly DecisionRecord[]): Promise<Map<string, DecisionRecord>> {
  return repo.resolucionesDe(rows.filter((d) => d.outcome === 'DENIED').map((d) => d.id));
}
