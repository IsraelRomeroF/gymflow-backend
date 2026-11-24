import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { makeApp, loginAs, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { CashSessionRepository } from '../src/modules/cash/index.js';

/**
 * FASE 3 · BLOQUE 3.5 · D-13 EN LA TIENDA.
 *
 * Recepción marca la venta «por corregir»; la gerencia la anula el mismo día
 * o, si su turno ya se cortó (o es de otro día), registra su devolución con la
 * firma de la dueña: el dinero sale del turno abierto y el producto vuelve al
 * inventario. Gimnasio propio: una sede con dos cajas, un producto de $50.
 */
describe('tienda · por corregir y devolución (D-13)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente: string; let recepcion: string;
  let sede: string; let producto: string;

  const post = (cookie: string, url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, headers: { cookie }, payload });
  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const existencias = async () => (await getDb().inventoryStock.findFirstOrThrow({ where: { branchId: sede, productId: producto } })).quantityOnHand;
  const enCaja = async (turno: string) => { const r = new CashSessionRepository(g.organizationId); return r.expectedCashCents((await r.findById(turno))!); };
  const abrir = async (caja: number) => {
    const t = await post(gerente, '/cash-sessions', { cashRegisterId: g.sedes[0]!.cajas[caja], openingFloatCents: '50000' });
    expect(t.statusCode, t.body).toBe(201);
    return t.json().id as string;
  };
  const cortar = async (turno: string) => {
    const r = await post(gerente, `/cash-sessions/${turno}/close`, { countedCashCents: (await enCaja(turno)).toString() });
    expect(r.statusCode, r.body).toBe(200);
  };
  const vender = async (turno: string, method: 'CASH' | 'SPEI_TRANSFER' = 'CASH', quantity = 2) => {
    const r = await post(recepcion, '/pos/sales', {
      branchId: sede, method, cashSessionId: turno, lines: [{ productId: producto, quantity }], idempotencyKey: `tienda-${randomUUID()}`,
      ...(method === 'SPEI_TRANSFER' ? { externalRef: 'SPEI-VENTA-1' } : {}),
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; totalCents: string };
  };
  const firma = (saleId: string, amountCents: string) => aprobacion(app, gerente, 'pos:sale:return', g.correos.owner, sede, { resourceId: saleId, amountCents });

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio();
    sede = g.sedes[0]!.id;
    gerente = await loginAs(app, g.correos.gerente);
    recepcion = await loginAs(app, g.correos.recepcion);
    const p = await post(gerente, '/products', { sku: `AGUA-${randomUUID().slice(0, 6)}`, name: 'Agua de prueba', priceCents: '5000', tracksInventory: true });
    expect(p.statusCode, p.body).toBe(201);
    producto = p.json().id;
    const e = await post(gerente, '/inventory/movements', { branchId: sede, productId: producto, movementType: 'PURCHASE', quantityDelta: 50, reason: 'Compra inicial de prueba' });
    expect(e.statusCode, e.body).toBe(201);
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  it('recepción marca «por corregir» (no anula ni devuelve); la gerencia la ve y, siendo de hoy, la anula y la marca queda resuelta', async () => {
    const turno = await abrir(0);
    const venta = await vender(turno);
    const antes = await existencias();

    // Recepción no puede anular ni devolver: avisa.
    expect((await post(recepcion, `/pos/sales/${venta.id}/void`, { reason: 'Me equivoqué' })).statusCode).toBe(403);
    expect((await post(recepcion, `/pos/sales/${venta.id}/return`, { reason: 'Me equivoqué' })).statusCode).toBe(403);
    const sinMotivo = await post(recepcion, `/pos/sales/${venta.id}/flag`, { reason: '' });
    expect(sinMotivo.statusCode).toBe(422);
    const marca = await post(recepcion, `/pos/sales/${venta.id}/flag`, { reason: 'Cobré dos aguas y era una' });
    expect(marca.statusCode, marca.body).toBe(201);
    expect(marca.json().correction.flag).toMatchObject({ reason: 'Cobré dos aguas y era una' });
    expect(marca.json()).toMatchObject({ status: 'COMPLETED', canVoid: true, canReturn: false });
    // Marcar no mueve ni dinero ni producto.
    expect(await existencias()).toBe(antes);

    const lista = await get(gerente, `/pos/flagged-sales?branchId=${sede}`);
    expect(lista.statusCode, lista.body).toBe(200);
    expect(lista.json().items.filter((i: { saleId: string }) => i.saleId === venta.id)).toMatchObject([{ reason: 'Cobré dos aguas y era una', sameDay: true, totalCents: '10000' }]);

    // Es de hoy y su turno sigue abierto: no se «devuelve», se anula.
    const dev = await post(gerente, `/pos/sales/${venta.id}/return`, { reason: 'Cobro de más', approvalToken: await firma(venta.id, '10000') });
    expect(dev.statusCode, dev.body).toBe(409);
    expect(dev.json().reason).toBe('SALE_SAME_DAY');

    const anulada = await post(gerente, `/pos/sales/${venta.id}/void`, { reason: 'Cobro de más' });
    expect(anulada.statusCode, anulada.body).toBe(200);
    expect(anulada.json().status).toBe('VOIDED');
    expect(await existencias()).toBe(antes + 2);
    const marcaFinal = await getDb().posSaleFlag.findFirstOrThrow({ where: { posSaleId: venta.id } });
    expect(marcaFinal.resolution).toBe('VOIDED');
    expect((await get(gerente, `/pos/flagged-sales?branchId=${sede}`)).json().items.some((i: { saleId: string }) => i.saleId === venta.id)).toBe(false);
    await cortar(turno);
  });

  it('con el turno ya cortado no se anula: se devuelve con la firma de la dueña, el efectivo sale del turno abierto y el producto vuelve', async () => {
    const turnoViejo = await abrir(0);
    const venta = await vender(turnoViejo);
    await post(recepcion, `/pos/sales/${venta.id}/flag`, { reason: 'El cliente regresó las aguas' });
    await cortar(turnoViejo);
    const turnoNuevo = await abrir(1);
    const antes = { caja: await enCaja(turnoNuevo), stock: await existencias() };

    const ticket = (await get(gerente, `/pos/sales/${venta.id}`)).json();
    expect(ticket).toMatchObject({ canVoid: false, canReturn: true });
    // Anular ya no procede, y el mensaje dice qué hacer.
    const anular = await post(gerente, `/pos/sales/${venta.id}/void`, { reason: 'Regresó las aguas' });
    expect(anular.statusCode).toBe(409);

    // Sin firma: 428, y nada se mueve.
    const sinFirma = await post(gerente, `/pos/sales/${venta.id}/return`, { reason: 'Regresó las aguas', cashSessionId: turnoNuevo });
    expect(sinFirma.statusCode, sinFirma.body).toBe(428);
    expect(await enCaja(turnoNuevo)).toBe(antes.caja);
    expect(await existencias()).toBe(antes.stock);

    const r = await post(gerente, `/pos/sales/${venta.id}/return`, { reason: 'Regresó las aguas', cashSessionId: turnoNuevo, approvalToken: await firma(venta.id, '10000') });
    expect(r.statusCode, r.body).toBe(201);
    // La venta sigue «completada» en su día; lo que hay es su devolución, de hoy.
    expect(r.json()).toMatchObject({ status: 'COMPLETED', canVoid: false, canReturn: false });
    expect(r.json().correction).toMatchObject({ flag: null, returned: { amountCents: '10000', method: 'CASH', reason: 'Regresó las aguas' } });
    expect(await enCaja(turnoNuevo)).toBe(antes.caja - 10_000n);
    expect(await existencias()).toBe(antes.stock + 2);
    // El turno ya cortado no cambió.
    const viejo = await getDb().cashSession.findUniqueOrThrow({ where: { id: turnoViejo } });
    expect(viejo.varianceCents).toBe(0n);
    const fila = await getDb().posSaleReturn.findFirstOrThrow({ where: { posSaleId: venta.id } });
    expect(fila).toMatchObject({ amountCents: 10_000n, cashSessionId: turnoNuevo, approvedByUserId: g.ownerId });
    expect((await getDb().posSaleFlag.findFirstOrThrow({ where: { posSaleId: venta.id } })).resolution).toBe('RETURNED');
    const movimiento = await getDb().inventoryMovement.findFirstOrThrow({ where: { posSaleId: venta.id, movementType: 'SALE_VOIDED' } });
    expect(movimiento.quantityDelta).toBe(2);
    expect(await getDb().auditLog.count({ where: { organizationId: g.organizationId, action: 'pos.sale.return', resourceId: venta.id, approvedByUserId: g.ownerId } })).toBe(1);

    // No se devuelve dos veces.
    const otra = await post(gerente, `/pos/sales/${venta.id}/return`, { reason: 'Otra vez', cashSessionId: turnoNuevo, approvalToken: await firma(venta.id, '10000') });
    expect(otra.statusCode, otra.body).toBe(409);
    expect(otra.json().reason).toBe('SALE_ALREADY_RETURNED');
    expect(await enCaja(turnoNuevo)).toBe(antes.caja - 10_000n);

    // Movimientos: la devolución resta hoy, como reembolso.
    const hoy = fila.businessDate.toISOString().slice(0, 10);
    const dia = await get(gerente, `/reports/movements?date=${hoy}`);
    expect(dia.statusCode, dia.body).toBe(200);
    const renglon = (dia.json().movements as Array<{ kind: string; amountCents: string; concept: string | null }>).find((m) => m.concept?.includes('Regresó las aguas'));
    expect(renglon).toMatchObject({ kind: 'REFUND', amountCents: '-10000' });
    const resumen = await get(gerente, `/reports/daily?from=${hoy}&to=${hoy}`);
    expect(resumen.statusCode, resumen.body).toBe(200);
    // En el resumen del día lo devuelto cuenta como reembolso (negativo): al menos los $100 de esta venta.
    expect(BigInt(resumen.json().days[0].refundsCents)).toBeLessThanOrEqual(-10_000n);
    await cortar(turnoNuevo);
  });

  it('la devolución de una venta por transferencia pide su referencia y no toca ninguna caja', async () => {
    const turno = await abrir(0);
    const venta = await vender(turno, 'SPEI_TRANSFER', 1);
    await cortar(turno);
    const otro = await abrir(1);
    const antes = await enCaja(otro);
    const sinRef = await post(gerente, `/pos/sales/${venta.id}/return`, { reason: 'Producto dañado', approvalToken: await firma(venta.id, '5000') });
    expect(sinRef.statusCode, sinRef.body).toBe(422);
    expect(sinRef.json().reason).toBe('RETURN_REFERENCE_REQUIRED');
    const r = await post(gerente, `/pos/sales/${venta.id}/return`, { reason: 'Producto dañado', returnRef: 'DEV-SPEI-9', approvalToken: await firma(venta.id, '5000') });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().correction.returned).toMatchObject({ method: 'SPEI_TRANSFER', returnRef: 'DEV-SPEI-9' });
    expect(await enCaja(otro)).toBe(antes);
    await cortar(otro);
  });

  it('la gerencia puede descartar un aviso que no procedía, con motivo; recepción no', async () => {
    const turno = await abrir(0);
    const venta = await vender(turno, 'CASH', 1);
    await post(recepcion, `/pos/sales/${venta.id}/flag`, { reason: 'Creo que cobré mal' });
    expect((await post(recepcion, `/pos/sales/${venta.id}/flag/dismiss`, { reason: 'Ya revisé' })).statusCode).toBe(403);
    const r = await post(gerente, `/pos/sales/${venta.id}/flag/dismiss`, { reason: 'Estaba bien cobrada' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().correction.flag).toBeNull();
    expect((await getDb().posSale.findUniqueOrThrow({ where: { id: venta.id } })).status).toBe('COMPLETED');
    // Otro gimnasio no la ve.
    const ajeno = await loginAs(app, 'gerente@demo.mx');
    expect((await post(ajeno, `/pos/sales/${venta.id}/flag`, { reason: 'Intento ajeno' })).statusCode).toBe(404);
    await cortar(turno);
  });
});
