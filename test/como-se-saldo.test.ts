import { describe, it, expect } from 'vitest';
import { liquidadoPor, type Liquidacion } from '@gymflow/core';
import type { SettledBy } from '@gymflow/core/contracts';
import { comoSeSaldo } from '../src/modules/billing/statement.serializers.js';

/**
 * DOS REGLAS PARA «CON QUÉ SE SALDÓ» UN CARGO, COMPARADAS CASO POR CASO
 * (pendiente de 1.6 → 1.3 / 1.10 / 1.17b).
 *
 * `liquidadoPor` (núcleo, 1.3) decide qué cuenta como ingreso y hasta dónde
 * está pagado; `comoSeSaldo` (`billing/statement.serializers.ts`, 1.6) decide
 * la palabra que ve la gente en el estado de cuenta. Son distintas a
 * propósito, con una equivalencia escrita en el contrato
 * (`StatementCharge.settledBy`). Nadie las comparaba: si una cambia sola, el
 * estado de cuenta dice «Pagado» de algo que los ingresos no cuentan.
 */
const EQUIVALE: Record<SettledBy, Liquidacion> = {
  PAYMENT: 'PAYMENT', MIXED: 'PAYMENT',
  WAIVER: 'WAIVER', DISCOUNT: 'WAIVER',
  CORRECTION: 'REFUND_CORRECTION',
};

type Ajuste = { adjustmentType: 'DISCOUNT' | 'WAIVER' | 'CORRECTION'; amountCents: bigint };
type Caso = { nombre: string; status: string; amountCents: bigint; allocatedCents: bigint; discountCents?: bigint; ajustes?: Ajuste[] };

const las = (c: Caso) => {
  const ajustes = c.ajustes ?? [];
  const adjustedCents = ajustes.reduce((a, x) => a + x.amountCents, 0n);
  return {
    pantalla: comoSeSaldo({ status: c.status as never, allocatedCents: c.allocatedCents, adjustedCents, discountCents: c.discountCents ?? 0n }, ajustes as never),
    ingresos: liquidadoPor({ status: c.status, amountCents: c.amountCents, allocatedCents: c.allocatedCents, adjustments: ajustes }),
  };
};

describe('con qué se saldó un cargo: la palabra de la pantalla y la regla de los ingresos', () => {
  const COINCIDEN: Array<Caso & { pantalla: SettledBy | null }> = [
    { nombre: 'pagado completo', status: 'PAID', amountCents: 60_000n, allocatedCents: 60_000n, pantalla: 'PAYMENT' },
    { nombre: 'pagado con descuento al venderlo', status: 'PAID', amountCents: 54_000n, allocatedCents: 54_000n, discountCents: 6_000n, pantalla: 'PAYMENT' },
    { nombre: 'pagó una parte y se le condonó el resto', status: 'PAID', amountCents: 60_000n, allocatedCents: 40_000n, ajustes: [{ adjustmentType: 'WAIVER', amountCents: 20_000n }], pantalla: 'MIXED' },
    { nombre: 'pagó una parte y el resto fue descuento', status: 'PAID', amountCents: 60_000n, allocatedCents: 50_000n, ajustes: [{ adjustmentType: 'DISCOUNT', amountCents: 10_000n }], pantalla: 'MIXED' },
    { nombre: 'condonado completo', status: 'PAID', amountCents: 60_000n, allocatedCents: 0n, ajustes: [{ adjustmentType: 'WAIVER', amountCents: 60_000n }], pantalla: 'WAIVER' },
    { nombre: 'descuento del total después de emitido', status: 'PAID', amountCents: 60_000n, allocatedCents: 0n, ajustes: [{ adjustmentType: 'DISCOUNT', amountCents: 60_000n }], pantalla: 'DISCOUNT' },
    { nombre: 'condonación y descuento, sin pago', status: 'PAID', amountCents: 60_000n, allocatedCents: 0n, ajustes: [{ adjustmentType: 'DISCOUNT', amountCents: 10_000n }, { adjustmentType: 'WAIVER', amountCents: 50_000n }], pantalla: 'WAIVER' },
    { nombre: 'cubierto por la corrección del cambio de plan', status: 'PAID', amountCents: 60_000n, allocatedCents: 0n, ajustes: [{ adjustmentType: 'CORRECTION', amountCents: 60_000n }], pantalla: 'CORRECTION' },
    { nombre: 'abierto', status: 'OPEN', amountCents: 60_000n, allocatedCents: 0n, pantalla: null },
    { nombre: 'pagado a medias', status: 'PARTIALLY_PAID', amountCents: 60_000n, allocatedCents: 20_000n, pantalla: null },
    { nombre: 'vencido', status: 'OVERDUE', amountCents: 60_000n, allocatedCents: 0n, pantalla: null },
    { nombre: 'anulado', status: 'VOID', amountCents: 60_000n, allocatedCents: 0n, pantalla: null },
  ];

  it.each(COINCIDEN)('$nombre: las dos reglas dicen lo mismo', (c) => {
    const r = las(c);
    expect(r.pantalla).toBe(c.pantalla);
    expect(r.ingresos).toBe(r.pantalla === null ? null : EQUIVALE[r.pantalla]);
  });

  /**
   * Donde NO dicen lo mismo, y está escrito: quien cambie una de las dos
   * reglas tiene que venir a decidir qué pasa con estos casos.
   */
  it('castigado: la pantalla dice «Condonado» y los ingresos no lo cuentan como saldado (declarado en el contrato)', () => {
    expect(las({ nombre: 'castigado', status: 'WRITTEN_OFF', amountCents: 60_000n, allocatedCents: 0n })).toEqual({ pantalla: 'WAIVER', ingresos: null });
  });

  it('una cortesía que nació en $0 con descuento del 100 %: la pantalla dice «Descuento»; para los ingresos no la saldó nadie', () => {
    expect(las({ nombre: 'cortesía', status: 'PAID', amountCents: 0n, allocatedCents: 0n, discountCents: 60_000n })).toEqual({ pantalla: 'DISCOUNT', ingresos: null });
  });

  it('corrección más condonación sin pago: la pantalla dice «Condonado» y los ingresos también lo tratan como perdón', () => {
    expect(las({ nombre: 'mixto sin pago', status: 'PAID', amountCents: 60_000n, allocatedCents: 0n, ajustes: [{ adjustmentType: 'CORRECTION', amountCents: 40_000n }, { adjustmentType: 'WAIVER', amountCents: 20_000n }] }))
      .toEqual({ pantalla: 'WAIVER', ingresos: 'WAIVER' });
  });

  /**
   * Para decidir (anotado en pendientes): un cargo de $0 SIN descuento (un plan gratis, una
   * cortesía sin registrar el descuento) sale como «Pagado» en el estado de cuenta, y para
   * los ingresos no lo saldó nadie. `comoSeSaldo` termina en `discountCents > 0n ?
   * 'DISCOUNT' : 'PAYMENT'`. No se marca como defecto: no hay regla escrita para este caso.
   */
  it('un cargo de $0 sin descuento: la pantalla dice «Pagado» y los ingresos no lo cuentan (sin regla escrita: decidir)', () => {
    expect(las({ nombre: 'cero', status: 'PAID', amountCents: 0n, allocatedCents: 0n })).toEqual({ pantalla: 'PAYMENT', ingresos: null });
  });
});
