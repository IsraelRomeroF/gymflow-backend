import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CashSessionList, diferenciasConElContrato } from '@gymflow/core/contracts';
import { makeApp, loginAs, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';

/**
 * FASE 4 · BLOQUE 4.11 · DOS CABOS DE LA CAJA (4.3).
 *
 *  · Un «Retiro del dueño» que salió del cajón no se anula en Movimientos:
 *    anularlo no devolvería el efectivo. La API lo impide y dice dónde se
 *    corrige. Uno anotado solo en Movimientos se anula como siempre.
 *  · «Cortes» por páginas: `GET /cash-sessions` con `cursor`.
 *
 * Gimnasio propio.
 */
describe('caja · cabos de 4.3 (bloque 4.11)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let owner: string; let gerente: string; let recepcion: string;
  let sede: string;

  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (cookie: string, url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, headers: { cookie }, payload });
  const abrir = async (fondo: bigint) => {
    const t = await post(recepcion, '/cash-sessions', { cashRegisterId: g.sedes[0]!.cajas[0]!, openingFloatCents: fondo.toString() });
    expect(t.statusCode, t.body).toBe(201);
    return t.json() as { id: string; businessDate: string };
  };
  const cortar = async (turno: string, contado: bigint) => {
    const r = await post(recepcion, `/cash-sessions/${turno}/close`, { countedCashCents: contado.toString() });
    expect(r.statusCode, r.body).toBe(200);
  };

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio({ sedes: [{ name: 'Sede de los cabos', cajas: 1 }] });
    sede = g.sedes[0]!.id;
    owner = await loginAs(app, g.correos.owner);
    gerente = await loginAs(app, g.correos.gerente);
    recepcion = await loginAs(app, g.correos.recepcion);
  }, 120_000);
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  it('el retiro del dueño que salió del cajón no se anula en Movimientos, ni con el turno ya cortado; el cajón y la anotación quedan como estaban', async () => {
    const turno = await abrir(500_000n);
    const firma = await aprobacion(app, recepcion, 'cash:withdraw', g.correos.owner, sede, { resourceId: turno.id, amountCents: '150000' });
    const hecho = await post(recepcion, `/cash-sessions/${turno.id}/owner-draw`, { amountCents: '150000', reason: 'Retiro del dueño de la quincena', approvalToken: firma });
    expect(hecho.statusCode, hecho.body).toBe(201);
    const gasto = hecho.json().expenseId as string;

    for (const cookie of [owner, gerente]) {
      const r = await post(cookie, `/expenses/${gasto}/void`, { reason: 'Se capturó por error' });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().reason).toBe('EXPENSE_FROM_CASH');
      expect(r.json().message).toContain('salió del cajón de');
      expect(r.json().message).toContain('«Corrección»');
    }
    await cortar(turno.id, 350_000n);
    const yaCortado = await post(owner, `/expenses/${gasto}/void`, { reason: 'Se capturó por error', asAdjustment: true });
    expect(yaCortado.statusCode, yaCortado.body).toBe(409);
    expect(yaCortado.json().reason).toBe('EXPENSE_FROM_CASH');

    const fila = await getDb().operatingExpense.findUniqueOrThrow({ where: { id: gasto } });
    expect(fila).toMatchObject({ voidedAt: null, amountCents: 150_000n });
    expect(await getDb().operatingExpense.count({ where: { organizationId: g.organizationId, adjustsExpenseId: gasto } })).toBe(0);
    expect(await getDb().auditLog.count({ where: { organizationId: g.organizationId, action: 'expense.void', resourceId: gasto } })).toBe(0);
  });

  it('un retiro del dueño anotado solo en Movimientos (no movió ningún cajón) se anula como siempre', async () => {
    const hoy = (await abrir(100_000n));
    await cortar(hoy.id, 100_000n);
    const alta = await post(owner, '/expenses', { category: 'OWNER_DRAW', description: 'Retiro del dueño por transferencia', amountCents: '80000', month: hoy.businessDate.slice(0, 7), branchId: sede });
    expect(alta.statusCode, alta.body).toBe(201);
    const r = await post(owner, `/expenses/${alta.json().id}/void`, { reason: 'Se capturó dos veces' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await getDb().operatingExpense.findUniqueOrThrow({ where: { id: alta.json().id } })).voidedAt).not.toBeNull();
  });

  it('«Cortes» por páginas: cada turno sale una vez, del más reciente al más antiguo, y la última página no trae cursor', async () => {
    // Con los dos turnos de arriba, cinco cortados.
    for (let i = 0; i < 3; i++) await cortar((await abrir(100_000n)).id, 100_000n);
    const todos = (await get(gerente, '/cash-sessions?status=CLOSED')).json() as CashSessionList;
    expect(diferenciasConElContrato(CashSessionList, todos)).toEqual([]);
    expect(todos.sessions).toHaveLength(5);
    expect(todos.nextCursor).toBeNull();

    const vistos: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    do {
      const r = await get(gerente, `/cash-sessions?status=CLOSED&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.statusCode, r.body).toBe(200);
      const pagina = r.json() as CashSessionList;
      expect(pagina.sessions.length).toBeLessThanOrEqual(2);
      vistos.push(...pagina.sessions.map((s) => s.id));
      cursor = pagina.nextCursor;
      paginas++;
    } while (cursor && paginas < 10);
    expect(paginas).toBe(3);
    expect(vistos).toEqual(todos.sessions.map((s) => s.id));
    // La dueña, que solo consulta, pagina igual; un cursor inventado se rechaza sin romper nada.
    expect((await get(owner, '/cash-sessions?status=CLOSED&limit=2')).json().nextCursor).toEqual(expect.any(String));
    expect((await get(gerente, '/cash-sessions?status=CLOSED&cursor=no-es-un-cursor')).statusCode).toBe(422);
  });
});
