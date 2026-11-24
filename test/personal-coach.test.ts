import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hash } from '@node-rs/argon2';
import { makeApp, loginAs, loginPlataforma, PASSWORD, nombreUnico, telefonoUnico, CONSENTIMIENTOS, publicarTextosDePrueba } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * 2026-10-09: cuentas de arranque a la medida, el dueño que administra al
 * personal mientras no haya gerente, los permisos por persona y el coach que
 * solo ve a sus socios asignados.
 */
describe('personal a la medida y coach con sus socios', () => {
  let app: FastifyInstance;
  let plataforma: string;
  const sufijo = Math.random().toString(36).slice(2, 7);
  const correo = (n: string) => `${n}.${sufijo}@personal.mx`;
  let orgId = '';
  let sede = '';

  beforeAll(async () => {
    app = await makeApp(); await app.ready();
    plataforma = await loginPlataforma(app);
    // Sin gerente: dueño, una recepción y un coach.
    const r = await app.inject({ method: 'POST', url: '/platform/organizations', headers: { cookie: plataforma }, payload: {
      legalName: `Norte ${sufijo} S.A.`, tradeName: `Norte ${sufijo}`, template: 'cadena',
      branch: { code: 'NTE', name: 'Matriz' },
      owner: { fullName: 'Olga Duena Norte', email: correo('duena') },
      staff: [
        { role: 'RECEPTION', fullName: 'Rene Recepcion Norte', email: correo('recepcion') },
        { role: 'COACH', fullName: 'Coco Coach Norte', email: correo('coach') },
      ],
      reason: 'Prueba sin gerente',
    } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().credentials.map((c: { roleKey: string }) => c.roleKey)).toEqual(['OWNER', 'RECEPTION', 'COACH']);
    orgId = r.json().organizationId;
    sede = r.json().branchId;
    await app.inject({ method: 'POST', url: `/platform/organizations/${orgId}/service`, headers: { cookie: plataforma }, payload: { status: 'ACTIVE', reason: 'Prueba' } });
    // Contraseña conocida y ya propia, para entrar directo.
    await getDb().user.updateMany({ where: { organizationId: orgId }, data: { passwordHash: await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 }), mustChangePassword: false } });
    // Un gimnasio nuevo no da de alta a nadie sin su aviso y su reglamento publicados (1.10, 21-06).
    await publicarTextosDePrueba(orgId);
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  const yo = async (cookie: string) => (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json();
  const idDe = async (email: string) => (await getDb().user.findFirstOrThrow({ where: { email }, select: { id: true } })).id;

  it('las cuentas de arranque son las que se pidan; sin lista ni gerente, solo el dueño', async () => {
    const r = await app.inject({ method: 'POST', url: '/platform/organizations', headers: { cookie: plataforma }, payload: {
      legalName: `Solo ${sufijo} S.A.`, tradeName: `Solo ${sufijo}`, template: 'barrio', branch: { code: 'SOL', name: 'Matriz' },
      owner: { fullName: 'Sara Sola Duena', email: correo('sola') }, staff: [], reason: 'Solo el dueño',
    } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().credentials).toHaveLength(1);
  });

  it('sin gerente, el dueño administra al personal; con gerente, vuelve a solo consultar', async () => {
    const dueno = await loginAs(app, correo('duena'));
    expect((await yo(dueno)).permissions).toContain('staff:manage');
    // Y registra los gastos fijos (2026-10-10).
    expect((await yo(dueno)).permissions).toContain('expenses:manage');
    const gasto = await app.inject({ method: 'POST', url: '/expenses', headers: { cookie: dueno }, payload: { category: 'RENT', description: 'Renta de octubre', amountCents: '1500000', month: new Date().toISOString().slice(0, 7), branchId: null } });
    expect(gasto.statusCode, gasto.body).toBe(201);

    const alta = await app.inject({ method: 'POST', url: '/users', headers: { cookie: dueno }, payload: { email: correo('recepciondos'), fullName: 'Rita Recepcion Dos', roleKey: 'RECEPTION', branchIds: [sede], reason: 'Turno de la tarde' } });
    expect(alta.statusCode, alta.body).toBe(201);
    const otroDueno = await app.inject({ method: 'POST', url: '/users', headers: { cookie: dueno }, payload: { email: correo('duenodos'), fullName: 'Dino Dueno Dos', roleKey: 'OWNER', branchIds: [], reason: 'Otro socio del negocio' } });
    expect(otroDueno.statusCode).toBe(403);

    // Llega un gerente. Nace sin Personal: hasta que el dueño se lo libere,
    // el dueño sigue administrando (17-04, D17-05); con Personal, deja de hacerlo.
    const gerente = await app.inject({ method: 'POST', url: '/users', headers: { cookie: dueno }, payload: { email: correo('gerente'), fullName: 'Gino Gerente Norte', roleKey: 'MANAGER', branchIds: [], reason: 'Contratado' } });
    expect(gerente.statusCode, gerente.body).toBe(201);
    expect((await yo(dueno)).permissions).toContain('staff:manage');
    const libera = await app.inject({ method: 'PUT', url: `/users/${gerente.json().user.id}/sections`, headers: { cookie: dueno }, payload: { sections: ['personal'], reason: 'Que contrate él' } });
    expect(libera.statusCode, libera.body).toBe(200);
    expect((await yo(dueno)).permissions).not.toContain('staff:manage');
    // D-23 (fase 3, 3.7): los gastos, la nómina y sus retiros los sigue anotando AUNQUE haya gerente
    // (antes dejaba de poder); lo que deja de poder con gerente es cerrar el mes sola.
    expect((await yo(dueno)).permissions).toContain('expenses:manage');
    expect((await yo(dueno)).permissions).not.toContain('reports:month:close');
    // Se va el gerente: lo vuelve a tener.
    await getDb().user.update({ where: { id: gerente.json().user.id }, data: { isActive: false } });
    expect((await yo(dueno)).permissions).toContain('staff:manage');
    // Y sin gerente cierra el mes ella, con su contraseña (D-23).
    expect((await yo(dueno)).permissions).toContain('reports:month:close');
  });

  it('permisos por persona: se encienden y apagan acciones de la lista, sobre el puesto', async () => {
    const dueno = await loginAs(app, correo('duena'));
    const rec = await idDe(correo('recepcion'));
    const r = await app.inject({ method: 'PUT', url: `/users/${rec}/permissions`, headers: { cookie: dueno }, payload: { add: ['pos:sale:void', 'classes:manage'], remove: ['pos:sale:create'], reason: 'Encargada del turno' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().permissionOverrides).toEqual({ add: ['classes:manage', 'pos:sale:void'], remove: ['pos:sale:create'] });
    const permisos = (await yo(await loginAs(app, correo('recepcion')))).permissions as string[];
    expect(permisos).toContain('pos:sale:void');
    expect(permisos).toContain('classes:manage');
    expect(permisos).not.toContain('pos:sale:create');
    expect(permisos).toContain('payments:record');

    const fuera = await app.inject({ method: 'PUT', url: `/users/${rec}/permissions`, headers: { cookie: dueno }, payload: { add: ['staff:manage'], reason: 'x' } });
    expect(fuera.statusCode).toBe(422);
    const catalogo = (await app.inject({ method: 'GET', url: '/users/adjustable-permissions', headers: { cookie: dueno } })).json();
    expect(catalogo.groups.length).toBeGreaterThan(3);
    // Volver al puesto: listas vacías.
    const limpio = await app.inject({ method: 'PUT', url: `/users/${rec}/permissions`, headers: { cookie: dueno }, payload: { add: [], remove: [], reason: 'Como su puesto' } });
    expect(limpio.json().permissionOverrides).toEqual({ add: [], remove: [] });
  });

  it('el coach ve solo a sus socios asignados, Rutinas y Clases', async () => {
    const recepcion = await loginAs(app, correo('recepcion'));
    const coachId = await idDe(correo('coach'));
    // D-29: recepción elige el coach AL ALTA; después ya no lo cambia.
    const alta = (coachUserId?: string) => app.inject({ method: 'POST', url: '/members', headers: { cookie: recepcion },
      payload: { firstName: nombreUnico('Suyo'), lastName: nombreUnico('Socio'), phoneE164: telefonoUnico(), homeBranchId: sede, consents: CONSENTIMIENTOS, ...(coachUserId ? { coachUserId } : {}) } });
    const suyo = (await alta(coachId)).json() as { id: string; firstName: string };
    const ajeno = (await alta()).json() as { id: string; firstName: string };
    expect((await alta(await idDe(correo('recepcion')))).statusCode).toBe(422);

    const coaches = (await app.inject({ method: 'GET', url: '/members/coaches', headers: { cookie: recepcion } })).json().coaches;
    expect(coaches.map((c: { id: string }) => c.id)).toContain(coachId);
    const asignar = await app.inject({ method: 'PUT', url: `/members/${ajeno.id}/coach`, headers: { cookie: recepcion }, payload: { coachUserId: coachId } });
    expect(asignar.statusCode, asignar.body).toBe(403);

    const coach = await loginAs(app, correo('coach'));
    const permisos = (await yo(coach)).permissions as string[];
    expect(permisos).not.toContain('access:attendance:read');
    const lista = (await app.inject({ method: 'GET', url: '/members', headers: { cookie: coach } })).json();
    expect(lista.members.map((m: { id: string }) => m.id)).toEqual([suyo.id]);
    expect((await app.inject({ method: 'GET', url: `/members/${suyo.id}`, headers: { cookie: coach } })).json().coachUserId).toBe(coachId);
    expect((await app.inject({ method: 'GET', url: `/members/${ajeno.id}`, headers: { cookie: coach } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/members/${ajeno.id}/health`, headers: { cookie: coach } })).statusCode).toBe(404);
    const busca = (await app.inject({ method: 'GET', url: `/members/search?q=${encodeURIComponent(ajeno.firstName)}`, headers: { cookie: coach } })).json();
    expect(busca.results).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: `/members/access-summary?ids=${ajeno.id}`, headers: { cookie: coach } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/members/access-summary?ids=${suyo.id}`, headers: { cookie: coach } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/routines', headers: { cookie: coach } })).statusCode).toBe(200);

    // Sin coach asignado, deja de verlo (este gimnasio no tiene gerente que lo quite: se quita en la base).
    await getDb().member.update({ where: { id: suyo.id }, data: { coachUserId: null } });
    expect((await app.inject({ method: 'GET', url: `/members/${suyo.id}`, headers: { cookie: coach } })).statusCode).toBe(404);
  });

  it('al coach solo se le ajusta lo de su trabajo: nunca caja, cobro, venta, acceso ni altas (17-02)', async () => {
    const dueno = await loginAs(app, correo('duena'));
    const coachId = await idDe(correo('coach'));
    for (const add of ['cash:session:open', 'payments:record', 'pos:sale:create', 'access:manual_grant', 'members:create']) {
      const r = await app.inject({ method: 'PUT', url: `/users/${coachId}/permissions`, headers: { cookie: dueno }, payload: { add: [add], reason: 'Prueba de excepciones' } });
      expect(r.statusCode, add).toBe(422);
      expect(r.json().message).toMatch(/A Coach no se le ajusta/);
    }
    // Lo de su trabajo sí: a este coach se le da armar el horario (D-28: ya no viene con el puesto) y se le quita reservar por el socio.
    const bien = await app.inject({ method: 'PUT', url: `/users/${coachId}/permissions`, headers: { cookie: dueno }, payload: { add: ['classes:manage'], remove: ['classes:book_for_member'], reason: 'Arma el horario' } });
    expect(bien.statusCode, bien.body).toBe(200);
    expect(bien.json().permissionOverrides).toEqual({ add: ['classes:manage'], remove: ['classes:book_for_member'] });
    // Cancelar clases no se le enciende a nadie por persona (D-28).
    expect((await app.inject({ method: 'PUT', url: `/users/${coachId}/permissions`, headers: { cookie: dueno }, payload: { add: ['classes:session:cancel'], reason: 'Prueba' } })).statusCode).toBe(422);
    // El catálogo dice qué se le ajusta a cada puesto: el panel solo muestra eso.
    const cat = (await app.inject({ method: 'GET', url: '/users/adjustable-permissions', headers: { cookie: dueno } })).json();
    const delCoach = cat.roles.find((r: { key: string }) => r.key === 'COACH').adjustable as string[];
    expect(delCoach).toContain('training:assign');
    expect(delCoach).not.toContain('cash:session:open');
    expect(cat.roles.find((r: { key: string }) => r.key === 'RECEPTION').adjustable).toContain('cash:withdraw');
    // Un ajuste viejo que quedó guardado (de antes de la regla) ya no le da caja ni venta.
    await getDb().user.update({ where: { id: coachId }, data: { permissionOverrides: { add: ['cash:session:open', 'pos:sale:create'], remove: ['classes:book_for_member'] } } });
    const permisos = (await yo(await loginAs(app, correo('coach')))).permissions as string[];
    expect(permisos).not.toContain('cash:session:open');
    expect(permisos).not.toContain('pos:sale:create');
    expect(permisos).not.toContain('classes:book_for_member');
    expect(permisos).not.toContain('classes:manage');
    expect((await app.inject({ method: 'GET', url: `/users/${coachId}`, headers: { cookie: dueno } })).json().permissionOverrides).toEqual({ add: [], remove: ['classes:book_for_member'] });
  });

  it('cambiar de puesto borra las excepciones y lo deja en la bitácora (17-03)', async () => {
    const dueno = await loginAs(app, correo('duena'));
    const alta = await app.inject({ method: 'POST', url: '/users', headers: { cookie: dueno }, payload: { email: correo('cambia'), fullName: 'Carla Cambia Puesto', roleKey: 'RECEPTION', branchIds: [sede], reason: 'Turno de la mañana' } });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json().user.id as string;
    const ajuste = await app.inject({ method: 'PUT', url: `/users/${id}/permissions`, headers: { cookie: dueno }, payload: { add: ['pos:sale:void'], reason: 'Encargada del turno' } });
    expect(ajuste.json().permissionOverrides).toEqual({ add: ['pos:sale:void'], remove: [] });
    // Pasa a coach: lo que se le encendió en el mostrador no viaja con ella.
    const aCoach = await app.inject({ method: 'PUT', url: `/users/${id}/role`, headers: { cookie: dueno }, payload: { roleKey: 'COACH', branchIds: [], reason: 'Ahora da clases' } });
    expect(aCoach.statusCode, aCoach.body).toBe(200);
    expect(aCoach.json().permissionOverrides).toEqual({ add: [], remove: [] });
    expect((await getDb().user.findUniqueOrThrow({ where: { id }, select: { permissionOverrides: true } })).permissionOverrides).toBeNull();
    const asiento = await getDb().auditLog.findFirstOrThrow({ where: { action: 'staff.role', resourceId: id }, orderBy: { at: 'desc' } });
    expect(asiento.beforeState).toMatchObject({ role: 'RECEPTION', permissionOverrides: { add: ['pos:sale:void'], remove: [] } });
    expect(asiento.afterState).toMatchObject({ role: 'COACH', overridesCleared: true });
    // Y si vuelve a recepción, no reviven.
    const vuelve = await app.inject({ method: 'PUT', url: `/users/${id}/role`, headers: { cookie: dueno }, payload: { roleKey: 'RECEPTION', branchIds: [sede], reason: 'Regresa al mostrador' } });
    expect(vuelve.statusCode, vuelve.body).toBe(200);
    expect(vuelve.json().permissionOverrides).toEqual({ add: [], remove: [] });
    // Cambiar solo de sucursal no es cambiar de puesto: lo que tenga se queda.
    await app.inject({ method: 'PUT', url: `/users/${id}/permissions`, headers: { cookie: dueno }, payload: { add: ['pos:sale:void'], reason: 'Encargada otra vez' } });
    const sedes = await app.inject({ method: 'PUT', url: `/users/${id}/role`, headers: { cookie: dueno }, payload: { roleKey: 'RECEPTION', branchIds: [sede], reason: 'Misma sucursal' } });
    expect(sedes.json().permissionOverrides).toEqual({ add: ['pos:sale:void'], remove: [] });
  });
});
