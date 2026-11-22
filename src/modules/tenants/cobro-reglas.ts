import { diasEntre, hoyEn, inicioDeMes, inicioDelMesSiguiente, masDias } from '@gymflow/core';

/**
 * REGLAS DEL COBRO DE PLATAFORMA (auditoría 8, bloque 1.13). Funciones puras:
 * el servicio, la lista de Marcas, la bandeja, la emisión del mes y el job
 * leen las mismas, y la consola pinta lo que estas dicen (23-02, 23-14).
 *
 * GymFlow cobra desde la Ciudad de México: «hoy», «este mes» y «vence» son
 * de ese calendario, no del reloj UTC del servidor ni del navegador (23-12,
 * 23-14, 23-15). Los días son texto `AAAA-MM-DD`.
 */
export const ZONA_DE_COBRO = 'America/Mexico_City';
/** Días para pagar desde que se emite. */
export const PLAZO_DIAS = 10;
/** Hasta qué día del mes emite el job: si el día 1 el servidor no corrió, el 2 o el 3 lo alcanzan. Pasado ese día, a una marca en uso sin factura del mes le falta. */
export const DIAS_DE_GRACIA = 3;
/** Un pago registrado por error se deshace hasta estos días después de registrarlo. */
export const DIAS_PARA_DESHACER = 7;

/** Hoy en el calendario del cobro. */
export const hoyDeCobro = (ahora: Date = new Date()): string => hoyEn(ZONA_DE_COBRO, ahora);
/** El mes en curso del cobro, `AAAA-MM`. */
export const mesDeCobro = (ahora: Date = new Date()): string => hoyDeCobro(ahora).slice(0, 7);
/** El día de calendario (en la zona del cobro) de un instante. */
export const diaDeCobroDe = (instante: Date): string => hoyEn(ZONA_DE_COBRO, instante);

