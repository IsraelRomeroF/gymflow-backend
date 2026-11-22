import type { PaymentMethodType } from '@gymflow/core';

/**
 * Registro de módulos que aportan dinero a un turno.
 *
 * Existe para cerrar una dependencia que en el dominio es BIDIRECCIONAL: una
 * venta de mostrador necesita un turno abierto (pos → cash), y el corte tiene
 * que sumar el producto vendido (cash → pos). Importarse mutuamente haría
 * inextraíbles a los dos módulos.
 *
 * Con este registro, `cash` no conoce a `pos`: solo sabe que alguien puede
 * aportar totales. Quien los conecta es `app.ts`, igual que compone las rutas.
 * El día que `pos` sea un servicio aparte, su contribuyente se sustituye por
 * un cliente HTTP y `cash` no cambia.
 */

export type ShiftContribution = {
  /** Etiqueta con la que aparece en el documento del turno. */
  readonly source: string;
  readonly byMethod: ReadonlyArray<{ method: PaymentMethodType; amountCents: bigint }>;
};

export type ShiftContributor = {
  readonly source: string;
  totalsForSession(organizationId: string, cashSessionId: string): Promise<ShiftContribution>;
};

const contribuyentes: ShiftContributor[] = [];

export function registerShiftContributor(c: ShiftContributor): void {
  if (contribuyentes.some((x) => x.source === c.source)) return;
  contribuyentes.push(c);
}

export function shiftContributors(): readonly ShiftContributor[] {
  return contribuyentes;
}

