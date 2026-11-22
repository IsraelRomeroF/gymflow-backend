import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hash } from '@node-rs/argon2';
import { makeApp, loginAs, loginPlataforma, orgFixtures, cuentaDePrueba, correoUnico, sedeDesechable, archivarSede, PASSWORD } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { usageOf } from '../src/platform/modules/usage.js';
import { ClassService, sedesConClases } from '../src/modules/classes/class.service.js';

/**
 * FASE 1 · BLOQUE 1.14 · PERSONAL Y GIMNASIO.
 *
 * Personal: la temporal vencida se distingue (pendiente de la fase 0),
 * reactivar entrega una temporal nueva (17-10, D17-06), el celular del
 * personal es un celular (17-07) y el gerente nuevo queda «por decidir qué
 * ve» hasta que la dueña lo revisa (17-06, D17-03).
 *
 * Gimnasio: Caja no se apaga con turnos abiertos (19-01, D19-05), la última
 * caja de una sede que usa Caja no se retira (19-07), una sede se cierra con
 * motivo y sin personal asignado (19-06, D19-03), la zona vacía hereda la del
 * gimnasio (19-10) y el horizonte de clases respeta la sede (19-04).
 *
 * Todo lo que cambia estado vive en sedes y cuentas desechables del gimnasio
 * de demostración: lo comparten las demás pruebas.
 */
