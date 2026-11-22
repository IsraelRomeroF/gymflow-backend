import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, correoUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

describe('personal, sucursales y prospectos', () => {
  let app: FastifyInstance;
  let owner: string;
  let gerente: string;
  let cen: string; let nor: string; let fro: string;
  const creados: string[] = [];

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    // Un segundo gerente: también de todo el gimnasio (2026-10-06).
    gerente = await loginAs(app, 'gerente@demo.mx');
    const f = await orgFixtures();
    cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
    nor = f.demoBranches.find((b) => b.code === 'NOR')!.id;
    fro = f.demoBranches.find((b) => b.code === 'FRO')!.id;
  });
  afterAll(async () => {
    const db = getDb();
    for (const id of creados) {
      await db.roleAssignment.deleteMany({ where: { userId: id } });
      await db.session.deleteMany({ where: { userId: id } });
      await db.user.update({ where: { id }, data: { deletedAt: new Date(), isActive: false, email: `${id}@borrado.local` } });
    }
    await app.close(); await closeDb();
  });

  const correo = () => correoUnico('staff');
  const entrar = (email: string, password: string) => app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });

  it('el dueño da de alta a una recepcionista con contraseña temporal, y ella la cambia', async () => {
    const email = correo();
    const r = await app.inject({
      method: 'POST', url: '/users', headers: { cookie: owner },
      payload: { email, fullName: 'Nueva Recepción', roleKey: 'RECEPTION', branchIds: [cen], reason: 'Contratación de turno vespertino' },
    });
    expect(r.statusCode, r.body).toBe(201);
    creados.push(r.json().user.id);
    expect(r.json().user.branchIds).toEqual([cen]);
    const temporal = r.json().temporaryPassword as string;

    const login = await entrar(email, temporal);
    expect(login.json().status).toBe('AUTHENTICATED');
    const cookie = `gf_session=${login.cookies.find((c) => c.name === 'gf_session')!.value}`;
    const cambio = await app.inject({ method: 'POST', url: '/auth/password', headers: { cookie }, payload: { current: temporal, next: 'MiClaveNueva.2026' } });
    expect(cambio.statusCode, cambio.body).toBe(200);
    expect((await entrar(email, 'MiClaveNueva.2026')).json().status).toBe('AUTHENTICATED');
    expect((await entrar(email, temporal)).statusCode).toBe(401);
  });

  it('un correo que ya entra a GymFlow no se repite', async () => {
    const r = await app.inject({
      method: 'POST', url: '/users', headers: { cookie: owner },
      payload: { email: 'recepcion@demo.mx', fullName: 'Duplicada', roleKey: 'RECEPTION', branchIds: [cen], reason: 'Prueba' },
    });
    expect(r.statusCode).toBe(409);
  });

  it('un gerente no da de alta a un dueño: nadie crea a alguien con más poder que él', async () => {
    const r = await app.inject({
      method: 'POST', url: '/users', headers: { cookie: gerente },
      payload: { email: correo(), fullName: 'Intento', roleKey: 'OWNER', branchIds: [], reason: 'Escalar' },
    });
    expect(r.statusCode, r.body).toBe(403);
  });

  it('cuatro puestos; el puesto manda el alcance (2026-10-05, un solo gerente desde el 2026-10-06)', async () => {
    // El gerente abarca todo el gimnasio: ya no se acota a sucursales. Recepción exige sede.
    const acotado = await app.inject({ method: 'POST', url: '/users', headers: { cookie: owner }, payload: { email: correo(), fullName: 'Gerente Acotado', roleKey: 'MANAGER', branchIds: [nor], reason: 'Gerente de Norte' } });
    expect(acotado.statusCode, acotado.body).toBe(422);
    expect(acotado.json().message).toMatch(/abarca todo el gimnasio/);
    const coach = await app.inject({ method: 'POST', url: '/users', headers: { cookie: owner }, payload: { email: correo(), fullName: 'Coach De Norte', roleKey: 'COACH', branchIds: [nor], reason: 'Coach de Norte' } });
    expect(coach.statusCode, coach.body).toBe(201);
    creados.push(coach.json().user.id);
    const sinSede = await app.inject({ method: 'POST', url: '/users', headers: { cookie: owner }, payload: { email: correo(), fullName: 'Recepcion Sin Sede', roleKey: 'RECEPTION', branchIds: [], reason: 'Prueba' } });
    expect(sinSede.statusCode, sinSede.body).toBe(422);
    // Los puestos retirados ya no existen.
    for (const viejo of ['CASHIER', 'INSTRUCTOR', 'SUPERVISOR']) {
      expect((await app.inject({ method: 'POST', url: '/users', headers: { cookie: owner }, payload: { email: correo(), fullName: 'Puesto Viejo', roleKey: viejo, branchIds: [nor], reason: 'Prueba' } })).statusCode).toBe(422);
    }
    // Personal lista los cuatro con lo que hacen y cuántas personas los tienen.
    const roles = (await app.inject({ method: 'GET', url: '/roles', headers: { cookie: owner } })).json().roles as Array<{ key: string; description: string; inUse: number }>;
    expect(roles.map((r) => r.key).sort()).toEqual(['COACH', 'MANAGER', 'OWNER', 'RECEPTION']);
    expect(roles.find((r) => r.key === 'RECEPTION')!.inUse).toBeGreaterThan(0);
  });

  it('dar de baja cierra sus sesiones y ya no entra; nadie se da de baja a sí mismo', async () => {
    const email = correo();
    const res = await app.inject({
      method: 'POST', url: '/users', headers: { cookie: owner },
      payload: { email, fullName: 'Por salir', roleKey: 'COACH', branchIds: [nor], reason: 'Alta temporal' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const alta = res.json();
    creados.push(alta.user.id);
    const login = await entrar(email, alta.temporaryPassword);
    const cookie = `gf_session=${login.cookies.find((c) => c.name === 'gf_session')!.value}`;
    const baja = await app.inject({ method: 'PATCH', url: `/users/${alta.user.id}`, headers: { cookie: owner }, payload: { isActive: false, reason: 'Terminó su contrato' } });
    expect(baja.statusCode, baja.body).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
    expect((await entrar(email, alta.temporaryPassword)).statusCode).toBe(401);

    const yo = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: owner } })).json();
    const mismo = await app.inject({ method: 'PATCH', url: `/users/${yo.userId}`, headers: { cookie: owner }, payload: { isActive: false, reason: 'Prueba' } });
    expect(mismo.statusCode).toBe(403);
  });

  it('abrir una sucursal: el código y su prefijo de socios no se repiten', async () => {
    const codigo = `S${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${Date.now() % 100}`;
    const r = await app.inject({ method: 'POST', url: '/branches', headers: { cookie: owner }, payload: { code: codigo, name: `Sucursal ${codigo}` } });
    expect(r.statusCode, r.body).toBe(201);
    await getDb().branch.update({ where: { id: r.json().id }, data: { deletedAt: new Date(), name: 'Sede aislada (prueba)' } });
    const prefijo = await app.inject({ method: 'POST', url: '/branches', headers: { cookie: owner }, payload: { code: 'CENX', name: 'Choca con Centro' } });
    expect(prefijo.statusCode).toBe(409);
    expect(prefijo.json().message).toMatch(/prefijo CEN/);
  });

  it('recepción no edita sucursales; el gerente sí, en cualquiera', async () => {
    const recepcion = await loginAs(app, 'recepcion@demo.mx');
    expect((await app.inject({ method: 'PATCH', url: `/branches/${cen}`, headers: { cookie: recepcion }, payload: { addressLine: 'Av. Centro 1' } })).statusCode).toBe(403);
    const antes = (await app.inject({ method: 'GET', url: `/branches/${fro}`, headers: { cookie: owner } })).json();
    const r = await app.inject({ method: 'PATCH', url: `/branches/${fro}`, headers: { cookie: gerente }, payload: { addressLine: 'Av. Frontera 123' } });
    expect(r.statusCode, r.body).toBe(200);
    await app.inject({ method: 'PATCH', url: `/branches/${fro}`, headers: { cookie: owner }, payload: { addressLine: antes.addressLine } });
  });

  it('un prospecto se sigue y, al inscribirse, queda ligado a su ficha', async () => {
    const recepcion = await loginAs(app, 'recepcion@demo.mx');
    const p = await app.inject({
      method: 'POST', url: '/prospects', headers: { cookie: recepcion },
      payload: { branchId: cen, firstName: nombreUnico('Pros'), lastName: 'Pecto', phoneE164: telefonoUnico(), source: 'Instagram' },
    });
    expect(p.statusCode, p.body).toBe(201);
    const id = p.json().id;
    expect((await app.inject({ method: 'PATCH', url: `/prospects/${id}`, headers: { cookie: recepcion }, payload: { notes: 'Viene el lunes' } })).statusCode).toBe(200);
    // La etapa ya no se cambia a mano (bloque 2.4, 10-05): sale de los contactos.
    expect((await app.inject({ method: 'PATCH', url: `/prospects/${id}`, headers: { cookie: recepcion }, payload: { status: 'CONTACTED' } })).statusCode).toBe(422);
    const socio = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: recepcion },
      payload: { firstName: nombreUnico('Pros'), lastName: 'Socio', phoneE164: telefonoUnico(), homeBranchId: cen, force: true,
        consents: [{ consentType: 'PRIVACY_NOTICE', documentVersion: 'v1.0', granted: true }, { consentType: 'HOUSE_RULES', documentVersion: 'v1.0', granted: true }] },
    });
    const conv = await app.inject({ method: 'POST', url: `/prospects/${id}/convert`, headers: { cookie: recepcion }, payload: { memberId: socio.json().id } });
    expect(conv.statusCode, conv.body).toBe(200);
    const lista = (await app.inject({ method: 'GET', url: '/prospects', headers: { cookie: recepcion } })).json();
    // `GET /prospects` viaja por páginas (bloque 1.6): los renglones van en `items`.
    expect(lista.items.find((x: { id: string }) => x.id === id).status).toBe('CONVERTED');
    expect(lista.items.every((x: { branchId: string }) => x.branchId === cen)).toBe(true);
  });
});
