import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { makeApp, loginAs, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { MEMBERSHIP_JOBS } from '../src/modules/memberships/index.js';

/**
 * FASE 3 · BLOQUE 3.5 · D-12 «NADA SE BORRA SOLO».
 *
 * La baja y la cancelación no condonan deuda; perdonar es una condonación con
 * monto: la gerencia sola hasta UNA MENSUALIDAD del socio (que se gasta en 30
 * días), arriba con la firma de la dueña; recepción no perdona; el camino sin
 * cobro ya no existe (eso último, en `sales.test.ts` y `dinero-unidad.test.ts`).
 * Gimnasio propio: plan mensual de $600.
 */
describe('dinero del socio · D-12', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente: string; let recepcion: string;
  let sede: string;

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio();
    sede = g.sedes[0]!.id;
    gerente = await loginAs(app, g.correos.gerente);
    recepcion = await loginAs(app, g.correos.recepcion);
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  const post = (cookie: string, url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, headers: { cookie }, payload });
  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  /** Vende el plan mensual; con `pagar`, por transferencia (no necesita caja). */
  async function vender(memberId: string, pagar: boolean) {
    const r = await post(gerente, `/members/${memberId}/memberships/sale`, {
      planId: g.planMensual, branchId: sede, saleKey: `d12-${randomUUID()}`,
      payment: pagar ? { method: 'SPEI_TRANSFER', externalRef: `REF-${randomUUID().slice(0, 8)}` } : null,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { membership: { id: string; status: string }; charges: Array<{ id: string; amountCents: string }> };
  }
  /** Una membresía ACTIVA que debe su cuota del periodo que corre (pagó, y se deshizo el cobro: queda en mora). */
  async function socioQueDebe() {
    const memberId = await socioPropio(g);
    const venta = await vender(memberId, true);
    const pago = (await get(gerente, `/members/${memberId}/statement`)).json().payments[0];
    const firma = await aprobacion(app, gerente, 'payments:reverse', g.correos.owner, sede, { resourceId: pago.id, amountCents: pago.amountCents });
    const rev = await post(gerente, `/payments/${pago.id}/reverse`, { reason: 'Transferencia que no llegó', approvalToken: firma });
    expect(rev.statusCode, rev.body).toBe(201);
    const m = await getDb().membership.findUniqueOrThrow({ where: { id: venta.membership.id } });
    expect(m.status).toBe('PAST_DUE');
    return { memberId, membershipId: venta.membership.id, chargeId: venta.charges[0]!.id };
  }
  const debe = async (memberId: string) => BigInt((await get(gerente, `/members/${memberId}/statement`)).json().outstandingCents);

  it('cancelar a quien debe su cuota NO borra la deuda: el cargo sigue abierto y el socio debe lo mismo', async () => {
    const { memberId, membershipId, chargeId } = await socioQueDebe();
    expect(await debe(memberId)).toBe(60_000n);
    const r = await post(gerente, `/memberships/${membershipId}/cancel`, { reason: 'Se muda de ciudad' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().status).toBe('CANCELED');
    const cargo = await getDb().charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(cargo.status).not.toBe('VOID');
    expect(cargo.voidReason).toBeNull();
    expect(await debe(memberId)).toBe(60_000n);
  });

  it('dar de baja a quien debe tampoco la borra: el cierre automático de su membresía deja la deuda', async () => {
    const { memberId, membershipId, chargeId } = await socioQueDebe();
    const baja = await post(gerente, `/members/${memberId}/archive`, { reason: 'Baja a petición del socio' });
    expect(baja.statusCode, baja.body).toBeLessThan(300);
    const cierre = MEMBERSHIP_JOBS.find((j) => j.name === 'membership.close-archived')!;
    const res = await cierre.handler(g.organizationId);
    expect(res.errors, JSON.stringify(res.errors)).toHaveLength(0);
    expect((await getDb().membership.findUniqueOrThrow({ where: { id: membershipId } })).status).toBe('CANCELED');
    const cargo = await getDb().charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(cargo.status).not.toBe('VOID');
    expect(cargo.amountCents - cargo.allocatedCents - cargo.adjustedCents).toBe(60_000n);
  });

  it('una venta que nunca se cobró ni dio acceso sí se anula al cancelarla: es la regla escrita, no un perdón', async () => {
    const memberId = await socioPropio(g);
    const venta = await vender(memberId, false);
    expect(venta.membership.status).toBe('PENDING');
    const r = await post(gerente, `/memberships/${venta.membership.id}/cancel`, { reason: 'Se equivocó de plan' });
    expect(r.statusCode, r.body).toBe(200);
    const cargo = await getDb().charge.findUniqueOrThrow({ where: { id: venta.charges[0]!.id } });
    expect(cargo.status).toBe('VOID');
    expect(cargo.voidReason).toContain('nunca se cobró');
    expect(await debe(memberId)).toBe(0n);
  });

  it('GET /members/:id/debt dice cuánto debe y cuánto se le puede perdonar sin firma', async () => {
    const { memberId } = await socioQueDebe();
    const r = await get(gerente, `/members/${memberId}/debt`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      outstandingCents: '60000', waiveAllNeedsApproval: false,
      waiver: { monthlyCents: '60000', usedCents: '0', availableCents: '60000', windowDays: 30 },
    });
    expect(r.json().charges).toHaveLength(1);
  });

  it('la gerencia condona sola JUSTO una mensualidad ($600) y el tope se gasta: después, ni un peso sin firma', async () => {
    const { memberId, chargeId } = await socioQueDebe();
    // Un segundo cargo para tener qué perdonar después.
    const extra = await post(gerente, `/members/${memberId}/charges`, { chargeType: 'MANUAL_ADJUSTMENT', concept: 'Reposición de credencial', subtotalCents: '10000', reason: 'Perdió su credencial', branchId: sede });
    expect(extra.statusCode, extra.body).toBe(201);

    const todo = await post(gerente, `/charges/${chargeId}/adjustments`, { adjustmentType: 'WAIVER', amountCents: '60000', reasonCode: 'LESION', reason: 'Incapacidad de un mes' });
    expect(todo.statusCode, todo.body).toBe(201);
    const ajuste = await getDb().chargeAdjustment.findFirstOrThrow({ where: { chargeId } });
    expect(ajuste.approvedByUserId).toBeNull();
    expect(ajuste.amountCents).toBe(60_000n);

    const tope = (await get(gerente, `/members/${memberId}/debt`)).json();
    expect(tope.waiver).toMatchObject({ usedCents: '60000', availableCents: '0' });
    expect(tope.waiveAllNeedsApproval).toBe(true);

    const unPeso = await post(gerente, `/charges/${extra.json().id}/adjustments`, { adjustmentType: 'WAIVER', amountCents: '100', reasonCode: 'CORTESIA', reason: 'Cortesía' });
    expect(unPeso.statusCode, unPeso.body).toBe(428);
    // Con la firma de la dueña, pasa; y lo firmado no gasta el tope.
    const firma = await aprobacion(app, gerente, 'billing:waiver:apply', g.correos.owner, sede, { resourceId: extra.json().id, amountCents: '100' });
    const firmado = await post(gerente, `/charges/${extra.json().id}/adjustments`, { adjustmentType: 'WAIVER', amountCents: '100', reasonCode: 'CORTESIA', reason: 'Cortesía', approvalToken: firma });
    expect(firmado.statusCode, firmado.body).toBe(201);
    expect((await get(gerente, `/members/${memberId}/debt`)).json().waiver.usedCents).toBe('60000');
  });

  it('un peso arriba de la mensualidad pide la firma de la dueña (428) y no condona nada', async () => {
    const { memberId, chargeId } = await socioQueDebe();
    const extra = await post(gerente, `/members/${memberId}/charges`, { chargeType: 'MANUAL_ADJUSTMENT', concept: 'Casillero', subtotalCents: '100', reason: 'Renta de casillero', branchId: sede });
    expect(extra.statusCode, extra.body).toBe(201);
    // Debe $601: perdonarlo todo de una vez pasa del tope por un peso.
    const todo = await post(gerente, `/members/${memberId}/debt/waiver`, { reasonCode: 'INCOBRABLE', reason: 'No contesta desde hace meses' });
    expect(todo.statusCode, todo.body).toBe(428);
    expect(await getDb().chargeAdjustment.count({ where: { chargeId } })).toBe(0);
    expect(await debe(memberId)).toBe(60_100n);

    const firma = await aprobacion(app, gerente, 'billing:waiver:apply', g.correos.owner, sede, { resourceId: memberId, amountCents: '60100' });
    const firmado = await post(gerente, `/members/${memberId}/debt/waiver`, { reasonCode: 'INCOBRABLE', reason: 'No contesta desde hace meses', approvalToken: firma });
    expect(firmado.statusCode, firmado.body).toBe(201);
    expect(firmado.json()).toMatchObject({ forgivenCents: '60100', outstandingCents: '0' });
    expect(firmado.json().charges).toHaveLength(2);
    expect(firmado.json().approvedByUserId).toBe(g.ownerId);
    expect(await debe(memberId)).toBe(0n);
    // Cada cargo lleva su condonación con su monto, y el perdón entero queda en la bitácora.
    const ajustes = await getDb().chargeAdjustment.findMany({ where: { chargeId: { in: [chargeId, extra.json().id] } } });
    expect(ajustes.map((a) => a.amountCents).sort()).toEqual([100n, 60_000n]);
    expect(ajustes.every((a) => a.adjustmentType === 'WAIVER' && a.approvedByUserId === g.ownerId && a.reasonCode === 'INCOBRABLE')).toBe(true);
    expect(await getDb().auditLog.count({ where: { organizationId: g.organizationId, action: 'billing.debt.waive', resourceId: memberId } })).toBe(1);
    // Repetirlo ya no encuentra deuda.
    const otra = await post(gerente, `/members/${memberId}/debt/waiver`, { reasonCode: 'INCOBRABLE', reason: 'No contesta desde hace meses' });
    expect(otra.statusCode).toBe(409);
    expect(otra.json().reason).toBe('NO_DEBT');
  });

  it('perdonar al cancelar: justo una mensualidad, sin firma y con motivo de catálogo', async () => {
    const { memberId, membershipId } = await socioQueDebe();
    await post(gerente, `/memberships/${membershipId}/cancel`, { reason: 'Se lesionó' });
    const sinMotivo = await post(gerente, `/members/${memberId}/debt/waiver`, { membershipId, reasonCode: 'PROMOCION_VIGENTE', reason: 'Se lesionó' });
    expect(sinMotivo.statusCode).toBe(422);
    const r = await post(gerente, `/members/${memberId}/debt/waiver`, { membershipId, reasonCode: 'LESION', reason: 'Se lesionó' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ forgivenCents: '60000', approvedByUserId: null, outstandingCents: '0' });
  });

  it('recepción no perdona: ni viendo el permiso encendido de descontar, ni con la firma de la dueña', async () => {
    const { memberId, chargeId } = await socioQueDebe();
    const r = await post(recepcion, `/members/${memberId}/debt/waiver`, { reasonCode: 'CORTESIA', reason: 'Cortesía' });
    expect(r.statusCode).toBe(403);
    const c = await post(recepcion, `/charges/${chargeId}/adjustments`, { adjustmentType: 'WAIVER', amountCents: '100', reasonCode: 'CORTESIA', reason: 'Cortesía' });
    expect(c.statusCode).toBe(403);
    expect(await debe(memberId)).toBe(60_000n);
  });

  it('otro gimnasio no ve ni perdona este adeudo', async () => {
    const { memberId } = await socioQueDebe();
    const ajeno = await loginAs(app, 'gerente@demo.mx');
    expect((await get(ajeno, `/members/${memberId}/debt`)).statusCode).toBe(404);
    expect((await post(ajeno, `/members/${memberId}/debt/waiver`, { reasonCode: 'CORTESIA', reason: 'Cortesía' })).statusCode).toBe(404);
  });
});
