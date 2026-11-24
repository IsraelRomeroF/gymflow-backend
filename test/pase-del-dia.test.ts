import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { addDays, auditPhrase, AVISO_PASE_DEL_DIA } from '@gymflow/core';
import {
  AccessAttemptPreview, AccessAttemptResult, AccessSummaryResponse, DayPassSaleResult, MemberDayPasses, diferenciasConElContrato,
} from '@gymflow/core/contracts';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, CONSENTIMIENTOS, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { altaSinCobro } from './membresia-de-prueba.js';

/**
 * PASE DEL DÍA (auditoría 8, bloque 1.8; hallazgo 4-01; D-20).
 *
 * La visita suelta dejó de ser una membresía de un día: es un cargo `DAY_PASS`
 * pagado que da acceso ese día de operación en la sede donde se vendió.
 *
 * - Vender: un cargo y su cobro; sin membresía y sin inscripción.
 * - La puerta lo reconoce (vista previa y entrada), solo hoy y solo en su sede.
 * - Al día siguiente no hay cuota, ni deuda, ni nada que impida venderle otro.
 * - Dinero: llave de la venta (el reintento no cobra dos veces), no queda a
 *   deber, el saldo a favor va primero, dos ventas a la vez dejan un pase.
 * - La venta vieja (membresía de un día) ya no existe por ninguna puerta.
 */
