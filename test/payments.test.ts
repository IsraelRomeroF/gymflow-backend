import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7, normalizedNameKey } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, aprobacion, PASSWORD } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { getPaymentProvider } from '../src/modules/payments/provider/index.js';
import { SandboxPaymentProvider } from '../src/modules/payments/provider/sandbox.provider.js';

/**
 * DOMICILIACIÓN.
 *
 * Lo que se prueba aquí no es que el cobro funcione —eso es lo fácil— sino
 * que **no cobre dos veces**: un timeout, un reintento, un webhook repetido y
 * un evento atrasado son las cuatro formas en que un sistema de cobros cobra
 * de más, y las cuatro tienen su caso.
 */
describe('domiciliación', () => {
  let app: FastifyInstance;
  let cookie: string;
  let orgId: string;
  let branchId: string;
  let provider: SandboxPaymentProvider;
  /** Segundo usuario para el maker-checker de los reembolsos. */
  let aprobador: string;

  async function crearSocio(): Promise<string> {
    const nombre = nombreUnico('Pago');
    const row = await getDb().member.create({
      data: {
        id: uuidv7(), organizationId: orgId,
        memberCode: `PAG-${Date.now() % 1_000_000}-${Math.floor(Math.random() * 999)}`,
        firstName: nombre, lastName: nombreUnico('Tarjeta'),
        nameKey: normalizedNameKey(`${nombre} tarjeta`),
        homeBranchId: branchId, joinedAt: new Date(),
      },
    });
    return row.id;
  }

  async function crearCargo(memberId: string, amountCents = 65_000n): Promise<string> {
    const row = await getDb().charge.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberId, branchId,
        chargeType: 'MANUAL_ADJUSTMENT', status: 'OPEN', concept: 'Cuota de prueba',
        subtotalCents: amountCents, amountCents, dueDate: new Date(), issuedAt: new Date(),
        membershipId: null,
      },
    });
    return row.id;
  }

  async function sesionDeSocio(memberId: string): Promise<string> {
    const invite = await app.inject({
      method: 'POST', url: `/members/${memberId}/portal-invite`, headers: { cookie },
    });
    const enroll = await app.inject({
      method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code },
    });
    return `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}`;
  }

  /** Alta completa de tarjeta con el escenario que pida la prueba. */
  async function domiciliar(memberId: string, scenario: string): Promise<string> {
    const portal = await sesionDeSocio(memberId);
    const setup = await app.inject({
      method: 'POST', url: '/portal/payment-methods/setup', headers: { cookie: portal },
      payload: { returnUrl: 'https://socio.gymflow.mx/volver', scenario },
    });
    expect(setup.statusCode, setup.body).toBe(201);

    const alta = await app.inject({
      method: 'POST', url: '/portal/payment-methods', headers: { cookie: portal },
      payload: { setupId: setup.json().setupId, makeDefault: true },
    });
    expect(alta.statusCode, alta.body).toBe(201);
    return alta.json().id;
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    cookie = await loginAs(app, 'gerencia@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    branchId = f.demoBranches[0]!.id;
    provider = getPaymentProvider('sandbox-dev-secret') as SandboxPaymentProvider;
    aprobador = f.demoUsers.find((u) => u.email === 'gerente@demo.mx')!.id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  // ── Flujo 1: alta con 3DS ─────────────────────────────────────────────────

  it('el alta devuelve las DOS vías, porque P4 aún no dice cuál se usa', async () => {
    const portal = await sesionDeSocio(await crearSocio());
    const setup = await app.inject({
      method: 'POST', url: '/portal/payment-methods/setup', headers: { cookie: portal },
      payload: { returnUrl: 'https://socio.gymflow.mx/volver' },
    });
    const body = setup.json();
    // iframe si el procesador confirma por escrito la protección contra
    // ataques de scripts; redirección completa si no (docs/07 §4.2).
    expect(body.clientSecret).toBeTruthy();
    expect(body.redirectUrl).toContain('setup_intent=');
  });

  it('guarda token, marca y últimos cuatro — y NADA más', async () => {
    const memberId = await crearSocio();
    const methodId = await domiciliar(memberId, 'ok');

    const row = await getDb().paymentMethod.findUniqueOrThrow({ where: { id: methodId } });
    expect(row.providerTokenRef).toMatch(/^pm_sbx_/);
    expect(row.last4).toMatch(/^\d{4}$/);
    expect(row.brand).toBeTruthy();
    // Ninguna columna de esta tabla puede contener un PAN.
    expect(Object.keys(row)).not.toContain('pan');
    expect(Object.keys(row)).not.toContain('cardNumber');
  });

  it('el alta EXIGE mandato y lo guarda con IP y canal del socio', async () => {
    const memberId = await crearSocio();
    const methodId = await domiciliar(memberId, 'ok');

    const method = await getDb().paymentMethod.findUniqueOrThrow({ where: { id: methodId } });
    expect(method.consentId).toBeTruthy();

    const consent = await getDb().memberConsent.findUniqueOrThrow({ where: { id: method.consentId! } });
    expect(consent.consentType).toBe('RECURRING_CHARGE');
    expect(consent.granted).toBe(true);
    // Sin IP el mandato no es prueba: la carga de la prueba es del comercio.
    expect(consent.ip).toBeTruthy();
    expect(consent.channel).toBe('SELF_SERVICE');
  });

  it('un socio NO tiene dos tarjetas predeterminadas a la vez', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    await domiciliar(memberId, 'ok');

    const predeterminadas = await getDb().paymentMethod.count({
      where: { memberId, isDefault: true, status: 'ACTIVE' },
    });
    expect(predeterminadas).toBe(1);
  });

  // ── Flujo 2: cargo recurrente exitoso ─────────────────────────────────────

  it('cobra el cargo y lo deja pagado', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    const chargeId = await crearCargo(memberId);

    const res = await app.inject({
      method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('SUCCEEDED');

    const charge = await getDb().charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(charge.status).toBe('PAID');
    expect(charge.allocatedCents).toBe(65_000n);

    const payment = await getDb().payment.findUniqueOrThrow({ where: { id: res.json().paymentId } });
    expect(payment.method).toBe('CARD_ON_FILE');
    expect(payment.externalRef).toMatch(/^pi_sbx_/);
  });

  it('el intento se escribe ANTES de llamar, con su clave derivada', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    const chargeId = await crearCargo(memberId);
    await app.inject({ method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie } });

    const attempt = await getDb().paymentAttempt.findFirstOrThrow({ where: { chargeId } });
    // Derivada, no sorteada: es lo que permite reconstruirla tras un proceso
    // muerto y que el procesador reconozca la operación.
    expect(attempt.idempotencyKey).toBe(`ch_${chargeId}_a1`);
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.outcome).toBe('SUCCESS');
  });

  it('sin tarjeta domiciliada no se cobra', async () => {
    const chargeId = await crearCargo(await crearSocio());
    const res = await app.inject({
      method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/no tiene una tarjeta/i);
  });

  it('sin mandato NO se cobra off-session, aunque haya token', async () => {
    const memberId = await crearSocio();
    const methodId = await domiciliar(memberId, 'ok');
    // Se retira la evidencia del mandato, como si se hubiera guardado la
    // tarjeta "para pedirlo luego".
    await getDb().paymentMethod.update({ where: { id: methodId }, data: { consentId: null } });

    const chargeId = await crearCargo(memberId);
    const res = await app.inject({
      method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/mandato/i);
  });

  // ── Flujo 3: authentication_required y recuperación ───────────────────────

  it('un cargo que pide autenticación NO se marca como fallo', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'auth_required_on_charge');
    const chargeId = await crearCargo(memberId);

    const res = await app.inject({
      method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie },
    });
    expect(res.json().status).toBe('REQUIRES_ACTION');
    expect(res.json().declineKind).toBe('AUTH_REQUIRED');

    const charge = await getDb().charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(charge.status).toBe('OPEN');
  });

  it('se recupera ON-SESSION, con el socio delante', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'auth_required_on_charge');
    const chargeId = await crearCargo(memberId);
    await app.inject({ method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie } });

    const portal = await sesionDeSocio(memberId);
    const pago = await app.inject({
      method: 'POST', url: `/portal/charges/${chargeId}/pay`, headers: { cookie: portal },
      payload: { returnUrl: 'https://socio.gymflow.mx/volver' },
    });
    expect(pago.statusCode, pago.body).toBe(200);
    expect(pago.json().status).toBe('SUCCEEDED');

    const charge = await getDb().charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(charge.status).toBe('PAID');
  });

  it('un rechazo duro no se reintenta solo', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'stolen_card');
    const chargeId = await crearCargo(memberId);

    const primero = await app.inject({
      method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie },
    });
    expect(primero.json().status).toBe('FAILED');
    expect(primero.json().declineKind).toBe('HARD');
    expect(primero.json().retriable).toBe(false);

    const segundo = await app.inject({
      method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie },
    });
    // Reintentar no recupera nada y sube la tasa de rechazos del comercio,
    // que las redes penalizan.
    expect(segundo.statusCode).toBe(409);
    expect(segundo.json().message).toMatch(/rechazo duro/i);
  });

  it('sin saldo SÍ es reintentable: mañana puede haberlo', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'insufficient_funds');
    const chargeId = await crearCargo(memberId);

    const res = await app.inject({
      method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie },
    });
    expect(res.json().declineKind).toBe('SOFT');
    expect(res.json().retriable).toBe(true);
  });

  // ── El timeout, que es el caso que de verdad importa ──────────────────────

  it('un timeout produce UNKNOWN y BLOQUEA el reintento', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'timeout');
    const chargeId = await crearCargo(memberId);

    const primero = await app.inject({
      method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie },
    });
    expect(primero.json().status).toBe('UNKNOWN');
    expect(primero.json().paymentId).toBeNull();

    // Aquí está todo el sprint: el cargo PUDO haberse cobrado. Reintentar
    // sería cobrarlo por segunda vez, y el socio lo descubriría en su estado
    // de cuenta, no aquí.
    const segundo = await app.inject({
      method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie },
    });
    expect(segundo.statusCode).toBe(409);
    expect(segundo.json().message).toMatch(/sin resolver/i);
  });

  /** Socio con su membresía SUSPENDIDA y la cuota del periodo sin pagar. */
  async function suspendidoConCuota(scenario: string): Promise<{ memberId: string; membershipId: string; chargeId: string }> {
    const memberId = await crearSocio();
    const planes = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie } })).json();
    const plan = planes.find((p: { code: string }) => p.code === 'MEN');
    const mem = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships`, headers: { cookie },
      payload: { reason: 'Fixture de prueba', planId: plan.id, soldAtBranchId: branchId },
    });
    expect(mem.statusCode, mem.body).toBe(201);
    await app.inject({ method: 'POST', url: `/memberships/${mem.json().id}/activate`, headers: { cookie }, payload: { reason: 'Fixture de prueba' } });
    const cargo = await app.inject({ method: 'POST', url: `/memberships/${mem.json().id}/period-charge`, headers: { cookie } });
    expect(cargo.statusCode, cargo.body).toBe(201);
    // Como la deja el job: suspendida con la gracia que se le venció.
    const actual = await getDb().membership.findUniqueOrThrow({ where: { id: mem.json().id } });
    await getDb().membership.update({ where: { id: mem.json().id }, data: { status: 'SUSPENDED', graceUntil: actual.currentPeriodStart } });
    await domiciliar(memberId, scenario);
    return { memberId, membershipId: mem.json().id, chargeId: cargo.json().id };
  }

  /**
   * El socio paga desde su teléfono y DEBE volver a entrar. Antes el cargo
   * quedaba pagado y la membresía seguía suspendida: el pago de mostrador
   * reactivaba y el del portal no, porque el portal registraba el dinero sin
   * pasar por la liquidación de billing.
   */
  it('pagar desde el portal REACTIVA la membresía suspendida', async () => {
    const { memberId, membershipId, chargeId } = await suspendidoConCuota('ok');
    const portal = await sesionDeSocio(memberId);

    const res = await app.inject({
      method: 'POST', url: `/portal/charges/${chargeId}/pay`, headers: { cookie: portal },
      payload: { returnUrl: 'https://socio.gymflow.mx/pagos' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('SUCCEEDED');

    const m = await getDb().membership.findUniqueOrThrow({ where: { id: membershipId } });
    expect(m.status).toBe('ACTIVE');
    // La gracia vencida no sobrevive: si quedara, el siguiente cambio de
    // plan (que mueve el inicio del periodo) violaba `graceUntil >= inicio`.
    expect(m.graceUntil).toBeNull();
    // Y el saldo que ve recepción en el padrón queda al día.
    const socio = await getDb().member.findUniqueOrThrow({ where: { id: memberId } });
    expect(socio.balanceCentsCached).toBe(0n);
  });

  it('un pago que se resuelve DESPUÉS también reactiva', async () => {
    const { membershipId, chargeId } = await suspendidoConCuota('timeout');
    await app.inject({ method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie } });
    const attempt = await getDb().paymentAttempt.findFirstOrThrow({ where: { chargeId } });
    expect(attempt.outcome).toBe('UNKNOWN');

    await app.inject({ method: 'POST', url: `/payments/attempts/${attempt.id}/resolve`, headers: { cookie } });
    const m = await getDb().membership.findUniqueOrThrow({ where: { id: membershipId } });
    expect(m.status).toBe('ACTIVE');
  });

  it('la reconsulta resuelve el UNKNOWN y registra el pago UNA sola vez', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'timeout');
    const chargeId = await crearCargo(memberId);
    await app.inject({ method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie } });

    const attempt = await getDb().paymentAttempt.findFirstOrThrow({ where: { chargeId } });
    expect(attempt.outcome).toBe('UNKNOWN');

    const resuelto = await app.inject({
      method: 'POST', url: `/payments/attempts/${attempt.id}/resolve`, headers: { cookie },
    });
    expect(resuelto.statusCode, resuelto.body).toBe(200);
    expect(resuelto.json().status).toBe('SUCCEEDED');

    const pagos = await getDb().payment.count({ where: { memberId, method: 'CARD_ON_FILE' } });
    expect(pagos).toBe(1);

    const charge = await getDb().charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(charge.status).toBe('PAID');
  });

  // ── Flujo 4: reembolso ────────────────────────────────────────────────────

  it('el reembolso EXIGE un segundo usuario, siempre', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    const chargeId = await crearCargo(memberId);
    const cobro = await app.inject({
      method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie },
    });

    const solo = await app.inject({
      method: 'POST', url: `/payments/${cobro.json().paymentId}/refund`, headers: { cookie },
      payload: { amountCents: '1000', reason: 'Sin autorizar' },
    });
    // Devolver dinero es la operación con la que se sacaría dinero de la caja
    // sin que se note. ADR-018 la trata como tal: maker-checker siempre.
    expect(solo.statusCode).toBe(428);
    expect(solo.json().error).toBe('REQUIRE_APPROVAL');
  });

  it('mandar el id del dueño ya NO aprueba: hace falta que teclee su contraseña', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    const chargeId = await crearCargo(memberId);
    const cobro = await app.inject({ method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie } });
    // Antes bastaba con el id del aprobador —que aparece en cualquier corte—
    // y la bitácora lo culpaba a él. Ahora ese campo ni se lee.
    const res = await app.inject({
      method: 'POST', url: `/payments/${cobro.json().paymentId}/refund`, headers: { cookie },
      payload: { amountCents: '1000', reason: 'Prueba', approvedByUserId: aprobador },
    });
    expect(res.statusCode).toBe(428);
  });

  it('un token INVENTADO no aprueba nada', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    const chargeId = await crearCargo(memberId);
    const cobro = await app.inject({ method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie } });
    const res = await app.inject({
      method: 'POST', url: `/payments/${cobro.json().paymentId}/refund`, headers: { cookie },
      payload: { amountCents: '1000', reason: 'Prueba', approvalToken: 'x'.repeat(43) },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/no es válida/i);
  });

  it('con la contraseña equivocada no se emite autorización', async () => {
    const res = await app.inject({
      method: 'POST', url: '/approvals', headers: { cookie },
      payload: { email: 'gerente@demo.mx', password: 'no-es-la-contraseña', permission: 'payments:refund' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('quien NO tiene la segunda firma no puede autorizar', async () => {
    // El maker-checker exige dos personas AUTORIZADAS, no dos personas.
    // La segunda firma es del dueño (2026-10-05).
    const res = await app.inject({
      method: 'POST', url: '/approvals', headers: { cookie },
      payload: { email: 'recepcion@demo.mx', password: PASSWORD, permission: 'payments:refund' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail ?? res.json().message).toMatch(/dueño/);
  });

  it('nadie se autoriza a sí mismo', async () => {
    const res = await app.inject({
      method: 'POST', url: '/approvals', headers: { cookie },
      payload: { email: 'gerencia@demo.mx', password: PASSWORD, permission: 'payments:refund' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('la autorización es de UN solo uso', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    const chargeId = await crearCargo(memberId);
    const cobro = await app.inject({ method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie } });
    const token = await aprobacion(app, cookie, 'payments:refund', undefined, undefined, { resourceId: cobro.json().paymentId, amountCents: '1000' });
    const reembolsar = () => app.inject({
      method: 'POST', url: `/payments/${cobro.json().paymentId}/refund`, headers: { cookie },
      payload: { amountCents: '1000', reason: 'Acuerdo con el socio', approvalToken: token },
    });
    expect((await reembolsar()).statusCode).toBe(201);
    expect((await reembolsar()).statusCode).toBe(422);
  });

  it('una autorización para OTRO permiso no sirve aquí', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    const chargeId = await crearCargo(memberId);
    const cobro = await app.inject({ method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie } });
    const token = await aprobacion(app, cookie, 'billing:charge:void', undefined, undefined, { resourceId: chargeId });
    const res = await app.inject({
      method: 'POST', url: `/payments/${cobro.json().paymentId}/refund`, headers: { cookie },
      payload: { amountCents: '1000', reason: 'Prueba', approvalToken: token },
    });
    expect(res.statusCode).toBe(422);
  });

  it('DOS reembolsos parciales del mismo pago quedan ambos en el libro (BE2-01)', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    const chargeId = await crearCargo(memberId);
    const cobro = await app.inject({ method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie } });
    const paymentId = cobro.json().paymentId;
    for (const motivo of ['Primera semana sin venir', 'Segunda semana sin venir']) {
      const r = await app.inject({
        method: 'POST', url: `/payments/${paymentId}/refund`, headers: { cookie },
        payload: { amountCents: '10000', reason: motivo, approvalToken: await aprobacion(app, cookie, 'payments:refund', undefined, undefined, { resourceId: paymentId, amountCents: '10000' }) },
      });
      expect(r.statusCode, r.body).toBe(201);
    }
    const asientos = await getDb().payment.findMany({ where: { reversesPaymentId: paymentId } });
    expect(asientos.map((a) => a.amountCents)).toEqual([-10000n, -10000n]);
    expect(asientos.every((a) => a.isRefund)).toBe(true);
    // Lo devuelto se deja de cobrar: el cargo queda saldado, no vuelve a deber.
    const cargo = await getDb().charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(cargo.amountCents - cargo.allocatedCents - cargo.adjustedCents).toBe(0n);
  });

  it('reembolsa parcialmente y no deja pasar más de lo cobrado', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    const chargeId = await crearCargo(memberId);
    const cobro = await app.inject({
      method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie },
    });
    const paymentId = cobro.json().paymentId;

    const parcial = await app.inject({
      method: 'POST', url: `/payments/${paymentId}/refund`, headers: { cookie },
      payload: { amountCents: '30000', reason: 'Acuerdo con el socio', approvalToken: await aprobacion(app, cookie, 'payments:refund', undefined, undefined, { resourceId: paymentId, amountCents: '30000' }) },
    });
    expect(parcial.statusCode, parcial.body).toBe(201);

    const excesivo = await app.inject({
      method: 'POST', url: `/payments/${paymentId}/refund`, headers: { cookie },
      payload: { amountCents: '40000', reason: 'Otro acuerdo', approvalToken: await aprobacion(app, cookie, 'payments:refund', undefined, undefined, { resourceId: paymentId, amountCents: '40000' }) },
    });
    expect(excesivo.statusCode).toBe(422);
    expect(excesivo.json().message).toMatch(/excede/i);

    const listado = await app.inject({
      method: 'GET', url: `/payments/${paymentId}/refunds`, headers: { cookie },
    });
    expect(listado.json().refundedCents).toBe('30000');
  });

  it('el reembolso se ASIENTA: el saldo no cambia y ya no se puede revertir el pago', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    const chargeId = await crearCargo(memberId);
    const cobro = await app.inject({ method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie } });
    const paymentId = cobro.json().paymentId;

    const r = await app.inject({
      method: 'POST', url: `/payments/${paymentId}/refund`, headers: { cookie },
      payload: { amountCents: '20000', reason: 'No usó la última semana', approvalToken: await aprobacion(app, cookie, 'payments:refund', undefined, undefined, { resourceId: paymentId, amountCents: '20000' }) },
    });
    expect(r.statusCode, r.body).toBe(201);

    const db = getDb();
    const contra = await db.payment.findFirstOrThrow({ where: { reversesPaymentId: paymentId } });
    expect(contra.amountCents).toBe(-20000n);
    const cargo = await db.charge.findUniqueOrThrow({ where: { id: chargeId } });
    // Menos aplicado y lo mismo ajustado: el cargo sigue saldado.
    expect(cargo.allocatedCents).toBe(45000n);
    expect(cargo.adjustedCents).toBe(20000n);
    expect(cargo.status).toBe('PAID');

    // Y ya no se revierte completo: devolvería dos veces.
    const rev = await app.inject({
      method: 'POST', url: `/payments/${paymentId}/reverse`, headers: { cookie },
      payload: { reason: 'Intento de doble devolución', approvalToken: await aprobacion(app, cookie, 'payments:reverse', undefined, undefined, { resourceId: paymentId, amountCents: (await getDb().payment.findUniqueOrThrow({ where: { id: paymentId } })).amountCents }) },
    });
    expect(rev.statusCode).toBe(409);
  });

  it('un contracargo reabre el cargo: el pago deja de contar', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    const chargeId = await crearCargo(memberId);
    const cobro = await app.inject({ method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie } });
    const payment = await getDb().payment.findUniqueOrThrow({ where: { id: cobro.json().paymentId } });
    const { PaymentsService } = await import('../src/modules/payments/payments.service.js');
    await new PaymentsService(provider).applyEvent(orgId, { type: 'charge.dispute.created', providerPaymentId: payment.externalRef, payload: {} });

    const cargo = await getDb().charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(cargo.allocatedCents).toBe(0n);
    expect(cargo.status).not.toBe('PAID');
    expect(await getDb().payment.count({ where: { reversesPaymentId: payment.id } })).toBe(1);
  });

  it('el reembolso exige motivo', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    const chargeId = await crearCargo(memberId);
    const cobro = await app.inject({
      method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie },
    });

    const res = await app.inject({
      method: 'POST', url: `/payments/${cobro.json().paymentId}/refund`, headers: { cookie },
      payload: { amountCents: '1000', reason: '', approvalToken: await aprobacion(app, cookie, 'payments:refund', undefined, undefined, { resourceId: cobro.json().paymentId, amountCents: '1000' }) },
    });
    expect(res.statusCode).toBe(422);
  });

  // ── Flujo 5: disputa, y los webhooks ──────────────────────────────────────

  async function mandarEvento(payload: object, firmar = true) {
    const raw = JSON.stringify(payload);
    return app.inject({
      method: 'POST', url: '/webhooks/payments',
      headers: {
        'content-type': 'application/json',
        ...(firmar ? { 'x-gymflow-signature': provider.sign(raw) } : {}),
      },
      payload: raw,
    });
  }

  it('el webhook responde 200 y ENCOLA: nunca procesa en línea', async () => {
    const eventId = `evt_${uuidv7()}`;
    const res = await mandarEvento({ id: eventId, type: 'payment_intent.succeeded', paymentId: 'pi_sbx_x' });
    expect(res.statusCode).toBe(200);
    // La respuesta es siempre la misma: no le dice a nadie si firmó bien (SEC-05).
    expect(res.json()).toEqual({ received: true });

    const stored = await getDb().webhookEvent.findFirstOrThrow({ where: { providerEventId: eventId } });
    expect(stored.status).toBe('RECEIVED');
    expect(stored.rawPayload).toBeTruthy();
  });

  it('un webhook REPETIDO es un no-op, y responde 200 igual', async () => {
    const evento = { id: `evt_${uuidv7()}`, type: 'payment_intent.succeeded', paymentId: 'pi_sbx_y' };
    const primero = await mandarEvento(evento);
    const segundo = await mandarEvento(evento);

    expect(primero.json()).toEqual({ received: true });
    expect(segundo.json()).toEqual({ received: true });
    // 200 a propósito: un error haría que el proveedor siguiera reintentando
    // algo que ya está hecho.
    expect(segundo.statusCode).toBe(200);

    const filas = await getDb().webhookEvent.count({ where: { providerEventId: evento.id } });
    expect(filas).toBe(1);
  });

  it('una firma inválida NO se procesa, pero SÍ se guarda', async () => {
    const eventId = `evt_${uuidv7()}`;
    const res = await mandarEvento({ id: eventId, type: 'payment_intent.succeeded' }, false);
    expect(res.json()).toEqual({ received: true });

    // Descartarla sin registro dejaría sin rastro justo el evento que hay
    // que investigar. Se guarda con un id propio para no ocupar el real.
    const stored = await getDb().webhookEvent.findFirstOrThrow({ where: { providerEventId: { endsWith: `:${eventId}` } } });
    expect(stored.signatureStatus).toBe('INVALID');
    expect(stored.status).toBe('FAILED');
  });

  it('un evento SIN firma no ocupa el id del legítimo, que llega después', async () => {
    const evento = { id: `evt_${uuidv7()}`, type: 'payment_intent.succeeded', paymentId: 'pi_sbx_squat' };
    await mandarEvento(evento, false); // el atacante se adelanta
    await mandarEvento(evento);        // el procesador, con firma
    const valido = await getDb().webhookEvent.findFirst({ where: { providerEventId: evento.id } });
    expect(valido?.signatureStatus).toBe('VALID');
    expect(valido?.status).toBe('RECEIVED');
  });

  it('una firma vieja no vale: un evento capturado no se puede reenviar', async () => {
    const raw = JSON.stringify({ id: `evt_${uuidv7()}`, type: 'payment_intent.succeeded' });
    const haceUnaHora = provider.sign(raw, new Date(Date.now() - 3_600_000));
    expect(provider.verifyWebhook(raw, haceUnaHora)).toBe(false);
    expect(provider.verifyWebhook(raw, provider.sign(raw))).toBe(true);
    // Y se verifica sobre los bytes: el mismo JSON con otro espaciado es otra firma.
    expect(provider.verifyWebhook(JSON.stringify(JSON.parse(raw), null, 2), provider.sign(raw))).toBe(false);
  });

  it('el webhook firma sobre los bytes que llegan, con cualquier espaciado', async () => {
    const eventId = `evt_${uuidv7()}`;
    const raw = `{ "id": "${eventId}",   "type": "payment_intent.succeeded" }`;
    await app.inject({
      method: 'POST', url: '/webhooks/payments',
      headers: { 'content-type': 'application/json', 'x-gymflow-signature': provider.sign(raw) },
      payload: raw,
    });
    const stored = await getDb().webhookEvent.findFirstOrThrow({ where: { providerEventId: eventId } });
    expect(stored.signatureStatus).toBe('VALID');
  });

  it('una disputa abre su contracargo, y el reenvío no lo duplica', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    const chargeId = await crearCargo(memberId);
    const cobro = await app.inject({
      method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie },
    });
    const payment = await getDb().payment.findUniqueOrThrow({ where: { id: cobro.json().paymentId } });

    const { PaymentsService } = await import('../src/modules/payments/payments.service.js');
    const service = new PaymentsService(provider);

    for (let i = 0; i < 2; i++) {
      await service.applyEvent(orgId, {
        type: 'charge.dispute.created',
        providerPaymentId: payment.externalRef,
        payload: { reasonCode: 'fraudulent' },
      });
    }

    const contracargos = await getDb().chargeback.count({ where: { paymentId: payment.id } });
    expect(contracargos).toBe(1);
  });

  it('un evento ATRASADO no deshace un cobro exitoso', async () => {
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    const chargeId = await crearCargo(memberId);
    const cobro = await app.inject({
      method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie },
    });
    const payment = await getDb().payment.findUniqueOrThrow({ where: { id: cobro.json().paymentId } });

    const { PaymentsService } = await import('../src/modules/payments/payments.service.js');
    const outcome = await new PaymentsService(provider).applyEvent(orgId, {
      type: 'payment_intent.payment_failed',
      providerPaymentId: payment.externalRef,
      payload: {},
    });

    // Los webhooks llegan desordenados: es normal. Sin esta guarda el socio
    // pagó, el sistema dice que no, y el torniquete le cierra la puerta.
    expect(outcome).toBe('IGNORED');
    const despues = await getDb().payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(despues.status).toBe('SUCCEEDED');
  });

  it('la cola de webhooks NO se atasca: 120 eventos inaplicables al frente no frenan uno real', async () => {
    // Antes el job tomaba siempre los 100 más antiguos en RECEIVED y nunca
    // cerraba los que no aplicaban: con 100 así, ningún webhook nuevo —ni
    // una disputa— se volvía a procesar.
    for (let i = 0; i < 120; i++) {
      await mandarEvento({ id: `evt_${uuidv7()}`, type: 'payment_intent.succeeded', paymentId: `pi_inexistente_${uuidv7()}` });
    }
    const memberId = await crearSocio();
    await domiciliar(memberId, 'ok');
    const chargeId = await crearCargo(memberId);
    const cobro = await app.inject({ method: 'POST', url: `/charges/${chargeId}/charge-card`, headers: { cookie } });
    const payment = await getDb().payment.findUniqueOrThrow({ where: { id: cobro.json().paymentId } });

    const disputa = `evt_${uuidv7()}`;
    await mandarEvento({ id: disputa, type: 'charge.dispute.created', paymentId: payment.externalRef, reasonCode: 'fraudulent' });
    const atrasado = `evt_${uuidv7()}`;
    await mandarEvento({ id: atrasado, type: 'payment_intent.payment_failed', paymentId: payment.externalRef });

    const { PAYMENT_JOBS } = await import('../src/modules/payments/payments.jobs.js');
    const job = PAYMENT_JOBS.find((j) => j.name === 'payments.process-webhooks')!;
    await job.handler(orgId);

    const real = await getDb().webhookEvent.findFirstOrThrow({ where: { providerEventId: disputa } });
    expect(real.status).toBe('PROCESSED');
    expect(await getDb().chargeback.count({ where: { paymentId: payment.id } })).toBe(1);
    // El que no aplica se CIERRA con motivo, no se queda en la cola.
    const viejo = await getDb().webhookEvent.findFirstOrThrow({ where: { providerEventId: atrasado } });
    expect(viejo.status).toBe('IGNORED');
    expect(viejo.lastError).toBeTruthy();
  });

  // ── Cancelación en un clic ────────────────────────────────────────────────

  it('el socio cancela su domiciliación en UN clic', async () => {
    const memberId = await crearSocio();
    const methodId = await domiciliar(memberId, 'ok');
    const portal = await sesionDeSocio(memberId);

    const res = await app.inject({
      method: 'DELETE', url: `/portal/payment-methods/${methodId}`, headers: { cookie: portal },
    });
    expect(res.statusCode, res.body).toBe(200);

    const row = await getDb().paymentMethod.findUniqueOrThrow({ where: { id: methodId } });
    expect(row.status).toBe('REVOKED');
    expect(row.isDefault).toBe(false);
  });

  it('un socio NO puede cancelar la tarjeta de otro', async () => {
    const duenno = await crearSocio();
    const methodId = await domiciliar(duenno, 'ok');
    const ajeno = await sesionDeSocio(await crearSocio());

    const res = await app.inject({
      method: 'DELETE', url: `/portal/payment-methods/${methodId}`, headers: { cookie: ajeno },
    });
    expect(res.statusCode).toBe(404);
  });
  it('pago único: cobra con la tarjeta recién capturada, sin mandato, y no la guarda (UX 2026-10-08)', async () => {
    const memberId = await crearSocio();
    const cargo = await crearCargo(memberId, 30_000n);
    const portal = await sesionDeSocio(memberId);
    const setup = await app.inject({ method: 'POST', url: '/portal/payment-methods/setup', headers: { cookie: portal }, payload: { returnUrl: 'https://socio.gymflow.mx/volver', scenario: 'ok' } });
    expect(setup.statusCode, setup.body).toBeLessThan(300);
    const r = await app.inject({ method: 'POST', url: `/portal/charges/${cargo}/pay`, headers: { cookie: portal }, payload: { setupId: setup.json().setupId } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().status).toBe('SUCCEEDED');
    const tarjetas = await getDb().paymentMethod.findMany({ where: { memberId } });
    expect(tarjetas.length).toBe(1);
    expect(tarjetas[0]!.status).toBe('REVOKED');
    expect(tarjetas[0]!.consentId).toBeNull();
    expect(await getDb().memberConsent.count({ where: { memberId, consentType: 'RECURRING_CHARGE' } })).toBe(0);
  });
});

/**
 * EL PAN NO ENTRA.
 *
 * Es el DoD del sprint: una prueba explícita de que ningún endpoint acepta un
 * número de tarjeta. Se prueba contra endpoints que nada tienen que ver con
 * pagos, porque el sitio por donde entraría de verdad es el campo de notas de
 * un socio, no un campo `cardNumber` que no existe.
 */
describe('ningún endpoint acepta un PAN', () => {
  let app: FastifyInstance;
  let cookie: string;
  let branchId: string;

  // Números de PRUEBA públicos de los procesadores. No son tarjetas reales.
  const PAN = '4242424242424242';
  const PAN_CON_ESPACIOS = '5555 5555 5555 4444';

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    cookie = await loginAs(app, 'gerencia@demo.mx');
    branchId = (await orgFixtures()).demoBranches[0]!.id;
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('lo rechaza en el alta de un socio', async () => {
    const res = await app.inject({
      method: 'POST', url: '/members', headers: { cookie },
      payload: {
        firstName: nombreUnico('Pan'), lastName: nombreUnico('Prueba'),
        notes: `me dictó su tarjeta ${PAN}`,
        homeBranchId: branchId,
        consents: [
          { consentType: 'PRIVACY_NOTICE', documentVersion: 'v1.0', granted: true },
          { consentType: 'HOUSE_RULES', documentVersion: 'v1.0', granted: true },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/número de tarjeta/i);
  });

  it('lo rechaza aunque venga con espacios', async () => {
    const res = await app.inject({
      method: 'POST', url: '/members', headers: { cookie },
      payload: {
        firstName: nombreUnico('Pan'), lastName: nombreUnico('Espacios'),
        notes: PAN_CON_ESPACIOS, homeBranchId: branchId, consents: [],
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('lo rechaza en un endpoint que no tiene nada que ver con pagos', async () => {
    const res = await app.inject({
      method: 'POST', url: '/classes/types', headers: { cookie },
      payload: { name: PAN, defaultCapacity: 10 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('el mensaje de error NO repite el número', async () => {
    const res = await app.inject({
      method: 'POST', url: '/classes/types', headers: { cookie },
      payload: { name: `Clase ${PAN}`, defaultCapacity: 10 },
    });
    // Devolverlo lo metería en el log de respuesta, que es justo lo que se
    // intenta evitar.
    expect(res.body).not.toContain(PAN);
  });

  it('lo rechaza en la QUERY, que es el camino más corto de todos', async () => {
    // `GET /members/search?q=<PAN>` no tiene cuerpo: el guard no se disparaba
    // y la URL con su query entraba entera en el log de la petición.
    // Recepción pegando un número en la caja de búsqueda bastaba.
    const res = await app.inject({
      method: 'GET', url: `/members/search?q=${PAN}`, headers: { cookie },
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(PAN);
  });

  it('NO estorba a los datos legítimos', async () => {
    const res = await app.inject({
      method: 'POST', url: '/classes/types', headers: { cookie },
      payload: {
        name: nombreUnico('Clase'),
        description: 'Tel 5512345678 · sala 2 · cupo 20 · folio CEN-000123',
        defaultCapacity: 20,
      },
    });
    expect(res.statusCode).toBe(201);
  });
});
