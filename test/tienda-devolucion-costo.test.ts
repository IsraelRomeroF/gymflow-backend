import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { makeApp, loginAs, aprobacion } from './helpers.js';
import { closeDb } from '../src/platform/db/client.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { ponerReloj, relojReal } from './reloj.js';
import { CashSessionRepository } from '../src/modules/cash/index.js';
import { AnalyticsRepository } from '../src/modules/analytics/analytics.repository.js';

/**
 * FASE 3 · BLOQUE 3.16 · UNA VENTA DE TIENDA DEVUELTA DEJA DE CONTAR SU COSTO (D-21).
 *
 * El Tablero resta de la utilidad el costo de lo vendido. Una venta devuelta
 * (D-13) regresó su producto al estante: su costo se descuenta el día de la
 * DEVOLUCIÓN, igual que su importe, y el día de la venta no cambia (D-22).
 * Gimnasio propio y reloj de prueba: se vende un día y se devuelve al siguiente.
 */
describe('tienda · el costo de una venta devuelta (D-21, 3.16)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let sede: string;
  const DIA_VENTA = '2026-03-10';
  const DIA_DEVOLUCION = '2026-03-11';
  const fecha = (d: string) => new Date(`${d}T00:00:00.000Z`);

  const post = (cookie: string, url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, headers: { cookie }, payload });
  const costo = async (desde: string, hasta: string) => {
    const filas = await new AnalyticsRepository(g.organizationId).costOfGoodsSold(fecha(desde), fecha(hasta));
    return { costCents: filas.reduce((a, f) => a + BigInt(f.costCents), 0n), sinCosto: filas.reduce((a, f) => a + f.sinCosto, 0) };
  };
  const enCaja = async (turno: string) => { const r = new CashSessionRepository(g.organizationId); return r.expectedCashCents((await r.findById(turno))!); };

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio();
    sede = g.sedes[0]!.id;
  });
  afterAll(async () => { relojReal(); await g.cerrar(); await app.close(); await closeDb(); });

  it('se resta el día en que se devuelve; el día de la venta queda como estaba; las piezas sin costo también dejan de contarse', async () => {
    // Día 1 (mediodía del centro): se venden 2 con costo ($30 c/u) y 3 sin costo.
    // Las sesiones se abren con el reloj de verdad (la base decide su vigencia con su propio `now()`); después se corre el reloj.
    const gerente = await loginAs(app, g.correos.gerente);
    const dueno = await loginAs(app, g.correos.owner);
    ponerReloj(`${DIA_VENTA}T18:00:00.000Z`);
    const conCosto = await post(gerente, '/products', { sku: `PROT-${randomUUID().slice(0, 6)}`, name: 'Barra de prueba', priceCents: '5000', costCents: '3000', tracksInventory: false });
    expect(conCosto.statusCode, conCosto.body).toBe(201);
    const sinCosto = await post(gerente, '/products', { sku: `AGUA-${randomUUID().slice(0, 6)}`, name: 'Agua de prueba', priceCents: '2000', tracksInventory: false });
    expect(sinCosto.statusCode, sinCosto.body).toBe(201);
    const t1 = await post(gerente, '/cash-sessions', { cashRegisterId: g.sedes[0]!.cajas[0], openingFloatCents: '50000' });
    expect(t1.statusCode, t1.body).toBe(201);
    const vender = async (lines: Array<{ productId: string; quantity: number }>) => {
      const r = await post(gerente, '/pos/sales', { branchId: sede, method: 'CASH', cashSessionId: t1.json().id, lines, idempotencyKey: `costo-${randomUUID()}` });
      expect(r.statusCode, r.body).toBe(201);
      return r.json() as { id: string; totalCents: string };
    };
    const devuelta = await vender([{ productId: conCosto.json().id, quantity: 2 }, { productId: sinCosto.json().id, quantity: 3 }]);
    await vender([{ productId: conCosto.json().id, quantity: 1 }]);
    expect(await costo(DIA_VENTA, DIA_DEVOLUCION)).toEqual({ costCents: 9_000n, sinCosto: 3 });
    expect((await post(gerente, `/cash-sessions/${t1.json().id}/close`, { countedCashCents: (await enCaja(t1.json().id)).toString() })).statusCode).toBe(200);

    // Día 2: se devuelve la primera venta, con la firma de la dueña.
    ponerReloj(`${DIA_DEVOLUCION}T18:00:00.000Z`);
    const t2 = await post(gerente, '/cash-sessions', { cashRegisterId: g.sedes[0]!.cajas[1], openingFloatCents: '50000' });
    expect(t2.statusCode, t2.body).toBe(201);
    const firma = await aprobacion(app, gerente, 'pos:sale:return', g.correos.owner, sede, { resourceId: devuelta.id, amountCents: devuelta.totalCents });
    const r = await post(gerente, `/pos/sales/${devuelta.id}/return`, { reason: 'El cliente regresó todo', cashSessionId: t2.json().id, approvalToken: firma });
    expect(r.statusCode, r.body).toBe(201);

    // El día de la venta no cambió (un mes cerrado no se mueve)…
    expect(await costo(DIA_VENTA, DIA_DEVOLUCION)).toEqual({ costCents: 9_000n, sinCosto: 3 });
    // …el día de la devolución descuenta el costo de esa venta (2 × $30)…
    expect(await costo(DIA_DEVOLUCION, '2026-03-12')).toEqual({ costCents: -6_000n, sinCosto: 0 });
    // …y en el periodo que abarca los dos días queda solo lo que no se devolvió: 1 × $30 y ninguna pieza sin costo.
    expect(await costo(DIA_VENTA, '2026-03-12')).toEqual({ costCents: 3_000n, sinCosto: 0 });

    // El Tablero de esos dos días (`to` no se incluye): el costo de lo vendido es −$30, no −$90.
    const tablero = await app.inject({ method: 'GET', url: `/dashboard?from=${DIA_VENTA}&to=2026-03-12`, headers: { cookie: dueno } });
    expect(tablero.statusCode, tablero.body).toBe(200);
    expect(tablero.json().money.costOfGoodsCents).toBe('-3000');
    expect(tablero.json().notes.soldWithoutCost).toBe(0);
    expect((await post(gerente, `/cash-sessions/${t2.json().id}/close`, { countedCashCents: (await enCaja(t2.json().id)).toString() })).statusCode).toBe(200);
  });
});
