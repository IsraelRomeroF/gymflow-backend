import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, correoUnico, loginPlataforma } from './helpers.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * UN SOLO DUEÑO POR GIMNASIO (D-02, hallazgo 22-10; bloque 3.16).
 *
 * La consola de plataforma no da de alta un segundo dueño ACTIVO ni reactiva
 * a uno suspendido mientras haya otro. Cambiar de dueño: se suspende al
 * anterior y se da de alta al nuevo. A quien ya esté en la base no se le toca.
 */
describe('un solo dueño por gimnasio', () => {
  let app: FastifyInstance;
  let plataforma: string;
  let g: GimnasioPropio;
  const alta = (roleKey: string, nombre: string, email = correoUnico('dueno')) => app.inject({
    method: 'POST', url: `/platform/organizations/${g.organizationId}/users`, headers: { cookie: plataforma },
    payload: { fullName: nombre, email, roleKey, branchIds: null, reason: 'Prueba de un solo dueño' },
  });
  const activar = (userId: string, isActive: boolean) => app.inject({
    method: 'POST', url: `/platform/organizations/${g.organizationId}/users/${userId}/active`, headers: { cookie: plataforma },
    payload: { isActive, reason: 'Prueba de un solo dueño' },
  });

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    plataforma = await loginPlataforma(app);
    g = await gimnasioPropio();
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  it('con un dueño activo, la plataforma no crea otro: 409 que dice quién es y qué hacer', async () => {
    const correo = correoUnico('dueno');
    const r = await alta('OWNER', 'Olga Otra Duena', correo);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().message).toMatch(/ya tiene dueño \(.+\) y solo puede haber uno/);
    expect(r.json().message).toMatch(/apoderado/);
    expect(await getDb().user.count({ where: { email: correo } })).toBe(0);
    expect(await getDb().auditLog.count({ where: { organizationId: g.organizationId, action: 'platform.user.create' } })).toBe(0);
    // Los demás puestos siguen igual: un gerente más se crea.
    expect((await alta('MANAGER', 'Gema Gerente Mas')).statusCode).toBe(201);
  });

  it('dos altas de dueño a la vez no dejan dos', async () => {
    const h = await gimnasioPropio();
    try {
      await getDb().user.update({ where: { id: h.ownerId }, data: { isActive: false } });
      const pedir = () => app.inject({
        method: 'POST', url: `/platform/organizations/${h.organizationId}/users`, headers: { cookie: plataforma },
        payload: { fullName: 'Dueno Simultaneo', email: correoUnico('dueno'), roleKey: 'OWNER', branchIds: null, reason: 'Dos a la vez' },
      });
      const codigos = (await Promise.all([pedir(), pedir(), pedir()])).map((r) => r.statusCode).sort();
      expect(codigos).toEqual([201, 409, 409]);
      expect(await getDb().roleAssignment.count({ where: { organizationId: h.organizationId, revokedAt: null, role: { key: 'OWNER' }, user: { isActive: true, deletedAt: null } } })).toBe(1);
    } finally { await h.cerrar(); }
  });

  it('cambio de dueño: suspendido el anterior, entra el nuevo; al anterior no se le reactiva mientras haya otro', async () => {
    expect((await activar(g.ownerId, false)).statusCode).toBe(200);
    const nuevo = await alta('OWNER', 'Nora Nueva Duena');
    expect(nuevo.statusCode, nuevo.body).toBe(201);
    const reactivar = await activar(g.ownerId, true);
    expect(reactivar.statusCode, reactivar.body).toBe(409);
    expect(reactivar.json().message).toMatch(/ya tiene dueño \(Nora Nueva Duena\)/);
    expect((await getDb().user.findUniqueOrThrow({ where: { id: g.ownerId } })).isActive).toBe(false);
    // Suspendida la nueva, el anterior sí regresa; y reactivar a quien no es dueño nunca se topa con la regla.
    expect((await activar(nuevo.json().userId, false)).statusCode).toBe(200);
    expect((await activar(g.ownerId, true)).statusCode).toBe(200);
  });

  it('si una base ya tuviera dos dueños, no se toca a nadie: los dos siguen activos y solo se impide un tercero', async () => {
    const h = await gimnasioPropio();
    try {
      const db = getDb();
      const rol = await db.role.findFirstOrThrow({ where: { organizationId: null, key: 'OWNER' } });
      const { uuidv7 } = await import('@gymflow/core');
      const segundo = uuidv7();
      await db.user.create({ data: { id: segundo, organizationId: h.organizationId, email: correoUnico('heredado'), fullName: 'Dueno Heredado', passwordHash: 'x' } });
      await db.roleAssignment.create({ data: { id: uuidv7(), organizationId: h.organizationId, userId: segundo, roleId: rol.id, branchId: null } });
      const tercero = await app.inject({
        method: 'POST', url: `/platform/organizations/${h.organizationId}/users`, headers: { cookie: plataforma },
        payload: { fullName: 'Tercer Dueno', email: correoUnico('dueno'), roleKey: 'OWNER', branchIds: null, reason: 'x y z' },
      });
      expect(tercero.statusCode).toBe(409);
      expect(await db.user.count({ where: { id: { in: [h.ownerId, segundo] }, isActive: true } })).toBe(2);
    } finally { await h.cerrar(); }
  });
});
