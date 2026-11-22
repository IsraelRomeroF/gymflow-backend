import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, aprobacion } from './helpers.js';
import { createPrismaClient } from '@gymflow/db';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { generateCycleCharges, markOverdueCharges, reconcileBalances } from '../src/modules/billing/billing.jobs.js';

const db = () => getDb();
const CONSENTS = [
  { consentType: 'PRIVACY_NOTICE', documentVersion: 'v1.0', granted: true },
  { consentType: 'HOUSE_RULES', documentVersion: 'v1.0', granted: true },
];

/** Fecha de negocio del día, como la calculan los jobs. */
const hoy = (): Date => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return new Date(`${f}T00:00:00.000Z`);
};

const sello = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);



describe('libro financiero', () => {
  let app: FastifyInstance;
  let owner: string;
  let reception: string;
  let orgId: string;
  let branchId: string;
  let planId: string;
  /** Segundo usuario: revertir y condonar exigen autorización ajena. */
  /** Todo cobro en efectivo pertenece a un turno (Sprint 5). */
  let cashSessionId: string;

  /** Alta de socio + membresía; devuelve ambos ids. */
  async function nuevoSocio(): Promise<{ memberId: string; membershipId: string }> {
    const res = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: owner },
      payload: {
        firstName: nombreUnico('Prueba'), lastName: nombreUnico('Libro'),
        phoneE164: telefonoUnico(),
        homeBranchId: branchId, consents: CONSENTS,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const memberId = res.json().id as string;

    const mem = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships`, headers: { cookie: owner },
      payload: { reason: 'Fixture de prueba', planId, soldAtBranchId: branchId },
    });
    expect(mem.statusCode, mem.body).toBe(201);
    return { memberId, membershipId: mem.json().id as string };
  }

  async function cargo(memberId: string, subtotalCents: string, dueDate?: string) {
    const res = await app.inject({
      method: 'POST', url: `/members/${memberId}/charges`, headers: { cookie: owner },
      payload: {
        chargeType: 'MANUAL_ADJUSTMENT', concept: 'Cargo de prueba',
        subtotalCents, reason: 'Prueba de integración del libro',
        ...(dueDate ? { dueDate } : {}),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  async function pagar(memberId: string, amountCents: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: owner },
      payload: { idempotencyKey: crypto.randomUUID(), method: 'CASH', amountCents, branchId, cashSessionId, ...extra },
    });
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    reception = await loginAs(app, 'recepcion@demo.mx');

    const { demo, demoBranches } = await orgFixtures();
    orgId = demo.id;
    branchId = demoBranches[0]!.id;
    const plan = await db().plan.findFirstOrThrow({
      where: { organizationId: orgId, billingModel: 'RECURRING', isActive: true },
      orderBy: { priceCents: 'asc' },
    });
    planId = plan.id;


    // Un cobro de mostrador SIEMPRE se imputa a una caja abierta. Se reutiliza
    // el turno si ya quedó abierto de una corrida anterior.
    const register = await db().cashRegister.findFirstOrThrow({
      where: { organizationId: orgId, branchId, code: 'C1', deletedAt: null },
    });
    const abierta = await db().cashSession.findFirst({
      where: { organizationId: orgId, cashRegisterId: register.id, status: 'OPEN' },
    });
    if (abierta) {
      cashSessionId = abierta.id;
    } else {
      const res = await app.inject({
        method: 'POST', url: '/cash-sessions', headers: { cookie: owner },
        payload: { cashRegisterId: register.id, openingFloatCents: '150000' },
      });
      expect(res.statusCode, res.body).toBe(201);
      cashSessionId = res.json().id as string;
    }
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  // ── Criterio de aceptación 1 ──────────────────────────────────────────────
  it('un cargo fuera del catálogo es solo de la gerencia, no sale del catálogo ni regala descuento (SEC2-14, 28-05)', async () => {
    const { memberId } = await nuevoSocio();
    const manual = (cookie: string, payload: Record<string, unknown>) => app.inject({
      method: 'POST', url: `/members/${memberId}/charges`, headers: { cookie },
      payload: { concept: 'Cargo de mostrador', subtotalCents: '20000', branchId, reason: 'Prueba de topes', ...payload },
    });
    // Recepción cobra lo del catálogo: ningún cargo con el importe a mano (28-05).
    for (const chargeType of ['DAY_PASS', 'MANUAL_ADJUSTMENT', 'OPENING_BALANCE']) {
      expect((await manual(reception, { chargeType })).statusCode, chargeType).toBe(403);
    }
    expect((await manual(owner, { chargeType: 'VISIT_PACK' })).statusCode).toBe(422); // tiene su propio flujo
    const descuento = await manual(owner, { chargeType: 'DAY_PASS', discountCents: '10000' }); // 50 % > su tope de 30 %
    expect([403, 428]).toContain(descuento.statusCode);
    const conDescuento = await manual(owner, { chargeType: 'DAY_PASS', discountCents: '1000' });
    expect(conDescuento.statusCode, conDescuento.body).toBe(201); // 5 %: dentro del tope de la gerencia
  });

  it('un cargo de $650 pagado con tres abonos queda PAID con saldo exacto', async () => {
    const { memberId } = await nuevoSocio();
    const c = await cargo(memberId, '65000');
    expect(c.status).toBe('OPEN');

    for (const [abono, esperado] of [['20000', 'PARTIALLY_PAID'], ['30000', 'PARTIALLY_PAID'], ['15000', 'PAID']] as const) {
      const res = await pagar(memberId, abono, { targetChargeIds: [c.id] });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().unappliedCents).toBe('0');

      const ver = await app.inject({
        method: 'GET', url: `/members/${memberId}/statement/charges`, headers: { cookie: owner },
      });
      const actual = ver.json().items.find((x: { id: string }) => x.id === c.id);
      expect(actual.status).toBe(esperado);
    }

    const st = await app.inject({
      method: 'GET', url: `/members/${memberId}/statement`, headers: { cookie: owner },
    });
    const cargoFinal = st.json().charges.find((x: { id: string }) => x.id === c.id);
    expect(cargoFinal.balanceCents).toBe('0');
    expect(cargoFinal.allocatedCents).toBe('65000');
  });

  // ── Criterio de aceptación 2 ──────────────────────────────────────────────
  it('un excedente queda como SALDO A FAVOR, nunca como cargo negativo', async () => {
    const { memberId } = await nuevoSocio();
    const c = await cargo(memberId, '65000');

    const res = await pagar(memberId, '100000', { targetChargeIds: [c.id] });
    expect(res.statusCode).toBe(201);
    expect(res.json().unappliedCents).toBe('35000');

    const st = (await app.inject({
      method: 'GET', url: `/members/${memberId}/statement`, headers: { cookie: owner },
    })).json();

    expect(st.creditCents).toBe('35000');
    expect(st.netBalanceCents).toBe('-35000');
    // Lo que de verdad se está comprobando: NO nació un cargo negativo.
    expect(st.charges.every((x: { amountCents: string }) => BigInt(x.amountCents) >= 0n)).toBe(true);
    expect(st.charges).toHaveLength(1);
  });

  it('la base RECHAZA cobrar de más contra un cargo, aunque se intente por dentro', async () => {
    const { memberId } = await nuevoSocio();
    const c = await cargo(memberId, '10000');
    await expect(
      db().charge.update({ where: { id: c.id }, data: { allocatedCents: 10001n } }),
    ).rejects.toThrow(/charges_no_overpayment_check/);
  });

  // ── Criterio de aceptación 3 ──────────────────────────────────────────────
  it('el job de generación ejecutado dos veces NO crea cargos duplicados', async () => {
    const { membershipId } = await nuevoSocio();

    const primera = await generateCycleCharges(orgId);
    const cuentaTras1 = await db().charge.count({
      where: { organizationId: orgId, membershipId, chargeType: 'MEMBERSHIP_PERIOD' },
    });
    expect(cuentaTras1).toBe(1);

    const segunda = await generateCycleCharges(orgId);
    const cuentaTras2 = await db().charge.count({
      where: { organizationId: orgId, membershipId, chargeType: 'MEMBERSHIP_PERIOD' },
    });
    expect(cuentaTras2).toBe(1);

    // Solo los errores de ESTA membresía: el job recorre toda la organización,
    // y otras pruebas dejan membresías de planes de prueba ya retirados.
    expect(primera.errors.filter((e) => e.entityId === membershipId)).toEqual([]);
    expect(segunda.errors.filter((e) => e.entityId === membershipId)).toEqual([]);
    // La segunda corrida no encuentra candidatos: no es que los salte, es que
    // el `NOT EXISTS` ya no los devuelve.
    expect(segunda.processed).toBe(0);
  });

  it('una segunda corrida el mismo día NO borra lo que generó la primera', async () => {
    const cycles = await import('../src/modules/billing/billing-cycle.repository.js');
    const repo = new cycles.BillingCycleRepository(orgId);

    await nuevoSocio();
    await generateCycleCharges(orgId);
    const tras1 = await repo.findByRunDate(hoy());
    expect(tras1!.status).toBe('COMPLETED');
    const generados = tras1!.chargesCreated;
    expect(generados).toBeGreaterThan(0);

    // La segunda pasada normalmente genera cero. Si escribiera los totales en
    // vez de sumarlos, dejaría la corrida del día en blanco.
    await generateCycleCharges(orgId);
    const tras2 = await repo.findByRunDate(hoy());
    expect(tras2!.id).toBe(tras1!.id);
    expect(tras2!.chargesCreated).toBeGreaterThanOrEqual(generados);
    expect(tras2!.amountCents).toBeGreaterThanOrEqual(tras1!.amountCents);
  });

  it('la ruta de cargo de periodo es idempotente: repetirla devuelve el mismo cargo', async () => {
    const { membershipId } = await nuevoSocio();

    const a = await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/period-charge`, headers: { cookie: owner },
    });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json().created).toBe(true);

    const b = await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/period-charge`, headers: { cookie: owner },
    });
    expect(b.statusCode).toBe(200);
    expect(b.json().created).toBe(false);
    expect(b.json().id).toBe(a.json().id);
  });

  it('dos cobros simultáneos con la misma clave idempotente cobran UNA vez', async () => {
    const { memberId } = await nuevoSocio();
    await cargo(memberId, '65000');
    const key = `caja-${sello()}`;

    const [a, b] = await Promise.all([
      pagar(memberId, '65000', { idempotencyKey: key }),
      pagar(memberId, '65000', { idempotencyKey: key }),
    ]);

    const ids = [a.json().payment.id, b.json().payment.id];
    expect(ids[0]).toBe(ids[1]);
    const cuenta = await db().payment.count({ where: { organizationId: orgId, memberId } });
    expect(cuenta).toBe(1);
  });

  // ── Aplicación a la deuda más antigua ─────────────────────────────────────
  it('un abono se aplica primero a la deuda MÁS ANTIGUA', async () => {
    const { memberId } = await nuevoSocio();
    const viejo = await cargo(memberId, '65000', '2026-07-01');
    const nuevo = await cargo(memberId, '65000', '2026-09-01');

    const res = await pagar(memberId, '80000');
    expect(res.statusCode).toBe(201);

    const porCargo = new Map<string, string>(
      res.json().allocations.map((a: { chargeId: string; amountCents: string }) => [a.chargeId, a.amountCents]),
    );
    expect(porCargo.get(viejo.id)).toBe('65000');
    expect(porCargo.get(nuevo.id)).toBe('15000');
  });

  // ── Reversión ─────────────────────────────────────────────────────────────
  it('revertir crea un contra-asiento y NO borra nada', async () => {
    const { memberId } = await nuevoSocio();
    const c = await cargo(memberId, '65000');
    const pago = (await pagar(memberId, '65000', { targetChargeIds: [c.id] })).json().payment;

    const rev = await app.inject({
      method: 'POST', url: `/payments/${pago.id}/reverse`, headers: { cookie: owner },
      payload: {
        reason: 'Cobro capturado en el socio equivocado',
        approvalToken: await aprobacion(app, owner, 'payments:reverse', undefined, undefined, { resourceId: pago.id, amountCents: pago.amountCents }), cashSessionId,
      },
    });
    expect(rev.statusCode, rev.body).toBe(201);
    expect(rev.json().amountCents).toBe('-65000');
    expect(rev.json().reversesPaymentId).toBe(pago.id);

    // El original SIGUE existiendo, marcado como revertido.
    const original = await db().payment.findUniqueOrThrow({ where: { id: pago.id } });
    expect(original.status).toBe('REVERSED');

    // Y el cargo volvió a deber.
    const st = (await app.inject({
      method: 'GET', url: `/members/${memberId}/statement`, headers: { cookie: owner },
    })).json();
    const actual = st.charges.find((x: { id: string }) => x.id === c.id);
    expect(actual.balanceCents).toBe('65000');
    expect(actual.status).not.toBe('PAID');
    expect(st.netBalanceCents).toBe('65000');

    // Las asignaciones originales NO se borraron: hay dos, y suman cero.
    const allocs = await db().paymentAllocation.findMany({ where: { chargeId: c.id } });
    expect(allocs).toHaveLength(2);
    expect(allocs.reduce((acc, a) => acc + a.amountCents, 0n)).toBe(0n);
  });

  it('un pago revertido NO se puede revertir dos veces', async () => {
    const { memberId } = await nuevoSocio();
    await cargo(memberId, '30000');
    const pago = (await pagar(memberId, '30000')).json().payment;

    const uno = await app.inject({
      method: 'POST', url: `/payments/${pago.id}/reverse`, headers: { cookie: owner },
      payload: { reason: 'Primer reverso, legítimo', approvalToken: await aprobacion(app, owner, 'payments:reverse', undefined, undefined, { resourceId: pago.id, amountCents: pago.amountCents }), cashSessionId },
    });
    expect(uno.statusCode).toBe(201);

    const dos = await app.inject({
      method: 'POST', url: `/payments/${pago.id}/reverse`, headers: { cookie: owner },
      payload: {
        reason: 'Segundo reverso, no debe pasar',
        approvalToken: await aprobacion(app, owner, 'payments:reverse', undefined, undefined, { resourceId: pago.id, amountCents: pago.amountCents }), cashSessionId,
      },
    });
    expect(dos.statusCode).toBe(409);
  });

  // ── Cobrar ACTIVA la membresía ────────────────────────────────────────────
  it('liquidar la cuota del periodo ACTIVA la membresía: cobrar abre el torniquete', async () => {
    const { memberId, membershipId } = await nuevoSocio();
    expect((await db().membership.findUniqueOrThrow({ where: { id: membershipId } })).status).toBe('PENDING');

    const gen = await app.inject({
      method: 'POST', url: `/memberships/${membershipId}/period-charge`, headers: { cookie: owner },
    });
    const cuota = gen.json();

    const res = await pagar(memberId, cuota.amountCents, { targetChargeIds: [cuota.id] });
    expect(res.statusCode, res.body).toBe(201);

    const tras = await db().membership.findUniqueOrThrow({ where: { id: membershipId } });
    expect(tras.status).toBe('ACTIVE');
  });

  // ── Ajustes ───────────────────────────────────────────────────────────────
  it('un descuento reduce el saldo SIN tocar el importe original', async () => {
    const { memberId } = await nuevoSocio();
    const c = await cargo(memberId, '65000');

    const res = await app.inject({
      method: 'POST', url: `/charges/${c.id}/adjustments`, headers: { cookie: owner },
      payload: {
        adjustmentType: 'DISCOUNT', amountCents: '15000',
        reasonCode: 'PROMOCION_VIGENTE', reason: 'Promoción de temporada',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().amountCents).toBe('65000');   // el importe NO cambió
    expect(res.json().adjustedCents).toBe('15000');
    expect(res.json().balanceCents).toBe('50000');

    const hist = await app.inject({
      method: 'GET', url: `/charges/${c.id}/adjustments`, headers: { cookie: owner },
    });
    expect(hist.json().adjustments).toHaveLength(1);
    expect(hist.json().adjustments[0].reason).toBe('Promoción de temporada');
  });

  it('un ajuste que supera el saldo pendiente se RECHAZA', async () => {
    const { memberId } = await nuevoSocio();
    const c = await cargo(memberId, '10000');
    const res = await app.inject({
      method: 'POST', url: `/charges/${c.id}/adjustments`, headers: { cookie: owner },
      payload: {
        adjustmentType: 'WAIVER', amountCents: '20000', reasonCode: 'RETENCION',
        reason: 'Condonación excesiva', approvalToken: await aprobacion(app, owner, 'billing:waiver:apply', undefined, undefined, { resourceId: c.id, amountCents: '20000' }),
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('condonar exige el permiso de condonación, no el de descuento', async () => {
    const { memberId } = await nuevoSocio();
    const c = await cargo(memberId, '10000');
    // Recepción tiene `billing:discount:apply` pero NO `billing:waiver:apply`.
    const res = await app.inject({
      method: 'POST', url: `/charges/${c.id}/adjustments`, headers: { cookie: reception },
      payload: {
        adjustmentType: 'WAIVER', amountCents: '10000',
        reasonCode: 'RETENCION', reason: 'Intento sin permiso',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('un cargo con pagos aplicados NO se puede anular: primero se revierte el pago', async () => {
    const { memberId } = await nuevoSocio();
    const c = await cargo(memberId, '30000');
    await pagar(memberId, '10000', { targetChargeIds: [c.id] });

    const res = await app.inject({
      method: 'POST', url: `/charges/${c.id}/void`, headers: { cookie: owner },
      payload: { reason: 'Intento de anular con cobros aplicados', approvalToken: await aprobacion(app, owner, 'billing:charge:void', undefined, undefined, { resourceId: c.id }) },
    });
    expect(res.statusCode).toBe(409);
  });

  // ── Append-only, comprobado contra la base real ───────────────────────────
  //
  // Hay DOS barreras y el orden importa: el rol de aplicación choca primero
  // con el `REVOKE` (permission denied), así que el trigger no llega a
  // dispararse. El trigger existe para la conexión con el rol DUEÑO, que es
  // justo la que usaría una migración o un script de mantenimiento.
  const bloqueado = /permission denied|append-only/;

  it('la base impide BORRAR un pago', async () => {
    const { memberId } = await nuevoSocio();
    await cargo(memberId, '10000');
    const pago = (await pagar(memberId, '10000')).json().payment;
    await expect(db().payment.delete({ where: { id: pago.id } })).rejects.toThrow(bloqueado);
  });

  it('la base impide BORRAR una asignación', async () => {
    const { memberId } = await nuevoSocio();
    const c = await cargo(memberId, '10000');
    await pagar(memberId, '10000', { targetChargeIds: [c.id] });
    const alloc = await db().paymentAllocation.findFirstOrThrow({ where: { chargeId: c.id } });
    await expect(db().paymentAllocation.delete({ where: { id: alloc.id } })).rejects.toThrow(bloqueado);
  });

  it('la base impide EDITAR un ajuste', async () => {
    const { memberId } = await nuevoSocio();
    const c = await cargo(memberId, '30000');
    await app.inject({
      method: 'POST', url: `/charges/${c.id}/adjustments`, headers: { cookie: owner },
      payload: {
        adjustmentType: 'DISCOUNT', amountCents: '5000',
        reasonCode: 'ERROR_DE_CAPTURA', reason: 'Descuento a editar',
      },
    });
    const adj = await db().chargeAdjustment.findFirstOrThrow({ where: { chargeId: c.id } });
    await expect(
      db().chargeAdjustment.update({ where: { id: adj.id }, data: { amountCents: 1n } }),
    ).rejects.toThrow(bloqueado);
  });

  /**
   * La segunda barrera, la que de verdad importa.
   *
   * El `REVOKE` protege del rol de aplicación, pero no de una migración ni de
   * un script de mantenimiento, que corren como DUEÑO de las tablas. Ese es el
   * vector real del borrado silencioso de un cobro en efectivo. Aquí se
   * comprueba con una conexión con ese rol.
   */
  it('ni siquiera el rol DUEÑO puede borrar un pago: el trigger lo impide', async () => {
    const url = process.env.DATABASE_URL_MIGRATOR;
    if (!url) throw new Error('Falta DATABASE_URL_MIGRATOR: la prueba no puede verificar el trigger');

    const { memberId } = await nuevoSocio();
    await cargo(memberId, '10000');
    const pago = (await pagar(memberId, '10000')).json().payment;

    const owner = createPrismaClient(url);
    try {
      await expect(
        owner.$executeRawUnsafe(`DELETE FROM "payments" WHERE "id" = '${pago.id}'`),
      ).rejects.toThrow(/append-only/);

      // Y sigue ahí.
      const [{ count } = { count: 0n }] = await owner.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM "payments" WHERE "id" = '${pago.id}'`,
      );
      expect(count).toBe(1n);
    } finally {
      await owner.$disconnect();
    }
  });

  it('el rol de aplicación NO tiene el privilegio de borrar en el libro', async () => {
    const filas = await db().$queryRaw<Array<{ table_name: string; privilege_type: string }>>`
      SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'gymflow_app'
        AND table_name IN ('payments','payment_allocations','charge_adjustments','charges')
        AND privilege_type = 'DELETE'`;
    expect(filas).toEqual([]);
  });

  // ── Reconciliación ────────────────────────────────────────────────────────
  it('el job de reconciliación corrige un saldo cacheado desviado', async () => {
    const { memberId } = await nuevoSocio();
    await cargo(memberId, '65000');

    // Se corrompe la caché a propósito, como lo haría un camino de escritura
    // que olvidara refrescarla.
    await db().member.update({ where: { id: memberId }, data: { balanceCentsCached: 999999n } });

    const res = await reconcileBalances(orgId);
    expect(res.processed).toBeGreaterThan(0);

    const tras = await db().member.findUniqueOrThrow({ where: { id: memberId } });
    expect(tras.balanceCentsCached).toBe(65000n);
    expect(tras.balanceComputedAt).not.toBeNull();

    // Y reejecutarlo no encuentra nada que corregir.
    expect((await reconcileBalances(orgId)).processed).toBe(0);
  });

  it('el job de mora marca vencidos los cargos pasados de fecha', async () => {
    const { memberId } = await nuevoSocio();
    const c = await cargo(memberId, '65000', '2026-01-15');

    const res = await markOverdueCharges(orgId);
    expect(res.errors).toEqual([]);

    const tras = await db().charge.findUniqueOrThrow({ where: { id: c.id } });
    expect(tras.status).toBe('OVERDUE');
    // Idempotente: la segunda pasada ya no lo encuentra.
    expect((await markOverdueCharges(orgId)).processed).toBe(0);
  });

  // ── Aislamiento entre organizaciones ──────────────────────────────────────
  it('el estado de cuenta de un socio de OTRA organización responde 404, no 403', async () => {
    const { other } = await orgFixtures();
    const ajeno = await db().member.findFirst({ where: { organizationId: other.id } });
    if (!ajeno) return;
    const res = await app.inject({
      method: 'GET', url: `/members/${ajeno.id}/statement`, headers: { cookie: owner },
    });
    expect(res.statusCode).toBe(404);
  });

  it('un cargo inexistente responde 404 y no filtra nada', async () => {
    const res = await app.inject({
      method: 'GET', url: `/charges/${uuidv7()}/adjustments`, headers: { cookie: owner },
    });
    expect(res.statusCode).toBe(404);
  });
});
