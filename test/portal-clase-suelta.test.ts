import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { uuidv7 } from '@gymflow/core';
import { makeApp, aprobacion, telefonoUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, sesionesDe, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { ClassService } from '../src/modules/classes/class.service.js';
import { prioridadDe } from '../src/modules/portal/notice-priority.js';

/**
 * FASE 3 · BLOQUE 3.16 · LA CLASE SUELTA EN EL TELÉFONO DEL SOCIO (D-16).
 *
 * `GET /portal/classes` trae por clase el mismo dato que la cotización del
 * mostrador (`payNow`, `holdUntil`) sin una consulta por clase; «Mis clases»
 * (`GET /portal/bookings`) dice hasta cuándo se guarda el lugar; los dos
 * rechazos le hablan al socio de tú, y cuando el lugar se libera recibe su
 * aviso en la campana. Gimnasio propio; el job recibe su «ahora» por parámetro.
 */
describe('portal · clase suelta (D-16, 3.16)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente: string; let recepcion: string;
  let sede: string; let tipo: string;
  let consultas = 0;
  const HORA = 3_600_000;
  const servicio = new ClassService();

  const pedir = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  async function sesion(enHoras: number): Promise<{ id: string; startsAt: Date }> {
    const startsAt = new Date(Date.now() + enHoras * HORA);
    const row = await getDb().classSchedule.create({
      data: {
        id: uuidv7(), organizationId: g.organizationId, branchId: sede, classTypeId: tipo,
        occurrenceKey: `p316:${uuidv7()}`, startsAt, endsAt: new Date(startsAt.getTime() + HORA),
        businessDate: new Date(startsAt.toISOString().slice(0, 10)), capacity: 10,
      },
    });
    return { id: row.id, startsAt };
  }
  async function socioConPortal(): Promise<{ memberId: string; cookie: string }> {
    const memberId = await socioPropio(g);
    await getDb().member.update({ where: { id: memberId }, data: { phoneE164: telefonoUnico() } });
    const inv = await pedir(gerente, 'POST', `/members/${memberId}/portal-invite`);
    expect(inv.statusCode, inv.body).toBe(201);
    const act = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: inv.json().code } });
    expect(act.statusCode, act.body).toBe(201);
    return { memberId, cookie: `gf_portal=${act.cookies.find((c) => c.name === 'gf_portal')!.value}` };
  }
  const transferencia = () => ({ method: 'SPEI_TRANSFER', externalRef: `P316-${randomUUID().slice(0, 8)}` });
  /** Deja al socio debiendo su mensualidad: vendida, cobrada y con el cobro deshecho. */
  async function queDebaSuMensualidad(memberId: string): Promise<void> {
    const venta = await pedir(gerente, 'POST', `/members/${memberId}/memberships/sale`, { planId: g.planMensual, branchId: sede, saleKey: `p316-${randomUUID()}`, payment: transferencia() });
    expect(venta.statusCode, venta.body).toBe(201);
    const pago = venta.json().payment;
    const firma = await aprobacion(app, gerente, 'payments:reverse', g.correos.owner, sede, { resourceId: pago.id, amountCents: pago.amountCents });
    expect((await pedir(gerente, 'POST', `/payments/${pago.id}/reverse`, { reason: 'Transferencia que no llegó', approvalToken: firma })).statusCode).toBe(201);
  }
  type ClaseDelPortal = { id: string; canBook: boolean; requiresPayment: boolean; payNow: string | null; holdUntil: string | null };
  const clases = async (cookie: string): Promise<ClaseDelPortal[]> => {
    const r = await pedir(cookie, 'GET', '/portal/classes');
    expect(r.statusCode, r.body).toBe(200);
    return r.json().classes;
  };

  beforeAll(async () => {
    // Para contar consultas: el cliente que dejó `setup.ts` nació sin el registro de consultas; se abre uno nuevo que sí lo lleva.
    process.env.DB_LOG_QUERIES = '1';
    await closeDb();
    app = await makeApp();
    (getDb() as unknown as { $on: (e: string, f: () => void) => void }).$on('query', () => { consultas++; });
    g = await gimnasioPropio();
    ({ gerente, recepcion } = await sesionesDe(app, g));
    sede = g.sedes[0]!.id;
    const t = await pedir(gerente, 'POST', '/classes/types', { name: 'Spinning', defaultCapacity: 12, dropInPriceCents: '15000' });
    expect(t.statusCode, t.body).toBe(201);
    tipo = t.json().id;
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  it('la lista trae por clase lo mismo que la cotización: se guarda hasta una hora antes, o solo pagando porque falta menos de una hora', async () => {
    const lejos = await sesion(50);
    const cerca = await sesion(0.5);
    const { memberId, cookie } = await socioConPortal();
    const lista = await clases(cookie);
    const deLejos = lista.find((c) => c.id === lejos.id)!;
    const deCerca = lista.find((c) => c.id === cerca.id)!;
    expect(deLejos).toMatchObject({ canBook: true, requiresPayment: true, payNow: null, holdUntil: new Date(lejos.startsAt.getTime() - HORA).toISOString() });
    expect(deCerca).toMatchObject({ canBook: true, requiresPayment: true, payNow: 'HOLD_CLOSED', holdUntil: null });
    // El mismo dato, clase por clase, que da la cotización del mostrador.
    for (const c of [deLejos, deCerca]) {
      const q = (await pedir(recepcion, 'GET', `/classes/schedules/${c.id}/quote?memberId=${memberId}`)).json();
      expect({ payNow: c.payNow, holdUntil: c.holdUntil }).toEqual({ payNow: q.payNow, holdUntil: q.holdUntil });
    }
    // El rechazo, de tú en el portal…
    const no = await pedir(cookie, 'POST', `/portal/classes/${cerca.id}/book`);
    expect(no.statusCode, no.body).toBe(409);
    expect(no.json().reason).toBe('CLASS_HOLD_CLOSED');
    expect(no.json().message).toBe('Falta menos de una hora para la clase: ya no la puedes apartar sin pagar. Págala en recepción al llegar');
    // …y el del mostrador sigue como estaba.
    const noMostrador = await pedir(recepcion, 'POST', `/classes/schedules/${cerca.id}/bookings`, { memberId });
    expect(noMostrador.json().message).toBe('Falta menos de una hora para la clase: ya no se aparta sin pagar. Se paga en recepción al llegar');
  });

  it('quien debe su mensualidad: todas sus clases sueltas dicen que solo pagando, y el rechazo le habla de tú', async () => {
    const s = await sesion(70);
    const { memberId, cookie } = await socioConPortal();
    await queDebaSuMensualidad(memberId);
    const sueltas = (await clases(cookie)).filter((c) => c.requiresPayment);
    expect(sueltas.length).toBeGreaterThan(0);
    for (const c of sueltas) expect(c).toMatchObject({ payNow: 'OWES_MEMBERSHIP', holdUntil: null });
    const no = await pedir(cookie, 'POST', `/portal/classes/${s.id}/book`);
    expect(no.statusCode, no.body).toBe(409);
    expect(no.json().reason).toBe('CLASS_PAY_NOW');
    expect(no.json().message).toBe('Debes tu mensualidad: una clase suelta solo la apartas pagándola en el momento, en recepción');
    const noMostrador = await pedir(recepcion, 'POST', `/classes/schedules/${s.id}/bookings`, { memberId });
    expect(noMostrador.json().message).toBe('Debe su mensualidad: una clase suelta solo se aparta pagándola en el momento, en recepción');
  });

  it('una clase incluida en su plan o ya apartada no trae ni `payNow` ni `holdUntil`', async () => {
    const s = await sesion(60);
    const { cookie } = await socioConPortal();
    const r = await pedir(cookie, 'POST', `/portal/classes/${s.id}/book`);
    expect(r.statusCode, r.body).toBe(201);
    const apartada = (await clases(cookie)).find((c) => c.id === s.id)!;
    expect(apartada).toMatchObject({ canBook: false, payNow: null, holdUntil: null });
  });

  it('el costo no crece con el número de clases: las mismas consultas con 3 que con 15', async () => {
    const { cookie, memberId } = await socioConPortal();
    await queDebaSuMensualidad(memberId);
    const medir = async () => { await clases(cookie); const antes = consultas; const n = (await clases(cookie)).length; return { consultas: consultas - antes, clases: n }; };
    const pocas = await medir();
    for (let i = 0; i < 12; i++) await sesion(20 + i);
    const muchas = await medir();
    expect(muchas.clases).toBe(pocas.clases + 12);
    expect(pocas.consultas).toBeGreaterThan(0);
    expect(muchas.consultas).toBe(pocas.consultas);
  });

  it('«Mis clases» dice hasta cuándo se guarda el lugar; pagada, ya no; y al liberarse llega UN aviso a la campana', async () => {
    const s = await sesion(40);
    const otra = await sesion(41);
    const { memberId, cookie } = await socioConPortal();
    const limite = new Date(s.startsAt.getTime() - HORA);
    const r = await pedir(cookie, 'POST', `/portal/classes/${s.id}/book`);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().holdUntil).toBe(limite.toISOString());
    const pagada = await pedir(cookie, 'POST', `/portal/classes/${otra.id}/book`);
    expect((await pedir(recepcion, 'POST', `/members/${memberId}/payments`, {
      ...transferencia(), amountCents: '15000', branchId: sede, targetChargeIds: [pagada.json().chargeId], idempotencyKey: `p316-${randomUUID()}`,
    })).statusCode).toBe(201);

    const mias = (await pedir(cookie, 'GET', '/portal/bookings')).json().bookings as Array<{ id: string; payment: string; holdUntil: string | null }>;
    expect(mias.find((b) => b.id === r.json().id)).toMatchObject({ payment: 'PENDING', holdUntil: limite.toISOString() });
    expect(mias.find((b) => b.id === pagada.json().id)).toMatchObject({ payment: 'PAID', holdUntil: null });

    const avisos = async () => (await pedir(cookie, 'GET', '/portal/notices')).json().notices as Array<{ kind: string; title: string; body: string; priority: string }>;
    expect((await avisos()).filter((a) => a.kind === 'CLASS_HOLD_RELEASED')).toHaveLength(0);
    expect((await servicio.releaseUnpaidHolds(g.organizationId, limite)).released).toBeGreaterThanOrEqual(1);
    // Repetir el job no repite el aviso.
    await servicio.releaseUnpaidHolds(g.organizationId, limite);
    const liberados = (await avisos()).filter((a) => a.kind === 'CLASS_HOLD_RELEASED');
    expect(liberados).toHaveLength(1);
    expect(liberados[0]!.title).toBe('Se liberó tu lugar en Spinning');
    const zona = g.sedes[0]!.timezone ?? 'America/Mexico_City';
    const hora = limite.toLocaleTimeString('es-MX', { timeZone: zona, hour: '2-digit', minute: '2-digit', hour12: false });
    expect(liberados[0]!.body).toContain(`Te lo guardamos hasta las ${hora}`);
    expect(liberados[0]!.body).toContain('No debes nada y no cuenta como falta');
    expect(liberados[0]!.priority).toBe('CLASS');
    // La que pagó conserva su lugar y no recibe aviso; la liberada ya no trae plazo.
    const despues = (await pedir(cookie, 'GET', '/portal/bookings')).json().bookings as Array<{ id: string; status: string; holdUntil: string | null }>;
    expect(despues.find((b) => b.id === r.json().id)).toMatchObject({ status: 'CANCELED', holdUntil: null });
    expect(despues.find((b) => b.id === pagada.json().id)).toMatchObject({ status: 'BOOKED' });
  });

  it('el aviso de lugar liberado es «de clase» mientras es reciente y después información', () => {
    const estado = { debe: false, sinAcceso: false, ahora: new Date('2026-11-25T18:00:00Z') };
    expect(prioridadDe({ kind: 'CLASS_HOLD_RELEASED', createdAt: new Date('2026-11-25T12:00:00Z') }, estado)).toBe('CLASS');
    expect(prioridadDe({ kind: 'CLASS_HOLD_RELEASED', createdAt: new Date('2026-11-20T12:00:00Z') }, estado)).toBe('INFO');
  });
});
