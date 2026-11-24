import { delinquencyRate } from '@gymflow/core';
import type { CajaDelCierre, MonthlyClose } from '@gymflow/core/contracts';

/**
 * EL MES CERRADO SE SIRVE DESDE SU FOTO (3.7 · D-22).
 *
 * Al cerrar, `finance` guarda la foto completa (`version: 2`): lo del Tablero
 * y lo de Movimientos, del gimnasio y de cada sucursal. Desde entonces, pedir
 * ese mes devuelve estas cifras y no un recálculo: un cargo anulado en
 * diciembre o una membresía cancelada después ya no mueven octubre.
 *
 * Devuelve `null` cuando la foto no alcanza: es anterior a la foto completa,
 * o quien mira tiene sedes que la foto no trae completas. Entonces se
 * recalcula y la respuesta lo dice (`fromSnapshot: false`).
 */
type Sucursal = MonthlyClose['byBranch'][number];
type Completa = {
  collectedCents: string; accruedCents: string; deferredCents: string; mrrCents: string; outstandingCents: string; overdueCents: string;
  cashExpensesCents: string; cashOverageCents: string; fixedExpensesCents: string; profitCents: string; ownerDrawsCents: string; costOfGoodsCents: string;
  activeMembers: number; membersBehind: number; membersBase: number; cash: CajaDelCierre;
};

export type FotoDeAlcance = { cifras: Completa; branches: Sucursal[] };

const DINERO = ['collectedCents', 'accruedCents', 'deferredCents', 'mrrCents', 'outstandingCents', 'overdueCents', 'cashExpensesCents', 'cashOverageCents', 'fixedExpensesCents', 'profitCents', 'ownerDrawsCents', 'costOfGoodsCents'] as const;
const CAJA = ['incomeCents', 'refundsCents', 'expensesCents', 'shortageCents', 'overageCents', 'netCents', 'toBankCents', 'creditNotesCents', 'fixedExpensesCents', 'profitCents'] as const;
const mas = (a: string, b: string): string => (BigInt(a) + BigInt(b)).toString();

/** ¿Trae todo? Las fotos anteriores a la completa (y el cajón «sin sucursal») no. */
function completaDe(x: { [K in keyof Completa]?: Completa[K] | undefined }): Completa | null {
  const { cash, membersBase, membersBehind, activeMembers } = x;
  if (cash === undefined || membersBase === undefined || membersBehind === undefined || activeMembers === undefined) return null;
  const dinero: Partial<Record<(typeof DINERO)[number], string>> = {};
  for (const k of DINERO) { const v = x[k]; if (v === undefined) return null; dinero[k] = v; }
  return { ...(dinero as Record<(typeof DINERO)[number], string>), activeMembers, membersBehind, membersBase, cash };
}

const CAJA_EN_CEROS: CajaDelCierre = {
  incomeCents: '0', refundsCents: '0', expensesCents: '0', shortageCents: '0', overageCents: '0', netCents: '0', toBankCents: '0',
  creditNotesCents: '0', fixedExpensesCents: '0', profitCents: '0', byMethod: {},
};
const EN_CEROS: Completa = {
  collectedCents: '0', accruedCents: '0', deferredCents: '0', mrrCents: '0', outstandingCents: '0', overdueCents: '0', activeMembers: 0,
  cashExpensesCents: '0', cashOverageCents: '0', fixedExpensesCents: '0', profitCents: '0', ownerDrawsCents: '0', costOfGoodsCents: '0', membersBehind: 0, membersBase: 0, cash: CAJA_EN_CEROS,
};

function sumar(a: Completa, b: Completa): Completa {
  const byMethod: Record<string, string> = { ...a.cash.byMethod };
  for (const [k, v] of Object.entries(b.cash.byMethod)) byMethod[k] = mas(byMethod[k] ?? '0', v);
  return {
    ...Object.fromEntries(DINERO.map((k) => [k, mas(a[k], b[k])])) as Pick<Completa, (typeof DINERO)[number]>,
    activeMembers: a.activeMembers + b.activeMembers, membersBehind: a.membersBehind + b.membersBehind, membersBase: a.membersBase + b.membersBase,
    cash: { ...Object.fromEntries(CAJA.map((k) => [k, mas(a.cash[k], b.cash[k])])) as Omit<CajaDelCierre, 'byMethod'>, byMethod },
  };
}

/** La foto para ese alcance: todo el gimnasio (`null`) o la suma de esas sucursales. */
export function fotoPara(cierre: Pick<MonthlyClose, 'totals' | 'byBranch'>, sedes: readonly string[] | null): FotoDeAlcance | null {
  if (cierre.totals.version !== 2) return null;
  if (sedes === null) { const todo = completaDe(cierre.totals); return todo ? { cifras: todo, branches: cierre.byBranch } : null; }
  let cifras = EN_CEROS;
  const branches: Sucursal[] = [];
  for (const id of sedes) {
    const b = cierre.byBranch.find((x) => x.branchId === id);
    // Una sede sin fila en una foto completa no tuvo nada ese mes: ceros.
    if (!b) continue;
    const suya = completaDe(b);
    if (!suya) return null;
    cifras = sumar(cifras, suya);
    branches.push(b);
  }
  return { cifras, branches };
}

/** Vencido entre lo que se debe, de 0 a 1, con la misma función que el cálculo en vivo. */
export const morosidadDeLaFoto = (c: Completa): number => delinquencyRate(BigInt(c.overdueCents), BigInt(c.outstandingCents));
