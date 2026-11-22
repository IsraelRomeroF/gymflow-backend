import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

const db = () => getDb();
const sello = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4);

describe('punto de venta e integración al corte', () => {
  let app: FastifyInstance;
  let owner: string;
  let reception: string;
  let orgId: string;
  let branchId: string;
  let sesion: string;
  let agua: string;
  let casillero: string;

  async function nuevaCaja(): Promise<{ id: string; code: string }> {
    const res = await app.inject({
      method: 'POST', url: '/cash-registers', headers: { cookie: owner },
      payload: { branchId, code: `P${sello()}`.slice(0, 8), name: `Caja POS ${sello()}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    return { id: res.json().id, code: res.json().code };
  }

  async function abrirTurno(cashRegisterId: string, floatCents = '0'): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/cash-sessions', headers: { cookie: owner },
      payload: { cashRegisterId, openingFloatCents: floatCents },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  async function vender(lines: Array<{ productId: string; quantity: number }>, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST', url: '/pos/sales', headers: { cookie: reception },
      payload: { idempotencyKey: crypto.randomUUID(), branchId, method: 'CASH', cashSessionId: sesion, lines, ...extra },
    });
  }

  async function stockDe(productId: string): Promise<number> {
    const res = await app.inject({
      method: 'GET', url: `/inventory?branchId=${branchId}`, headers: { cookie: owner },
    });
    return res.json().stock.find((s: { productId: string }) => s.productId === productId)?.quantityOnHand ?? 0;
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    reception = await loginAs(app, 'recepcion@demo.mx');

    const { demo, demoBranches } = await orgFixtures();
    orgId = demo.id;
    branchId = demoBranches.find((b) => b.code === 'CEN')!.id;

    agua = (await db().product.findFirstOrThrow({ where: { organizationId: orgId, sku: 'AGUA600' } })).id;
    casillero = (await db().product.findFirstOrThrow({ where: { organizationId: orgId, sku: 'CASILLERO-DIA' } })).id;

    const caja = await nuevaCaja();
    sesion = await abrirTurno(caja.id);

    // Reposición: la suite CONSUME existencias, así que sin esto se agotan
    // tras unas cuantas corridas y los fallos parecen del producto.
    await app.inject({
      method: 'POST', url: '/inventory/movements', headers: { cookie: owner },
      payload: {
        branchId, productId: agua, movementType: 'PURCHASE',
        quantityDelta: 500, reason: 'Reposición para la batería de pruebas',
      },
    });
    await app.inject({
      method: 'POST', url: '/inventory/movements', headers: { cookie: owner },
      payload: {
        branchId, productId: (await db().product.findFirstOrThrow({
          where: { organizationId: orgId, sku: 'BARRA-CEREAL' },
        })).id,
        movementType: 'PURCHASE', quantityDelta: 500,
        reason: 'Reposición para la batería de pruebas',
      },
    });
  });

  afterAll(async () => {
    const rep = await app.inject({ method: 'GET', url: `/cash-sessions/${sesion}`, headers: { cookie: owner } });
    if (rep.statusCode === 200 && rep.json().session.status === 'OPEN') {
      await app.inject({
        method: 'POST', url: `/cash-sessions/${sesion}/close`, headers: { cookie: owner },
        payload: { countedCashCents: rep.json().expectedCashCents },
      });
    }
    await app.close();
    await closeDb();
  });

  // ── Venta ─────────────────────────────────────────────────────────────────
  it('vende y congela el precio en la línea', async () => {
    const res = await vender([{ productId: agua, quantity: 3 }]);
    expect(res.statusCode, res.body).toBe(201);
    const v = res.json();
    expect(v.totalCents).toBe('4500');          // 3 × $15.00
    expect(v.lines[0].unitPriceCents).toBe('1500');
    expect(v.lines[0].lineTotalCents).toBe('4500');
    expect(v.folio).toMatch(/^CEN-/);
  });

  it('el precio lo pone el CATÁLOGO, no el cliente', async () => {
    // Se intenta colar un precio en el cuerpo: debe ignorarse.
    const res = await app.inject({
      method: 'POST', url: '/pos/sales', headers: { cookie: reception },
      payload: { idempotencyKey: crypto.randomUUID(),
        branchId, method: 'CASH', cashSessionId: sesion,
        lines: [{ productId: agua, quantity: 1, unitPriceCents: '1' }],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().lines[0].unitPriceCents).toBe('1500');
  });

  it('subir el precio NO cambia el importe de una venta ya hecha', async () => {
    // Producto propio: cambiar el precio de uno compartido contaminaría las
    // demás pruebas si esta falla a mitad.
    const creado = await app.inject({
      method: 'POST', url: '/products', headers: { cookie: owner },
      payload: { sku: `PRE${sello()}`.toUpperCase(), name: 'Producto de prueba de precio', priceCents: '1500', tracksInventory: false },
    });
    expect(creado.statusCode, creado.body).toBe(201);
    const producto = creado.json().id as string;

    const antes = (await vender([{ productId: producto, quantity: 1 }])).json();
    expect(antes.totalCents).toBe('1500');

    await app.inject({
      method: 'PATCH', url: `/products/${producto}`, headers: { cookie: owner },
      payload: { priceCents: '9900' },
    });

    const releida = await app.inject({
      method: 'GET', url: `/pos/sales/${antes.id}`, headers: { cookie: owner },
    });
    expect(releida.json().totalCents).toBe('1500');
    expect(releida.json().lines[0].unitPriceCents).toBe('1500');
  });

  it('la venta DESCUENTA existencias', async () => {
    const antes = await stockDe(agua);
    const res = await vender([{ productId: agua, quantity: 2 }]);
    expect(res.statusCode).toBe(201);
    expect(await stockDe(agua)).toBe(antes - 2);
  });

  it('un SERVICIO no mueve existencias', async () => {
    const res = await vender([{ productId: casillero, quantity: 1 }]);
    expect(res.statusCode, res.body).toBe(201);
    const movimientos = await db().inventoryMovement.count({
      where: { organizationId: orgId, productId: casillero },
    });
    expect(movimientos).toBe(0);
  });

  it('NO se puede vender lo que no hay: lo impide la BASE, no solo la aplicación', async () => {
    const hay = await stockDe(agua);
    const ventasAntes = await db().posSale.count({ where: { organizationId: orgId } });

    const res = await vender([{ productId: agua, quantity: hay + 50 }]);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    // El stock no se movió…
    expect(await stockDe(agua)).toBe(hay);
    // …y TAMPOCO quedó una venta a medias. Sin transacción única, la venta se
    // creaba igual y el corte contaba producto que nunca salió del estante.
    expect(await db().posSale.count({ where: { organizationId: orgId } })).toBe(ventasAntes);
  });

  it('venta y movimiento de existencias son ATÓMICOS en toda la base', async () => {
    const huerfanas = await db().$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "pos_sales" s
      WHERE s."organizationId" = ${orgId}::uuid
        AND s."status" = 'COMPLETED'
        AND EXISTS (
          SELECT 1 FROM "pos_sale_lines" l JOIN "products" p ON p."id" = l."productId"
          WHERE l."posSaleId" = s."id" AND p."tracksInventory"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "inventory_movements" m WHERE m."posSaleId" = s."id"
        )`;
    expect(huerfanas[0]!.n).toBe(0);
  });

  it('una venta sin turno abierto no puede existir', async () => {
    const caja = await nuevaCaja();
    const otra = await abrirTurno(caja.id);
    await app.inject({
      method: 'POST', url: `/cash-sessions/${otra}/close`, headers: { cookie: owner },
      payload: { countedCashCents: '0' },
    });
    const res = await vender([{ productId: agua, quantity: 1 }], { cashSessionId: otra });
    expect(res.statusCode).toBe(409);
  });

  // ── Anulación ─────────────────────────────────────────────────────────────
  it('anular DEVUELVE el producto al estante', async () => {
    const antes = await stockDe(agua);
    const venta = (await vender([{ productId: agua, quantity: 4 }])).json();
    expect(await stockDe(agua)).toBe(antes - 4);

    const res = await app.inject({
      method: 'POST', url: `/pos/sales/${venta.id}/void`, headers: { cookie: owner },
      payload: { reason: 'El socio devolvió el producto sin abrir' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('VOIDED');
    expect(await stockDe(agua)).toBe(antes);
  });

  it('no se anula dos veces', async () => {
    const venta = (await vender([{ productId: agua, quantity: 1 }])).json();
    const uno = await app.inject({
      method: 'POST', url: `/pos/sales/${venta.id}/void`, headers: { cookie: owner },
      payload: { reason: 'Primera anulación legítima' },
    });
    expect(uno.statusCode).toBe(200);
    const dos = await app.inject({
      method: 'POST', url: `/pos/sales/${venta.id}/void`, headers: { cookie: owner },
      payload: { reason: 'Segunda, no debe pasar' },
    });
    expect(dos.statusCode).toBe(409);
  });

  it('una venta de OTRO día no se anula: el corte ya cerró', async () => {
    const venta = (await vender([{ productId: agua, quantity: 1 }])).json();
    // Se retrasa la fecha de operación con el rol dueño, simulando ayer.
    const { createPrismaClient } = await import('@gymflow/db');
    const dueno = createPrismaClient(process.env.DATABASE_URL_MIGRATOR);
    try {
      await dueno.$executeRawUnsafe(
        `UPDATE "pos_sales" SET "businessDate" = "businessDate" - INTERVAL '1 day' WHERE "id" = '${venta.id}'`,
      );
    } finally {
      await dueno.$disconnect();
    }

    const res = await app.inject({
      method: 'POST', url: `/pos/sales/${venta.id}/void`, headers: { cookie: owner },
      payload: { reason: 'Intento de anular una venta de ayer' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/devolución/);
  });

  // ── CRITERIO DE ACEPTACIÓN: un solo documento ────────────────────────────
  it('el corte incluye membresías Y producto en UN SOLO documento', async () => {
    const caja = await nuevaCaja();
    const turno = await abrirTurno(caja.id, '100000');

    // Un cobro de membresía…
    const socio = await db().member.findFirstOrThrow({
      where: { organizationId: orgId, deletedAt: null },
    });
    await app.inject({
      method: 'POST', url: `/members/${socio.id}/charges`, headers: { cookie: owner },
      payload: {
        chargeType: 'MANUAL_ADJUSTMENT', concept: 'Cuota de prueba del corte',
        subtotalCents: '65000', reason: 'Prueba de corte con producto', branchId,
      },
    });
    await app.inject({
      method: 'POST', url: `/members/${socio.id}/payments`, headers: { cookie: owner },
      payload: { idempotencyKey: crypto.randomUUID(), method: 'CASH', amountCents: '65000', branchId, cashSessionId: turno },
    });

    // …y una venta de producto, en el MISMO turno.
    const venta = await app.inject({
      method: 'POST', url: '/pos/sales', headers: { cookie: reception },
      payload: { idempotencyKey: crypto.randomUUID(), branchId, method: 'CASH', cashSessionId: turno, lines: [{ productId: agua, quantity: 2 }] },
    });
    expect(venta.statusCode, venta.body).toBe(201);

    const rep = await app.inject({
      method: 'GET', url: `/cash-sessions/${turno}`, headers: { cookie: owner },
    });
    const r = rep.json();

    // 100,000 de fondo + 65,000 de cuota + 3,000 de producto.
    expect(r.cashCollectedCents).toBe('68000');
    expect(r.expectedCashCents).toBe('168000');
    // Y el documento dice de dónde viene cada peso.
    expect(r.contributions.find((c: { source: string }) => c.source === 'POS').byMethod[0].amountCents).toBe('3000');

    const cierre = await app.inject({
      method: 'POST', url: `/cash-sessions/${turno}/close`, headers: { cookie: owner },
      payload: { countedCashCents: '168000' },
    });
    expect(cierre.statusCode, cierre.body).toBe(200);
    expect(cierre.json().varianceCents).toBe('0');
  });

  it('una venta ANULADA no cuenta en el corte', async () => {
    const caja = await nuevaCaja();
    const turno = await abrirTurno(caja.id, '0');

    const venta = (await app.inject({
      method: 'POST', url: '/pos/sales', headers: { cookie: reception },
      payload: { idempotencyKey: crypto.randomUUID(), branchId, method: 'CASH', cashSessionId: turno, lines: [{ productId: agua, quantity: 2 }] },
    })).json();

    await app.inject({
      method: 'POST', url: `/pos/sales/${venta.id}/void`, headers: { cookie: owner },
      payload: { reason: 'Anulada antes del corte' },
    });

    const rep = await app.inject({ method: 'GET', url: `/cash-sessions/${turno}`, headers: { cookie: owner } });
    expect(rep.json().expectedCashCents).toBe('0');
  });

  it('tras el corte, ni se anula la venta ni se cobra en ese turno (BE2-12, BE2-13)', async () => {
    const caja = await nuevaCaja();
    const turno = await abrirTurno(caja.id, '0');
    const venta = (await app.inject({
      method: 'POST', url: '/pos/sales', headers: { cookie: reception },
      payload: { idempotencyKey: crypto.randomUUID(), branchId, method: 'CASH', cashSessionId: turno, lines: [{ productId: agua, quantity: 1 }] },
    })).json();
    const esperado = (await app.inject({ method: 'GET', url: `/cash-sessions/${turno}`, headers: { cookie: owner } })).json().expectedCashCents;
    const cierre = await app.inject({
      method: 'POST', url: `/cash-sessions/${turno}/close`, headers: { cookie: owner }, payload: { countedCashCents: esperado },
    });
    expect(cierre.statusCode, cierre.body).toBe(200);

    const anular = await app.inject({
      method: 'POST', url: `/pos/sales/${venta.id}/void`, headers: { cookie: owner }, payload: { reason: 'Después del corte' },
    });
    expect(anular.statusCode).toBe(409);
    expect(anular.json().message).toMatch(/turno.*cerr/i);

    const otraVenta = await app.inject({
      method: 'POST', url: '/pos/sales', headers: { cookie: reception },
      payload: { idempotencyKey: crypto.randomUUID(), branchId, method: 'CASH', cashSessionId: turno, lines: [{ productId: agua, quantity: 1 }] },
    });
    expect(otraVenta.statusCode).toBeGreaterThanOrEqual(400);
    // El corte firmado no se movió.
    const despues = (await app.inject({ method: 'GET', url: `/cash-sessions/${turno}`, headers: { cookie: owner } })).json();
    expect(despues.session.expectedCashCents).toBe(esperado);
  });

  // ── Inventario ────────────────────────────────────────────────────────────
  it('un ajuste de inventario exige motivo y queda en la bitácora', async () => {
    const res = await app.inject({
      method: 'POST', url: '/inventory/movements', headers: { cookie: owner },
      payload: {
        branchId, productId: agua, movementType: 'SHRINKAGE',
        quantityDelta: -2, reason: 'Dos botellas rotas en el traslado',
      },
    });
    expect(res.statusCode, res.body).toBe(201);

    const bitacora = await db().auditLog.findFirst({
      where: { organizationId: orgId, action: 'pos.inventory.adjust' },
      orderBy: { at: 'desc' },
    });
    expect(bitacora?.reason).toMatch(/rotas/);
  });

  it('la base RECHAZA una merma con signo positivo', async () => {
    const usuario = await db().user.findFirstOrThrow({ where: { organizationId: orgId } });
    await expect(db().$executeRawUnsafe(`
      INSERT INTO "inventory_movements" ("id","organizationId","branchId","productId","movementType","quantityDelta","reason","createdByUserId","businessDate")
      VALUES (gen_random_uuid(), '${orgId}', '${branchId}', '${agua}', 'SHRINKAGE', 5, 'Merma con signo invertido', '${usuario.id}', CURRENT_DATE)
    `)).rejects.toThrow(/inv_moves_sign_coherence_check/);
  });

  it('la base impide dejar el stock en NEGATIVO', async () => {
    await expect(db().$executeRawUnsafe(
      `UPDATE "inventory_stock" SET "quantityOnHand" = -1 WHERE "branchId" = '${branchId}' AND "productId" = '${agua}'`,
    )).rejects.toThrow(/stock_non_negative_check/);
  });

  it('el libro de inventario es append-only', async () => {
    const mov = await db().inventoryMovement.findFirstOrThrow({
      where: { organizationId: orgId, branchId },
    });
    await expect(db().inventoryMovement.delete({ where: { id: mov.id } }))
      .rejects.toThrow(/permission denied|append-only/);
  });

  it('recepción NO puede tocar el catálogo de productos', async () => {
    const res = await app.inject({
      method: 'POST', url: '/products', headers: { cookie: reception },
      payload: { sku: `X${sello()}`, name: 'Intento sin permiso', priceCents: '1000' },
    });
    expect(res.statusCode).toBe(403);
  });
});
