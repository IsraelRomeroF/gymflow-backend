import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7, normalizedNameKey } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { resetPaymentProvider } from '../src/modules/payments/provider/index.js';

/**
 * SIN PROCESADOR (producción mientras no haya uno contratado). El cobro con
 * tarjeta en línea se apaga y lo dice: la caja de arena no puede contestar
 * "aprobado" a un socio real sin que nadie le cobre.
 */
describe('pagos en línea apagados', () => {
  let app: FastifyInstance;
  let portal: string;
  let cargo: string;
  const antes = process.env.PAYMENT_PROVIDER;

  beforeAll(async () => {
    process.env.PAYMENT_PROVIDER = 'none';
    resetPaymentProvider();
    app = await makeApp();
    await app.ready();
    const cookie = await loginAs(app, 'gerencia@demo.mx');
    const f = await orgFixtures();
    const branchId = f.demoBranches[0]!.id;
    const nombre = nombreUnico('Linea');
    const socio = await getDb().member.create({
      data: {
        id: uuidv7(), organizationId: f.demo.id,
        memberCode: `LIN-${Date.now() % 1_000_000}-${Math.floor(Math.random() * 999)}`,
        firstName: nombre, lastName: nombreUnico('Apagada'), nameKey: normalizedNameKey(`${nombre} apagada`),
        homeBranchId: branchId, joinedAt: new Date(),
      },
    });
    cargo = (await getDb().charge.create({
      data: {
        id: uuidv7(), organizationId: f.demo.id, memberId: socio.id, branchId,
        chargeType: 'MANUAL_ADJUSTMENT', status: 'OPEN', concept: 'Cuota de prueba',
        subtotalCents: 65_000n, amountCents: 65_000n, dueDate: new Date(), issuedAt: new Date(), membershipId: null,
      },
    })).id;
    const invite = await app.inject({ method: 'POST', url: `/members/${socio.id}/portal-invite`, headers: { cookie } });
    const enroll = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code } });
    portal = `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}`;
  });

  afterAll(async () => {
    if (antes === undefined) delete process.env.PAYMENT_PROVIDER; else process.env.PAYMENT_PROVIDER = antes;
    resetPaymentProvider();
    await app.close();
    await closeDb();
  });

  it('el portal sabe que no hay pago en línea, para no ofrecerlo', async () => {
    const me = (await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie: portal } })).json();
    expect(me.onlinePayments).toBe(false);
  });

  it('domiciliar responde 409 con qué hacer, no "aprobado"', async () => {
    const r = await app.inject({
      method: 'POST', url: '/portal/payment-methods/setup', headers: { cookie: portal },
      payload: { returnUrl: 'https://socio.gymflow.mx/volver' },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toMatch(/Paga en recepción/);
  });

  it('pagar un cargo desde el portal tampoco cobra nada', async () => {
    const r = await app.inject({
      method: 'POST', url: `/portal/charges/${cargo}/pay`, headers: { cookie: portal },
      payload: { returnUrl: 'https://socio.gymflow.mx/volver' },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    const c = await getDb().charge.findUniqueOrThrow({ where: { id: cargo } });
    expect(c.status).toBe('OPEN');
  });
});
