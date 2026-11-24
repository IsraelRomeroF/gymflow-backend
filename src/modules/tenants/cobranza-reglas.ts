import { diasEntre, formatMoney, inicioDelMesSiguiente, masDias, money } from '@gymflow/core';

/**
 * REGLAS DE LA COBRANZA DE PLATAFORMA (auditoría 8, fase 3, bloque 3.11;
 * decisiones D-37 y D-38). Funciones puras: el job, la consola y la cuenta
 * que ve el dueño leen las mismas.
 *
 * D-37 · Un gimnasio atrasado se suspende SOLO a los 15 días de atraso. Es la
 * decisión que apaga un gimnasio entero, así que la cuenta de esos días no
 * empieza con el vencimiento a secas: empieza el día en que hay CONSTANCIA de
 * que el aviso de «factura vencida» le llegó al dueño (una notificación
 * entregada a su teléfono, lo vio en su panel, o una persona de GymFlow se lo
 * mandó). En el camino normal el aviso sale y llega el primer día de atraso, y
 * los 15 días son los 15 días. Con una factura que ya llevaba semanas vencida
 * cuando esto se estrenó, o que se avisó tarde, los 15 días corren desde el
 * aviso: nadie queda suspendido de golpe sin haberlo leído antes.
 */
export const DIAS_PARA_SUSPENDER = 15;
/** Al reanudar a una marca que sigue debiendo algo vencido: días que la suspensión automática la deja en paz. */
export const DIAS_DE_PRORROGA = 15;
/** Lo más lejos que se puede poner una prórroga a mano. */
export const DIAS_MAX_DE_PRORROGA = 60;

const mayor = (a: string, b: string): string => (a > b ? a : b);

export type FacturaEnCobranza = {
  id: string; folio: string;
  /** `AAAA-MM-DD`. */
  dueDate: string;
  saldoCents: bigint;
  /** El día con constancia de entrega del aviso de vencida VIGENTE de esta factura; null si no hay aviso o no hay constancia. */
  avisoEntregadoEl: string | null;
};

/** El primer día que cuenta para suspender: no antes de vencer ni antes de que el aviso llegara. */
function inicioDelConteo(f: Pick<FacturaEnCobranza, 'dueDate' | 'avisoEntregadoEl'>): string | null {
  if (!f.avisoEntregadoEl) return null;
  return mayor(masDias(f.dueDate, 1), f.avisoEntregadoEl);
}

/**
 * Días de atraso AVISADO: los que cuentan para suspender. 0 si la factura no
 * ha vencido o si el aviso de vencida no tiene constancia de entrega. El día
 * en que el aviso llega es el día 1.
 */
export function atrasoAvisado(f: Pick<FacturaEnCobranza, 'dueDate' | 'avisoEntregadoEl'>, hoy: string): number {
  const inicio = inicioDelConteo(f);
  if (!inicio || hoy < inicio) return 0;
  return diasEntre(inicio, hoy) + 1;
}

/** El día en que esa factura suspendería a la marca, sin contar prórrogas; null sin constancia del aviso. */
export function suspenderiaEl(f: Pick<FacturaEnCobranza, 'dueDate' | 'avisoEntregadoEl'>): string | null {
  const inicio = inicioDelConteo(f);
  return inicio ? masDias(inicio, DIAS_PARA_SUSPENDER - 1) : null;
}

export type PorQueNoSuspende = 'NO_EN_USO' | 'SIN_ADEUDO_VENCIDO' | 'AVISO_SIN_ENTREGAR' | 'EN_PLAZO' | 'PRORROGA';
export type DecisionDeSuspension = {
  suspender: boolean;
  /** Por qué no (o `SUSPENDER`). */
  por: PorQueNoSuspende | 'SUSPENDER';
  /** La factura que manda: la que antes suspende. */
  factura: FacturaEnCobranza | null;
  /** Días de atraso desde el vencimiento (lo que lee la consola). */
  overdueDays: number;
  /** Días de atraso con aviso entregado (lo que cuenta). */
  noticedDays: number;
  /** El día en que se suspendería si nada cambia; null si hoy no hay fecha (sin adeudo vencido o aviso sin entregar). */
  suspendsOn: string | null;
};

