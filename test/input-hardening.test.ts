import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, CONSENTIMIENTOS } from './helpers.js';
import { closeDb } from '../src/platform/db/client.js';
import { redactarQuery } from '../src/app.js';

/**
 * SEC-13: lo que entra del cliente hacia logs, bitácora y redirecciones.
 */
describe('entradas del cliente', () => {
  let app: FastifyInstance;
  let cookie: string;
  let branchId: string;

  beforeAll(async () => {
    app = await makeApp({ PORTAL_ORIGINS: 'https://socio.gymflow.mx' });
    await app.ready();
    cookie = await loginAs(app, 'recepcion@demo.mx');
    branchId = (await orgFixtures()).demoBranches[0]!.id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  it('un x-request-id raro se reemplaza; uno con forma de id se respeta', async () => {
    const raro = await app.inject({ method: 'GET', url: '/auth/me', headers: { 'x-request-id': 'x {"admin":true}' } });
    expect(raro.json().requestId).toMatch(/^[0-9a-f-]{36}$/);
    const bueno = await app.inject({ method: 'GET', url: '/auth/me', headers: { 'x-request-id': 'req-12345678' } });
    expect(bueno.json().requestId).toBe('req-12345678');
  });

  it('el log no guarda nombres ni teléfonos de la búsqueda', () => {
    expect(redactarQuery('/members/search?q=Mar%C3%ADa+L%C3%B3pez&limit=20'))
      .toBe('/members/search?q=%5Bredactado%5D&limit=20');
    expect(redactarQuery('/members?status=ACTIVE')).toBe('/members?status=ACTIVE');
  });

  it('un nombre con marcado se rechaza en el mostrador', async () => {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie },
      payload: { firstName: '<img src=x onerror=alert(1)>', lastName: nombreUnico('Prueba'), homeBranchId: branchId, consents: CONSENTIMIENTOS, force: true },
    });
    expect(r.statusCode).toBe(422);
    // Un nombre de verdad, con acento, apóstrofo y guion, sí pasa.
    const ok = await app.inject({
      method: 'POST', url: '/members', headers: { cookie },
      payload: { firstName: "María José O'Neill", lastName: `${nombreUnico('Pérez')}-Díaz`, homeBranchId: branchId, consents: CONSENTIMIENTOS, force: true },
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('un celular mal escrito se rechaza en su campo, no se borra en silencio (UXA-05)', async () => {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie },
      payload: { firstName: nombreUnico('Tel'), lastName: nombreUnico('Corto'), phoneE164: '55123', homeBranchId: branchId, consents: CONSENTIMIENTOS, force: true },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().issues[0].path).toBe('phoneE164');
  });

  it('el regreso del 3DS solo puede ser el portal', async () => {
    const alta = await app.inject({
      method: 'POST', url: '/members', headers: { cookie },
      payload: { firstName: nombreUnico('Tres'), lastName: nombreUnico('Des'), homeBranchId: branchId, consents: CONSENTIMIENTOS, force: true },
    });
    const invite = await app.inject({ method: 'POST', url: `/members/${alta.json().id}/portal-invite`, headers: { cookie } });
    const enroll = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code } });
    const portal = `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}`;

    const ajeno = await app.inject({
      method: 'POST', url: '/portal/payment-methods/setup', headers: { cookie: portal },
      payload: { returnUrl: 'https://gymflow-pagos.example.com/robar' },
    });
    expect(ajeno.statusCode).toBe(422);
    const propio = await app.inject({
      method: 'POST', url: '/portal/payment-methods/setup', headers: { cookie: portal },
      payload: { returnUrl: 'https://socio.gymflow.mx/pagos' },
    });
    expect(propio.statusCode, propio.body).toBe(201);
  });
});
