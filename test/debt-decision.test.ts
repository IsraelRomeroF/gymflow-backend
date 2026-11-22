import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7, normalizedNameKey, cycleChargeKey } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * SUSPENDIDA QUE VUELVE MESES DESPUÉS.
 *
 * Mientras está suspendida el job no la renueva: su periodo se queda en el
 * mes en que dejó de pagar. Cuando vuelve, el dueño decide si se le cobran
 * los meses que no vino (reanudar) o se le perdonan (olvidar).
 */
describe('adeudo de una suspendida', () => {
  let app: FastifyInstance;
  let owner: string;
  let recepcion: string;
  let gerente: string;
  let orgId: string;
  let branchId: string;

  const dia = (d: Date) => d.toISOString().slice(0, 10);
  const mesesAtras = (n: number) => {
    // "Hoy" del gimnasio, no de UTC: por la noche en México UTC ya es mañana y
    // la cuenta de periodos atrasados salía con uno menos.
    const hoy = new Date(`${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })}T00:00:00.000Z`);
    return new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - n, Math.min(hoy.getUTCDate(), 28)));
  };

  /**
   * Socio con plan mensual suspendido hace `meses`: la cuota de aquel
   * periodo sigue abierta y no hay ninguna más.
   */
  async function suspendidaDesdeHace(meses: number) {
    const db = getDb();
    const nombre = nombreUnico('Vuelve');
    const socio = await db.member.create({
      data: {
        id: uuidv7(), organizationId: orgId,
        memberCode: `VUE-${Date.now() % 1_000_000}-${Math.floor(Math.random() * 999)}`,
        firstName: nombre, lastName: nombreUnico('Tarde'),
        nameKey: normalizedNameKey(`${nombre} tarde`), homeBranchId: branchId, joinedAt: new Date(),
      },
    });
    const plan = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie: owner } }))
      .json().find((p: { code: string }) => p.code === 'MEN');
    const mem = await app.inject({
      method: 'POST', url: `/members/${socio.id}/memberships`, headers: { cookie: owner },
      payload: { reason: 'Fixture de prueba', planId: plan.id, soldAtBranchId: branchId },
    });
    expect(mem.statusCode, mem.body).toBe(201);
    const id = mem.json().id as string;
    await app.inject({ method: 'POST', url: `/memberships/${id}/activate`, headers: { cookie: owner }, payload: { reason: 'Fixture' } });
    const cargo = await app.inject({ method: 'POST', url: `/memberships/${id}/period-charge`, headers: { cookie: owner } });
    expect(cargo.statusCode, cargo.body).toBe(201);

    // Se lleva todo al pasado: el periodo, su cuota y la clave de la cuota.
    const inicio = mesesAtras(meses);
    const fin = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() + 1, inicio.getUTCDate()));
    await db.membership.update({
      where: { id },
      data: { status: 'SUSPENDED', currentPeriodStart: inicio, currentPeriodEnd: fin, billingAnchorDay: inicio.getUTCDate(), startDate: inicio },
    });
    await db.charge.update({
      where: { id: cargo.json().id },
      data: { periodStart: inicio, periodEnd: fin, dueDate: inicio, status: 'OVERDUE', idempotencyKey: cycleChargeKey(id, inicio) },
    });
    return { memberId: socio.id, membershipId: id, chargeId: cargo.json().id as string, inicio };
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    gerente = await loginAs(app, 'gerente@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    branchId = f.demoBranches[0]!.id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('muestra lo que cuesta cada decisión antes de elegir', async () => {
    const { membershipId } = await suspendidaDesdeHace(3);
    const r = await app.inject({ method: 'GET', url: `/memberships/${membershipId}/debt-options`, headers: { cookie: recepcion } });
    expect(r.statusCode, r.body).toBe(200);
    const o = r.json();
    expect(o.openCharges).toHaveLength(1);
    // Tres meses atrás: los dos intermedios y el que contiene hoy.
    expect(o.missedPeriods).toHaveLength(3);
    expect(BigInt(o.resumeTotalCents)).toBe(BigInt(o.openCents) + 3n * BigInt(o.periodCents));
    expect(o.forgiveNewPeriod.start).toBe(o.today);
  });

  it('REANUDAR emite una cuota por periodo y, pagando todo, la reactiva', async () => {
    const { memberId, membershipId, inicio } = await suspendidaDesdeHace(3);
    const r = await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/debt-decision`, headers: { cookie: recepcion },
      payload: { decision: 'RESUME', reason: 'Acepta pagar los meses', payment: { method: 'SPEI_TRANSFER', externalRef: 'SPEI-REANUDA' } },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().charges).toHaveLength(4);
    expect(r.json().payment.status).toBe('SUCCEEDED');
    expect(r.json().membership.status).toBe('ACTIVE');

    const cuotas = await getDb().charge.findMany({ where: { membershipId, chargeType: 'MEMBERSHIP_PERIOD' }, orderBy: { periodStart: 'asc' } });
    expect(cuotas.map((c) => c.status)).toEqual(['PAID', 'PAID', 'PAID', 'PAID']);
    expect(dia(cuotas[0]!.periodStart!)).toBe(dia(inicio));
    // El ancla no se movió: todas empiezan el mismo día del mes.
    expect(new Set(cuotas.map((c) => c.periodStart!.getUTCDate())).size).toBe(1);
    const socio = await getDb().member.findUniqueOrThrow({ where: { id: memberId } });
    expect(socio.balanceCentsCached).toBe(0n);

    const ev = await getDb().membershipEvent.findFirst({ where: { membershipId, eventType: 'DEBT_RESUMED' } });
    expect(ev?.reason).toBe('Acepta pagar los meses');
  });

  it('REANUDAR sin cobrar deja las cuotas pendientes y sigue suspendida', async () => {
    const { membershipId } = await suspendidaDesdeHace(2);
    const r = await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/debt-decision`, headers: { cookie: recepcion },
      payload: { decision: 'RESUME', reason: 'Paga la próxima semana' },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().membership.status).toBe('SUSPENDED');
    expect(r.json().charges).toHaveLength(3);

    // Un segundo clic no emite los periodos otra vez: ya está decidido y solo
    // devuelve el adeudo para cobrarlo (BE2-05).
    const otra = await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/debt-decision`, headers: { cookie: recepcion },
      payload: { decision: 'RESUME', reason: 'Paga la próxima semana' },
    });
    expect(otra.statusCode, otra.body).toBe(200);
    expect(otra.json().charges).toHaveLength(3);
    expect(await getDb().charge.count({ where: { membershipId } })).toBe(3);
  });

  it('si el cobro no se puede hacer, la decisión NO se aplica a medias (BE2-05)', async () => {
    const { membershipId, inicio } = await suspendidaDesdeHace(2);
    const r = await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/debt-decision`, headers: { cookie: recepcion },
      payload: { decision: 'RESUME', reason: 'Paga hoy', payment: { method: 'CASH', cashSessionId: '00000000-0000-7000-8000-000000000000' } },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    const m = await getDb().membership.findUniqueOrThrow({ where: { id: membershipId } });
    expect(dia(m.currentPeriodStart)).toBe(dia(inicio));
    expect(await getDb().charge.count({ where: { membershipId } })).toBe(1);
  });

  it('OLVIDAR es del gerente o el dueño, y aun así con una segunda autorización', async () => {
    const { membershipId } = await suspendidaDesdeHace(2);
    const desdeRecepcion = await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/debt-decision`, headers: { cookie: recepcion },
      payload: { decision: 'FORGIVE', reason: 'Vuelve tras lesión' },
    });
    expect(desdeRecepcion.statusCode).toBe(403);
    const r = await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/debt-decision`, headers: { cookie: gerente },
      payload: { decision: 'FORGIVE', reason: 'Vuelve tras lesión' },
    });
    expect(r.statusCode).toBe(428);
    const m = await getDb().membership.findUniqueOrThrow({ where: { id: membershipId } });
    expect(m.status).toBe('SUSPENDED');
    expect(await getDb().chargeAdjustment.count({ where: { charge: { membershipId } } })).toBe(0);
  });

  it('OLVIDAR condona lo que debía y arranca un periodo hoy; paga solo ese', async () => {
    const { memberId, membershipId, chargeId } = await suspendidaDesdeHace(3);
    const debe = (await app.inject({ method: 'GET', url: `/memberships/${membershipId}/debt-options`, headers: { cookie: gerente } })).json();
    const token = await aprobacion(app, gerente, 'billing:waiver:apply', 'owner@demo.mx', branchId, { resourceId: membershipId, amountCents: debe.openCents });
    const r = await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/debt-decision`, headers: { cookie: gerente },
      payload: {
        decision: 'FORGIVE', reason: 'Vuelve tras lesión', approvalToken: token,
        payment: { method: 'SPEI_TRANSFER', externalRef: 'SPEI-OLVIDA' },
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.membership.status).toBe('ACTIVE');
    expect(body.charges).toHaveLength(1);
    expect(BigInt(body.forgivenCents)).toBeGreaterThan(0n);

    const viejo = await getDb().charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(viejo.adjustedCents).toBe(viejo.amountCents);
    const ajuste = await getDb().chargeAdjustment.findFirstOrThrow({ where: { chargeId } });
    expect(ajuste.adjustmentType).toBe('WAIVER');
    expect(ajuste.approvedByUserId).not.toBeNull();

    const m = await getDb().membership.findUniqueOrThrow({ where: { id: membershipId } });
    expect(dia(m.currentPeriodStart)).toBe(body.charges[0].periodStart.slice(0, 10));
    expect(m.billingAnchorDay).toBe(m.currentPeriodStart.getUTCDate());
    const socio = await getDb().member.findUniqueOrThrow({ where: { id: memberId } });
    expect(socio.balanceCentsCached).toBe(0n);
  });

  it('una membresía que no está suspendida no tiene esta decisión', async () => {
    const { membershipId } = await suspendidaDesdeHace(1);
    await getDb().membership.update({ where: { id: membershipId }, data: { status: 'PAST_DUE' } });
    const r = await app.inject({ method: 'GET', url: `/memberships/${membershipId}/debt-options`, headers: { cookie: recepcion } });
    expect(r.statusCode).toBe(409);
  });
});
