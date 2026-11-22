import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ALL_SECTIONS_UNLOCKED, auditLabel } from '@gymflow/core';
import { makeApp, correoUnico, loginPlataforma } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * PLATAFORMA · ALTA, FICHA Y CUENTAS (auditoría 8, bloque 2.11; informe 22).
 *
 * Lo que cambió en la fase 2: en el alta contratado = encendido (22-01), la
 * zona horaria se pide ahí (22-02), solo el primer gerente nace con la llave
 * (22-08), «Liberar al terminar» (22-11), el gerente dado después según la
 * regla (22-09), «Reanudar» como acto propio que no mueve la primera
 * liberación (22-07), la actividad real de la marca (22-06) y la lista de
 * marcas sin consultas por marca (22-15).
 *
 * Cada prueba crea SU marca (queda en la base: una marca no se borra por la
 * API). Todas terminan suspendidas para no entrar al cobro de nadie más.
 */
describe('plataforma: alta, ficha y cuentas (2.11)', () => {
  let app: FastifyInstance;
  let plataforma: string;
  let consultas = 0;
  const creadas: string[] = [];
  const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const letras = (n: number) => Array.from({ length: n }, () => LETRAS[Math.floor(Math.random() * LETRAS.length)]).join('');
  const correo = (rol: string) => correoUnico(`${rol}.dosonce`);
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: plataforma } });
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { cookie: plataforma }, payload: payload as object });

  /** El cuerpo mínimo de un alta, con lo que la prueba quiera cambiar. */
  const cuerpo = (extra: Record<string, unknown> = {}) => {
    const nombre = `Dosonce ${letras(6)}`;
    return {
      legalName: `${nombre} S.A.`, tradeName: nombre, branch: { code: letras(4), name: 'Matriz' },
      owner: { fullName: 'Olga Dueña Dosonce', email: correo('duena') }, staff: [], reason: 'Prueba del bloque 2.11', ...extra,
    };
  };
  const alta = async (extra: Record<string, unknown> = {}) => {
    const c = cuerpo(extra);
    const r = await post('/platform/organizations', c);
    expect(r.statusCode, r.body).toBe(201);
    creadas.push(r.json().organizationId as string);
    return { cuerpo: c, ...(r.json() as { organizationId: string; serviceStatus: string; credentials: Array<{ roleKey: string; email: string; password: string }> }) };
  };
  const detalle = async (id: string) => (await get(`/platform/organizations/${id}`)).json();
  const enLista = async (id: string) => (await get('/platform/organizations')).json().organizations.find((o: { id: string }) => o.id === id);
  const secciones = async (email: string) => {
    const u = await getDb().user.findFirstOrThrow({ where: { email }, select: { unlockedSections: true } });
    return (u.unlockedSections as string[]) ?? [];
  };

  beforeAll(async () => {
    process.env.DB_LOG_QUERIES = '1';
    app = await makeApp();
    await app.ready();
    (getDb() as unknown as { $on: (e: string, f: () => void) => void }).$on('query', () => { consultas++; });
    plataforma = await loginPlataforma(app);
  });
  afterAll(async () => {
    // Las marcas de la prueba quedan suspendidas: no entran al cobro ni a la bandeja de «en uso».
    for (const id of creadas) await post(`/platform/organizations/${id}/service`, { status: 'SUSPENDED', reason: 'Marca de una prueba' });
    await app.close(); await closeDb();
  });

  it('en el alta, contratado = encendido: no se escribe el estado de los módulos y la bitácora dice qué contrató', async () => {
    // Plantilla «de barrio» (apaga clases, tienda…) y una lista explícita: manda la lista.
    const m = await alta({ template: 'barrio', contracted: ['cash', 'classes', 'pos'] });
    const db = getDb();
    expect(await db.organizationModule.count({ where: { organizationId: m.organizationId } })).toBe(0);
    const negados = await db.organizationEntitlement.findMany({ where: { organizationId: m.organizationId, granted: false }, select: { moduleKey: true } });
    expect(negados.map((n) => n.moduleKey)).not.toEqual(expect.arrayContaining(['cash', 'classes', 'pos']));
    expect(negados.map((n) => n.moduleKey)).toEqual(expect.arrayContaining(['training', 'prospects']));
    const d = await detalle(m.organizationId);
    for (const k of ['cash', 'classes', 'pos']) expect(d.modules.find((x: { key: string }) => x.key === k), k).toMatchObject({ contracted: true, enabled: true });
    expect(d.modules.find((x: { key: string }) => x.key === 'training')).toMatchObject({ contracted: false, enabled: false });
    // Caja contratada: nace con su primera caja.
    expect(await db.cashRegister.count({ where: { organizationId: m.organizationId } })).toBe(1);
    const asiento = await db.auditLog.findFirstOrThrow({ where: { organizationId: m.organizationId, action: 'platform.organization.create' } });
    const estado = asiento.afterState as Record<string, unknown>;
    expect(estado).not.toHaveProperty('modulesOff');
    expect(estado.contracted).toEqual(expect.arrayContaining(['Caja', 'Clases']));
    expect(estado.notContracted).toEqual(expect.arrayContaining(['Rutinas']));
    expect(estado.released).toBe(false);
  });

  it('sin plan ni lista, la plantilla es solo un atajo de lo contratado; sin plantilla, se contrata todo', async () => {
    const barrio = await alta({ template: 'barrio' });
    const d = await detalle(barrio.organizationId);
    expect(d.modules.find((x: { key: string }) => x.key === 'cash')).toMatchObject({ contracted: true, enabled: true });
    expect(d.modules.find((x: { key: string }) => x.key === 'classes')).toMatchObject({ contracted: false });
    expect(await getDb().organizationModule.count({ where: { organizationId: barrio.organizationId } })).toBe(0);

    const todo = await alta();
    const d2 = await detalle(todo.organizationId);
    expect(d2.modules.every((x: { contracted: boolean }) => x.contracted)).toBe(true);

    const mala = await post('/platform/organizations', cuerpo({ template: 'no-existe' }));
    expect(mala.statusCode, mala.body).toBe(422);
  });

  it('la zona horaria se fija en el alta, y una zona que no existe se rechaza en su campo', async () => {
    const m = await alta({ timezone: 'America/Tijuana' });
    expect((await detalle(m.organizationId)).timezone).toBe('America/Tijuana');
    expect((await enLista(m.organizationId)).timezone).toBe('America/Tijuana');
    // Por omisión, la del centro.
    expect((await detalle((await alta()).organizationId)).timezone).toBe('America/Mexico_City');

    const mala = await post('/platform/organizations', cuerpo({ timezone: 'America/Tijuanaa' }));
    expect(mala.statusCode, mala.body).toBe(422);
    expect(mala.json().issues.map((i: { path: string }) => i.path)).toContain('timezone');
    // Tampoco al corregir la marca.
    const editar = await app.inject({ method: 'PUT', url: `/platform/organizations/${m.organizationId}`, headers: { cookie: plataforma }, payload: { timezone: 'Marte/Olimpo', reason: 'Prueba de zona' } });
    expect(editar.statusCode, editar.body).toBe(422);
  });

  it('solo el primer gerente del alta nace con Dirección y Cumplimiento liberados', async () => {
    const primero = correo('gerente.uno'); const segundo = correo('gerente.dos'); const recepcion = correo('recepcion');
    const m = await alta({ staff: [
      { role: 'RECEPTION', fullName: 'Rita Recepción Dosonce', email: recepcion },
      { role: 'MANAGER', fullName: 'Gael Gerente Uno', email: primero },
      { role: 'MANAGER', fullName: 'Gema Gerente Dos', email: segundo },
    ] });
    expect(m.credentials.map((c) => c.roleKey)).toEqual(['OWNER', 'RECEPTION', 'MANAGER', 'MANAGER']);
    expect([...(await secciones(primero))].sort()).toEqual([...ALL_SECTIONS_UNLOCKED].sort());
    expect(await secciones(segundo)).toEqual([]);
    expect(await secciones(recepcion)).toEqual([]);
  });

  it('«Liberar al terminar» deja la marca en uso desde el alta, con su asiento; sin marcarla nace sin liberar', async () => {
    const sin = await alta();
    expect(sin.serviceStatus).toBe('PENDING');
    expect((await detalle(sin.organizationId)).activatedAt).toBeNull();

    const con = await alta({ releaseNow: true });
    expect(con.serviceStatus).toBe('ACTIVE');
    const d = await detalle(con.organizationId);
    expect(d.serviceStatus).toBe('ACTIVE');
    expect(d.activatedAt).not.toBeNull();
    const liberar = await getDb().auditLog.findMany({ where: { organizationId: con.organizationId, action: 'platform.service.activate' } });
    expect(liberar).toHaveLength(1);
    expect(liberar[0]!.reason).toBe('Prueba del bloque 2.11');
    // La dueña ya entra (con su temporal: lo primero es elegir la suya).
    const duena = con.credentials.find((c) => c.roleKey === 'OWNER')!;
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: duena.email, password: duena.password } });
    expect(login.statusCode, login.body).toBe(200);
    // Y la de la marca sin liberar, no.
    const otra = sin.credentials.find((c) => c.roleKey === 'OWNER')!;
    const fuera = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: otra.email, password: otra.password } });
    expect(fuera.statusCode, fuera.body).toBe(403);
  });

  it('un gerente dado después nace liberado solo si la marca no tiene otro gerente activo', async () => {
    const m = await alta();
    const cuenta = (rol: string, email: string) => post(`/platform/organizations/${m.organizationId}/users`, { fullName: 'Persona Dada Después', email, roleKey: rol, branchIds: null, reason: 'Prueba de la regla del gerente' });

    // Sin gerente: el que llega arma el gimnasio.
    const uno = correo('rescate.uno');
    const r1 = await cuenta('MANAGER', uno);
    expect(r1.statusCode, r1.body).toBe(201);
    expect(r1.json().sectionsUnlocked).toBe(true);
    expect([...(await secciones(uno))].sort()).toEqual([...ALL_SECTIONS_UNLOCKED].sort());

    // Ya hay uno activo: el siguiente nace cerrado y lo libera el dueño.
    const dos = correo('rescate.dos');
    const r2 = await cuenta('MANAGER', dos);
    expect(r2.json().sectionsUnlocked).toBe(false);
    expect(await secciones(dos)).toEqual([]);

    // Un puesto que no es gerencia nunca nace con la llave, haya o no gerente.
    const d = await detalle(m.organizationId);
    const sede = d.branches[0].id as string;
    const r3 = await post(`/platform/organizations/${m.organizationId}/users`, { fullName: 'Rosa Recepción Después', email: correo('rescate.rec'), roleKey: 'RECEPTION', branchIds: [sede], reason: 'Prueba' });
    expect(r3.statusCode, r3.body).toBe(201);
    expect(r3.json().sectionsUnlocked).toBe(false);

    // Con los dos gerentes suspendidos, vuelve a no haber gerente activo: el nuevo nace liberado.
    for (const email of [uno, dos]) {
      const u = d.users.find((x: { email: string }) => x.email === email) ?? (await detalle(m.organizationId)).users.find((x: { email: string }) => x.email === email);
      const s = await post(`/platform/organizations/${m.organizationId}/users/${u.id}/active`, { isActive: false, reason: 'Dejó de trabajar ahí' });
      expect(s.statusCode, s.body).toBe(200);
    }
    const r4 = await cuenta('MANAGER', correo('rescate.tres'));
    expect(r4.json().sectionsUnlocked).toBe(true);
    const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: m.organizationId, action: 'platform.user.create', resourceId: r4.json().userId } });
    expect((asiento.afterState as Record<string, unknown>).sectionsUnlocked).toBe(true);
  });

  it('reanudar es un acto distinto de liberar y no mueve la fecha de la primera liberación', async () => {
    const m = await alta();
    const servicio = (status: string, reason: string) => post(`/platform/organizations/${m.organizationId}/service`, { status, reason });

    const liberar = await servicio('ACTIVE', 'Contrato firmado y primer pago recibido');
    expect(liberar.statusCode, liberar.body).toBe(200);
    expect(liberar.json()).toEqual({ ok: true, serviceStatus: 'ACTIVE', action: 'platform.service.activate' });
    const liberadaEl = (await detalle(m.organizationId)).activatedAt as string;
    expect(liberadaEl).not.toBeNull();

    const suspender = await servicio('SUSPENDED', 'Falta de pago');
    expect(suspender.json().action).toBe('platform.service.suspend');
    const suspendida = await detalle(m.organizationId);
    expect(suspendida).toMatchObject({ serviceStatus: 'SUSPENDED', suspendedReason: 'Falta de pago', activatedAt: liberadaEl });

    const reanudar = await servicio('ACTIVE', 'Pago recibido');
    expect(reanudar.json()).toEqual({ ok: true, serviceStatus: 'ACTIVE', action: 'platform.service.resume' });
    const otraVez = await detalle(m.organizationId);
    expect(otraVez).toMatchObject({ serviceStatus: 'ACTIVE', suspendedAt: null, suspendedReason: null });
    // La primera liberación sigue donde estaba: el cobro factura desde ese mes (pendiente de 1.13).
    expect(otraVez.activatedAt).toBe(liberadaEl);

    const actos = (await getDb().auditLog.findMany({ where: { organizationId: m.organizationId, action: { startsWith: 'platform.service.' } }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })).map((a) => a.action);
    expect(actos).toEqual(['platform.service.activate', 'platform.service.suspend', 'platform.service.resume']);
    expect(auditLabel('platform.service.resume')).toBe('GymFlow reanudó el servicio');
    // Y la ficha lo lee en palabras.
    const frases = (await get(`/platform/organizations/${m.organizationId}/audit?limit=10`)).json().entries.map((e: { phrase: string }) => e.phrase);
    expect(frases).toContain('GymFlow reanudó el servicio');

    // Sin motivo no se cambia nada, y una marca que no existe es 404.
    expect((await servicio('SUSPENDED', '')).statusCode).toBe(422);
    expect((await post('/platform/organizations/00000000-0000-7000-8000-000000000000/service', { status: 'ACTIVE', reason: 'No existe' })).statusCode).toBe(404);
  });

  it('la «última actividad» es la de la gente del gimnasio: lo que hace la plataforma o el sistema no cuenta', async () => {
    const m = await alta({ releaseNow: true });
    // Hasta aquí solo actuó la plataforma (alta y liberación): la marca no tiene actividad propia.
    let fila = await enLista(m.organizationId);
    expect(fila.lastActivityAt).toBeNull();
    expect(fila.lastStaffLoginAt).toBeNull();
    // Más actos de la plataforma tampoco la «reviven».
    await app.inject({ method: 'PUT', url: `/platform/organizations/${m.organizationId}`, headers: { cookie: plataforma }, payload: { billingEmail: correo('cobros'), reason: 'Correo de cobros' } });
    expect((await enLista(m.organizationId)).lastActivityAt).toBeNull();

    // La dueña entra y elige su contraseña: eso sí es de la marca.
    const duena = m.credentials.find((c) => c.roleKey === 'OWNER')!;
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: duena.email, password: duena.password } });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = `gf_session=${login.cookies.find((c) => c.name === 'gf_session')!.value}`;
    const cambio = await app.inject({ method: 'POST', url: '/auth/password', headers: { cookie }, payload: { next: `Una.Clave.Larga.${letras(6)}.2026` } });
    expect(cambio.statusCode, cambio.body).toBe(200);
    fila = await enLista(m.organizationId);
    expect(fila.lastStaffLoginAt).not.toBeNull();
    const propios = await getDb().auditLog.count({ where: { organizationId: m.organizationId, NOT: [{ action: { startsWith: 'platform.' } }, { action: { startsWith: 'system.' } }] } });
    // Si entrar o cambiar la contraseña dejó asiento en su bitácora, esa es su última actividad; si no, sigue sin tenerla.
    if (propios > 0) expect(fila.lastActivityAt).not.toBeNull(); else expect(fila.lastActivityAt).toBeNull();
  });

  it('la lista de marcas no hace consultas por marca', async () => {
    const medir = async () => {
      // La primera carga calienta lo que tenga memoria; se mide la segunda.
      await get('/platform/organizations');
      consultas = 0;
      const r = await get('/platform/organizations');
      expect(r.statusCode, r.body).toBe(200);
      return { n: consultas, marcas: r.json().organizations.length as number, cuerpo: r.json() };
    };
    const antes = await medir();
    await alta({ releaseNow: true });
    await alta({ releaseNow: true, template: 'estudio' });
    await alta();
    const despues = await medir();
    expect(despues.marcas).toBe(antes.marcas + 3);
    expect(despues.n, `consultas con ${antes.marcas} marcas: ${antes.n}; con ${despues.marcas}: ${despues.n}`).toBe(antes.n);
    // Y con un tope fijo, no por marca (lo mismo que afirma `perf/medir.test.ts`).
    expect(despues.n).toBeLessThanOrEqual(22);
    // La bandeja ya no pide los precios aparte: la lista dice cuántos faltan.
    expect(typeof despues.cuerpo.pricesMissing).toBe('number');
  });
});
