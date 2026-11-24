import { diasEntre, formatMoney, inicioDeMes, inicioDelMesSiguiente, masDias, money } from '@gymflow/core';

/**
 * REGLAS DE LA FACTURA DE GYMFLOW (auditoría 8, fase 4, bloque 4.9; decisión
 * D-39). Funciones puras: la emisión, la vista previa, la ficha de la consola
 * y la cuenta que ve el dueño leen las mismas.
 *
 * La factura NO es un CFDI ni se timbra: es un estado de cuenta. Se arma así:
 *
 *  1. RENGLONES del mes, a precio de lista (sin IVA). El primer mes de una
 *     marca y un módulo contratado a medio mes se cobran POR DÍAS.
 *  2. DESCUENTO o precio especial de ese mes, si la marca tiene uno: un
 *     renglón en negativo, con su motivo.
 *  3. IVA sobre lo que queda, si ya empezó a aplicar. Nace APAGADO.
 *
 * Todo en centavos enteros (`bigint`); un importe con fracción de centavo se
 * redondea al centavo más cercano, y el medio centavo sube.
 */

/** La tasa general del IVA, en puntos base: 16 %. */
export const IVA_BPS = 1600;
const BASE_BPS = 10_000n;

/** `num / den` al entero más cercano; el medio sube. Solo para importes no negativos. */
export function redondear(num: bigint, den: bigint): bigint {
  return (num * 2n + den) / (den * 2n);
}

const pesos = (c: bigint): string => formatMoney(money(c));
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const nombreDelMes = (dia: string): string => MESES[Number(dia.slice(5, 7)) - 1]!;
/** `1600` → «16 %»; `1250` → «12.5 %». */
export const porcentaje = (bps: number): string => `${(bps / 100).toString()} %`;

// ── 1. Cobro por días ────────────────────────────────────────────────────────

/** Cuántos días tiene ese mes (`AAAA-MM` o un día suyo): los del calendario real, 28 a 31. */
export function diasDelMes(mes: string): number {
  const inicio = inicioDeMes(`${mes.slice(0, 7)}-01`);
  return diasEntre(inicio, inicioDelMesSiguiente(inicio));
}

/**
 * Los días que se cobran de un mes a algo que empezó el día `desde`: del día
 * en que empezó, INCLUIDO, al último del mes.
 *  - empezó antes de ese mes (o no se sabe cuándo: `null`): el mes completo;
 *  - empezó el día 1: el mes completo (no hay nada que prorratear);
 *  - empezó el último día: un día;
 *  - empieza después de ese mes: cero.
 */
export function diasACobrar(mes: string, desde: string | null): { dias: number; de: number } {
  const inicio = inicioDeMes(`${mes.slice(0, 7)}-01`);
  const fin = inicioDelMesSiguiente(inicio);
  const de = diasEntre(inicio, fin);
  if (!desde || desde <= inicio) return { dias: de, de };
  if (desde >= fin) return { dias: 0, de };
  return { dias: diasEntre(desde, fin), de };
}

/** El precio de un mes por los días que tocan: `precio × días ÷ días del mes`, redondeado al centavo. */
export function prorratear(cents: bigint, dias: number, de: number): bigint {
  if (dias >= de) return cents;
  if (dias <= 0) return 0n;
  return redondear(cents * BigInt(dias), BigInt(de));
}

/** «16 de 30 días (del 15 al 30 de noviembre)». */
export function textoDeDias(mes: string, dias: number, de: number): string {
  const ultimo = masDias(inicioDelMesSiguiente(`${mes.slice(0, 7)}-01`), -1);
  const primero = de - dias + 1;
  const tramo = dias === 1 ? `el ${de} de ${nombreDelMes(ultimo)}` : `del ${primero} al ${de} de ${nombreDelMes(ultimo)}`;
  return `${dias} de ${de} días (${tramo})`;
}

// ── 2. Descuento o precio especial por meses ─────────────────────────────────

export type ClaseDeAjuste = 'PERCENT' | 'AMOUNT' | 'SPECIAL_PRICE';
export type Ajuste = {
  id: string;
  kind: ClaseDeAjuste;
  /** PERCENT: puntos base (2000 = 20 %). */
  percentBps: number | null;
  /** AMOUNT: el descuento al mes. SPECIAL_PRICE: lo que cuesta la mensualidad completa, sin IVA. */
  amountCents: bigint | null;
  /** Día 1 del mes de la primera factura que lo lleva. */
  fromMonth: string;
  months: number;
  reason: string;
  canceled: boolean;
};

/** Día 1 del ÚLTIMO mes cuya factura lleva el ajuste. */
export function ultimoMesDe(a: Pick<Ajuste, 'fromMonth' | 'months'>): string {
  let cursor = a.fromMonth;
  for (let i = 1; i < a.months; i += 1) cursor = inicioDelMesSiguiente(cursor);
  return cursor;
}

/** ¿La factura de ese mes lleva el ajuste? Solo las de sus meses: después caduca solo. */
export function aplicaEn(a: Ajuste, mes: string): boolean {
  const dia = `${mes.slice(0, 7)}-01`;
  return !a.canceled && dia >= a.fromMonth && dia <= ultimoMesDe(a);
}

/** El ajuste de la factura de ese mes, si lo hay (una marca tiene a lo más uno vivo por mes). */
export function ajusteDe(ajustes: readonly Ajuste[], mes: string): Ajuste | null {
  return ajustes.find((a) => aplicaEn(a, mes)) ?? null;
}

