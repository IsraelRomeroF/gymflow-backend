import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { cycleChargeKey } from '@gymflow/core';
import { makeApp, loginAs, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { CashSessionRepository } from '../src/modules/cash/index.js';

/**
 * FASE 3 · BLOQUE 3.5 · D-13 «DEVOLVER DINERO» (lo del estado de cuenta; la
 * tienda está en `tienda-devoluciones.test.ts`).
 *
 *  · Una parte de un cobro de mostrador: siempre con la firma de la dueña; el
 *    efectivo sale del turno abierto; la transferencia lleva su referencia.
 *  · Al cancelar, lo pagado y no usado queda a favor; devolverlo en dinero
 *    también pide la firma.
 * Gimnasio propio: plan mensual de $600, una sede con dos cajas.
 */
describe('dinero del socio · D-13', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente: string; let recepcion: string;
  let sede: string; let turno: string;

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio();
    sede = g.sedes[0]!.id;
    gerente = await loginAs(app, g.correos.gerente);
    recepcion = await loginAs(app, g.correos.recepcion);
    const t = await post(gerente, '/cash-sessions', { cashRegisterId: g.sedes[0]!.cajas[0], openingFloatCents: '100000' });
    expect(t.statusCode, t.body).toBe(201);
    turno = t.json().id;
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  const post = (cookie: string, url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, headers: { cookie }, payload });
  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const llave = () => `d13-${randomUUID()}`;
  const enCaja = async () => new CashSessionRepository(g.organizationId).expectedCashCents((await new CashSessionRepository(g.organizationId).findById(turno))!);
  const firma = (permiso: string, resourceId: string, amountCents: string) => aprobacion(app, gerente, permiso, g.correos.owner, sede, { resourceId, amountCents });
  const estado = async (memberId: string) => (await get(gerente, `/members/${memberId}/statement`)).json();

  /** Vende el plan mensual y lo cobra: en efectivo (a la caja abierta) o por transferencia. */
  async function venderPagado(metodo: 'CASH' | 'SPEI_TRANSFER' = 'CASH') {
    const memberId = await socioPropio(g);
    const r = await post(gerente, `/members/${memberId}/memberships/sale`, {
      planId: g.planMensual, branchId: sede, saleKey: llave(),
      payment: metodo === 'CASH' ? { method: 'CASH', cashSessionId: turno } : { method: 'SPEI_TRANSFER', externalRef: `REF-${randomUUID().slice(0, 8)}` },
    });
    expect(r.statusCode, r.body).toBe(201);
    const v = r.json() as { membership: { id: string }; charges: Array<{ id: string }>; payment: { id: string; amountCents: string } };
    return { memberId, membershipId: v.membership.id, chargeId: v.charges[0]!.id, paymentId: v.payment.id };
  }
  /** Lleva el periodo en curso (y su cuota) a que haya empezado hace `dias` y dure 30. */
  async function periodoEmpezadoHace(membershipId: string, chargeId: string, dias: number) {
    const m = await getDb().membership.findUniqueOrThrow({ where: { id: membershipId } });
    const inicio = new Date(m.currentPeriodStart.getTime() - dias * 86_400_000);
    const fin = new Date(inicio.getTime() + 30 * 86_400_000);
    await getDb().membership.update({ where: { id: membershipId }, data: { startDate: inicio, currentPeriodStart: inicio, currentPeriodEnd: fin } });
    await getDb().charge.update({ where: { id: chargeId }, data: { periodStart: inicio, periodEnd: fin, dueDate: inicio, idempotencyKey: cycleChargeKey(membershipId, inicio) } });
  }

  // ── Una parte de un cobro ─────────────────────────────────────────────────

  it('devolver una parte de un cobro en efectivo: con firma, sale del turno abierto con su folio y el cargo no vuelve a deber', async () => {
    const { memberId, membershipId, chargeId, paymentId } = await venderPagado('CASH');
    const antes = await enCaja();
    const cuerpo = { amountCents: '20000', reason: 'Se le cobró de más', requestKey: llave(), cashSessionId: turno };

    const sinFirma = await post(gerente, `/payments/${paymentId}/return`, cuerpo);
    expect(sinFirma.statusCode, sinFirma.body).toBe(428);
    expect(await enCaja()).toBe(antes);

    const r = await post(gerente, `/payments/${paymentId}/return`, { ...cuerpo, approvalToken: await firma('payments:refund', paymentId, '20000') });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().entry).toMatchObject({ amountCents: '-20000', method: 'CASH', cashSessionId: turno, reversesPaymentId: paymentId });
    expect(r.json().entry.folio).toBeTruthy();
    expect(r.json().remainingCents).toBe('40000');
    // El efectivo salió de ESTA caja.
    expect(await enCaja()).toBe(antes - 20_000n);
    // El cargo queda saldado: $400 pagados y $200 corregidos; el socio no debe y sigue activo.
    const cargo = await getDb().charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(cargo).toMatchObject({ status: 'PAID', allocatedCents: 40_000n, adjustedCents: 20_000n });
    expect((await estado(memberId)).outstandingCents).toBe('0');
    expect((await getDb().membership.findUniqueOrThrow({ where: { id: membershipId } })).status).toBe('ACTIVE');
    // Quedó en la bitácora con quién lo firmó.
    const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'payments.return', resourceId: paymentId } });
    expect(asiento.approvedByUserId).toBe(g.ownerId);

    // El reintento del mismo envío es la misma devolución: 200, sin otra firma y sin sacar más dinero.
    const otraVez = await post(gerente, `/payments/${paymentId}/return`, cuerpo);
    expect(otraVez.statusCode, otraVez.body).toBe(200);
    expect(otraVez.json().entry.id).toBe(r.json().entry.id);
    expect(await enCaja()).toBe(antes - 20_000n);
  });

  it('no se devuelve más de lo que queda de ese cobro: justo lo que queda sí, un peso más no', async () => {
    const { paymentId } = await venderPagado('CASH');
    const primera = await post(gerente, `/payments/${paymentId}/return`, { amountCents: '25000', reason: 'Primera parte', requestKey: llave(), cashSessionId: turno, approvalToken: await firma('payments:refund', paymentId, '25000') });
    expect(primera.statusCode, primera.body).toBe(201);
    // Quedan $350. $351 no pasa (y la firma no se gasta: la operación no ocurrió).
    const token = await firma('payments:refund', paymentId, '35100');
    const deMas = await post(gerente, `/payments/${paymentId}/return`, { amountCents: '35100', reason: 'Más de lo que queda', requestKey: llave(), cashSessionId: turno, approvalToken: token });
    expect(deMas.statusCode, deMas.body).toBe(422);
    expect(deMas.json().reason).toBe('RETURN_EXCEEDS_PAYMENT');
    const justo = await post(gerente, `/payments/${paymentId}/return`, { amountCents: '35000', reason: 'Lo que quedaba', requestKey: llave(), cashSessionId: turno, approvalToken: await firma('payments:refund', paymentId, '35000') });
    expect(justo.statusCode, justo.body).toBe(201);
    expect(justo.json().remainingCents).toBe('0');
    // Ya no queda nada, y tampoco se puede revertir completo lo ya devuelto.
    const rev = await post(gerente, `/payments/${paymentId}/reverse`, { reason: 'Doble devolución', approvalToken: await firma('payments:reverse', paymentId, '60000'), cashSessionId: turno });
    expect(rev.statusCode).toBe(409);
  });

  it('la devolución de un cobro por transferencia pide su referencia y no toca la caja', async () => {
    const { paymentId } = await venderPagado('SPEI_TRANSFER');
    const antes = await enCaja();
    const sinRef = await post(gerente, `/payments/${paymentId}/return`, { amountCents: '10000', reason: 'Pagó de más', requestKey: llave(), approvalToken: await firma('payments:refund', paymentId, '10000') });
    expect(sinRef.statusCode, sinRef.body).toBe(422);
    expect(sinRef.json().reason).toBe('RETURN_REFERENCE_REQUIRED');
    const r = await post(gerente, `/payments/${paymentId}/return`, { amountCents: '10000', reason: 'Pagó de más', requestKey: llave(), returnRef: 'DEV-778899', approvalToken: await firma('payments:refund', paymentId, '10000') });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().entry).toMatchObject({ amountCents: '-10000', method: 'SPEI_TRANSFER', externalRef: 'DEV-778899', cashSessionId: null, folio: null });
    expect(await enCaja()).toBe(antes);
  });

  it('recepción no devuelve dinero, ni con la firma de la dueña en la mano', async () => {
    const { paymentId, memberId } = await venderPagado('CASH');
    const r = await post(recepcion, `/payments/${paymentId}/return`, { amountCents: '100', reason: 'Intento', requestKey: llave(), cashSessionId: turno });
    expect(r.statusCode).toBe(403);
    const c = await post(recepcion, `/members/${memberId}/credit/return`, { amountCents: '100', method: 'CASH', branchId: sede, reason: 'Intento', requestKey: llave() });
    expect(c.statusCode).toBe(403);
  });

  // ── Lo no usado al cancelar ───────────────────────────────────────────────

  it('al cancelar, lo pagado y no usado queda a favor: 20 de 30 días de $600 son $400', async () => {
    const { memberId, membershipId, chargeId } = await venderPagado('SPEI_TRANSFER');
    await periodoEmpezadoHace(membershipId, chargeId, 10);
    const r = await post(gerente, `/memberships/${membershipId}/cancel`, { reason: 'Se muda de ciudad' });
    expect(r.statusCode, r.body).toBe(200);
    const st = await estado(memberId);
    expect(st.creditCents).toBe('40000');
    expect(st.outstandingCents).toBe('0');
    const nota = await getDb().payment.findFirstOrThrow({ where: { memberId, method: 'CREDIT_NOTE' } });
    expect(nota).toMatchObject({ amountCents: 40_000n, unappliedCents: 40_000n, cashSessionId: null });
    const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'billing.credit.unused', resourceId: memberId } });
    expect(asiento.afterState).toMatchObject({ amountCents: '40000', remainingDays: 20, cycleDays: 30 });
    // La cuota que pagó sigue pagada: cancelar no deshace el cobro.
    expect((await getDb().charge.findUniqueOrThrow({ where: { id: chargeId } })).status).toBe('PAID');
  });

  it('lo que queda a favor cubre primero lo que el socio deba', async () => {
    const { memberId, membershipId, chargeId } = await venderPagado('SPEI_TRANSFER');
    await periodoEmpezadoHace(membershipId, chargeId, 10);
    const extra = await post(gerente, `/members/${memberId}/charges`, { chargeType: 'MANUAL_ADJUSTMENT', concept: 'Casillero', subtotalCents: '15000', reason: 'Renta de casillero', branchId: sede });
    expect(extra.statusCode, extra.body).toBe(201);
    await post(gerente, `/memberships/${membershipId}/cancel`, { reason: 'Cambio de horario' });
    const st = await estado(memberId);
    expect(st.outstandingCents).toBe('0');
    expect(st.creditCents).toBe('25000');
  });

  it('una membresía que se cancela el día que vence, o sin haber pagado, no deja nada a favor', async () => {
    const { memberId, membershipId, chargeId } = await venderPagado('SPEI_TRANSFER');
    await periodoEmpezadoHace(membershipId, chargeId, 30);
    await post(gerente, `/memberships/${membershipId}/cancel`, { reason: 'Terminó su mes' });
    expect((await estado(memberId)).creditCents).toBe('0');
  });

  it('devolver el saldo a favor: con firma, en efectivo del turno abierto; no más de lo que tiene; el reintento no saca más', async () => {
    const { memberId, membershipId, chargeId } = await venderPagado('SPEI_TRANSFER');
    await periodoEmpezadoHace(membershipId, chargeId, 10);
    await post(gerente, `/memberships/${membershipId}/cancel`, { reason: 'Se muda de ciudad' });
    const antes = await enCaja();
    const cuerpo = { amountCents: '40000', method: 'CASH', branchId: sede, cashSessionId: turno, reason: 'Pidió su dinero al cancelar', requestKey: llave() };

    expect((await post(gerente, `/members/${memberId}/credit/return`, cuerpo)).statusCode).toBe(428);
    const deMas = await post(gerente, `/members/${memberId}/credit/return`, { ...cuerpo, amountCents: '40100', requestKey: llave(), approvalToken: await firma('payments:refund', memberId, '40100') });
    expect(deMas.statusCode, deMas.body).toBe(409);
    expect(deMas.json().reason).toBe('NO_CREDIT');
    expect(await enCaja()).toBe(antes);

    const r = await post(gerente, `/members/${memberId}/credit/return`, { ...cuerpo, approvalToken: await firma('payments:refund', memberId, '40000') });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ returnedCents: '40000', creditCents: '0' });
    expect(r.json().entries).toHaveLength(1);
    expect(r.json().entries[0]).toMatchObject({ amountCents: '-40000', method: 'CASH', cashSessionId: turno });
    expect(await enCaja()).toBe(antes - 40_000n);
    expect((await estado(memberId)).creditCents).toBe('0');

    const otraVez = await post(gerente, `/members/${memberId}/credit/return`, cuerpo);
    expect(otraVez.statusCode, otraVez.body).toBe(200);
    expect(otraVez.json().entries[0].id).toBe(r.json().entries[0].id);
    expect(await enCaja()).toBe(antes - 40_000n);

    // Lo devuelto ya no es saldo a favor: una cuota nueva no se cubre con él (antes sí: se aplicaba dos veces).
    const cargo = await post(gerente, `/members/${memberId}/charges`, { chargeType: 'MANUAL_ADJUSTMENT', concept: 'Casillero', subtotalCents: '10000', reason: 'Renta de casillero', branchId: sede });
    expect(cargo.statusCode, cargo.body).toBe(201);
    const aplicar = await post(gerente, `/members/${memberId}/credit/apply`, { branchId: sede });
    expect(aplicar.json().appliedCents).toBe('0');
    expect((await estado(memberId)).outstandingCents).toBe('10000');
  });

  it('devolver una parte del saldo a favor por transferencia: pide la referencia y deja el resto a favor', async () => {
    const { memberId, membershipId, chargeId } = await venderPagado('SPEI_TRANSFER');
    await periodoEmpezadoHace(membershipId, chargeId, 10);
    await post(gerente, `/memberships/${membershipId}/cancel`, { reason: 'Se muda de ciudad' });
    const cuerpo = { amountCents: '15000', method: 'SPEI_TRANSFER', branchId: sede, reason: 'Pidió una parte', requestKey: llave() };
    const sinRef = await post(gerente, `/members/${memberId}/credit/return`, { ...cuerpo, approvalToken: await firma('payments:refund', memberId, '15000') });
    expect(sinRef.statusCode).toBe(422);
    expect(sinRef.json().reason).toBe('RETURN_REFERENCE_REQUIRED');
    const r = await post(gerente, `/members/${memberId}/credit/return`, { ...cuerpo, returnRef: 'SPEI-DEV-0001', approvalToken: await firma('payments:refund', memberId, '15000') });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ returnedCents: '15000', creditCents: '25000' });
    expect(r.json().entries[0]).toMatchObject({ method: 'SPEI_TRANSFER', externalRef: 'SPEI-DEV-0001', cashSessionId: null });
  });
});
