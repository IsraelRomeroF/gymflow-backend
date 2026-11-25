import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { addDays, nextPeriod } from '@gymflow/core';
import { makeApp, loginAs, telefonoUnico } from './helpers.js';
import { gimnasioPropio, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { BusinessCalendar } from '../src/platform/time/business-calendar.js';
import { BillingService } from '../src/modules/billing/index.js';
import { systemContext } from '../src/platform/jobs/types.js';
import { ponerReloj, relojReal } from './reloj.js';

/**
 * FASE 4 · BLOQUE 4.20 · AVISO DE AUMENTO (P-14).
 *
 * Un AUMENTO del precio de un plan pide 15 días entre el día en que se guarda
 * y el primer cobro con el precio nuevo, para cada socio: a quien su cuota le
 * nace antes, el primero con el precio nuevo es el ciclo siguiente. La
 * pantalla lo dice antes de guardar y el aviso de Mensajes también. Una
 * BAJADA no espera. Sin depender de la hora real: el «hoy» es el de la sede y
 * lo que pasa a los 16 días se hace con el reloj de prueba (`test/reloj.ts`).
 *
 * Todo en un gimnasio propio con datos inventados.
 */
describe('aviso de aumento (4.20, P-14)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente = '';
  let hoy = new Date();

  const db = () => getDb();
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: gerente } });
  const dia = (d: Date) => d.toISOString().slice(0, 10);
  const membresia = (id: string) => db().membership.findUniqueOrThrow({ where: { id } });
  const cambiarPrecio = (planId: string, priceCents: string, fromPriceCents: string) => app.inject({
    method: 'PATCH', url: `/plans/${planId}`, headers: { cookie: gerente },
    payload: { priceCents, reason: 'Ajuste de precio de la prueba 4.20', priceChange: { includeProtected: false, fromPriceCents } },
  });

  async function crearPlan(precio: string): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/plans', headers: { cookie: gerente },
      payload: { code: `A${randomUUID().slice(0, 8).toUpperCase()}`, name: 'Mensual de aviso', billingModel: 'RECURRING', durationUnit: 'MONTH', durationValue: 1, priceCents: precio, signupFeeCents: '0', reason: 'Plan de la prueba 4.20' },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  async function vender(planId: string, conCelular = true): Promise<{ socio: string; membresia: string }> {
    const socio = await socioPropio(g);
    if (conCelular) await db().member.update({ where: { id: socio }, data: { phoneE164: telefonoUnico() } });
    const r = await app.inject({
      method: 'POST', url: `/members/${socio}/memberships/sale`, headers: { cookie: gerente },
      payload: { planId, branchId: g.sedes[0]!.id, saleKey: `venta-${randomUUID()}`, payment: { method: 'SPEI_TRANSFER', externalRef: `AVI${randomUUID().slice(0, 10)}` } },
    });
    expect(r.statusCode, r.body).toBe(201);
    return { socio, membresia: r.json().membership.id as string };
  }

  /** Le pone su siguiente pago dentro de `dias` días (con su ancla), como si se la hubieran vendido hace casi un mes. */
  async function pagaDentroDe(membershipId: string, dias: number): Promise<Date> {
    const fin = addDays(hoy, dias);
    const m = await membresia(membershipId);
    await db().membership.update({
      where: { id: membershipId },
      data: { currentPeriodStart: addDays(fin, -30) < m.startDate ? m.startDate : addDays(fin, -30), currentPeriodEnd: fin, billingAnchorDay: fin.getUTCDate() },
    });
    return fin;
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio({});
    gerente = await loginAs(app, g.correos.gerente);
    hoy = await new BusinessCalendar(g.organizationId).today(g.sedes[0]!.id);
  });
  afterAll(async () => { relojReal(); await g.cerrar(); await app.close(); await closeDb(); });

  describe('un aumento espera 15 días', () => {
    let plan = '';
    let cerca: { socio: string; membresia: string };
    let lejos: { socio: string; membresia: string };
    let finCerca = new Date();
    let primeroCerca = new Date();

    beforeAll(async () => {
      plan = await crearPlan('60000');
      cerca = await vender(plan);
      lejos = await vender(plan);
      // A uno le toca pagar en 5 días (dentro de los 15); al otro, en un mes.
      finCerca = await pagaDentroDe(cerca.membresia, 5);
      primeroCerca = nextPeriod({ start: addDays(finCerca, -30), end: finCerca }, { unit: 'MONTH', value: 1 }, finCerca.getUTCDate()).end;
    });

    it('la vista previa dice desde cuándo rige, cuándo paga el primero y quién paga una vez más el de hoy', async () => {
      const r = await get(`/plans/${plan}/impact?newPriceCents=65000`);
      expect(r.statusCode, r.body).toBe(200);
      const finLejos = (await membresia(lejos.membresia)).currentPeriodEnd;
      expect(r.json().priceChange).toMatchObject({
        touched: 2, appliesFrom: dia(addDays(hoy, 15)), noticeDays: 15, touchedBeforeNotice: 1,
        // El primero: el más próximo entre el ciclo siguiente del de 5 días y el pago del otro.
        firstPaymentOn: dia(finLejos < primeroCerca ? finLejos : primeroCerca),
      });
    });

    it('al guardar no se le mueve a nadie lo que paga; cada uno queda con su día', async () => {
      const r = await cambiarPrecio(plan, '65000', '60000');
      expect(r.statusCode, r.body).toBe(200);
      expect((await membresia(cerca.membresia)).agreedPriceCents).toBe(60_000n);
      expect((await membresia(lejos.membresia)).agreedPriceCents).toBe(60_000n);
      const acto = await db().planPriceChange.findFirstOrThrow({ where: { planId: plan } });
      expect(dia(acto.appliesFrom!)).toBe(dia(addDays(hoy, 15)));
      const fila = (id: string) => db().membershipPriceChange.findFirstOrThrow({ where: { membershipId: id } });
      expect(dia((await fila(cerca.membresia)).firstChargeOn!)).toBe(dia(primeroCerca));
      expect(dia((await fila(lejos.membresia)).firstChargeOn!)).toBe(dia((await membresia(lejos.membresia)).currentPeriodEnd));
      const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'catalog.plan.price_change', resourceId: plan } });
      expect(asiento.afterState).toMatchObject({ appliesFrom: dia(addDays(hoy, 15)) });
    });

    it('el aviso de Mensajes dice el día de su primer pago al precio nuevo', async () => {
      const lista = (await get('/outbound/messages?kind=PRICE_CHANGE')).json();
      const suyo = lista.pending.find((x: { memberId: string }) => x.memberId === cerca.socio);
      const corta = primeroCerca.toLocaleDateString('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'long' });
      expect(suyo.text).toContain(`a partir de tu pago del ${corta} tu plan Mensual de aviso cuesta $650.00 (antes $600.00)`);
      expect(suyo.detail).toContain(`desde su pago del ${corta}`);
    });

    it('la ficha dice a cuánto pasa y desde cuándo; renovar hoy cotiza y cobra el precio de hoy', async () => {
      const ficha = (await get(`/memberships/${cerca.membresia}`)).json();
      expect(ficha).toMatchObject({
        periodPriceCents: '60000', nextPeriodPriceCents: '60000',
        pendingPrice: { toPriceCents: '65000', firstChargeOn: dia(primeroCerca), appliesFrom: dia(addDays(hoy, 15)), inNextPeriod: false },
      });
      const r = await app.inject({
        method: 'POST', url: `/memberships/${cerca.membresia}/renewal`, headers: { cookie: gerente },
        payload: { expectedPeriodStart: dia((await membresia(cerca.membresia)).currentPeriodStart), payment: { method: 'SPEI_TRANSFER', externalRef: `REN${randomUUID().slice(0, 10)}` } },
      });
      expect(r.statusCode, r.body).toBe(200);
      // Su cuota del día 5 nace antes de los 15 días: la paga al precio de antes.
      expect(r.json().charge.amountCents).toBe('60000');
      expect(await db().membershipPriceApplication.count({ where: { membershipId: cerca.membresia } })).toBe(0);
      // Y el comprobante le avisa el día del primero al precio nuevo.
      const recibo = (await get(`/payments/${r.json().payment.id}/receipt`)).json();
      expect(recibo.priceNotice).toEqual({ kind: 'UPCOMING', planName: 'Mensual de aviso', fromPriceCents: '60000', toPriceCents: '65000', startsOn: dia(primeroCerca) });
    });

    it('renovar por adelantado antes de que rija sigue al precio de antes, aunque el periodo empiece después', async () => {
      // El periodo que sigue ya empieza después de los 15 días, pero se emitiría hoy.
      expect((await get(`/memberships/${cerca.membresia}`)).json()).toMatchObject({ nextPeriodPriceCents: '60000', pendingPrice: { inNextPeriod: false } });
    });

    it('a los 16 días la cuota que empieza y se emite desde ese día ya lo lleva, y queda la constancia', async () => {
      const m = await membresia(cerca.membresia);
      ponerReloj(new Date(Date.now() + 16 * 86_400_000).toISOString());
      const renovada = await new BillingService().renewMembership(systemContext(g.organizationId), { membershipId: cerca.membresia, payment: null, expectedPeriodStart: m.currentPeriodStart })
        .finally(relojReal);
      expect(dia(renovada.charge.periodStart!)).toBe(dia(primeroCerca));
      expect(renovada.charge.amountCents).toBe(65_000n);
      expect((await membresia(cerca.membresia)).agreedPriceCents).toBe(65_000n);
      expect(await db().membershipPriceApplication.count({ where: { membershipId: cerca.membresia, chargeId: renovada.charge.id } })).toBe(1);
      // Ya no hay nada por llegar.
      expect((await get(`/memberships/${cerca.membresia}`)).json().pendingPrice ?? null).toBeNull();
    });

    it('«conserva su precio» sigue igual: sin decidir no se guarda nada', async () => {
      const otro = await vender(plan);
      const marca = await app.inject({ method: 'PUT', url: `/memberships/${otro.membresia}/price-protection`, headers: { cookie: gerente }, payload: { protected: true, reason: 'Convenio de la prueba 4.20' } });
      expect(marca.statusCode, marca.body).toBe(200);
      const r = await app.inject({ method: 'PATCH', url: `/plans/${plan}`, headers: { cookie: gerente }, payload: { priceCents: '70000', reason: 'Otro ajuste de la prueba 4.20' } });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().reason).toBe('PRICE_CHANGE_NEEDS_DECISION');
    });
  });

  describe('una bajada no espera', () => {
    it('baja ya lo que paga, sin «rige desde», y el aviso dice el día de su siguiente pago', async () => {
      const plan = await crearPlan('60000');
      const v = await vender(plan);
      const vista = (await get(`/plans/${plan}/impact?newPriceCents=55000`)).json().priceChange;
      expect(vista).toMatchObject({ appliesFrom: dia(hoy), noticeDays: 0, touchedBeforeNotice: 0 });
      const r = await cambiarPrecio(plan, '55000', '60000');
      expect(r.statusCode, r.body).toBe(200);
      expect((await membresia(v.membresia)).agreedPriceCents).toBe(55_000n);
      const fila = await db().membershipPriceChange.findFirstOrThrow({ where: { membershipId: v.membresia } });
      expect(fila.appliesFrom).toBeNull();
      expect((await db().planPriceChange.findFirstOrThrow({ where: { planId: plan } })).appliesFrom).toBeNull();
      const lista = (await get('/outbound/messages?kind=PRICE_CHANGE')).json();
      const fin = (await membresia(v.membresia)).currentPeriodEnd.toLocaleDateString('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'long' });
      expect(lista.pending.find((x: { memberId: string }) => x.memberId === v.socio).text).toContain(`a partir de tu pago del ${fin} tu plan Mensual de aviso baja a $550.00`);
    });

    it('una bajada después de un aumento por llegar se aplica ya, sin adelantar el aumento', async () => {
      const plan = await crearPlan('60000');
      const v = await vender(plan);
      expect((await cambiarPrecio(plan, '70000', '60000')).statusCode).toBe(200);
      expect((await membresia(v.membresia)).agreedPriceCents).toBe(60_000n);
      // Baja la lista a 640: queda arriba de lo que paga hoy (600), así que hoy sigue en 600 y a los 15 días pasa a 640.
      expect((await cambiarPrecio(plan, '64000', '70000')).statusCode).toBe(200);
      expect((await membresia(v.membresia)).agreedPriceCents).toBe(60_000n);
      expect((await get(`/memberships/${v.membresia}`)).json().pendingPrice).toMatchObject({ toPriceCents: '64000' });
      // Baja a 550: ya, debajo de lo que paga.
      expect((await cambiarPrecio(plan, '55000', '64000')).statusCode).toBe(200);
      expect((await membresia(v.membresia)).agreedPriceCents).toBe(55_000n);
    });
  });

  describe('de noche también', () => {
    it('a las 21:30 del centro (ya mañana en UTC) cuenta el día de la sede', async () => {
      const plan = await crearPlan('60000');
      await vender(plan);
      // 2026-11-20 03:30 UTC = 19 de noviembre, 21:30 en la Ciudad de México.
      ponerReloj('2026-11-20T03:30:00.000Z');
      const r = await get(`/plans/${plan}/impact?newPriceCents=65000`).finally(relojReal);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().priceChange).toMatchObject({ appliesFrom: '2026-12-04', noticeDays: 15 });
    });
  });
});
