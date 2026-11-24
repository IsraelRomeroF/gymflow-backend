import type { RequestContext } from '../context.js';

/**
 * «COMO APODERADO» EN EL ASIENTO DE LA OPERACIÓN (D-02; fase 3, bloque 3.16).
 *
 * El asiento de la FIRMA ya dice «firmó como apoderado de …» (bloque 3.1). El
 * de la operación que se registró con esa firma (el retiro, el reembolso)
 * solo llevaba a quien autorizó (`approvedByUserId`), sin decir que firmó con
 * un nombramiento. El dato está en `approval_grants.proxyId`.
 *
 * Al consumir la firma (`ApprovalService.verify`) se anota aquí, atado a la
 * petición en curso; al escribir el asiento (`AuditService.record`) con ese
 * mismo `approvedByUserId`, se le agrega a su estado. Así ninguna de las
 * decenas de operaciones que piden firma tiene que saberlo. Si el asiento se
 * escribe con otro contexto (un job), no lleva la nota: queda como antes.
 */
export type FirmaDeApoderado = { proxyId: string; proxyOfUserId: string; proxyOfName: string | null };

const porPeticion = new WeakMap<object, Map<string, FirmaDeApoderado>>();

export function anotarFirmaDeApoderado(ctx: RequestContext, approverUserId: string, firma: FirmaDeApoderado): void {
  // Por el contexto y por su inquilino: hay servicios que copian el contexto (`{ ...ctx }`) y conservan el inquilino.
  for (const llave of [ctx, ctx.tenant] as object[]) {
    const m = porPeticion.get(llave) ?? new Map<string, FirmaDeApoderado>();
    m.set(approverUserId, firma);
    porPeticion.set(llave, m);
  }
}

export function firmaDeApoderado(ctx: RequestContext, approverUserId: string): FirmaDeApoderado | null {
  return porPeticion.get(ctx)?.get(approverUserId) ?? porPeticion.get(ctx.tenant)?.get(approverUserId) ?? null;
}

/** El estado del asiento con la nota del apoderado. Solo se agrega a un objeto (o a nada): una lista o un texto se dejan como están. */
export function conFirmaDeApoderado(afterState: unknown, firma: FirmaDeApoderado): unknown {
  if (afterState !== undefined && afterState !== null && (typeof afterState !== 'object' || Array.isArray(afterState))) return afterState;
  return { ...(afterState as Record<string, unknown> | null | undefined ?? {}), approvedAsProxy: true, approvedProxyId: firma.proxyId, approvedProxyOfUserId: firma.proxyOfUserId, approvedProxyOfName: firma.proxyOfName };
}
