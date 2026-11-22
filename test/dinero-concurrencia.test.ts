import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { uuidv7, normalizedNameKey, cycleChargeKey } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, sedeDesechable, archivarSede } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * FASE 1 · BLOQUE 1.3 · DINERO CON DOS CAJAS Y CON CARGA.
 *
 * Reproduce lo que la fase 0 dejó anotado: una vez, `POST
 * /memberships/:id/debt-decision` no respondió. Aquí se decide el adeudo de
 * muchas suspendidas A LA VEZ, cobrando en efectivo en dos cajas abiertas de
 * la misma sede, mientras otros socios pagan y se venden membresías en esas
 * mismas cajas.
 *
 * Antes del bloque, el cobro reservaba el folio (candado de la caja) y luego
 * pedía el candado de la bitácora, mientras la venta y la decisión de adeudo
 * asentaban primero la bitácora y después pedían el folio: dos peticiones se
 * esperaban una a la otra hasta que la base cortaba a una (5 s) o la
 * transacción agotaba su tope (15 s). Ahora toda operación de dinero toma el
 * candado de la organización al empezar, y el orden es uno solo.
 */
describe('dinero con dos cajas abiertas y carga · fase 1.3', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let gerente: string;
  let orgId: string;
  let sede: { id: string; code: string };
  let planId: string;
  const turnos: string[] = [];

  const hoyNegocio = () => new Date(`${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })}T00:00:00.000Z`);
  const mesesAtras = (n: number) => {
    const hoy = hoyNegocio();
    return new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - n, Math.min(hoy.getUTCDate(), 28)));
  };

  async function socio(): Promise<string> {
    const nombre = nombreUnico('Carga');
    const m = await getDb().member.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberCode: `CRG-${randomUUID().slice(0, 10)}`,
        firstName: nombre, lastName: nombreUnico('Dos'), nameKey: normalizedNameKey(`${nombre} dos`),
        homeBranchId: sede.id, joinedAt: new Date(),
      },
    });
    return m.id;
  }

  /** Suspendida hace `meses`, con la cuota de aquel periodo abierta. */
  async function suspendida(meses: number): Promise<{ memberId: string; membershipId: string }> {
    const db = getDb();
    const memberId = await socio();
    const inicio = mesesAtras(meses);
    const fin = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() + 1, inicio.getUTCDate()));
    const id = uuidv7();
    await db.membership.create({
      data: {
        id, organizationId: orgId, memberId, planId, soldAtBranchId: sede.id, status: 'SUSPENDED',
        startDate: inicio, currentPeriodStart: inicio, currentPeriodEnd: fin, billingAnchorDay: inicio.getUTCDate(),
        autoRenew: true, agreedPriceCents: 60_000n,
      },
    });
    await db.charge.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberId, membershipId: id, branchId: sede.id, chargeType: 'MEMBERSHIP_PERIOD',
        status: 'OVERDUE', concept: 'Cuota de la prueba de carga', subtotalCents: 60_000n, taxCents: 0n, discountCents: 0n,
        amountCents: 60_000n, periodStart: inicio, periodEnd: fin, dueDate: inicio, issuedAt: inicio,
        idempotencyKey: cycleChargeKey(id, inicio),
      },
    });
    return { memberId, membershipId: id };
  }

  /** Socio con un cargo abierto de $100 que no es de membresía. */
  async function conCargo(): Promise<string> {
    const memberId = await socio();
    await getDb().charge.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberId, branchId: sede.id, chargeType: 'MANUAL_ADJUSTMENT', status: 'OPEN',
        concept: 'Cargo de la prueba de carga', subtotalCents: 10_000n, taxCents: 0n, discountCents: 0n, amountCents: 10_000n,
        dueDate: hoyNegocio(), issuedAt: new Date(),
      },
    });
    return memberId;
  }

  const medir = async <T extends { statusCode: number; body: string }>(que: string, p: Promise<T>) => {
    const t = Date.now();
    const r = await p;
    return { que, ms: Date.now() - t, status: r.statusCode, body: r.body };
  };

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    gerente = await loginAs(app, 'gerente@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    sede = await sedeDesechable(orgId, 'Sede de dos cajas');
    const plan = await app.inject({
      method: 'POST', url: '/plans', headers: { cookie: gerencia },
      payload: {
        code: `C${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`, name: 'Plan de la prueba de carga', billingModel: 'RECURRING',
        durationUnit: 'MONTH', durationValue: 1, priceCents: '60000', signupFeeCents: '0', branchAccessScope: 'ALL_BRANCHES',
        reason: 'Plan de la prueba de dos cajas',
      },
    });
    expect(plan.statusCode, plan.body).toBe(201);
    planId = plan.json().id;
    // Dos cajas de la misma sede, cada una con su turno abierto por una persona distinta.
    for (const [i, quien] of [gerencia, gerente].entries()) {
      const caja = await app.inject({
        method: 'POST', url: '/cash-registers', headers: { cookie: gerencia },
        payload: { branchId: sede.id, code: `K${i}${randomUUID().slice(0, 5)}`.toUpperCase(), name: `Caja ${i + 1} de carga` },
      });
      expect(caja.statusCode, caja.body).toBe(201);
      const turno = await app.inject({
        method: 'POST', url: '/cash-sessions', headers: { cookie: quien },
        payload: { cashRegisterId: caja.json().id, openingFloatCents: '50000' },
      });
      expect(turno.statusCode, turno.body).toBe(201);
      turnos.push(turno.json().id);
    }
  }, 60_000);

  afterAll(async () => {
    // Los turnos se cortan directo en la base, cuadrados: la sede se archiva y aquí no se prueba el corte.
    for (const t of await getDb().cashSession.findMany({ where: { id: { in: turnos }, status: 'OPEN' } })) {
      await getDb().cashSession.update({
        where: { id: t.id },
        data: { status: 'CLOSED', closedAt: new Date(), closedByUserId: t.openedByUserId, countedCashCents: t.openingFloatCents, expectedCashCents: t.openingFloatCents, varianceCents: 0n },
      }).catch(() => undefined);
    }
    await archivarSede(sede.id).catch(() => undefined);
    await app.close();
    await closeDb();
  });

  it('con dos cajas abiertas, decidir un adeudo sin decir la caja responde 422 y no mueve nada', async () => {
    const s = await suspendida(2);
    const r = await app.inject({
      method: 'POST', url: `/memberships/${s.membershipId}/debt-decision`, headers: { cookie: gerencia },
      payload: { decision: 'RESUME', reason: 'Vuelve y paga', payment: { method: 'CASH' } },
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().message).toMatch(/2 cajas abiertas/);
    const m = await getDb().membership.findUniqueOrThrow({ where: { id: s.membershipId } });
    expect(m.status).toBe('SUSPENDED');
    expect(await getDb().charge.count({ where: { membershipId: s.membershipId } })).toBe(1);
  });

  it('doce adeudos, doce cobros y seis ventas a la vez en dos cajas: todo responde, nada se cuelga y los folios no se repiten ni se saltan', async () => {
    const N = 12;
    const suspendidas = await Promise.all(Array.from({ length: N }, () => suspendida(3)));
    const deudores = await Promise.all(Array.from({ length: N }, () => conCargo()));
    const compradores = await Promise.all(Array.from({ length: 6 }, () => socio()));
    const cajas = await getDb().cashSession.findMany({ where: { id: { in: turnos } }, select: { id: true, cashRegisterId: true } });
    const antes = new Map((await getDb().cashRegister.findMany({ where: { id: { in: cajas.map((c) => c.cashRegisterId) } } })).map((c) => [c.id, c.folioCounter]));

    const t0 = Date.now();
    const resultados = await Promise.all([
      ...suspendidas.map((s, i) => medir('adeudo', app.inject({
        method: 'POST', url: `/memberships/${s.membershipId}/debt-decision`, headers: { cookie: i % 2 ? gerencia : gerente },
        payload: { decision: 'RESUME', reason: 'Vuelve y paga los meses', payment: { method: 'CASH', cashSessionId: turnos[i % 2] } },
      }))),
      ...deudores.map((memberId, i) => medir('cobro', app.inject({
        method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: i % 2 ? gerente : gerencia },
        payload: { method: 'CASH', amountCents: '10000', branchId: sede.id, cashSessionId: turnos[(i + 1) % 2], idempotencyKey: `carga-${randomUUID()}` },
      }))),
      ...compradores.map((memberId, i) => medir('venta', app.inject({
        method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: gerencia },
        payload: { planId, branchId: sede.id, saleKey: `carga-venta-${randomUUID()}`, payment: { method: 'CASH', cashSessionId: turnos[i % 2] } },
      }))),
    ]);
    const total = Date.now() - t0;

    const lentas = resultados.filter((r) => r.ms > 10_000);
    const fallidas = resultados.filter((r) => r.status >= 400);
    const resumen = ['adeudo', 'cobro', 'venta'].map((q) => {
      const xs = resultados.filter((r) => r.que === q);
      return `${q}: ${xs.filter((r) => r.status < 400).length}/${xs.length} bien, máx ${Math.max(...xs.map((r) => r.ms))} ms`;
    }).join(' · ');
    console.log(`[dos cajas con carga] ${resultados.length} peticiones en ${total} ms · ${resumen}`
      + (fallidas.length ? `\n  fallidas: ${fallidas.map((r) => `${r.que} ${r.status} ${r.ms} ms ${r.body.slice(0, 160)}`).join('\n  ')}` : ''));

    expect(fallidas.map((r) => `${r.que} ${r.status} ${r.body.slice(0, 200)}`)).toEqual([]);
    expect(lentas.map((r) => `${r.que} ${r.ms} ms`)).toEqual([]);

    // Cada suspendida quedó activa, con sus cuatro cuotas pagadas y un solo cobro.
    const db = getDb();
    for (const s of suspendidas) {
      const m = await db.membership.findUniqueOrThrow({ where: { id: s.membershipId } });
      expect(m.status).toBe('ACTIVE');
      const cuotas = await db.charge.findMany({ where: { membershipId: s.membershipId } });
      expect(cuotas.map((c) => c.status)).toEqual(['PAID', 'PAID', 'PAID', 'PAID']);
      expect(await db.payment.count({ where: { memberId: s.memberId } })).toBe(1);
    }
    // Folios: uno por cobro en efectivo, consecutivos por caja, sin repetir ni saltar.
    const pagos = await db.payment.findMany({ where: { cashSessionId: { in: turnos }, memberId: { in: [...suspendidas.map((s) => s.memberId), ...deudores, ...compradores] } }, select: { folio: true, cashSessionId: true } });
    expect(pagos).toHaveLength(N + N + 6);
    expect(new Set(pagos.map((p) => p.folio)).size).toBe(pagos.length);
    for (const c of cajas) {
      const ahora = (await db.cashRegister.findUniqueOrThrow({ where: { id: c.cashRegisterId } })).folioCounter;
      expect(ahora - antes.get(c.cashRegisterId)!).toBe(pagos.filter((p) => p.cashSessionId === c.id).length);
    }
    // La bitácora sigue encadenada después de la ráfaga.
    const { AuditService } = await import('../src/platform/audit/audit.service.js');
    expect((await new AuditService().verifyChain(orgId)).ok).toBe(true);
  }, 120_000);

  it('la misma decisión enviada dos veces a la vez (doble clic) deja UN cobro y las cuotas una sola vez', async () => {
    const s = await suspendida(2);
    const cuerpo = { decision: 'RESUME', reason: 'Doble clic', payment: { method: 'CASH', cashSessionId: turnos[0] } };
    const [a, b] = await Promise.all([1, 2].map(() => app.inject({
      method: 'POST', url: `/memberships/${s.membershipId}/debt-decision`, headers: { cookie: gerencia }, payload: cuerpo,
    })));
    const estados = [a!.statusCode, b!.statusCode].sort();
    // Una gana; la otra recibe el mismo resultado o un 409 que lo explica. Nunca un 500.
    expect(estados[0], `${a!.body}\n${b!.body}`).toBe(200);
    expect([200, 409]).toContain(estados[1]);
    const db = getDb();
    expect(await db.payment.count({ where: { memberId: s.memberId } })).toBe(1);
    expect(await db.charge.count({ where: { membershipId: s.membershipId } })).toBe(3);
    expect((await db.membership.findUniqueOrThrow({ where: { id: s.membershipId } })).status).toBe('ACTIVE');
    expect(await db.membershipEvent.count({ where: { membershipId: s.membershipId, eventType: 'DEBT_RESUMED' } })).toBe(1);
  }, 60_000);
});
