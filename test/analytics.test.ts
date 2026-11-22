import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

const db = () => getDb();
const sello = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4);

const CONSENTS = [
  { consentType: 'PRIVACY_NOTICE', documentVersion: 'v1.0', granted: true },
  { consentType: 'HOUSE_RULES', documentVersion: 'v1.0', granted: true },
];


let telSeq = Math.floor(Math.random() * 90_000_000);
const telefonoUnico = (): string => {
  telSeq = (telSeq + 1) % 100_000_000;
  return `+5255${String(telSeq).padStart(8, '0')}`;
};

describe('tablero del dueño', () => {
  let app: FastifyInstance;
  let owner: string;
  let reception: string;
  let orgId: string;
  let branchId: string;
  let packPlanId: string;
  let turno: string;

  async function nuevoSocio(): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: owner },
      payload: {
        firstName: nombreUnico('Kpi'), lastName: nombreUnico('Tablero'),
        phoneE164: telefonoUnico(), homeBranchId: branchId, consents: CONSENTS,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  /**
   * Siempre recién calculado: estas pruebas verifican la aritmética del
   * tablero, no su caché de 30 s (que tiene su propia prueba abajo). Consumir
   * una visita no deja bitácora, así que no tira el caché, y sin `fresh` la
   * segunda lectura devolvía la cifra de antes.
   */
  async function tablero(query = ''): Promise<Record<string, any>> {
    const res = await app.inject({
      method: 'GET', url: `/dashboard${query}${query ? '&' : '?'}fresh=1`, headers: { cookie: owner },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    reception = await loginAs(app, 'recepcion@demo.mx');

    const { demo, demoBranches } = await orgFixtures();
    orgId = demo.id;
    branchId = demoBranches.find((b) => b.code === 'CEN')!.id;
    packPlanId = (await db().plan.findFirstOrThrow({
      where: { organizationId: orgId, billingModel: 'VISIT_PACK', isActive: true },
    })).id;

    const caja = await app.inject({
      method: 'POST', url: '/cash-registers', headers: { cookie: owner },
      payload: { branchId, code: `K${sello()}`.slice(0, 8), name: `Caja KPI ${sello()}` },
    });
    const abierta = await app.inject({
      method: 'POST', url: '/cash-sessions', headers: { cookie: owner },
      payload: { cashRegisterId: caja.json().id, openingFloatCents: '0' },
    });
    turno = abierta.json().id as string;

    // El tablero vende producto: sin reponer, la suite se queda sin existencias.
    const barra = await db().product.findFirstOrThrow({
      where: { organizationId: orgId, sku: 'BARRA-CEREAL' },
    });
    await app.inject({
      method: 'POST', url: '/inventory/movements', headers: { cookie: owner },
      payload: {
        branchId, productId: barra.id, movementType: 'PURCHASE',
        quantityDelta: 200, reason: 'Reposición para la batería de pruebas',
      },
    });
  });

  afterAll(async () => {
    const rep = await app.inject({ method: 'GET', url: `/cash-sessions/${turno}`, headers: { cookie: owner } });
    if (rep.statusCode === 200 && rep.json().session.status === 'OPEN') {
      await app.inject({
        method: 'POST', url: `/cash-sessions/${turno}/close`, headers: { cookie: owner },
        payload: { countedCashCents: rep.json().expectedCashCents },
      });
    }
    await app.close();
    await closeDb();
  });

  it('devuelve las TRES cifras por separado', async () => {
    const t = await tablero();
    for (const k of ['collectedCents', 'accruedCents', 'deferredCents', 'mrrCents']) {
      expect(t.money[k], k).toMatch(/^-?[0-9]+$/);
    }
    expect(t.portfolio.outstandingCents).toMatch(/^-?[0-9]+$/);
    expect(typeof t.activeMembers).toBe('number');
  });

  // ── CRITERIO: MRR devengado excluye paquetes no consumidos ───────────────
  it('un paquete recién vendido SUMA a lo cobrado y NO a lo devengado', async () => {
    const antes = await tablero();
    const socio = await nuevoSocio();

    const venta = await app.inject({
      method: 'POST', url: `/members/${socio}/visit-packs`, headers: { cookie: owner },
      payload: { planId: packPlanId, soldAtBranchId: branchId, saleKey: crypto.randomUUID(), payment: null },
    });
    expect(venta.statusCode, venta.body).toBe(201);
    const importe = BigInt(venta.json().charge.amountCents);
    expect(importe).toBeGreaterThan(0n);

    await app.inject({
      method: 'POST', url: `/members/${socio}/payments`, headers: { cookie: owner },
      payload: { idempotencyKey: crypto.randomUUID(), method: 'CASH', amountCents: importe.toString(), branchId, cashSessionId: turno },
    });

    const despues = await tablero();

    // Entró el dinero…
    expect(BigInt(despues.money.collectedCents) - BigInt(antes.money.collectedCents)).toBe(importe);
    // …pero NO se ganó: el socio todavía no ha pisado el gimnasio.
    expect(BigInt(despues.money.accruedCents)).toBe(BigInt(antes.money.accruedCents));
    // Y aparece como PASIVO.
    expect(BigInt(despues.money.deferredCents) - BigInt(antes.money.deferredCents)).toBe(importe);
  });

  it('el tablero se sirve de memoria medio minuto, fresh=1 lo salta y un asiento en la bitácora lo tira (OPT3-04)', async () => {
    const leer = async (q = '') => {
      const res = await app.inject({ method: 'GET', url: `/dashboard${q}`, headers: { cookie: owner } });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Record<string, any>;
    };
    const fresco = await leer('?fresh=1');
    const socio = await nuevoSocio();
    // Un cargo manual deja bitácora: el caché de la organización se tira y la
    // siguiente lectura ya lo trae.
    const cargo = await app.inject({
      method: 'POST', url: `/members/${socio}/charges`, headers: { cookie: owner },
      payload: { chargeType: 'MANUAL_ADJUSTMENT', concept: 'Prueba del caché', subtotalCents: '777', reason: 'Prueba del caché del tablero' },
    });
    expect(cargo.statusCode, cargo.body).toBe(201);
    const tras = await leer();
    expect(BigInt(tras.portfolio.outstandingCents) - BigInt(fresco.portfolio.outstandingCents)).toBe(777n);
    // Lo que NO deja bitácora no lo tira: la lectura siguiente es la guardada.
    const otra = await leer();
    expect(otra).toEqual(tras);
  });

  it('consumir una visita mueve valor de DIFERIDO a DEVENGADO', async () => {
    const socio = await nuevoSocio();
    const venta = await app.inject({
      method: 'POST', url: `/members/${socio}/visit-packs`, headers: { cookie: owner },
      payload: { planId: packPlanId, soldAtBranchId: branchId, saleKey: crypto.randomUUID(), payment: { method: 'SPEI_TRANSFER', externalRef: 'SPEI-PAQUETE' } },
    });
    const packId = venta.json().id as string;
    const visitas = venta.json().visitsPurchased as number;
    const importe = BigInt(venta.json().charge.amountCents);

    const antes = await tablero();

    const consumo = await app.inject({
      method: 'POST', url: `/visit-packs/${packId}/consume`, headers: { cookie: owner },
      payload: { branchId },
    });
    expect(consumo.statusCode, consumo.body).toBe(201);

    const despues = await tablero();
    const porVisita = importe / BigInt(visitas);

    expect(BigInt(despues.money.accruedCents) - BigInt(antes.money.accruedCents)).toBe(porVisita);
    expect(BigInt(antes.money.deferredCents) - BigInt(despues.money.deferredCents)).toBe(porVisita);
    // Cobrar no cambió: el dinero entró cuando se vendió el paquete.
    expect(despues.money.collectedCents).toBe(antes.money.collectedCents);
  });

  it('una venta de producto se gana EN EL ACTO', async () => {
    const producto = await db().product.findFirstOrThrow({
      where: { organizationId: orgId, sku: 'BARRA-CEREAL' },
    });
    const antes = await tablero();

    const venta = await app.inject({
      method: 'POST', url: '/pos/sales', headers: { cookie: reception },
      payload: { idempotencyKey: crypto.randomUUID(), branchId, method: 'CASH', cashSessionId: turno, lines: [{ productId: producto.id, quantity: 2 }] },
    });
    expect(venta.statusCode, venta.body).toBe(201);
    const total = BigInt(venta.json().totalCents);

    const despues = await tablero();
    expect(BigInt(despues.money.collectedCents) - BigInt(antes.money.collectedCents)).toBe(total);
    expect(BigInt(despues.money.accruedCents) - BigInt(antes.money.accruedCents)).toBe(total);
  });

  // ── MRR ───────────────────────────────────────────────────────────────────
  it('el MRR normaliza los planes a valor mensual', async () => {
    const t = await tablero();
    const mrr = BigInt(t.money.mrrCents);
    expect(mrr).toBeGreaterThan(0n);

    // El MRR NO puede ser la suma bruta de los precios: una anualidad de
    // $6,500 aporta ~$542 al mes, no $6,500.
    const planes = await db().plan.findMany({
      where: { organizationId: orgId, billingModel: { in: ['RECURRING', 'PREPAID_PERIOD'] } },
    });
    const vivas = await db().membership.count({
      where: { organizationId: orgId, status: { in: ['PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'FROZEN'] } },
    });
    const precioMax = planes.reduce((m, p) => (p.priceCents > m ? p.priceCents : m), 0n);
    expect(mrr).toBeLessThanOrEqual(precioMax * BigInt(vivas));
  });

  it('un paquete de visitas NO entra en el MRR: no se renueva solo', async () => {
    const antes = await tablero();
    const socio = await nuevoSocio();
    await app.inject({
      method: 'POST', url: `/members/${socio}/visit-packs`, headers: { cookie: owner },
      payload: { planId: packPlanId, soldAtBranchId: branchId, saleKey: crypto.randomUUID(), payment: { method: 'SPEI_TRANSFER', externalRef: 'SPEI-PAQUETE' } },
    });
    const despues = await tablero();
    expect(despues.money.mrrCents).toBe(antes.money.mrrCents);
  });

  // ── Comparativo ───────────────────────────────────────────────────────────
  it('compara sucursales, ordenadas por DEVENGADO', async () => {
    const t = await tablero('?days=30');
    expect(Array.isArray(t.branches)).toBe(true);
    expect(t.branches.length).toBeGreaterThan(0);

    const devengados = t.branches.map((b: { accruedCents: string }) => BigInt(b.accruedCents));
    for (let i = 1; i < devengados.length; i++) {
      expect(devengados[i - 1] >= devengados[i]).toBe(true);
    }
  });

  it('muestra los cortes ABIERTOS, que es lo que el dueño mira desde el móvil', async () => {
    const t = await tablero();
    const abiertos = t.openCashSessions as Array<{ id: string; registerCode: string }>;
    expect(abiertos.some((s) => s.id === turno)).toBe(true);
    expect(abiertos.every((s) => typeof s.registerCode === 'string')).toBe(true);
  });

  it('reporta morosidad como proporción de la cartera', async () => {
    const t = await tablero();
    expect(t.portfolio.delinquencyRate).toBeGreaterThanOrEqual(0);
    expect(t.portfolio.delinquencyRate).toBeLessThanOrEqual(1);
    expect(BigInt(t.portfolio.overdueCents)).toBeLessThanOrEqual(BigInt(t.portfolio.outstandingCents));
    expect(t.portfolio.membersBehind).toBeGreaterThanOrEqual(0);
    expect(t.portfolio.membersBehind).toBeLessThanOrEqual(t.portfolio.membersBase);
    expect(t.portfolio.membersBase).toBeGreaterThanOrEqual(t.activeMembers);
  });

  // ── Ventana ───────────────────────────────────────────────────────────────
  it('una ventana de 30 días devenga MÁS que una de un día', async () => {
    const dia = await tablero();
    const mes = await tablero('?days=30');
    expect(BigInt(mes.money.accruedCents)).toBeGreaterThanOrEqual(BigInt(dia.money.accruedCents));
  });

  it('rechaza un rango invertido', async () => {
    const res = await app.inject({
      method: 'GET', url: '/dashboard?from=2026-10-01&to=2026-09-01', headers: { cookie: owner },
    });
    expect(res.statusCode).toBe(422);
  });

  it('el saldo MIGRADO no cuenta como ingreso', async () => {
    const socio = await nuevoSocio();
    const antes = await tablero('?days=30');

    const res = await app.inject({
      method: 'POST', url: `/members/${socio}/charges`, headers: { cookie: owner },
      payload: {
        chargeType: 'OPENING_BALANCE', concept: 'Saldo migrado de BDKGYM',
        subtotalCents: '500000', reason: 'Migración de saldo inicial', branchId,
      },
    });
    expect(res.statusCode, res.body).toBe(201);

    const despues = await tablero('?days=30');
    // Aparece en la cartera…
    expect(BigInt(despues.portfolio.outstandingCents)).toBeGreaterThan(BigInt(antes.portfolio.outstandingCents));
    // …pero NO como ingreso ganado por GymFlow.
    expect(despues.money.accruedCents).toBe(antes.money.accruedCents);
  });

  // ── Permisos ──────────────────────────────────────────────────────────────
  it('recepción NO ve el tablero financiero', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: reception } });
    expect(res.statusCode).toBe(403);
  });

  it('sin sesión, el tablero responde 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(401);
  });
});
