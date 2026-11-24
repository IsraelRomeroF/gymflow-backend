import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/** Fase 4: el cierre de mes firmado por el dueño. */
describe('fase 4 · cierre de mes', () => {
  let app: FastifyInstance; let gerencia: string; let owner: string; let orgId: string;
  beforeAll(async () => {
    app = await makeApp(); await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx'); owner = await loginAs(app, 'owner@demo.mx');
    orgId = (await orgFixtures()).demo.id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  it('el gerente cierra un mes pasado con la firma del dueño; el Tablero lo marca y no se cierra dos veces', async () => {
    // Un mes lejano que ninguna otra prueba usa; si una corrida anterior lo cerró, se limpia.
    const mes = '2024-03';
    await getDb().$executeRaw`DELETE FROM "monthly_closes" WHERE "organizationId" = ${orgId}::uuid AND "month" = ${new Date(`${mes}-01T00:00:00.000Z`)}`;
    const sinFirma = await app.inject({ method: 'POST', url: '/reports/monthly-close', headers: { cookie: gerencia }, payload: { month: mes, reason: 'Cierre contable' } });
    expect(sinFirma.statusCode, sinFirma.body).toBe(428);
    const futuro = await app.inject({ method: 'POST', url: '/reports/monthly-close', headers: { cookie: gerencia }, payload: { month: '2099-01', reason: 'Cierre contable' } });
    expect(futuro.statusCode).toBe(422);

    const token = await aprobacion(app, gerencia, 'reports:month:close', 'owner@demo.mx');
    const ok = await app.inject({ method: 'POST', url: '/reports/monthly-close', headers: { cookie: gerencia }, payload: { month: mes, reason: 'Cierre contable', approvalToken: token } });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().totals.collectedCents).toMatch(/^\d+$/);

    const tablero = await app.inject({ method: 'GET', url: `/dashboard?from=${mes}-01&to=2024-04-01&fresh=1`, headers: { cookie: owner } });
    expect(tablero.statusCode, tablero.body).toBe(200);
    expect(tablero.json().closed?.closedAt).toBeTruthy();
    // D-22 (3.7): el mes cerrado se sirve de su foto; lo tardío va etiquetado en `adjustments` (antes `priorAdjustmentsCents`).
    expect(tablero.json().closed).toMatchObject({ fromSnapshot: true });
    expect(tablero.json().adjustments).toEqual([]);

    const lista = await app.inject({ method: 'GET', url: '/reports/monthly-closes', headers: { cookie: owner } });
    expect(lista.json().closes.some((c: { month: string }) => c.month === mes)).toBe(true);
    const otra = await aprobacion(app, gerencia, 'reports:month:close', 'owner@demo.mx');
    expect((await app.inject({ method: 'POST', url: '/reports/monthly-close', headers: { cookie: gerencia }, payload: { month: mes, reason: 'Otra vez', approvalToken: otra } })).statusCode).toBe(409);
    // El dueño solo firma: no cierra él.
    expect((await app.inject({ method: 'POST', url: '/reports/monthly-close', headers: { cookie: owner }, payload: { month: '2024-02', reason: 'Yo mismo' } })).statusCode).toBe(403);
    expect(await getDb().auditLog.count({ where: { action: 'report.month.close', organizationId: orgId } })).toBeGreaterThan(0);
  });
});
