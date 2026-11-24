/**
 * GANCHO "membresía cerrada" (DM-03, DM-07).
 *
 * Cancelar o expirar una membresía tiene consecuencias en el DINERO (lo
 * pagado y no usado queda a favor; la deuda NO se borra: D-12, D-13), pero `memberships` no puede importar
 * `billing` —`billing` ya depende de `memberships` y el ciclo haría
 * inextraíbles a los dos (ADR-026)—. Igual que `cash` con `pos`, aquí solo se
 * anuncia el hecho; `billing` se registra al montarse (`src/modules.ts`).
 */
export type MembershipClosed = {
  organizationId: string;
  membershipId: string;
  memberId: string;
  outcome: 'CANCELED' | 'EXPIRED';
  reason: string;
  /**
   * El estado del que salió (bloque 3.5, D-12). `PENDING` = la venta nunca se
   * cobró ni dio acceso: es el único cierre que anula sus cuotas por regla.
   */
  fromStatus: string;
  /** Quién la cerró; nulo si fue un job (bloque 3.5, D-13: el saldo a favor queda a su nombre). */
  actorUserId: string | null;
};

type Hook = (evento: MembershipClosed) => Promise<void>;
const ganchos: Hook[] = [];

export function registerMembershipClosedHook(fn: Hook): void {
  if (!ganchos.includes(fn)) ganchos.push(fn);
}

export async function emitMembershipClosed(evento: MembershipClosed): Promise<void> {
  for (const g of ganchos) await g(evento);
}
