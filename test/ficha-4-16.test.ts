import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { makeApp, loginAs } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';

/**
 * FASE 4 · BLOQUE 4.16 · FICHA DE QUIEN CANCELÓ Y DE QUIEN SE DIO DE BAJA.
 *
 *  · «Para terminar su alta» ya no le pide «Vender su membresía» a quien ya
 *    tuvo plan (canceló o le venció): la venta de su alta ya se hizo.
 *  · De un socio dado de baja la ficha sí se lee, pero sus membresías y su
 *    biometría responden 404: la ficha lo toma como «Dado de baja» (no como un
 *    error que reintentar). Esto fija ese contrato.
 */
describe('ficha · canceló o se dio de baja', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente: string;
  const db = () => getDb();
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: gerente } });

  async function membresiaTerminada(memberId: string, status: 'CANCELED' | 'EXPIRED'): Promise<void> {
    const inicio = new Date(Date.now() - 70 * 86_400_000);
    const termino = new Date(Date.now() - 5 * 86_400_000);
    await db().membership.create({
      data: {
        id: uuidv7(), organizationId: g.organizationId, memberId, planId: g.planMensual, soldAtBranchId: g.sedes[0]!.id, status, autoRenew: true,
        startDate: inicio, currentPeriodStart: inicio, currentPeriodEnd: new Date(inicio.getTime() + 30 * 86_400_000), billingAnchorDay: 1,
        endedAt: termino, ...(status === 'CANCELED' ? { canceledAt: termino, cancellationReason: 'Se cambió de ciudad' } : {}),
      },
    });
  }

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio();
    gerente = await loginAs(app, g.correos.gerente);
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  it('sin ningún plan, el primer paso del alta sigue siendo vender', async () => {
    const socio = await socioPropio(g);
    const o = (await get(`/members/${socio}/onboarding`)).json();
    expect(o.steps[0]).toEqual({ key: 'SELL', done: false, optional: false });
    expect(o.next).toBe('SELL');
  });

  it.each(['CANCELED', 'EXPIRED'] as const)('con una membresía %s, «vender» ya está hecho y no es el siguiente paso', async (estado) => {
    const socio = await socioPropio(g);
    await membresiaTerminada(socio, estado);
    const r = await get(`/members/${socio}/onboarding`);
    expect(r.statusCode, r.body).toBe(200);
    const o = r.json();
    expect(o.steps[0]).toEqual({ key: 'SELL', done: true, optional: false });
    expect(o.next).not.toBe('SELL');
    // No tiene plan vigente: la respuesta no inventa uno.
    expect(o.membership).toBeNull();
  });

  it('dado de baja: la ficha se lee y sus membresías responden 404 (la ficha dice «Dado de baja»)', async () => {
    const socio = await socioPropio(g);
    await membresiaTerminada(socio, 'CANCELED');
    await db().member.update({ where: { id: socio }, data: { status: 'ARCHIVED', deletedAt: new Date() } });
    const ficha = await get(`/members/${socio}`);
    expect(ficha.statusCode, ficha.body).toBe(200);
    expect(ficha.json().status).toBe('ARCHIVED');
    const membresias = await get(`/members/${socio}/memberships`);
    expect(membresias.statusCode).toBe(404);
    expect(membresias.json().message).toBe('Socio no encontrado');
  });
});
