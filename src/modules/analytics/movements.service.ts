import { descuadreQueCuenta } from '@gymflow/core';
import { MovementsRepository, type FilaDia, type Movimiento } from './movements.repository.js';
import { ExpensesRepository, ajustesPorMes, prorrateoDiario, restaDeLaGanancia, retirosDelDueno } from '../finance/index.js';

const MS_DIA = 86_400_000;
const dia = (d: Date) => d.toISOString().slice(0, 10);

export type ResumenDia = {
  date: string;
  /** Pagos de socios y ventas del punto de venta cobradas. */
  incomeCents: bigint;
  /** Reversas y reembolsos (negativo). */
  refundsCents: bigint;
  /** Gastos pagados de la caja (negativo). */
  expensesCents: bigint;
  /** Sobrantes y faltantes al cerrar caja, sumados con su signo. Solo informa: ver `shortageCents`. */
  varianceCents: bigint;
  /** Faltantes de los cortes, corte por corte (negativo): ESTO es lo que resta (13-05, 14-09). */
  shortageCents: bigint;
  /** Sobrantes de los cortes (positivo): no suman, se informan «por aclarar». */
  overageCents: bigint;
  /** Lo que de verdad le quedó al gimnasio ese día. */
  netCents: bigint;
  /** Efectivo que salió de la caja al banco: NO es gasto, es el mismo dinero. */
  toBankCents: bigint;
  /** Pagado con saldo a favor: se informa, no es dinero nuevo. */
  creditNotesCents: bigint;
  /** Renta, nómina, servicios: el gasto del mes repartido entre sus días (negativo). */
  fixedExpensesCents: bigint;
  /** GANANCIA del día: lo que quedó en caja menos su parte de los gastos fijos. */
  profitCents: bigint;
  byMethod: Record<string, bigint>;
};


/**
 * La ganancia REAL de cada día: entró − devoluciones − gastos ± descuadres.
 *
 * No es el "ganado" del tablero (que reparte una anualidad entre sus doce
 * meses): esto es caja, lo que el dueño pregunta al cerrar el día. Tampoco
 * descuenta lo que el sistema no conoce: renta, nómina ni costo de los
 * productos; eso se dice en pantalla.
 */
export class MovementsService {
  async resumen(organizationId: string, from: Date, to: Date, sedes: readonly string[] | null) {
    const [todas, gastos] = await Promise.all([
      new MovementsRepository(organizationId).porDia(from, to),
      new ExpensesRepository(organizationId).vigentes(from, to),
    ]);
    const filas = filtrar(todas, sedes);
    // Un gasto de todo el gimnasio (branchId null) cuenta en la vista de toda
    // la organización; en la de una sede, solo los de esa sede.
    // El retiro del dueño no es gasto (D-23): no entra al reparto por día.
    const queRestan = gastos.filter(restaDeLaGanancia);
    const fijos = prorrateoDiario(sedes === null ? queRestan : queRestan.filter((g) => g.branchId !== null && sedes.includes(g.branchId)), from, to);
    const dias = new Map<string, ResumenDia>();
    for (let t = from.getTime(); t < to.getTime(); t += MS_DIA) {
      const d = dia(new Date(t));
      dias.set(d, {
        date: d, incomeCents: 0n, refundsCents: 0n, expensesCents: 0n, varianceCents: 0n, shortageCents: 0n, overageCents: 0n, netCents: 0n, toBankCents: 0n,
        creditNotesCents: 0n, fixedExpensesCents: fijos.get(d) ?? 0n, profitCents: 0n, byMethod: {},
      });
    }
    for (const f of filas) {
      const r = dias.get(dia(f.day));
      if (!r) continue;
      const v = BigInt(f.amountCents);
      switch (f.kind) {
        case 'PAYMENT': case 'POS_SALE':
          r.incomeCents += v;
          if (f.method) r.byMethod[f.method] = (r.byMethod[f.method] ?? 0n) + v;
          break;
        case 'REFUND': r.refundsCents += v; break;
        case 'CASH_EXPENSE': r.expensesCents += v; break;
        case 'CASH_VARIANCE': {
          // Cada fila es UN corte: la regla única del núcleo, corte por corte.
          const corte = descuadreQueCuenta(v);
          r.varianceCents += v;
          r.shortageCents += corte.faltanteCents;
          r.overageCents += corte.sobranteCents;
          break;
        }
        case 'CASH_WITHDRAWAL': case 'CASH_DEPOSIT': r.toBankCents += v; break;
        case 'CREDIT_NOTE': r.creditNotesCents += v; break;
        default: break; // fondo inicial y correcciones: mueven la caja, no la ganancia
      }
    }
    const days = [...dias.values()].map((r) => {
      // Un faltante es dinero que se fue; un sobrante es dinero sin explicar
      // (una venta sin registrar, un cambio mal dado) y NO es ganancia (DM-10):
      // se informa aparte hasta que alguien diga de dónde salió.
      const netCents = r.incomeCents + r.refundsCents + r.expensesCents + r.shortageCents;
      return { ...r, netCents, profitCents: netCents + r.fixedExpensesCents };
    });
    const sum = (k: keyof Omit<ResumenDia, 'date' | 'byMethod'>) => days.reduce((a, d) => a + (d[k] as bigint), 0n);
    const byMethod: Record<string, bigint> = {};
    for (const d of days) for (const [m, v] of Object.entries(d.byMethod)) byMethod[m] = (byMethod[m] ?? 0n) + v;
    return {
      days,
      totals: {
        incomeCents: sum('incomeCents'), refundsCents: sum('refundsCents'), expensesCents: sum('expensesCents'),
        varianceCents: sum('varianceCents'), shortageCents: sum('shortageCents'), overageCents: sum('overageCents'),
        netCents: sum('netCents'), toBankCents: sum('toBankCents'),
        creditNotesCents: sum('creditNotesCents'), fixedExpensesCents: sum('fixedExpensesCents'), profitCents: sum('profitCents'), byMethod,
      },
      /** Retiros del dueño de los meses del periodo (positivo): se informan, no restan (D-23). */
      ownerDrawsCents: retirosDelDueno(gastos, sedes),
      /** «Ajustes de ‹mes›» anotados en los meses del periodo: ya van dentro de los gastos fijos (D-22). */
      adjustments: ajustesPorMes(gastos, sedes),
    };
  }

  async delDia(organizationId: string, day: Date, sedes: readonly string[] | null): Promise<Movimiento[]> {
    return filtrar(await new MovementsRepository(organizationId).delDia(day), sedes);
  }
}

function filtrar<T extends Pick<FilaDia, 'branchId'>>(filas: T[], sedes: readonly string[] | null): T[] {
  return sedes === null ? filas : filas.filter((f) => f.branchId !== null && sedes.includes(f.branchId));
}
