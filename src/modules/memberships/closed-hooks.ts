/**
 * GANCHO "membresía cerrada" (DM-03, DM-07).
 *
 * Cancelar o expirar una membresía tiene consecuencias en el DINERO (sus
 * cuotas sin pagar dejan de ser deuda), pero `memberships` no puede importar
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
};

type Hook = (evento: MembershipClosed) => Promise<void>;
const ganchos: Hook[] = [];

export function registerMembershipClosedHook(fn: Hook): void {
  if (!ganchos.includes(fn)) ganchos.push(fn);
}

export async function emitMembershipClosed(evento: MembershipClosed): Promise<void> {
  for (const g of ganchos) await g(evento);
}