/** ¿Dos ajustes vivos tocan algún mes en común? */
export function seEnciman(a: Pick<Ajuste, 'fromMonth' | 'months'>, b: Pick<Ajuste, 'fromMonth' | 'months'>): boolean {
  return a.fromMonth <= ultimoMesDe(b) && b.fromMonth <= ultimoMesDe(a);
}

/** Dónde va un ajuste respecto del mes en curso. */
export function estadoDeAjuste(a: Ajuste, mesActual: string): 'SCHEDULED' | 'ACTIVE' | 'ENDED' | 'CANCELED' {
  const dia = `${mesActual.slice(0, 7)}-01`;
  if (a.canceled) return 'CANCELED';
  if (dia < a.fromMonth) return 'SCHEDULED';
  return dia > ultimoMesDe(a) ? 'ENDED' : 'ACTIVE';
}

/**
 * Cuánto descuenta el ajuste en UNA factura.
 *  - `baseCents`: lo que se cobra de ESE mes en esa factura (ya por días, si
 *    tocó); los días de un mes anterior que vengan en la misma factura no
 *    entran al descuento.
 *  - `listaCents`: lo que costaría ese mes completo a precio de lista.
 *
 * PERCENT: ese porcentaje de la base. AMOUNT: el importe, sin pasar de la
 * base (una factura no queda en negativo). SPECIAL_PRICE: el mes completo
 * cuesta `amountCents` en vez de la lista; en un mes cobrado por días, la
 * misma proporción. Un precio especial mayor o igual que la lista no descuenta
 * nada (nunca sube lo que se cobra).
 */
export function descuentoDe(a: Ajuste, baseCents: bigint, listaCents: bigint): bigint {
  if (baseCents <= 0n) return 0n;
  if (a.kind === 'PERCENT') return redondear(baseCents * BigInt(a.percentBps ?? 0), BASE_BPS);
  const importe = a.amountCents ?? 0n;
  if (a.kind === 'AMOUNT') return importe < baseCents ? importe : baseCents;
  if (listaCents <= 0n || importe >= listaCents) return 0n;
  return baseCents - redondear(baseCents * importe, listaCents);
}

/** Como sale escrito el renglón del descuento en la factura. */
export function textoDeAjuste(a: Pick<Ajuste, 'kind' | 'percentBps' | 'amountCents' | 'reason'>): string {
  const que = a.kind === 'PERCENT' ? `Descuento de ${porcentaje(a.percentBps ?? 0)}`
    : a.kind === 'AMOUNT' ? 'Descuento'
      : `Precio especial de ${pesos(a.amountCents ?? 0n)} al mes`;
  return `${que} · ${a.reason}`;
}

// ── 3. IVA ───────────────────────────────────────────────────────────────────

/** El IVA que llevan las facturas desde un mes. `included`: los precios ya lo traen dentro. */
export type Impuesto = { rateBps: number; included: boolean };
export const SIN_IVA: Impuesto = { rateBps: 0, included: false };

export type CambioDeIva = Impuesto & { id: string; /** Día 1 del mes de la primera factura. */ effectiveFrom: string; canceled: boolean };

/** El IVA de la factura de ese mes: el cambio vivo más reciente que ya empezó. Sin ninguno, no hay IVA. */
export function impuestoEn(cambios: readonly CambioDeIva[], mes: string): Impuesto {
  const dia = `${mes.slice(0, 7)}-01`;
  const vivos = cambios.filter((c) => !c.canceled && c.effectiveFrom <= dia).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const ultimo = vivos.at(-1);
  return ultimo ? { rateBps: ultimo.rateBps, included: ultimo.included && ultimo.rateBps > 0 } : SIN_IVA;
}

export type Desglose = { subtotalCents: bigint; taxCents: bigint; taxRateBps: number; taxIncluded: boolean; totalCents: bigint };

/**
 * Subtotal, IVA y total de una factura a partir de la suma de sus renglones
 * (ya con el descuento). El IVA se calcula UNA vez, sobre el subtotal de la
 * factura, no renglón por renglón.
 *  - Sin IVA: subtotal = total.
 *  - IVA aparte (los precios son SIN IVA): IVA = subtotal × tasa; total = subtotal + IVA.
 *  - IVA incluido en los precios: el total es la suma; subtotal = total ÷ (1 + tasa); IVA = total − subtotal.
 */
export function desglosar(sumaCents: bigint, impuesto: Impuesto): Desglose {
  const tasa = BigInt(impuesto.rateBps);
  if (tasa <= 0n || sumaCents <= 0n) return { subtotalCents: sumaCents, taxCents: 0n, taxRateBps: 0, taxIncluded: false, totalCents: sumaCents };
  if (impuesto.included) {
    const subtotal = redondear(sumaCents * BASE_BPS, BASE_BPS + tasa);
    return { subtotalCents: subtotal, taxCents: sumaCents - subtotal, taxRateBps: impuesto.rateBps, taxIncluded: true, totalCents: sumaCents };
  }
  const iva = redondear(sumaCents * tasa, BASE_BPS);
  return { subtotalCents: sumaCents, taxCents: iva, taxRateBps: impuesto.rateBps, taxIncluded: false, totalCents: sumaCents + iva };
}
