import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, CONSENTIMIENTOS, aprobacion, asignarAlCoach } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * CATÁLOGO Y VENTA.
 *
 * Hasta aquí los planes solo existían en el sembrado y vender una membresía
 * requería cuatro llamadas en el orden correcto —y nadie las hacía en ese
 * orden: la inscripción no se cobraba nunca—. Estas pruebas fijan el orden
 * que el modelo exige: pendiente → cargos → pago → activa.
 */
describe('catálogo de planes y venta de membresías', () => {
  let app: FastifyInstance;
  let owner: string;
  let recepcion: string;
  let coach: string;
  let branchId: string;
  /** Caja PROPIA de la prueba: la sede acumula cajas abiertas de otras pruebas. */
  let caja: string;

  const codigo = () => `T${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const planBase = (over: Record<string, unknown> = {}) => ({
    code: codigo(), name: 'Plan de prueba', billingModel: 'RECURRING',
    durationUnit: 'MONTH', durationValue: 1, priceCents: '70000', signupFeeCents: '25000',
    branchAccessScope: 'ALL_BRANCHES', reason: 'Alta del plan en el catálogo', ...over,
  });

  async function crearPlan(over: Record<string, unknown> = {}) {
    return app.inject({ method: 'POST', url: '/plans', headers: { cookie: owner }, payload: planBase(over) });
  }

  async function nuevoSocio(): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: owner },
      payload: {
        firstName: nombreUnico('Venta'), lastName: nombreUnico('Plan'),
        phoneE164: telefonoUnico(), homeBranchId: branchId, consents: CONSENTIMIENTOS,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    coach = await loginAs(app, 'coach@demo.mx');
    const { demoBranches } = await orgFixtures();
    branchId = demoBranches.find((b) => b.code === 'CEN')!.id;

    const registro = await app.inject({
      method: 'POST', url: '/cash-registers', headers: { cookie: owner },
      payload: { branchId, code: `V${randomUUID().slice(0, 6).replace(/-/g, '')}`, name: 'Caja de ventas' },
    });
    expect(registro.statusCode, registro.body).toBe(201);
    const sesion = await app.inject({
      method: 'POST', url: '/cash-sessions', headers: { cookie: owner },
      payload: { cashRegisterId: registro.json().id, openingFloatCents: '50000' },
    });
    expect(sesion.statusCode, sesion.body).toBe(201);
    caja = sesion.json().id;
  });

  afterAll(async () => { await app.close(); await closeDb(); });

  // ── Catálogo ──────────────────────────────────────────────────────────────

  it('el dueño crea un plan y queda en la bitácora con su motivo', async () => {
    const res = await crearPlan();
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().priceCents).toBe('70000');

    const log = await getDb().auditLog.findFirstOrThrow({ where: { action: 'catalog.plan.create', resourceId: res.json().id } });
    expect(log.reason).toBe('Alta del plan en el catálogo');
  });

  it('dos planes vigentes no comparten código', async () => {
    const code = codigo();
    expect((await crearPlan({ code })).statusCode).toBe(201);
    const otro = await crearPlan({ code });
    expect(otro.statusCode).toBe(409);
  });

  it('un plan incoherente se rechaza con TODOS sus problemas, no con un 500', async () => {
    const res = await crearPlan({ billingModel: 'VISIT_PACK', durationUnit: 'MONTH', priceCents: '1000' });
    expect(res.statusCode).toBe(422);
    const campos = JSON.parse(res.json().detail).map((i: { field: string }) => i.field);
    expect(campos).toEqual(expect.arrayContaining(['durationUnit', 'visitsIncluded']));
  });

  it('crear o editar planes exige motivo y el permiso del catálogo', async () => {
    expect((await crearPlan({ reason: '' })).statusCode).toBe(422);
    const sinPermiso = await app.inject({ method: 'POST', url: '/plans', headers: { cookie: recepcion }, payload: planBase() });
    expect(sinPermiso.statusCode).toBe(403);
  });

  it('editar el precio guarda el antes y el después', async () => {
    const plan = (await crearPlan()).json();
    const res = await app.inject({
      method: 'PATCH', url: `/plans/${plan.id}`, headers: { cookie: owner },
      payload: { priceCents: '75000', reason: 'Ajuste de precio anual' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().priceCents).toBe('75000');

    const log = await getDb().auditLog.findFirstOrThrow({ where: { action: 'catalog.plan.update', resourceId: plan.id } });
    expect(log.beforeState).toMatchObject({ priceCents: '70000' });
    expect(log.afterState).toMatchObject({ priceCents: '75000' });
  });

  it('el código NO se puede cambiar al editar', async () => {
    const plan = (await crearPlan()).json();
    const res = await app.inject({
      method: 'PATCH', url: `/plans/${plan.id}`, headers: { cookie: owner },
      payload: { code: 'OTRO', name: 'Nombre nuevo', reason: 'Renombrar' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe(plan.code);
    expect(res.json().name).toBe('Nombre nuevo');
  });

  it('un plan desactivado sale del catálogo de venta y ya no se vende', async () => {
    const plan = (await crearPlan()).json();
    await app.inject({
      method: 'PATCH', url: `/plans/${plan.id}`, headers: { cookie: owner },
      payload: { isActive: false, reason: 'Ya no se ofrece' },
    });
    const activos = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie: owner } })).json();
    expect(activos.map((p: { id: string }) => p.id)).not.toContain(plan.id);

    const venta = await app.inject({
      method: 'POST', url: `/members/${await nuevoSocio()}/memberships/sale`, headers: { cookie: owner },
      payload: { planId: plan.id, branchId, payment: null },
    });
    expect(venta.statusCode).toBe(422);
  });

  it('un plan nuevo se vende en TODAS las sucursales si no se dice otra cosa', async () => {
    const plan = (await crearPlan()).json();
    const { demoBranches } = await orgFixtures();
    for (const b of demoBranches.filter((x) => ['CEN', 'NOR', 'FRO'].includes(x.code))) {
      const aqui = (await app.inject({ method: 'GET', url: `/plans?branchId=${b.id}`, headers: { cookie: owner } })).json();
      expect(aqui.map((p: { id: string }) => p.id), b.code).toContain(plan.id);
    }
  });

  it('solo en una sucursal: en otra ni aparece ni se puede vender, y no deja nada a medias', async () => {
    const { demoBranches } = await orgFixtures();
    const norte = demoBranches.find((b) => b.code === 'NOR')!.id;
    const plan = (await crearPlan({ branchIds: [norte] })).json();

    const enCentro = (await app.inject({ method: 'GET', url: `/plans?branchId=${branchId}`, headers: { cookie: owner } })).json();
    expect(enCentro.map((p: { id: string }) => p.id)).not.toContain(plan.id);

    const memberId = await nuevoSocio();
    const venta = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: owner },
      payload: { planId: plan.id, branchId, payment: null },
    });
    expect(venta.statusCode).toBe(409);
    // Sin membresía huérfana: la venta se rechaza antes de crear nada.
    expect(await getDb().membership.count({ where: { memberId } })).toBe(0);

    // Y editando, se abre en Centro también.
    const edit = await app.inject({
      method: 'PATCH', url: `/plans/${plan.id}`, headers: { cookie: owner },
      payload: { branchIds: [norte, branchId], reason: 'Se abre en Centro' },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    const ahora = (await app.inject({ method: 'GET', url: `/plans?branchId=${branchId}`, headers: { cookie: owner } })).json();
    expect(ahora.map((p: { id: string }) => p.id)).toContain(plan.id);
  });

  it('el detalle de un plan con precio especial por sucursal responde (no 500)', async () => {
    const plan = (await crearPlan()).json();
    await getDb().planBranchAvailability.update({
      where: { planId_branchId: { planId: plan.id, branchId } },
      data: { priceOverrideCents: 59_900n },
    });
    const res = await app.inject({ method: 'GET', url: `/plans/${plan.id}`, headers: { cookie: owner } });
    expect(res.statusCode, res.body).toBe(200);
    const aqui = res.json().availability.find((a: { branchId: string }) => a.branchId === branchId);
    expect(aqui.priceOverrideCents).toBe('59900');
    expect(res.json().liveMemberships).toBe(0);

    // Y la cotización en esa sede usa el precio especial.
    const q = (await app.inject({ method: 'GET', url: `/plans/${plan.id}/quote?branchId=${branchId}`, headers: { cookie: owner } })).json();
    expect(q.lines.at(-1).totalCents).toBe('59900');
  });

  // ── Venta ─────────────────────────────────────────────────────────────────

  it('vender y cobrar: inscripción + periodo, pagados, y la membresía ACTIVA', async () => {
    const plan = (await crearPlan()).json();
    const memberId = await nuevoSocio();

    const cotizacion = (await app.inject({ method: 'GET', url: `/plans/${plan.id}/quote?branchId=${branchId}`, headers: { cookie: recepcion } })).json();
    expect(cotizacion.totalCents).toBe('95000');
    expect(cotizacion.lines).toHaveLength(2);

    const res = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: recepcion },
      payload: { planId: plan.id, branchId, payment: { method: 'CARD_TERMINAL', externalRef: 'VOUCHER-123', cashSessionId: caja } },
    });
    expect(res.statusCode, res.body).toBe(201);
    const venta = res.json();
    expect(venta.membership.status).toBe('ACTIVE');
    // La inscripción, que antes nunca se cobraba, ahora está.
    expect(venta.charges.map((c: { chargeType: string }) => c.chargeType).sort()).toEqual(['MEMBERSHIP_PERIOD', 'SIGNUP_FEE']);
    // Lo cotizado es exactamente lo cobrado.
    expect(venta.payment.amountCents).toBe(cotizacion.totalCents);

    const cargos = await getDb().charge.findMany({ where: { memberId } });
    expect(cargos.every((c) => c.status === 'PAID')).toBe(true);
  });

  it('vender SIN cobrar deja la membresía pendiente, y el pago posterior la activa', async () => {
    const plan = (await crearPlan()).json();
    const memberId = await nuevoSocio();

    const venta = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: recepcion },
      payload: { planId: plan.id, branchId, payment: null },
    });
    expect(venta.statusCode, venta.body).toBe(201);
    // No da acceso hasta que se pague: nada de activar "a mano".
    expect(venta.json().membership.status).toBe('PENDING');

    const pago = await app.inject({
      method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: recepcion },
      payload: { idempotencyKey: crypto.randomUUID(), method: 'CARD_TERMINAL', amountCents: venta.json().totalCents, branchId, cashSessionId: caja },
    });
    expect(pago.statusCode, pago.body).toBe(201);

    const m = await getDb().membership.findUniqueOrThrow({ where: { id: venta.json().membership.id } });
    expect(m.status).toBe('ACTIVE');
  });

  it('pagar SOLO la inscripción NO activa: falta la cuota del periodo', async () => {
    const plan = (await crearPlan()).json();
    const memberId = await nuevoSocio();
    const venta = (await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: recepcion },
      payload: { planId: plan.id, branchId, payment: null },
    })).json();
    const inscripcion = venta.charges.find((c: { chargeType: string }) => c.chargeType === 'SIGNUP_FEE');
    const cuota = venta.charges.find((c: { chargeType: string }) => c.chargeType === 'MEMBERSHIP_PERIOD');

    const soloInscripcion = await app.inject({
      method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: recepcion },
      payload: { idempotencyKey: crypto.randomUUID(), method: 'CARD_TERMINAL', amountCents: inscripcion.amountCents, branchId, cashSessionId: caja },
    });
    expect(soloInscripcion.statusCode, soloInscripcion.body).toBe(201);
    const m1 = await getDb().membership.findUniqueOrThrow({ where: { id: venta.membership.id } });
    expect(m1.status).toBe('PENDING');

    await app.inject({
      method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: recepcion },
      payload: { idempotencyKey: crypto.randomUUID(), method: 'CARD_TERMINAL', amountCents: cuota.amountCents, branchId, cashSessionId: caja },
    });
    const m2 = await getDb().membership.findUniqueOrThrow({ where: { id: venta.membership.id } });
    expect(m2.status).toBe('ACTIVE');
  });

  it('recepción ya NO puede activar ni renovar sin cobrar por las rutas viejas', async () => {
    const plan = (await crearPlan()).json();
    const memberId = await nuevoSocio();
    const venta = (await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: recepcion },
      payload: { planId: plan.id, branchId, payment: null },
    })).json();
    const id = venta.membership.id as string;

    for (const ruta of ['activate', 'renew']) {
      const r = await app.inject({
        method: 'POST', url: `/memberships/${id}/${ruta}`, headers: { cookie: recepcion },
        payload: { reason: 'Intento de activar sin cobrar' },
      });
      expect(r.statusCode, `${ruta}: ${r.body}`).toBe(403);
    }
    // El dueño puede corregir, pero con motivo.
    const sinMotivo = await app.inject({ method: 'POST', url: `/memberships/${id}/activate`, headers: { cookie: owner } });
    expect(sinMotivo.statusCode).toBe(422);
    const m = await getDb().membership.findUniqueOrThrow({ where: { id } });
    expect(m.status).toBe('PENDING');
  });

  it('el comprobante dice qué pagó, a qué se aplicó y su folio', async () => {
    const plan = (await crearPlan()).json();
    const memberId = await nuevoSocio();
    const venta = (await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: recepcion },
      payload: { planId: plan.id, branchId, payment: { method: 'CARD_TERMINAL', cashSessionId: caja } },
    })).json();
    const r = await app.inject({ method: 'GET', url: `/payments/${venta.payment.id}/receipt`, headers: { cookie: recepcion } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().payment.amountCents).toBe('95000');
    expect(r.json().payment.folio).toBeTruthy();
    expect(r.json().lines).toHaveLength(2);
    expect(r.json().member.memberCode).toBeTruthy();
  });

  it('revertir el cobro que activó una membresía la pasa a mora: ya no está pagada', async () => {
    const plan = (await crearPlan()).json();
    const memberId = await nuevoSocio();
    const venta = (await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: recepcion },
      payload: { planId: plan.id, branchId, payment: { method: 'CARD_TERMINAL', cashSessionId: caja } },
    })).json();
    expect(venta.membership.status).toBe('ACTIVE');
    const rev = await app.inject({
      method: 'POST', url: `/payments/${venta.payment.id}/reverse`, headers: { cookie: owner },
      payload: { reason: 'Se cobró al socio equivocado', cashSessionId: caja, approvalToken: await aprobacion(app, owner, 'payments:reverse', undefined, undefined, { resourceId: venta.payment.id, amountCents: venta.payment.amountCents }) },
    });
    expect(rev.statusCode, rev.body).toBe(201);
    const m = await getDb().membership.findUniqueOrThrow({ where: { id: venta.membership.id } });
    expect(m.status).toBe('PAST_DUE');
  });

  it('un cobro de mostrador NO se reembolsa por el procesador: se revierte', async () => {
    const plan = (await crearPlan()).json();
    const memberId = await nuevoSocio();
    const venta = (await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: recepcion },
      payload: { planId: plan.id, branchId, payment: { method: 'CARD_TERMINAL', cashSessionId: caja } },
    })).json();
    const r = await app.inject({
      method: 'POST', url: `/payments/${venta.payment.id}/refund`, headers: { cookie: owner },
      payload: { amountCents: '1000', reason: 'Prueba', approvalToken: await aprobacion(app, owner, 'payments:refund', undefined, undefined, { resourceId: venta.payment.id, amountCents: '1000' }) },
    });
    expect(r.statusCode).toBe(422);
  });

  it('no se vende una segunda membresía vigente', async () => {
    const plan = (await crearPlan()).json();
    const memberId = await nuevoSocio();
    const vender = () => app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: recepcion },
      payload: { planId: plan.id, branchId, payment: null },
    });
    expect((await vender()).statusCode).toBe(201);
    expect((await vender()).statusCode).toBe(409);
  });

  it('quien no puede vender, no vende', async () => {
    const plan = (await crearPlan()).json();
    // Un socio SUYO: aun así, el coach no vende.
    const suyo = await nuevoSocio();
    await asignarAlCoach(suyo);
    const res = await app.inject({
      method: 'POST', url: `/members/${suyo}/memberships/sale`, headers: { cookie: coach },
      payload: { planId: plan.id, branchId, payment: null },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── Renovar y cambiar de plan: cobrando ───────────────────────────────────

  /** Socio con membresía vendida y pagada que arrancó hace `dias` días. */
  async function conMembresia(planId: string, dias: number) {
    const memberId = await nuevoSocio();
    // El día de negocio es el de México, no el de UTC: después de las 18:00
    // de CDMX la fecha UTC ya es mañana y el conteo de días se corre uno.
    const inicio = new Date(Date.now() - dias * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const venta = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: owner },
      payload: { reason: 'Fixture: periodo ya corrido', planId, branchId, startDate: inicio, payment: { method: 'CARD_TERMINAL', cashSessionId: caja } },
    });
    expect(venta.statusCode, venta.body).toBe(201);
    return { memberId, membershipId: venta.json().membership.id as string, periodoFin: venta.json().membership.currentPeriodEnd as string };
  }

  it('renovar COBRA el periodo siguiente: antes regalaba uno entero', async () => {
    const plan = (await crearPlan({ signupFeeCents: '0' })).json();
    const { membershipId, periodoFin } = await conMembresia(plan.id, 5);

    const res = await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/renewal`, headers: { cookie: recepcion },
      payload: { expectedPeriodStart: (await getDb().membership.findUniqueOrThrow({ where: { id: membershipId } })).currentPeriodStart.toISOString().slice(0, 10), payment: { method: 'CARD_TERMINAL', cashSessionId: caja } },
    });
    expect(res.statusCode, res.body).toBe(200);
    // El periodo nuevo arranca donde terminaba el anterior.
    expect(res.json().membership.currentPeriodStart).toBe(periodoFin);
    expect(res.json().charge.amountCents).toBe('70000');
    expect(res.json().charge.status).toBe('PAID');
  });

  it('renovar es IDEMPOTENTE: el reintento con el mismo periodo no cobra otro', async () => {
    const plan = (await crearPlan({ signupFeeCents: '0' })).json();
    const { membershipId } = await conMembresia(plan.id, 5);
    const antes = await getDb().membership.findUniqueOrThrow({ where: { id: membershipId } });
    const visto = antes.currentPeriodStart.toISOString().slice(0, 10);
    const renovar = () => app.inject({
      method: 'POST', url: `/memberships/${membershipId}/renewal`, headers: { cookie: recepcion },
      payload: { payment: null, expectedPeriodStart: visto },
    });
    expect((await renovar()).statusCode).toBe(200);
    const reintento = await renovar();
    expect(reintento.statusCode).toBe(409);
    const cuotas = await getDb().charge.count({ where: { membershipId, chargeType: 'MEMBERSHIP_PERIOD' } });
    expect(cuotas).toBe(2); // la de la venta y UNA renovación
  });

  it('renovar sin cobrar deja el cargo pendiente', async () => {
    const plan = (await crearPlan({ signupFeeCents: '0' })).json();
    const { membershipId } = await conMembresia(plan.id, 5);
    const res = await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/renewal`, headers: { cookie: recepcion },
      payload: { payment: null, expectedPeriodStart: (await getDb().membership.findUniqueOrThrow({ where: { id: membershipId } })).currentPeriodStart.toISOString().slice(0, 10) },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(['OPEN', 'OVERDUE']).toContain(res.json().charge.status);
  });

  it('cambiar de plan cobra el nuevo y acredita lo pagado y no usado', async () => {
    const barato = (await crearPlan({ priceCents: '60000', signupFeeCents: '0', durationUnit: 'DAY', durationValue: 30 })).json();
    const caro = (await crearPlan({ priceCents: '90000', signupFeeCents: '0' })).json();
    // Pagó 30 días del barato y lleva 10 usados.
    const { membershipId } = await conMembresia(barato.id, 10);

    const res = await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/plan-change`, headers: { cookie: owner },
      payload: { planId: caro.id, reason: 'Quiere entrar a todas las sucursales', payment: { method: 'CARD_TERMINAL', cashSessionId: caja } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.membership.planId).toBe(caro.id);
    expect(r.proration).toMatchObject({ cycleDays: 30, usedDays: 10, remainingDays: 20 });
    // 20/30 de $600 = $400 de crédito sobre el cargo de $900.
    expect(r.creditCents).toBe('40000');
    expect(r.charge.amountCents).toBe('90000');
    expect(r.payment.amountCents).toBe('50000');
    expect(r.charge.status).toBe('PAID');
  });

  it('el mismo día de la venta, cambiar de plan se rechaza con la salida correcta', async () => {
    const a = (await crearPlan({ signupFeeCents: '0' })).json();
    const b = (await crearPlan({ signupFeeCents: '0' })).json();
    const { membershipId } = await conMembresia(a.id, 0);
    const res = await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/plan-change`, headers: { cookie: owner },
      payload: { planId: b.id, reason: 'Se vendió el plan equivocado', payment: null },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/cancela esta membresía/);
  });

  it('tras renovar por adelantado, cambiar de plan lo explica en vez de pedir cancelar', async () => {
    const a = (await crearPlan({ signupFeeCents: '0' })).json();
    const b = (await crearPlan({ signupFeeCents: '0' })).json();
    const { membershipId } = await conMembresia(a.id, 5);
    await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/renewal`, headers: { cookie: recepcion }, payload: { payment: null, expectedPeriodStart: (await getDb().membership.findUniqueOrThrow({ where: { id: membershipId } })).currentPeriodStart.toISOString().slice(0, 10) },
    });
    const res = await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/plan-change`, headers: { cookie: owner },
      payload: { planId: b.id, reason: 'Cambio', payment: null },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/renovada por adelantado/);
  });
});

