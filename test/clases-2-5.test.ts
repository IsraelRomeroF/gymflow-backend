import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { ClassSettings, MemberClassBookings, SessionBookings, diferenciasConElContrato } from '@gymflow/core/contracts';
import { makeApp } from './helpers.js';
import { gimnasioPropio, sesionesDe, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * CLASES · BLOQUE 2.5 (auditoría 8): la lista con pago (11-03), las clases
 * del socio en su ficha (11-04), sesión única, «hasta» y pausas (11-05),
 * editar un horario sin cancelar reservas (11-06) y las reglas de reserva por
 * gimnasio (11-08).
 *
 * En un gimnasio propio: cambiar las reglas de reserva del Gimnasio Demo
 * movería las pruebas de `classes.test.ts` (plazo de cancelación, bloqueo).
 * No depende de la hora real: las sesiones se siembran relativas a «ahora» y
 * los horarios se comparan por su clave, no por el día en que corre.
 */
describe('clases · bloque 2.5', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente: string;
  let recepcion: string;
  let sede: string;
  let tipo: string;
  let planConClases: string;

  const HORA = 3_600_000;
  const DIA = 24 * HORA;

  async function sesion(opts: { enHoras?: number; capacity?: number; coachUserId?: string } = {}): Promise<string> {
    const startsAt = new Date(Date.now() + (opts.enHoras ?? 48) * HORA);
    const row = await getDb().classSchedule.create({
      data: {
        id: uuidv7(), organizationId: g.organizationId, branchId: sede, classTypeId: tipo, coachUserId: opts.coachUserId ?? null,
        occurrenceKey: `prueba:${uuidv7()}`, startsAt, endsAt: new Date(startsAt.getTime() + HORA),
        businessDate: new Date(startsAt.toISOString().slice(0, 10)), capacity: opts.capacity ?? 10,
      },
    });
    return row.id;
  }
  async function conPlan(memberId: string): Promise<void> {
    await getDb().membership.create({
      data: {
        id: uuidv7(), organizationId: g.organizationId, memberId, planId: planConClases, soldAtBranchId: sede, status: 'ACTIVE',
        startDate: new Date(), currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 90 * DIA), billingAnchorDay: 1,
      },
    });
  }
  const pedir = (cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const inscribir = (memberId: string, scheduleId: string) => pedir(gerente, 'POST', `/classes/schedules/${scheduleId}/bookings`, { memberId });

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio();
    ({ gerente, recepcion } = await sesionesDe(app, g));
    sede = g.sedes[0]!.id;
    const t = await pedir(gerente, 'POST', '/classes/types', { name: 'Spinning', defaultCapacity: 12, dropInPriceCents: '15000' });
    expect(t.statusCode, t.body).toBe(201);
    tipo = t.json().id;
    planConClases = uuidv7();
    await getDb().plan.create({
      data: {
        id: planConClases, organizationId: g.organizationId, code: 'CONCLASES', name: 'Con clases', billingModel: 'RECURRING',
        durationUnit: 'MONTH', durationValue: 1, priceCents: 90_000n, includesClasses: true,
      },
    });
  });

  afterAll(async () => {
    await g.cerrar();
    await app.close();
    await closeDb();
  });

  // ── 11-03 · La lista sabe quién debe la clase ─────────────────────────────

  it('la lista de la sesión dice quién va incluido, quién ya pagó y quién debe, y cuánto', async () => {
    const s = await sesion();
    const incluido = await socioPropio(g);
    await conPlan(incluido);
    const suelto = await socioPropio(g);
    expect((await inscribir(incluido, s)).statusCode).toBe(201);
    const r = await inscribir(suelto, s);
    expect(r.statusCode, r.body).toBe(201);
    const chargeId = r.json().chargeId as string;
    expect(chargeId).toBeTruthy();

    const lista = await pedir(recepcion, 'GET', `/classes/schedules/${s}/bookings`);
    expect(lista.statusCode, lista.body).toBe(200);
    expect(diferenciasConElContrato(SessionBookings, lista.json())).toEqual([]);
    const filas = lista.json() as SessionBookings;
    expect(filas.pendingCount).toBe(1);
    expect(filas.bookings.find((b) => b.memberId === incluido)).toMatchObject({ payment: 'INCLUDED', chargeId: null, pendingCents: '0', pendingLabel: null, source: 'FRONT_DESK' });
    expect(filas.bookings.find((b) => b.memberId === suelto)).toMatchObject({ payment: 'PENDING', chargeId, pendingCents: '15000' });
    expect(filas.bookings.find((b) => b.memberId === suelto)!.pendingLabel).toContain('150');

    // Cobrada (por transferencia: no necesita caja abierta), la lista lo sabe.
    const cobro = await pedir(recepcion, 'POST', `/members/${suelto}/payments`, {
      method: 'SPEI_TRANSFER', amountCents: '15000', branchId: sede, targetChargeIds: [chargeId], externalRef: 'RASTREO-25', idempotencyKey: `clase-${uuidv7()}`,
    });
    expect(cobro.statusCode, cobro.body).toBe(201);
    const despues = (await pedir(recepcion, 'GET', `/classes/schedules/${s}/bookings`)).json() as SessionBookings;
    expect(despues.pendingCount).toBe(0);
    expect(despues.bookings.find((b) => b.memberId === suelto)).toMatchObject({ payment: 'PAID', pendingCents: '0', pendingLabel: null });
  });

  it('un cargo de clase anulado por la gerencia no se sigue pidiendo en la lista', async () => {
    const s = await sesion();
    const socio = await socioPropio(g);
    const chargeId = (await inscribir(socio, s)).json().chargeId as string;
    await getDb().charge.update({ where: { id: chargeId }, data: { status: 'VOID', voidedAt: new Date(), voidReason: 'Cortesía' } });
    const lista = (await pedir(gerente, 'GET', `/classes/schedules/${s}/bookings`)).json() as SessionBookings;
    expect(lista.pendingCount).toBe(0);
    expect(lista.bookings[0]).toMatchObject({ payment: 'WAIVED', pendingCents: '0' });
  });

  // ── 11-04 · Las clases del socio, para su ficha ───────────────────────────

  it('la ficha recibe lo que viene y lo reciente del socio, con su pago y su bloqueo', async () => {
    const socio = await socioPropio(g);
    const proxima = await sesion({ enHoras: 30 });
    const otra = await sesion({ enHoras: 54 });
    const r1 = await inscribir(socio, proxima);
    const r2 = await inscribir(socio, otra);
    expect([r1.statusCode, r2.statusCode]).toEqual([201, 201]);

    let ficha = await pedir(recepcion, 'GET', `/members/${socio}/bookings`);
    expect(ficha.statusCode, ficha.body).toBe(200);
    expect(diferenciasConElContrato(MemberClassBookings, ficha.json())).toEqual([]);
    let datos = ficha.json() as MemberClassBookings;
    // Lo que viene, lo más cercano primero.
    expect(datos.upcoming.map((b) => b.classScheduleId)).toEqual([proxima, otra]);
    expect(datos.upcoming[0]).toMatchObject({ className: 'Spinning', status: 'BOOKED', payment: 'PENDING', pendingCents: '15000', branchId: sede });
    expect(datos.block).toBeNull();
    expect(datos.noShows).toEqual({ count: 0, windowDays: 30, blockAt: 3 });

    // Quitada desde el mostrador: pasa a lo reciente, cancelada y sin cargo que cobrar.
    const quitar = await pedir(recepcion, 'POST', `/classes/bookings/${r1.json().id}/cancel`, {});
    expect(quitar.statusCode, quitar.body).toBe(200);
    await getDb().classBookingBlock.create({
      data: { id: uuidv7(), organizationId: g.organizationId, memberId: socio, untilDate: new Date(Date.now() + 5 * DIA), noShowCount: 3, reason: '3 faltas en 30 días' },
    });
    ficha = await pedir(recepcion, 'GET', `/members/${socio}/bookings`);
    datos = ficha.json() as MemberClassBookings;
    expect(datos.upcoming.map((b) => b.classScheduleId)).toEqual([otra]);
    expect(datos.recent[0]).toMatchObject({ classScheduleId: proxima, status: 'CANCELED', payment: 'WAIVED' });
    expect(datos.block).toMatchObject({ noShowCount: 3 });

    // Bloqueado, el mostrador sabe HASTA CUÁNDO (11-08), no solo «bloqueadas por faltas».
    const tercera = await sesion({ enHoras: 60 });
    const cotizacion = await pedir(recepcion, 'GET', `/classes/schedules/${tercera}/quote?memberId=${socio}`);
    expect(cotizacion.json()).toMatchObject({ canBook: false });
    expect(cotizacion.json().reason).toMatch(/bloqueadas por faltas hasta el \d+ de /);
  });

  it('las clases de un socio de otro gimnasio no existen', async () => {
    const otro = await gimnasioPropio();
    try {
      const ajeno = await socioPropio(otro);
      expect((await pedir(gerente, 'GET', `/members/${ajeno}/bookings`)).statusCode).toBe(404);
    } finally { await otro.cerrar(); }
  });

  // ── `?mine=1` para «Mis clases» del coach (lo usa el bloque 2.6) ───────────

  it('`mine=1` deja solo las sesiones que imparte quien pregunta', async () => {
    const yo = await getDb().user.findFirstOrThrow({ where: { organizationId: g.organizationId, email: g.correos.gerente } });
    const mia = await sesion({ enHoras: 20, coachUserId: yo.id });
    const ajena = await sesion({ enHoras: 21 });
    const rango = `from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 2 * DIA).toISOString())}`;
    const todas = (await pedir(gerente, 'GET', `/classes/schedules?branchId=${sede}&${rango}`)).json().schedules as Array<{ id: string }>;
    expect(todas.map((x) => x.id)).toEqual(expect.arrayContaining([mia, ajena]));
    const mias = (await pedir(gerente, 'GET', `/classes/schedules?branchId=${sede}&mine=1&${rango}`)).json().schedules as Array<{ id: string }>;
    expect(mias.map((x) => x.id)).toContain(mia);
    expect(mias.map((x) => x.id)).not.toContain(ajena);
  });

  // ── 11-05 · Sesión única ──────────────────────────────────────────────────

  it('una sesión única se programa con la hora de la sucursal y se reserva como cualquiera', async () => {
    // A dos días: dentro de la antelación de reserva y fuera de los días que pausa otra prueba.
    const en5 = new Date(Date.now() + 2 * DIA).toISOString().slice(0, 10);
    const r = await pedir(gerente, 'POST', '/classes/schedules', { branchId: sede, classTypeId: tipo, date: en5, startMinute: 18 * 60 + 30, durationMin: 90, capacity: 8, room: 'Salón 2' });
    expect(r.statusCode, r.body).toBe(201);
    const fila = await getDb().classSchedule.findUniqueOrThrow({ where: { id: r.json().id } });
    expect(fila.templateId).toBeNull();
    expect(fila.businessDate.toISOString().slice(0, 10)).toBe(en5);
    // 18:30 en la Ciudad de México (UTC−6) son las 00:30 UTC del día siguiente.
    expect(fila.startsAt.toISOString().slice(11, 16)).toBe('00:30');
    expect(fila.endsAt.getTime() - fila.startsAt.getTime()).toBe(90 * 60_000);
    const socio = await socioPropio(g);
    expect((await inscribir(socio, fila.id)).statusCode).toBe(201);

    // Una fecha que ya pasó se dice; recepción no arma sesiones.
    const ayer = new Date(Date.now() - 2 * DIA).toISOString().slice(0, 10);
    const pasada = await pedir(gerente, 'POST', '/classes/schedules', { branchId: sede, classTypeId: tipo, date: ayer, startMinute: 600, durationMin: 60, capacity: 8 });
    expect(pasada.statusCode).toBe(422);
    expect(pasada.json().message).toContain('ya pasaron');
    expect((await pedir(recepcion, 'POST', '/classes/schedules', { branchId: sede, classTypeId: tipo, date: en5, startMinute: 600, durationMin: 60, capacity: 8 })).statusCode).toBe(403);
  });

  // ── 11-06 · Editar un horario sin cancelar reservas ───────────────────────

  it('cambiar la hora de un horario rehace las sesiones vacías y deja en su lugar las que tienen reservas', async () => {
    const hoy = new Date().toISOString().slice(0, 10);
    const todosLosDias = (startMinute: number, capacity = 10) => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute, durationMin: 60, capacity }));
    const alta = await pedir(gerente, 'POST', '/classes/templates', { branchId: sede, classTypeId: tipo, effectiveFrom: hoy, slots: todosLosDias(7 * 60) });
    expect(alta.statusCode, alta.body).toBe(201);
    const plantilla = alta.json().id as string;
    const db = getDb();
    const futuras = () => db.classSchedule.findMany({ where: { templateId: plantilla, status: 'SCHEDULED', startsAt: { gt: new Date() } }, orderBy: { startsAt: 'asc' } });

    const antes = await futuras();
    expect(antes.length).toBeGreaterThanOrEqual(19);
    // Alguien ya tiene lugar en la cuarta sesión (dentro de la antelación de 7 días).
    const conReserva = antes[3]!;
    const socio = await socioPropio(g);
    await conPlan(socio);
    const reserva = await inscribir(socio, conReserva.id);
    expect(reserva.statusCode, reserva.body).toBe(201);

    // Solo cupo: las sesiones son las mismas, con el cupo nuevo. Nadie pierde nada.
    const cupo = await pedir(gerente, 'PATCH', `/classes/templates/${plantilla}`, { slots: todosLosDias(7 * 60, 14) });
    expect(cupo.statusCode, cupo.body).toBe(200);
    expect(cupo.json()).toMatchObject({ ok: true, removed: 0, generated: 0, kept: [] });
    expect(cupo.json().updated).toBe(antes.length);
    expect((await futuras()).map((x) => x.id)).toEqual(antes.map((x) => x.id));
    expect((await futuras()).every((x) => x.capacity === 14)).toBe(true);

    // De 7:00 a 7:30: las vacías se rehacen a la hora nueva; la que tiene reserva se queda y se dice.
    const mover = await pedir(gerente, 'PATCH', `/classes/templates/${plantilla}`, { slots: todosLosDias(7 * 60 + 30, 14), room: 'Salón 1' });
    expect(mover.statusCode, mover.body).toBe(200);
    const r = mover.json();
    expect(r.kept).toEqual([{ scheduleId: conReserva.id, startsAt: conReserva.startsAt.toISOString(), bookedCount: 1 }]);
    expect(r.removed).toBe(antes.length - 1);
    expect(r.generated).toBeGreaterThanOrEqual(antes.length - 1);
    const despues = await futuras();
    const nuevas = despues.filter((x) => x.id !== conReserva.id);
    expect(nuevas.every((x) => x.occurrenceKey.endsWith(`:${7 * 60 + 30}`) && x.room === 'Salón 1')).toBe(true);
    // La reserva sigue viva, a su hora de siempre.
    expect((await db.classBooking.findUniqueOrThrow({ where: { id: reserva.json().id } })).status).toBe('BOOKED');
    expect(despues.find((x) => x.id === conReserva.id)!.startsAt.toISOString()).toBe(conReserva.startsAt.toISOString());
    // Las que se quitaron no dejan rastro de «canceladas»: nadie las había reservado.
    expect(await db.classSchedule.count({ where: { templateId: plantilla, status: 'CANCELED' } })).toBe(0);

    // «Hasta»: el horario deja de generar después de ese día y lo que sobraba (vacío) se quita.
    const hasta = new Date(Date.now() + 9 * DIA).toISOString().slice(0, 10);
    const fin = await pedir(gerente, 'PATCH', `/classes/templates/${plantilla}`, { until: hasta });
    expect(fin.statusCode, fin.body).toBe(200);
    expect(fin.json().removed).toBeGreaterThan(0);
    expect((await futuras()).every((x) => x.businessDate.toISOString().slice(0, 10) <= hasta)).toBe(true);
    const listado = (await pedir(gerente, 'GET', `/classes/templates?branchId=${sede}`)).json().templates as Array<{ id: string; until: string | null }>;
    expect(listado.find((x) => x.id === plantilla)!.until).toBe(hasta);
    // Y generar otra vez no las trae de vuelta.
    await pedir(gerente, 'POST', '/classes/schedules/generate', { days: 21 });
    expect((await futuras()).every((x) => x.businessDate.toISOString().slice(0, 10) <= hasta)).toBe(true);

    // Un «hasta» que ya pasó no es editar: es quitar el horario.
    const ayer = new Date(Date.now() - 2 * DIA).toISOString().slice(0, 10);
    expect((await pedir(gerente, 'PATCH', `/classes/templates/${plantilla}`, { until: ayer })).statusCode).toBe(422);
    // Dos bloques el mismo día a la misma hora no son un horario.
    expect((await pedir(gerente, 'PATCH', `/classes/templates/${plantilla}`, { slots: [{ weekday: 1, startMinute: 600, durationMin: 60, capacity: 5 }, { weekday: 1, startMinute: 600, durationMin: 45, capacity: 5 }] })).statusCode).toBe(422);
    expect((await pedir(recepcion, 'PATCH', `/classes/templates/${plantilla}`, { room: 'Otro' })).statusCode).toBe(403);

    await pedir(gerente, 'POST', `/classes/templates/${plantilla}/retire`, { reason: 'Termina la prueba' });
  });

  // ── 11-05 · Pausas por fechas ─────────────────────────────────────────────

  it('una pausa cancela las sesiones de esos días con un motivo, no deja generar otras y al quitarla vuelven', async () => {
    const db = getDb();
    const hoy = new Date().toISOString().slice(0, 10);
    const alta = await pedir(gerente, 'POST', '/classes/templates', {
      branchId: sede, classTypeId: tipo, effectiveFrom: hoy, slots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 20 * 60, durationMin: 60, capacity: 10 })),
    });
    const plantilla = alta.json().id as string;
    const dia = (n: number) => new Date(Date.now() + n * DIA).toISOString().slice(0, 10);
    const enPausa = () => db.classSchedule.findMany({ where: { templateId: plantilla, businessDate: { gte: new Date(dia(4)), lte: new Date(dia(6)) } } });
    const tres = await enPausa();
    expect(tres).toHaveLength(3);

    // Alguien tenía lugar (clase suelta sin pagar) en uno de esos días.
    const socio = await socioPropio(g);
    const reserva = await inscribir(socio, tres[0]!.id);
    expect(reserva.statusCode, reserva.body).toBe(201);

    const pausa = await pedir(gerente, 'POST', '/classes/pauses', { branchId: sede, fromDate: dia(4), toDate: dia(6), reason: 'Mantenimiento del salón' });
    expect(pausa.statusCode, pausa.body).toBe(201);
    expect(pausa.json()).toMatchObject({ canceledClasses: 3, canceledBookings: 1, pause: { fromDate: dia(4), toDate: dia(6), branchId: sede } });
    const pausaId = pausa.json().pause.id as string;
    expect((await enPausa()).every((x) => x.status === 'CANCELED' && x.cancelReason === 'Pausa del horario: Mantenimiento del salón' && x.pauseId === pausaId)).toBe(true);
    // Quien tenía lugar lo pierde sin falta, y su cargo sin pagar se anula.
    expect(await db.classBooking.findUniqueOrThrow({ where: { id: reserva.json().id } })).toMatchObject({ status: 'CANCELED', lateCancel: false });
    expect((await db.charge.findUniqueOrThrow({ where: { id: reserva.json().chargeId } })).status).toBe('VOID');

    // Mientras viva, no se generan sesiones en esas fechas; fuera de ellas, sí.
    await db.classSchedule.deleteMany({ where: { id: tres[2]!.id } });
    await db.classSchedule.deleteMany({ where: { templateId: plantilla, businessDate: new Date(dia(8)), bookedCount: 0 } });
    const generar = await pedir(gerente, 'POST', '/classes/schedules/generate', { days: 21 });
    expect(generar.json().created).toBe(1);
    expect(await enPausa()).toHaveLength(2);

    const vivas = await pedir(recepcion, 'GET', `/classes/pauses?branchId=${sede}`);
    expect(vivas.statusCode, vivas.body).toBe(200);
    expect(vivas.json().pauses.map((p: { id: string }) => p.id)).toContain(pausaId);

    // Recepción no pausa ni quita pausas.
    expect((await pedir(recepcion, 'POST', '/classes/pauses', { branchId: sede, fromDate: dia(10), toDate: dia(11), reason: 'No me toca' })).statusCode).toBe(403);
    expect((await pedir(recepcion, 'POST', '/classes/pauses/end', { pauseId: pausaId })).statusCode).toBe(403);

    // Quitarla: vuelven las dos que había cancelado (vacías) y se genera la que faltaba.
    const fin = await pedir(gerente, 'POST', '/classes/pauses/end', { pauseId: pausaId });
    expect(fin.statusCode, fin.body).toBe(200);
    expect(fin.json()).toMatchObject({ ok: true, restored: 2, generated: 1 });
    const devueltas = await enPausa();
    expect(devueltas).toHaveLength(3);
    expect(devueltas.every((x) => x.status === 'SCHEDULED' && x.canceledAt === null && x.pauseId === null && x.bookedCount === 0)).toBe(true);
    expect((await pedir(gerente, 'POST', '/classes/pauses/end', { pauseId: pausaId })).statusCode).toBe(404);
    expect((await pedir(gerente, 'GET', `/classes/pauses?branchId=${sede}`)).json().pauses.map((p: { id: string }) => p.id)).not.toContain(pausaId);

    // Fechas al revés, o ya pasadas, no son una pausa.
    expect((await pedir(gerente, 'POST', '/classes/pauses', { branchId: sede, fromDate: dia(5), toDate: dia(3), reason: 'Al revés' })).statusCode).toBe(422);
    expect((await pedir(gerente, 'POST', '/classes/pauses', { branchId: sede, fromDate: dia(-9), toDate: dia(-7), reason: 'Ya pasó' })).statusCode).toBe(422);

    await pedir(gerente, 'POST', `/classes/templates/${plantilla}/retire`, { reason: 'Termina la prueba' });
  });

  // ── 11-08 · Reglas de reserva del gimnasio ────────────────────────────────

  it('las reglas nacen con los valores de fábrica, las cambia quien arma las clases y maneja precios, y valen desde que se guardan', async () => {
    const inicial = await pedir(recepcion, 'GET', '/classes/settings');
    expect(inicial.statusCode, inicial.body).toBe(200);
    expect(diferenciasConElContrato(ClassSettings, inicial.json())).toEqual([]);
    const fabrica = { maxDaysAhead: 7, cancelCutoffMinutes: 120, noShowWindowDays: 30, noShowsBeforeBlock: 3, blockDays: 7 };
    expect(inicial.json()).toMatchObject({ isDefault: true, rules: fabrica, defaults: fabrica, updatedAt: null });

    // Con las de fábrica: a 3 días se reserva, y cancelar a 90 minutos ya es tarde.
    const lejos = await sesion({ enHoras: 72 });
    const cerca = await sesion({ enHoras: 1.5 });
    const socio = await socioPropio(g);
    await conPlan(socio);
    expect((await pedir(recepcion, 'GET', `/classes/schedules/${lejos}/quote?memberId=${socio}`)).json().canBook).toBe(true);

    // Recepción las lee, no las cambia; fuera de rango no se guarda nada.
    const nuevas = { maxDaysAhead: 2, cancelCutoffMinutes: 60, noShowWindowDays: 30, noShowsBeforeBlock: 2, blockDays: 10 };
    expect((await pedir(recepcion, 'PUT', '/classes/settings', nuevas)).statusCode).toBe(403);
    expect((await pedir(gerente, 'PUT', '/classes/settings', { ...nuevas, maxDaysAhead: 45 })).statusCode).toBe(422);
    expect((await pedir(gerente, 'PUT', '/classes/settings', { ...nuevas, noShowsBeforeBlock: 0 })).statusCode).toBe(422);
    expect((await pedir(gerente, 'GET', '/classes/settings')).json().isDefault).toBe(true);

    const guardar = await pedir(gerente, 'PUT', '/classes/settings', nuevas);
    expect(guardar.statusCode, guardar.body).toBe(200);
    expect(guardar.json()).toMatchObject({ isDefault: false, rules: nuevas, defaults: fabrica });
    expect(guardar.json().updatedByName).toBeTruthy();
    const asiento = await getDb().auditLog.findFirst({ where: { organizationId: g.organizationId, action: 'class.settings.update' }, orderBy: { at: 'desc' } });
    expect(asiento?.afterState).toMatchObject({ maxDaysAhead: 2, cancelCutoffMinutes: 60 });

    // Antelación de 2 días: la de dentro de 3 ya no se reserva todavía.
    const cot = (await pedir(recepcion, 'GET', `/classes/schedules/${lejos}/quote?memberId=${socio}`)).json();
    expect(cot).toMatchObject({ canBook: false, reason: 'Todavía no se abren las reservas de esa clase' });
    // Plazo de 60 minutos: cancelar a 90 minutos está a tiempo (antes era tarde).
    const reserva = await inscribir(socio, cerca);
    expect(reserva.statusCode, reserva.body).toBe(201);
    const portal = await getDb().classBooking.findUniqueOrThrow({ where: { id: reserva.json().id } });
    const { ClassService } = await import('../src/modules/classes/class.service.js');
    const r = await new ClassService().cancel(g.organizationId, { bookingId: portal.id, byMember: true });
    expect(r.late).toBe(false);

    // Dos faltas bloquean diez días (las reglas nuevas), no tres por siete.
    const faltista = await socioPropio(g);
    await conPlan(faltista);
    for (let i = 0; i < 2; i++) {
      const pasada = await sesion({ enHoras: -3 - i });
      await getDb().classBooking.create({ data: { id: uuidv7(), organizationId: g.organizationId, branchId: sede, classScheduleId: pasada, memberId: faltista, status: 'BOOKED' } });
    }
    await new ClassService().closeFinished(g.organizationId);
    const bloqueo = await getDb().classBookingBlock.findFirst({ where: { memberId: faltista } });
    expect(bloqueo).toMatchObject({ noShowCount: 2 });
    const dias = Math.round((bloqueo!.untilDate.getTime() - Date.now()) / DIA);
    expect(dias).toBe(10);
    const ficha = (await pedir(recepcion, 'GET', `/members/${faltista}/bookings`)).json() as MemberClassBookings;
    expect(ficha.noShows).toEqual({ count: 2, windowDays: 30, blockAt: 2 });
    expect(ficha.block?.noShowCount).toBe(2);

    // Otro gimnasio sigue con las de fábrica.
    const otro = await gimnasioPropio();
    try {
      const s = await sesionesDe(app, otro);
      expect((await pedir(s.gerente, 'GET', '/classes/settings')).json()).toMatchObject({ isDefault: true, rules: fabrica });
    } finally { await otro.cerrar(); }
  });
});
