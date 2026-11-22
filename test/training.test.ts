import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, asignarAlCoach, cuentaDePrueba } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * RUTINAS: el coach arma con el catálogo, asigna, y el socio la ve en su
 * teléfono. Recepción no las crea.
 */
describe('rutinas', () => {
  let app: FastifyInstance;
  let owner: string;
  let coach: string;
  let recepcion: string;
  let cen: string;
  type Ej = { id: string; muscleGroup: string; custom: boolean; name: string };
  let catalogo: Ej[];

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    coach = await loginAs(app, 'coach@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    cen = (await orgFixtures()).demoBranches.find((b) => b.code === 'CEN')!.id;
    catalogo = (await app.inject({ method: 'GET', url: '/exercises', headers: { cookie: coach } })).json().exercises;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  async function socio(): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: owner },
      payload: {
        firstName: nombreUnico('Rutina'), lastName: nombreUnico('Socio'), phoneE164: telefonoUnico(), homeBranchId: cen, force: true,
        consents: [
          { consentType: 'PRIVACY_NOTICE', documentVersion: 'v1.0', granted: true },
          { consentType: 'HOUSE_RULES', documentVersion: 'v1.0', granted: true },
        ],
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id;
  }

  const de = (g: string) => catalogo.filter((e) => e.muscleGroup === g && !e.custom);
  const rutina = (nombre = `Rutina ${Date.now()}`) => ({
    name: nombre, goal: 'HIPERTROFIA', level: 'PRINCIPIANTE',
    days: [
      { name: 'Pecho y tríceps', items: [
        { exerciseId: de('CHEST')[0]!.id, sets: 4, reps: '8-10', restSeconds: 90 },
        { exerciseId: de('TRICEPS')[1]!.id, sets: 3, reps: '12', restSeconds: 60, notes: 'Controla la bajada' },
      ] },
      { name: 'Pierna', items: [{ exerciseId: de('LEGS')[0]!.id, sets: 5, reps: '5', restSeconds: 120 }] },
    ],
  });

  it('el catálogo trae diez ejercicios precargados por cada bloque muscular', () => {
    const grupos = ['CHEST', 'BACK', 'SHOULDERS', 'BICEPS', 'TRICEPS', 'LEGS', 'GLUTES', 'ABS'];
    for (const g of grupos) expect(de(g), g).toHaveLength(10);
  });

  it('el coach arma una rutina por días y se guarda en su orden', async () => {
    const r = await app.inject({ method: 'POST', url: '/routines', headers: { cookie: coach }, payload: rutina() });
    expect(r.statusCode, r.body).toBe(201);
    const body = r.json();
    expect(body.days.map((d: { name: string }) => d.name)).toEqual(['Pecho y tríceps', 'Pierna']);
    expect(body.days[0].items[1]).toMatchObject({ sets: 3, reps: '12', notes: 'Controla la bajada' });
    expect(body.days[0].items[0].exercise.muscleGroup).toBe('CHEST');
  });

  it('editar reemplaza días y ejercicios completos', async () => {
    const creada = (await app.inject({ method: 'POST', url: '/routines', headers: { cookie: coach }, payload: rutina() })).json();
    const cambio = { ...rutina('Solo pierna'), days: [{ name: 'Pierna', items: [{ exerciseId: de('GLUTES')[0]!.id, sets: 3, reps: '15' }] }] };
    const r = await app.inject({ method: 'PUT', url: `/routines/${creada.id}`, headers: { cookie: coach }, payload: cambio });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().days).toHaveLength(1);
    expect(r.json().days[0].items).toHaveLength(1);
  });

  it('un ejercicio que no existe se rechaza', async () => {
    const mala = rutina();
    mala.days[0]!.items[0]!.exerciseId = '00000000-0000-7000-8000-000000000000';
    const r = await app.inject({ method: 'POST', url: '/routines', headers: { cookie: coach }, payload: mala });
    expect(r.statusCode).toBe(422);
  });

  it('el gimnasio agrega ejercicios propios al catálogo', async () => {
    const r = await app.inject({ method: 'POST', url: '/exercises', headers: { cookie: coach }, payload: { name: `Sentadilla en Smith ${Date.now()}`, muscleGroup: 'LEGS', equipment: 'Smith' } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().custom).toBe(true);
  });

  it('recepción NO crea rutinas', async () => {
    const r = await app.inject({ method: 'POST', url: '/routines', headers: { cookie: recepcion }, payload: rutina() });
    expect(r.statusCode).toBe(403);
  });

  it('asignada, el socio la ve en su portal; reasignar deja UNA sola activa', async () => {
    const memberId = await socio();
    await asignarAlCoach(memberId);
    const r1 = (await app.inject({ method: 'POST', url: '/routines', headers: { cookie: coach }, payload: rutina('Fuerza A') })).json();
    const r2 = (await app.inject({ method: 'POST', url: '/routines', headers: { cookie: coach }, payload: rutina('Fuerza B') })).json();

    const asignar = (routineId: string) => app.inject({ method: 'POST', url: `/members/${memberId}/routine`, headers: { cookie: coach }, payload: { routineId, notes: 'Empieza ligero' } });
    expect((await asignar(r1.id)).statusCode).toBe(201);
    expect((await asignar(r2.id)).statusCode).toBe(201);

    const invite = await app.inject({ method: 'POST', url: `/members/${memberId}/portal-invite`, headers: { cookie: owner } });
    const enroll = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code } });
    const portal = `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}`;
    const vista = (await app.inject({ method: 'GET', url: '/portal/routine', headers: { cookie: portal } })).json();
    expect(vista.routine.name).toBe('Fuerza B');
    expect(vista.coach).toBeTruthy();
    expect(vista.notes).toBe('Empieza ligero');
    expect(vista.routine.days[0].items[0].exercise.name).toBeTruthy();

    const fin = await app.inject({ method: 'POST', url: `/members/${memberId}/routine/end`, headers: { cookie: coach } });
    expect(fin.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/portal/routine', headers: { cookie: portal } })).json().routine).toBeNull();
  });

  it('quien solo asigna (sin armar el catálogo) ve las rutinas para asignar (12-20)', async () => {
    await app.inject({ method: 'POST', url: '/routines', headers: { cookie: coach }, payload: rutina('Para asignar') });
    const correo = await cuentaDePrueba((await orgFixtures()).demo.id, 'COACH', [null]);
    const id = (await getDb().user.findFirstOrThrow({ where: { email: correo }, select: { id: true } })).id;
    const ajuste = await app.inject({ method: 'PUT', url: `/users/${id}/permissions`, headers: { cookie: owner }, payload: { remove: ['training:template:manage'], reason: 'Solo asigna rutinas' } });
    expect(ajuste.statusCode, ajuste.body).toBe(200);
    const soloAsigna = await loginAs(app, correo);
    // Antes: 403 y el diálogo decía «No hay rutinas».
    const lista = await app.inject({ method: 'GET', url: '/routines', headers: { cookie: soloAsigna } });
    expect(lista.statusCode, lista.body).toBe(200);
    const una = lista.json().routines[0] as { id: string };
    expect(una).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: `/routines/${una.id}`, headers: { cookie: soloAsigna } })).statusCode).toBe(200);
    // Ver no es armar: crear y editar siguen pidiendo las plantillas.
    expect((await app.inject({ method: 'POST', url: '/routines', headers: { cookie: soloAsigna }, payload: rutina() })).statusCode).toBe(403);
    // Y quien no entrena no las ve.
    expect((await app.inject({ method: 'GET', url: '/routines', headers: { cookie: recepcion } })).statusCode).toBe(403);
  });
});
