import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, cuentaDePrueba, correoUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * LA LLAVE DEL DUEÑO (2026-10-06): Dirección y Cumplimiento no se ven por el
 * puesto; el dueño las libera sección por sección a cada persona.
 */
describe('secciones bajo llave del dueño', () => {
  let app: FastifyInstance;
  let owner: string;
  let gerencia: string;
  let email: string;
  let userId: string;
  const me = async (cookie: string) => (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json();

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'owner@demo.mx');
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    const f = await orgFixtures();
    // Un gerente nuevo: sin nada liberado.
    email = await cuentaDePrueba(f.demo.id, 'MANAGER', [null]);
    userId = (await getDb().user.findFirstOrThrow({ where: { email } })).id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  it('un gerente sin nada liberado opera el mostrador, pero no ve Tablero ni crea planes', async () => {
    const c = await loginAs(app, email);
    const yo = await me(c);
    expect(yo.unlockedSections).toEqual([]);
    expect(yo.permissions).toContain('members:create');
    expect(yo.permissions).toContain('catalog:read');
    expect(yo.permissions).not.toContain('reports:financial:read');
    expect(yo.permissions).not.toContain('catalog:manage');
    expect(yo.permissions).not.toContain('staff:read');
    expect((await app.inject({ method: 'GET', url: '/dashboard?days=7', headers: { cookie: c } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/users', headers: { cookie: c } })).statusCode).toBe(403);
  });

  it('solo el dueño libera; el gerente no, ni a otros ni a sí mismo', async () => {
    const r = await app.inject({ method: 'PUT', url: `/users/${userId}/sections`, headers: { cookie: gerencia }, payload: { sections: ['tablero'], reason: 'Prueba' } });
    expect(r.statusCode).toBe(403);
    const yo = (await me(owner)).userId;
    expect((await app.inject({ method: 'PUT', url: `/users/${yo}/sections`, headers: { cookie: owner }, payload: { sections: ['tablero'], reason: 'Prueba' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/users/${userId}/sections`, headers: { cookie: owner }, payload: { sections: ['inventada'], reason: 'Prueba' } })).statusCode).toBe(422);
  });

  it('el dueño libera Tablero y Planes: la persona vuelve a entrar y ya los ve, y nada más', async () => {
    const antes = await loginAs(app, email);
    const r = await app.inject({ method: 'PUT', url: `/users/${userId}/sections`, headers: { cookie: owner }, payload: { sections: ['tablero', 'planes'], reason: 'Lleva el catálogo y revisa el tablero' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().unlockedSections).toEqual(['tablero', 'planes']);
    // La sesión vieja se cerró: los permisos cambiaron.
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: antes } })).statusCode).toBe(401);
    const c = await loginAs(app, email);
    const yo = await me(c);
    expect(yo.unlockedSections).toEqual(['tablero', 'planes']);
    expect(yo.permissions).toContain('reports:financial:read');
    expect(yo.permissions).toContain('catalog:manage');
    expect(yo.permissions).not.toContain('expenses:manage');
    expect(yo.permissions).not.toContain('audit:read');
    expect((await app.inject({ method: 'GET', url: '/dashboard?days=7', headers: { cookie: c } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/audit?limit=5', headers: { cookie: c } })).statusCode).toBe(403);
    // Queda en la bitácora, con el antes y el después.
    const log = await getDb().auditLog.findFirst({ where: { action: 'staff.unlock', resourceId: userId } });
    expect(log).toBeTruthy();
  });

  it('el dueño no tiene llave: ve lo suyo siempre y Personal lo dice', async () => {
    expect((await me(owner)).unlockedSections).toBeNull();
    const lista = (await app.inject({ method: 'GET', url: '/users', headers: { cookie: owner } })).json().users as Array<{ email: string; unlockedSections: string[] | null }>;
    expect(lista.find((u) => u.email === 'owner@demo.mx')!.unlockedSections).toBeNull();
    expect(lista.find((u) => u.email === email)!.unlockedSections).toEqual(['tablero', 'planes']);
  });

  it('el dueño le quita Caja a recepción: pierde turnos y cortes, conserva el punto de venta (2026-10-07)', async () => {
    const owner = await loginAs(app, 'owner@demo.mx');
    const usuarios = (await app.inject({ method: 'GET', url: '/users', headers: { cookie: owner } })).json();
    const lista = (Array.isArray(usuarios) ? usuarios : usuarios.users) as Array<{ id: string; email: string; unlockedSections: string[] | null }>;
    const rec = lista.find((u) => u.email === 'recepcion@demo.mx')!;
    const antes = rec.unlockedSections ?? [];
    expect((await app.inject({ method: 'PUT', url: `/users/${rec.id}/sections`, headers: { cookie: owner }, payload: { sections: ['caja'], reason: 'prueba' } })).statusCode).toBe(422);
    const quita = await app.inject({ method: 'PUT', url: `/users/${rec.id}/sections`, headers: { cookie: owner }, payload: { sections: [...antes, '-caja'], reason: 'No lleva caja en este turno' } });
    expect(quita.statusCode, quita.body).toBe(200);
    expect(quita.json().unlockedSections).toContain('-caja');

    const recepcion = await loginAs(app, 'recepcion@demo.mx');
    const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: recepcion } })).json();
    expect(me.unlockedSections).toContain('-caja');
    expect((await app.inject({ method: 'GET', url: '/cash-sessions?status=OPEN', headers: { cookie: recepcion } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/pos/sales', headers: { cookie: recepcion } })).statusCode).not.toBe(403);

    // Se la devuelve: todo como antes.
    const devuelve = await app.inject({ method: 'PUT', url: `/users/${rec.id}/sections`, headers: { cookie: owner }, payload: { sections: antes, reason: 'Vuelve a llevar caja' } });
    expect(devuelve.statusCode, devuelve.body).toBe(200);
    expect(devuelve.json().unlockedSections).not.toContain('-caja');
    const otraVez = await loginAs(app, 'recepcion@demo.mx');
    expect((await app.inject({ method: 'GET', url: '/cash-sessions?status=OPEN', headers: { cookie: otraVez } })).statusCode).toBe(200);
  });

  it('un gerente al que el dueño le quitó Caja sigue contratando: el puesto se mide contra su puesto, no contra su llave (17-01)', async () => {
    const f = await orgFixtures();
    const correo = await cuentaDePrueba(f.demo.id, 'MANAGER', [null]);
    const id = (await getDb().user.findFirstOrThrow({ where: { email: correo } })).id;
    // Administra al personal, pero sin Caja ni nada más de Dirección.
    const llave = await app.inject({ method: 'PUT', url: `/users/${id}/sections`, headers: { cookie: owner }, payload: { sections: ['personal', '-caja'], reason: 'Gerente sin caja' } });
    expect(llave.statusCode, llave.body).toBe(200);
    const g = await loginAs(app, correo);
    expect((await me(g)).permissions).not.toContain('cash:session:open');
    // Personal le ofrece lo que la API le acepta.
    const puestos = (await app.inject({ method: 'GET', url: '/roles', headers: { cookie: g } })).json().roles as Array<{ key: string; assignable: boolean }>;
    expect(puestos.filter((r) => r.assignable).map((r) => r.key).sort()).toEqual(['COACH', 'MANAGER', 'RECEPTION']);
    const sede = f.demoBranches.find((b) => b.code === 'CEN')!.id;
    const alta = (roleKey: string, branchIds: string[]) => app.inject({ method: 'POST', url: '/users', headers: { cookie: g },
      payload: { email: correoUnico(roleKey.toLowerCase()), fullName: 'Persona Nueva Prueba', roleKey, branchIds, reason: 'Contratación' } });
    // Antes: «No puedes asignar un rol con permisos que tú no tienes (cash:session:open, …)».
    const rec = await alta('RECEPTION', [sede]);
    expect(rec.statusCode, rec.body).toBe(201);
    expect((await alta('MANAGER', [])).statusCode).toBe(201);
    // Lo que se ENCIENDE por persona sí se mide contra lo que tiene hoy, y se dice en palabras.
    const excepcion = await app.inject({ method: 'PUT', url: `/users/${rec.json().user.id}/permissions`, headers: { cookie: g }, payload: { add: ['cash:withdraw'], reason: 'Retiros de su turno' } });
    expect(excepcion.statusCode, excepcion.body).toBe(403);
    expect(excepcion.json().message, excepcion.body).toMatch(/Retirar efectivo de la caja/);
    expect(excepcion.json().message).not.toMatch(/cash:/);
  });
});
