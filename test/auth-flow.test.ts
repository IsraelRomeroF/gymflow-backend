import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, PASSWORD, correoUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

describe('flujo de autenticación', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('login correcto emite cookie HttpOnly', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'owner@demo.mx', password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('AUTHENTICATED');
    const cookie = res.cookies.find((c) => c.name === 'gf_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite?.toLowerCase()).toBe('lax');
  });

  it('contraseña incorrecta devuelve 401 genérico', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'owner@demo.mx', password: 'incorrecta' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('El correo o la contraseña no coinciden');
  });

  it('un correo inexistente responde IGUAL que una contraseña mala', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'nadie@demo.mx', password: 'loquesea' },
    });
    // No se revela si el correo está registrado.
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('El correo o la contraseña no coinciden');
  });

  it('/auth/me devuelve los permisos efectivos del actor', async () => {
    const cookie = await loginAs(app, 'recepcion@demo.mx');
    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.permissions).toContain('payments:record');
    // Recepción NO puede reembolsar ni gestionar roles.
    expect(body.permissions).not.toContain('payments:refund');
    expect(body.permissions).not.toContain('settings:roles:manage');
  });

  it('/auth/me dice quién es, sin filtrar nada de la credencial', async () => {
    const cookie = await loginAs(app, 'recepcion@demo.mx');
    const body = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json();
    expect(body.email).toBe('recepcion@demo.mx');
    expect(body.fullName).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|failedLogins|lockedUntil/);
  });

  it('el gerente abarca todo el gimnasio; recepción, solo su sede (2026-10-06)', async () => {
    const gerente = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: await loginAs(app, 'gerente@demo.mx') } })).json().branchScopes;
    expect(gerente).toContain(null);
    const recepcion: Array<string | null> = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: await loginAs(app, 'recepcion@demo.mx') } })).json().branchScopes;
    expect(recepcion).toHaveLength(1);
    expect(recepcion).not.toContain(null);
  });

  it('el dueño SÍ tiene alcance organizacional', async () => {
    const cookie = await loginAs(app, 'owner@demo.mx');
    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(res.json().branchScopes).toContain(null);
  });

  it('recepción NO puede listar usuarios (permiso de roles)', async () => {
    const cookie = await loginAs(app, 'recepcion@demo.mx');
    const res = await app.inject({ method: 'GET', url: '/users', headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('el dueño SÍ puede listar usuarios', async () => {
    const cookie = await loginAs(app, 'owner@demo.mx');
    const res = await app.inject({ method: 'GET', url: '/users', headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it('logout revoca la sesión de inmediato', async () => {
    const cookie = await loginAs(app, 'coach@demo.mx');
    const before = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(before.statusCode).toBe(200);

    await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });

    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401); // revocación inmediata: la ventaja de la sesión opaca
  });

  it('sin verificación en dos pasos: con la contraseña correcta entra directo, aunque la cuenta tuviera 2FA', async () => {
    // Decisión del dueño (2026-10-09; nota en ADR-008): nadie escribe un código.
    const db = getDb();
    const email = correoUnico('directo');
    const { demo } = await orgFixtures();
    const { hash } = await import('@node-rs/argon2');
    const { uuidv7 } = await import('@gymflow/core');
    const rol = await db.role.findFirstOrThrow({ where: { organizationId: null, key: 'MANAGER' } });
    const user = await db.user.create({
      data: {
        id: uuidv7(), organizationId: demo.id, email, fullName: 'Gerencia sin código', mfaEnabled: true,
        passwordHash: await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      },
    });
    await db.roleAssignment.create({ data: { id: uuidv7(), organizationId: demo.id, userId: user.id, roleId: rol.id, branchId: null } });

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
    expect(login.json().status).toBe('AUTHENTICATED');
    const cookie = `gf_session=${login.cookies.find((c) => c.name === 'gf_session')!.value}`;
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(200);
    // Las rutas del código ya no existen.
    expect((await app.inject({ method: 'POST', url: '/auth/mfa/verify', headers: { cookie }, payload: { code: '000000' } })).statusCode).toBe(404);

    await db.roleAssignment.deleteMany({ where: { userId: user.id } });
    await db.session.deleteMany({ where: { userId: user.id } });
    await db.user.update({ where: { id: user.id }, data: { deletedAt: new Date(), isActive: false, email: `${user.id}@borrado.local` } });
  });
});

describe('bloqueo de la cuenta', () => {
  let app: FastifyInstance;
  const creados: string[] = [];

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
  });
  afterAll(async () => {
    const db = getDb();
    for (const id of creados) {
      await db.roleAssignment.deleteMany({ where: { userId: id } });
      await db.session.deleteMany({ where: { userId: id } });
      await db.user.update({ where: { id }, data: { deletedAt: new Date(), isActive: false, email: `${id}@borrado.local` } });
    }
    await app.close();
    await closeDb();
  });

  /** Usuario desechable con un rol del sistema: no se ensucia a los de la demo. */
  async function usuario(rol: 'MANAGER' | 'RECEPTION'): Promise<string> {
    const db = getDb();
    const { demo } = await orgFixtures();
    const { hash } = await import('@node-rs/argon2');
    const { uuidv7 } = await import('@gymflow/core');
    const role = await db.role.findFirstOrThrow({ where: { organizationId: null, key: rol } });
    const email = correoUnico(`bloqueo-${rol.toLowerCase()}`);
    const u = await db.user.create({
      data: {
        id: uuidv7(), organizationId: demo.id, email, fullName: `Prueba ${rol}`,
        passwordHash: await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      },
    });
    creados.push(u.id);
    await db.roleAssignment.create({ data: { id: uuidv7(), organizationId: demo.id, userId: u.id, roleId: role.id, branchId: null } });
    return email;
  }


  it('el bloqueo no delata la cuenta ni deja fuera al titular en su equipo de siempre', async () => {
    const email = await usuario('RECEPTION');
    const desde = (ip: string, password: string) => app.inject({
      method: 'POST', url: '/auth/login', remoteAddress: ip, payload: { email, password },
    });
    expect((await desde('10.0.0.7', PASSWORD)).statusCode).toBe(200); // su equipo
    for (let i = 0; i < 5; i++) await desde('203.0.113.9', 'adivinanza-mala');

    // El atacante no sabe si la cuenta existe ni si quedó bloqueada.
    const atacante = await desde('203.0.113.9', 'otra-mala');
    expect(atacante.statusCode).toBe(401);
    expect(atacante.json().message).toBe('El correo o la contraseña no coinciden');
    // Con la contraseña correcta desde una IP desconocida, tampoco entra.
    expect((await desde('198.51.100.4', PASSWORD)).statusCode).toBe(401);
    // Ella, desde su equipo, sí.
    expect((await desde('10.0.0.7', PASSWORD)).statusCode).toBe(200);
  });
});

describe('bitácora de auditoría', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('una acción sensible queda registrada con su actor', async () => {
    // Un usuario desechable: cerrar TODAS las sesiones del dueño tumbaba las
    // de los demás archivos de prueba que corren en paralelo con él.
    // El personal lo da de alta la gerencia: la dueña solo consulta.
    const owner = await loginAs(app, 'gerencia@demo.mx');
    const email = correoUnico('audit');
    const alta = await app.inject({
      method: 'POST', url: '/users', headers: { cookie: owner },
      payload: { email, fullName: 'Bitácora de prueba', roleKey: 'COACH', branchIds: [], reason: 'Prueba de bitácora' },
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: alta.json().temporaryPassword } });
    const cookie = `gf_session=${login.cookies.find((c) => c.name === 'gf_session')!.value}`;
    await app.inject({ method: 'POST', url: '/auth/logout-all', headers: { cookie } });

    const res = await app.inject({ method: 'GET', url: `/audit?limit=5&actorUserId=${alta.json().user.id}`, headers: { cookie: owner } });
    expect(res.statusCode).toBe(200);
    const { entries } = res.json();
    expect(entries.map((e: { action: string }) => e.action)).toContain('session.revoke_all');
    await getDb().user.update({ where: { id: alta.json().user.id }, data: { isActive: false } });
  });

  it('la cadena de hashes verifica de extremo a extremo', async () => {
    const cookie = await loginAs(app, 'owner@demo.mx');
    const res = await app.inject({ method: 'GET', url: '/audit/verify', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('verificar por tramos pequeños da lo mismo que por tramos grandes', async () => {
    const { AuditService } = await import('../src/platform/audit/audit.service.js');
    const { demo } = await orgFixtures();
    const svc = new AuditService();
    const grande = await svc.verifyChain(demo.id, 5000);
    const chico = await svc.verifyChain(demo.id, 997);
    expect(grande.ok).toBe(true);
    expect(chico.ok).toBe(true);
    // Otros archivos escriben en la bitácora a la vez: el chico corre después.
    expect(chico.checked).toBeGreaterThanOrEqual(grande.checked);
  });

  it('la base RECHAZA borrar una entrada de bitácora', async () => {
    const db = getDb();
    const { demo } = await orgFixtures();
    const entry = await db.auditLog.findFirst({ where: { organizationId: demo.id } });
    expect(entry).toBeTruthy();
    // El rol de aplicación no tiene DELETE, y además hay trigger.
    await expect(db.auditLog.delete({ where: { id: entry!.id } })).rejects.toThrow();
  });

  it('la base RECHAZA modificar una entrada de bitácora', async () => {
    const db = getDb();
    const { demo } = await orgFixtures();
    const entry = await db.auditLog.findFirst({ where: { organizationId: demo.id } });
    await expect(
      db.auditLog.update({ where: { id: entry!.id }, data: { reason: 'alterado' } }),
    ).rejects.toThrow();
  });

  it('la cadena sigue verificando tras los intentos de manipulación', async () => {
    const cookie = await loginAs(app, 'owner@demo.mx');
    const res = await app.inject({ method: 'GET', url: '/audit/verify', headers: { cookie } });
    expect(res.json().ok).toBe(true);
  });
});
