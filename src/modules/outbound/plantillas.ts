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
  /** Solo PRICE_CHANGE: lo que pagaba y lo que pagará por periodo. */
  priceFromCents: bigint | null;
  priceToCents: bigint | null;
  /** Con cobro en línea no se manda al socio solo al mostrador. */
  enLinea: boolean;
  /** Para nombrarlo completo cuando el mensaje va a quien responde por su celular. */
  lastName?: string | null;
  /**
   * Celular compartido (D-09; bloque 3.10): el nombre de pila de quien
   * responde por el número. Con él, el mensaje la saluda a ella y habla DEL
   * socio. `null` o ausente = va al propio socio.
   */
  para?: string | null;
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

/** Lo mismo, dicho a quien responde por el celular: se habla DEL socio, sin suponer si es él o ella. */
const TE_EXTRANAMOS_DE_OTRO: Readonly<Record<string, string>> = {
  ONBOARDING_AT_RISK: 'Vimos que casi no ha venido desde que se inscribió. ¿Le ayudamos a arrancar? Dinos qué horario le acomoda.',
  SLIPPING: 'Notamos que ha venido menos estas semanas. ¿Todo bien? Aquí le esperamos para que retome su ritmo.',
  DORMANT: 'Hace tiempo que no viene al gimnasio. ¿Cuándo regresa? Si necesita algo, cuéntanos.',
};

/** El mensaje completo, listo para WhatsApp. */
export function textoDelMensaje(d: DatosDelMensaje): string {
  if (d.para) return textoParaElResponsable(d, d.para);
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
    case 'PRICE_CHANGE': {
      // D-19: se avisa antes de su siguiente pago, con el antes y el después. Sin promesas ni disculpas.
      const plan = d.planName ? `tu plan ${d.planName}` : 'tu plan';
      const baja = d.priceFromCents !== null && d.priceToCents !== null && d.priceToCents < d.priceFromCents;
      return `${saludo} Te avisamos que a partir de tu siguiente pago ${plan} ${baja ? 'baja a' : 'cuesta'} ${importe(d.priceToCents)}${d.priceFromCents !== null ? ` (antes ${importe(d.priceFromCents)})` : ''}. Cualquier duda, con gusto te atendemos en recepción.`;
    }
  }
}

/**
 * CELULAR COMPARTIDO (D-09; fase 3, bloque 3.10). El número del socio lo
 * responde otra persona (su mamá, su pareja): el mismo hecho, dicho a ELLA y
 * diciendo de quién se habla. Antes le llegaba «Hola Renata, tu pago vence…»
 * a quien no es Renata, y con dos socios en el mismo número no se sabía de
 * cuál era cada mensaje. Se saluda por su nombre y se nombra al socio completo.
 */
function textoParaElResponsable(d: DatosDelMensaje, para: string): string {
  const socio = `${d.firstName} ${d.lastName ?? ''}`.trim();
  const saludo = `Hola ${para}, te escribimos de ${d.gimnasio}${d.sede ? ` (${d.sede})` : ''} por ${socio}, que tiene registrado este celular.`;
  const donde = d.enLinea ? 'desde su portal o en recepción' : 'en recepción';
  switch (d.kind) {
    case 'PAYMENT_DUE_SOON':
      if (d.dueDate === null) {
        return `${saludo} Te recordamos que su siguiente pago${d.planName ? ` de ${d.planName}` : ''} es el ${d.periodEnd ? dia(d.periodEnd) : 'próximo día de pago'}. Se puede pagar ${donde}. ¡Gracias!`;
      }
      return `${saludo} Te recordamos que su pago de ${d.concept ?? 'su membresía'} por ${importe(d.dueCents)} vence el ${d.dueDate ? dia(d.dueDate) : 'próximo día de pago'}. Se puede pagar ${donde}. ¡Gracias!`;
    case 'PAYMENT_OVERDUE':
      return `${saludo} Su pago de ${d.concept ?? 'su membresía'} por ${importe(d.dueCents)} venció el ${d.dueDate ? dia(d.dueDate) : 'día de pago'}. Se puede poner al corriente ${donde} para seguir entrenando sin interrupciones.`;
    case 'MEMBERSHIP_SUSPENDED':
      return `${saludo} Su membresía quedó suspendida porque se agotó el plazo para pagar. En cuanto se pague ${donde}, vuelve a entrar.`;
    case 'MEMBERSHIP_ENDING':
      return `${saludo} Su plan${d.planName ? ` ${d.planName}` : ''} termina el ${d.periodEnd ? dia(ultimoDia(d.periodEnd)) : 'en unos días'}. Para seguir sin interrupciones, se puede renovar en recepción.`;
    case 'WE_MISS_YOU':
      return `${saludo} ${TE_EXTRANAMOS_DE_OTRO[d.engagementState ?? ''] ?? TE_EXTRANAMOS_DE_OTRO.DORMANT!}`;
    case 'PRICE_CHANGE': {
      const plan = d.planName ? `su plan ${d.planName}` : 'su plan';
      const baja = d.priceFromCents !== null && d.priceToCents !== null && d.priceToCents < d.priceFromCents;
      return `${saludo} Te avisamos que a partir de su siguiente pago ${plan} ${baja ? 'baja a' : 'cuesta'} ${importe(d.priceToCents)}${d.priceFromCents !== null ? ` (antes ${importe(d.priceFromCents)})` : ''}. Cualquier duda, con gusto te atendemos en recepción.`;
    }
  }
}

const corta = (d: Date) => d.toLocaleDateString('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'long' });

/** De qué es, en una línea, para la fila de la lista. */
export function detalleDelMensaje(d: Pick<DatosDelMensaje, 'kind' | 'concept' | 'dueCents' | 'dueDate' | 'planName' | 'periodEnd' | 'engagementState' | 'priceFromCents' | 'priceToCents'>): string {
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
    case 'PRICE_CHANGE':
      return [d.planName, d.priceFromCents !== null && d.priceToCents !== null ? `de ${importe(d.priceFromCents)} a ${importe(d.priceToCents)}` : null, 'desde su siguiente pago'].filter(Boolean).join(' · ');
  }
}
