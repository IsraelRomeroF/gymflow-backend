import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, cuentaDePrueba, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * EL DÍA DEL COACH (auditoría 8, fase 2, bloque 2.6).
 *
 * Asignar con «Revisar en», «Personalizar para…», «Hoy toca» y «día hecho»
 * en el portal, el inicio del coach, recepción que ve la rutina sin poder
 * cambiarla y la baja de un coach, que pregunta a quién pasan sus socios.
 * Cada caso usa coaches y socios propios: no depende de los sembrados.
 */
describe('el día del coach', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let recepcion: string;
  let orgId: string;
  let cen: string;
  type Ej = { id: string; muscleGroup: string; custom: boolean };
  let catalogo: Ej[];

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
    catalogo = (await app.inject({ method: 'GET', url: '/exercises', headers: { cookie: gerencia } })).json().exercises;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  const de = (g: string) => catalogo.filter((e) => e.muscleGroup === g && !e.custom);
  const rutina = (nombre: string, dias = 3) => ({
    name: nombre, goal: 'FUERZA', level: 'INTERMEDIO',
    days: ['Pecho', 'Pierna', 'Espalda', 'Hombro'].slice(0, dias).map((name, i) => ({
      name, items: [{ exerciseId: de(['CHEST', 'LEGS', 'BACK', 'SHOULDERS'][i]!)[0]!.id, sets: 4, reps: '8', restSeconds: 90 }],
    })),
  });

  async function coachNuevo(): Promise<{ id: string; cookie: string }> {
    const correo = await cuentaDePrueba(orgId, 'COACH', [null]);
    const id = (await getDb().user.findFirstOrThrow({ where: { email: correo }, select: { id: true } })).id;
    return { id, cookie: await loginAs(app, correo) };
  }
  async function socio(coachId?: string): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Coach'), lastName: nombreUnico('Socio'), phoneE164: telefonoUnico(), homeBranchId: cen, force: true, consents: CONSENTIMIENTOS },
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    if (coachId) {
      const c = await app.inject({ method: 'PUT', url: `/members/${id}/coach`, headers: { cookie: gerencia }, payload: { coachUserId: coachId } });
      expect(c.statusCode, c.body).toBe(200);
    }
    return id;
  }
  async function portalDe(memberId: string): Promise<string> {
    const invite = await app.inject({ method: 'POST', url: `/members/${memberId}/portal-invite`, headers: { cookie: gerencia } });
    const enroll = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code } });
    return `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}`;
  }
  const crear = async (cookie: string, nombre: string, dias = 3) => {
    const r = await app.inject({ method: 'POST', url: '/routines', headers: { cookie }, payload: rutina(nombre, dias) });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; activeMembers: number; personalFor: unknown };
  };
  const masDias = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00.000Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

  it('asignar con «Revisar en» guarda la fecha; sin el dato no hay revisión; otra cifra se rechaza (12-09)', async () => {
    const coach = await coachNuevo();
    const m = await socio(coach.id);
    const r = await crear(coach.cookie, 'Revisión A');
    const mala = await app.inject({ method: 'POST', url: `/members/${m}/routine`, headers: { cookie: coach.cookie }, payload: { routineId: r.id, reviewWeeks: 5 } });
    expect(mala.statusCode).toBe(422);
    const sin = await app.inject({ method: 'POST', url: `/members/${m}/routine`, headers: { cookie: coach.cookie }, payload: { routineId: r.id } });
    expect(sin.statusCode, sin.body).toBe(201);
    expect(sin.json().reviewOn).toBeNull();
    const con = await app.inject({ method: 'POST', url: `/members/${m}/routine`, headers: { cookie: coach.cookie }, payload: { routineId: r.id, reviewWeeks: 6 } });
    expect(con.statusCode, con.body).toBe(201);
    const vista = (await app.inject({ method: 'GET', url: `/members/${m}/routine`, headers: { cookie: coach.cookie } })).json().assignment;
    expect(vista.reviewOn).toBe(masDias(vista.progress.today, 42));
    expect(vista.reviewDue).toBe(false);
    expect(vista.routine.activeMembers).toBe(1);
    // La anterior quedó cerrada con quién la terminó.
    const cerradas = await getDb().workoutAssignment.findMany({ where: { memberId: m, endedAt: { not: null } }, select: { endedByUserId: true } });
    expect(cerradas).toHaveLength(1);
    expect(cerradas[0]!.endedByUserId).toBe(coach.id);
  });

  it('recepción ve la rutina del socio y no la puede cambiar (12-17)', async () => {
    const coach = await coachNuevo();
    const m = await socio(coach.id);
    const r = await crear(coach.cookie, 'Para el mostrador');
    await app.inject({ method: 'POST', url: `/members/${m}/routine`, headers: { cookie: coach.cookie }, payload: { routineId: r.id, notes: 'Ligero' } });
    const ve = await app.inject({ method: 'GET', url: `/members/${m}/routine`, headers: { cookie: recepcion } });
    expect(ve.statusCode, ve.body).toBe(200);
    expect(ve.json().assignment.routine.days).toHaveLength(3);
    expect((await app.inject({ method: 'POST', url: `/members/${m}/routine`, headers: { cookie: recepcion }, payload: { routineId: r.id } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/members/${m}/routine/end`, headers: { cookie: recepcion }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/members/${m}/routine/personalize`, headers: { cookie: recepcion }, payload: {} })).statusCode).toBe(403);
    // Ver la del socio no abre el catálogo de rutinas.
    expect((await app.inject({ method: 'GET', url: '/routines', headers: { cookie: recepcion } })).statusCode).toBe(403);
  });

  it('«Personalizar para…»: la copia es del socio, no sale en el catálogo y editarla no toca a los demás (12-05)', async () => {
    const coach = await coachNuevo();
    const [juan, ana] = [await socio(coach.id), await socio(coach.id)];
    const r = await crear(coach.cookie, `Compartida ${Date.now()}`);
    for (const m of [juan, ana]) await app.inject({ method: 'POST', url: `/members/${m}/routine`, headers: { cookie: coach.cookie }, payload: { routineId: r.id, reviewWeeks: 4, notes: 'Nota' } });
    expect((await app.inject({ method: 'GET', url: `/routines/${r.id}`, headers: { cookie: coach.cookie } })).json().activeMembers).toBe(2);

    const p = await app.inject({ method: 'POST', url: `/members/${juan}/routine/personalize`, headers: { cookie: coach.cookie }, payload: {} });
    expect(p.statusCode, p.body).toBe(201);
    const copia = p.json().routineId as string;
    expect(copia).not.toBe(r.id);
    // Repetirlo no hace otra copia.
    const otra = await app.inject({ method: 'POST', url: `/members/${juan}/routine/personalize`, headers: { cookie: coach.cookie }, payload: {} });
    expect(otra.statusCode).toBe(200);
    expect(otra.json()).toMatchObject({ routineId: copia, created: false });

    // Juan conserva su asignación (nota y revisión) con la copia; Ana sigue con la compartida.
    const deJuan = (await app.inject({ method: 'GET', url: `/members/${juan}/routine`, headers: { cookie: coach.cookie } })).json().assignment;
    expect(deJuan.routine.id).toBe(copia);
    expect(deJuan.routine.personalFor).toMatchObject({ memberId: juan });
    expect(deJuan.routine.personalFor.name).toBeTruthy();
    expect(deJuan.notes).toBe('Nota');
    expect(deJuan.reviewOn).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: `/routines/${r.id}`, headers: { cookie: coach.cookie } })).json().activeMembers).toBe(1);

    // No sale en el catálogo, y no se le asigna a otro socio.
    const lista = (await app.inject({ method: 'GET', url: '/routines', headers: { cookie: coach.cookie } })).json().routines as Array<{ id: string }>;
    expect(lista.some((x) => x.id === copia)).toBe(false);
    expect(lista.some((x) => x.id === r.id)).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/members/${ana}/routine`, headers: { cookie: coach.cookie }, payload: { routineId: copia } })).statusCode).toBe(404);

    // Editar la copia no cambia la de Ana.
    const cambio = await app.inject({ method: 'PUT', url: `/routines/${copia}`, headers: { cookie: coach.cookie }, payload: rutina('Solo de Juan', 2) });
    expect(cambio.statusCode, cambio.body).toBe(200);
    expect(cambio.json().personalFor).toMatchObject({ memberId: juan });
    const deAna = (await app.inject({ method: 'GET', url: `/members/${ana}/routine`, headers: { cookie: coach.cookie } })).json().assignment;
    expect(deAna.routine.id).toBe(r.id);
    expect(deAna.routine.days).toHaveLength(3);

    // Otro coach abre la copia por enlace: no lee de quién es.
    const ajeno = await coachNuevo();
    const vistaAjena = await app.inject({ method: 'GET', url: `/routines/${copia}`, headers: { cookie: ajeno.cookie } });
    expect(vistaAjena.statusCode).toBe(200);
    expect(vistaAjena.json().personalFor).toEqual({ memberId: juan, name: null });
  });

  it('el socio ve «Hoy toca», marca el día hecho, lo deshace y mañana le toca el siguiente (12-02)', async () => {
    const coach = await coachNuevo();
    const m = await socio(coach.id);
    const r = await crear(coach.cookie, 'Tres días');
    await app.inject({ method: 'POST', url: `/members/${m}/routine`, headers: { cookie: coach.cookie }, payload: { routineId: r.id, reviewWeeks: 4 } });
    const portal = await portalDe(m);
    const ver = async () => (await app.inject({ method: 'GET', url: '/portal/routine', headers: { cookie: portal } })).json();

    const antes = await ver();
    expect(antes.coach).toBeTruthy();
    expect(antes.reviewDue).toBe(false);
    expect(antes.progress).toMatchObject({ nextDay: 1, doneToday: null, doneThisWeek: [], lastDone: null });

    expect((await app.inject({ method: 'POST', url: '/portal/routine/done', headers: { cookie: portal }, payload: { dayIndex: 4 } })).statusCode).toBe(422);
    const hecho = await app.inject({ method: 'POST', url: '/portal/routine/done', headers: { cookie: portal }, payload: { dayIndex: 1 } });
    expect(hecho.statusCode, hecho.body).toBe(201);
    expect(hecho.json().progress).toMatchObject({ nextDay: 1, doneToday: 1, doneThisWeek: [1] });
    // Marcar dos veces no duplica.
    await app.inject({ method: 'POST', url: '/portal/routine/done', headers: { cookie: portal }, payload: { dayIndex: 1 } });
    expect(await getDb().workoutLog.count({ where: { memberId: m } })).toBe(1);

    const deshecho = await app.inject({ method: 'POST', url: '/portal/routine/undo', headers: { cookie: portal }, payload: {} });
    expect(deshecho.statusCode, deshecho.body).toBe(200);
    expect(deshecho.json().progress).toMatchObject({ nextDay: 1, doneToday: null, lastDone: null });

    // Lo que marcó AYER: hoy toca el siguiente. Y tras el último día, vuelve al primero.
    const a = await getDb().workoutAssignment.findFirstOrThrow({ where: { memberId: m, endedAt: null }, select: { id: true } });
    const hoy = antes.progress.today as string;
    const anotar = (dayIndex: number, haceDias: number) => getDb().workoutLog.create({
      data: { id: crypto.randomUUID(), organizationId: orgId, memberId: m, assignmentId: a.id, dayIndex, doneOn: new Date(`${masDias(hoy, -haceDias)}T00:00:00.000Z`) },
    });
    await anotar(1, 2);
    expect((await ver()).progress).toMatchObject({ nextDay: 2, doneToday: null, lastDone: { day: 1, on: masDias(hoy, -2) } });
    await anotar(3, 1);
    expect((await ver()).progress).toMatchObject({ nextDay: 1, doneToday: null });

    // El coach lo ve en la ficha.
    const ficha = (await app.inject({ method: 'GET', url: `/members/${m}/routine`, headers: { cookie: coach.cookie } })).json().assignment;
    expect(ficha.progress.lastDone).toEqual({ day: 3, on: masDias(hoy, -1) });

    // Sin rutina no hay qué marcar.
    await app.inject({ method: 'POST', url: `/members/${m}/routine/end`, headers: { cookie: coach.cookie }, payload: {} });
    expect((await app.inject({ method: 'POST', url: '/portal/routine/done', headers: { cookie: portal }, payload: { dayIndex: 1 } })).statusCode).toBe(404);
  });

  it('«Tu coach» en el portal es el de la ficha, aunque la rutina la haya asignado otra persona (12-12)', async () => {
    const coach = await coachNuevo();
    const m = await socio(coach.id);
    const r = await crear(gerencia, 'Asignada por gerencia');
    await app.inject({ method: 'POST', url: `/members/${m}/routine`, headers: { cookie: gerencia }, payload: { routineId: r.id } });
    const portal = await portalDe(m);
    const nombre = (await getDb().user.findFirstOrThrow({ where: { id: coach.id }, select: { fullName: true } })).fullName;
    expect((await app.inject({ method: 'GET', url: '/portal/routine', headers: { cookie: portal } })).json().coach).toBe(nombre);
  });

  it('el inicio del coach: solo sus socios, quién no tiene rutina, quién no viene y a quién toca revisar (12-04)', async () => {
    const coach = await coachNuevo();
    const otro = await coachNuevo();
    const [sinRutina, conRutina, porRevisar] = [await socio(coach.id), await socio(coach.id), await socio(coach.id)];
    await socio(otro.id);
    const r = await crear(coach.cookie, 'Del inicio');
    for (const m of [conRutina, porRevisar]) await app.inject({ method: 'POST', url: `/members/${m}/routine`, headers: { cookie: coach.cookie }, payload: { routineId: r.id, reviewWeeks: 4 } });
    // A uno ya le tocaba revisión ayer; otro se inscribió hace un mes y no ha entrado nunca.
    const hoy = (await app.inject({ method: 'GET', url: '/coach/today', headers: { cookie: coach.cookie } })).json().today as string;
    await getDb().workoutAssignment.updateMany({ where: { memberId: porRevisar, endedAt: null }, data: { reviewOn: new Date(`${masDias(hoy, -1)}T00:00:00.000Z`) } });
    await getDb().member.update({ where: { id: sinRutina }, data: { createdAt: new Date(Date.now() - 30 * 86_400_000) } });

    const v = await app.inject({ method: 'GET', url: '/coach/today', headers: { cookie: coach.cookie } });
    expect(v.statusCode, v.body).toBe(200);
    const d = v.json();
    expect(d.members.total).toBe(3);
    expect(d.members.withoutRoutine.map((x: { id: string }) => x.id)).toEqual([sinRutina]);
    expect(d.members.toReview.map((x: { id: string }) => x.id)).toEqual([porRevisar]);
    // Recién inscritos sin entrar no son «dejó de venir»; el de hace un mes sí.
    expect(d.members.away.map((x: { id: string }) => x.id)).toEqual([sinRutina]);
    expect(d.routines.map((x: { id: string }) => x.id)).toEqual([r.id]);
    // Nada de contacto ni de afluencia (D-30, 1-05).
    expect(v.body).not.toMatch(/phone|email|entries/i);
    // El de otro coach trae lo suyo, no esto.
    const delOtro = (await app.inject({ method: 'GET', url: '/coach/today', headers: { cookie: otro.cookie } })).json();
    expect(delOtro.members.total).toBe(1);
    expect(delOtro.routines).toHaveLength(0);
  });

  it('dar de baja a un coach con socios pregunta a quién pasan; sin respuesta no hay baja (12-07)', async () => {
    const [sale, recibe] = [await coachNuevo(), await coachNuevo()];
    const [a, b] = [await socio(sale.id), await socio(sale.id)];
    expect((await app.inject({ method: 'GET', url: `/coaches/${sale.id}/members`, headers: { cookie: gerencia } })).json()).toEqual({ count: 2 });
    expect((await app.inject({ method: 'GET', url: `/coaches/${sale.id}/members`, headers: { cookie: recepcion } })).statusCode).toBe(403);

    const baja = (extra: Record<string, unknown>) => app.inject({
      method: 'PATCH', url: `/users/${sale.id}`, headers: { cookie: gerencia }, payload: { isActive: false, reason: 'Fin de contrato', ...extra },
    });
    const sinDecir = await baja({});
    expect(sinDecir.statusCode, sinDecir.body).toBe(409);
    expect(sinDecir.json().reason).toBe('COACH_HAS_MEMBERS');
    expect((await getDb().user.findFirstOrThrow({ where: { id: sale.id }, select: { isActive: true } })).isActive).toBe(true);
    // A sí mismo, o a alguien que no es coach, no.
    expect((await baja({ coachHandover: { toUserId: sale.id } })).statusCode).toBe(422);
    const gerenteId = (await getDb().user.findFirstOrThrow({ where: { email: 'gerencia@demo.mx' }, select: { id: true } })).id;
    expect((await baja({ coachHandover: { toUserId: gerenteId } })).statusCode).toBe(422);
    expect(await getDb().member.count({ where: { coachUserId: sale.id } })).toBe(2);

    const bien = await baja({ coachHandover: { toUserId: recibe.id } });
    expect(bien.statusCode, bien.body).toBe(200);
    expect(bien.json().isActive).toBe(false);
    const fichas = await getDb().member.findMany({ where: { id: { in: [a, b] } }, select: { coachUserId: true } });
    expect(fichas.every((f) => f.coachUserId === recibe.id)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/coach/today', headers: { cookie: recibe.cookie } })).json().members.total).toBe(2);
    // Queda en la bitácora con cuántos.
    const asiento = await getDb().auditLog.findFirst({ where: { organizationId: orgId, action: 'member.coach.handover', resourceId: sale.id } });
    expect(asiento).toBeTruthy();
  });

  it('«Sin coach» también es una respuesta, y un coach sin socios se da de baja sin preguntar', async () => {
    const sale = await coachNuevo();
    const m = await socio(sale.id);
    const r = await app.inject({ method: 'PATCH', url: `/users/${sale.id}`, headers: { cookie: gerencia }, payload: { isActive: false, reason: 'Renuncia', coachHandover: { toUserId: null } } });
    expect(r.statusCode, r.body).toBe(200);
    expect((await getDb().member.findFirstOrThrow({ where: { id: m }, select: { coachUserId: true } })).coachUserId).toBeNull();
    const libre = await coachNuevo();
    const r2 = await app.inject({ method: 'PATCH', url: `/users/${libre.id}`, headers: { cookie: gerencia }, payload: { isActive: false, reason: 'Renuncia' } });
    expect(r2.statusCode, r2.body).toBe(200);
  });
});
