import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, cuentaDePrueba, nombreUnico, telefonoUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * AISLAMIENTO ENTRE SUCURSALES — el hermano de `tenant-isolation`.
 *
 * El registro de rutas solo exige tener el permiso en ALGUNA sucursal. Durante
 * mucho tiempo eso bastaba: recepción de Centro veía el corte de Norte,
 * cancelaba membresías de Norte y leía los reportes de las tres sedes. La
 * regla es la de `06-roles-permisos.md` §1: el alcance se evalúa JUNTO con el
 * permiso. Aquí se prueba desde afuera, con los usuarios reales de la demo:
 *  · recepción es solo de Centro;
 *  · una recepcionista de Centro y Norte, no de Frontera (el gerente ya no
 *    se acota a sucursales desde el 2026-10-06).
 */
describe('aislamiento entre sucursales', () => {
  let app: FastifyInstance;
  let owner: string;
  let recepcion: string;
  let dosSedes: string;
  let cen: string;
  let nor: string;
  let fro: string;
  let membresiaNorte: string;
  let socioNorte: string;
  let claseNorte: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    const f = await orgFixtures();
    cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
    nor = f.demoBranches.find((b) => b.code === 'NOR')!.id;
    fro = f.demoBranches.find((b) => b.code === 'FRO')!.id;
    // Una recepcionista de DOS sedes: el alcance de varias sucursales se sigue probando.
    dosSedes = await loginAs(app, await cuentaDePrueba(f.demo.id, 'RECEPTION', [cen, nor]));

    // Un socio de Norte con su membresía vendida en Norte.
    const alta = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: owner },
      payload: {
        firstName: nombreUnico('Norte'), lastName: nombreUnico('Aislado'), phoneE164: telefonoUnico(),
        homeBranchId: nor, force: true,
        consents: [
          { consentType: 'PRIVACY_NOTICE', documentVersion: 'v1.0', granted: true },
          { consentType: 'HOUSE_RULES', documentVersion: 'v1.0', granted: true },
        ],
      },
    });
    expect(alta.statusCode, alta.body).toBe(201);
    socioNorte = alta.json().id;
    const plan = await getDb().plan.findFirstOrThrow({ where: { organizationId: f.demo.id, code: 'MEN', isActive: true } });
    const venta = await app.inject({
      method: 'POST', url: `/members/${socioNorte}/memberships/sale`, headers: { cookie: owner },
      payload: { planId: plan.id, branchId: nor, payment: { method: 'SPEI_TRANSFER', externalRef: `SPEI-${uuidv7()}` } },
    });
    expect(venta.statusCode, venta.body).toBe(201);
    membresiaNorte = venta.json().membership.id;

    // Una clase en Norte.
    const tipo = await getDb().classType.create({ data: { id: uuidv7(), organizationId: f.demo.id, name: `Aislada ${Date.now()}` } });
    const clase = await getDb().classSchedule.create({
      data: {
        id: uuidv7(), organizationId: f.demo.id, branchId: nor, classTypeId: tipo.id,
        occurrenceKey: `aislada:${uuidv7()}`, startsAt: new Date(Date.now() + 2 * 86_400_000),
        endsAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000), businessDate: new Date(), capacity: 10,
      },
    });
    claseNorte = clase.id;
  });

  afterAll(async () => { await app.close(); await closeDb(); });

  const noPermitido = (code: number) => expect([403, 404]).toContain(code);

  it('recepción de Centro NO congela, descongela ni cancela una membresía de Norte', async () => {
    for (const [url, payload] of [
      [`/memberships/${membresiaNorte}/freeze`, { days: 7, reason: 'Intento desde otra sede' }],
      [`/memberships/${membresiaNorte}/unfreeze`, {}],
      [`/memberships/${membresiaNorte}/cancel`, { reason: 'Intento desde otra sede' }],
    ] as const) {
      const r = await app.inject({ method: 'POST', url, headers: { cookie: recepcion }, payload });
      noPermitido(r.statusCode);
    }
    const m = await getDb().membership.findUniqueOrThrow({ where: { id: membresiaNorte } });
    expect(m.status).toBe('ACTIVE');
  });

  it('recepción de Centro NO reserva ni lista reservas de una clase de Norte', async () => {
    const reservar = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseNorte}/bookings`, headers: { cookie: recepcion },
      payload: { memberId: socioNorte },
    });
    noPermitido(reservar.statusCode);
    const listar = await app.inject({ method: 'GET', url: `/classes/schedules/${claseNorte}/bookings`, headers: { cookie: recepcion } });
    noPermitido(listar.statusCode);
  });

  it('recepción de Centro NO muda a un socio a otra sede', async () => {
    const r = await app.inject({
      method: 'PATCH', url: `/members/${socioNorte}`, headers: { cookie: recepcion }, payload: { homeBranchId: cen },
    });
    noPermitido(r.statusCode);
  });

  it('pero SÍ ve la ficha del socio de Norte: el cobro entre sedes es parte del producto', async () => {
    const r = await app.inject({ method: 'GET', url: `/members/${socioNorte}`, headers: { cookie: recepcion } });
    expect(r.statusCode).toBe(200);
  });

  it('recepción de Centro NO lista cajas ni turnos de Norte', async () => {
    for (const url of [`/cash-registers?branchId=${nor}`, `/cash-sessions?branchId=${nor}`]) {
      const r = await app.inject({ method: 'GET', url, headers: { cookie: recepcion } });
      noPermitido(r.statusCode);
    }
    // Sin decir sucursal, recibe SOLO la suya.
    const propias = (await app.inject({ method: 'GET', url: '/cash-registers', headers: { cookie: recepcion } })).json();
    expect(propias.registers.every((c: { branchId: string }) => c.branchId === cen)).toBe(true);
  });

  it('Retención la libera el dueño; con la llave, recepción ve solo su sede', async () => {
    // Por su puesto, recepción no ve Retención (2026-10-06).
    noPermitido((await app.inject({ method: 'GET', url: '/retention/alerts?limit=5', headers: { cookie: recepcion } })).statusCode);
    const f = await orgFixtures();
    const email = await cuentaDePrueba(f.demo.id, 'RECEPTION', [cen]);
    await getDb().user.updateMany({ where: { email }, data: { unlockedSections: ['retencion'] } });
    const conLlave = await loginAs(app, email);
    const ajena = await app.inject({ method: 'GET', url: `/retention/alerts?branchId=${nor}`, headers: { cookie: conLlave } });
    noPermitido(ajena.statusCode);
    const propias = await app.inject({ method: 'GET', url: '/retention/alerts?limit=500', headers: { cookie: conLlave } });
    expect(propias.statusCode, propias.body).toBe(200);
    expect(propias.json().outreach.every((m: { homeBranchId: string }) => m.homeBranchId === cen)).toBe(true);
  });

  it('recepción no ve el tablero ni la bitácora: el dinero y el historial son de la gerencia', async () => {
    noPermitido((await app.inject({ method: 'GET', url: '/dashboard?days=30', headers: { cookie: recepcion } })).statusCode);
    noPermitido((await app.inject({ method: 'GET', url: '/audit?limit=20', headers: { cookie: recepcion } })).statusCode);
  });

  it('quien trabaja en dos sedes tiene que elegir cuál al pedir las cajas, y no ve las de una tercera', async () => {
    const sinSede = await app.inject({ method: 'GET', url: '/cash-registers', headers: { cookie: dosSedes } });
    expect(sinSede.statusCode).toBe(422);
    const ajena = await app.inject({ method: 'GET', url: `/cash-registers?branchId=${fro}`, headers: { cookie: dosSedes } });
    noPermitido(ajena.statusCode);
    const suya = await app.inject({ method: 'GET', url: `/cash-registers?branchId=${nor}`, headers: { cookie: dosSedes } });
    expect(suya.statusCode).toBe(200);
  });
});