export const esMes = (texto: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(texto);
/** Primer día del mes y primer día del siguiente (fin exclusivo). */
export function periodoDe(mes: string): { inicio: string; fin: string } {
  const inicio = inicioDeMes(`${mes}-01`);
  return { inicio, fin: inicioDelMesSiguiente(inicio) };
}
/** Cuándo vence una factura emitida ese día. */
export const venceEl = (emitidaEl: string): string => masDias(emitidaEl, PLAZO_DIAS);

// ── Estado de UNA factura ────────────────────────────────────────────────────

export type EstadoDeFactura = 'PENDIENTE' | 'PAGADA_EN_PARTE' | 'VENCIDA' | 'PAGADA' | 'ANULADA';

export type FacturaParaEstado = {
  /** Lo guardado: PENDING, PAID o VOID. */
  status: string;
  totalCents: bigint; paidCents: bigint;
  /** `AAAA-MM-DD`. */
  dueDate: string;
};

/** Días de atraso de una factura que todavía debe; 0 si no ha vencido. Vence al terminar su día de vencimiento. */
export function diasDeAtraso(f: FacturaParaEstado, hoy: string): number {
  if (f.status !== 'PENDING') return 0;
  return Math.max(0, diasEntre(f.dueDate, hoy));
}

/**
 * EL estado de una factura, uno solo para todas las pantallas (antes cada
 * una decidía «vencida» con su propio reloj). Vencida gana a «pagada en
 * parte»: lo que importa es que hay saldo fuera de plazo.
 */
export function estadoDeFactura(f: FacturaParaEstado, hoy: string): EstadoDeFactura {
  if (f.status === 'VOID') return 'ANULADA';
  if (f.status === 'PAID') return 'PAGADA';
  if (diasDeAtraso(f, hoy) > 0) return 'VENCIDA';
  return f.paidCents > 0n ? 'PAGADA_EN_PARTE' : 'PENDIENTE';
}

/** Lo que falta por pagar de una factura viva. */
export const saldoDe = (f: { status: string; totalCents: bigint; paidCents: bigint }): bigint => (f.status === 'PENDING' ? f.totalCents - f.paidCents : 0n);

// ── Estado de cobro de UNA marca ─────────────────────────────────────────────

/**
 * En orden de prioridad (23-02):
 *  1. VENCIDA: debe algo fuera de plazo.
 *  2. NO_FACTURABLE: está en uso y algo de lo que tiene contratado no tiene precio, aunque tenga historial.
 *  3. SIN_FACTURA_DEL_MES: está en uso, ya pasó el día de gracia y no tiene factura viva del mes en curso.
 *  4. POR_VENCER: debe algo todavía en plazo.
 *  5. AL_CORRIENTE.
 * A una marca que no está en uso (sin liberar o suspendida) no se le emite:
 * si no debe nada, su estado es SIN_COBRO, no «al corriente».
 */
export type EstadoDeCobro = 'VENCIDA' | 'NO_FACTURABLE' | 'SIN_FACTURA_DEL_MES' | 'POR_VENCER' | 'AL_CORRIENTE' | 'SIN_COBRO';

export type FacturaDeMarca = FacturaParaEstado & { /** `AAAA-MM-DD`, día 1 del mes que cubre. */ periodStart: string };

export function estadoDeCobro(entrada: {
  facturas: readonly FacturaDeMarca[];
  /** ACTIVE = en uso; lo demás no se factura. */
  serviceStatus: string;
  /** Falta el precio de algo contratado. */
  sinPrecio: boolean;
  /** El día en que se liberó el software (`AAAA-MM-DD`), si se liberó. */
  liberadaEl: string | null;
  hoy: string;
}): { code: EstadoDeCobro; overdueDays: number; pendingCents: bigint } {
  const { facturas, hoy } = entrada;
  const pendientes = facturas.filter((f) => f.status === 'PENDING');
  const pendingCents = pendientes.reduce((a, f) => a + saldoDe(f), 0n);
  const atraso = Math.max(0, ...pendientes.map((f) => diasDeAtraso(f, hoy)));
  if (atraso > 0) return { code: 'VENCIDA', overdueDays: atraso, pendingCents };
  const enUso = entrada.serviceStatus === 'ACTIVE';
  if (enUso && entrada.sinPrecio) return { code: 'NO_FACTURABLE', overdueDays: 0, pendingCents };
  if (enUso && faltaLaDelMes(facturas, hoy)) return { code: 'SIN_FACTURA_DEL_MES', overdueDays: 0, pendingCents };
  if (pendientes.length > 0) return { code: 'POR_VENCER', overdueDays: 0, pendingCents };
  return { code: enUso ? 'AL_CORRIENTE' : 'SIN_COBRO', overdueDays: 0, pendingCents };
}

/** ¿Tiene factura viva del mes de `hoy`? */
export function tieneLaDelMes(facturas: readonly FacturaDeMarca[], hoy: string): boolean {
  const mes = hoy.slice(0, 7);
  return facturas.some((f) => f.status !== 'VOID' && f.periodStart.slice(0, 7) === mes);
}

/** Ya pasó el día de gracia y la marca en uso sigue sin la factura del mes. */
function faltaLaDelMes(facturas: readonly FacturaDeMarca[], hoy: string): boolean {
  return Number(hoy.slice(8, 10)) > DIAS_DE_GRACIA && !tieneLaDelMes(facturas, hoy);
}

// ── A quién y de qué mes se emite (23-06): una regla para la marca suelta y para el lote ──

export type MotivoDeNoEmitir = 'NOT_IN_USE' | 'ALREADY_INVOICED' | 'MISSING_PRICES' | 'ZERO_TOTAL' | 'BEFORE_RELEASE' | 'FUTURE_MONTH';

/**
 * Por qué NO se le emite ese mes a esa marca, o null si procede. El orden es
 * el que le sirve a quien lee: primero lo que no depende de precios.
 */
export function motivoDeNoEmitir(entrada: {
  mes: string; hoy: string;
  serviceStatus: string; liberadaEl: string | null;
  yaTieneFactura: boolean; sinPrecio: readonly string[]; totalCents: bigint;
}): { reason: MotivoDeNoEmitir; texto: string } | null {
  if (entrada.serviceStatus !== 'ACTIVE') {
    return { reason: 'NOT_IN_USE', texto: entrada.serviceStatus === 'SUSPENDED' ? 'El servicio está suspendido: no se le factura' : 'El software no está liberado: no se le factura' };
  }
  if (entrada.mes > entrada.hoy.slice(0, 7)) return { reason: 'FUTURE_MONTH', texto: 'Ese mes todavía no empieza' };
  if (entrada.liberadaEl && entrada.mes < entrada.liberadaEl.slice(0, 7)) return { reason: 'BEFORE_RELEASE', texto: 'Ese mes es anterior a la liberación del software' };
  if (entrada.yaTieneFactura) return { reason: 'ALREADY_INVOICED', texto: 'Ya tiene factura de ese mes' };
  if (entrada.sinPrecio.length > 0) return { reason: 'MISSING_PRICES', texto: `Sin precio: ${entrada.sinPrecio.join(', ')}` };
  if (entrada.totalCents <= 0n) return { reason: 'ZERO_TOTAL', texto: 'Mensualidad en cero' };
  return null;
}
