import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, sedeDesechable, archivarSede } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * MOVIMIENTOS: la ganancia real de cada día. Se prueba sobre una sede
 * desechable para que los números sean solo los de la prueba.
 */
describe('movimientos y ganancia real por día', () => {
  let app: FastifyInstance;
  let owner: string;
  let recepcion: string;
  let orgId: string;
  let sede: { id: string; code: string };
  const dia = '2026-03-10';
  const otro = '2026-03-12';

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    orgId = (await orgFixtures()).demo.id;
    sede = await sedeDesechable(orgId, 'Sede de movimientos');

    const db = getDb();
    const userId = (await db.user.findFirstOrThrow({ where: { email: 'gerencia@demo.mx' } })).id;
    const socio = await db.member.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberCode: `MOV-${Date.now() % 1e6}`, firstName: nombreUnico('Mov'),
        lastName: nombreUnico('Dia'), nameKey: nombreUnico('k'), homeBranchId: sede.id, joinedAt: new Date(),
      },
    });
    const pago = (cents: bigint, method: 'CASH' | 'SPEI_TRANSFER' | 'CREDIT_NOTE', fecha = dia, extra: object = {}) => db.payment.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberId: socio.id, branchId: sede.id, method, status: 'SUCCEEDED',
        amountCents: cents, unappliedCents: 0n, receivedAt: new Date(`${fecha}T18:00:00Z`), businessDate: new Date(`${fecha}T00:00:00Z`),
        createdByUserId: userId, ...extra,
      },
    });
    const original = await pago(80_000n, 'CASH');
    await pago(50_000n, 'SPEI_TRANSFER');
    await pago(-20_000n, 'SPEI_TRANSFER', dia, { reversesPaymentId: original.id, reversalReason: 'Reembolso: no vino' });
    await pago(99_999n, 'CREDIT_NOTE'); // saldo a favor: no es dinero nuevo
    await pago(30_000n, 'CASH', otro);
    // Del portal: sin sede. Cuenta en la sede de casa del socio, no se pierde al filtrar.
    await pago(7_000n, 'SPEI_TRANSFER', dia, { branchId: null });

    const reg = await db.cashRegister.create({ data: { id: uuidv7(), organizationId: orgId, branchId: sede.id, code: 'MV1', name: 'Caja movimientos' } });
    const ses = await db.cashSession.create({
      data: {
        id: uuidv7(), organizationId: orgId, branchId: sede.id, cashRegisterId: reg.id, openedByUserId: userId,
        businessDate: new Date(`${dia}T00:00:00Z`), status: 'OPEN', openingFloatCents: 50_000n,
      },
    });
    // Como en la vida real: los movimientos entran con el turno ABIERTO (la
    // base rechaza cualquiera sobre un turno cerrado) y después se hace el corte.
    for (const [movementType, amountCents, reason] of [['EXPENSE', -5_000n, 'Garrafones de agua'], ['WITHDRAWAL', -60_000n, 'Depósito al banco']] as const) {
      await db.cashMovement.create({ data: { id: uuidv7(), organizationId: orgId, cashSessionId: ses.id, movementType, amountCents, reason, createdByUserId: userId, businessDate: ses.businessDate } });
    }
    await db.cashSession.update({
      where: { id: ses.id },
      data: {
        status: 'CLOSED', expectedCashCents: 130_000n, countedCashCents: 129_000n, varianceCents: -1_000n,
        varianceReason: 'Faltó cambio', closedByUserId: userId, closedAt: new Date(`${dia}T23:00:00Z`),
      },
    });
  });
  afterAll(async () => { await archivarSede(sede.id); await app.close(); await closeDb(); });

  it('el día suma lo que entró, resta devoluciones, gastos y descuadre, y no cuenta el retiro al banco', async () => {
    const r = await app.inject({ method: 'GET', url: `/reports/daily?from=${dia}&to=${dia}&branchId=${sede.id}`, headers: { cookie: owner } });
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json().days[0];
    expect(d).toMatchObject({
      date: dia, incomeCents: '137000', refundsCents: '-20000', expensesCents: '-5000',
      varianceCents: '-1000', netCents: '111000', toBankCents: '-60000',
      // El pago con saldo a favor se informa pero no suma (SEC2-16).
      creditNotesCents: '99999',
    });
    expect(d.byMethod).toEqual({ CASH: '80000', SPEI_TRANSFER: '57000' });
  });

  it('el periodo trae TODOS sus días, también los vacíos, y el total cuadra', async () => {
    const r = (await app.inject({ method: 'GET', url: `/reports/daily?from=${dia}&to=${otro}&branchId=${sede.id}`, headers: { cookie: owner } })).json();
    expect(r.days.map((d: { date: string }) => d.date)).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
    expect(r.days[1].netCents).toBe('0');
    expect(r.totals.netCents).toBe('141000');
  });

  it('los movimientos del día dicen qué fue, de quién y quién lo registró', async () => {
    const r = (await app.inject({ method: 'GET', url: `/reports/movements?date=${dia}&branchId=${sede.id}`, headers: { cookie: owner } })).json();
    const tipos = r.movements.map((m: { kind: string }) => m.kind).sort();
    expect(tipos).toEqual(['CASH_EXPENSE', 'CASH_VARIANCE', 'CASH_WITHDRAWAL', 'CREDIT_NOTE', 'PAYMENT', 'PAYMENT', 'PAYMENT', 'REFUND']);
    const devolucion = r.movements.find((m: { kind: string }) => m.kind === 'REFUND');
    expect(devolucion.memberName).toBeTruthy();
    expect(devolucion.userName).toBeTruthy();
    expect(devolucion.concept).toBe('Reembolso: no vino');
  });

  it('recepción no ve la ganancia; un periodo al revés o muy largo se rechaza', async () => {
    expect((await app.inject({ method: 'GET', url: `/reports/daily?from=${dia}&to=${dia}`, headers: { cookie: recepcion } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/reports/daily?from=${otro}&to=${dia}`, headers: { cookie: owner } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'GET', url: '/reports/daily?from=2025-01-01&to=2026-03-01', headers: { cookie: owner } })).statusCode).toBe(422);
  });

  it('el Tablero y Movimientos dicen lo mismo de lo que entró (BE2-15)', async () => {
    const t = (await app.inject({ method: 'GET', url: `/dashboard?from=${dia}&to=2026-03-11&branchId=${sede.id}`, headers: { cookie: owner } })).json();
    const m = (await app.inject({ method: 'GET', url: `/reports/daily?from=${dia}&to=${dia}&branchId=${sede.id}`, headers: { cookie: owner } })).json();
    expect(t.money.collectedCents).toBe(String(BigInt(m.totals.incomeCents) + BigInt(m.totals.refundsCents)));
    expect(t.money.collectedCents).toBe('117000'); // sin la nota de crédito de 99,999
    expect(t.money.cashExpensesCents).toBe('-6000'); // garrafones + descuadre
    expect(t.previous.to).toBe(dia);
  });

  it('los gastos fijos se reparten por día y la ganancia los descuenta (UXB-02)', async () => {
    // Recepción no registra gastos, ni de su sede ni de todo el gimnasio (ADR-039).
    expect((await app.inject({ method: 'POST', url: '/expenses', headers: { cookie: recepcion }, payload: { category: 'RENT', description: 'Renta', amountCents: '100', month: '2026-03', branchId: sede.id } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/expenses', headers: { cookie: recepcion }, payload: { category: 'PAYROLL', description: 'Nómina de oficina', amountCents: '100', month: '2026-03', branchId: null } })).statusCode).toBe(403);

    const renta = await app.inject({ method: 'POST', url: '/expenses', headers: { cookie: owner }, payload: { category: 'RENT', description: 'Renta de marzo', amountCents: '310000', month: '2026-03', branchId: sede.id } });
    expect(renta.statusCode, renta.body).toBe(201);
    const dia10 = (await app.inject({ method: 'GET', url: `/reports/daily?from=${dia}&to=${dia}&branchId=${sede.id}`, headers: { cookie: owner } })).json().totals;
    expect(dia10.fixedExpensesCents).toBe('-10000'); // 310,000 / 31 días
    expect(dia10.profitCents).toBe(String(BigInt(dia10.netCents) - 10000n));
    const mes = (await app.inject({ method: 'GET', url: `/reports/daily?from=2026-03-01&to=2026-03-31&branchId=${sede.id}`, headers: { cookie: owner } })).json().totals;
    expect(mes.fixedExpensesCents).toBe('-310000');
    const t = (await app.inject({ method: 'GET', url: `/dashboard?from=2026-03-01&to=2026-04-01&branchId=${sede.id}`, headers: { cookie: owner } })).json();
    expect(t.money.fixedExpensesCents).toBe('-310000');
    expect(t.money.profitCents).toBe(String(BigInt(t.money.accruedCents) + BigInt(t.money.cashExpensesCents) - 310000n));

    const lista = (await app.inject({ method: 'GET', url: '/expenses?month=2026-03', headers: { cookie: owner } })).json();
    expect(lista.expenses.some((g: { id: string }) => g.id === renta.json().id)).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/expenses/${renta.json().id}/void`, headers: { cookie: owner }, payload: { reason: 'Capturada dos veces' } })).statusCode).toBe(200);
    const sinRenta = (await app.inject({ method: 'GET', url: `/reports/daily?from=${dia}&to=${dia}&branchId=${sede.id}`, headers: { cookie: owner } })).json().totals;
    expect(sinRenta.fixedExpensesCents).toBe('0');
  });
});
