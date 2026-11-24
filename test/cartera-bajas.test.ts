import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { makeApp, loginAs } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { markLostDebt } from '../src/modules/billing/deuda-perdida.js';
import { BusinessCalendar } from '../src/platform/time/business-calendar.js';

const MS_DIA = 86_400_000;

/**
 * FASE 4 · BLOQUE 4.11 · LA DEUDA DE UN SOCIO DADO DE BAJA SIGUE EN «POR COBRAR» (D-12).
 *
 * «Nada se borra solo»: dar de baja a un socio en su ficha no quita lo que
 * debe de la cartera, del Tablero ni del Inicio de la dueña. Sale solo por una
 * de tres puertas: se cobra, se condona con monto o se da por perdida por
 * plazo (D-18). Y su estado de cuenta se sigue pudiendo leer.
 *
 * Gimnasio propio; las fechas se cuentan desde el «hoy» de la sede.
 */
describe('cartera · la deuda de un socio dado de baja (D-12)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente: string; let duena: string;
  let org: string; let sede: string;
  let hoy: Date;

  const db = () => getDb();
  const hace = (dias: number) => new Date(hoy.getTime() - dias * MS_DIA);
  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (cookie: string, url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers: { cookie }, payload });

  type Cartera = {
    totalOutstandingCents: string; overdueCents: string; membersWithDebt: number; lostCents: string; lostMembers: number;
    byAging: Array<{ bucket: string; amountCents: string; members: number }>;
    byBranch: Array<{ branchId: string | null; amountCents: string }>;
    topDebtors: Array<{ memberId: string; outstandingCents: string; archived: boolean }>;
  };
  const cartera = async (): Promise<Cartera> => {
    const r = await get(gerente, '/portfolio?topDebtors=100');
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as Cartera;
  };
  const tramo = (c: Cartera, bucket: string) => BigInt(c.byAging.find((b) => b.bucket === bucket)?.amountCents ?? '0');
  const deLaSede = (c: Cartera) => BigInt(c.byBranch.find((b) => b.branchId === sede)?.amountCents ?? '0');

  /** Una membresía ya terminada, directo en la base, con su evento. */
  async function membresiaTerminada(memberId: string, status: 'CANCELED' | 'EXPIRED', venia: 'ACTIVE' | 'SUSPENDED'): Promise<string> {
    const id = uuidv7();
    const inicio = hace(70);
    const termino = hace(5);
    await db().membership.create({
      data: {
        id, organizationId: org, memberId, planId: g.planMensual, soldAtBranchId: sede, status,
        startDate: inicio, currentPeriodStart: inicio, currentPeriodEnd: new Date(inicio.getTime() + 30 * MS_DIA), billingAnchorDay: 1,
        endedAt: termino, ...(status === 'CANCELED' ? { canceledAt: termino, cancellationReason: 'Se mudó de ciudad' } : {}),
      },
    });
    await db().membershipEvent.create({
      data: { id: uuidv7(), organizationId: org, membershipId: id, eventType: status, fromStatus: venia, toStatus: status, at: termino, businessDate: termino },
    });
    return id;
  }

  /** Una cuota de $600 sin pagar, vencida hace `dias`. */
  async function cuota(memberId: string, membershipId: string, dias: number): Promise<string> {
    const id = uuidv7();
    const vence = hace(dias);
    await db().charge.create({
      data: {
        id, organizationId: org, memberId, membershipId, branchId: sede, chargeType: 'MEMBERSHIP_PERIOD', status: 'OVERDUE',
        concept: 'Mensualidad de prueba', subtotalCents: 60_000n, taxCents: 0n, discountCents: 0n, amountCents: 60_000n,
        periodStart: vence, periodEnd: new Date(vence.getTime() + 30 * MS_DIA), dueDate: vence, issuedAt: vence,
      },
    });
    return id;
  }

  const darDeBaja = async (memberId: string) => {
    const r = await post(gerente, `/members/${memberId}/archive`, { reason: 'Avisó que ya no viene' });
    expect(r.statusCode, r.body).toBe(200);
  };

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio({ sedes: [{ name: 'Sede de la cartera', cajas: 1 }] });
    org = g.organizationId;
    sede = g.sedes[0]!.id;
    gerente = await loginAs(app, g.correos.gerente);
    duena = await loginAs(app, g.correos.owner);
    hoy = await new BusinessCalendar(org).today(null);
  }, 120_000);

  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  let socio: string; let membresia: string;
  let antes: Cartera;

  it('dar de baja no mueve «Por cobrar»: mismo total, mismo vencido, mismos tramos, misma sede, mismo deudor', async () => {
    socio = await socioPropio(g);
    membresia = await membresiaTerminada(socio, 'CANCELED', 'ACTIVE');
    await cuota(socio, membresia, 40);
    antes = await cartera();
    expect(BigInt(antes.totalOutstandingCents)).toBe(60_000n);
    expect(tramo(antes, '31-60')).toBe(60_000n);
    expect(antes.topDebtors).toEqual([expect.objectContaining({ memberId: socio, outstandingCents: '60000', archived: false })]);

    await darDeBaja(socio);

    const despues = await cartera();
    expect(despues.totalOutstandingCents).toBe(antes.totalOutstandingCents);
    expect(despues.overdueCents).toBe(antes.overdueCents);
    expect(despues.membersWithDebt).toBe(1);
    expect(tramo(despues, '31-60')).toBe(60_000n);
    expect(deLaSede(despues)).toBe(60_000n);
    // Sigue en la lista de deudores, y dice que está dado de baja.
    expect(despues.topDebtors).toEqual([expect.objectContaining({ memberId: socio, outstandingCents: '60000', archived: true })]);
  });

  it('el Tablero y el Inicio de la dueña dicen lo mismo que la cartera', async () => {
    const tablero = (await get(gerente, '/dashboard?fresh=true')).json();
    expect(tablero.portfolio).toMatchObject({ outstandingCents: '60000', overdueCents: '60000' });
    const pulso = await get(duena, '/reports/pulse?fresh=true');
    expect(pulso.statusCode, pulso.body).toBe(200);
    expect(pulso.json().owed).toMatchObject({ outstandingCents: '60000', overdueCents: '60000' });
    expect(pulso.json().owed.byBranch).toEqual([expect.objectContaining({ branchId: sede, outstandingCents: '60000' })]);
  });

  it('su estado de cuenta se sigue leyendo, con lo que debe; el padrón vivo ya no lo lista', async () => {
    const r = await get(gerente, `/members/${socio}/statement`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ outstandingCents: '60000' });
    expect((await get(gerente, `/members/${socio}/statement/charges`)).statusCode).toBe(200);
    expect((await get(gerente, `/members/${socio}/debt`)).statusCode).toBe(200);
    const padron = (await get(gerente, '/members?withDebt=true')).json() as { members: Array<{ id: string }> };
    expect(padron.members.map((m) => m.id)).not.toContain(socio);
  });

  it('sale por cobro: lo que paga el exsocio baja de «Por cobrar» en ese importe', async () => {
    const r = await post(gerente, `/members/${socio}/payments`, {
      method: 'SPEI_TRANSFER', amountCents: '20000', branchId: sede, externalRef: 'RASTREO-4-11', idempotencyKey: `cartera-bajas-${uuidv7()}`,
    });
    expect([200, 201], r.body).toContain(r.statusCode);
    const c = await cartera();
    expect(c.totalOutstandingCents).toBe('40000');
    expect(c.topDebtors).toEqual([expect.objectContaining({ memberId: socio, outstandingCents: '40000', archived: true })]);
    // Sigue dado de baja: cobrarle no lo reactiva.
    expect((await db().member.findUniqueOrThrow({ where: { id: socio } })).deletedAt).not.toBeNull();
  });

  it('sale por condonación con monto: el resto se perdona con motivo y queda su ajuste', async () => {
    const r = await post(gerente, `/members/${socio}/debt/waiver`, { reasonCode: 'INCOBRABLE', reason: 'Se fue de la ciudad y no contesta' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ forgivenCents: '40000', outstandingCents: '0' });
    const c = await cartera();
    expect(c.totalOutstandingCents).toBe('0');
    expect(c.membersWithDebt).toBe(0);
    expect(c.topDebtors).toEqual([]);
  });

  it('sale por plazo (D-18): la de una membresía que terminó tras estar suspendida se da por perdida y se informa aparte', async () => {
    const otro = await socioPropio(g);
    const m = await membresiaTerminada(otro, 'EXPIRED', 'SUSPENDED');
    const cargo = await cuota(otro, m, 120);
    await darDeBaja(otro);
    let c = await cartera();
    expect(c).toMatchObject({ totalOutstandingCents: '60000', lostCents: '0', lostMembers: 0 });
    expect(tramo(c, '90+')).toBe(60_000n);

    const corrida = await markLostDebt(org);
    expect(corrida.errors).toEqual([]);
    expect(corrida.processed).toBe(1);

    c = await cartera();
    expect(c).toMatchObject({ totalOutstandingCents: '0', overdueCents: '0', membersWithDebt: 0, lostCents: '60000', lostMembers: 1 });
    // Ni anulada ni condonada: mismo estado y mismo saldo.
    const fila = await db().charge.findUniqueOrThrow({ where: { id: cargo } });
    expect(fila.status).toBe('OVERDUE');
    expect(fila.amountCents - fila.allocatedCents - fila.adjustedCents).toBe(60_000n);
    const tablero = (await get(gerente, '/dashboard?fresh=true')).json();
    expect(tablero.portfolio).toMatchObject({ outstandingCents: '0', lostCents: '60000', lostMembers: 1 });
  });

  it('reactivarlo tampoco cambia la cifra: la deuda era suya antes, durante y después de la baja', async () => {
    const tercero = await socioPropio(g);
    const m = await membresiaTerminada(tercero, 'CANCELED', 'ACTIVE');
    await cuota(tercero, m, 10);
    const a = await cartera();
    await darDeBaja(tercero);
    const b = await cartera();
    const r = await post(gerente, `/members/${tercero}/reactivate`, { reason: 'Volvió a inscribirse' });
    expect(r.statusCode, r.body).toBe(200);
    const c = await cartera();
    expect([b.totalOutstandingCents, c.totalOutstandingCents]).toEqual([a.totalOutstandingCents, a.totalOutstandingCents]);
    expect(tramo(c, '1-30')).toBe(60_000n);
  });
});
