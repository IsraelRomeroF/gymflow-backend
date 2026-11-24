import { describe, it, expect } from 'vitest';
import { esVencimiento, primerVencimiento, vencimientos } from '../src/modules/finance/recurrentes.js';

/**
 * Fase 4, bloque 4.5 (D-26): cuándo toca un gasto que se repite. Función
 * pura, sin reloj ni base.
 */
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const dias = (xs: Date[]) => xs.map((x) => x.toISOString().slice(0, 10));

describe('4.5 · vencimientos de un gasto que se repite', () => {
  it('cada mes: el mismo día; si el mes no lo tiene, su último día', () => {
    expect(dias(vencimientos('MONTHLY', d('2024-01-31'), d('2024-01-01'), d('2024-05-01')))).toEqual(['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30']);
    expect(dias(vencimientos('MONTHLY', d('2025-01-31'), d('2025-02-01'), d('2025-03-01')))).toEqual(['2025-02-28']);
    expect(dias(vencimientos('MONTHLY', d('2024-03-01'), d('2024-11-01'), d('2025-02-01')))).toEqual(['2024-11-01', '2024-12-01', '2025-01-01']);
  });

  it('cada quincena: el 15 y el último día del mes', () => {
    expect(dias(vencimientos('BIWEEKLY', d('2024-02-01'), d('2024-02-01'), d('2024-03-01')))).toEqual(['2024-02-15', '2024-02-29']);
    // Empieza el 16: la primera es la de fin de mes.
    expect(dias(vencimientos('BIWEEKLY', d('2024-03-16'), d('2024-03-01'), d('2024-04-16')))).toEqual(['2024-03-31', '2024-04-15']);
  });

  it('cada semana: cada siete días desde que empieza, aunque cruce de mes o de año', () => {
    expect(dias(vencimientos('WEEKLY', d('2024-12-20'), d('2024-12-01'), d('2025-01-11')))).toEqual(['2024-12-20', '2024-12-27', '2025-01-03', '2025-01-10']);
    expect(dias(vencimientos('WEEKLY', d('2024-03-01'), d('2024-04-01'), d('2024-04-15')))).toEqual(['2024-04-05', '2024-04-12']);
  });

  it('nada antes de empezar, ni fuera de la ventana (el final no entra)', () => {
    expect(vencimientos('MONTHLY', d('2024-06-10'), d('2024-01-01'), d('2024-06-10'))).toEqual([]);
    expect(dias(vencimientos('MONTHLY', d('2024-06-10'), d('2024-01-01'), d('2024-06-11')))).toEqual(['2024-06-10']);
    expect(vencimientos('WEEKLY', d('2024-06-10'), d('2024-06-11'), d('2024-06-11'))).toEqual([]);
  });

  it('esVencimiento y primerVencimiento dicen lo mismo que la lista', () => {
    expect(esVencimiento('BIWEEKLY', d('2024-02-01'), d('2024-02-29'))).toBe(true);
    expect(esVencimiento('BIWEEKLY', d('2024-02-01'), d('2024-02-28'))).toBe(false);
    expect(esVencimiento('WEEKLY', d('2024-02-01'), d('2024-02-08'))).toBe(true);
    expect(esVencimiento('WEEKLY', d('2024-02-01'), d('2024-01-25'))).toBe(false);
    expect(dias([primerVencimiento('BIWEEKLY', d('2024-02-14')), primerVencimiento('BIWEEKLY', d('2024-02-16')), primerVencimiento('MONTHLY', d('2024-02-16')), primerVencimiento('WEEKLY', d('2024-02-16'))]))
      .toEqual(['2024-02-15', '2024-02-29', '2024-02-16', '2024-02-16']);
  });
});