/**
 * ¿Se suspende HOY esta marca? Solo si está en uso, tiene una factura vencida
 * con saldo, el aviso de vencida de ESA factura lleva 15 días entregado y no
 * hay una prórroga vigente. Cualquier duda, no se suspende.
 */
export function decidirSuspension(entrada: {
  serviceStatus: string;
  /** Las facturas PENDING de la marca. */
  facturas: readonly FacturaEnCobranza[];
  hoy: string;
  /** Prórroga: hasta ese día, incluido, no se suspende. */
  prorrogaHasta: string | null;
}): DecisionDeSuspension {
  const { hoy } = entrada;
  const nada = { factura: null, overdueDays: 0, noticedDays: 0, suspendsOn: null };
  if (entrada.serviceStatus !== 'ACTIVE') return { suspender: false, por: 'NO_EN_USO', ...nada };
  const vencidas = entrada.facturas.filter((f) => f.saldoCents > 0n && diasEntre(f.dueDate, hoy) > 0);
  if (vencidas.length === 0) return { suspender: false, por: 'SIN_ADEUDO_VENCIDO', ...nada };
  const overdueDays = Math.max(...vencidas.map((f) => diasEntre(f.dueDate, hoy)));
  // Manda la que antes suspendería; si ninguna tiene constancia de aviso, la más vieja.
  const conFecha = vencidas.filter((f) => suspenderiaEl(f) !== null).sort((a, b) => suspenderiaEl(a)!.localeCompare(suspenderiaEl(b)!));
  const factura = conFecha[0] ?? [...vencidas].sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]!;
  const noticedDays = atrasoAvisado(factura, hoy);
  if (conFecha.length === 0) return { suspender: false, por: 'AVISO_SIN_ENTREGAR', factura, overdueDays, noticedDays: 0, suspendsOn: null };
  const porConteo = suspenderiaEl(factura)!;
  const prorroga = entrada.prorrogaHasta && entrada.prorrogaHasta >= hoy ? entrada.prorrogaHasta : null;
  const suspendsOn = prorroga ? mayor(porConteo, masDias(prorroga, 1)) : porConteo;
  if (hoy < porConteo) return { suspender: false, por: 'EN_PLAZO', factura, overdueDays, noticedDays, suspendsOn };
  if (prorroga) return { suspender: false, por: 'PRORROGA', factura, overdueDays, noticedDays, suspendsOn };
  return { suspender: true, por: 'SUSPENDER', factura, overdueDays, noticedDays, suspendsOn: hoy };
}

// ── Los textos de los avisos (se congelan al nacer el aviso) ─────────────────

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** `2026-11` o `2026-11-01` → «noviembre de 2026». */
export const nombreDeMes = (mes: string): string => `${MESES[Number(mes.slice(5, 7)) - 1]} de ${mes.slice(0, 4)}`;
/** `2026-12-03` → «3 de diciembre de 2026». */
export const diaLargo = (dia: string): string => `${Number(dia.slice(8, 10))} de ${nombreDeMes(dia)}`;
const pesos = (c: bigint): string => formatMoney(money(c));

export type ClaseDeAviso = 'INVOICE_ISSUED' | 'INVOICE_OVERDUE' | 'SERVICE_SUSPENDED' | 'PRICE_CHANGE' | 'PRICE_CHANGE_CANCELED';
export type TextoDeAviso = { title: string; body: string };

export function avisoDeFacturaEmitida(f: { folio: string; periodStart: string; saldoCents: bigint; dueDate: string }): TextoDeAviso {
  return {
    title: `Factura de GymFlow de ${nombreDeMes(f.periodStart)}`,
    body: `GymFlow emitió la factura ${f.folio} de ${nombreDeMes(f.periodStart)} por ${pesos(f.saldoCents)}. Vence el ${diaLargo(f.dueDate)}.`,
  };
}

