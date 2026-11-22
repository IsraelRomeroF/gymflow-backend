import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { hash } from '@node-rs/argon2';
import { makeApp, loginPlataforma, PASSWORD, correoUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/** La consola de plataforma es el panel de mayor rango: su seguridad no depende de ajustes. */
describe('seguridad de la consola de plataforma', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); await app.ready(); });
  afterAll(async () => { await app.close(); await closeDb(); });

  async function cuentaNueva(extra: { mustChangePassword?: boolean; creada?: Date } = {}) {
    const email = correoUnico('plat');
    await getDb().user.create({ data: { id: uuidv7(), organizationId: null, email, fullName: 'Plataforma nueva', mustChangePassword: extra.mustChangePassword ?? false,
      ...(extra.creada ? { createdAt: extra.creada } : {}),
      passwordHash: await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 }) } });
    return email;
  }

  it('entra con la contraseña, sin código', async () => {
    const email = await cuentaNueva();
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
    expect(r.json()).toMatchObject({ status: 'AUTHENTICATED', platform: true });
    const cookie = `gf_session=${r.cookies.find((c) => c.name === 'gf_session')!.value}`;
    expect((await app.inject({ method: 'GET', url: '/platform/me', headers: { cookie } })).statusCode).toBe(200);
  });

  it('toda acción que modifica pide reconfirmar con la contraseña; leer no', async () => {
    const cookie = await loginPlataforma(app);
    // Se vence la reconfirmación a mano: es lo que pasa a los diez minutos.
    await getDb().session.updateMany({ where: { stepUpUntil: { not: null }, user: { email: { startsWith: 'plataforma.' } } }, data: { stepUpUntil: new Date(Date.now() - 1000) } });
    expect((await app.inject({ method: 'GET', url: '/platform/organizations', headers: { cookie } })).statusCode).toBe(200);
    const r = await app.inject({ method: 'PUT', url: '/platform/prices/core', headers: { cookie }, payload: { monthlyCents: '150000' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('REAUTH_REQUIRED');
    const mal = await app.inject({ method: 'POST', url: '/platform/reauth', headers: { cookie }, payload: { password: 'no-es-la-contraseña' } });
    expect(mal.statusCode).toBe(401);
    const bien = await app.inject({ method: 'POST', url: '/platform/reauth', headers: { cookie }, payload: { password: PASSWORD } });
    expect(bien.statusCode, bien.body).toBe(200);
    const otra = await app.inject({ method: 'PUT', url: '/platform/prices/core', headers: { cookie }, payload: { monthlyCents: '150000' } });
    expect(otra.statusCode).not.toBe(403);
  });

  it('con contraseña temporal solo puede cambiarla', async () => {
    const email = await cuentaNueva({ mustChangePassword: true });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
    const cookie = `gf_session=${login.cookies.find((c) => c.name === 'gf_session')!.value}`;
    expect((await app.inject({ method: 'GET', url: '/platform/me', headers: { cookie } })).json().mustChangePassword).toBe(true);
    const bloqueada = await app.inject({ method: 'GET', url: '/platform/organizations', headers: { cookie } });
    expect(bloqueada.statusCode).toBe(403);
    const corta = await app.inject({ method: 'POST', url: '/platform/password', headers: { cookie }, payload: { current: PASSWORD, next: 'corta' } });
    expect(corta.statusCode).toBe(422);
    const ok = await app.inject({ method: 'POST', url: '/platform/password', headers: { cookie }, payload: { current: PASSWORD, next: 'Una contraseña larga y nueva 2026' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/platform/organizations', headers: { cookie } })).statusCode).toBe(200);
  });

  it('el primer ingreso de la plataforma tampoco pide la temporal otra vez, y la que tiene más de 7 días ya no entra', async () => {
    const email = await cuentaNueva({ mustChangePassword: true });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
    expect(login.json()).toMatchObject({ platform: true, mustChangePassword: true });
    const cookie = `gf_session=${login.cookies.find((c) => c.name === 'gf_session')!.value}`;
    // La misma regla de 12 que el personal, y sin `current`.
    expect((await app.inject({ method: 'POST', url: '/platform/password', headers: { cookie }, payload: { next: 'Once-letras' } })).statusCode).toBe(422);
    const ok = await app.inject({ method: 'POST', url: '/platform/password', headers: { cookie }, payload: { next: 'Una contraseña larga y nueva 2026' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/platform/organizations', headers: { cookie } })).statusCode).toBe(200);
    // Una cuenta creada por guion (sin fecha de restablecimiento) cuenta sus 7 días desde el alta.
    const vieja = await cuentaNueva({ mustChangePassword: true, creada: new Date(Date.now() - 8 * 86_400_000) });
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: vieja, password: PASSWORD } });
    expect(r.statusCode).toBe(403);
    expect(r.json().message).toMatch(/venció/);
  });

  it('sin uso por más de la inactividad permitida, la sesión se cierra', async () => {
    const cookie = await loginPlataforma(app);
    const token = cookie.split('=')[1]!;
    const { createHash } = await import('node:crypto');
    await getDb().session.updateMany({ where: { tokenHash: createHash('sha256').update(token).digest('hex') }, data: { lastSeenAt: new Date(Date.now() - 31 * 60_000) } });
    expect((await app.inject({ method: 'GET', url: '/platform/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('con IPs permitidas, desde otra la sesión no sirve', async () => {
    const otra = await makeApp({ PLATFORM_ALLOWED_IPS: '10.9.9.9' });
    await otra.ready();
    const cookie = await loginPlataforma(app);
    expect((await otra.inject({ method: 'GET', url: '/platform/me', headers: { cookie } })).statusCode).toBe(401);
    await otra.close();
  });

  it('la plataforma limita lo que ve el dueño (y lo devuelve todo con null); al personal no lo toca', async () => {
    const { other } = await (await import('./helpers.js')).orgFixtures();
    const cookie = await loginPlataforma(app);
    const db = getDb();
    const dueno = await db.user.findFirstOrThrow({ where: { email: 'owner@otro.mx' } });
    const gerente = await db.user.findFirstOrThrow({ where: { email: 'gerencia@otro.mx' } });
    const url = (u: string) => `/platform/organizations/${other.id}/users/${u}/sections`;
    const limitar = await app.inject({ method: 'PUT', url: url(dueno.id), headers: { cookie }, payload: { sections: ['bitacora'], reason: 'Prueba de llave' } });
    expect(limitar.statusCode, limitar.body).toBe(200);
    const { loginAs } = await import('./helpers.js');
    const owner = await loginAs(app, 'owner@otro.mx');
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: owner } })).json().unlockedSections).toEqual(['bitacora']);
    expect((await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: owner } })).statusCode).toBe(403);
    const alPersonal = await app.inject({ method: 'PUT', url: url(gerente.id), headers: { cookie }, payload: { sections: [], reason: 'No debe dejar' } });
    expect(alPersonal.statusCode).toBe(422);
    await app.inject({ method: 'PUT', url: url(dueno.id), headers: { cookie }, payload: { sections: null, reason: 'Fin de la prueba' } });
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: owner } })).json().unlockedSections).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: owner } })).statusCode).toBe(200);
  });

  it('Seguridad: sus sesiones, la política y la actividad; salir cierra la sesión', async () => {
    const cookie = await loginPlataforma(app);
    const s = (await app.inject({ method: 'GET', url: '/platform/security', headers: { cookie } })).json();
    expect(s.policy).toMatchObject({ sessionHours: 8, idleMinutes: 30, stepUpMinutes: 10 });
    expect(s.sessions.some((x: { current: boolean }) => x.current)).toBe(true);
    // La actividad ya no viaja aquí: la consola la lee de la cadena de plataforma (bloque 1.13).
    expect(s.activity).toBeUndefined();
    expect(Array.isArray((await app.inject({ method: 'GET', url: '/platform/audit?limit=5', headers: { cookie } })).json().entries)).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/platform/logout', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/platform/me', headers: { cookie } })).statusCode).toBe(401);
  });
});
