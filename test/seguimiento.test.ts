import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/** SEGUIMIENTO (UX7): "le llamé" en Prospectos y en Retención, con resultado y próximo paso. */
describe('seguimiento de prospectos y socios en riesgo', () => {
  let app: FastifyInstance;
  let cen: string;
  beforeAll(async () => {
    app = await makeApp(); await app.ready();
    const f = await orgFixtures();
    cen = (await getDb().branch.findFirst({ where: { organizationId: f.demo.id, code: 'CEN' } }))!.id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  it('un contacto con el prospecto queda con quién, cuándo y el próximo paso; lo pasa a Contactado', async () => {
    const recepcion = await loginAs(app, 'recepcion@demo.mx');
    const p = await app.inject({
      method: 'POST', url: '/prospects', headers: { cookie: recepcion },
      payload: { branchId: cen, firstName: nombreUnico('Segui'), lastName: 'Miento', phoneE164: telefonoUnico() },
    });
    expect(p.statusCode, p.body).toBe(201);
    const id = p.json().id;

    const malo = await app.inject({ method: 'POST', url: `/prospects/${id}/follow-ups`, headers: { cookie: recepcion }, payload: { channel: 'FAX', outcome: 'ANSWERED' } });
    expect(malo.statusCode).toBe(422);

    const sinRespuesta = await app.inject({ method: 'POST', url: `/prospects/${id}/follow-ups`, headers: { cookie: recepcion }, payload: { channel: 'CALL', outcome: 'NO_ANSWER' } });
    expect(sinRespuesta.statusCode, sinRespuesta.body).toBe(201);
    let fila = (await app.inject({ method: 'GET', url: '/prospects', headers: { cookie: recepcion } })).json().items.find((x: { id: string }) => x.id === id);
    expect(fila.status).toBe('NEW'); // nadie contestó: sigue nuevo

    const c = await app.inject({
      method: 'POST', url: `/prospects/${id}/follow-ups`, headers: { cookie: recepcion },
      payload: { channel: 'WHATSAPP', outcome: 'INTERESTED', note: 'Viene el lunes a probar', nextStepOn: '2026-10-12' },
    });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json().createdByName).toBeTruthy();

    fila = (await app.inject({ method: 'GET', url: '/prospects', headers: { cookie: recepcion } })).json().items.find((x: { id: string }) => x.id === id);
    expect(fila.status).toBe('CONTACTED');
    expect(fila.followUps).toBe(2);
    expect(fila.lastFollowUp).toMatchObject({ channel: 'WHATSAPP', outcome: 'INTERESTED', nextStepOn: '2026-10-12', note: 'Viene el lunes a probar' });

    const hist = (await app.inject({ method: 'GET', url: `/prospects/${id}/follow-ups`, headers: { cookie: recepcion } })).json();
    expect(hist.followUps.map((x: { outcome: string }) => x.outcome)).toEqual(['INTERESTED', 'NO_ANSWER']);
  });

  it('en Retención, "le llamé" queda por socio y se lee en lote', async () => {
    const gerencia = await loginAs(app, 'gerencia@demo.mx');
    const alertas = (await app.inject({ method: 'GET', url: '/retention/alerts', headers: { cookie: gerencia } })).json();
    const socio = alertas.outreach[0] ?? (await app.inject({ method: 'GET', url: '/members?limit=1', headers: { cookie: gerencia } })).json().members[0];
    const memberId = socio.memberId ?? socio.id;
    const r = await app.inject({ method: 'POST', url: `/members/${memberId}/follow-ups`, headers: { cookie: gerencia }, payload: { channel: 'CALL', outcome: 'COMING_BACK', note: 'Vuelve la próxima semana' } });
    expect(r.statusCode, r.body).toBe(201);
    const lote = (await app.inject({ method: 'GET', url: `/members/follow-ups/latest?ids=${memberId}`, headers: { cookie: gerencia } })).json();
    expect(lote.latest[0]).toMatchObject({ memberId, last: { outcome: 'COMING_BACK' } });
  });

  it('la bitácora de seguimiento es solo de agregar: la base no deja reescribirla', async () => {
    await expect(getDb().$executeRawUnsafe('UPDATE "follow_ups" SET "note" = \'x\'')).rejects.toThrow();
  });
});
