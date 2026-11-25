import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, telefonoUnico } from './helpers.js';
import { abrirTurno, gimnasioPropio, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { OutboundService } from '../src/modules/outbound/index.js';
import { BusinessCalendar } from '../src/platform/time/business-calendar.js';
import { ponerReloj, relojReal } from './reloj.js';
import { BillingService } from '../src/modules/billing/index.js';
import { systemContext } from '../src/platform/jobs/types.js';

/**
 * FASE 3 · BLOQUE 3.6 · PRECIOS Y TIENDA (D-19, D-20, D-21).
 *
 * D-19: cambiar el precio de un plan le cambia a TODOS en su siguiente pago
 * (la misma diferencia a cada membresía viva); solo conserva su precio la
 * marcada, y aun esa cambia si quien confirma lo decide. Desde 4.20 (P-14) un
 * AUMENTO espera 15 días: aquí la renovación que ya lo lleva se hace con el
 * reloj 16 días adelante (lo propio de 4.20 está en `aviso-de-aumento.test.ts`). La vista previa dice
 * a cuántos toca y cuánto ANTES de confirmar; queda el acto, la bitácora, el
 * aviso al teléfono (bandeja de salida) y la línea del recibo.
 * D-20: nada nuevo; la visita suelta sigue sin inscripción (lo comprueba
 * `pase-del-dia.test.ts`) y su precio se cambia sin tocar a nadie.
 * D-21: costo (opcional, solo lo ve quien administra el catálogo) y precio de
 * socio / de público; la venta guarda el costo del día y a qué precio salió.
 *
 * Todo en un gimnasio propio con datos inventados.
 */
describe('precios y tienda (3.6)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente = '';
  let owner = '';
  let recepcion = '';
  let ajeno = '';
  let turno = '';

  const db = () => getDb();
  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const codigo = () => `P${randomUUID().slice(0, 8).toUpperCase()}`;
  const membresia = (id: string) => db().membership.findUniqueOrThrow({ where: { id } });

  async function crearPlan(over: Record<string, unknown> = {}): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/plans', headers: { cookie: gerente },
      payload: {
        code: codigo(), name: 'Mensual de la prueba', billingModel: 'RECURRING', durationUnit: 'MONTH', durationValue: 1,
        priceCents: '60000', signupFeeCents: '0', reason: 'Plan de la prueba 3.6', ...over,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  async function vender(memberId: string, planId: string, branchId: string, extra: Record<string, unknown> = {}) {
    const r = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: gerente },
      payload: { planId, branchId, saleKey: `venta-${randomUUID()}`, payment: { method: 'SPEI_TRANSFER', externalRef: `PRE${randomUUID().slice(0, 10)}` }, ...extra },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { membership: { id: string }; payment: { id: string } | null; charges: Array<{ id: string; amountCents: string }> };
  }

  const cambiarPrecio = (planId: string, priceCents: string, priceChange?: Record<string, unknown>) => app.inject({
    method: 'PATCH', url: `/plans/${planId}`, headers: { cookie: gerente },
    payload: { priceCents, reason: 'Ajuste de precio de la prueba', ...(priceChange ? { priceChange } : {}) },
  });

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Casa Centro', cajas: 1 }, { name: 'Casa Norte', cajas: 1 }] });
    [gerente, owner, recepcion, ajeno] = await Promise.all([
      loginAs(app, g.correos.gerente), loginAs(app, g.correos.owner), loginAs(app, g.correos.recepcion), loginAs(app, 'gerencia@demo.mx'),
    ]);
    turno = await abrirTurno(app, recepcion, g.sedes[0]!.cajas[0]!);
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  // ── D-19 ──────────────────────────────────────────────────────────────────

  describe('D-19 · el cambio de precio aplica a todos en su siguiente pago', () => {
    let plan = '';
    const m: Record<'lista1' | 'lista2' | 'convenio' | 'norte' | 'sinPacto', string> = { lista1: '', lista2: '', convenio: '', norte: '', sinPacto: '' };
    const socio: Record<string, string> = {};
    let pagoDeLaVenta = '';
    let cuotaSinPagar = '';

    beforeAll(async () => {
      const [centro, norte] = g.sedes as [GimnasioPropio['sedes'][number], GimnasioPropio['sedes'][number]];
      plan = await crearPlan();
      // Norte tiene su precio propio: el precio de lista no rige ahí.
      await db().planBranchAvailability.update({ where: { planId_branchId: { planId: plan, branchId: norte.id } }, data: { priceOverrideCents: 66_000n } });
      for (const k of ['lista1', 'lista2', 'convenio', 'sinPacto'] as const) socio[k] = await socioPropio(g, centro);
      socio.norte = await socioPropio(g, norte);
      await db().member.update({ where: { id: socio.lista1! }, data: { phoneE164: telefonoUnico() } });
      await db().member.update({ where: { id: socio.convenio! }, data: { phoneE164: telefonoUnico() } });

      const v1 = await vender(socio.lista1!, plan, centro.id);
      m.lista1 = v1.membership.id; pagoDeLaVenta = v1.payment!.id;
      // Se vende sin cobrar: su cuota (a $600) se paga después del cambio de precio.
      const v2 = await vender(socio.lista2!, plan, centro.id, { payment: null });
      m.lista2 = v2.membership.id; cuotaSinPagar = v2.charges[0]!.id;
      m.convenio = (await vender(socio.convenio!, plan, centro.id, { agreedPriceCents: '50000', reason: 'Convenio con empresa de la prueba' })).membership.id;
      m.norte = (await vender(socio.norte!, plan, norte.id)).membership.id;
      m.sinPacto = (await vender(socio.sinPacto!, plan, centro.id)).membership.id;
      // Así quedaron las membresías anteriores al precio pactado: sin precio escrito.
      await db().membership.update({ where: { id: m.sinPacto }, data: { agreedPriceCents: null } });
    });

    it('la venta a un precio distinto al de lista nace marcada «conserva su precio»; la de lista no', async () => {
      expect(await membresia(m.convenio)).toMatchObject({ agreedPriceCents: 50_000n, priceProtected: true });
      expect(await membresia(m.lista1)).toMatchObject({ agreedPriceCents: 60_000n, priceProtected: false });
      expect(await membresia(m.norte)).toMatchObject({ agreedPriceCents: 66_000n, priceProtected: false });
    });

    it('la vista previa dice a cuántos toca, cuánto cambia y quiénes conservan su precio, sin escribir nada', async () => {
      const r = await get(gerente, `/plans/${plan}/impact?newPriceCents=65000`);
      expect(r.statusCode, r.body).toBe(200);
      const fin = (await membresia(m.lista1)).currentPeriodEnd.toISOString().slice(0, 10);
      const hoy = await new BusinessCalendar(g.organizationId).today(null);
      expect(r.json().priceChange).toEqual({
        fromPriceCents: '60000', toPriceCents: '65000', deltaCents: '5000',
        touched: 3, touchedAtListPrice: 3, touchedAtOtherPrice: 0, touchedDeltaCents: '15000',
        protected: 1, protectedDeltaCents: '5000', atOwnPriceBranches: 1,
        firstPaymentOn: fin, touchedWithoutPhone: 2,
        // 4.20: rige 15 días después; su siguiente pago (en un mes) ya pasa de esa fecha.
        appliesFrom: new Date(hoy.getTime() + 15 * 86_400_000).toISOString().slice(0, 10), noticeDays: 15, touchedBeforeNotice: 0,
      });
      // Sin precio nuevo, o con el mismo, no hay cambio que mostrar.
      expect((await get(gerente, `/plans/${plan}/impact`)).json().priceChange).toBeNull();
      expect((await get(gerente, `/plans/${plan}/impact?newPriceCents=60000`)).json().priceChange).toBeNull();
      expect(await db().planPriceChange.count({ where: { planId: plan } })).toBe(0);
      expect((await membresia(m.lista1)).agreedPriceCents).toBe(60_000n);
    });

    it('con socios que conservan su precio, el cambio exige la decisión y sin ella no cambia nada', async () => {
      const r = await cambiarPrecio(plan, '65000');
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().reason).toBe('PRICE_CHANGE_NEEDS_DECISION');
      expect((await db().plan.findUniqueOrThrow({ where: { id: plan } })).priceCents).toBe(60_000n);
      expect((await membresia(m.lista1)).agreedPriceCents).toBe(60_000n);

      // Y si el precio que vio la pantalla ya no es el de hoy, tampoco.
      const viejo = await cambiarPrecio(plan, '65000', { includeProtected: false, fromPriceCents: '59000' });
      expect(viejo.statusCode, viejo.body).toBe(409);
      expect(viejo.json().reason).toBe('PRICE_CHANGED_MEANWHILE');
      expect(await db().planPriceChange.count({ where: { planId: plan } })).toBe(0);
    });

    it('al confirmar: suben los que pagan el de lista, el convenio conserva su precio y la sede con precio propio no cambia', async () => {
      const r = await cambiarPrecio(plan, '65000', { includeProtected: false, fromPriceCents: '60000' });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().priceCents).toBe('65000');

      // 4.20: el aumento espera su primera cuota; mientras, lo que pagan no se mueve.
      expect((await membresia(m.lista1)).agreedPriceCents).toBe(60_000n);
      expect((await membresia(m.lista2)).agreedPriceCents).toBe(60_000n);
      // Sin precio escrito queda con el de antes escrito: el de lista ya es el nuevo y no le llega antes.
      expect((await membresia(m.sinPacto)).agreedPriceCents).toBe(60_000n);
      expect(await membresia(m.convenio)).toMatchObject({ agreedPriceCents: 50_000n, priceProtected: true });
      expect((await membresia(m.norte)).agreedPriceCents).toBe(66_000n);

      const acto = await db().planPriceChange.findFirstOrThrow({ where: { planId: plan } });
      expect(acto).toMatchObject({ fromPriceCents: 60_000n, toPriceCents: 65_000n, includedProtected: false, touchedCount: 3, protectedKeptCount: 1 });
      const filas = await db().membershipPriceChange.findMany({ where: { planPriceChangeId: acto.id } });
      expect(filas.map((f) => f.membershipId).sort()).toEqual([m.lista1, m.lista2, m.sinPacto].sort());
      expect(filas.every((f) => f.fromPriceCents === 60_000n && f.toPriceCents === 65_000n && !f.wasProtected)).toBe(true);
      expect(filas.every((f) => f.appliesFrom !== null && f.appliesFrom.getTime() === acto.appliesFrom?.getTime())).toBe(true);

      // En la bitácora: el cambio del plan y a cuántos tocó.
      const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'catalog.plan.price_change', resourceId: plan } });
      expect(asiento.afterState).toMatchObject({ priceCents: '65000', touched: 3, protectedKept: 1, includedProtected: false });
      expect(asiento.reason).toBe('Ajuste de precio de la prueba');
    });

    it('lo ya emitido no cambia: la cuota de la venta sigue en $600', async () => {
      const cuota = await db().charge.findUniqueOrThrow({ where: { id: cuotaSinPagar } });
      expect(cuota.amountCents).toBe(60_000n);
    });

    it('el siguiente pago sale al precio nuevo, y el recibo lo dice', async () => {
      // 4.20: renovar HOY por adelantado todavía no lo lleva; a los 16 días, sí.
      const visto = (await membresia(m.lista1)).currentPeriodStart;
      ponerReloj(new Date(Date.now() + 16 * 86_400_000).toISOString());
      const renovada = await new BillingService().renewMembership(systemContext(g.organizationId), { membershipId: m.lista1, payment: null, expectedPeriodStart: visto })
        .finally(relojReal);
      expect(renovada.charge.amountCents).toBe(65_000n);
      // Llegó: queda la constancia con su cuota y el precio pactado ya es el nuevo.
      expect((await membresia(m.lista1)).agreedPriceCents).toBe(65_000n);
      expect(await db().membershipPriceApplication.count({ where: { membershipId: m.lista1, chargeId: renovada.charge.id } })).toBe(1);
      const cobro = await app.inject({
        method: 'POST', url: `/members/${socio.lista1}/payments`, headers: { cookie: gerente },
        payload: { idempotencyKey: randomUUID(), method: 'SPEI_TRANSFER', amountCents: '65000', branchId: g.sedes[0]!.id, externalRef: `REN${randomUUID().slice(0, 10)}`, targetChargeIds: [renovada.charge.id] },
      });
      expect([200, 201], cobro.body).toContain(cobro.statusCode);

      // El comprobante de ese pago: es el primero al precio nuevo.
      const pago = await db().payment.findFirstOrThrow({ where: { memberId: socio.lista1!, organizationId: g.organizationId }, orderBy: { createdAt: 'desc' } });
      const nuevo = (await get(gerente, `/payments/${pago.id}/receipt`)).json();
      expect(nuevo.priceNotice).toEqual({ kind: 'APPLIED', planName: 'Mensual de la prueba', fromPriceCents: '60000', toPriceCents: '65000', startsOn: null });
      // El comprobante de la venta, anterior al cambio, no dice nada aunque se reimprima hoy.
      expect((await get(gerente, `/payments/${pagoDeLaVenta}/receipt`)).json().priceNotice).toBeNull();

      // Quien paga DESPUÉS del cambio una cuota emitida antes: se le avisa lo que viene.
      const abono = await app.inject({
        method: 'POST', url: `/members/${socio.lista2}/payments`, headers: { cookie: gerente },
        payload: { idempotencyKey: randomUUID(), method: 'SPEI_TRANSFER', amountCents: '60000', branchId: g.sedes[0]!.id, externalRef: `ABO${randomUUID().slice(0, 10)}`, targetChargeIds: [cuotaSinPagar] },
      });
      expect([200, 201], abono.body).toContain(abono.statusCode);
      const recibo = (await get(gerente, `/payments/${abono.json().payment.id}/receipt`)).json();
      const suFila = await db().membershipPriceChange.findFirstOrThrow({ where: { membershipId: m.lista2 } });
      // Su membresía sigue por activar (no hay fecha prevista): el recibo dice desde cuándo rige.
      expect(recibo.priceNotice).toEqual({
        kind: 'UPCOMING', planName: 'Mensual de la prueba', fromPriceCents: '60000', toPriceCents: '65000',
        startsOn: (suFila.firstChargeOn ?? suFila.appliesFrom)!.toISOString().slice(0, 10),
      });
    });

    it('el aviso al teléfono queda en Mensajes para quien tiene celular, con el antes y el después', async () => {
      const r = await get(gerente, '/outbound/messages?kind=PRICE_CHANGE');
      expect(r.statusCode, r.body).toBe(200);
      const lista = r.json();
      expect(lista.counts.PRICE_CHANGE).toBe(1);
      const aviso = lista.pending.find((x: { memberId: string }) => x.memberId === socio.lista1);
      expect(aviso).toBeTruthy();
      expect(aviso.kind).toBe('PRICE_CHANGE');
      // 4.20: dice el día de su primer pago al precio nuevo.
      expect(aviso.text).toContain('a partir de tu pago del');
      expect(aviso.text).toContain('$650.00');
      expect(aviso.text).toContain('antes $600.00');
      expect(aviso.detail).toContain('de $600.00 a $650.00');
      expect(aviso.detail).toContain('desde su pago del');
      // Volver a armarlos (el job diario) no duplica nada.
      expect((await new OutboundService().avisarCambiosDePrecio(g.organizationId)).created).toBe(0);
      expect(await db().outboundMessage.count({ where: { organizationId: g.organizationId, kind: 'PRICE_CHANGE' } })).toBe(1);
    });

    it('repetir el mismo precio no hace nada; decidir «también a ellos» le suma la misma diferencia al convenio', async () => {
      const igual = await cambiarPrecio(plan, '65000', { includeProtected: false });
      expect(igual.statusCode, igual.body).toBe(200);
      expect(await db().planPriceChange.count({ where: { planId: plan } })).toBe(1);

      const vista = (await get(gerente, `/plans/${plan}/impact?newPriceCents=70000`)).json().priceChange;
      expect(vista).toMatchObject({ touched: 3, protected: 1, protectedDeltaCents: '5000', deltaCents: '5000' });
      const r = await cambiarPrecio(plan, '70000', { includeProtected: true, fromPriceCents: '65000' });
      expect(r.statusCode, r.body).toBe(200);
      // Conserva su distancia con el de lista y sigue marcado: el siguiente cambio vuelve a preguntar.
      // 4.20: el aumento espera sus 15 días; lo que paga hoy no se mueve.
      expect(await membresia(m.convenio)).toMatchObject({ agreedPriceCents: 50_000n, priceProtected: true });
      expect((await membresia(m.lista1)).agreedPriceCents).toBe(65_000n);
      const suyas = await db().membershipPriceChange.findMany({ where: { membershipId: { in: [m.convenio, m.lista1] }, acto: { toPriceCents: 70_000n } } });
      expect(suyas.map((f) => `${f.fromPriceCents}>${f.toPriceCents}`).sort()).toEqual(['50000>55000', '65000>70000']);
      const acto = await db().planPriceChange.findFirstOrThrow({ where: { planId: plan, toPriceCents: 70_000n } });
      expect(acto).toMatchObject({ includedProtected: true, touchedCount: 4, protectedKeptCount: 0 });
      // El aviso del convenio nace; el del primer cambio de lista1 se reemplaza por el nuevo.
      const avisos = (await get(gerente, '/outbound/messages?kind=PRICE_CHANGE')).json();
      expect(avisos.counts.PRICE_CHANGE).toBe(2);
      expect(avisos.pending.find((x: { memberId: string }) => x.memberId === socio.convenio).text).toContain('$550.00');
      expect(avisos.pending.find((x: { memberId: string }) => x.memberId === socio.lista1).text).toContain('$700.00');
    });

    it('bajar el precio también le llega a todos y nunca deja un precio negativo', async () => {
      const r = await cambiarPrecio(plan, '64000', { includeProtected: false, fromPriceCents: '70000' });
      expect(r.statusCode, r.body).toBe(200);
      // La bajada no espera (4.20): pagaba 650 con un aumento a 700 por llegar; ya paga 640.
      expect((await membresia(m.lista1)).agreedPriceCents).toBe(64_000n);
      // El convenio no entró en la bajada: sigue en 500 con su aumento a 550 por llegar.
      expect((await membresia(m.convenio)).agreedPriceCents).toBe(50_000n);
    });

    it('«conserva su precio» se pone y se quita con motivo, queda en la bitácora y solo lo hace quien arma el catálogo', async () => {
      const marcar = (cookie: string, id: string, protegida: boolean) => app.inject({
        method: 'PUT', url: `/memberships/${id}/price-protection`, headers: { cookie }, payload: { protected: protegida, reason: 'Acuerdo de la prueba con el socio' },
      });
      expect((await marcar(recepcion, m.lista1, true)).statusCode).toBe(403);
      expect((await marcar(owner, m.lista1, true)).statusCode).toBe(403);
      expect((await marcar(ajeno, m.lista1, true)).statusCode).toBe(404);

      // Quien no tenía precio escrito queda con el que paga hoy.
      const r = await marcar(gerente, m.sinPacto, true);
      expect(r.statusCode, r.body).toBe(200);
      // Hoy paga 600: su aumento a 650 no ha llegado y la bajada a 640 no lo adelanta (4.20).
      expect(r.json()).toEqual({ membershipId: m.sinPacto, priceProtected: true, agreedPriceCents: '60000', reason: 'Acuerdo de la prueba con el socio' });
      expect(await db().auditLog.count({ where: { organizationId: g.organizationId, action: 'catalog.price_protection.set', resourceId: socio.sinPacto! } })).toBe(1);
      // Repetirla no hace nada.
      expect((await marcar(gerente, m.sinPacto, true)).statusCode).toBe(200);
      expect(await db().auditLog.count({ where: { organizationId: g.organizationId, action: 'catalog.price_protection.set', resourceId: socio.sinPacto! } })).toBe(1);

      const lista = await get(gerente, `/plans/${plan}/protected-prices`);
      expect(lista.statusCode, lista.body).toBe(200);
      expect(lista.json().total).toBe(2);
      expect(lista.json().items.map((x: { membershipId: string }) => x.membershipId).sort()).toEqual([m.convenio, m.sinPacto].sort());
      expect(lista.json().items.find((x: { membershipId: string }) => x.membershipId === m.convenio)).toMatchObject({ agreedPriceCents: '50000', listPriceCents: '64000', reason: 'Se pactó un precio distinto al de lista' });
      expect((await get(recepcion, `/plans/${plan}/protected-prices`)).statusCode).toBe(403);

      // Un cambio que no los incluye no los toca; al quitar la marca, el siguiente sí.
      expect((await cambiarPrecio(plan, '66000', { includeProtected: false })).statusCode).toBe(200);
      expect((await membresia(m.sinPacto)).agreedPriceCents).toBe(60_000n);
      expect((await marcar(gerente, m.sinPacto, false)).json()).toMatchObject({ priceProtected: false, agreedPriceCents: '60000', reason: null });
      expect((await cambiarPrecio(plan, '67000', { includeProtected: false })).statusCode).toBe(200);
      // 4.20: los aumentos esperan; la ficha dice a cuánto pasa.
      expect((await membresia(m.sinPacto)).agreedPriceCents).toBe(60_000n);
      expect((await membresia(m.lista1)).agreedPriceCents).toBe(64_000n);
      expect((await get(gerente, `/memberships/${m.sinPacto}`)).json().pendingPrice).toMatchObject({ toPriceCents: '65000' });
      expect((await get(gerente, `/memberships/${m.lista1}`)).json().pendingPrice).toMatchObject({ toPriceCents: '67000' });
    });

    it('un plan sin socios que conserven su precio se cambia sin más, y el de la visita suelta no toca a nadie (D-20)', async () => {
      const visita = await crearPlan({ name: 'Visita de la prueba', billingModel: 'DAY_PASS', durationUnit: 'DAY', durationValue: 1, priceCents: '10000', signupFeeCents: '30000' });
      // La visita suelta nunca lleva inscripción, la mande quien la mande (D-20).
      expect((await db().plan.findUniqueOrThrow({ where: { id: visita } })).signupFeeCents).toBe(0n);
      const r = await cambiarPrecio(visita, '12000');
      expect(r.statusCode, r.body).toBe(200);
      const acto = await db().planPriceChange.findFirstOrThrow({ where: { planId: visita } });
      expect(acto).toMatchObject({ touchedCount: 0, protectedKeptCount: 0 });
    });
  });

  // ── D-21 ──────────────────────────────────────────────────────────────────

  describe('D-21 · costo por producto y precio de socio / de público', () => {
    let agua = '';
    let socioVigente = '';
    let socioSinPlan = '';
    const sku = () => `T${randomUUID().slice(0, 8).toUpperCase()}`;

    const venta = (lines: Array<{ productId: string; quantity: number }>, memberId?: string) => app.inject({
      method: 'POST', url: '/pos/sales', headers: { cookie: recepcion },
      payload: { idempotencyKey: randomUUID(), branchId: g.sedes[0]!.id, method: 'CASH', cashSessionId: turno, lines, ...(memberId ? { memberId } : {}) },
    });

    beforeAll(async () => {
      socioVigente = await socioPropio(g);
      socioSinPlan = await socioPropio(g);
      await vender(socioVigente, g.planMensual, g.sedes[0]!.id);
    });

    it('un producto guarda su costo y su precio de socio; el de socio no puede ser mayor que el de público', async () => {
      const mal = await app.inject({
        method: 'POST', url: '/products', headers: { cookie: gerente },
        payload: { sku: sku(), name: 'Agua de la prueba', priceCents: '2000', memberPriceCents: '2500', tracksInventory: false },
      });
      expect(mal.statusCode, mal.body).toBe(422);
      const r = await app.inject({
        method: 'POST', url: '/products', headers: { cookie: gerente },
        payload: { sku: sku(), name: 'Agua de la prueba', priceCents: '2000', memberPriceCents: '1500', costCents: '800', tracksInventory: false },
      });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({ priceCents: '2000', memberPriceCents: '1500', costCents: '800' });
      agua = r.json().id as string;
    });

    it('el costo solo lo ve quien administra el catálogo; el mostrador ve los dos precios', async () => {
      const deRecepcion = (await get(recepcion, '/products')).json().products.find((p: { id: string }) => p.id === agua);
      expect(deRecepcion).toMatchObject({ priceCents: '2000', memberPriceCents: '1500' });
      expect('costCents' in deRecepcion).toBe(false);
      const deGerencia = (await get(gerente, '/products')).json().products.find((p: { id: string }) => p.id === agua);
      expect(deGerencia.costCents).toBe('800');
    });

    it('la pantalla sabe si a ese socio le toca el precio de socio', async () => {
      expect((await get(recepcion, `/products?memberId=${socioVigente}`)).json().memberPricing).toEqual({ memberId: socioVigente, applies: true });
      expect((await get(recepcion, `/products?memberId=${socioSinPlan}`)).json().memberPricing).toEqual({ memberId: socioSinPlan, applies: false });
      expect((await get(recepcion, '/products')).json().memberPricing).toBeNull();
      expect((await get(recepcion, `/products?memberId=${randomUUID()}`)).statusCode).toBe(404);
    });

    it('al socio con membresía vigente se le cobra el precio de socio; al público y a quien no la tiene, el de público', async () => {
      const aSocio = await venta([{ productId: agua, quantity: 2 }], socioVigente);
      expect(aSocio.statusCode, aSocio.body).toBe(201);
      expect(aSocio.json()).toMatchObject({ totalCents: '3000', lines: [{ unitPriceCents: '1500', lineTotalCents: '3000', priceKind: 'MEMBER' }] });

      const alPublico = await venta([{ productId: agua, quantity: 2 }]);
      expect(alPublico.json()).toMatchObject({ totalCents: '4000', lines: [{ unitPriceCents: '2000', priceKind: 'PUBLIC' }] });

      const sinPlan = await venta([{ productId: agua, quantity: 1 }], socioSinPlan);
      expect(sinPlan.json()).toMatchObject({ totalCents: '2000', lines: [{ unitPriceCents: '2000', priceKind: 'PUBLIC' }] });

      // Con la membresía suspendida ya no es «vigente» para la tienda.
      const viva = await db().membership.findFirstOrThrow({ where: { memberId: socioVigente, organizationId: g.organizationId } });
      await db().membership.update({ where: { id: viva.id }, data: { status: 'SUSPENDED' } });
      const suspendido = await venta([{ productId: agua, quantity: 1 }], socioVigente);
      expect(suspendido.json()).toMatchObject({ totalCents: '2000', lines: [{ priceKind: 'PUBLIC' }] });
      await db().membership.update({ where: { id: viva.id }, data: { status: 'ACTIVE' } });
    });

    it('cada línea guarda lo que costaba el producto ese día: cambiar o quitar el costo no toca lo vendido', async () => {
      const antes = await venta([{ productId: agua, quantity: 3 }]);
      const cambiar = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/products/${agua}`, headers: { cookie: gerente }, payload });
      expect((await cambiar({ costCents: '900' })).json()).toMatchObject({ costCents: '900', memberPriceCents: '1500' });
      const despues = await venta([{ productId: agua, quantity: 1 }]);
      expect((await cambiar({ costCents: null, memberPriceCents: null })).json()).toMatchObject({ costCents: null, memberPriceCents: null });
      const sinCosto = await venta([{ productId: agua, quantity: 1 }], socioVigente);
      expect(sinCosto.json()).toMatchObject({ totalCents: '2000', lines: [{ priceKind: 'PUBLIC' }] });

      const costoDe = async (saleId: string) => (await db().posSaleLine.findFirstOrThrow({ where: { posSaleId: saleId } })).unitCostCents;
      expect(await costoDe(antes.json().id)).toBe(800n);
      expect(await costoDe(despues.json().id)).toBe(900n);
      expect(await costoDe(sinCosto.json().id)).toBeNull();

      // El cambio queda en la bitácora con el antes y el después.
      const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'pos.product.update', resourceId: agua }, orderBy: { at: 'desc' } });
      expect(asiento.beforeState).toMatchObject({ costCents: '900', memberPriceCents: '1500' });
      expect(asiento.afterState).toMatchObject({ costCents: null, memberPriceCents: null });
      // Bajar el precio de público por debajo del de socio no se acepta.
      expect((await cambiar({ memberPriceCents: '1500' })).statusCode).toBe(200);
      expect((await cambiar({ priceCents: '1000' })).statusCode).toBe(422);
    });
  });
});
