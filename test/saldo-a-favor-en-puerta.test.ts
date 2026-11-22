import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cycleChargeKey, uuidv7 } from '@gymflow/core';
import { ApplyCreditResult, diferenciasConElContrato } from '@gymflow/core/contracts';
import { makeApp } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, sesionesDe, socioPropio, type GimnasioPropio, type SedePropia } from './gimnasio-propio.js';

/**
 * APLICAR EL SALDO A FAVOR EN LA PUERTA (fase 2, bloque 2.13; pendiente de 1.4).
 *
 * Cuando lo que el socio tiene a favor cubre TODO lo que debe, «Cobrar y abrir»
 * no puede cobrar (422: no hay nada que cobrar) y hasta hoy la única salida era
 * dejarlo pasar con motivo, con la deuda y el saldo a favor intactos. Ahora
 * `POST /members/:id/credit/apply` reparte su saldo sin cobro, la membresía
 * queda al corriente y la entrada se registra sobre el mismo rechazo: la
 * puerta decide de verdad.
 */
describe('aplicar el saldo a favor sin cobro y entrar', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let sede: SedePropia;
  let otra: SedePropia;
  let s: Awaited<ReturnType<typeof sesionesDe>>;
  const db = () => getDb();
  const dia = (d: Date) => new Date(d.toISOString().slice(0, 10));

  /** Suspendida por una cuota vencida de $600, con `aFavor` centavos pagados de más que nadie ha aplicado. */
  async function suspendidaConSaldo(aFavor: bigint): Promise<{ socio: string; membresia: string; cuota: string }> {
    const socio = await socioPropio(g, sede);
    const hoy = dia(new Date());
    const inicio = new Date(hoy.getTime() - 10 * 86_400_000);
    const fin = new Date(hoy.getTime() + 20 * 86_400_000);
    const membresia = uuidv7();
    await db().membership.create({
      data: {
        id: membresia, organizationId: g.organizationId, memberId: socio, planId: g.planMensual, soldAtBranchId: sede.id, status: 'SUSPENDED',
        startDate: inicio, currentPeriodStart: inicio, currentPeriodEnd: fin, billingAnchorDay: Math.min(inicio.getUTCDate(), 28), autoRenew: true,
        graceUntil: new Date(hoy.getTime() - 3 * 86_400_000),
      },
    });
    const cuota = uuidv7();
    await db().charge.create({
      data: {
        id: cuota, organizationId: g.organizationId, memberId: socio, membershipId: membresia, branchId: sede.id, chargeType: 'MEMBERSHIP_PERIOD', status: 'OVERDUE',
        concept: 'Cuota del periodo', subtotalCents: 60_000n, taxCents: 0n, discountCents: 0n, amountCents: 60_000n,
        periodStart: inicio, periodEnd: fin, dueDate: inicio, issuedAt: inicio, idempotencyKey: cycleChargeKey(membresia, inicio),
      },
    });
    if (aFavor > 0n) {
      await db().payment.create({
        data: {
          id: uuidv7(), organizationId: g.organizationId, memberId: socio, branchId: sede.id, method: 'SPEI_TRANSFER', status: 'SUCCEEDED',
          amountCents: aFavor, unappliedCents: aFavor, businessDate: hoy, externalRef: `SPEI-${uuidv7().slice(-8)}`,
        },
      });
    }
    return { socio, membresia, cuota };
  }
  const intentar = (memberId: string, extra: Record<string, unknown> = {}) => app.inject({
    method: 'POST', url: '/access/attempts', headers: { cookie: s.recepcion },
    payload: { branchId: sede.id, memberId, credentialKind: 'MANUAL', ...extra },
  });
  const aplicar = (memberId: string, cookie = s.recepcion, branchId = sede.id) => app.inject({
    method: 'POST', url: `/members/${memberId}/credit/apply`, headers: { cookie }, payload: { branchId },
  });
  const asientos = (memberId: string) => db().auditLog.count({ where: { organizationId: g.organizationId, action: 'billing.credit.apply', resourceId: memberId } });

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Puerta', cajas: 1 }, { name: 'Otra', cajas: 1 }] });
    [sede, otra] = g.sedes as [SedePropia, SedePropia];
    s = await sesionesDe(app, g);
  }, 60_000);

  afterAll(async () => {
    await g.cerrar();
    await app.close();
    await closeDb();
  });

  it('con saldo a favor que cubre toda la deuda: la puerta no cobra, se aplica el saldo sin cobro, queda al corriente y entra sobre el mismo rechazo', async () => {
    const { socio, membresia, cuota } = await suspendidaConSaldo(70_000n);
    const rojo = await intentar(socio);
    expect(rojo.statusCode, rojo.body).toBe(201);
    expect(rojo.json().outcome).toBe('DENIED');
    const rechazo = rojo.json().decisionId as string;

    // «Cobrar y abrir» no puede: no hay nada que cobrar.
    const cobrar = await app.inject({ method: 'POST', url: `/access/decisions/${rechazo}/collect`, headers: { cookie: s.recepcion }, payload: { method: 'SPEI_TRANSFER', externalRef: 'X-1', amountCents: '100' } });
    expect(cobrar.statusCode).toBe(422);

    const pagosAntes = await db().payment.count({ where: { memberId: socio } });
    const r = await aplicar(socio);
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(ApplyCreditResult, r.json())).toEqual([]);
    expect(r.json()).toMatchObject({ appliedCents: '60000', creditCents: '10000', outstandingCents: '0', toEnterCents: null });
    expect(r.json().membership).toMatchObject({ id: membresia, status: 'ACTIVE', canEnter: true });

    // No entró dinero: ningún pago nuevo; la cuota quedó pagada con el que ya existía; un asiento.
    expect(await db().payment.count({ where: { memberId: socio } })).toBe(pagosAntes);
    expect((await db().charge.findUniqueOrThrow({ where: { id: cuota } })).status).toBe('PAID');
    expect(await asientos(socio)).toBe(1);

    // Repetirla no hace nada ni asienta otra vez.
    const otraVez = await aplicar(socio);
    expect(otraVez.json()).toMatchObject({ appliedCents: '0', creditCents: '10000', outstandingCents: '0' });
    expect(await asientos(socio)).toBe(1);

    // La entrada, sobre el mismo rechazo: la puerta decide de verdad y ahora abre.
    const verde = await intentar(socio, { reason: 'Se aplicó su saldo a favor', resolvesDecisionId: rechazo, requestKey: uuidv7() });
    expect(verde.statusCode, verde.body).toBe(201);
    expect(verde.json().outcome).toBe('GRANTED');
    const vista = (await app.inject({ method: 'GET', url: `/access/decisions/${rechazo}/exception`, headers: { cookie: s.recepcion } })).json();
    expect(vista.resolution?.decisionId).toBe(verde.json().decisionId);
  });

  it('si el saldo a favor no alcanza, se aplica lo que hay, sigue debiendo la diferencia y no queda al corriente', async () => {
    const { socio } = await suspendidaConSaldo(20_000n);
    const r = await aplicar(socio);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ appliedCents: '20000', creditCents: '0', outstandingCents: '40000' });
    expect(r.json().membership).toMatchObject({ status: 'SUSPENDED', canEnter: false });
    expect((await intentar(socio)).json().outcome).toBe('DENIED');
  });

  it('sin saldo a favor no aplica nada ni deja asiento', async () => {
    const { socio } = await suspendidaConSaldo(0n);
    const r = await aplicar(socio);
    expect(r.json()).toMatchObject({ appliedCents: '0', outstandingCents: '60000' });
    expect(await asientos(socio)).toBe(0);
  });

  it('pide el permiso de cobrar en ESA sede: recepción de otra sede no aplica; un socio que no existe es 404', async () => {
    const { socio } = await suspendidaConSaldo(70_000n);
    // La cuenta de recepción es de la primera sede.
    expect((await aplicar(socio, s.recepcion, otra.id)).statusCode).toBe(403);
    expect(await asientos(socio)).toBe(0);
    expect((await aplicar(uuidv7(), s.gerente)).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/members/${socio}/credit/apply`, headers: { cookie: s.recepcion }, payload: {} })).statusCode).toBe(422);
  });

  it('«dejar pasar» guarda la clave del motivo del catálogo en su asiento (`reasonCode`): el chip, su clave; lo escrito a mano, OTRO', async () => {
    const claveDe = async (motivo: string) => {
      const { socio } = await suspendidaConSaldo(0n);
      const rechazo = (await intentar(socio)).json().decisionId as string;
      const r = await app.inject({ method: 'POST', url: `/access/decisions/${rechazo}/grant`, headers: { cookie: s.gerente }, payload: { reason: motivo } });
      expect(r.statusCode, r.body).toBe(201);
      const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'access.manual_grant', resourceId: r.json().decisionId as string } });
      return (asiento.afterState as { reasonCode?: string }).reasonCode;
    };
    expect(await claveDe('Paga hoy al salir')).toBe('PAGA_AL_SALIR');
    expect(await claveDe('Cortesía de la gerencia · cumpleaños')).toBe('CORTESIA');
    expect(await claveDe('Su mamá viene a pagar en la tarde')).toBe('OTRO');
  });
});
