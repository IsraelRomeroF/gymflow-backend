import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { uuidv7 } from '@gymflow/core';
import { makeApp, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, sesionesDe, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { ClassService } from '../src/modules/classes/class.service.js';

/**
 * FASE 3 · BLOQUE 3.5 · D-16 «LA CLASE SUELTA APARTADA SIN PAGAR».
 *
 * Se guarda hasta una hora antes; sin pago se libera y no debe nada; si llega,
 * se cobra al pasar lista. Quien debe su mensualidad, o quien aparta con menos
 * de una hora, solo la aparta pagándola en el momento.
 * Gimnasio propio: «Spinning» a $150 la clase suelta. Las sesiones se crean a
 * N horas de AHORA y el job recibe su «ahora» por parámetro: no depende del reloj.
 */
describe('clases · D-16', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente: string; let recepcion: string;
  let sede: string; let tipo: string;
  const HORA = 3_600_000;
  const servicio = new ClassService();

  const pedir = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  async function sesion(enHoras: number, capacity = 10): Promise<{ id: string; startsAt: Date }> {
    const startsAt = new Date(Date.now() + enHoras * HORA);
    const row = await getDb().classSchedule.create({
      data: {
        id: uuidv7(), organizationId: g.organizationId, branchId: sede, classTypeId: tipo,
        occurrenceKey: `d16:${uuidv7()}`, startsAt, endsAt: new Date(startsAt.getTime() + HORA),
        businessDate: new Date(startsAt.toISOString().slice(0, 10)), capacity,
      },
    });
    return { id: row.id, startsAt };
  }
  const apartar = (memberId: string, scheduleId: string, payment?: Record<string, unknown>) =>
    pedir(recepcion, 'POST', `/classes/schedules/${scheduleId}/bookings`, { memberId, ...(payment ? { payment } : {}) });
  const lugares = async (scheduleId: string) => (await getDb().classSchedule.findUniqueOrThrow({ where: { id: scheduleId } })).bookedCount;
  const debe = async (memberId: string) => BigInt((await pedir(gerente, 'GET', `/members/${memberId}/statement`)).json().outstandingCents);
  const transferencia = () => ({ method: 'SPEI_TRANSFER', externalRef: `CLASE-${randomUUID().slice(0, 8)}` });
  /** Un socio con membresía en mora: vendida, cobrada y con el cobro deshecho (debe su cuota de hoy). */
  async function socioQueDebeSuMensualidad(): Promise<string> {
    const memberId = await socioPropio(g);
    const venta = await pedir(gerente, 'POST', `/members/${memberId}/memberships/sale`, { planId: g.planMensual, branchId: sede, saleKey: `d16-${randomUUID()}`, payment: transferencia() });
    expect(venta.statusCode, venta.body).toBe(201);
    const pago = venta.json().payment;
    const firma = await aprobacion(app, gerente, 'payments:reverse', g.correos.owner, sede, { resourceId: pago.id, amountCents: pago.amountCents });
    expect((await pedir(gerente, 'POST', `/payments/${pago.id}/reverse`, { reason: 'Transferencia que no llegó', approvalToken: firma })).statusCode).toBe(201);
    return memberId;
  }

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio();
    ({ gerente, recepcion } = await sesionesDe(app, g));
    sede = g.sedes[0]!.id;
    const t = await pedir(gerente, 'POST', '/classes/types', { name: 'Spinning', defaultCapacity: 12, dropInPriceCents: '15000' });
    expect(t.statusCode, t.body).toBe(201);
    tipo = t.json().id;
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  // Cada caso usa una sesión a distinta distancia: el job libera TODO lo vencido del gimnasio a la hora que se le dice.
  it('apartada sin pagar: el lugar se guarda hasta una hora antes, y la lista y la cotización lo dicen', async () => {
    const s = await sesion(100);
    const memberId = await socioPropio(g);
    const q = (await pedir(recepcion, 'GET', `/classes/schedules/${s.id}/quote?memberId=${memberId}`)).json();
    expect(q).toMatchObject({ canBook: true, requiresPayment: true, payNow: null, priceCents: '15000' });
    expect(q.holdUntil).toBe(new Date(s.startsAt.getTime() - HORA).toISOString());

    const r = await apartar(memberId, s.id);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ status: 'BOOKED', paymentId: null, holdUntil: new Date(s.startsAt.getTime() - HORA).toISOString() });
    expect(r.json().chargeId).toBeTruthy();
    const lista = (await pedir(recepcion, 'GET', `/classes/schedules/${s.id}/bookings`)).json();
    expect(lista.bookings[0]).toMatchObject({ payment: 'PENDING', pendingCents: '15000', holdUntil: new Date(s.startsAt.getTime() - HORA).toISOString() });
  });

  it('una hora antes y sin pago, el lugar se libera y NO debe nada; un instante antes, todavía no', async () => {
    const s = await sesion(48, 1);
    const memberId = await socioPropio(g);
    const r = await apartar(memberId, s.id);
    expect(r.statusCode, r.body).toBe(201);
    expect(await debe(memberId)).toBe(15_000n);
    expect(await lugares(s.id)).toBe(1);
    const limite = new Date(s.startsAt.getTime() - HORA);

    const antes = await servicio.releaseUnpaidHolds(g.organizationId, new Date(limite.getTime() - 1));
    expect(antes.released).toBe(0);
    expect((await getDb().classBooking.findUniqueOrThrow({ where: { id: r.json().id } })).status).toBe('BOOKED');
    expect(await debe(memberId)).toBe(15_000n);

    const justo = await servicio.releaseUnpaidHolds(g.organizationId, limite);
    expect(justo.released).toBe(1);
    const reserva = await getDb().classBooking.findUniqueOrThrow({ where: { id: r.json().id } });
    expect(reserva).toMatchObject({ status: 'CANCELED', lateCancel: false, holdUntil: null });
    const cargo = await getDb().charge.findUniqueOrThrow({ where: { id: r.json().chargeId } });
    expect(cargo.status).toBe('VOID');
    expect(cargo.voidReason).toContain('una hora antes');
    expect(await debe(memberId)).toBe(0n);
    // El lugar volvió al cupo: otro socio lo toma (la sesión era de un solo lugar).
    expect(await lugares(s.id)).toBe(0);
    expect((await apartar(await socioPropio(g), s.id)).statusCode).toBe(201);
    // No cuenta como falta ni deja bloqueo, y quedó en la bitácora.
    expect(await getDb().classBookingBlock.count({ where: { memberId } })).toBe(0);
    expect(await getDb().auditLog.count({ where: { organizationId: g.organizationId, action: 'class.booking.release', resourceId: reserva.id } })).toBe(1);
    // A esa misma hora el job libera también al que acaba de tomar el lugar sin pagar; repetido, ya no hace nada.
    expect((await servicio.releaseUnpaidHolds(g.organizationId, limite)).released).toBe(1);
    expect((await servicio.releaseUnpaidHolds(g.organizationId, limite)).released).toBe(0);
  });

  it('si la paga antes de la hora, conserva su lugar', async () => {
    const s = await sesion(24);
    const memberId = await socioPropio(g);
    const r = await apartar(memberId, s.id);
    const cobro = await pedir(recepcion, 'POST', `/members/${memberId}/payments`, {
      ...transferencia(), amountCents: '15000', branchId: sede, targetChargeIds: [r.json().chargeId], idempotencyKey: `d16-${randomUUID()}`,
    });
    expect(cobro.statusCode, cobro.body).toBe(201);
    const res = await servicio.releaseUnpaidHolds(g.organizationId, new Date(s.startsAt.getTime() - HORA));
    expect(res).toMatchObject({ released: 0, kept: 1 });
    expect(await getDb().classBooking.findUniqueOrThrow({ where: { id: r.json().id } })).toMatchObject({ status: 'BOOKED', holdUntil: null });
    expect((await getDb().charge.findUniqueOrThrow({ where: { id: r.json().chargeId } })).status).toBe('PAID');
  });

  it('con menos de una hora ya no se aparta sin pagar (y no se le quita el lugar a nadie); pagando en el momento, sí', async () => {
    const s = await sesion(0.5);
    const memberId = await socioPropio(g);
    const q = (await pedir(recepcion, 'GET', `/classes/schedules/${s.id}/quote?memberId=${memberId}`)).json();
    expect(q).toMatchObject({ canBook: true, payNow: 'HOLD_CLOSED', holdUntil: null });
    const sinPago = await apartar(memberId, s.id);
    expect(sinPago.statusCode, sinPago.body).toBe(409);
    expect(sinPago.json().reason).toBe('CLASS_HOLD_CLOSED');
    expect(await lugares(s.id)).toBe(0);
    expect(await debe(memberId)).toBe(0n);

    const pagando = await apartar(memberId, s.id, transferencia());
    expect(pagando.statusCode, pagando.body).toBe(201);
    expect(pagando.json().holdUntil).toBeNull();
    expect(pagando.json().paymentId).toBeTruthy();
    expect((await getDb().charge.findUniqueOrThrow({ where: { id: pagando.json().chargeId } })).status).toBe('PAID');
    expect(await debe(memberId)).toBe(0n);
    expect(await lugares(s.id)).toBe(1);
  });

  it('quien debe su mensualidad solo la aparta pagándola en el momento, falte lo que falte; el pago va a la clase, no a la mensualidad', async () => {
    const s = await sesion(72);
    const memberId = await socioQueDebeSuMensualidad();
    expect(await debe(memberId)).toBe(60_000n);
    const q = (await pedir(recepcion, 'GET', `/classes/schedules/${s.id}/quote?memberId=${memberId}`)).json();
    expect(q).toMatchObject({ canBook: true, requiresPayment: true, payNow: 'OWES_MEMBERSHIP', holdUntil: null });

    const sinPago = await apartar(memberId, s.id);
    expect(sinPago.statusCode, sinPago.body).toBe(409);
    expect(sinPago.json().reason).toBe('CLASS_PAY_NOW');
    expect(await lugares(s.id)).toBe(0);
    expect(await debe(memberId)).toBe(60_000n);
    // Desde su teléfono no hay cómo pagar todavía: tampoco la aparta.
    await expect(servicio.book(g.organizationId, { scheduleId: s.id, memberId, source: 'PORTAL' })).rejects.toMatchObject({ reason: 'CLASS_PAY_NOW' });

    const pagando = await apartar(memberId, s.id, transferencia());
    expect(pagando.statusCode, pagando.body).toBe(201);
    expect((await getDb().charge.findUniqueOrThrow({ where: { id: pagando.json().chargeId } })).status).toBe('PAID');
    // Sigue debiendo su mensualidad, completa.
    expect(await debe(memberId)).toBe(60_000n);
  });

  it('quitar tarde un lugar apartado sin pagar tampoco deja deuda (si no venir no le costaba, avisar tampoco)', async () => {
    // Apartada con tiempo; se quita a 90 minutos de la clase: ya pasó el plazo de cancelación (2 horas), pero sigue siendo un apartado.
    const s = await sesion(48);
    const memberId = await socioPropio(g);
    const r = await apartar(memberId, s.id);
    expect(r.statusCode, r.body).toBe(201);
    const cerca = new Date(Date.now() + 1.5 * HORA);
    await getDb().classSchedule.update({ where: { id: s.id }, data: { startsAt: cerca, endsAt: new Date(cerca.getTime() + HORA) } });
    const quitar = await pedir(recepcion, 'POST', `/classes/bookings/${r.json().id}/cancel`, {});
    expect(quitar.statusCode, quitar.body).toBe(200);
    expect(quitar.json()).toMatchObject({ chargeVoided: true, lateChargeKept: false });
    expect(await debe(memberId)).toBe(0n);
  });

  it('si el cobro en el momento no se puede hacer, no queda ni el lugar ni la deuda', async () => {
    const s = await sesion(0.5);
    const memberId = await socioPropio(g);
    // En efectivo y sin caja abierta: 409, y nada se movió.
    const r = await apartar(memberId, s.id, { method: 'CASH' });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().reason).toBe('NO_OPEN_REGISTER');
    expect(await lugares(s.id)).toBe(0);
    expect(await getDb().classBooking.count({ where: { classScheduleId: s.id } })).toBe(0);
    expect(await debe(memberId)).toBe(0n);
  });
});
