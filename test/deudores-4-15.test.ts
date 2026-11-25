import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { adjustableFor } from '@gymflow/core';
import type { PortfolioDebtors } from '@gymflow/core/contracts';
import { makeApp, loginAs } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { cargoPropio, gimnasioPropio, sesionesDe, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { BusinessCalendar } from '../src/platform/time/business-calendar.js';

const MS_DIA = 86_400_000;

/**
 * FASE 4 · BLOQUE 4.15 · QUIÉN DEBE, INCLUIDOS LOS DADOS DE BAJA.
 *
 * `GET /portfolio/debtors` es la lista que abre «Ver quién debe» del Tablero.
 * Lo que se prueba:
 *  - suma EXACTAMENTE lo que dicen «Por cobrar» y «Dada por perdida» (de
 *    `/portfolio` y del Tablero), con y sin sede, recorriendo todas sus páginas;
 *  - trae a los dados de baja (marcados) y deja de traerlos con el filtro;
 *  - una ficha anonimizada nunca sale como renglón: solo su cifra;
 *  - quién ve nombres: la gerencia con la llave del Tablero. La dueña ve la
 *    cartera sin nombres (D-25) y recepción no ve la cartera (ni se le enciende).
 *
 * Gimnasio propio con dos sedes; las fechas salen del «hoy» del gimnasio.
 */
describe('cartera · quién debe (bloque 4.15)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let s: Awaited<ReturnType<typeof sesionesDe>>;
  let sede1: string; let sede2: string;
  let hoy: Date;
  const socios: Record<'vivo' | 'baja' | 'anonimo' | 'perdido' | 'dosSedes', string> = { vivo: '', baja: '', anonimo: '', perdido: '', dosSedes: '' };

  const db = () => getDb();
  const dia = (n: number) => new Date(hoy.getTime() + n * MS_DIA);
  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });

  /** Todas las páginas de la lista, de `limit` en `limit`. */
  async function todaLaLista(query: string, limit: number): Promise<{ primera: PortfolioDebtors; items: PortfolioDebtors['items'] }> {
    let url = `/portfolio/debtors?limit=${limit}${query}`;
    const items: PortfolioDebtors['items'] = [];
    let primera: PortfolioDebtors | null = null;
    for (let vuelta = 0; vuelta < 50; vuelta++) {
      const r = await get(s.gerente, url);
      expect(r.statusCode, r.body).toBe(200);
      const p = r.json() as PortfolioDebtors;
      primera ??= p;
      expect(p.items.length).toBeLessThanOrEqual(limit);
      items.push(...p.items);
      if (!p.hasMore) { expect(p.nextCursor).toBeNull(); break; }
      url = `/portfolio/debtors?limit=${limit}${query}&cursor=${encodeURIComponent(p.nextCursor!)}`;
    }
    return { primera: primera!, items };
  }
  const suma = (items: PortfolioDebtors['items'], campo: 'outstandingCents' | 'lostCents') => items.reduce((a, d) => a + BigInt(d[campo]), 0n);

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio({ sedes: [{ name: 'Sede norte', cajas: 1 }, { name: 'Sede sur', cajas: 1 }] });
    sede1 = g.sedes[0]!.id; sede2 = g.sedes[1]!.id;
    s = await sesionesDe(app, g);
    hoy = await new BusinessCalendar(g.organizationId).today(null);

    // Vivo, sede norte: $300 vencidos hace 10 días.
    socios.vivo = await socioPropio(g);
    await cargoPropio(g, socios.vivo, 30_000n, g.sedes[0], dia(-10));
    // Dado de baja en su ficha, sede norte: $600 vencidos hace 40 días.
    socios.baja = await socioPropio(g);
    await cargoPropio(g, socios.baja, 60_000n, g.sedes[0], dia(-40));
    const baja = await app.inject({ method: 'POST', url: `/members/${socios.baja}/archive`, headers: { cookie: s.gerente }, payload: { reason: 'Avisó que ya no viene' } });
    expect(baja.statusCode, baja.body).toBe(200);
    // Ficha anonimizada (dada de baja hace mucho), sede sur: $250.
    socios.anonimo = await socioPropio(g, g.sedes[1]);
    await cargoPropio(g, socios.anonimo, 25_000n, g.sedes[1], dia(-400));
    await db().member.update({ where: { id: socios.anonimo }, data: { status: 'ARCHIVED', deletedAt: dia(-380), anonymizedAt: dia(-1), firstName: 'Exsocio', lastName: 'Anonimizado' } });
    // Vivo, sede sur: $100 que aún no vencen y $500 dados por perdidos (D-18).
    socios.perdido = await socioPropio(g, g.sedes[1]);
    await cargoPropio(g, socios.perdido, 10_000n, g.sedes[1], dia(5));
    const perdido = await cargoPropio(g, socios.perdido, 50_000n, g.sedes[1], dia(-150));
    await db().charge.update({ where: { id: perdido }, data: { status: 'OVERDUE', lostOn: dia(-30) } });
    // Vivo de la sede norte que debe en las dos sedes: $200 en la norte y $150 en la sur.
    socios.dosSedes = await socioPropio(g);
    await cargoPropio(g, socios.dosSedes, 20_000n, g.sedes[0], dia(-3));
    await cargoPropio(g, socios.dosSedes, 15_000n, g.sedes[1], dia(-3));
  }, 120_000);

  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  it('suma lo mismo que «Por cobrar» y «Dada por perdida» de la cartera y del Tablero, página por página', async () => {
    const cartera = (await get(s.gerente, '/portfolio')).json() as { totalOutstandingCents: string; lostCents: string };
    const tablero = (await get(s.gerente, '/dashboard?fresh=true')).json() as { portfolio: { outstandingCents: string; lostCents: string } };
    // 300 + 600 + 250 + 100 + 200 + 150 = 1,600 en «Por cobrar»; 500 perdidos.
    expect(cartera).toMatchObject({ totalOutstandingCents: '160000', lostCents: '50000' });
    expect(tablero.portfolio).toMatchObject({ outstandingCents: '160000', lostCents: '50000' });

    const { primera, items } = await todaLaLista('', 2);
    expect(primera.summary.all).toEqual({ outstandingCents: '160000', lostCents: '50000', members: 5 });
    expect(primera.summary.archived).toEqual({ outstandingCents: '60000', lostCents: '0', members: 1 });
    expect(primera.summary.anonymized).toEqual({ outstandingCents: '25000', lostCents: '0', members: 1 });
    expect(primera.summary.listed).toEqual({ outstandingCents: '135000', lostCents: '50000', members: 4 });
    expect(primera.total).toBe(4);
    expect(primera.includeArchived).toBe(true);
    // Sin repetidos ni saltos al paginar, y la lista + lo anonimizado = «Por cobrar».
    expect(new Set(items.map((d) => d.memberId)).size).toBe(4);
    expect(suma(items, 'outstandingCents') + BigInt(primera.summary.anonymized.outstandingCents)).toBe(BigInt(cartera.totalOutstandingCents));
    expect(suma(items, 'lostCents')).toBe(BigInt(cartera.lostCents));
    // De más a menos de lo que debe en total.
    const totales = items.map((d) => BigInt(d.outstandingCents) + BigInt(d.lostCents));
    expect([...totales].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))).toEqual(totales);
  });

  it('cada renglón dice cuánto, desde cuándo, si es dado de baja y lo dado por perdido; la ficha anonimizada no sale', async () => {
    const r = await get(s.gerente, '/portfolio/debtors');
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json() as PortfolioDebtors;
    const de = (id: string) => p.items.find((d) => d.memberId === id);
    expect(de(socios.baja)).toMatchObject({ archived: true, outstandingCents: '60000', overdueCents: '60000', lostCents: '0', oldestDueDate: dia(-40).toISOString().slice(0, 10), homeBranchId: sede1 });
    expect(de(socios.vivo)).toMatchObject({ archived: false, outstandingCents: '30000', overdueCents: '30000' });
    expect(de(socios.perdido)).toMatchObject({ archived: false, outstandingCents: '10000', overdueCents: '0', lostCents: '50000', oldestDueDate: dia(-150).toISOString().slice(0, 10) });
    expect(de(socios.dosSedes)).toMatchObject({ outstandingCents: '35000', homeBranchId: sede1 });
    expect(de(socios.anonimo)).toBeUndefined();
    expect(r.body).not.toContain(socios.anonimo);
    expect(r.body).not.toContain('Anonimizado');
  });

  it('«incluir dados de baja» apagado: no salen, y el resumen dice cuánto falta para «Por cobrar»', async () => {
    const r = await get(s.gerente, '/portfolio/debtors?includeArchived=false');
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json() as PortfolioDebtors;
    expect(p.includeArchived).toBe(false);
    expect(p.items.map((d) => d.memberId)).not.toContain(socios.baja);
    expect(p.items.every((d) => !d.archived)).toBe(true);
    expect(p.summary.listed).toEqual({ outstandingCents: '75000', lostCents: '50000', members: 3 });
    expect(p.summary.all.outstandingCents).toBe('160000');
    expect(BigInt(p.summary.listed.outstandingCents) + BigInt(p.summary.archived.outstandingCents) + BigInt(p.summary.anonymized.outstandingCents)).toBe(160_000n);
  });

  it('por sede: cuenta el cargo donde se emitió, como el reparto por sede de la cartera', async () => {
    for (const [sede, esperado, perdido] of [[sede1, '110000', '0'], [sede2, '50000', '50000']] as const) {
      const cartera = (await get(s.gerente, `/portfolio?branchId=${sede}`)).json() as { totalOutstandingCents: string; lostCents: string };
      expect(cartera).toMatchObject({ totalOutstandingCents: esperado, lostCents: perdido });
      const { primera, items } = await todaLaLista(`&branchId=${sede}`, 1);
      expect(primera.scope).toBe(sede);
      expect(primera.summary.all).toMatchObject({ outstandingCents: esperado, lostCents: perdido });
      expect(suma(items, 'outstandingCents') + BigInt(primera.summary.anonymized.outstandingCents)).toBe(BigInt(esperado));
      expect(suma(items, 'lostCents')).toBe(BigInt(perdido));
    }
    const sur = (await get(s.gerente, `/portfolio/debtors?branchId=${sede2}`)).json() as PortfolioDebtors;
    expect(sur.items.find((d) => d.memberId === socios.dosSedes)).toMatchObject({ outstandingCents: '15000' });
    expect(sur.summary.anonymized).toEqual({ outstandingCents: '25000', lostCents: '0', members: 1 });
  });

  it('cobrarle al dado de baja desde su ficha lo baja de la lista y de «Por cobrar» por igual', async () => {
    const pago = await app.inject({
      method: 'POST', url: `/members/${socios.baja}/payments`, headers: { cookie: s.gerente },
      payload: { method: 'SPEI_TRANSFER', amountCents: '60000', branchId: sede1, externalRef: 'RASTREO-4-15', idempotencyKey: `deudores-4-15-${socios.baja}` },
    });
    expect([200, 201], pago.body).toContain(pago.statusCode);
    const p = (await get(s.gerente, '/portfolio/debtors')).json() as PortfolioDebtors;
    expect(p.items.map((d) => d.memberId)).not.toContain(socios.baja);
    expect(p.summary.all.outstandingCents).toBe('100000');
    expect(p.summary.archived).toEqual({ outstandingCents: '0', lostCents: '0', members: 0 });
    expect((await get(s.gerente, '/portfolio')).json()).toMatchObject({ totalOutstandingCents: '100000' });
  });

  it('un cursor que no es de la API responde 422', async () => {
    const r = await get(s.gerente, '/portfolio/debtors?cursor=inventado');
    expect(r.statusCode, r.body).toBe(422);
  });

  it('la dueña ve la cartera en cifras, sin nombres (D-25): la lista y `topDebtors` le responden 403', async () => {
    const lista = await get(s.owner, '/portfolio/debtors');
    expect(lista.statusCode, lista.body).toBe(403);
    expect(lista.body).not.toContain(socios.vivo);
    const top = await get(s.owner, '/portfolio?topDebtors=5');
    expect(top.statusCode, top.body).toBe(403);
    const cifras = await get(s.owner, '/portfolio');
    expect(cifras.statusCode, cifras.body).toBe(200);
    expect(cifras.json()).toMatchObject({ totalOutstandingCents: '100000', topDebtors: [] });
  });

  it('recepción no ve la cartera ni se le puede encender; un gerente sin la llave del Tablero tampoco', async () => {
    expect((await get(s.recepcion, '/portfolio/debtors')).statusCode).toBe(403);
    expect((await get(s.recepcion, `/portfolio/debtors?branchId=${sede1}`)).statusCode).toBe(403);
    expect((await get(s.recepcion, `/portfolio?branchId=${sede1}&topDebtors=5`)).statusCode).toBe(403);
    expect(adjustableFor('RECEPTION').has('billing:portfolio:read')).toBe(false);

    await db().user.updateMany({ where: { organizationId: g.organizationId, email: g.correos.gerente2 }, data: { unlockedSections: ['personal'] } });
    const gerente2 = await loginAs(app, g.correos.gerente2);
    expect((await get(gerente2, '/portfolio/debtors')).statusCode).toBe(403);
    // El mismo gerente con la llave, sí.
    expect((await get(s.gerente, '/portfolio/debtors')).statusCode).toBe(200);
  });
});
