import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, CONSENTIMIENTOS } from './helpers.js';
import { closeDb } from '../src/platform/db/client.js';
import { registeredRoutes } from '../src/platform/http/registry.js';

/**
 * PERMISOS QUE DICEN LO QUE AUTORIZAN (auditoría 8, fase 0, bloque 0.8).
 *
 * Cada permiso nombra lo que deja hacer: ver no es escribir, cobrar lo del
 * catálogo no es inventar un cargo, y la plataforma no carga permisos de un
 * gimnasio en el que nunca entra.
 */
describe('permisos que dicen lo que autorizan', () => {
  let app: FastifyInstance;
  let dueno: string;
  let gerencia: string;
  let recepcion: string;
  let coach: string;
  let branchId: string;

  async function nuevoSocio(): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Perm'), lastName: nombreUnico('Isos'), phoneE164: telefonoUnico(), homeBranchId: branchId, consents: CONSENTIMIENTOS },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    dueno = await loginAs(app, 'owner@demo.mx');
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    coach = await loginAs(app, 'coach@demo.mx');
    branchId = (await orgFixtures()).demoBranches.find((b) => b.code === 'CEN')!.id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  /**
   * NINGUNA RUTA QUE ESCRIBE EXIGE UN PERMISO DE LECTURA (28-04).
   *
   * Resolver un intento de pago colgaba de `payments:reconciliation:read`,
   * que tiene la dueña: la que «solo consulta» escribía. Se verifica sobre el
   * registro de rutas para que la siguiente no nazca igual.
   */
  it('ninguna ruta que escribe exige un permiso de lectura', () => {
    // Deuda conocida, con dueño y con el permiso nuevo ya en el núcleo: solo puede bajar.
    const PENDIENTES: Record<string, string> = {};
    const escrituras = registeredRoutes().filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
    const conLectura = escrituras
      .filter((r) => r.security.kind === 'permission' && [r.security.permission, ...(r.security.anyOf ?? [])].some((p) => p.endsWith(':read')))
      .map((r) => `${r.method} ${r.url}`);
    expect(conLectura.filter((k) => !PENDIENTES[k])).toEqual([]);
    // `anyOf` es para lecturas: una escritura dice con UN permiso lo que autoriza.
    const conVarios = escrituras.filter((r) => r.security.kind === 'permission' && (r.security.anyOf?.length ?? 0) > 0);
    expect(conVarios.map((r) => `${r.method} ${r.url}`)).toEqual([]);
  });

  it('resolver un intento de pago es escribir: la dueña lo consulta, no lo resuelve (28-04)', async () => {
    const r = await app.inject({ method: 'POST', url: `/payments/attempts/${crypto.randomUUID()}/resolve`, headers: { cookie: dueno } });
    expect(r.statusCode).toBe(403);
    expect(r.json().detail).toMatch(/payments:reconciliation:resolve/);
  });

  it('el cargo fuera del catálogo es de la gerencia y sale en «Para revisar» de la dueña (28-05)', async () => {
    const socio = await nuevoSocio();
    const cargo = (cookie: string) => app.inject({
      method: 'POST', url: `/members/${socio}/charges`, headers: { cookie },
      payload: { chargeType: 'MANUAL_ADJUSTMENT', concept: 'Ajuste de prueba', subtotalCents: '35000', branchId, reason: 'Corrección acordada con el socio' },
    });
    const deRecepcion = await cargo(recepcion);
    expect(deRecepcion.statusCode).toBe(403);
    expect(deRecepcion.json().detail).toMatch(/billing:charge:manual/);
    const deGerencia = await cargo(gerencia);
    expect(deGerencia.statusCode, deGerencia.body).toBe(201);
    const revisar = (await app.inject({
      method: 'GET', url: `/audit?category=sensibles&resourceId=${deGerencia.json().id}&limit=5`, headers: { cookie: dueno },
    })).json();
    expect(revisar.entries).toHaveLength(1);
    expect(revisar.entries[0]).toMatchObject({ action: 'billing.charge.create', sensitive: true, reason: 'Corrección acordada con el socio' });
    expect(revisar.entries[0].phrase).toMatch(/fuera del catálogo de \$350/);
  });

  it('desde el panel solo se registra la entrada por el mostrador: huella, PIN y tarjeta son del equipo (5-08)', async () => {
    const socio = await nuevoSocio();
    for (const credentialKind of ['FINGERPRINT', 'RFID', 'PIN', 'FACE']) {
      const r = await app.inject({ method: 'POST', url: '/access/attempts', headers: { cookie: recepcion }, payload: { branchId, memberId: socio, credentialKind } });
      expect(r.statusCode, credentialKind).toBe(422);
      expect(r.json().issues[0].message).toMatch(/solo se registra la entrada por el mostrador/);
    }
    const manual = await app.inject({
      method: 'POST', url: '/access/attempts', headers: { cookie: recepcion },
      payload: { branchId, memberId: socio, credentialKind: 'MANUAL', reason: 'Prueba de la puerta' },
    });
    expect(manual.statusCode, manual.body).toBe(201);
  });

  it('el coach no ve la afluencia del gimnasio en su turno; recepción sí (1-05)', async () => {
    const delCoach = (await app.inject({ method: 'GET', url: '/me/shift', headers: { cookie: coach } })).json();
    expect(delCoach.canSeeEntries).toBe(false);
    expect(delCoach.branches.length).toBeGreaterThan(0);
    for (const b of delCoach.branches) expect([b.entriesToday, b.lastEntryAt]).toEqual([null, null]);
    const deRecepcion = (await app.inject({ method: 'GET', url: '/me/shift', headers: { cookie: recepcion } })).json();
    expect(deRecepcion.canSeeEntries).toBe(true);
    expect(typeof deRecepcion.branches[0].entriesToday).toBe('number');
  });

  it('la plataforma no carga permisos de gimnasio (28-17; exige el seed del catálogo)', async () => {
    const m = (await app.inject({ method: 'GET', url: '/roles/matrix', headers: { cookie: gerencia } })).json();
    expect(m.roles.find((r: { key: string }) => r.key === 'SUPERADMIN')?.permissions).toEqual(['platform:organizations:manage']);
    const recep = m.roles.find((r: { key: string }) => r.key === 'RECEPTION')?.permissions as string[];
    expect(recep).toContain('billing:charge:create');
    expect(recep).not.toContain('billing:charge:manual');
  });
});
