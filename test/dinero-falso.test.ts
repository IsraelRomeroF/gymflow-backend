import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { addDays, uuidv7 } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, CONSENTIMIENTOS, sedeDesechable, archivarSede } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { BillingService } from '../src/modules/billing/billing.service.js';
import { systemContext } from '../src/platform/jobs/types.js';

/**
 * AUDITORÍA 8, BLOQUE 0.6 · «DINERO FALSO».
 *
 * Lo que el sistema le dice al socio y a la dueña sobre el dinero tiene que
 * ser verdad: hasta dónde pagó, si una visita se renueva, qué pasa con lo que
 * sobra al bajar de plan, que el saldo a favor se use al cobrar, que un abono
 * diga si alcanza, que «olvidar» solo exista con meses atrasados, que una
 * renovación nunca quede sin su cuota y una sola regla de descuadre.
 */
describe('dinero falso · fase 0', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let gerente: string;
  let orgId: string;
  let cen: string;
  let nor: string;

  const dia = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10);
  const menosUnDia = (iso: string) => dia(addDays(new Date(`${iso}T00:00:00.000Z`), -1));
  const codigo = () => `T${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const spei = () => ({ method: 'SPEI_TRANSFER', externalRef: `SPEI${randomUUID().slice(0, 8)}` });
  /** «Hoy» del gimnasio: de noche en México la fecha de UTC ya es mañana. */
  const hoyNegocio = () => new Date(`${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })}T00:00:00.000Z`);

  async function crearPlan(over: Record<string, unknown> = {}): Promise<{ id: string }> {
    const r = await app.inject({
      method: 'POST', url: '/plans', headers: { cookie: gerencia },
      payload: {
        code: codigo(), name: 'Plan de prueba 0.6', billingModel: 'RECURRING', durationUnit: 'MONTH', durationValue: 1,
        priceCents: '70000', signupFeeCents: '0', branchAccessScope: 'ALL_BRANCHES', reason: 'Plan de la prueba del bloque 0.6', ...over,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  }

  async function nuevoSocio(sede = cen): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Dinero'), lastName: nombreUnico('Falso'), phoneE164: telefonoUnico(), homeBranchId: sede, force: true, consents: CONSENTIMIENTOS },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  async function vender(memberId: string, planId: string, extra: Record<string, unknown> = {}) {
    const r = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: gerencia },
      payload: { planId, branchId: cen, payment: spei(), ...extra },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { membership: { id: string; status: string; currentPeriodStart: string; currentPeriodEnd: string }; payment: { id: string } | null; totalCents: string; creditAppliedCents: string };
  }

  const membresias = async (memberId: string) =>
    (await app.inject({ method: 'GET', url: `/members/${memberId}/memberships`, headers: { cookie: gerencia } })).json() as Array<{
      id: string; status: string; coveredThrough: string; paidThrough: string | null; missedPeriods: number | null; autoRenew: boolean;
    }>;
  const estado = async (memberId: string) =>
    (await app.inject({ method: 'GET', url: `/members/${memberId}/statement`, headers: { cookie: gerencia } })).json();
  const cobrar = (memberId: string, cents: string) => app.inject({
    method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: gerencia },
    payload: { idempotencyKey: `cobro-${randomUUID()}`, amountCents: cents, branchId: cen, ...spei() },
  });

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    gerente = await loginAs(app, 'gerente@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
    nor = f.demoBranches.find((b) => b.code === 'NOR')!.id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  // ── Pagado hasta (3-01, 4-03) ─────────────────────────────────────────────

  it('«pagado hasta» es el fin de lo PAGADO: el periodo que debe no cuenta, ni en la ficha ni en el resumen de acceso', async () => {
    const plan = await crearPlan();
    const memberId = await nuevoSocio();
    const venta = await vender(memberId, plan.id);
    const p1Fin = venta.membership.currentPeriodEnd;
    // Esa noche el job abrió el periodo siguiente con su cuota, y nadie la pagó.
    await new BillingService().advancePeriod(systemContext(orgId), venta.membership.id, new Date(`${venta.membership.currentPeriodStart}T00:00:00.000Z`));
    await getDb().membership.update({ where: { id: venta.membership.id }, data: { status: 'SUSPENDED' } });

    const [m] = await membresias(memberId);
    expect(m!.status).toBe('SUSPENDED');
    expect(m!.paidThrough).toBe(menosUnDia(p1Fin));
    // La vigencia del periodo sigue siendo otra cosa: la que mira la puerta.
    expect(m!.coveredThrough > m!.paidThrough!).toBe(true);

    const resumen = (await app.inject({ method: 'GET', url: `/members/access-summary?ids=${memberId}`, headers: { cookie: gerencia } })).json();
    expect(resumen.members[0].membership.paidThrough).toBe(menosUnDia(p1Fin));

    // Un abono que no alcanza lo dice: sigue sin entrar y le faltan $400.
    const abono = await cobrar(memberId, '30000');
    expect(abono.statusCode, abono.body).toBe(201);
    expect(abono.json().membership).toMatchObject({ status: 'SUSPENDED', canEnter: false, paidThrough: menosUnDia(p1Fin) });
    expect(abono.json().toEnterCents).toBe('40000');
    expect((await estado(memberId)).cobro.toEnterCents).toBe('40000');

    // Con lo que falta, entra y el «pagado hasta» avanza al fin del periodo.
    const resto = await cobrar(memberId, '40000');
    expect(resto.statusCode, resto.body).toBe(201);
    expect(resto.json().membership).toMatchObject({ status: 'ACTIVE', canEnter: true, paidThrough: m!.coveredThrough });
    expect(resto.json().toEnterCents).toBeNull();

    // El comprobante dice hasta dónde quedó pagado CON ESE pago, no con los de después.
    const recibo1 = (await app.inject({ method: 'GET', url: `/payments/${abono.json().payment.id}/receipt`, headers: { cookie: gerencia } })).json();
    expect(recibo1.coverage.paidThrough).toBe(menosUnDia(p1Fin));
    const recibo2 = (await app.inject({ method: 'GET', url: `/payments/${resto.json().payment.id}/receipt`, headers: { cookie: gerencia } })).json();
    expect(recibo2.coverage.paidThrough).toBe(m!.coveredThrough);
  });

  it('al volver de congelar, lo pagado cubre los días repuestos: no aparece debiendo', async () => {
    const plan = await crearPlan({ allowFreeze: true, minFreezeDays: 1 });
    const memberId = await nuevoSocio();
    const venta = await vender(memberId, plan.id);
    const congelar = await app.inject({ method: 'POST', url: `/memberships/${venta.membership.id}/freeze`, headers: { cookie: gerencia }, payload: { days: 10, reason: 'Viaje de trabajo' } });
    expect(congelar.statusCode, congelar.body).toBe(200);
    // Lleva tres días en pausa.
    await getDb().membership.update({ where: { id: venta.membership.id }, data: { frozenSince: addDays(hoyNegocio(), -3) } });
    const volver = await app.inject({ method: 'POST', url: `/memberships/${venta.membership.id}/unfreeze`, headers: { cookie: gerencia }, payload: {} });
    expect(volver.statusCode, volver.body).toBe(200);
    const [m] = await membresias(memberId);
    expect(m!.coveredThrough).toBe(menosUnDia(dia(addDays(new Date(`${venta.membership.currentPeriodEnd}T00:00:00.000Z`), 3))));
    expect(m!.paidThrough).toBe(m!.coveredThrough);
  });

  // ── Visita suelta y prepago (4-01, 4-02, D-14) ────────────────────────────

  // Desde la fase 1.8 la visita suelta se vende como PASE DEL DÍA (sin membresía:
  // `test/pase-del-dia.test.ts`). Estas dos pruebas cuidan las membresías «de
  // visita» que ya estaban vendidas: se arman vendiendo un día de prepago y
  // pasando el plan a visita suelta, que es como quedaron en la base.
  it('una visita suelta ya vendida como membresía NO se renueva: vence esa noche, sin cuota nueva, y se le vende un pase', async () => {
    const visita = await crearPlan({ billingModel: 'PREPAID_PERIOD', durationUnit: 'DAY', durationValue: 1, priceCents: '15000', autoRenewDefault: true });
    const memberId = await nuevoSocio();
    const venta = await vender(memberId, visita.id);
    expect(venta.membership.status).toBe('ACTIVE');
    await getDb().plan.update({ where: { id: visita.id }, data: { billingModel: 'DAY_PASS' } });
    expect((await membresias(memberId))[0]!.autoRenew).toBe(false);

    // Llega la noche: su día ya terminó.
    const db = getDb();
    await db.membership.update({
      where: { id: venta.membership.id },
      data: { startDate: addDays(hoyNegocio(), -1), currentPeriodStart: addDays(hoyNegocio(), -1), currentPeriodEnd: hoyNegocio() },
    });
    const { rollPeriods } = await import('../src/modules/billing/billing.jobs.js');
    const { expireMemberships } = await import('../src/modules/memberships/membership.jobs.js');
    await rollPeriods(orgId);
    await expireMemberships(orgId);
    expect(await db.charge.count({ where: { membershipId: venta.membership.id, chargeType: 'MEMBERSHIP_PERIOD' } })).toBe(1);
    expect((await db.membership.findUniqueOrThrow({ where: { id: venta.membership.id } })).status).toBe('EXPIRED');

    // Al día siguiente vuelve: como membresía ya no se vende (422) y el pase sale sin «ya tiene una membresía vigente».
    const comoMembresia = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: gerencia },
      payload: { planId: visita.id, branchId: cen, saleKey: `venta-${randomUUID()}`, payment: spei() },
    });
    expect(comoMembresia.statusCode, comoMembresia.body).toBe(422);
    const pase = await app.inject({
      method: 'POST', url: `/members/${memberId}/day-passes`, headers: { cookie: gerencia },
      payload: { planId: visita.id, branchId: cen, saleKey: `pase-${randomUUID()}`, payment: spei() },
    });
    expect(pase.statusCode, pase.body).toBe(201);
    expect(pase.json().pass.validToday).toBe(true);
  });

  it('una visita suelta viva con «se renueva sola» de antes tampoco se renueva (la regla está en el job)', async () => {
    const visita = await crearPlan({ billingModel: 'PREPAID_PERIOD', durationUnit: 'DAY', durationValue: 1, priceCents: '15000' });
    const memberId = await nuevoSocio();
    const venta = await vender(memberId, visita.id);
    const db = getDb();
    await db.plan.update({ where: { id: visita.id }, data: { billingModel: 'DAY_PASS' } });
    await db.membership.update({
      where: { id: venta.membership.id },
      data: { autoRenew: true, startDate: addDays(hoyNegocio(), -1), currentPeriodStart: addDays(hoyNegocio(), -1), currentPeriodEnd: hoyNegocio() },
    });
    const { rollPeriods } = await import('../src/modules/billing/billing.jobs.js');
    await rollPeriods(orgId);
    expect(await db.charge.count({ where: { membershipId: venta.membership.id, chargeType: 'MEMBERSHIP_PERIOD' } })).toBe(1);
  });

  it('el pago anticipado nace sin renovarse (D-14) y solo se renueva si se elige en la venta', async () => {
    const anualidad = await crearPlan({ billingModel: 'PREPAID_PERIOD', durationUnit: 'MONTH', durationValue: 12, priceCents: '650000', autoRenewDefault: true });
    const uno = await nuevoSocio();
    await vender(uno, anualidad.id);
    expect((await membresias(uno))[0]!.autoRenew).toBe(false);
    const otro = await nuevoSocio();
    await vender(otro, anualidad.id, { autoRenew: true });
    expect((await membresias(otro))[0]!.autoRenew).toBe(true);
  });

  // ── Cambio de plan (4-05, 4-06) ───────────────────────────────────────────

  it('bajar de una anualidad a una mensualidad deja el excedente A FAVOR del socio, no lo pierde', async () => {
    const anualidad = await crearPlan({ billingModel: 'PREPAID_PERIOD', durationUnit: 'DAY', durationValue: 365, priceCents: '600000' });
    const mensual = await crearPlan({ priceCents: '70000' });
    const memberId = await nuevoSocio();
    const inicio = new Date(Date.now() - 10 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const venta = await vender(memberId, anualidad.id, { startDate: inicio, reason: 'Fixture: lleva diez días' });

    const r = await app.inject({
      method: 'POST', url: `/memberships/${venta.membership.id}/plan-change`, headers: { cookie: gerencia },
      payload: { planId: mensual.id, reason: 'Ya no le alcanza la anualidad', payment: null },
    });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    // 355 de 365 días de $6,000 = $5,835.62 (redondeo al centavo, regla única del núcleo).
    expect(b.proration).toMatchObject({ cycleDays: 365, usedDays: 10, remainingDays: 355 });
    expect(b.creditCents).toBe('70000');
    expect(b.creditToBalanceCents).toBe(String(583_562n - 70_000n));
    expect(b.charge.status).toBe('PAID');
    const st = await estado(memberId);
    expect(st.creditCents).toBe(String(583_562n - 70_000n));
    expect(BigInt(st.outstandingCents)).toBe(0n);
    // Y de pago anticipado a recurrente, se renueva sola como dice el plan nuevo.
    expect((await membresias(memberId))[0]!.autoRenew).toBe(true);
  });

  it('no se cambia a una visita suelta', async () => {
    const mensual = await crearPlan();
    const visita = await crearPlan({ billingModel: 'DAY_PASS', durationUnit: 'DAY', durationValue: 1, priceCents: '15000' });
    const memberId = await nuevoSocio();
    const inicio = new Date(Date.now() - 5 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const venta = await vender(memberId, mensual.id, { startDate: inicio });
    const r = await app.inject({
      method: 'POST', url: `/memberships/${venta.membership.id}/plan-change`, headers: { cookie: gerencia },
      payload: { planId: visita.id, reason: 'Solo viene a veces', payment: null },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toMatch(/visita suelta/);
  });

  it('con la cuota abierta, primero se cobra: renovar y cambiar de plan responden 409 sin tocar nada', async () => {
    const mensual = await crearPlan();
    const otro = await crearPlan({ priceCents: '90000' });
    const memberId = await nuevoSocio();
    const inicio = new Date(Date.now() - 5 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const venta = await vender(memberId, mensual.id, { startDate: inicio });
    // Le queda un cargo de su membresía sin pagar (por el servicio: el permiso
    // del cargo manual no es lo que se prueba aquí).
    await new BillingService().createManualCharge(systemContext(orgId), {
      memberId, chargeType: 'MANUAL_ADJUSTMENT', concept: 'Diferencia de la mensualidad', subtotalCents: 15_000n,
      membershipId: venta.membership.id, branchId: cen, reason: 'Fixture de cuota abierta',
    });

    const renovar = await app.inject({ method: 'POST', url: `/memberships/${venta.membership.id}/renewal`, headers: { cookie: gerencia }, payload: { payment: null, expectedPeriodStart: venta.membership.currentPeriodStart } });
    expect(renovar.statusCode).toBe(409);
    expect(renovar.json().message).toMatch(/Primero cobra/);
    const cambiar = await app.inject({
      method: 'POST', url: `/memberships/${venta.membership.id}/plan-change`, headers: { cookie: gerencia },
      payload: { planId: otro.id, reason: 'Quiere el otro', payment: null },
    });
    expect(cambiar.statusCode).toBe(409);
    expect(cambiar.json().message).toMatch(/Primero cobra/);
    const m = await getDb().membership.findUniqueOrThrow({ where: { id: venta.membership.id } });
    expect(m.planId).toBe(mensual.id);
    expect(dia(m.currentPeriodStart)).toBe(venta.membership.currentPeriodStart);
  });

  it('el día de corte, «renovar» no cobra el periodo siguiente encima de la cuota de hoy', async () => {
    const mensual = await crearPlan();
    const memberId = await nuevoSocio();
    const venta = await vender(memberId, mensual.id);
    await new BillingService().advancePeriod(systemContext(orgId), venta.membership.id, new Date(`${venta.membership.currentPeriodStart}T00:00:00.000Z`));
    const r = await app.inject({ method: 'POST', url: `/memberships/${venta.membership.id}/renewal`, headers: { cookie: gerencia }, payload: { payment: spei(), expectedPeriodStart: (await getDb().membership.findUniqueOrThrow({ where: { id: venta.membership.id } })).currentPeriodStart.toISOString().slice(0, 10) } });
    expect(r.statusCode).toBe(409);
    expect(await getDb().charge.count({ where: { membershipId: venta.membership.id, chargeType: 'MEMBERSHIP_PERIOD' } })).toBe(2);
  });

  // ── Saldo a favor al cobrar (4-18) ────────────────────────────────────────

  it('el saldo a favor se aplica al cobrar: con $200 a favor y $650 de deuda se cobran $450', async () => {
    const memberId = await nuevoSocio();
    // Pagó de más cuando no debía nada: le quedan $200 a favor.
    const adelanto = await cobrar(memberId, '20000');
    expect(adelanto.json().unappliedCents).toBe('20000');
    // Después le nace una deuda que no se emitió como cuota: nadie le aplicó el crédito.
    const cargo = await new BillingService().createManualCharge(systemContext(orgId), {
      memberId, chargeType: 'MANUAL_ADJUSTMENT', concept: 'Reposición de credencial', subtotalCents: 65_000n, branchId: cen, reason: 'Fixture de deuda',
    });
    const antes = await estado(memberId);
    expect(antes.netBalanceCents).toBe('45000');

    const pago = await cobrar(memberId, '45000');
    expect(pago.statusCode, pago.body).toBe(201);
    expect(pago.json().creditAppliedCents).toBe('20000');
    expect(pago.json().unappliedCents).toBe('0');
    const c = await getDb().charge.findUniqueOrThrow({ where: { id: cargo.id } });
    expect(c.status).toBe('PAID');
    const despues = await estado(memberId);
    expect(despues.outstandingCents).toBe('0');
    expect(despues.creditCents).toBe('0');
  });

  it('la venta cobra solo lo que el saldo a favor no cubrió', async () => {
    const mensual = await crearPlan();
    const memberId = await nuevoSocio();
    await cobrar(memberId, '20000');
    const venta = await vender(memberId, mensual.id);
    expect(venta.membership.status).toBe('ACTIVE');
    expect(venta.creditAppliedCents).toBe('20000');
    const pago = await getDb().payment.findUniqueOrThrow({ where: { id: venta.payment!.id } });
    expect(pago.amountCents).toBe(50_000n);
    expect(pago.unappliedCents).toBe(0n);
  });

  it('si el saldo a favor cubre toda la venta, se activa sin cobrar un peso', async () => {
    const mensual = await crearPlan();
    const memberId = await nuevoSocio();
    await cobrar(memberId, '80000');
    const venta = await vender(memberId, mensual.id);
    expect(venta.membership.status).toBe('ACTIVE');
    expect(venta.payment).toBeNull();
    expect(venta.creditAppliedCents).toBe('70000');
    expect((await estado(memberId)).creditCents).toBe('10000');
  });

  it('una suspendida con saldo a favor que REANUDA su adeudo no se activa a medias', async () => {
    const mensual = await crearPlan();
    const memberId = await nuevoSocio();
    const venta = await vender(memberId, mensual.id, { payment: null });
    const hace = (n: number) => { const x = hoyNegocio(); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() - n, Math.min(x.getUTCDate(), 28))); };
    const db = getDb();
    // Suspendida desde hace dos meses, con su cuota de entonces abierta y $700 a favor que llegaron después.
    await db.membership.update({
      where: { id: venta.membership.id },
      data: { status: 'SUSPENDED', startDate: hace(2), currentPeriodStart: hace(2), currentPeriodEnd: hace(1), billingAnchorDay: hace(2).getUTCDate() },
    });
    await db.charge.updateMany({ where: { membershipId: venta.membership.id }, data: { periodStart: hace(2), periodEnd: hace(1), dueDate: hace(2) } });
    await db.payment.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberId, branchId: cen, method: 'CREDIT_NOTE', status: 'SUCCEEDED',
        amountCents: 70_000n, unappliedCents: 70_000n, businessDate: hoyNegocio(),
      },
    });
    const r = await app.inject({
      method: 'POST', url: `/memberships/${venta.membership.id}/debt-decision`, headers: { cookie: gerencia },
      payload: { decision: 'RESUME', reason: 'Acepta pagar los meses', payment: null },
    });
    expect(r.statusCode, r.body).toBe(200);
    const m = await db.membership.findUniqueOrThrow({ where: { id: venta.membership.id } });
    // El periodo sí avanzó al de hoy y sigue debiendo los meses que no vino.
    expect(m.currentPeriodStart.getTime()).toBeGreaterThan(hace(1).getTime() - 1);
    expect(m.status).toBe('SUSPENDED');
  });

  // ── Decidir adeudo solo con atrasos (4-08) ────────────────────────────────

  it('«olvidar» sin meses atrasados se rechaza antes de pedir firma; con atrasos la ficha los cuenta', async () => {
    const mensual = await crearPlan();
    const memberId = await nuevoSocio();
    const venta = await vender(memberId, mensual.id, { payment: null });
    // Suspendida con su periodo en curso: debe la cuota, pero no hay meses que olvidar.
    await getDb().membership.update({ where: { id: venta.membership.id }, data: { status: 'SUSPENDED' } });
    expect((await membresias(memberId))[0]!.missedPeriods).toBe(0);
    const r = await app.inject({
      method: 'POST', url: `/memberships/${venta.membership.id}/debt-decision`, headers: { cookie: gerente },
      payload: { decision: 'FORGIVE', reason: 'Vuelve tras lesión' },
    });
    expect(r.statusCode).toBe(409);
    expect(await getDb().chargeAdjustment.count({ where: { charge: { membershipId: venta.membership.id } } })).toBe(0);

    // Con su periodo dos meses atrás, sí hay atrasos.
    const hace = (n: number) => { const x = hoyNegocio(); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() - n, Math.min(x.getUTCDate(), 28))); };
    await getDb().membership.update({
      where: { id: venta.membership.id },
      data: { startDate: hace(2), currentPeriodStart: hace(2), currentPeriodEnd: hace(1), billingAnchorDay: hace(2).getUTCDate() },
    });
    expect((await membresias(memberId))[0]!.missedPeriods).toBeGreaterThan(0);
  });

  // ── Renovar y emitir la cuota en una transacción (A3-N1) ──────────────────

  it('la sede que dejó de vender el plan NO rompe la renovación: la cuota sale con el precio del plan (16-04, fase 1.3)', async () => {
    // Un plan que solo se vende en Norte, en una membresía de Centro sin precio pactado (anterior a DM-05).
    const soloNorte = await crearPlan({ branchIds: [nor] });
    const memberId = await nuevoSocio();
    const db = getDb();
    const ayer = addDays(hoyNegocio(), -1);
    const m = await db.membership.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberId, planId: soloNorte.id, soldAtBranchId: cen, status: 'ACTIVE',
        startDate: addDays(hoyNegocio(), -31), currentPeriodStart: addDays(hoyNegocio(), -31), currentPeriodEnd: ayer,
        billingAnchorDay: ayer.getUTCDate(), autoRenew: true,
      },
    });
    const { rollPeriods } = await import('../src/modules/billing/billing.jobs.js');
    const corrida = await rollPeriods(orgId);
    // Antes: 409 «ya no está disponible en la sucursal de venta» cada noche, y el socio sin poder renovar.
    expect(corrida.errors.filter((e) => e.entityId === m.id)).toEqual([]);
    const despues = await db.membership.findUniqueOrThrow({ where: { id: m.id } });
    expect(despues.currentPeriodStart.getTime()).toBeGreaterThanOrEqual(ayer.getTime());
    const cuotas = await db.charge.findMany({ where: { membershipId: m.id } });
    expect(cuotas.length).toBeGreaterThanOrEqual(1);
    expect(cuotas.every((c) => c.amountCents === 70_000n)).toBe(true);
    expect(await db.auditLog.count({ where: { organizationId: orgId, action: 'membership.sin_renovar', resourceId: m.id } })).toBe(0);
  });

  it('si la cuota no se puede emitir, la membresía NO avanza y queda una sola vez en la bitácora', async () => {
    // La cuota del periodo siguiente ya existe y está ANULADA: no se emite otra encima.
    const plan = await crearPlan();
    const memberId = await nuevoSocio();
    const db = getDb();
    const ayer = addDays(hoyNegocio(), -1);
    const m = await db.membership.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberId, planId: plan.id, soldAtBranchId: cen, status: 'ACTIVE',
        startDate: addDays(hoyNegocio(), -31), currentPeriodStart: addDays(hoyNegocio(), -31), currentPeriodEnd: ayer,
        billingAnchorDay: ayer.getUTCDate(), autoRenew: true, agreedPriceCents: 70_000n,
      },
    });
    const { cycleChargeKey } = await import('@gymflow/core');
    await db.charge.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberId, membershipId: m.id, branchId: cen, chargeType: 'MEMBERSHIP_PERIOD', status: 'VOID',
        concept: 'Cuota anulada de la prueba', subtotalCents: 70_000n, taxCents: 0n, discountCents: 0n, amountCents: 70_000n,
        periodStart: ayer, periodEnd: addDays(ayer, 30), dueDate: ayer, issuedAt: new Date(), voidedAt: new Date(), voidReason: 'Prueba',
        idempotencyKey: cycleChargeKey(m.id, ayer),
      },
    });
    const { rollPeriods } = await import('../src/modules/billing/billing.jobs.js');
    const corrida = await rollPeriods(orgId);
    expect(corrida.errors.some((e) => e.entityId === m.id)).toBe(true);
    const despues = await db.membership.findUniqueOrThrow({ where: { id: m.id } });
    // Antes de 0.6: periodo nuevo, sin cuota y sin mora. Ahora no se movió.
    expect(dia(despues.currentPeriodEnd)).toBe(dia(m.currentPeriodEnd));
    expect(await db.charge.count({ where: { membershipId: m.id, status: { not: 'VOID' } } })).toBe(0);
    expect(await db.membershipEvent.count({ where: { membershipId: m.id, eventType: 'RENEWED' } })).toBe(0);

    await rollPeriods(orgId);
    const asientos = await db.auditLog.findMany({ where: { organizationId: orgId, action: 'membership.sin_renovar', resourceId: m.id } });
    expect(asientos).toHaveLength(1);
  });

  // ── Una sola regla de descuadre (13-05, 14-09) ────────────────────────────

  describe('descuadre por corte', () => {
    let sede: { id: string; code: string };
    const fecha = '2026-03-20';

    beforeAll(async () => {
      sede = await sedeDesechable(orgId, 'Sede de descuadres');
      const db = getDb();
      const userId = (await db.user.findFirstOrThrow({ where: { email: 'gerencia@demo.mx' } })).id;
      const reg = await db.cashRegister.create({ data: { id: uuidv7(), organizationId: orgId, branchId: sede.id, code: 'DQ1', name: 'Caja uno' } });
      const reg2 = await db.cashRegister.create({ data: { id: uuidv7(), organizationId: orgId, branchId: sede.id, code: 'DQ2', name: 'Caja dos' } });
      // Mismo día, misma sede: a la caja uno le faltaron $150 y a la dos le sobraron $200.
      for (const [caja, contado, varianza] of [[reg.id, 85_000n, -15_000n], [reg2.id, 120_000n, 20_000n]] as const) {
        const ses = await db.cashSession.create({
          data: { id: uuidv7(), organizationId: orgId, branchId: sede.id, cashRegisterId: caja, openedByUserId: userId, businessDate: new Date(`${fecha}T00:00:00Z`), status: 'OPEN', openingFloatCents: 100_000n },
        });
        await db.cashSession.update({
          where: { id: ses.id },
          data: { status: 'CLOSED', expectedCashCents: contado - varianza, countedCashCents: contado, varianceCents: varianza, varianceReason: 'Fixture de descuadre', closedByUserId: userId, closedAt: new Date(`${fecha}T23:00:00Z`) },
        });
      }
    });
    afterAll(async () => { await archivarSede(sede.id); });

    it('Movimientos: el faltante resta, el sobrante se informa y no tapa al faltante', async () => {
      const r = (await app.inject({ method: 'GET', url: `/reports/daily?from=${fecha}&to=${fecha}&branchId=${sede.id}`, headers: { cookie: gerencia } })).json();
      const d = r.days[0];
      expect(d).toMatchObject({ shortageCents: '-15000', overageCents: '20000', varianceCents: '5000', netCents: '-15000', profitCents: '-15000' });
    });

    it('Tablero: la utilidad resta el mismo faltante y el sobrante no la sube', async () => {
      const t = (await app.inject({ method: 'GET', url: `/dashboard?from=${fecha}&to=2026-03-21&branchId=${sede.id}&fresh=1`, headers: { cookie: gerencia } })).json();
      expect(t.money.cashExpensesCents).toBe('-15000');
      expect(t.money.cashOverageCents).toBe('20000');
      expect(t.money.profitCents).toBe(String(BigInt(t.money.accruedCents) - 15_000n + BigInt(t.money.fixedExpensesCents)));
    });

    it('Inicio: «Gastos» del mes es la misma suma que Movimientos (gastos + faltantes + fijos)', async () => {
      const p = (await app.inject({ method: 'GET', url: '/reports/pulse?fresh=1', headers: { cookie: gerencia } })).json();
      const m = (await app.inject({ method: 'GET', url: `/reports/daily?from=${p.month.from}&to=${p.month.to}`, headers: { cookie: gerencia } })).json().totals;
      expect(p.month.expensesCents).toBe(String(BigInt(m.expensesCents) + BigInt(m.shortageCents) + BigInt(m.fixedExpensesCents)));
      expect(p.month.cashOverageCents).toBe(m.overageCents);
    });
  });
});
