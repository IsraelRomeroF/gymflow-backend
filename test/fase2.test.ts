import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { PaymentRepository } from '../src/modules/billing/payment.repository.js';
import { IntakeService } from '../src/modules/intake/intake.service.js';

/** Auditoría 6, fase 2: el ciclo de vida de la membresía se cierra y el saldo a favor se usa. */
describe('fase 2 · ciclo de vida y saldo a favor', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let orgId: string;
  let cen: string;
  let planId: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
    const planes = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie: gerencia } })).json();
    planId = planes.find((p: { code: string }) => p.code === 'MEN').id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  async function socio(): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Fdos'), lastName: nombreUnico('Ciclo'), homeBranchId: cen, force: true, consents: CONSENTIMIENTOS },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }
  async function ventaSinCobro(memberId: string): Promise<string> {
    const r = await app.inject({ method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: gerencia }, payload: { planId, branchId: cen, payment: null } });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().membership.id as string;
  }
  const deuda = async (memberId: string) => BigInt((await app.inject({ method: 'GET', url: `/members/${memberId}/statement`, headers: { cookie: gerencia } })).json().outstandingCents);

  it('DM-03 · cancelar una membresía anula sus cuotas sin pagar: la cartera no las ve', async () => {
    const id = await socio();
    const m = await ventaSinCobro(id);
    expect(await deuda(id)).toBeGreaterThan(0n);
    const r = await app.inject({ method: 'POST', url: `/memberships/${m}/cancel`, headers: { cookie: gerencia }, payload: { reason: 'Se mudó de ciudad' } });
    expect(r.statusCode, r.body).toBe(200);
    const cargos = await getDb().charge.findMany({ where: { membershipId: m } });
    expect(cargos.length).toBeGreaterThan(0);
    expect(cargos.every((c) => c.status === 'VOID')).toBe(true);
    expect(await deuda(id)).toBe(0n);
  });

  it('DM-07 · una venta que nunca se cobró se cancela sola a los 14 días', async () => {
    const id = await socio();
    const m = await ventaSinCobro(id);
    await getDb().$executeRaw`UPDATE "memberships" SET "createdAt" = now() - interval '20 days' WHERE "id" = ${m}::uuid`;
    const { expirePendingSales } = await import('../src/modules/memberships/membership.jobs.js');
    await expirePendingSales(orgId);
    const tras = await getDb().membership.findUniqueOrThrow({ where: { id: m } });
    expect(tras.status).toBe('CANCELED');
    expect(await deuda(id)).toBe(0n);
    // Y el socio puede comprar otra.
    expect((await app.inject({ method: 'POST', url: `/members/${id}/memberships/sale`, headers: { cookie: gerencia }, payload: { planId, branchId: cen, payment: null } })).statusCode).toBe(201);
  });

  it('DM-07 · una suspendida que lleva 90 días sin pagar termina (y la deuda se queda)', async () => {
    const id = await socio();
    const m = await ventaSinCobro(id);
    await getDb().$executeRaw`UPDATE "memberships" SET "status" = 'SUSPENDED', "graceUntil" = NULL, "updatedAt" = now() - interval '100 days' WHERE "id" = ${m}::uuid`;
    const { expireSuspended } = await import('../src/modules/memberships/membership.jobs.js');
    await expireSuspended(orgId);
    expect((await getDb().membership.findUniqueOrThrow({ where: { id: m } })).status).toBe('EXPIRED');
    expect(await deuda(id)).toBeGreaterThan(0n);
  });

  it('DM-07 · demasiados periodos sin pagar: "decidir adeudo" responde 409, no 500', async () => {
    const id = await socio();
    const m = await ventaSinCobro(id);
    await getDb().$executeRaw`UPDATE "memberships" SET "status" = 'SUSPENDED', "graceUntil" = NULL, "currentPeriodStart" = now()::date - 1500, "currentPeriodEnd" = now()::date - 1470, "startDate" = now()::date - 1500 WHERE "id" = ${m}::uuid`;
    const r = await app.inject({ method: 'GET', url: `/memberships/${m}/debt-options`, headers: { cookie: gerencia } });
    expect(r.statusCode).toBe(409);
  });

  it('DM-02 · el saldo a favor cubre la siguiente cuota sin que nadie lo cobre', async () => {
    const id = await socio();
    const hoy = new Date();
    const credito = await new PaymentRepository(orgId).record({ memberId: id, branchId: cen, method: 'CREDIT_NOTE', amountCents: 20_000n, businessDate: hoy, idempotencyKey: `favor-${id}` });
    expect(credito.unappliedCents).toBe(20_000n);
    const m = await ventaSinCobro(id);
    // Se aplica a lo más antiguo primero (inscripción y cuota vencen el mismo día): lo que importa es el total.
    const cargos = await getDb().charge.findMany({ where: { membershipId: m } });
    expect(cargos.reduce((a, c) => a + c.allocatedCents, 0n)).toBe(20_000n);
    expect((await getDb().payment.findUniqueOrThrow({ where: { id: credito.payment.id } })).unappliedCents).toBe(0n);
    expect(await deuda(id)).toBe(cargos.reduce((a, c) => a + c.amountCents, 0n) - 20_000n);
  });

  // ── El socio y sus datos ──────────────────────────────────────────────────

  async function telefonoDelPortal(memberId: string): Promise<string> {
    const invite = await app.inject({ method: 'POST', url: `/members/${memberId}/portal-invite`, headers: { cookie: gerencia } });
    expect(invite.statusCode, invite.body).toBe(201);
    const enroll = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code } });
    expect(enroll.statusCode, enroll.body).toBe(201);
    return `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}`;
  }

  it('PS-05 · un cargo anulado no aparece como pendiente en el estado de cuenta del socio', async () => {
    const id = await socio();
    const m = await ventaSinCobro(id);
    const portal = await telefonoDelPortal(id);
    const antes = (await app.inject({ method: 'GET', url: '/portal/statement', headers: { cookie: portal } })).json();
    expect(antes.charges.some((c: { balanceCents: string }) => BigInt(c.balanceCents) > 0n)).toBe(true);
    await app.inject({ method: 'POST', url: `/memberships/${m}/cancel`, headers: { cookie: gerencia }, payload: { reason: 'Se arrepintió' } });
    const despues = (await app.inject({ method: 'GET', url: '/portal/statement', headers: { cookie: portal } })).json();
    expect(despues.charges.length).toBeGreaterThan(0);
    for (const c of despues.charges) {
      expect(c.status).toBe('VOID');
      expect(c.balanceCents).toBe('0');
    }
    expect(despues.outstandingCents).toBe('0');
  });

  it('PS-02 · "cerrar en todos" cierra los demás teléfonos; recepción también puede desde la ficha', async () => {
    const id = await socio();
    const viejo = await telefonoDelPortal(id);
    expect((await app.inject({ method: 'GET', url: '/portal/sessions', headers: { cookie: viejo } })).json().active).toBe(1);
    expect((await app.inject({ method: 'GET', url: `/members/${id}/portal-sessions`, headers: { cookie: gerencia } })).json().active).toBe(1);

    // Un segundo teléfono es legítimo: el código nuevo no cierra el primero.
    const nuevo = await telefonoDelPortal(id);
    expect((await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie: viejo } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/portal/sessions', headers: { cookie: nuevo } })).json().active).toBe(2);

    // Perdió uno: desde el otro cierra todos, incluido el que usa.
    const todos = await app.inject({ method: 'POST', url: '/portal/logout-all', headers: { cookie: nuevo }, payload: {} });
    expect(todos.statusCode, todos.body).toBe(200);
    expect(todos.json().revoked).toBe(2);
    expect((await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie: viejo } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie: nuevo } })).statusCode).toBe(401);

    // Y recepción también puede cerrarlo todo desde la ficha.
    const otro = await telefonoDelPortal(id);
    const r = await app.inject({ method: 'POST', url: `/members/${id}/portal-sessions/revoke`, headers: { cookie: gerencia }, payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().revoked).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie: otro } })).statusCode).toBe(401);
    expect(await getDb().auditLog.count({ where: { action: 'portal.sessions.revoke', resourceId: id } })).toBe(1);
  });

  it('PS-04 · un exsocio sale en los duplicados y se reactiva con su misma ficha', async () => {
    const nombre = nombreUnico('Vuelve'); const apellido = nombreUnico('Otravez');
    const alta = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombre, lastName: apellido, homeBranchId: cen, force: true, consents: CONSENTIMIENTOS },
    });
    const id = alta.json().id as string; const codigo = alta.json().memberCode as string;
    expect((await app.inject({ method: 'POST', url: `/members/${id}/reactivate`, headers: { cookie: gerencia }, payload: { reason: 'Prueba' } })).statusCode).toBe(409);

    await app.inject({ method: 'POST', url: `/members/${id}/archive`, headers: { cookie: gerencia }, payload: { reason: 'Se fue a otro gimnasio' } });
    const dup = await app.inject({ method: 'POST', url: '/members/check-duplicates', headers: { cookie: gerencia }, payload: { firstName: nombre, lastName: apellido } });
    expect(dup.json().candidates.map((c: { candidateId: string }) => c.candidateId)).toContain(id);

    const r = await app.inject({ method: 'POST', url: `/members/${id}/reactivate`, headers: { cookie: gerencia }, payload: { reason: 'Regresó al gimnasio' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().status).toBe('INACTIVE');
    expect(r.json().memberCode).toBe(codigo);
    const ficha = (await app.inject({ method: 'GET', url: `/members/${id}`, headers: { cookie: gerencia } })).json();
    expect(ficha.status).toBe('INACTIVE');
    expect(await getDb().auditLog.count({ where: { action: 'member.reactivate', resourceId: id } })).toBe(1);
  });

  it('PS-09 · con la bandeja llena, el formulario público manda a recepción', async () => {
    await expect(new IntakeService().submit(orgId, {
      branchId: cen, draft: { firstName: 'X', lastName: 'Y' } as never, accepted: [], ip: null, userAgent: null, maxPendientes: 0,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  // ── Dinero ────────────────────────────────────────────────────────────────

  it('DM-05 · el precio pactado al vender manda sobre el de lista en todas las cuotas', async () => {
    const id = await socio();
    // Sin permiso de descuento ni motivo, un precio distinto no pasa.
    const sinMotivo = await app.inject({ method: 'POST', url: `/members/${id}/memberships/sale`, headers: { cookie: gerencia }, payload: { planId, branchId: cen, agreedPriceCents: '55000', payment: null } });
    expect(sinMotivo.statusCode, sinMotivo.body).toBe(422);
    const r = await app.inject({
      method: 'POST', url: `/members/${id}/memberships/sale`, headers: { cookie: gerencia },
      payload: { planId, branchId: cen, agreedPriceCents: '55000', reason: 'Precio de convenio con su empresa', payment: null },
    });
    expect(r.statusCode, r.body).toBe(201);
    const m = r.json().membership.id as string;
    const cuota = await getDb().charge.findFirstOrThrow({ where: { membershipId: m, chargeType: 'MEMBERSHIP_PERIOD' } });
    expect(cuota.amountCents).toBe(55_000n);
    expect((await getDb().membership.findUniqueOrThrow({ where: { id: m } })).agreedPriceCents).toBe(55_000n);

    // La siguiente cuota también va al precio pactado, aunque el de lista sea otro.
    const { BillingService } = await import('../src/modules/billing/billing.service.js');
    const ctx = { requestId: 't', ip: null, userAgent: null, tenant: { organizationId: orgId, actorType: 'SYSTEM', actorUserId: null, grants: [], limits: {}, branchScopeHint: null, requestId: 't' } } as never;
    const fin = cuota.periodEnd!;
    const sig = await new BillingService().createPeriodCharge(ctx, { membershipId: m, period: { start: fin, end: new Date(fin.getTime() + 30 * 86_400_000) } });
    expect(sig.created).toBe(true);
    expect(sig.charge.amountCents).toBe(55_000n);
    // Y el portal le dice al socio lo que de verdad pagará.
    expect(await deuda(id)).toBeGreaterThan(0n);
  });

  it('DM-05 · sin precio pactado, la venta deja escrito el precio vigente', async () => {
    const id = await socio();
    const m = await ventaSinCobro(id);
    const fila = await getDb().membership.findUniqueOrThrow({ where: { id: m }, include: { plan: true } });
    expect(fila.agreedPriceCents).not.toBeNull();
    expect(fila.agreedPriceCents).toBe(fila.plan.priceCents);
  });

  it('DM-10 · un movimiento de caja lleva su propio día de negocio', async () => {
    const cajas = (await app.inject({ method: 'GET', url: `/cash-registers?branchId=${cen}`, headers: { cookie: gerencia } })).json().registers as Array<{ id: string }>;
    const abierta = await app.inject({ method: 'POST', url: '/cash-sessions', headers: { cookie: gerencia }, payload: { cashRegisterId: cajas[0]!.id, openingFloatCents: '50000' } });
    expect([200, 201, 409]).toContain(abierta.statusCode);
    const sesiones = (await app.inject({ method: 'GET', url: `/cash-sessions?branchId=${cen}&status=OPEN`, headers: { cookie: gerencia } })).json().sessions as Array<{ id: string }>;
    const sesion = sesiones[0]!.id;
    const mov = await app.inject({ method: 'POST', url: `/cash-sessions/${sesion}/movements`, headers: { cookie: gerencia }, payload: { movementType: 'FLOAT_IN', amountCents: '1500', reason: 'Monedas para cambio' } });
    expect(mov.statusCode, mov.body).toBe(201);
    const fila = await getDb().cashMovement.findUniqueOrThrow({ where: { id: mov.json().id } });
    expect(fila.businessDate).toBeInstanceOf(Date);
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    expect(fila.businessDate.toISOString().slice(0, 10)).toBe(hoy);
  });

  it('DM-10 · un sobrante de caja se informa pero no cuenta como ganancia', async () => {
    const { MovementsService } = await import('../src/modules/analytics/movements.service.js');
    const svc = new MovementsService();
    const hoy = new Date(); hoy.setUTCHours(0, 0, 0, 0);
    const manana = new Date(hoy.getTime() + 86_400_000);
    const r = await svc.resumen(orgId, hoy, manana, null);
    // Con sobrante o sin él, lo neto nunca supera lo que entró menos lo que
    // salió, y el faltante se cuenta CORTE POR CORTE (auditoría 8, 13-05).
    for (const d of r.days) {
      expect(d.shortageCents <= 0n && d.overageCents >= 0n).toBe(true);
      expect(d.shortageCents + d.overageCents).toBe(d.varianceCents);
      expect(d.netCents).toBe(d.incomeCents + d.refundsCents + d.expensesCents + d.shortageCents);
    }
  });
});
