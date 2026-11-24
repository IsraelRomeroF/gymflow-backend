import type { FrecuenciaDeGasto } from '@gymflow/core/contracts';

const MS_DIA = 86_400_000;
const utc = (a: number, m: number, d: number) => new Date(Date.UTC(a, m, d));
const ultimoDia = (a: number, m: number) => utc(a, m + 1, 0).getUTCDate();

/**
 * CUÁNDO TOCA un gasto que se repite (D-26, bloque 4.5). Pura: fechas de
 * calendario (medianoche UTC), sin reloj.
 *
 *  - `MONTHLY`: cada mes, el mismo día que `startsOn`; si el mes no tiene ese
 *    día (31 en febrero), su último día.
 *  - `BIWEEKLY`: cada quincena, el día 15 y el último del mes.
 *  - `WEEKLY`: cada siete días desde `startsOn`.
 *
 * Devuelve las fechas en `[from, to)` que no son anteriores a `startsOn`, en
 * orden. De aquí salen las propuestas «por confirmar»: no se guardan, se
 * calculan cada vez, así que nada se anota solo.
 */
export function vencimientos(frequency: FrecuenciaDeGasto, startsOn: Date, from: Date, to: Date): Date[] {
  const desde = Math.max(from.getTime(), startsOn.getTime());
  const hasta = to.getTime();
  if (desde >= hasta) return [];
  const out: Date[] = [];
  const cabe = (d: Date) => { if (d.getTime() >= desde && d.getTime() < hasta) out.push(d); };

  if (frequency === 'WEEKLY') {
    const paso = 7 * MS_DIA;
    const saltos = Math.max(0, Math.ceil((desde - startsOn.getTime()) / paso));
    for (let t = startsOn.getTime() + saltos * paso; t < hasta; t += paso) cabe(new Date(t));
    return out;
  }
  const inicio = new Date(desde);
  // `Date.UTC` acepta el mes 12, 13…: pasa solo al año siguiente.
  for (let a = inicio.getUTCFullYear(), m = inicio.getUTCMonth(); utc(a, m, 1).getTime() < hasta; m++) {
    const fin = ultimoDia(a, m);
    if (frequency === 'MONTHLY') cabe(utc(a, m, Math.min(startsOn.getUTCDate(), fin)));
    else { cabe(utc(a, m, 15)); cabe(utc(a, m, fin)); }
  }
  return out;
}

/** ¿Ese día es uno de los que le tocan a la plantilla? */
export function esVencimiento(frequency: FrecuenciaDeGasto, startsOn: Date, dia: Date): boolean {
  return vencimientos(frequency, startsOn, dia, new Date(dia.getTime() + MS_DIA)).length === 1;
}

/** La primera fecha en que toca, desde `startsOn` (incluido). */
export function primerVencimiento(frequency: FrecuenciaDeGasto, startsOn: Date): Date {
  // Una quincena o un mes después siempre hay una: 62 días sobran.
  return vencimientos(frequency, startsOn, startsOn, new Date(startsOn.getTime() + 62 * MS_DIA))[0]!;
}
