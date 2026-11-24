import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { MeHome, diferenciasConElContrato } from '@gymflow/core/contracts';
import { makeApp, loginAs } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { BusinessCalendar } from '../src/platform/time/business-calendar.js';

/**
 * FASE 4 · BLOQUE 4.11 · «HOY TE TOCA» DICE LOS GASTOS QUE SE REPITEN POR CONFIRMAR (D-26).
 *
 * El renglón `expenses` de `GET /me/home` es la misma cuenta que Movimientos
 * (`pending` de `GET /expenses/recurring`), solo para quien anota gastos y en
 * sus sedes. Gimnasio propio; el mes es el del «hoy» del gimnasio.
 */
describe('inicio · gastos que se repiten por confirmar (bloque 4.11)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let owner: string; let gerente: string; let soloTablero: string; let recepcion: string;
  let mes: string;
  let renta: string;

  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const delInicio = async (cookie: string) => {
    const r = await get(cookie, '/me/home');
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(MeHome, r.json())).toEqual([]);
    const home = r.json() as MeHome;
    expect(home.unchecked).not.toContain('expenses');
    return home.items.find((i) => i.key === 'expenses') ?? null;
  };

  beforeAll(async () => {
    app = await makeApp(); await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Centro', cajas: 1 }] });
    // El segundo gerente tiene liberado SOLO el Tablero: ve el dinero, no anota gastos.
    await getDb().user.updateMany({ where: { organizationId: g.organizationId, email: g.correos.gerente2 }, data: { unlockedSections: ['tablero'] } });
    owner = await loginAs(app, g.correos.owner); gerente = await loginAs(app, g.correos.gerente);
    soloTablero = await loginAs(app, g.correos.gerente2); recepcion = await loginAs(app, g.correos.recepcion);
    mes = (await new BusinessCalendar(g.organizationId).today(null)).toISOString().slice(0, 7);
  }, 120_000);
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  it('sin nada que se repita, el renglón no viaja', async () => {
    for (const cookie of [owner, gerente, recepcion]) expect(await delInicio(cookie)).toBeNull();
  });

  it('con dos por confirmar este mes lo ve quien anota gastos, con la misma cuenta que Movimientos; recepción y quien solo tiene el Tablero, no', async () => {
    renta = uuidv7();
    await getDb().recurringExpense.createMany({ data: [
      { id: renta, organizationId: g.organizationId, branchId: g.sedes[0]!.id, category: 'RENT', description: 'Renta del local', amountCents: 800_000n, frequency: 'MONTHLY', startsOn: new Date(`${mes}-01`), createdByUserId: g.ownerId },
      { id: uuidv7(), organizationId: g.organizationId, branchId: g.sedes[0]!.id, category: 'SERVICES', description: 'Internet', amountCents: 60_000n, frequency: 'MONTHLY', startsOn: new Date(`${mes}-01`), createdByUserId: g.ownerId },
    ] });
    const enMovimientos = (await get(gerente, `/expenses/recurring?month=${mes}`)).json().pending as number;
    expect(enMovimientos).toBe(2);
    for (const cookie of [gerente, owner]) {
      expect(await delInicio(cookie)).toMatchObject({ key: 'expenses', count: 2, tone: 'info', amountCents: null });
    }
    expect(await delInicio(recepcion)).toBeNull();
    expect(await delInicio(soloTablero)).toBeNull();
  });

  it('al confirmar uno baja a uno; al descartar el otro, el renglón desaparece', async () => {
    const confirmar = await app.inject({ method: 'POST', url: '/expenses/recurring/confirm', headers: { cookie: gerente }, payload: { recurringId: renta, dueOn: `${mes}-01` } });
    expect(confirmar.statusCode, confirmar.body).toBe(201);
    expect(await delInicio(gerente)).toMatchObject({ count: 1 });
    const lista = (await get(gerente, `/expenses/recurring?month=${mes}`)).json() as { proposals: Array<{ recurringId: string; dueOn: string; status: string }> };
    const queda = lista.proposals.find((p) => p.status === 'PENDING')!;
    const descartar = await app.inject({ method: 'POST', url: '/expenses/recurring/skip', headers: { cookie: gerente }, payload: { recurringId: queda.recurringId, dueOn: queda.dueOn, reason: 'Este mes no se pagó' } });
    expect(descartar.statusCode, descartar.body).toBe(200);
    expect(await delInicio(gerente)).toBeNull();
  });
});
