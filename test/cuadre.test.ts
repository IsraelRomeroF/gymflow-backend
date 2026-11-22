import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, CONSENTIMIENTOS } from './helpers.js';
import { closeDb } from '../src/platform/db/client.js';

/**
 * CUADRE (fase 4): el Tablero, Movimientos y el corte hablan del mismo dinero.
 * Lo que "entró" hoy en el Tablero es lo que Movimientos suma como ingreso
 * menos devoluciones; un cobro nuevo mueve a los dos por igual.
 */
describe('cuadre · Tablero = Movimientos', () => {
  let app: FastifyInstance;
  let owner: string; let gerencia: string;
  let cen: string; let planId: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'owner@demo.mx');
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    cen = (await orgFixtures()).demoBranches.find((b) => b.code === 'CEN')!.id;
    planId = ((await app.inject({ method: 'GET', url: '/plans', headers: { cookie: gerencia } })).json() as Array<{ code: string; id: string }>).find((p) => p.code === 'MEN')!.id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const manana = () => { const d = new Date(`${hoy()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

  async function tablero(): Promise<bigint> {
    const r = await app.inject({ method: 'GET', url: `/dashboard?from=${hoy()}&to=${manana()}&fresh=1`, headers: { cookie: owner } });
    expect(r.statusCode, r.body).toBe(200);
    return BigInt(r.json().money.collectedCents);
  }
  async function movimientos(): Promise<bigint> {
    const r = await app.inject({ method: 'GET', url: `/reports/daily?from=${hoy()}&to=${hoy()}`, headers: { cookie: owner } });
    expect(r.statusCode, r.body).toBe(200);
    return BigInt(r.json().totals.incomeCents) + BigInt(r.json().totals.refundsCents);
  }

  it('lo que entró hoy es la misma cifra en el Tablero y en Movimientos, antes y después de un cobro', async () => {
    const antesT = await tablero(); const antesM = await movimientos();
    expect(antesT).toBe(antesM);

    const alta = await app.inject({ method: 'POST', url: '/members', headers: { cookie: gerencia }, payload: { firstName: nombreUnico('Cuadre'), lastName: nombreUnico('Hoy'), homeBranchId: cen, force: true, consents: CONSENTIMIENTOS } });
    const venta = await app.inject({ method: 'POST', url: `/members/${alta.json().id}/memberships/sale`, headers: { cookie: gerencia }, payload: { planId, branchId: cen, payment: { method: 'SPEI_TRANSFER', externalRef: `CUADRE${Date.now()}` } } });
    expect(venta.statusCode, venta.body).toBe(201);
    const cobrado = BigInt(venta.json().totalCents);
    expect(cobrado).toBeGreaterThan(0n);

    const despuesT = await tablero(); const despuesM = await movimientos();
    expect(despuesT - antesT).toBe(cobrado);
    expect(despuesM - antesM).toBe(cobrado);
    expect(despuesT).toBe(despuesM);
  });
});