describe('personal y gimnasio (1.14)', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let owner: string;
  let demoId = '';
  let cen = '';

  type Persona = {
    id: string; email: string; fullName: string; phoneE164: string | null; isActive: boolean;
    mustChangePassword: boolean; temporaryExpired: boolean; temporaryExpiresAt: string | null; sectionsReviewPending: boolean;
    role: { key: string } | null; unlockedSections: string[] | null;
  };
  const personal = async (cookie: string) => (await app.inject({ method: 'GET', url: '/users', headers: { cookie } })).json().users as Persona[];
  const persona = async (cookie: string, id: string) => (await personal(cookie)).find((p) => p.id === id)!;
  const idDe = async (email: string) => (await getDb().user.findFirstOrThrow({ where: { email }, select: { id: true } })).id;
  const alta = (cookie: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/users', headers: { cookie }, payload: { reason: 'Contratación', ...payload } });

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    [gerencia, owner] = await Promise.all([loginAs(app, 'gerencia@demo.mx'), loginAs(app, 'owner@demo.mx')]);
    const f = await orgFixtures();
    demoId = f.demo.id;
    cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  // ── Personal ──────────────────────────────────────────────────────────────

  it('Personal distingue la temporal vencida de la que sigue vigente (A4-N1)', async () => {
    const r = await alta(gerencia, { email: correoUnico('vencida'), fullName: 'Vera Temporal Prueba', roleKey: 'RECEPTION', branchIds: [cen] });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().user.id as string;
    const vigente = await persona(gerencia, id);
    expect(vigente.mustChangePassword).toBe(true);
    expect(vigente.temporaryExpired).toBe(false);
    const vence = new Date(vigente.temporaryExpiresAt!).getTime() - Date.now();
    expect(vence).toBeGreaterThan(6.9 * 86_400_000);
    expect(vence).toBeLessThanOrEqual(7 * 86_400_000);
    // Ocho días después ya no abre: el login la rechaza y Personal lo dice.
    await getDb().user.update({ where: { id }, data: { passwordResetAt: new Date(Date.now() - 8 * 86_400_000) } });
    expect((await persona(gerencia, id)).temporaryExpired).toBe(true);
    // Una cuenta que ya eligió la suya no tiene temporal.
    const lucia = (await personal(gerencia)).find((p) => p.email === 'gerencia@demo.mx')!;
    expect(lucia.temporaryExpired).toBe(false);
    expect(lucia.temporaryExpiresAt).toBeNull();
  });

  it('el celular del personal es un celular de verdad y se guarda como el de los socios (17-07)', async () => {
    const malo = await alta(gerencia, { email: correoUnico('celular'), fullName: 'Celia Celular Prueba', roleKey: 'RECEPTION', branchIds: [cen], phoneE164: '55123' });
    expect(malo.statusCode).toBe(422);
    expect(JSON.stringify(malo.json().issues)).toMatch(/phoneE164/);
    const r = await alta(gerencia, { email: correoUnico('celular'), fullName: 'Celia Celular Prueba', roleKey: 'RECEPTION', branchIds: [cen], phoneE164: '55 1234 5678' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().user.phoneE164).toBe('+525512345678');
    const id = r.json().user.id as string;
    // Se corrige el nombre y se cambia o se borra el celular, con motivo.
    const cambio = await app.inject({ method: 'PATCH', url: `/users/${id}`, headers: { cookie: gerencia }, payload: { fullName: 'Celia Celular Corregida', phoneE164: '3312345678', reason: 'Apellido mal escrito' } });
    expect(cambio.statusCode, cambio.body).toBe(200);
    expect(cambio.json()).toMatchObject({ fullName: 'Celia Celular Corregida', phoneE164: '+523312345678' });
    expect(cambio.json().temporaryPassword).toBeUndefined();
    const borra = await app.inject({ method: 'PATCH', url: `/users/${id}`, headers: { cookie: gerencia }, payload: { phoneE164: '', reason: 'Ya no usa ese número' } });
    expect(borra.statusCode, borra.body).toBe(200);
    expect(borra.json().phoneE164).toBeNull();
    const log = await getDb().auditLog.findFirst({ where: { action: 'staff.update', resourceId: id }, orderBy: { at: 'asc' } });
    expect(log?.afterState).toMatchObject({ fullName: 'Celia Celular Corregida', phoneE164: '+523312345678' });
  });

  it('reactivar entrega una temporal nueva: la contraseña de antes ya no entra (17-10, D17-06)', async () => {
    const email = await cuentaDePrueba(demoId, 'RECEPTION', [cen]);
    const id = await idDe(email);
    await loginAs(app, email);
    const baja = await app.inject({ method: 'PATCH', url: `/users/${id}`, headers: { cookie: gerencia }, payload: { isActive: false, reason: 'Terminó su contrato' } });
    expect(baja.statusCode, baja.body).toBe(200);
    expect(baja.json().temporaryPassword).toBeUndefined();
    const vuelve = await app.inject({ method: 'PATCH', url: `/users/${id}`, headers: { cookie: gerencia }, payload: { isActive: true, reason: 'Regresa a trabajar' } });
    expect(vuelve.statusCode, vuelve.body).toBe(200);
    const clave = vuelve.json().temporaryPassword as string;
    expect(clave).toMatch(/^GYM-[ACDEFGHJKMNPQRTUVWXYZ2345679]{4}-[ACDEFGHJKMNPQRTUVWXYZ2345679]{4}$/);
    expect(vuelve.json()).toMatchObject({ isActive: true, mustChangePassword: true, temporaryExpired: false });
    // La de siempre ya no sirve; la temporal sí, y solo para elegir la suya.
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })).statusCode).toBe(401);
    const entra = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: clave } });
    expect(entra.statusCode, entra.body).toBe(200);
    expect(entra.json().mustChangePassword).toBe(true);
    // En la bitácora: la reactivación y el restablecimiento, con el mismo motivo.
    const asientos = await getDb().auditLog.findMany({ where: { resourceId: id, action: { in: ['staff.update', 'staff.password_reset'] } } });
    expect(asientos.map((a) => a.action).sort()).toEqual(['staff.password_reset', 'staff.update']);
    expect(asientos.every((a) => a.reason === 'Regresa a trabajar')).toBe(true);
    expect(asientos.find((a) => a.action === 'staff.update')!.afterState).toMatchObject({ isActive: true, reactivated: true });
  });

  it('el rescate del dueño también reactiva con temporal nueva (DP-02 + D17-06)', async () => {
    const email = await cuentaDePrueba(demoId, 'MANAGER', [null]);
    const id = await idDe(email);
    const baja = await app.inject({ method: 'POST', url: `/users/${id}/rescue`, headers: { cookie: owner }, payload: { action: 'deactivate', reason: 'Se fue sin avisar' } });
    expect(baja.statusCode, baja.body).toBe(200);
    expect(baja.json().temporaryPassword).toBeNull();
    const vuelve = await app.inject({ method: 'POST', url: `/users/${id}/rescue`, headers: { cookie: owner }, payload: { action: 'reactivate', reason: 'Regresó' } });
    expect(vuelve.statusCode, vuelve.body).toBe(200);
    expect(vuelve.json().temporaryPassword).toMatch(/^GYM-/);
    expect(vuelve.json()).toMatchObject({ isActive: true, mustChangePassword: true });
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })).statusCode).toBe(401);
  });

  it('un gerente nuevo queda «por decidir qué ve» hasta que la dueña guarda su Qué ve (17-06, D17-03)', async () => {
    // El que da de alta la gerencia nace sin Dirección y la dueña lo ve marcado.
    const r = await alta(gerencia, { email: correoUnico('gerentenuevo'), fullName: 'Gerardo Nuevo Prueba', roleKey: 'MANAGER', branchIds: [] });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().user.id as string;
    expect(r.json().user.unlockedSections).toEqual([]);
    expect((await persona(owner, id)).sectionsReviewPending).toBe(true);
    // Los gerentes de siempre, con su llave decidida, no.
    expect((await personal(owner)).find((p) => p.email === 'gerencia@demo.mx')!.sectionsReviewPending).toBe(false);
    // Dejarlo como está también es decidir: con motivo, queda en la bitácora y el aviso se va.
    const decide = await app.inject({ method: 'PUT', url: `/users/${id}/sections`, headers: { cookie: owner }, payload: { sections: [], reason: 'Por ahora solo opera' } });
    expect(decide.statusCode, decide.body).toBe(200);
    expect((await persona(owner, id)).sectionsReviewPending).toBe(false);

    // Una recepcionista que pasa a gerente también es un gerente nuevo para la dueña.
    const rec = await alta(gerencia, { email: correoUnico('ascenso'), fullName: 'Rosa Ascenso Prueba', roleKey: 'RECEPTION', branchIds: [cen] });
    const recId = rec.json().user.id as string;
    const libera = await app.inject({ method: 'PUT', url: `/users/${recId}/sections`, headers: { cookie: owner }, payload: { sections: ['retencion'], reason: 'Llama a los socios' } });
    expect(libera.statusCode, libera.body).toBe(200);
    expect((await persona(owner, recId)).sectionsReviewPending).toBe(false);
    const sube = await app.inject({ method: 'PUT', url: `/users/${recId}/role`, headers: { cookie: gerencia }, payload: { roleKey: 'MANAGER', branchIds: [], reason: 'Ascenso' } });
    expect(sube.statusCode, sube.body).toBe(200);
    expect((await persona(owner, recId)).sectionsReviewPending).toBe(true);
  });

  /**
   * 17-04 (D17-05): «gerente que administra» = gerente activo con Personal
   * liberado. La regla vive en `identity/session.repository.ts` (la aplicó
   * 1.12 con el parche que dejó 1.14).
   */
  it('sin un gerente que tenga Personal liberado, la dueña administra al personal (17-04, D17-05)', async () => {
    const plataforma = await loginPlataforma(app);
    const sufijo = Math.random().toString(36).slice(2, 7);
    const correo = (n: string) => `${n}.${sufijo}@unocuatro.mx`;
    const r = await app.inject({ method: 'POST', url: '/platform/organizations', headers: { cookie: plataforma }, payload: {
      legalName: `Catorce ${sufijo} S.A.`, tradeName: `Catorce ${sufijo}`, template: 'barrio', branch: { code: 'CAT', name: 'Matriz' },
      owner: { fullName: 'Dalia Duena Catorce', email: correo('duena') },
      manager: { fullName: 'Gael Gerente Catorce', email: correo('gerente') },
      reason: 'Prueba de la gerencia que administra',
    } });
    expect(r.statusCode, r.body).toBe(201);
    const orgId = r.json().organizationId as string;
    await app.inject({ method: 'POST', url: `/platform/organizations/${orgId}/service`, headers: { cookie: plataforma }, payload: { status: 'ACTIVE', reason: 'Prueba' } });
    await getDb().user.updateMany({ where: { organizationId: orgId }, data: { passwordHash: await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 }), mustChangePassword: false } });
    const permisos = async (email: string) => (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: await loginAs(app, email) } })).json().permissions as string[];
    // El primer gerente nace con todo: administra él.
    expect(await permisos(correo('duena'))).not.toContain('staff:manage');
    // La dueña le quita Personal: nadie más podría contratar, así que administra ella.
    const dueno = await loginAs(app, correo('duena'));
    const gerenteId = await idDe(correo('gerente'));
    const quita = await app.inject({ method: 'PUT', url: `/users/${gerenteId}/sections`, headers: { cookie: dueno }, payload: { sections: ['tablero'], reason: 'Solo números' } });
    expect(quita.statusCode, quita.body).toBe(200);
    expect(await permisos(correo('duena'))).toContain('staff:manage');
    // Se la devuelve: vuelve a solo consultar.
    await app.inject({ method: 'PUT', url: `/users/${gerenteId}/sections`, headers: { cookie: dueno }, payload: { sections: ['tablero', 'personal'], reason: 'Vuelve a contratar' } });
    expect(await permisos(correo('duena'))).not.toContain('staff:manage');
  });

  // ── Caja ──────────────────────────────────────────────────────────────────

  it('Caja dice qué tiene vivo y no se deja de usar en una sede con un turno abierto (19-01, D19-05)', async () => {
    const sede = await sedeDesechable(demoId, 'Sede caja');
    const enSede = (key: string, enabled: boolean) => app.inject({
      method: 'PUT', url: `/organization/modules/${key}/branches/${sede.id}`, headers: { cookie: gerencia },
      payload: { enabled, ...(enabled ? {} : { reason: 'Prueba de caja' }) },
    });
    try {
      const caja = await app.inject({ method: 'POST', url: '/cash-registers', headers: { cookie: gerencia }, payload: { branchId: sede.id, code: 'C1', name: `Caja 1 ${sede.code}` } });
      expect(caja.statusCode, caja.body).toBe(201);
      expect(await usageOf('cash', demoId, sede.id)).toEqual({ inUse: ['1 caja en uso'], blockers: [] });
      const turno = await app.inject({ method: 'POST', url: '/cash-sessions', headers: { cookie: gerencia }, payload: { cashRegisterId: caja.json().id, openingFloatCents: '0' } });
      expect(turno.statusCode, turno.body).toBe(201);
      expect((await usageOf('cash', demoId, sede.id)).blockers).toEqual(['1 turno de caja abierto']);
      // En todo el gimnasio también cuenta (y por eso tampoco se apaga ahí).
      expect((await usageOf('cash', demoId)).blockers.length).toBe(1);

      // Punto de venta necesita Caja: primero se deja de usar ese.
      expect((await enSede('pos', false)).statusCode).toBe(200);
      const bloqueada = await enSede('cash', false);
      expect(bloqueada.statusCode, bloqueada.body).toBe(409);
      expect(bloqueada.json().detail).toBe('MODULE_BLOCKED');
      expect(bloqueada.json().message).toMatch(/1 turno de caja abierto/);

      // Con el corte hecho, sí.
      const id = turno.json().id as string;
      const esperado = (await app.inject({ method: 'GET', url: `/cash-sessions/${id}`, headers: { cookie: gerencia } })).json().expectedCashCents as string;
      const corte = await app.inject({ method: 'POST', url: `/cash-sessions/${id}/close`, headers: { cookie: gerencia }, payload: { countedCashCents: esperado } });
      expect(corte.statusCode, corte.body).toBe(200);
      expect((await enSede('cash', false)).statusCode).toBe(200);
    } finally {
      await enSede('cash', true);
      await enSede('pos', true);
      await archivarSede(sede.id);
    }
  });

  it('la última caja de una sede que usa Caja no se retira; si ahí ya no se corta cajón, sí (19-07)', async () => {
    const sede = await sedeDesechable(demoId, 'Sede cajas');
    const nueva = async (code: string) => (await app.inject({ method: 'POST', url: '/cash-registers', headers: { cookie: gerencia }, payload: { branchId: sede.id, code, name: `Caja ${code} ${sede.code}` } })).json().id as string;
    const retirar = (id: string) => app.inject({ method: 'PATCH', url: `/cash-registers/${id}`, headers: { cookie: gerencia }, payload: { isActive: false } });
    const enSede = (key: string, enabled: boolean) => app.inject({
      method: 'PUT', url: `/organization/modules/${key}/branches/${sede.id}`, headers: { cookie: gerencia },
      payload: { enabled, ...(enabled ? {} : { reason: 'Prueba de cajas' }) },
    });
    try {
      const c1 = await nueva('C1');
      const sola = await retirar(c1);
      expect(sola.statusCode, sola.body).toBe(409);
      expect(sola.json().detail).toBe('LAST_REGISTER');
      expect(sola.json().message).toMatch(/única caja de Sede cajas/);
      // Con otra caja, la primera sí se retira; la que queda, no.
      const c2 = await nueva('C2');
      expect((await retirar(c1)).statusCode).toBe(200);
      expect((await retirar(c2)).json().detail).toBe('LAST_REGISTER');
      // Renombrar la última sigue permitido.
      expect((await app.inject({ method: 'PATCH', url: `/cash-registers/${c2}`, headers: { cookie: gerencia }, payload: { name: 'Caja de la entrada' } })).statusCode).toBe(200);
      // El camino para «aquí no se corta cajón» es dejar de usar Caja en la sede:
      // entonces sus cajas ni se tocan, y cobrar sigue (sin turno).
      expect((await enSede('pos', false)).statusCode).toBe(200);
      expect((await enSede('cash', false)).statusCode).toBe(200);
      const apagada = await retirar(c2);
      expect(apagada.statusCode).toBe(403);
      expect(apagada.json().error).toBe('MODULE_DISABLED');
    } finally {
      await enSede('cash', true);
      await enSede('pos', true);
      await archivarSede(sede.id);
    }
  });

  // ── Sucursales ────────────────────────────────────────────────────────────

  it('cerrar una sucursal pide motivo y no deja a nadie asignado a ella (19-06, D19-03)', async () => {
    const sede = await sedeDesechable(demoId, 'Sede por cerrar');
    try {
      const email = await cuentaDePrueba(demoId, 'RECEPTION', [sede.id]);
      const id = await idDe(email);
      const nombre = (await getDb().user.findUniqueOrThrow({ where: { id } })).fullName;
      const resumen = await app.inject({ method: 'GET', url: `/branches/${sede.id}/closing-summary`, headers: { cookie: gerencia } });
      expect(resumen.statusCode, resumen.body).toBe(200);
      expect(resumen.json().staff).toEqual([{ id, fullName: nombre, roleName: 'Recepción' }]);

      const cerrar = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/branches/${sede.id}`, headers: { cookie: gerencia }, payload: { isActive: false, ...payload } });
      const sinMotivo = await cerrar({});
      expect(sinMotivo.statusCode, sinMotivo.body).toBe(422);
      expect(sinMotivo.json().message).toMatch(/motivo/);
      const conPersonal = await cerrar({ reason: 'Se termina la renta del local' });
      expect(conPersonal.statusCode, conPersonal.body).toBe(409);
      expect(conPersonal.json().detail).toBe('BRANCH_HAS_STAFF');
      expect(conPersonal.json().message).toContain(nombre);

      // Dada de baja la persona, se cierra; el motivo queda en la bitácora.
      expect((await app.inject({ method: 'PATCH', url: `/users/${id}`, headers: { cookie: gerencia }, payload: { isActive: false, reason: 'Cierra su sucursal' } })).statusCode).toBe(200);
      const cierre = await cerrar({ reason: 'Se termina la renta del local' });
      expect(cierre.statusCode, cierre.body).toBe(200);
      expect(cierre.json().isActive).toBe(false);
      const log = await getDb().auditLog.findFirst({ where: { action: 'branch.update', resourceId: sede.id }, orderBy: { at: 'desc' } });
      expect(log?.reason).toBe('Se termina la renta del local');
      // Reabrirla no pide motivo.
      const reabre = await app.inject({ method: 'PATCH', url: `/branches/${sede.id}`, headers: { cookie: gerencia }, payload: { isActive: true } });
      expect(reabre.statusCode, reabre.body).toBe(200);
      // La dueña no cierra sucursales.
      expect((await app.inject({ method: 'PATCH', url: `/branches/${sede.id}`, headers: { cookie: owner }, payload: { isActive: false, reason: 'Prueba' } })).statusCode).toBe(403);
    } finally {
      await archivarSede(sede.id);
    }
  });

  it('una sede sin zona propia hereda la del gimnasio, y una zona inventada se rechaza (19-10)', async () => {
    const sede = await sedeDesechable(demoId, 'Sede zona');
    const zona = (timezone: string | null) => app.inject({ method: 'PATCH', url: `/branches/${sede.id}`, headers: { cookie: gerencia }, payload: { timezone } });
    try {
      expect((await zona('America/Tijuana')).json().timezone).toBe('America/Tijuana');
      // Editar otra cosa sin mandar la zona no la toca.
      const nombre = await app.inject({ method: 'PATCH', url: `/branches/${sede.id}`, headers: { cookie: gerencia }, payload: { name: 'Sede zona norte' } });
      expect(nombre.json().timezone).toBe('America/Tijuana');
      // Vacía = hereda.
      expect((await zona(null)).json().timezone).toBeNull();
      expect((await zona('')).json().timezone).toBeNull();
      const inventada = await zona('Marte/Olimpo');
      expect(inventada.statusCode).toBe(422);
      expect(JSON.stringify(inventada.json().issues)).toMatch(/Zona horaria desconocida/);
      // La dueña la consulta: la lista de sucursales es de cualquiera con sesión.
      const sedes = (await app.inject({ method: 'GET', url: '/branches', headers: { cookie: owner } })).json() as Array<{ id: string; timezone: string | null }>;
      expect(sedes.find((b) => b.id === sede.id)?.timezone).toBeNull();
    } finally {
      await archivarSede(sede.id);
    }
  });

  // ── Clases ────────────────────────────────────────────────────────────────

  it('el horizonte de clases respeta la sede: sin Clases ahí, ni sesiones nuevas ni reservas (19-04)', async () => {
    const db = getDb();
    const sede = await sedeDesechable(demoId, 'Sede clases');
    const enSede = (enabled: boolean) => app.inject({
      method: 'PUT', url: `/organization/modules/classes/branches/${sede.id}`, headers: { cookie: gerencia },
      payload: { enabled, ...(enabled ? {} : { reason: 'Esta sede no tiene salón' }) },
    });
    const sesiones = () => db.classSchedule.count({ where: { branchId: sede.id } });
    try {
      const tipo = await app.inject({ method: 'POST', url: '/classes/types', headers: { cookie: gerencia }, payload: { name: `Yoga ${sede.code}`, dropInPriceCents: '0' } });
      expect(tipo.statusCode, tipo.body).toBe(201);
      const plantilla = await app.inject({
        method: 'POST', url: '/classes/templates', headers: { cookie: gerencia },
        payload: { branchId: sede.id, classTypeId: tipo.json().id, effectiveFrom: new Date().toISOString().slice(0, 10), slots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 23 * 60, durationMin: 30, capacity: 5 })) },
      });
      expect(plantilla.statusCode, plantilla.body).toBe(201);
      // Al crear el horario ya genera sus clases.
      expect(await sesiones()).toBeGreaterThan(0);

      // La sede deja de usar Clases (sin reservas, se puede): el horizonte se la
      // salta. Se borran las ya generadas para ver que la noche no las rehace.
      expect((await enSede(false)).statusCode).toBe(200);
      expect((await sedesConClases(demoId))(sede.id)).toBe(false);
      await db.classSchedule.deleteMany({ where: { branchId: sede.id, bookedCount: 0 } });
      const r = await new ClassService().materializeHorizon(demoId, { days: 7 });
      expect(r.skipped).toBeGreaterThanOrEqual(1);
      expect(await sesiones()).toBe(0);

      // La retoma: vuelve a generar.
      expect((await enSede(true)).statusCode).toBe(200);
      await new ClassService().materializeHorizon(demoId, { days: 7 });
      expect(await sesiones()).toBeGreaterThan(0);

      // Las que ya estaban no se ofrecen ni se reservan mientras no las dé.
      expect((await enSede(false)).statusCode).toBe(200);
      const una = await db.classSchedule.findFirstOrThrow({ where: { branchId: sede.id, status: 'SCHEDULED' } });
      const socio = await db.member.findFirstOrThrow({ where: { organizationId: demoId, deletedAt: null } });
      await expect(new ClassService().book(demoId, { scheduleId: una.id, memberId: socio.id, source: 'PORTAL' })).rejects.toMatchObject({ code: 'MODULE_DISABLED' });
    } finally {
      await enSede(true);
      await db.classSchedule.deleteMany({ where: { branchId: sede.id, bookedCount: 0 } });
      await db.classTemplate.updateMany({ where: { branchId: sede.id }, data: { isActive: false } });
      await archivarSede(sede.id);
    }
  });

  it('una sede cerrada tampoco recibe clases nuevas (19-04)', async () => {
    const sede = await sedeDesechable(demoId, 'Sede cerrada');
    try {
      expect((await sedesConClases(demoId))(sede.id)).toBe(true);
      await getDb().branch.update({ where: { id: sede.id }, data: { isActive: false } });
      expect((await sedesConClases(demoId))(sede.id)).toBe(false);
    } finally {
      await archivarSede(sede.id);
    }
  });
});
