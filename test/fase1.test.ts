import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/** Auditoría 6, fase 1: lo que hoy costaba dinero o seguridad. */
describe('fase 1 · dinero y seguridad', () => {
  let app: FastifyInstance;
  let owner: string;
  let gerencia: string;
  let recepcion: string;
  let orgId: string;
  let cen: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    [owner, gerencia, recepcion] = await Promise.all(['owner@demo.mx', 'gerencia@demo.mx', 'recepcion@demo.mx'].map((e) => loginAs(app, e))) as [string, string, string];
    const f = await orgFixtures();
    orgId = f.demo.id;
    cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  async function socio(): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Fase'), lastName: nombreUnico('Uno'), homeBranchId: cen, force: true, consents: CONSENTIMIENTOS },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  it('DP-01 · el gerente no toca la cuenta del dueño: ni baja, ni puesto, ni contraseña', async () => {
    const dueno = (await getDb().user.findFirstOrThrow({ where: { organizationId: orgId, email: 'owner@demo.mx' } })).id;
    expect((await app.inject({ method: 'PATCH', url: `/users/${dueno}`, headers: { cookie: gerencia }, payload: { isActive: false, reason: 'Prueba' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/users/${dueno}/role`, headers: { cookie: gerencia }, payload: { roleKey: 'RECEPTION', branchIds: [cen], reason: 'Prueba' } })).statusCode).toBe(403);
    const reset = await app.inject({ method: 'POST', url: `/users/${dueno}/reset-password`, headers: { cookie: gerencia }, payload: { reason: 'Prueba' } });
    expect(reset.statusCode).toBe(403);
    expect(reset.json().detail ?? reset.json().message).toMatch(/dueño/);
    // El dueño sigue entrando y firmando.
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: owner } })).statusCode).toBe(200);
  });

  it('MC-07 · el esperado del corte no viaja a quien va a contar mientras el turno está abierto', async () => {
    const listar = async () => (await app.inject({ method: 'GET', url: `/cash-sessions?branchId=${cen}&status=OPEN`, headers: { cookie: gerencia } })).json().sessions as Array<{ id: string }>;
    let abiertos = await listar();
    // Suponía un turno abierto que dejaba otro archivo: si esta prueba corre primero en una
    // base recién sembrada no hay ninguno (1.17b, orden barajado). Abre el suyo y lo corta al final.
    let propio: string | null = null;
    if (abiertos.length === 0) {
      const caja = await getDb().cashRegister.findFirstOrThrow({ where: { organizationId: orgId, branchId: cen, isActive: true, deletedAt: null }, orderBy: { code: 'asc' } });
      const abrir = await app.inject({ method: 'POST', url: '/cash-sessions', headers: { cookie: gerencia }, payload: { cashRegisterId: caja.id, openingFloatCents: '50000' } });
      expect(abrir.statusCode, abrir.body).toBe(201);
      propio = abrir.json().id as string;
      abiertos = await listar();
    }
    expect(abiertos.length).toBeGreaterThan(0);
    const ciego = (await app.inject({ method: 'GET', url: `/cash-sessions/${abiertos[0]!.id}`, headers: { cookie: recepcion } })).json();
    expect(ciego.blind).toBe(true);
    expect(ciego.expectedCashCents).toBeNull();
    expect(ciego.cashCollectedCents).toBeNull();
    expect(ciego.byMethod.some((x: { method: string }) => x.method === 'CASH')).toBe(false);
    // La gerencia, que aprueba descuadres, sí lo ve.
    const claro = (await app.inject({ method: 'GET', url: `/cash-sessions/${abiertos[0]!.id}`, headers: { cookie: gerencia } })).json();
    expect(claro.blind).toBe(false);
    expect(claro.expectedCashCents).toMatch(/^[0-9]+$/);
    if (propio) {
      const corte = await app.inject({ method: 'POST', url: `/cash-sessions/${propio}/close`, headers: { cookie: gerencia }, payload: { countedCashCents: '50000' } });
      expect(corte.statusCode, corte.body).toBe(200);
    }
  });

  it('DM-12 · un ajuste solo rebaja la deuda: sin LATE_FEE y sin importes negativos', async () => {
    const id = await socio();
    const cargo = await app.inject({
      method: 'POST', url: `/members/${id}/charges`, headers: { cookie: gerencia },
      payload: { chargeType: 'MANUAL_ADJUSTMENT', concept: 'Cuota de prueba', subtotalCents: '50000', reason: 'Prueba de ajuste', branchId: cen },
    });
    expect(cargo.statusCode, cargo.body).toBe(201);
    const fee = await app.inject({ method: 'POST', url: `/charges/${cargo.json().id}/adjustments`, headers: { cookie: gerencia }, payload: { adjustmentType: 'LATE_FEE', amountCents: '1000', reason: 'Recargo' } });
    expect(fee.statusCode).toBe(422);
    const negativo = await app.inject({ method: 'POST', url: `/charges/${cargo.json().id}/adjustments`, headers: { cookie: gerencia }, payload: { adjustmentType: 'DISCOUNT', amountCents: '-1000', reason: 'Deshacer' } });
    expect(negativo.statusCode).toBe(422);
  });

  it('DM-08 · vender dos veces con la misma clave es UNA venta', async () => {
    const id = await socio();
    const planes = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie: gerencia } })).json();
    const plan = planes.find((p: { code: string }) => p.code === 'MEN');
    const saleKey = `venta-${nombreUnico('k').toLowerCase()}`;
    const payload = { planId: plan.id, branchId: cen, saleKey, payment: null };
    const primera = await app.inject({ method: 'POST', url: `/members/${id}/memberships/sale`, headers: { cookie: gerencia }, payload });
    expect(primera.statusCode, primera.body).toBe(201);
    expect(primera.json().created).toBe(true);
    const segunda = await app.inject({ method: 'POST', url: `/members/${id}/memberships/sale`, headers: { cookie: gerencia }, payload });
    expect(segunda.statusCode, segunda.body).toBe(200);
    expect(segunda.json().created).toBe(false);
    expect(segunda.json().membership.id).toBe(primera.json().membership.id);
    expect(await getDb().membership.count({ where: { memberId: id } })).toBe(1);
  });

  it('PS-06 · el texto del consentimiento lo pone el servidor, no el navegador', async () => {
    const id = await socio();
    const inventado = await app.inject({
      method: 'POST', url: `/members/${id}/consents`, headers: { cookie: gerencia },
      payload: { consentType: 'HOUSE_RULES', documentVersion: 'v1.0', documentText: 'TEXTO INVENTADO POR EL CLIENTE', granted: true },
    });
    expect(inventado.statusCode, inventado.body).toBe(201);
    const guardado = await getDb().memberConsent.findFirst({ where: { memberId: id, consentType: 'HOUSE_RULES' }, orderBy: { grantedAt: 'desc' } });
    expect(guardado!.documentText).not.toContain('INVENTADO');
    expect(guardado!.documentText).toBeTruthy();
    // Una versión que no existe, con un texto ya publicado del mismo tipo, no se firma.
    const desconocida = await app.inject({
      method: 'POST', url: `/members/${id}/consents`, headers: { cookie: gerencia },
      payload: { consentType: 'HOUSE_RULES', documentVersion: 'no-existe', granted: true },
    });
    // Desde el bloque 1.10 el servidor firma siempre la vigente: la versión que
    // manda el navegador solo dice cuál leyó el socio, y si no es la vigente, 409.
    expect(desconocida.statusCode).toBe(409);
    expect(desconocida.json().message).toMatch(/vigente/);
  });

  it('DP-02 · el dueño rescata a su gerente: contraseña temporal, baja y reactivación; a nadie más', async () => {
    const { cuentaDePrueba } = await import('./helpers.js');
    const email = await cuentaDePrueba(orgId, 'MANAGER', [null]);
    const gerenteId = (await getDb().user.findFirstOrThrow({ where: { email } })).id;
    // La gerencia no rescata (no es su permiso) y recepción no se rescata (no es gerente).
    expect((await app.inject({ method: 'POST', url: `/users/${gerenteId}/rescue`, headers: { cookie: gerencia }, payload: { action: 'reset_password', reason: 'Prueba' } })).statusCode).toBe(403);
    const rec = (await getDb().user.findFirstOrThrow({ where: { organizationId: orgId, email: 'recepcion@demo.mx' } })).id;
    expect((await app.inject({ method: 'POST', url: `/users/${rec}/rescue`, headers: { cookie: owner }, payload: { action: 'reset_password', reason: 'Prueba' } })).statusCode).toBe(422);
    const reset = await app.inject({ method: 'POST', url: `/users/${gerenteId}/rescue`, headers: { cookie: owner }, payload: { action: 'reset_password', reason: 'Olvidó su contraseña' } });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json().temporaryPassword).toMatch(/^GYM-/);
    const baja = await app.inject({ method: 'POST', url: `/users/${gerenteId}/rescue`, headers: { cookie: owner }, payload: { action: 'deactivate', reason: 'Se fue' } });
    expect(baja.statusCode, baja.body).toBe(200);
    expect(baja.json().isActive).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: reset.json().temporaryPassword } })).statusCode).toBe(401);
    const alta = await app.inject({ method: 'POST', url: `/users/${gerenteId}/rescue`, headers: { cookie: owner }, payload: { action: 'reactivate', reason: 'Volvió' } });
    expect(alta.json().isActive).toBe(true);
  });

  it('payments:backdate · una venta que empieza hace más de 7 días exige permiso y motivo', async () => {
    const planes = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie: gerencia } })).json();
    const plan = planes.find((p: { code: string }) => p.code === 'MEN');
    const hace30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const sinMotivo = await app.inject({ method: 'POST', url: `/members/${await socio()}/memberships/sale`, headers: { cookie: gerencia }, payload: { planId: plan.id, branchId: cen, startDate: hace30, payment: null } });
    expect(sinMotivo.statusCode).toBe(422);
    const recep = await app.inject({ method: 'POST', url: `/members/${await socio()}/memberships/sale`, headers: { cookie: recepcion }, payload: { planId: plan.id, branchId: cen, startDate: hace30, reason: 'Migración tardía', payment: null } });
    expect(recep.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: `/members/${await socio()}/memberships/sale`, headers: { cookie: gerencia }, payload: { planId: plan.id, branchId: cen, startDate: hace30, reason: 'Migración tardía', payment: null } });
    expect(ok.statusCode, ok.body).toBe(201);
    const lejos = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    expect((await app.inject({ method: 'POST', url: `/members/${await socio()}/memberships/sale`, headers: { cookie: gerencia }, payload: { planId: plan.id, branchId: cen, startDate: lejos, payment: null } })).statusCode).toBe(422);
  });

  it('audit:export · el dueño exporta la bitácora en CSV, con motivo, y queda asentado', async () => {
    expect((await app.inject({ method: 'GET', url: '/audit/export.csv', headers: { cookie: owner } })).statusCode).toBe(422);
    const r = await app.inject({ method: 'GET', url: '/audit/export.csv?reason=Para%20el%20contador&category=dinero', headers: { cookie: owner } });
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.body).toContain('Fecha');
    expect((await app.inject({ method: 'GET', url: '/audit/export.csv?reason=x', headers: { cookie: recepcion } })).statusCode).toBe(403);
    expect(await getDb().auditLog.count({ where: { action: 'audit.export' } })).toBeGreaterThan(0);
  });
});
