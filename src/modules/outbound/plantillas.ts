import { formatMoney, money } from '@gymflow/core';
import type { OutboundKind } from '@gymflow/core/contracts';
import { ESTADO_DE_HABITO } from '@gymflow/core/vocabulario';

/**
 * LO QUE DICE CADA MENSAJE (bloque 2.9; 15-08, 28-14).
 *
 * Una plantilla por motivo, fija y en el servidor: recepción ya no teclea el
 * mensaje ni cada pantalla arma el suyo. El texto se escribe con los datos de
 * HOY (lo que queda por pagar, la fecha) y habla de tú, corto y sin promesas:
 * lo manda una persona desde su WhatsApp.
 *
 * Editarlas por gimnasio (15, §3.4) queda pendiente: hoy son las mismas para todos.
 */
export type DatosDelMensaje = {
  kind: OutboundKind;
  firstName: string;
  /** El nombre comercial del gimnasio y, si tiene varias sedes, la del socio. */
  gimnasio: string;
  sede: string | null;
  concept: string | null;
  dueCents: bigint | null;
  /** `@db.Date`: medianoche UTC. */
  dueDate: Date | null;
  planName: string | null;
  /** El primer día que YA NO cubre el plan (`currentPeriodEnd`): el último día es el anterior. */
  periodEnd: Date | null;
  engagementState: string | null;
  /** Con cobro en línea no se manda al socio solo al mostrador. */
  enLinea: boolean;
};

// Las fechas de calendario son medianoche UTC: leídas en hora de México caían un día antes.
const dia = (d: Date) => d.toLocaleDateString('es-MX', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const ultimoDia = (fin: Date) => new Date(fin.getTime() - 86_400_000);
const importe = (c: bigint | null) => (c === null ? '' : formatMoney(money(c)));

const TE_EXTRANAMOS: Readonly<Record<string, string>> = {
  ONBOARDING_AT_RISK: 'Vimos que casi no has venido desde que te inscribiste. ¿Te ayudamos a arrancar? Dinos qué horario te acomoda y aquí te esperamos.',
  SLIPPING: 'Notamos que has venido menos estas semanas. ¿Todo bien? Aquí te esperamos para que retomes tu ritmo.',
  DORMANT: 'Hace tiempo que no te vemos y te extrañamos. ¿Cuándo regresas? Si necesitas algo, cuéntanos.',
};

/** El mensaje completo, listo para WhatsApp. */
export function textoDelMensaje(d: DatosDelMensaje): string {
  const saludo = `Hola ${d.firstName}, te escribimos de ${d.gimnasio}${d.sede ? ` (${d.sede})` : ''}.`;
  const donde = d.enLinea ? 'desde tu portal o en recepción' : 'en recepción';
  switch (d.kind) {
    case 'PAYMENT_DUE_SOON':
      // Sin cargo todavía: es la membresía que se renueva (su cuota nace ese día). No se dice
      // importe: el precio de la cuota lo fija la emisión, no esta plantilla.
      if (d.dueDate === null) {
        return `${saludo} Te recordamos que tu siguiente pago${d.planName ? ` de ${d.planName}` : ''} es el ${d.periodEnd ? dia(d.periodEnd) : 'próximo día de pago'}. Puedes pagarlo ${donde}. ¡Gracias!`;
      }
      return `${saludo} Te recordamos que tu pago de ${d.concept ?? 'tu membresía'} por ${importe(d.dueCents)} vence el ${d.dueDate ? dia(d.dueDate) : 'próximo día de pago'}. Puedes pagarlo ${donde}. ¡Gracias!`;
    case 'PAYMENT_OVERDUE':
      return `${saludo} Tu pago de ${d.concept ?? 'tu membresía'} por ${importe(d.dueCents)} venció el ${d.dueDate ? dia(d.dueDate) : 'día de pago'}. Puedes ponerte al corriente ${donde} para seguir entrenando sin interrupciones.`;
    case 'MEMBERSHIP_SUSPENDED':
      return `${saludo} Tu membresía quedó suspendida porque se agotó el plazo para pagar. En cuanto pagues ${donde}, vuelves a entrar.`;
    case 'MEMBERSHIP_ENDING':
      return `${saludo} Tu plan${d.planName ? ` ${d.planName}` : ''} termina el ${d.periodEnd ? dia(ultimoDia(d.periodEnd)) : 'en unos días'}. Si quieres seguir sin interrupciones, puedes renovarlo en recepción.`;
    case 'WE_MISS_YOU':
      return `${saludo} ${TE_EXTRANAMOS[d.engagementState ?? ''] ?? TE_EXTRANAMOS.DORMANT!}`;
  }
}

const corta = (d: Date) => d.toLocaleDateString('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'long' });

/** De qué es, en una línea, para la fila de la lista. */
export function detalleDelMensaje(d: Pick<DatosDelMensaje, 'kind' | 'concept' | 'dueCents' | 'dueDate' | 'planName' | 'periodEnd' | 'engagementState'>): string {
  switch (d.kind) {
    case 'PAYMENT_DUE_SOON':
      if (d.dueDate === null) return [d.planName, d.periodEnd ? `su siguiente pago es el ${corta(d.periodEnd)}` : null].filter(Boolean).join(' · ');
      return [d.concept, importe(d.dueCents), d.dueDate ? `vence el ${corta(d.dueDate)}` : null].filter(Boolean).join(' · ');
    case 'PAYMENT_OVERDUE':
      return [d.concept, importe(d.dueCents), d.dueDate ? `venció el ${corta(d.dueDate)}` : null].filter(Boolean).join(' · ');
    case 'MEMBERSHIP_SUSPENDED':
      return ['Se agotó su plazo de gracia', d.planName].filter(Boolean).join(' · ');
    case 'MEMBERSHIP_ENDING':
      return [d.planName, d.periodEnd ? `termina el ${corta(ultimoDia(d.periodEnd))}` : null, 'no se renueva solo'].filter(Boolean).join(' · ');
    case 'WE_MISS_YOU':
      return ESTADO_DE_HABITO[d.engagementState ?? '']?.label ?? 'En riesgo';
  }
}