export function avisoDeFacturaVencida(f: { folio: string; saldoCents: bigint; dueDate: string }): TextoDeAviso {
  return {
    title: 'Factura de GymFlow vencida',
    body: `La factura ${f.folio} de GymFlow venció el ${diaLargo(f.dueDate)} y debe ${pesos(f.saldoCents)}. `
      + `Si el pago no se registra, el servicio se suspende a los ${DIAS_PARA_SUSPENDER} días de atraso: nadie del gimnasio podrá entrar al sistema hasta que se pague. Tus datos se conservan.`,
  };
}

export function avisoDeSuspension(f: { folio: string; saldoCents: bigint }): TextoDeAviso {
  return {
    title: 'Servicio de GymFlow suspendido',
    body: `El servicio de GymFlow quedó suspendido por falta de pago de la factura ${f.folio} (${pesos(f.saldoCents)}). `
      + 'No se borró nada: socios, cobros e historial se conservan completos. En cuanto se registre el pago, el servicio se reanuda.',
  };
}

export function avisoDeCambioDePrecio(x: { effectiveFrom: string; antesCents: bigint; despuesCents: bigint }): TextoDeAviso {
  const sube = x.despuesCents > x.antesCents;
  return {
    title: `Tu mensualidad de GymFlow cambia en ${nombreDeMes(x.effectiveFrom)}`,
    body: `A partir de la factura de ${nombreDeMes(x.effectiveFrom)}, tu mensualidad de GymFlow ${sube ? 'sube' : 'baja'} de ${pesos(x.antesCents)} a ${pesos(x.despuesCents)}. Hasta entonces pagas lo mismo que hoy.`,
  };
}

export function avisoDeCambioCancelado(x: { effectiveFrom: string; sigueCents: bigint }): TextoDeAviso {
  return {
    title: 'El cambio anunciado de tu mensualidad ya no aplica',
    body: `El cambio que se te avisó para la factura de ${nombreDeMes(x.effectiveFrom)} ya no aplica: tu mensualidad de GymFlow sigue en ${pesos(x.sigueCents)}.`,
  };
}

// ── D-38 · Desde cuándo aplica un cambio de precio o de plan ─────────────────

/**
 * La primera factura que puede llevar un cambio anunciado HOY: la del primer
 * mes que empieza con al menos un mes de aviso. Anunciado el 23 de noviembre,
 * aplica desde la factura de enero; anunciado el 1 de diciembre, también.
 */
export function primeraVigencia(hoy: string): string {
  const siguiente = inicioDelMesSiguiente(hoy);
  return hoy.slice(8, 10) === '01' ? siguiente : inicioDelMesSiguiente(siguiente);
}

/** Un cambio no cancelado de un valor (un precio, o el precio y los módulos de un plan). */
export type CambioDeValor<T> = { effectiveFrom: string; before: T; after: T; applied: boolean };

/**
 * Lo que valía (o valdrá) algo el día `dia`, a partir de lo que vale HOY y de
 * sus cambios no cancelados:
 *  - si después de `dia` hay un cambio YA aplicado, ese día valía lo de antes
 *    del más antiguo de ellos (facturar tarde un mes pasado usa su precio);
 *  - si hasta `dia` hay un cambio anunciado SIN aplicar, ese día vale lo
 *    nuevo (la emisión no depende de que el job lo haya aplicado ya);
 *  - si no, lo de hoy.
 */
export function valorEn<T>(actual: T, cambios: ReadonlyArray<CambioDeValor<T>>, dia: string): T {
  const orden = [...cambios].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const aplicadoDespues = orden.find((c) => c.applied && c.effectiveFrom > dia);
  if (aplicadoDespues) return aplicadoDespues.before;
  const anunciados = orden.filter((c) => !c.applied && c.effectiveFrom <= dia);
  return anunciados.length > 0 ? anunciados.at(-1)!.after : actual;
}
