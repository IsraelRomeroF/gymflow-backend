import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { addDays, uuidv7, normalizedNameKey, cycleChargeKey } from '@gymflow/core';
import { RecordPaymentResult, MemberMemberships, diferenciasConElContrato } from '@gymflow/core/contracts';
import { makeApp, loginAs, orgFixtures, nombreUnico, sedeDesechable, archivarSede } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { BillingService } from '../src/modules/billing/billing.service.js';
import { AuditRepository } from '../src/platform/audit/audit.repository.js';
import { systemContext } from '../src/platform/jobs/types.js';
import { registeredRoutes } from '../src/platform/http/registry.js';

/**
 * FASE 1 · BLOQUE 1.3 · «DINERO».
 *
 * Lo que mueve dinero ocurre completo o no ocurre (con su asiento dentro), no
 * se repite por un doble envío, y la cuota sale de una sola regla.
 */
describe('dinero · fase 1.3', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let orgId: string;
  let sede: { id: string; code: string };
  let planId: string;
  let cajaId: string;
  let turno: string;

  const hoyNegocio = () => new Date(`${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })}T00:00:00.000Z`);
  const dia = (d: Date) => d.toISOString().slice(0, 10);
  const spei = () => ({ method: 'SPEI_TRANSFER', externalRef: `SPEI${randomUUID().slice(0, 8)}` });

  async function socio(): Promise<string> {
    const nombre = nombreUnico('Unidad');
    const m = await getDb().member.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberCode: `UNI-${randomUUID().slice(0, 10)}`,
        firstName: nombre, lastName: nombreUnico('Dinero'), nameKey: normalizedNameKey(`${nombre} dinero`),
        homeBranchId: sede.id, joinedAt: new Date(),
      },
    });
    return m.id;
  }
  async function cargoAbierto(memberId: string, cents = 10_000n): Promise<string> {
    const c = await getDb().charge.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberId, branchId: sede.id, chargeType: 'MANUAL_ADJUSTMENT', status: 'OPEN',
        concept: 'Cargo de la prueba 1.3', subtotalCents: cents, taxCents: 0n, discountCents: 0n, amountCents: cents,
        dueDate: hoyNegocio(), issuedAt: new Date(),
      },
    });
    return c.id;
  }
  async function crearPlan(over: Record<string, unknown> = {}): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/plans', headers: { cookie: gerencia },
      payload: {
        code: `U${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`, name: 'Plan de la prueba 1.3', billingModel: 'RECURRING',
        durationUnit: 'MONTH', durationValue: 1, priceCents: '60000', signupFeeCents: '0', branchAccessScope: 'ALL_BRANCHES',
        reason: 'Plan de la prueba del bloque 1.3', ...over,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id;
  }
  async function vender(memberId: string, plan = planId, extra: Record<string, unknown> = {}) {
    const r = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: gerencia },
      payload: { planId: plan, branchId: sede.id, saleKey: `venta-${randomUUID()}`, payment: spei(), ...extra },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { membership: { id: string; currentPeriodStart: string } };
  }
  async function abrirTurno(): Promise<string> {
    const r = await app.inject({ method: 'POST', url: '/cash-sessions', headers: { cookie: gerencia }, payload: { cashRegisterId: cajaId, openingFloatCents: '50000' } });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id;
  }
  /** Corta el turno directo en la base, cuadrado: aquí no se prueba el corte. */
  async function cerrarTurno(id: string): Promise<void> {
    const t = await getDb().cashSession.findUniqueOrThrow({ where: { id } });
    if (t.status !== 'OPEN') return;
    await getDb().cashSession.update({
      where: { id },
      data: { status: 'CLOSED', closedAt: new Date(), closedByUserId: t.openedByUserId, countedCashCents: t.openingFloatCents, expectedCashCents: t.openingFloatCents, varianceCents: 0n },
    });
  }
  const folios = async () => (await getDb().cashRegister.findUniqueOrThrow({ where: { id: cajaId } })).folioCounter;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    orgId = (await orgFixtures()).demo.id;
    sede = await sedeDesechable(orgId, 'Sede de la prueba 1.3');
    planId = await crearPlan();
    const caja = await app.inject({
      method: 'POST', url: '/cash-registers', headers: { cookie: gerencia },
      payload: { branchId: sede.id, code: `U${randomUUID().slice(0, 6)}`.toUpperCase(), name: 'Caja de la prueba 1.3' },
    });
    expect(caja.statusCode, caja.body).toBe(201);
    cajaId = caja.json().id;
    turno = await abrirTurno();
  }, 60_000);

  afterAll(async () => {
    await cerrarTurno(turno).catch(() => undefined);
    await archivarSede(sede.id).catch(() => undefined);
    await app.close();
    await closeDb();
  });

  // ── Defectos de 1.1 §7 ────────────────────────────────────────────────────

  it('un cargo anulado sale con saldo 0: la ficha ya no lo suma como deuda (1.1 §7-1)', async () => {
    const memberId = await socio();
    const chargeId = await cargoAbierto(memberId, 25_000n);
    await new BillingService().voidCharge(systemContext(orgId), { chargeId, reason: 'Se capturó por error' });
    const lista = (await app.inject({ method: 'GET', url: `/members/${memberId}/statement/charges`, headers: { cookie: gerencia } })).json().items as Array<{ id: string; status: string; balanceCents: string; amountCents: string }>;
    const c = lista.find((x) => x.id === chargeId)!;
    expect(c.status).toBe('VOID');
    expect(c.amountCents).toBe('25000');
    expect(c.balanceCents).toBe('0');
  });

  it('reintentar un cobro en efectivo NO gasta folio ni busca caja: con la caja ya cerrada responde el mismo cobro (1.1 §7-4)', async () => {
    const memberId = await socio();
    await cargoAbierto(memberId);
    const cuerpo = { method: 'CASH', amountCents: '10000', branchId: sede.id, idempotencyKey: `cobro-${randomUUID()}` };
    const antes = await folios();
    const primero = await app.inject({ method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: gerencia }, payload: cuerpo });
    expect(primero.statusCode, primero.body).toBe(201);
    expect(await folios()).toBe(antes + 1);

    // Reintento con la caja abierta: el mismo pago, sin folio nuevo.
    const segundo = await app.inject({ method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: gerencia }, payload: cuerpo });
    expect(segundo.statusCode, segundo.body).toBe(200);
    expect(segundo.json().payment.id).toBe(primero.json().payment.id);
    expect(segundo.json().payment.folio).toBe(primero.json().payment.folio);
    expect(await folios()).toBe(antes + 1);

    // Reintento con la caja ya cerrada: antes respondía 409 «no hay ninguna caja abierta».
    await cerrarTurno(turno);
    const tercero = await app.inject({ method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: gerencia }, payload: cuerpo });
    expect(tercero.statusCode, tercero.body).toBe(200);
    expect(tercero.json().payment.id).toBe(primero.json().payment.id);
    expect(tercero.json().created).toBe(false);
    expect(await folios()).toBe(antes + 1);
    expect(await getDb().payment.count({ where: { memberId } })).toBe(1);
    // Un cobro NUEVO sin caja sigue respondiendo 409.
    const nuevo = await app.inject({ method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: gerencia }, payload: { ...cuerpo, idempotencyKey: `cobro-${randomUUID()}` } });
    expect(nuevo.statusCode).toBe(409);
    turno = await abrirTurno();
  });

  // ── La bitácora dentro de la unidad (28-10, A5-N5) ────────────────────────

  it('si la bitácora no se puede escribir, el cobro NO ocurre: ni pago, ni folio, ni cargo pagado', async () => {
    const memberId = await socio();
    const chargeId = await cargoAbierto(memberId);
    const antes = await folios();
    const espia = vi.spyOn(AuditRepository.prototype, 'append').mockRejectedValue(new Error('La bitácora no responde (prueba)'));
    try {
      const r = await app.inject({
        method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: gerencia },
        payload: { method: 'CASH', amountCents: '10000', branchId: sede.id, idempotencyKey: `cobro-${randomUUID()}` },
      });
      expect(r.statusCode).toBe(500);
    } finally {
      espia.mockRestore();
    }
    expect(await getDb().payment.count({ where: { memberId } })).toBe(0);
    expect(await folios()).toBe(antes);
    expect((await getDb().charge.findUniqueOrThrow({ where: { id: chargeId } })).status).toBe('OPEN');
  });

  it('si la bitácora no se puede escribir, congelar NO congela (la transición y su asiento van juntos)', async () => {
    const memberId = await socio();
    const plan = await crearPlan({ allowFreeze: true, minFreezeDays: 1, maxFreezeDaysPerYear: 30 });
    const venta = await vender(memberId, plan);
    const espia = vi.spyOn(AuditRepository.prototype, 'append').mockRejectedValue(new Error('La bitácora no responde (prueba)'));
    try {
      const r = await app.inject({ method: 'POST', url: `/memberships/${venta.membership.id}/freeze`, headers: { cookie: gerencia }, payload: { days: 7, reason: 'Viaje de trabajo' } });
      expect(r.statusCode).toBe(500);
    } finally {
      espia.mockRestore();
    }
    const m = await getDb().membership.findUniqueOrThrow({ where: { id: venta.membership.id } });
    expect(m.status).toBe('ACTIVE');
    expect(await getDb().membershipEvent.count({ where: { membershipId: m.id, eventType: 'FROZEN' } })).toBe(0);
  });

  it('una corrección sin cobro que falla NO deja asiento en la bitácora; la que ocurre deja uno, después de hacerse (A5-N5)', async () => {
    const memberId = await socio();
    const venta = await vender(memberId);
    const asientos = () => getDb().auditLog.findMany({
      where: { organizationId: orgId, resourceId: venta.membership.id, action: { startsWith: 'membership.override.' } }, orderBy: { at: 'asc' },
    });
    // Ya está activa: «activar» no aplica y responde 409. Antes quedaba `membership.override.activate` asentado.
    const falla = await app.inject({ method: 'POST', url: `/memberships/${venta.membership.id}/activate`, headers: { cookie: gerencia }, payload: { reason: 'Corrección que no aplica' } });
    expect(falla.statusCode, falla.body).toBe(409);
    expect(await asientos()).toHaveLength(0);

    const bien = await app.inject({ method: 'POST', url: `/memberships/${venta.membership.id}/renew`, headers: { cookie: gerencia }, payload: { reason: 'Cortesía autorizada por la dueña' } });
    expect(bien.statusCode, bien.body).toBe(200);
    const hechos = await asientos();
    expect(hechos.map((a) => a.action)).toEqual(['membership.override.renew']);
    // El asiento de la corrección va DESPUÉS del de la transición que la hizo.
    const transicion = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: orgId, resourceId: venta.membership.id, action: 'membership.renew' } });
    expect(hechos[0]!.at.getTime()).toBeGreaterThanOrEqual(transicion.at.getTime());
  });

  // ── Llaves obligatorias ───────────────────────────────────────────────────

  it('renovar sin el periodo que vio la pantalla y vender un paquete sin llave responden 422', async () => {
    const memberId = await socio();
    const venta = await vender(memberId);
    const renovar = await app.inject({ method: 'POST', url: `/memberships/${venta.membership.id}/renewal`, headers: { cookie: gerencia }, payload: { payment: null } });
    expect(renovar.statusCode).toBe(422);
    expect(JSON.stringify(renovar.json())).toMatch(/expectedPeriodStart/);
    const paquete = await app.inject({ method: 'POST', url: `/members/${memberId}/visit-packs`, headers: { cookie: gerencia }, payload: { planId, soldAtBranchId: sede.id, payment: null } });
    expect(paquete.statusCode).toBe(422);
    expect(JSON.stringify(paquete.json())).toMatch(/saleKey/);
  });

  it('dos renovaciones a la vez con el mismo periodo: una renueva y cobra, la otra recibe 409; un solo cobro y una sola cuota', async () => {
    const memberId = await socio();
    const venta = await vender(memberId);
    const cuerpo = { payment: { method: 'CASH' }, expectedPeriodStart: venta.membership.currentPeriodStart };
    const [a, b] = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: `/memberships/${venta.membership.id}/renewal`, headers: { cookie: gerencia }, payload: cuerpo })));
    expect([a!.statusCode, b!.statusCode].sort(), `${a!.body}\n${b!.body}`).toEqual([200, 409]);
    expect(await getDb().charge.count({ where: { membershipId: venta.membership.id, chargeType: 'MEMBERSHIP_PERIOD' } })).toBe(2);
    expect(await getDb().payment.count({ where: { memberId, method: 'CASH' } })).toBe(1);
  });

  it('el mismo paquete enviado dos veces a la vez es UN paquete, un cargo y un cobro', async () => {
    const memberId = await socio();
    const paquete = (await getDb().plan.findFirstOrThrow({ where: { organizationId: orgId, billingModel: 'VISIT_PACK', isActive: true } })).id;
    const cuerpo = { planId: paquete, soldAtBranchId: sede.id, saleKey: `paquete-${randomUUID()}`, payment: { method: 'CASH' } };
    const [a, b] = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: `/members/${memberId}/visit-packs`, headers: { cookie: gerencia }, payload: cuerpo })));
    expect([a!.statusCode, b!.statusCode], `${a!.body}\n${b!.body}`).toEqual([201, 201]);
    expect(a!.json().id).toBe(b!.json().id);
    expect(await getDb().visitPack.count({ where: { memberId } })).toBe(1);
    expect(await getDb().charge.count({ where: { memberId } })).toBe(1);
    expect(await getDb().payment.count({ where: { memberId } })).toBe(1);
  });

  it('el cargo a mano con la misma llave de envío es UN cargo y un asiento', async () => {
    const memberId = await socio();
    const cuerpo = { chargeType: 'MANUAL_ADJUSTMENT', concept: 'Reposición de credencial', subtotalCents: '5000', branchId: sede.id, reason: 'Perdió su credencial', requestKey: `cargo-${randomUUID()}` };
    const a = await app.inject({ method: 'POST', url: `/members/${memberId}/charges`, headers: { cookie: gerencia }, payload: cuerpo });
    const b = await app.inject({ method: 'POST', url: `/members/${memberId}/charges`, headers: { cookie: gerencia }, payload: cuerpo });
    expect(a.statusCode, a.body).toBe(201);
    expect(b.statusCode, b.body).toBe(201);
    expect(b.json().id).toBe(a.json().id);
    expect(await getDb().charge.count({ where: { memberId } })).toBe(1);
    expect(await getDb().auditLog.count({ where: { organizationId: orgId, action: 'billing.charge.create', resourceId: a.json().id } })).toBe(1);
  });

  // ── precioDeCuota única (16-04) ───────────────────────────────────────────

  it('el adeudo de una suspendida se cotiza con SU precio pactado, igual que la cuota que se emite', async () => {
    const memberId = await socio();
    const db = getDb();
    const hoy = hoyNegocio();
    const inicio = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 2, Math.min(hoy.getUTCDate(), 28)));
    const fin = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() + 1, inicio.getUTCDate()));
    const id = uuidv7();
    await db.membership.create({
      data: {
        id, organizationId: orgId, memberId, planId, soldAtBranchId: sede.id, status: 'SUSPENDED', startDate: inicio,
        currentPeriodStart: inicio, currentPeriodEnd: fin, billingAnchorDay: inicio.getUTCDate(), autoRenew: true, agreedPriceCents: 45_000n,
      },
    });
    await db.charge.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberId, membershipId: id, branchId: sede.id, chargeType: 'MEMBERSHIP_PERIOD', status: 'OVERDUE',
        concept: 'Cuota pactada', subtotalCents: 45_000n, taxCents: 0n, discountCents: 0n, amountCents: 45_000n,
        periodStart: inicio, periodEnd: fin, dueDate: inicio, issuedAt: inicio, idempotencyKey: cycleChargeKey(id, inicio),
      },
    });
    const o = (await app.inject({ method: 'GET', url: `/memberships/${id}/debt-options`, headers: { cookie: gerencia } })).json();
    // Antes: 60000 (precio de lista), aunque cada cuota saliera en 45000.
    expect(o.periodCents).toBe('45000');
    expect(o.missedPeriods).toHaveLength(2);
    expect(o.resumeTotalCents).toBe(String(45_000 * 3));

    const r = await app.inject({
      method: 'POST', url: `/memberships/${id}/debt-decision`, headers: { cookie: gerencia },
      payload: { decision: 'RESUME', reason: 'Vuelve y paga', payment: spei() },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().payment.amountCents).toBe(o.resumeTotalCents);
    expect(r.json().charges.map((c: { amountCents: string }) => c.amountCents)).toEqual(['45000', '45000', '45000']);
  });

  it('si la decisión de adeudo falla a la mitad, no queda NADA hecho (antes quedaban las cuotas y el periodo movido)', async () => {
    const memberId = await socio();
    const db = getDb();
    const hoy = hoyNegocio();
    const inicio = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 2, Math.min(hoy.getUTCDate(), 28)));
    const fin = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() + 1, inicio.getUTCDate()));
    const id = uuidv7();
    await db.membership.create({
      data: {
        id, organizationId: orgId, memberId, planId, soldAtBranchId: sede.id, status: 'SUSPENDED', startDate: inicio,
        currentPeriodStart: inicio, currentPeriodEnd: fin, billingAnchorDay: inicio.getUTCDate(), autoRenew: true, agreedPriceCents: 60_000n,
      },
    });
    // El cobro falla al final, con las cuotas ya emitidas y el periodo ya movido dentro de la unidad.
    const svc = new BillingService();
    const espia = vi.spyOn(svc.cash, 'nextFolio').mockRejectedValue(new Error('La caja no responde (prueba)'));
    try {
      await expect(svc.resolveSuspendedDebt(systemContext(orgId), {
        membershipId: id, decision: 'RESUME', reason: 'Vuelve y paga', payment: { method: 'CASH', cashSessionId: turno },
      })).rejects.toThrow(/La caja no responde/);
    } finally {
      espia.mockRestore();
    }
    const m = await db.membership.findUniqueOrThrow({ where: { id } });
    expect(m.status).toBe('SUSPENDED');
    expect(dia(m.currentPeriodStart)).toBe(dia(inicio));
    expect(await db.charge.count({ where: { membershipId: id } })).toBe(0);
    expect(await db.membershipEvent.count({ where: { membershipId: id, eventType: 'DEBT_RESUMED' } })).toBe(0);
  });

  it('el cambio de plan deja PACTADO el precio del plan nuevo: subir después el de lista no le sube la cuota', async () => {
    const memberId = await socio();
    const otro = await crearPlan({ priceCents: '90000' });
    const venta = await vender(memberId, planId, { startDate: dia(addDays(hoyNegocio(), -5)) });
    const cambio = await app.inject({
      method: 'POST', url: `/memberships/${venta.membership.id}/plan-change`, headers: { cookie: gerencia },
      payload: { planId: otro, reason: 'Quiere el plan completo', payment: spei() },
    });
    expect(cambio.statusCode, cambio.body).toBe(200);
    const m = await getDb().membership.findUniqueOrThrow({ where: { id: venta.membership.id } });
    // Antes quedaba en null y cada cuota tomaba el precio de lista del día.
    expect(m.agreedPriceCents).toBe(90_000n);
    await getDb().plan.update({ where: { id: otro }, data: { priceCents: 120_000n } });
    const siguiente = await new BillingService().advancePeriod(systemContext(orgId), m.id, m.currentPeriodStart);
    expect(siguiente.charge.amountCents).toBe(90_000n);
  });

  // ── Contratos del núcleo y cartera en billing ─────────────────────────────

  it('las respuestas de cobrar y del historial de membresías cumplen su contrato del núcleo', async () => {
    const memberId = await socio();
    await vender(memberId);
    await cargoAbierto(memberId);
    for (const cuerpo of [{ ...spei(), amountCents: '4000' }, { method: 'CASH', amountCents: '6000' }]) {
      const payload = { ...cuerpo, branchId: sede.id, idempotencyKey: `cobro-${randomUUID()}` };
      const cobro = await app.inject({ method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: gerencia }, payload });
      expect(cobro.statusCode, cobro.body).toBe(201);
      expect(diferenciasConElContrato(RecordPaymentResult, cobro.json())).toEqual([]);
      const reintento = await app.inject({ method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: gerencia }, payload });
      expect(reintento.statusCode).toBe(200);
      expect(diferenciasConElContrato(RecordPaymentResult, reintento.json())).toEqual([]);
    }
    const historial = await app.inject({ method: 'GET', url: `/members/${memberId}/memberships`, headers: { cookie: gerencia } });
    expect(historial.statusCode).toBe(200);
    expect(historial.json()).toHaveLength(1);
    expect(diferenciasConElContrato(MemberMemberships, historial.json())).toEqual([]);
  });

  it('la cartera y los motivos de descuento son de cobranza: los registra billing y no dependen del módulo Caja (28-07)', async () => {
    const rutas = registeredRoutes().filter((r) => r.url === '/portfolio' || r.url === '/discount-reasons');
    expect(rutas.map((r) => `${r.method} ${r.url} · ${r.source} · ${r.module}`).sort()).toEqual([
      'GET /discount-reasons · billing · core',
      'GET /portfolio · billing · core',
    ]);
    const cartera = await app.inject({ method: 'GET', url: `/portfolio?branchId=${sede.id}&topDebtors=3`, headers: { cookie: gerencia } });
    expect(cartera.statusCode, cartera.body).toBe(200);
    expect(cartera.json().scope).toBe(sede.id);
    const motivos = await app.inject({ method: 'GET', url: '/discount-reasons', headers: { cookie: gerencia } });
    expect(motivos.statusCode).toBe(200);
    expect(motivos.json().reasons.length).toBeGreaterThan(0);
  });
});