describe('pase del día (1.8)', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let recepcion: string;
  let orgId: string;
  let cen: string;
  let nor: string;
  let visita: string;
  let mensual: string;

  const spei = () => ({ method: 'SPEI_TRANSFER', externalRef: `SPEI-${randomUUID().slice(0, 8)}` });
  const codigo = () => `P${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  /** «Hoy» del gimnasio: de noche en México la fecha de UTC ya es mañana. */
  const hoyNegocio = () => new Date(`${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })}T00:00:00.000Z`);
  const dia = (d: Date) => d.toISOString().slice(0, 10);

  async function crearPlan(over: Record<string, unknown> = {}): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/plans', headers: { cookie: gerencia },
      payload: {
        code: codigo(), name: 'Visita suelta', billingModel: 'DAY_PASS', durationUnit: 'DAY', durationValue: 1,
        priceCents: '15000', signupFeeCents: '0', branchAccessScope: 'HOME_BRANCH', reason: 'Plan de la prueba del bloque 1.8', ...over,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  async function nuevoSocio(): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Pase'), lastName: nombreUnico('Deldia'), phoneE164: telefonoUnico(), homeBranchId: cen, force: true, consents: CONSENTIMIENTOS },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  const venderPase = (memberId: string, extra: Record<string, unknown> = {}, cookie = recepcion) => app.inject({
    method: 'POST', url: `/members/${memberId}/day-passes`, headers: { cookie },
    payload: { planId: visita, branchId: cen, saleKey: `pase-${randomUUID()}`, payment: spei(), ...extra },
  });
  const previa = (memberId: string, branchId = cen) => app.inject({
    method: 'POST', url: '/access/attempts/preview', headers: { cookie: gerencia }, payload: { branchId, memberId },
  });
  const intentar = (memberId: string, extra: Record<string, unknown> = {}) => app.inject({
    method: 'POST', url: '/access/attempts', headers: { cookie: recepcion },
    payload: { branchId: cen, memberId, credentialKind: 'MANUAL', ...extra },
  });
  const cargosDe = (memberId: string) => getDb().charge.findMany({ where: { memberId }, orderBy: { createdAt: 'asc' } });
  /** Llega el día siguiente: el pase vendido «hoy» pasa a ser de ayer. */
  const envejecer = (chargeId: string) => getDb().charge.update({
    where: { id: chargeId }, data: { periodStart: addDays(hoyNegocio(), -1), periodEnd: hoyNegocio(), dueDate: addDays(hoyNegocio(), -1) },
  });

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
    nor = f.demoBranches.find((b) => b.code === 'NOR')!.id;
    // Con inscripción a propósito: el pase NUNCA la cobra (D-20), la traiga o no el plan.
    visita = await crearPlan({ signupFeeCents: '30000' });
    mensual = (await getDb().plan.findFirstOrThrow({ where: { organizationId: orgId, code: 'MEN' } })).id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  // ── La venta ──────────────────────────────────────────────────────────────

  it('vende un cargo y su cobro: sin membresía, sin inscripción, con la forma del contrato', async () => {
    const memberId = await nuevoSocio();

    // La cotización ya no ofrece inscripción para la visita suelta.
    const cot = (await app.inject({ method: 'GET', url: `/plans/${visita}/quote?branchId=${cen}`, headers: { cookie: recepcion } })).json();
    expect(cot.totalCents).toBe('15000');
    expect(cot.lines).toHaveLength(1);
    expect(cot.lines[0].concept).toMatch(/^Pase del día/);

    const r = await venderPase(memberId);
    expect(r.statusCode, r.body).toBe(201);
    expect(diferenciasConElContrato(DayPassSaleResult, r.json())).toEqual([]);
    const venta = r.json() as DayPassSaleResult;
    expect(venta).toMatchObject({ created: true, creditAppliedCents: '0' });
    expect(venta.pass).toMatchObject({ memberId, branchId: cen, validOn: dia(hoyNegocio()), amountCents: '15000', paid: true, validToday: true });
    expect(venta.payment).toMatchObject({ amountCents: '15000' });

    // Un solo cargo, de pase, pagado, sin membresía; ninguna membresía nació.
    const cargos = await cargosDe(memberId);
    expect(cargos).toHaveLength(1);
    expect(cargos[0]).toMatchObject({ chargeType: 'DAY_PASS', status: 'PAID', membershipId: null, branchId: cen, amountCents: 15000n });
    expect(dia(cargos[0]!.periodStart!)).toBe(dia(hoyNegocio()));
    expect(dia(cargos[0]!.periodEnd!)).toBe(dia(addDays(hoyNegocio(), 1)));
    expect(await getDb().membership.count({ where: { memberId } })).toBe(0);

    // El estado de cuenta lo muestra como pase y no queda debiendo nada.
    const cuenta = (await app.inject({ method: 'GET', url: `/members/${memberId}/statement`, headers: { cookie: gerencia } })).json();
    expect(cuenta.outstandingCents).toBe('0');
    expect(cuenta.charges[0]).toMatchObject({ chargeType: 'DAY_PASS', status: 'PAID', balanceCents: '0' });
    expect(cuenta.charges[0].concept).toBe('Pase del día · Visita suelta');

    // La bitácora lo dice con su frase y su importe, dentro de la misma unidad.
    const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'daypass.sell', resourceId: venta.pass.id } });
    expect(asiento.afterState).toMatchObject({ memberId, amountCents: '15000', validOn: dia(hoyNegocio()) });
    expect(auditPhrase({ action: 'daypass.sell', afterState: asiento.afterState }, { member: 'Ana López' })).toBe('vendió un pase del día de $150.00 a Ana López');
  });

  it('la ficha lo cuenta: el pase de hoy y cuántos lleva', async () => {
    const memberId = await nuevoSocio();
    const vacio = await app.inject({ method: 'GET', url: `/members/${memberId}/day-passes`, headers: { cookie: recepcion } });
    expect(vacio.statusCode, vacio.body).toBe(200);
    expect(vacio.json()).toEqual({ today: null, total: 0, recent: [] });

    const viejo = (await venderPase(memberId)).json() as DayPassSaleResult;
    await envejecer(viejo.pass.id);
    const hoy = (await venderPase(memberId)).json() as DayPassSaleResult;

    const r = await app.inject({ method: 'GET', url: `/members/${memberId}/day-passes`, headers: { cookie: recepcion } });
    expect(diferenciasConElContrato(MemberDayPasses, r.json())).toEqual([]);
    const lista = r.json() as MemberDayPasses;
    expect(lista.total).toBe(2);
    expect(lista.today?.id).toBe(hoy.pass.id);
    expect(lista.recent.map((p) => [p.id, p.validToday])).toEqual([[hoy.pass.id, true], [viejo.pass.id, false]]);
  });

  // ── La puerta ─────────────────────────────────────────────────────────────

  it('la puerta lo reconoce: entra hoy en su sede, con su aviso, y no en otra sede', async () => {
    const memberId = await nuevoSocio();
    const antes = await previa(memberId);
    expect(antes.json()).toMatchObject({ outcome: 'DENIED', reason: 'NO_MEMBERSHIP' });

    expect((await venderPase(memberId)).statusCode).toBe(201);

    const despues = await previa(memberId);
    expect(diferenciasConElContrato(AccessAttemptPreview, despues.json())).toEqual([]);
    expect(despues.json()).toMatchObject({ outcome: 'GRANTED', reason: null, warning: AVISO_PASE_DEL_DIA, wouldConsumeVisit: false });

    // En otra sede el pase no abre.
    expect((await previa(memberId, nor)).json()).toMatchObject({ outcome: 'DENIED', reason: 'NO_MEMBERSHIP' });

    // En una sede con cámara la entrada por el mostrador pide motivo, también con pase.
    const entrada = await intentar(memberId, { reason: 'Visita de hoy, sin rostro dado de alta' });
    expect(entrada.statusCode, entrada.body).toBe(201);
    expect(diferenciasConElContrato(AccessAttemptResult, entrada.json())).toEqual([]);
    expect(entrada.json()).toMatchObject({ outcome: 'GRANTED', warning: AVISO_PASE_DEL_DIA, consumedVisit: false });
    expect(entrada.json().attendanceId).toBeTruthy();

    // La lista dice lo mismo que la puerta.
    const resumen = await app.inject({ method: 'GET', url: `/members/access-summary?ids=${memberId}`, headers: { cookie: recepcion } });
    expect(diferenciasConElContrato(AccessSummaryResponse, resumen.json())).toEqual([]);
    expect(resumen.json().members[0]).toMatchObject({ membership: null, pack: null, canEnter: true, dayPass: { branchId: cen, validOn: dia(hoyNegocio()) } });
  });

  it('«Vender y abrir»: el rechazo de la puerta se resuelve con la entrada tras vender el pase', async () => {
    const memberId = await nuevoSocio();
    const rechazo = await intentar(memberId);
    expect(rechazo.json()).toMatchObject({ outcome: 'DENIED', reason: 'NO_MEMBERSHIP' });

    expect((await venderPase(memberId)).statusCode).toBe(201);
    const verde = await intentar(memberId, { reason: 'Renovó en el mostrador', resolvesDecisionId: rechazo.json().decisionId });
    expect(verde.json(), verde.body).toMatchObject({ outcome: 'GRANTED', warning: AVISO_PASE_DEL_DIA });
    expect(await getDb().accessDecision.count({ where: { resolvesDecisionId: rechazo.json().decisionId } })).toBe(1);
  });

  it('al día siguiente: no abre, no hay cuota ni deuda, los jobs no lo tocan y se le vende otro', async () => {
    const memberId = await nuevoSocio();
    const ayer = (await venderPase(memberId)).json() as DayPassSaleResult;
    await envejecer(ayer.pass.id);

    expect((await previa(memberId)).json()).toMatchObject({ outcome: 'DENIED', reason: 'NO_MEMBERSHIP' });
    const resumen = (await app.inject({ method: 'GET', url: `/members/access-summary?ids=${memberId}`, headers: { cookie: recepcion } })).json();
    expect(resumen.members[0]).toMatchObject({ canEnter: false, dayPass: null });

    // El cierre diario: ni renovación, ni vencimiento, ni mora sobre el pase.
    const { rollPeriods } = await import('../src/modules/billing/billing.jobs.js');
    const { expireMemberships } = await import('../src/modules/memberships/membership.jobs.js');
    await rollPeriods(orgId);
    await expireMemberships(orgId);
    const cargos = await cargosDe(memberId);
    expect(cargos).toHaveLength(1);
    expect(cargos[0]!.status).toBe('PAID');
    const cuenta = (await app.inject({ method: 'GET', url: `/members/${memberId}/statement`, headers: { cookie: gerencia } })).json();
    expect(cuenta.outstandingCents).toBe('0');

    // Vuelve: se le vende otro sin «ya tiene una membresía vigente».
    const otro = await venderPase(memberId);
    expect(otro.statusCode, otro.body).toBe(201);
    expect((await previa(memberId)).json().outcome).toBe('GRANTED');
    // Los jobs recorren TODO el gimnasio: en una base con volumen recién sembrada la primera pasada tarda.
  }, 120_000);

  it('el pase con el cobro revertido deja de abrir', async () => {
    const memberId = await nuevoSocio();
    const venta = (await venderPase(memberId, {}, gerencia)).json() as DayPassSaleResult;
    expect((await previa(memberId)).json().outcome).toBe('GRANTED');
    const reversa = await app.inject({
      method: 'POST', url: `/payments/${venta.payment!.id}/reverse`, headers: { cookie: gerencia },
      payload: {
        reason: 'Se cobró por error',
        approvalToken: await aprobacion(app, gerencia, 'payments:reverse', undefined, undefined, { resourceId: venta.payment!.id, amountCents: venta.payment!.amountCents }),
      },
    });
    expect([200, 201], reversa.body).toContain(reversa.statusCode);
    // El pase no queda a deber: su cargo se anula con la reversa (cierre de la oleada C).
    expect((await getDb().charge.findUniqueOrThrow({ where: { id: venta.pass.id } })).status).toBe('VOID');
    expect((await previa(memberId)).json()).toMatchObject({ outcome: 'DENIED', reason: 'NO_MEMBERSHIP' });
  });

  // ── El dinero ─────────────────────────────────────────────────────────────

  it('la misma venta enviada dos veces es UN pase y UN cobro; otro pase el mismo día se rechaza', async () => {
    const memberId = await nuevoSocio();
    const saleKey = `pase-${randomUUID()}`;
    const primero = await venderPase(memberId, { saleKey });
    expect(primero.statusCode, primero.body).toBe(201);
    const reintento = await venderPase(memberId, { saleKey });
    expect(reintento.statusCode, reintento.body).toBe(200);
    expect(diferenciasConElContrato(DayPassSaleResult, reintento.json())).toEqual([]);
    expect(reintento.json()).toMatchObject({ created: false, pass: { id: primero.json().pass.id }, payment: { id: primero.json().payment.id } });
    expect(await getDb().charge.count({ where: { memberId } })).toBe(1);
    expect(await getDb().payment.count({ where: { memberId } })).toBe(1);

    const otro = await venderPase(memberId);
    expect(otro.statusCode, otro.body).toBe(409);
    expect(otro.json().message).toMatch(/Ya tiene su pase de hoy/);
    expect(await getDb().charge.count({ where: { memberId } })).toBe(1);
  });

  it('dos ventas a la vez (dos mostradores) dejan un pase y un cobro', async () => {
    const memberId = await nuevoSocio();
    const [a, b] = await Promise.all([venderPase(memberId), venderPase(memberId, {}, gerencia)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(await getDb().charge.count({ where: { memberId } })).toBe(1);
    expect(await getDb().payment.count({ where: { memberId } })).toBe(1);
  });

  it('no queda a deber: sin cobro responde 422 y no deja cargo, ni asiento', async () => {
    const memberId = await nuevoSocio();
    const r = await venderPase(memberId, { payment: null });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().message).toMatch(/se cobra al venderlo/);
    expect(await getDb().charge.count({ where: { memberId } })).toBe(0);
    expect(await getDb().auditLog.count({ where: { organizationId: orgId, action: 'daypass.sell', afterState: { path: ['memberId'], equals: memberId } } })).toBe(0);
  });

  it('el saldo a favor va primero: si cubre el pase no se cobra nada; si no, se cobra la diferencia', async () => {
    const abonar = async (memberId: string, cents: string) => {
      const r = await app.inject({
        method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: gerencia },
        payload: { idempotencyKey: `abono-${randomUUID()}`, amountCents: cents, branchId: cen, ...spei() },
      });
      expect(r.statusCode, r.body).toBe(201);
    };
    const cubierto = await nuevoSocio();
    await abonar(cubierto, '20000');
    const sinCobro = await venderPase(cubierto, { payment: null });
    expect(sinCobro.statusCode, sinCobro.body).toBe(201);
    expect(sinCobro.json()).toMatchObject({ payment: null, creditAppliedCents: '15000', pass: { paid: true, validToday: true } });
    const cuenta = (await app.inject({ method: 'GET', url: `/members/${cubierto}/statement`, headers: { cookie: gerencia } })).json();
    expect(cuenta.creditCents).toBe('5000');

    const parcial = await nuevoSocio();
    await abonar(parcial, '5000');
    const conCobro = await venderPase(parcial);
    expect(conCobro.statusCode, conCobro.body).toBe(201);
    expect(conCobro.json()).toMatchObject({ payment: { amountCents: '10000' }, creditAppliedCents: '5000', pass: { paid: true } });
  });

  it('en efectivo entra al turno de caja con su folio', async () => {
    const sello = randomUUID().slice(0, 6).toUpperCase();
    const caja = await app.inject({ method: 'POST', url: '/cash-registers', headers: { cookie: gerencia }, payload: { branchId: nor, code: `D${sello}`, name: `Caja pase ${sello}` } });
    expect(caja.statusCode, caja.body).toBe(201);
    const turno = await app.inject({ method: 'POST', url: '/cash-sessions', headers: { cookie: gerencia }, payload: { cashRegisterId: caja.json().id, openingFloatCents: '0' } });
    expect(turno.statusCode, turno.body).toBe(201);
    try {
      const memberId = await nuevoSocio();
      const r = await venderPase(memberId, { branchId: nor, payment: { method: 'CASH', cashSessionId: turno.json().id } }, gerencia);
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().payment.folio).toBeTruthy();
      const rep = (await app.inject({ method: 'GET', url: `/cash-sessions/${turno.json().id}`, headers: { cookie: gerencia } })).json();
      expect(rep.expectedCashCents).toBe('15000');
    } finally {
      await app.inject({ method: 'POST', url: `/cash-sessions/${turno.json().id}/close`, headers: { cookie: gerencia }, payload: { countedCashCents: '15000' } });
    }
  });

  // ── Lo que ya no se puede ─────────────────────────────────────────────────

  it('la visita suelta ya no se vende como membresía por ninguna puerta', async () => {
    const memberId = await nuevoSocio();
    const venta = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: gerencia },
      payload: { planId: visita, branchId: cen, saleKey: `venta-${randomUUID()}`, payment: spei() },
    });
    expect(venta.statusCode, venta.body).toBe(422);
    expect(venta.json().message).toMatch(/pase del día/);
    const aMano = await altaSinCobro(app, gerencia, memberId, { reason: 'Corrección de prueba', planId: visita, soldAtBranchId: cen });
    expect(aMano.statusCode, aMano.body).toBe(422);
    expect(await getDb().membership.count({ where: { memberId } })).toBe(0);
    expect(await getDb().charge.count({ where: { memberId } })).toBe(0);
  });

  it('reglas de la venta: solo planes de visita suelta, no a quien ya tiene membresía, no a un socio de otro gimnasio', async () => {
    const memberId = await nuevoSocio();
    const noEsVisita = await venderPase(memberId, { planId: mensual });
    expect(noEsVisita.statusCode, noEsVisita.body).toBe(422);

    const conPlan = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: gerencia },
      payload: { planId: mensual, branchId: cen, saleKey: `venta-${randomUUID()}`, payment: spei() },
    });
    expect(conPlan.statusCode, conPlan.body).toBe(201);
    const yaTiene = await venderPase(memberId);
    expect(yaTiene.statusCode, yaTiene.body).toBe(409);
    expect(yaTiene.json().message).toMatch(/membresía vigente/);

    // Aislamiento: otro gimnasio no vende ni lee pases de este socio.
    const otro = await loginAs(app, 'gerencia@otro.mx');
    const suelto = await nuevoSocio();
    const ajena = await app.inject({
      method: 'POST', url: `/members/${suelto}/day-passes`, headers: { cookie: otro },
      payload: { planId: visita, branchId: cen, saleKey: `pase-${randomUUID()}`, payment: spei() },
    });
    expect([403, 404]).toContain(ajena.statusCode);
    expect((await app.inject({ method: 'GET', url: `/members/${suelto}/day-passes`, headers: { cookie: otro } })).statusCode).toBe(404);
    expect(await getDb().charge.count({ where: { memberId: suelto } })).toBe(0);
  });

  it('a un suspendido por adeudo se le puede vender el pase y entra ese día (como antes con la visita suelta)', async () => {
    const memberId = await nuevoSocio();
    const venta = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: gerencia },
      payload: { planId: mensual, branchId: cen, saleKey: `venta-${randomUUID()}`, payment: spei() },
    });
    expect(venta.statusCode, venta.body).toBe(201);
    await getDb().membership.update({ where: { id: venta.json().membership.id }, data: { status: 'SUSPENDED' } });
    expect((await previa(memberId)).json()).toMatchObject({ outcome: 'DENIED', reason: 'MEMBERSHIP_SUSPENDED' });

    const pase = await venderPase(memberId);
    expect(pase.statusCode, pase.body).toBe(201);
    expect((await previa(memberId)).json()).toMatchObject({ outcome: 'GRANTED', warning: AVISO_PASE_DEL_DIA });
    const resumen = (await app.inject({ method: 'GET', url: `/members/access-summary?ids=${memberId}`, headers: { cookie: recepcion } })).json();
    expect(resumen.members[0]).toMatchObject({ canEnter: true, membership: { status: 'SUSPENDED' }, dayPass: { branchId: cen } });
  });

  it('permisos: sin sesión 401; el coach no vende pases (ni ve a quien no es su socio)', async () => {
    const memberId = await nuevoSocio();
    const sinSesion = await app.inject({ method: 'POST', url: `/members/${memberId}/day-passes`, payload: {} });
    expect(sinSesion.statusCode).toBe(401);
    const coach = await loginAs(app, 'coach@demo.mx');
    const r = await venderPase(memberId, {}, coach);
    expect([403, 404], r.body).toContain(r.statusCode);
    expect(await getDb().charge.count({ where: { memberId } })).toBe(0);
  });

  it('una membresía «de visita» vendida antes de 1.8 sigue abriendo hoy como membresía y vence esta noche', async () => {
    // Así quedaron las ya vendidas: una membresía ACTIVE de un día sobre un plan DAY_PASS.
    const plan = await crearPlan({ billingModel: 'PREPAID_PERIOD', name: 'Visita de antes' });
    const memberId = await nuevoSocio();
    const venta = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: gerencia },
      payload: { planId: plan, branchId: cen, saleKey: `venta-${randomUUID()}`, payment: spei() },
    });
    expect(venta.statusCode, venta.body).toBe(201);
    await getDb().plan.update({ where: { id: plan }, data: { billingModel: 'DAY_PASS' } });

    // Hoy entra, por su membresía (sin el aviso del pase).
    const hoy = (await previa(memberId)).json();
    expect(hoy).toMatchObject({ outcome: 'GRANTED' });
    expect(hoy.warning).not.toBe(AVISO_PASE_DEL_DIA);

    // Esta noche vence, sin cuota nueva (la regla de la fase 0, que se queda).
    const id = venta.json().membership.id as string;
    await getDb().membership.update({ where: { id }, data: { startDate: addDays(hoyNegocio(), -1), currentPeriodStart: addDays(hoyNegocio(), -1), currentPeriodEnd: hoyNegocio() } });
    const { rollPeriods } = await import('../src/modules/billing/billing.jobs.js');
    const { expireMemberships } = await import('../src/modules/memberships/membership.jobs.js');
    await rollPeriods(orgId);
    await expireMemberships(orgId);
    expect((await getDb().membership.findUniqueOrThrow({ where: { id } })).status).toBe('EXPIRED');
    expect(await getDb().charge.count({ where: { membershipId: id } })).toBe(1);

    // Y mañana lo que se le vende ya es un pase.
    const pase = await venderPase(memberId, { planId: plan });
    expect(pase.statusCode, pase.body).toBe(201);
  }, 120_000);
});
