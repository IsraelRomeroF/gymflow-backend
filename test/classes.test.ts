import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7, normalizedNameKey } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, asignarAlCoach } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * CLASES CON CUPO.
 *
 * El criterio del sprint es explícito: dos socios reservando el último lugar
 * a la vez, uno entra y el otro no, NUNCA sobreventa. Por eso hay una prueba
 * de carrera real y no solo de camino feliz — la sobreventa no aparece
 * probando de uno en uno.
 */
describe('clases', () => {
  let app: FastifyInstance;
  let cookie: string;
  let orgId: string;
  let branchId: string;
  let planConClases: string;
  let planSinClases: string;
  let classTypeId: string;

  async function crearSocio(planId: string, opts: { periodEnd?: Date } = {}): Promise<string> {
    const db = getDb();
    const nombre = nombreUnico('Socio');
    const member = await db.member.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberCode: `CLS-${uuidv7().slice(-12)}`, // único de verdad: diez altas en el mismo milisegundo chocaban con un azar de 0 a 998
        firstName: nombre, lastName: nombreUnico('Clase'), nameKey: normalizedNameKey(`${nombre} clase`),
        homeBranchId: branchId, joinedAt: new Date(),
      },
    });
    await db.membership.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberId: member.id, planId,
        soldAtBranchId: branchId, status: 'ACTIVE', startDate: new Date(),
        currentPeriodStart: new Date(),
        currentPeriodEnd: opts.periodEnd ?? new Date(Date.now() + 90 * 86_400_000),
        billingAnchorDay: 1,
      },
    });
    return member.id;
  }

  async function crearClase(opts: { capacity: number; startsInHours?: number; typeId?: string; coachUserId?: string }): Promise<string> {
    const db = getDb();
    const startsAt = new Date(Date.now() + (opts.startsInHours ?? 48) * 3_600_000);
    const row = await db.classSchedule.create({
      data: {
        id: uuidv7(), organizationId: orgId, branchId, classTypeId: opts.typeId ?? classTypeId, coachUserId: opts.coachUserId ?? null,
        occurrenceKey: `test:${uuidv7()}`,
        startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000),
        businessDate: new Date(startsAt.toISOString().slice(0, 10)),
        capacity: opts.capacity,
      },
    });
    return row.id;
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    cookie = await loginAs(app, 'gerencia@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    branchId = f.demoBranches[0]!.id;

    const db = getDb();
    const base = await db.plan.findFirstOrThrow({
      where: { organizationId: orgId, billingModel: 'RECURRING' },
    });
    const clonar = async (includesClasses: boolean) => {
      const p = await db.plan.create({
        data: {
          id: uuidv7(), organizationId: orgId,
          code: `CLS${includesClasses ? 'INC' : 'EXC'}${Date.now() % 100000}`,
          name: `Plan clases ${includesClasses ? 'incluidas' : 'aparte'}`,
          billingModel: base.billingModel, durationUnit: base.durationUnit,
          durationValue: base.durationValue, priceCents: base.priceCents,
          branchAccessScope: 'ALL_BRANCHES', includesClasses,
        },
      });
      return p.id;
    };
    planConClases = await clonar(true);
    planSinClases = await clonar(false);

    const tipo = await app.inject({
      method: 'POST', url: '/classes/types', headers: { cookie },
      payload: { name: nombreUnico('Spinning'), defaultCapacity: 20, dropInPriceCents: '15000' },
    });
    expect(tipo.statusCode).toBe(201);
    classTypeId = tipo.json().id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  // ── Horarios recurrentes ──────────────────────────────────────────────────

  it('generar el horizonte dos veces NO duplica clases', async () => {
    const plantilla = await app.inject({
      method: 'POST', url: '/classes/templates', headers: { cookie },
      payload: {
        branchId, classTypeId,
        effectiveFrom: new Date().toISOString().slice(0, 10),
        slots: [{ weekday: 1, startMinute: 7 * 60, durationMin: 60, capacity: 12 }],
      },
    });
    expect(plantilla.statusCode).toBe(201);
    // Crear el horario ya generó sus clases (primera pasada)…
    expect(plantilla.json().generated).toBeGreaterThan(0);

    const segunda = await app.inject({
      method: 'POST', url: '/classes/schedules/generate', headers: { cookie }, payload: { days: 21 },
    });
    // …y la clave de ocurrencia es derivada: la segunda pasada no crea nada.
    expect(segunda.statusCode).toBe(200);
    expect(segunda.json().created).toBe(0);
  });

  // ── Cupo ──────────────────────────────────────────────────────────────────

  it('dos socios compitiendo por el ÚLTIMO lugar: uno entra, el otro no', async () => {
    const claseId = await crearClase({ capacity: 1 });
    const a = await crearSocio(planConClases);
    const b = await crearSocio(planConClases);

    const [ra, rb] = await Promise.all([
      app.inject({
        method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
        headers: { cookie }, payload: { memberId: a },
      }),
      app.inject({
        method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
        headers: { cookie }, payload: { memberId: b },
      }),
    ]);

    const codigos = [ra.statusCode, rb.statusCode].sort();
    expect(codigos).toEqual([201, 409]);

    const clase = await getDb().classSchedule.findUniqueOrThrow({ where: { id: claseId } });
    expect(clase.bookedCount).toBe(1);
  });

  it('diez pulsaciones simultáneas sobre tres lugares dejan exactamente tres', async () => {
    const claseId = await crearClase({ capacity: 3 });
    const socios = await Promise.all(Array.from({ length: 10 }, () => crearSocio(planConClases)));

    const res = await Promise.all(socios.map((memberId) => app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId },
    })));

    // Con los códigos en el mensaje: si falla, distingue sobreventa (grave)
    // de una petición que no llegó por carga.
    expect(res.filter((r) => r.statusCode === 201), JSON.stringify(res.map((r) => r.statusCode))).toHaveLength(3);
    const clase = await getDb().classSchedule.findUniqueOrThrow({ where: { id: claseId } });
    expect(clase.bookedCount).toBe(3);
  });

  it('el mismo socio no ocupa dos lugares en la misma clase', async () => {
    const claseId = await crearClase({ capacity: 5 });
    const memberId = await crearSocio(planConClases);

    const primera = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId },
    });
    expect(primera.statusCode).toBe(201);

    const segunda = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId },
    });
    expect(segunda.statusCode).toBe(409);

    const clase = await getDb().classSchedule.findUniqueOrThrow({ where: { id: claseId } });
    expect(clase.bookedCount).toBe(1);
  });

  it('cancelar devuelve el lugar', async () => {
    const claseId = await crearClase({ capacity: 1 });
    const a = await crearSocio(planConClases);
    const b = await crearSocio(planConClases);

    const reserva = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId: a },
    });
    const llena = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId: b },
    });
    expect(llena.statusCode).toBe(409);

    await app.inject({
      method: 'POST', url: `/classes/bookings/${reserva.json().id}/cancel`,
      headers: { cookie }, payload: {},
    });

    const ahora = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId: b },
    });
    expect(ahora.statusCode).toBe(201);
  });

  it('cancelar dos veces NO devuelve dos lugares', async () => {
    const claseId = await crearClase({ capacity: 5 });
    const memberId = await crearSocio(planConClases);
    const reserva = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId },
    });

    await app.inject({
      method: 'POST', url: `/classes/bookings/${reserva.json().id}/cancel`, headers: { cookie }, payload: {},
    });
    const segunda = await app.inject({
      method: 'POST', url: `/classes/bookings/${reserva.json().id}/cancel`, headers: { cookie }, payload: {},
    });
    expect(segunda.statusCode).toBe(409);

    const clase = await getDb().classSchedule.findUniqueOrThrow({ where: { id: claseId } });
    expect(clase.bookedCount).toBe(0);
  });

  it('no se puede bajar el cupo por debajo de lo ya reservado', async () => {
    const claseId = await crearClase({ capacity: 5 });
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
        headers: { cookie }, payload: { memberId: await crearSocio(planConClases) },
      });
    }

    const recorte = await app.inject({
      method: 'PATCH', url: `/classes/schedules/${claseId}/capacity`,
      headers: { cookie }, payload: { capacity: 2 },
    });
    // Recortar y expulsar a los últimos convertiría un error de dedo en una
    // cancelación silenciosa para alguien que ya tenía lugar.
    expect(recorte.statusCode).toBe(422);

    const valido = await app.inject({
      method: 'PATCH', url: `/classes/schedules/${claseId}/capacity`,
      headers: { cookie }, payload: { capacity: 3 },
    });
    expect(valido.statusCode).toBe(200);
  });

  // ── Derecho a reservar ────────────────────────────────────────────────────

  it('una clase POSTERIOR al fin del periodo cubierto ya no va incluida: es clase suelta', async () => {
    const claseId = await crearClase({ capacity: 5, startsInHours: 96 });
    const memberId = await crearSocio(planConClases, {
      periodEnd: new Date(Date.now() + 48 * 3_600_000),
    });

    const res = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId },
    });
    // Con precio de clase suelta, ya no se niega: se toma pagando esa clase (2026-10-09).
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().chargeId).toBeTruthy();
  });

  it('un socio archivado no reserva', async () => {
    const claseId = await crearClase({ capacity: 5 });
    const memberId = await crearSocio(planConClases);
    await getDb().member.update({
      where: { id: memberId }, data: { status: 'ARCHIVED', deletedAt: new Date() },
    });

    const res = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId },
    });
    expect(res.statusCode).toBe(409);
  });

  // ── Clase suelta ──────────────────────────────────────────────────────────

  it('el plan que no incluye clases genera cargo de clase suelta', async () => {
    const claseId = await crearClase({ capacity: 5 });
    const memberId = await crearSocio(planSinClases);

    const res = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().chargeId).toBeTruthy();

    const cargo = await getDb().charge.findUniqueOrThrow({ where: { id: res.json().chargeId } });
    expect(cargo.chargeType).toBe('CLASS_SINGLE');
    expect(cargo.amountCents).toBe(15000n);
    // Socios y Caja pintan el saldo cacheado: se entera en el momento, no hasta
    // el siguiente cobro o la noche (D3 de los recorridos, 2026-11-19).
    expect((await getDb().member.findUniqueOrThrow({ where: { id: memberId }, select: { balanceCentsCached: true } })).balanceCentsCached).toBe(15000n);
  });

  it('el plan que incluye clases NO genera cargo', async () => {
    const claseId = await crearClase({ capacity: 5 });
    const res = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId: await crearSocio(planConClases) },
    });
    expect(res.json().chargeId).toBeNull();
  });

  it('cancelar EN PLAZO anula el cargo de la clase suelta', async () => {
    const claseId = await crearClase({ capacity: 5, startsInHours: 48 });
    const memberId = await crearSocio(planSinClases);
    const reserva = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId },
    });
    const chargeId = reserva.json().chargeId;

    const cancel = await app.inject({
      method: 'POST', url: `/classes/bookings/${reserva.json().id}/cancel`,
      headers: { cookie }, payload: {},
    });
    expect(cancel.json()).toMatchObject({ late: false, chargeVoided: true });

    const cargo = await getDb().charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(cargo.status).toBe('VOID');
    // Y el saldo cacheado vuelve a cero en el momento (D3).
    expect((await getDb().member.findUniqueOrThrow({ where: { id: memberId }, select: { balanceCentsCached: true } })).balanceCentsCached).toBe(0n);
  });

  it('cancelar una clase YA PAGADA no anula el cargo: el dinero no desaparece', async () => {
    const claseId = await crearClase({ capacity: 5, startsInHours: 48 });
    const memberId = await crearSocio(planSinClases);
    const reserva = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`, headers: { cookie }, payload: { memberId },
    });
    const pago = await app.inject({
      method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie },
      payload: { idempotencyKey: crypto.randomUUID(), method: 'SPEI_TRANSFER', amountCents: '15000', externalRef: 'SPEI-CLASE' },
    });
    expect(pago.statusCode, pago.body).toBe(201);

    const cancel = await app.inject({
      method: 'POST', url: `/classes/bookings/${reserva.json().id}/cancel`, headers: { cookie }, payload: {},
    });
    expect(cancel.json()).toMatchObject({ late: false, chargeVoided: false, paidChargeKept: true });
    const cargo = await getDb().charge.findUniqueOrThrow({ where: { id: reserva.json().chargeId } });
    expect(cargo.status).toBe('PAID');
  });

  it('reservar, cancelar y volver a reservar genera un cargo NUEVO: la clase no sale gratis', async () => {
    const claseId = await crearClase({ capacity: 5, startsInHours: 48 });
    const memberId = await crearSocio(planSinClases);
    const reservar = () => app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`, headers: { cookie }, payload: { memberId },
    });
    const primera = await reservar();
    await app.inject({ method: 'POST', url: `/classes/bookings/${primera.json().id}/cancel`, headers: { cookie }, payload: {} });
    const segunda = await reservar();
    expect(segunda.statusCode, segunda.body).toBe(201);
    expect(segunda.json().chargeId).not.toBe(primera.json().chargeId);
    const cargo = await getDb().charge.findUniqueOrThrow({ where: { id: segunda.json().chargeId } });
    expect(cargo.status).not.toBe('VOID');
    expect(cargo.amountCents).toBe(15000n);
  });

  it('cancelar FUERA DE PLAZO libera el lugar pero NO anula el cargo ya pagado', async () => {
    // Una hora antes: dentro de la ventana de corte de dos horas. Con menos de una hora ya no se
    // aparta sin pagar (D-16, bloque 3.5): la clase suelta se paga al apartarla.
    const claseId = await crearClase({ capacity: 5, startsInHours: 1 });
    const reserva = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId: await crearSocio(planSinClases), payment: { method: 'SPEI_TRANSFER', externalRef: `CLASE-${uuidv7().slice(-8)}` } },
    });
    expect(reserva.statusCode, reserva.body).toBe(201);

    const cancel = await app.inject({
      method: 'POST', url: `/classes/bookings/${reserva.json().id}/cancel`,
      headers: { cookie }, payload: {},
    });
    expect(cancel.json()).toMatchObject({ late: true, chargeVoided: false });

    // El lugar SÍ vuelve: castigar al gimnasio dejándolo bloqueado no protege
    // a nadie.
    const clase = await getDb().classSchedule.findUniqueOrThrow({ where: { id: claseId } });
    expect(clase.bookedCount).toBe(0);
  });

  // ── Cierre, faltas y sanción ──────────────────────────────────────────────

  it('al cerrar la clase, quien pasó check-in asiste y quien no, falta', async () => {
    const claseId = await crearClase({ capacity: 5, startsInHours: 1 });
    const presente = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId: await crearSocio(planConClases) },
    });
    const ausente = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId: await crearSocio(planConClases) },
    });

    const checkin = await app.inject({
      method: 'POST', url: `/classes/bookings/${presente.json().id}/checkin`, headers: { cookie },
    });
    expect(checkin.statusCode).toBe(200);

    const { ClassService } = await import('../src/modules/classes/class.service.js');
    // Hasta vaciar la cola: el cierre va por lotes de 200, de la clase más vieja a la
    // más nueva, y en una base con historial la de la prueba no entra al primero.
    const hasta = new Date(Date.now() + 5 * 3_600_000);
    while ((await new ClassService().closeFinished(orgId, hasta)).closed > 0) { /* siguiente lote */ }

    const db = getDb();
    expect((await db.classBooking.findUniqueOrThrow({ where: { id: presente.json().id } })).status)
      .toBe('ATTENDED');
    expect((await db.classBooking.findUniqueOrThrow({ where: { id: ausente.json().id } })).status)
      .toBe('NO_SHOW');
  });

  it('tres faltas bloquean las reservas, y el bloqueo NO es dinero', async () => {
    const memberId = await crearSocio(planConClases);
    const { ClassService } = await import('../src/modules/classes/class.service.js');

    for (let i = 0; i < 3; i++) {
      const claseId = await crearClase({ capacity: 5, startsInHours: 1 });
      await app.inject({
        method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
        headers: { cookie }, payload: { memberId },
      });
      const hasta = new Date(Date.now() + 5 * 3_600_000);
      while ((await new ClassService().closeFinished(orgId, hasta)).closed > 0) { /* siguiente lote */ }
    }

    const db = getDb();
    const bloqueo = await db.classBookingBlock.findFirst({ where: { memberId } });
    expect(bloqueo).toBeTruthy();
    expect(bloqueo!.noShowCount).toBeGreaterThanOrEqual(3);

    // ADR-025: la sanción nunca se cobra. No debe existir ningún cargo de
    // penalización para este socio.
    const penalizaciones = await db.charge.count({
      where: { memberId, chargeType: 'NO_SHOW_PENALTY' },
    });
    expect(penalizaciones).toBe(0);

    const nueva = await crearClase({ capacity: 5 });
    const res = await app.inject({
      method: 'POST', url: `/classes/schedules/${nueva}/bookings`,
      headers: { cookie }, payload: { memberId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/faltas/i);
  });

  it('cancelar la clase cancela sus reservas y no cuenta como falta de nadie', async () => {
    const claseId = await crearClase({ capacity: 5 });
    const memberId = await crearSocio(planSinClases);
    const reserva = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId },
    });

    const res = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/cancel`,
      headers: { cookie }, payload: { reason: 'El instructor se enfermó' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().canceledBookings).toBe(1);

    const db = getDb();
    const booking = await db.classBooking.findUniqueOrThrow({ where: { id: reserva.json().id } });
    expect(booking.status).toBe('CANCELED');
    expect(booking.lateCancel).toBe(false);

    // Y el cargo de la clase suelta se anula: el gimnasio no dio la clase.
    const cargo = await db.charge.findUniqueOrThrow({ where: { id: reserva.json().chargeId } });
    expect(cargo.status).toBe('VOID');
    // Y el saldo cacheado del socio vuelve a cero en el momento (D3).
    expect((await getDb().member.findUniqueOrThrow({ where: { id: memberId }, select: { balanceCentsCached: true } })).balanceCentsCached).toBe(0n);
  });

  it('cancelar una clase exige motivo', async () => {
    const claseId = await crearClase({ capacity: 5 });
    const res = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/cancel`,
      headers: { cookie }, payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  // ── Portal del socio ──────────────────────────────────────────────────────

  async function sesionDeSocio(memberId: string): Promise<string> {
    const invite = await app.inject({
      method: 'POST', url: `/members/${memberId}/portal-invite`, headers: { cookie },
    });
    const enroll = await app.inject({
      method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code },
    });
    return `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}`;
  }

  it('el socio reserva desde su teléfono y ve por qué NO puede cuando no puede', async () => {
    const claseId = await crearClase({ capacity: 1 });
    const memberId = await crearSocio(planConClases);
    const portal = await sesionDeSocio(memberId);

    const listado = await app.inject({
      method: 'GET', url: '/portal/classes', headers: { cookie: portal },
    });
    expect(listado.statusCode).toBe(200);
    const clase = listado.json().classes.find((c: { id: string }) => c.id === claseId);
    expect(clase.canBook).toBe(true);

    const reserva = await app.inject({
      method: 'POST', url: `/portal/classes/${claseId}/book`, headers: { cookie: portal },
    });
    expect(reserva.statusCode).toBe(201);

    // Ahora la ve reservada, y otro socio la ve llena CON el motivo: decirle
    // "no puedes" sin decir por qué lo manda al mostrador, que es lo contrario
    // de lo que busca este sprint.
    const mia = await app.inject({ method: 'GET', url: '/portal/classes', headers: { cookie: portal } });
    expect(mia.json().classes.find((c: { id: string }) => c.id === claseId).booked).toBe(true);

    const otro = await sesionDeSocio(await crearSocio(planConClases));
    const suya = await app.inject({ method: 'GET', url: '/portal/classes', headers: { cookie: otro } });
    const vista = suya.json().classes.find((c: { id: string }) => c.id === claseId);
    expect(vista.canBook).toBe(false);
    expect(vista.reason).toBe('CLASS_FULL');
  });

  it('un socio NO puede cancelar la reserva de otro', async () => {
    const claseId = await crearClase({ capacity: 5 });
    const duenno = await crearSocio(planConClases);
    const ajeno = await crearSocio(planConClases);

    const reserva = await app.inject({
      method: 'POST', url: `/classes/schedules/${claseId}/bookings`,
      headers: { cookie }, payload: { memberId: duenno },
    });

    const res = await app.inject({
      method: 'POST', url: `/portal/bookings/${reserva.json().id}/cancel`,
      headers: { cookie: await sesionDeSocio(ajeno) },
    });
    // 404 y no 403: confirmar que la reserva existe ya sería contar algo de
    // otra persona.
    expect(res.statusCode).toBe(404);
  });

  it('el socio en MORA puede reservar, pero se le avisa de la puerta', async () => {
    const claseId = await crearClase({ capacity: 5 });
    const memberId = await crearSocio(planConClases);
    await getDb().membership.updateMany({ where: { memberId }, data: { status: 'PAST_DUE' } });

    const portal = await sesionDeSocio(memberId);
    const listado = await app.inject({ method: 'GET', url: '/portal/classes', headers: { cookie: portal } });
    const clase = listado.json().classes.find((c: { id: string }) => c.id === claseId);

    expect(clase.canBook).toBe(true);
    // ADR-028 cierra la puerta al moroso. Dejarle reservar sin avisar produce
    // una plaza ocupada y un socio plantado en el torniquete.
    expect(clase.warnings).toContain('WILL_BE_DENIED_AT_DOOR');
  });

  // ── Administración del horario ────────────────────────────────────────────

  /** Tipo + horario de lunes a domingo a las 6:00, creados por la API. */
  async function claseConHorario() {
    const tipo = await app.inject({
      method: 'POST', url: '/classes/types', headers: { cookie },
      payload: { name: nombreUnico('Yoga'), defaultCapacity: 12, dropInPriceCents: '10000' },
    });
    expect(tipo.statusCode, tipo.body).toBe(201);
    const plantilla = await app.inject({
      method: 'POST', url: '/classes/templates', headers: { cookie },
      payload: {
        branchId, classTypeId: tipo.json().id, room: 'Salón 3',
        effectiveFrom: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
        slots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 6 * 60, durationMin: 50, capacity: 12 })),
      },
    });
    expect(plantilla.statusCode, plantilla.body).toBe(201);
    return { typeId: tipo.json().id as string, templateId: plantilla.json().id as string, generated: plantilla.json().generated as number };
  }

  const futurasDe = (templateId: string) => getDb().classSchedule.findMany({
    where: { templateId, startsAt: { gte: new Date() } }, orderBy: { startsAt: 'asc' },
  });

  it('crear un horario genera las clases EN EL MOMENTO, no hasta el job de la noche', async () => {
    const { templateId, generated } = await claseConHorario();
    expect(generated).toBeGreaterThan(0);
    expect((await futurasDe(templateId)).length).toBeGreaterThan(0);

    const lista = (await app.inject({ method: 'GET', url: `/classes/templates?branchId=${branchId}`, headers: { cookie } })).json();
    const t = lista.templates.find((x: { id: string }) => x.id === templateId);
    expect(t.slots).toHaveLength(7);
    expect(t.room).toBe('Salón 3');
  });

  it('quitar un horario cancela las clases futuras y las reservas, sin contar faltas', async () => {
    const { templateId } = await claseConHorario();
    const [primera] = await futurasDe(templateId);
    const memberId = await crearSocio(planConClases);
    const reserva = await app.inject({
      method: 'POST', url: `/classes/schedules/${primera!.id}/bookings`, headers: { cookie }, payload: { memberId },
    });
    expect(reserva.statusCode, reserva.body).toBe(201);

    const res = await app.inject({
      method: 'POST', url: `/classes/templates/${templateId}/retire`, headers: { cookie },
      payload: { reason: 'El instructor se fue' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().canceledBookings).toBe(1);
    expect(res.json().canceledClasses).toBeGreaterThan(0);

    const despues = await futurasDe(templateId);
    expect(despues.every((c) => c.status === 'CANCELED')).toBe(true);
    const b = await getDb().classBooking.findUniqueOrThrow({ where: { id: reserva.json().id } });
    expect(b.status).toBe('CANCELED');
    expect(b.lateCancel).toBe(false);

    // Y no se vuelven a generar.
    await app.inject({ method: 'POST', url: '/classes/schedules/generate', headers: { cookie }, payload: { days: 21 } });
    expect((await futurasDe(templateId)).every((c) => c.status === 'CANCELED')).toBe(true);
    const lista = (await app.inject({ method: 'GET', url: '/classes/templates', headers: { cookie } })).json();
    expect(lista.templates.map((x: { id: string }) => x.id)).not.toContain(templateId);
  });

  it('un horario creado hoy también se puede quitar hoy', async () => {
    const tipo = await app.inject({
      method: 'POST', url: '/classes/types', headers: { cookie },
      payload: { name: nombreUnico('Pilates'), defaultCapacity: 10 },
    });
    const hoy = await app.inject({
      method: 'POST', url: '/classes/templates', headers: { cookie },
      payload: {
        branchId, classTypeId: tipo.json().id, effectiveFrom: new Date().toISOString().slice(0, 10),
        slots: [{ weekday: 1, startMinute: 600, durationMin: 45, capacity: 10 }],
      },
    });
    const res = await app.inject({
      method: 'POST', url: `/classes/templates/${hoy.json().id}/retire`, headers: { cookie },
      payload: { reason: 'Error de captura' },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('retirar un tipo retira todos sus horarios; se puede reactivar pero no duplicar', async () => {
    const { typeId, templateId } = await claseConHorario();
    const res = await app.inject({
      method: 'POST', url: `/classes/types/${typeId}/retire`, headers: { cookie },
      payload: { reason: 'Ya no se da esta clase' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await getDb().classTemplate.findUniqueOrThrow({ where: { id: templateId } })).isActive).toBe(false);
    const tipo = await getDb().classType.findUniqueOrThrow({ where: { id: typeId } });
    expect(tipo.isActive).toBe(false);

    const duplicado = await app.inject({
      method: 'POST', url: '/classes/types', headers: { cookie }, payload: { name: tipo.name },
    });
    expect(duplicado.statusCode).toBe(409);
    expect(duplicado.json().message).toMatch(/reactívala/);

    const reactivar = await app.inject({
      method: 'PATCH', url: `/classes/types/${typeId}`, headers: { cookie }, payload: { isActive: true },
    });
    expect(reactivar.statusCode, reactivar.body).toBe(200);
    expect(reactivar.json().isActive).toBe(true);
  });

  it('el portal sabe si el gimnasio da clases', async () => {
    const { ClassRepository } = await import('../src/modules/classes/class.repository.js');
    const f = await orgFixtures();
    await claseConHorario();
    expect(await new ClassRepository(f.demo.id).offersClasses()).toBe(true);
    // La otra organización del sembrado no tiene ninguna.
    expect(await new ClassRepository(f.other.id).offersClasses()).toBe(false);
  });

  // ── Bloque 8: precio antes de reservar y pase de lista ─────────────────────

  it('antes de reservar dice si va incluida en el plan o cuánto se le carga', async () => {
    const claseId = await crearClase({ capacity: 5 });
    const incluida = await app.inject({ method: 'GET', url: `/classes/schedules/${claseId}/quote?memberId=${await crearSocio(planConClases)}`, headers: { cookie } });
    expect(incluida.json()).toMatchObject({ canBook: true, requiresPayment: false, priceLabel: null });
    const suelta = await app.inject({ method: 'GET', url: `/classes/schedules/${claseId}/quote?memberId=${await crearSocio(planSinClases)}`, headers: { cookie } });
    expect(suelta.json()).toMatchObject({ canBook: true, requiresPayment: true, priceCents: '15000' });
    expect(suelta.json().priceLabel).toContain('150');
  });

  it('quitar una reserva de clase suelta anula su cargo sin pagar', async () => {
    const claseId = await crearClase({ capacity: 5 });
    const r = await app.inject({ method: 'POST', url: `/classes/schedules/${claseId}/bookings`, headers: { cookie }, payload: { memberId: await crearSocio(planSinClases) } });
    expect(r.json().chargeId).toBeTruthy();
    const quitar = await app.inject({ method: 'POST', url: `/classes/bookings/${r.json().id}/cancel`, headers: { cookie }, payload: {} });
    expect(quitar.json()).toMatchObject({ chargeVoided: true });
    expect((await getDb().charge.findUniqueOrThrow({ where: { id: r.json().chargeId } })).status).toBe('VOID');
  });

  it('el pase de lista se abre una hora antes y cierra 30 minutos después; la clase no se cierra antes', async () => {
    const temprano = await crearClase({ capacity: 5, startsInHours: 3 });
    const r1 = await app.inject({ method: 'POST', url: `/classes/schedules/${temprano}/bookings`, headers: { cookie }, payload: { memberId: await crearSocio(planConClases) } });
    expect((await app.inject({ method: 'POST', url: `/classes/bookings/${r1.json().id}/checkin`, headers: { cookie } })).statusCode).toBe(409);

    // Terminó hace 10 minutos: se ve "en curso" y todavía se puede pasar lista.
    const recien = await crearClase({ capacity: 5, startsInHours: -70 / 60 });
    const r2 = await getDb().classBooking.create({
      data: { id: uuidv7(), organizationId: orgId, branchId, classScheduleId: recien, memberId: await crearSocio(planConClases), status: 'BOOKED', source: 'FRONT_DESK' },
    });
    const { ClassService } = await import('../src/modules/classes/class.service.js');
    while ((await new ClassService().closeFinished(orgId)).closed > 0) { /* siguiente lote */ }
    expect((await getDb().classSchedule.findUniqueOrThrow({ where: { id: recien } })).status).toBe('SCHEDULED');
    const desdeHoy = (await app.inject({ method: 'GET', url: `/classes/schedules?branchId=${branchId}&from=${encodeURIComponent(new Date(Date.now() - 3 * 3_600_000).toISOString())}`, headers: { cookie } })).json();
    expect(desdeHoy.schedules.some((s: { id: string }) => s.id === recien)).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/classes/bookings/${r2.id}/checkin`, headers: { cookie } })).statusCode).toBe(200);

    const vieja = await crearClase({ capacity: 5, startsInHours: -2 });
    const r3 = await getDb().classBooking.create({
      data: { id: uuidv7(), organizationId: orgId, branchId, classScheduleId: vieja, memberId: await crearSocio(planConClases), status: 'BOOKED', source: 'FRONT_DESK' },
    });
    expect((await app.inject({ method: 'POST', url: `/classes/bookings/${r3.id}/checkin`, headers: { cookie } })).statusCode).toBe(409);
  });

  // ── Clases en el plan y clase suelta (2026-10-09) ─────────────────────────

  it('el plan puede incluir solo algunas clases; las que no puede incluir, siempre se cobran', async () => {
    const db = getDb();
    const tipo = async (nombre: string, extra: Record<string, unknown> = {}) => (await app.inject({ method: 'POST', url: '/classes/types', headers: { cookie },
      payload: { name: nombreUnico(nombre), dropInPriceCents: '9000', ...extra } })).json().id as string;
    const yoga = await tipo('Yoga');
    const box = await tipo('Box');
    const privada = await tipo('Privada', { includableInPlans: false });
    // Plan que incluye SOLO yoga.
    const soloYoga = await db.plan.findUniqueOrThrow({ where: { id: planConClases } });
    const { id: _id, ...resto } = soloYoga; void _id;
    const plan = await db.plan.create({ data: { ...resto, id: uuidv7(), code: `YOGA${Date.now() % 100000}`, name: 'Solo yoga', includedClassTypeIds: [yoga], accessTimeWindows: resto.accessTimeWindows ?? undefined } as never });
    const socio = await crearSocio(plan.id);
    const reservar = async (typeId: string, memberId = socio) => (await app.inject({ method: 'POST', url: `/classes/schedules/${await crearClase({ capacity: 5, typeId })}/bookings`, headers: { cookie }, payload: { memberId } })).json();
    expect((await reservar(yoga)).chargeId).toBeNull();
    expect((await reservar(box)).chargeId).toBeTruthy();
    // El plan que incluye TODAS tampoco cubre la que no se puede incluir.
    expect((await reservar(privada, await crearSocio(planConClases))).chargeId).toBeTruthy();
    // Solo quien maneja precios decide si una clase va en los planes.
    const recepcion = await loginAs(app, 'recepcion@demo.mx');
    expect((await app.inject({ method: 'PATCH', url: `/classes/types/${box}`, headers: { cookie: recepcion }, payload: { includableInPlans: false } })).statusCode).toBe(403);
  });

  it('sin plan, la clase suelta se reserva pagando, y pagada abre la puerta a esa clase', async () => {
    const db = getDb();
    const nombre = nombreUnico('Suelta');
    const sinPlan = await db.member.create({ data: { id: uuidv7(), organizationId: orgId, memberCode: `SLT-${Date.now() % 1_000_000}`, firstName: nombre, lastName: 'Suelta', nameKey: normalizedNameKey(`${nombre} suelta`), homeBranchId: branchId, joinedAt: new Date() } });
    const coach = await db.user.findFirstOrThrow({ where: { email: 'coach@demo.mx' }, select: { id: true, fullName: true } });
    // D-16 (bloque 3.5): se aparta con tiempo (a menos de una hora solo pagando en el momento) y
    // después se acerca la clase, para probar la puerta con la clase apartada y todavía sin pagar.
    const claseId = await crearClase({ capacity: 5, startsInHours: 3, coachUserId: coach.id });
    const res = await app.inject({ method: 'POST', url: `/classes/schedules/${claseId}/bookings`, headers: { cookie }, payload: { memberId: sinPlan.id } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().warnings).toContain('DROP_IN_ONLY');
    const pronto = new Date(Date.now() + 1_800_000);
    await db.classSchedule.update({ where: { id: claseId }, data: { startsAt: pronto, endsAt: new Date(pronto.getTime() + 3_600_000) } });
    const recepcion = await loginAs(app, 'recepcion@demo.mx');
    const puerta = () => app.inject({ method: 'POST', url: '/access/attempts', headers: { cookie: recepcion }, payload: { branchId, memberId: sinPlan.id, credentialKind: 'MANUAL', reason: 'Prueba de la puerta' } });
    // Sin pagar, no entra.
    expect((await puerta()).json().outcome).toBe('DENIED');
    await db.charge.update({ where: { id: res.json().chargeId }, data: { status: 'PAID' } });
    const entra = (await puerta()).json();
    expect(entra.outcome, JSON.stringify(entra)).toBe('GRANTED');

    // En su portal ve su clase, quién la imparte y que está pagada.
    const portal = await sesionDeSocio(sinPlan.id);
    const mias = (await app.inject({ method: 'GET', url: '/portal/bookings', headers: { cookie: portal } })).json().bookings;
    expect(mias.find((b: { classScheduleId: string }) => b.classScheduleId === claseId)).toMatchObject({ coachName: coach.fullName, payment: 'PAID', status: 'BOOKED' });
    const lista = (await app.inject({ method: 'GET', url: '/portal/classes', headers: { cookie: portal } })).json().classes;
    expect(lista.find((c: { id: string }) => c.id === claseId)).toMatchObject({ booked: true, coachName: coach.fullName });
  });

  it('quién imparte: se cambia en el horario (y sus clases futuras) o en una sola clase', async () => {
    const db = getDb();
    const coach = await db.user.findFirstOrThrow({ where: { email: 'coach@demo.mx' }, select: { id: true } });
    const h = (await app.inject({ method: 'POST', url: '/classes/templates', headers: { cookie }, payload: {
      branchId, classTypeId, effectiveFrom: new Date().toISOString().slice(0, 10),
      slots: [{ weekday: 3, startMinute: 19 * 60, durationMin: 60, capacity: 10 }],
    } })).json();
    const r = await app.inject({ method: 'PUT', url: `/classes/templates/${h.id}/coach`, headers: { cookie }, payload: { coachUserId: coach.id } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().updated).toBeGreaterThan(0);
    const futuras = await db.classSchedule.findMany({ where: { templateId: h.id, startsAt: { gt: new Date() } }, select: { id: true, coachUserId: true } });
    expect(futuras.every((c) => c.coachUserId === coach.id)).toBe(true);
    // Un suplente: solo esa clase.
    const otra = await app.inject({ method: 'PUT', url: `/classes/schedules/${futuras[0]!.id}/coach`, headers: { cookie }, payload: { coachUserId: null } });
    expect(otra.statusCode).toBe(200);
    const recepcion = await db.user.findFirstOrThrow({ where: { email: 'recepcion@demo.mx' }, select: { id: true } });
    expect((await app.inject({ method: 'PUT', url: `/classes/templates/${h.id}/coach`, headers: { cookie }, payload: { coachUserId: recepcion.id } })).statusCode).toBe(422);
    await app.inject({ method: 'POST', url: `/classes/templates/${h.id}/retire`, headers: { cookie }, payload: { reason: 'Fin de la prueba' } });
  });

  it('el coach ve los nombres solo en las sesiones que imparte o cubre; en las demás, el cupo y a sus socios (A2 N-01)', async () => {
    const db = getDb();
    const coachId = (await db.user.findFirstOrThrow({ where: { email: 'coach@demo.mx' }, select: { id: true } })).id;
    const suya = await crearClase({ capacity: 5, coachUserId: coachId });
    const ajena = await crearClase({ capacity: 5 });
    const suyo = await crearSocio(planConClases);
    const otro = await crearSocio(planConClases);
    await asignarAlCoach(suyo);
    for (const clase of [suya, ajena]) for (const memberId of [suyo, otro]) {
      const r = await app.inject({ method: 'POST', url: `/classes/schedules/${clase}/bookings`, headers: { cookie }, payload: { memberId } });
      expect(r.statusCode, r.body).toBe(201);
    }
    type Fila = { memberId: string | null; fullName: string | null; memberCode: string | null; hidden?: boolean };
    const coach = await loginAs(app, 'coach@demo.mx');
    const lista = async (clase: string, c = coach) => (await app.inject({ method: 'GET', url: `/classes/schedules/${clase}/bookings`, headers: { cookie: c } })).json().bookings as Fila[];
    try {
      // La que imparte (o cubre): todos con nombre, para pasar lista.
      const propia = await lista(suya);
      expect(propia).toHaveLength(2);
      expect(propia.every((b) => b.fullName && b.memberCode && !b.hidden)).toBe(true);
      // La de otro: el cupo completo, pero con nombre solo su socio.
      const deOtro = await lista(ajena);
      expect(deOtro).toHaveLength(2);
      expect(deOtro.find((b) => b.memberId === suyo)?.fullName).toBeTruthy();
      expect(deOtro.find((b) => b.memberId !== suyo)).toMatchObject({ memberId: null, fullName: null, memberCode: null, hidden: true });
      // La gerencia ve todos los nombres en cualquiera.
      expect((await lista(ajena, cookie)).every((b) => b.fullName && !b.hidden)).toBe(true);
    } finally {
      await db.member.update({ where: { id: suyo }, data: { coachUserId: null } });
    }
  });
});
