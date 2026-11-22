import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { addDays, uuidv7 } from '@gymflow/core';
import {
  PortalAttendance, PortalAttendanceSummary, PortalMe, PortalNotices, PortalReceipt, PortalSessions, PortalStatement, diferenciasConElContrato,
} from '@gymflow/core/contracts';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { MemberNoticeRepository } from '../src/modules/members/index.js';
import { contarDias, cuandoSeActivo } from '../src/modules/portal/portal.service.js';
import { prioridadDe } from '../src/modules/portal/notice-priority.js';

/**
 * FASE 2 · BLOQUE 2.8 · PORTAL ÚTIL SIN PROCESADOR (auditoría 8).
 *
 * - «¿Puedo entrar hoy?» lo contesta LA PUERTA (27-04): `/portal/me` dice lo
 *   mismo que la vista previa del mostrador, con membresía, suspendido, con
 *   pase del día (también de otra sede) y con paquete de visitas (25-04).
 * - Las visitas se cuentan por días de operación (27-05, 25-16).
 * - Los avisos van por prioridad y lo resuelto deja de estar arriba (25-11).
 * - El socio abre el comprobante de SUS pagos y de nadie más (25-14).
 * - La hora tope de la sesión de ese teléfono viene de la API (pendiente de 1.12).
 */
describe('portal útil sin procesador (2.8)', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let recepcion: string;
  let orgId: string;
  let cen: string;
  let nor: string;
  let mensual: string;
  let visita: string;

  const db = () => getDb();
  const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const spei = () => ({ method: 'SPEI_TRANSFER', externalRef: `SPEI-${randomUUID().slice(0, 8)}` });
  /** «Hoy» del gimnasio: de noche en México la fecha de UTC ya es mañana. */
  const hoyNegocio = () => new Date(`${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })}T00:00:00.000Z`);
  const dia = (d: Date) => d.toISOString().slice(0, 10);

  async function nuevoSocio(sede = cen): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Portal'), lastName: nombreUnico('Util'), phoneE164: telefonoUnico(), homeBranchId: sede, force: true, consents: CONSENTIMIENTOS },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  async function portalDe(memberId: string): Promise<{ cookie: string; expiresAt: string }> {
    const inv = await app.inject({ method: 'POST', url: `/members/${memberId}/portal-invite`, headers: { cookie: gerencia } });
    expect(inv.statusCode, inv.body).toBe(201);
    const act = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: inv.json().code } });
    expect(act.statusCode, act.body).toBe(201);
    return { cookie: `gf_portal=${act.cookies.find((c) => c.name === 'gf_portal')!.value}`, expiresAt: act.json().expiresAt };
  }

  async function venderMensual(memberId: string): Promise<string> {
    const venta = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: gerencia },
      payload: { planId: mensual, branchId: cen, saleKey: `venta-${randomUUID()}`, payment: spei() },
    });
    expect(venta.statusCode, venta.body).toBe(201);
    return venta.json().membership.id as string;
  }

  const venderPase = (memberId: string, branchId = cen) => app.inject({
    method: 'POST', url: `/members/${memberId}/day-passes`, headers: { cookie: gerencia },
    payload: { planId: visita, branchId, saleKey: `pase-${randomUUID()}`, payment: spei() },
  });

  /** Lo que dice el mostrador antes de registrar la entrada: la referencia contra la que se compara el portal. */
  async function puerta(memberId: string, branchId = cen): Promise<{ outcome: string; reason: string | null; wouldConsumeVisit: boolean }> {
    const r = await app.inject({ method: 'POST', url: '/access/attempts/preview', headers: { cookie: gerencia }, payload: { branchId, memberId } });
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  }

  async function yo(cookie: string): Promise<PortalMe> {
    const r = await get('/portal/me', cookie);
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(PortalMe, r.json())).toEqual([]);
    return r.json() as PortalMe;
  }

  /** El teléfono y el mostrador dicen lo mismo. */
  async function igualQueLaPuerta(memberId: string, cookie: string, branchId = cen): Promise<PortalMe> {
    const [me, p] = [await yo(cookie), await puerta(memberId, branchId)];
    expect({ canEnter: me.canEnter, accessReason: me.accessReason, accessUsesVisit: me.accessUsesVisit })
      .toEqual({ canEnter: p.outcome === 'GRANTED', accessReason: p.reason, accessUsesVisit: p.wouldConsumeVisit });
    return me;
  }

  async function cargo(memberId: string, subtotalCents: string, concept: string) {
    const res = await app.inject({
      method: 'POST', url: `/members/${memberId}/charges`, headers: { cookie: gerencia },
      payload: { chargeType: 'MANUAL_ADJUSTMENT', concept, subtotalCents, reason: 'Prueba del portal útil', dueDate: dia(addDays(hoyNegocio(), -3)) },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string };
  }

  async function pagar(memberId: string, amountCents: string, chargeId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: gerencia },
      payload: { idempotencyKey: randomUUID(), method: 'SPEI_TRANSFER', amountCents, branchId: cen, externalRef: `RASTREO-${randomUUID().slice(0, 8)}`, targetChargeIds: [chargeId] },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().payment?.id ?? res.json().id) as string;
  }

  /** Una entrada ya registrada ese día de operación (la decisión y su asistencia), sin pasar por la puerta. */
  async function entrada(memberId: string, businessDate: Date, at: Date, branchId = cen) {
    const decision = uuidv7();
    await db().accessDecision.create({
      data: { id: decision, organizationId: orgId, branchId, memberId, outcome: 'GRANTED', credentialKind: 'MANUAL', policyVersion: 'prueba-2.8', businessDate, at },
    });
    await db().attendanceEvent.create({ data: { id: uuidv7(), organizationId: orgId, branchId, memberId, accessDecisionId: decision, businessDate, at } });
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
    nor = f.demoBranches.find((b) => b.code === 'NOR')!.id;
    mensual = (await db().plan.findFirstOrThrow({ where: { organizationId: orgId, code: 'MEN' } })).id;
    const plan = await app.inject({
      method: 'POST', url: '/plans', headers: { cookie: gerencia },
      payload: {
        code: `U${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`, name: 'Visita suelta', billingModel: 'DAY_PASS', durationUnit: 'DAY', durationValue: 1,
        priceCents: '15000', signupFeeCents: '0', branchAccessScope: 'HOME_BRANCH', reason: 'Plan de la prueba del bloque 2.8',
      },
    });
    expect(plan.statusCode, plan.body).toBe(201);
    visita = plan.json().id as string;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  // ── «¿Puedo entrar hoy?» ──────────────────────────────────────────────────

  it('sin plan: la puerta dice que no, y el portal lo repite con su sede y lo que el gimnasio ofrece', async () => {
    const socio = await nuevoSocio();
    const { cookie } = await portalDe(socio);
    const me = await igualQueLaPuerta(socio, cookie);
    expect(me).toMatchObject({ canEnter: false, accessReason: 'NO_MEMBERSHIP', visitPack: null, dayPass: null, planEnded: null });
    expect(me.accessBranchName).toBe(me.homeBranchName);
    expect(me.features).toEqual({ classes: me.modules.includes('classes'), routines: me.modules.includes('training'), onlinePayments: me.onlinePayments });
    // Lo del socio no se guarda en cachés de paso.
    expect((await get('/portal/me', cookie)).headers['cache-control']).toBe('no-store');
    expect((await get('/portal/statement', cookie)).headers['cache-control']).toBe('no-store');
  });

  it('con membresía entra; suspendida no, y con el pase de hoy vuelve a entrar: siempre lo que dice el mostrador', async () => {
    const socio = await nuevoSocio();
    const { cookie } = await portalDe(socio);
    const membresia = await venderMensual(socio);
    expect(await igualQueLaPuerta(socio, cookie)).toMatchObject({ canEnter: true, accessReason: null, membershipStatus: 'ACTIVE', accessUsesVisit: false });

    await db().membership.update({ where: { id: membresia }, data: { status: 'SUSPENDED' } });
    expect(await igualQueLaPuerta(socio, cookie)).toMatchObject({ canEnter: false, accessReason: 'MEMBERSHIP_SUSPENDED', membershipStatus: 'SUSPENDED', dayPass: null });

    const pase = await venderPase(socio);
    expect(pase.statusCode, pase.body).toBe(201);
    const me = await igualQueLaPuerta(socio, cookie);
    expect(me).toMatchObject({ canEnter: true, accessReason: null, membershipStatus: 'SUSPENDED', dayPass: { validOn: dia(hoyNegocio()) } });
    expect(me.dayPass!.branchName).toBe(me.homeBranchName);
  });

  it('el pase del día de OTRA sede: el portal dice que entra y en cuál (en la suya la puerta le diría que no)', async () => {
    const socio = await nuevoSocio(cen);
    const { cookie } = await portalDe(socio);
    const pase = await venderPase(socio, nor);
    expect(pase.statusCode, pase.body).toBe(201);
    const norte = await db().branch.findUniqueOrThrow({ where: { id: nor } });
    const me = await yo(cookie);
    expect(me).toMatchObject({ canEnter: true, accessReason: null, accessBranchName: norte.name, dayPass: { branchName: norte.name } });
    expect((await puerta(socio, nor)).outcome).toBe('GRANTED');
    expect((await puerta(socio, cen)).outcome).toBe('DENIED');
  });

  it('paquete de visitas: sin pagar no entra y lo dice; pagado entra, gasta una visita y se ve cuántas quedan', async () => {
    const v10 = await db().plan.findFirstOrThrow({ where: { organizationId: orgId, code: 'V10' } });
    const vender = async (memberId: string, paga: boolean) => {
      const r = await app.inject({
        method: 'POST', url: `/members/${memberId}/visit-packs`, headers: { cookie: recepcion },
        payload: { planId: v10.id, soldAtBranchId: cen, saleKey: randomUUID(), payment: paga ? spei() : null },
      });
      expect(r.statusCode, r.body).toBe(201);
    };
    const sinPagar = await nuevoSocio();
    await vender(sinPagar, false);
    const a = await igualQueLaPuerta(sinPagar, (await portalDe(sinPagar)).cookie);
    expect(a).toMatchObject({ canEnter: false, accessReason: 'VISIT_PACK_UNPAID', visitPack: { status: 'PENDING_PAYMENT' } });

    const pagado = await nuevoSocio();
    await vender(pagado, true);
    const b = await igualQueLaPuerta(pagado, (await portalDe(pagado)).cookie);
    expect(b).toMatchObject({ canEnter: true, accessReason: null, accessUsesVisit: true, membershipStatus: null });
    expect(b.visitPack).toMatchObject({ status: 'ACTIVE', visitsLeft: b.visitPack!.visitsPurchased });
    expect(b.visitPack!.visitsPurchased).toBeGreaterThan(0);
  });

  it('a quien se le terminó el plan se le dice que terminó y hasta cuándo pagó, no que «no tiene membresía»', async () => {
    const socio = await nuevoSocio();
    const { cookie } = await portalDe(socio);
    const membresia = await venderMensual(socio);
    const pagadoHasta = (await yo(cookie)).paidThrough;
    expect(pagadoHasta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await db().membership.update({ where: { id: membresia }, data: { status: 'EXPIRED' } });
    const me = await igualQueLaPuerta(socio, cookie);
    expect(me).toMatchObject({ canEnter: false, membershipStatus: null, planName: null });
    expect(me.planEnded).toMatchObject({ how: 'EXPIRED', paidThrough: pagadoHasta, periodEnd: pagadoHasta });
    expect(me.planEnded!.planName).toBeTruthy();
  });

  // ── Visitas por días ──────────────────────────────────────────────────────

  it('las visitas se cuentan por días de operación: dos entradas el mismo día son una visita', async () => {
    const socio = await nuevoSocio();
    const { cookie } = await portalDe(socio);
    const hoy = hoyNegocio();
    const ayer = addDays(hoy, -1);
    const viejo = addDays(hoy, -40);
    await entrada(socio, hoy, new Date(Date.now() - 60_000));
    await entrada(socio, hoy, new Date(Date.now() - 30_000));
    // Entró casi a medianoche: cuenta en el día que la puerta guardó, no en el que caiga con otra zona.
    await entrada(socio, ayer, new Date(hoy.getTime() + 5.9 * 3_600_000));
    await entrada(socio, viejo, new Date(viejo.getTime() + 18 * 3_600_000));

    const resumen = await get('/portal/attendance/summary', cookie);
    expect(resumen.statusCode, resumen.body).toBe(200);
    expect(diferenciasConElContrato(PortalAttendanceSummary, resumen.json())).toEqual([]);
    const delMes = [hoy, ayer].filter((d) => d.getUTCMonth() === hoy.getUTCMonth()).length;
    expect(resumen.json()).toEqual({ today: dia(hoy), daysThisMonth: delMes, daysLast28: 2 });

    const lista = await get('/portal/attendance', cookie);
    expect(lista.statusCode, lista.body).toBe(200);
    expect(diferenciasConElContrato(PortalAttendance, lista.json())).toEqual([]);
    const a = lista.json() as PortalAttendance;
    expect(a.days).toEqual([dia(hoy), dia(ayer), dia(viejo)]);
    expect(a.visits).toHaveLength(4);
    expect(a.visits.map((v) => v.day)).toEqual([dia(hoy), dia(hoy), dia(ayer), dia(viejo)]);
    expect(a.visits[0]!.branchName).toBeTruthy();
  });

  it('`contarDias` no cuenta dos veces el mismo día ni lo que quedó fuera del mes o de las cuatro semanas', () => {
    const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
    const hoy = d('2026-03-02');
    expect(contarDias([d('2026-03-02'), d('2026-03-02'), d('2026-03-01'), d('2026-02-28'), d('2026-02-03'), d('2026-02-02'), d('2026-01-15')], hoy))
      .toEqual({ daysThisMonth: 2, daysLast28: 4 });
    expect(contarDias([], hoy)).toEqual({ daysThisMonth: 0, daysLast28: 0 });
    // Un día «de mañana» (otra sede, otra zona) no cuenta todavía.
    expect(contarDias([d('2026-03-03')], hoy)).toEqual({ daysThisMonth: 0, daysLast28: 0 });
  });

  // ── Avisos ────────────────────────────────────────────────────────────────

  it('los avisos van por prioridad: lo que hoy debe arriba; al pagar, baja con los demás', async () => {
    const socio = await nuevoSocio();
    const { cookie } = await portalDe(socio); // deja «Tu portal se activó», más nuevo que el de dinero
    const debe = await cargo(socio, '65000', 'Mensualidad de prueba');
    const avisos = new MemberNoticeRepository(orgId);
    await avisos.emit({ memberId: socio, kind: 'PAYMENT_OVERDUE', dedupeKey: `PAYMENT_OVERDUE:${debe.id}`, title: 'Tienes un pago vencido', body: 'Pásate a recepción.' });
    await db().memberNotice.updateMany({ where: { memberId: socio, kind: 'PAYMENT_OVERDUE' }, data: { createdAt: new Date(Date.now() - 5 * 86_400_000) } });

    const antes = await get('/portal/notices', cookie);
    expect(antes.statusCode, antes.body).toBe(200);
    expect(diferenciasConElContrato(PortalNotices, antes.json())).toEqual([]);
    const a = antes.json() as PortalNotices;
    expect(a.notices.map((n) => [n.kind, n.priority])).toEqual([['PAYMENT_OVERDUE', 'RESOLVE'], ['NEW_DEVICE', 'INFO']]);
    expect(a.unread).toBe(2);
    // El teléfono nuevo dice la fecha, no «hoy» (25-11).
    expect(a.notices[1]!.body).toMatch(/^El \d{1,2} de [a-z]+ a las \d{2}:\d{2}\. /);

    // Se leen de a uno: solo el que se vio.
    const leido = await app.inject({ method: 'POST', url: '/portal/notices/read', headers: { cookie }, payload: { ids: [a.notices[0]!.id] } });
    expect(leido.json()).toEqual({ read: 1 });
    expect((await get('/portal/notices', cookie)).json().unread).toBe(1);

    await pagar(socio, '65000', debe.id);
    const despues = (await get('/portal/notices', cookie)).json() as PortalNotices;
    expect(despues.notices.map((n) => [n.kind, n.priority])).toEqual([['NEW_DEVICE', 'INFO'], ['PAYMENT_OVERDUE', 'INFO']]);
  });

  it('la prioridad de cada tipo: dinero y acceso solo mientras sigan pendientes; la clase, mientras sea reciente', () => {
    const ahora = new Date('2026-11-21T18:00:00.000Z');
    const hace = (dias: number) => new Date(ahora.getTime() - dias * 86_400_000);
    const debe = { debe: true, sinAcceso: true, ahora };
    const alCorriente = { debe: false, sinAcceso: false, ahora };
    for (const kind of ['PAYMENT_DUE_SOON', 'PAYMENT_OVERDUE', 'MEMBERSHIP_SUSPENDED']) {
      expect(prioridadDe({ kind, createdAt: hace(9) }, debe), kind).toBe('RESOLVE');
      expect(prioridadDe({ kind, createdAt: hace(1) }, alCorriente), kind).toBe('INFO');
    }
    expect(prioridadDe({ kind: 'CLASS_TOMORROW', createdAt: hace(1) }, debe)).toBe('CLASS');
    expect(prioridadDe({ kind: 'CLASS_TOMORROW', createdAt: hace(4) }, debe)).toBe('INFO');
    for (const kind of ['NEW_DEVICE', 'PRIVACY_NOTICE_UPDATED', 'PRIVACY_REQUEST_RESOLVED', 'INTAKE_APPROVED', 'UNO_NUEVO']) {
      expect(prioridadDe({ kind, createdAt: hace(0) }, debe), kind).toBe('INFO');
    }
    expect(cuandoSeActivo(new Date('2026-11-18T04:31:00.000Z'), 'America/Mexico_City')).toBe('El 17 de noviembre a las 22:31');
  });

  // ── Sesión de este teléfono ───────────────────────────────────────────────

  it('`/portal/sessions` dice hasta cuándo queda abierto ESTE teléfono, lo haya guardado o no', async () => {
    const socio = await nuevoSocio();
    const uno = await portalDe(socio);
    const dos = await portalDe(socio);
    const r = await get('/portal/sessions', uno.cookie);
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(PortalSessions, r.json())).toEqual([]);
    expect(r.json()).toMatchObject({ active: 2, current: { expiresAt: uno.expiresAt, idleDays: 7 } });
    expect((await get('/portal/sessions', dos.cookie)).json().current.expiresAt).toBe(dos.expiresAt);
  });

  // ── Comprobante ───────────────────────────────────────────────────────────

  it('el socio abre el comprobante de SUS pagos: con folio, a qué se aplicó y nunca el de otro', async () => {
    const socio = await nuevoSocio();
    const { cookie } = await portalDe(socio);
    const c = await cargo(socio, '65000', 'Mensualidad de prueba');
    const pago = await pagar(socio, '65000', c.id);

    const cuenta = await get('/portal/statement', cookie);
    expect(diferenciasConElContrato(PortalStatement, cuenta.json())).toEqual([]);
    expect((cuenta.json() as PortalStatement).payments).toMatchObject([{ id: pago, hasReceipt: true }]);

    const r = await get(`/portal/payments/${pago}/receipt`, cookie);
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(PortalReceipt, r.json())).toEqual([]);
    const me = await yo(cookie);
    expect(r.json()).toMatchObject({
      gymName: me.gymName, branchName: me.homeBranchName, memberName: me.fullName, memberCode: me.memberCode,
      method: 'SPEI_TRANSFER', amountCents: '65000', unappliedCents: '0', reversal: false,
      lines: [{ concept: 'Mensualidad de prueba', amountCents: '65000' }],
    });
    expect(r.headers['cache-control']).toBe('no-store');

    // Otro socio del mismo gimnasio, y uno de otro gimnasio: 404, sin decir si existe.
    const otro = await nuevoSocio();
    expect((await get(`/portal/payments/${pago}/receipt`, (await portalDe(otro)).cookie)).statusCode).toBe(404);
    const { otherBranches } = await orgFixtures();
    const otroGimnasio = await loginAs(app, 'gerencia@otro.mx');
    const alta = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: otroGimnasio },
      payload: { firstName: nombreUnico('Ajeno'), lastName: nombreUnico('Portal'), phoneE164: telefonoUnico(), homeBranchId: otherBranches[0]!.id, force: true, consents: CONSENTIMIENTOS },
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const invitacion = await app.inject({ method: 'POST', url: `/members/${alta.json().id}/portal-invite`, headers: { cookie: otroGimnasio } });
    expect(invitacion.statusCode, invitacion.body).toBe(201);
    const act = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invitacion.json().code } });
    const deOtroGimnasio = `gf_portal=${act.cookies.find((x) => x.name === 'gf_portal')!.value}`;
    expect((await get(`/portal/payments/${pago}/receipt`, deOtroGimnasio)).statusCode).toBe(404);
    // Sin sesión, 401 con su motivo; un id que no es un pago, 404.
    expect((await app.inject({ method: 'GET', url: `/portal/payments/${pago}/receipt` })).statusCode).toBe(401);
    expect((await get(`/portal/payments/${randomUUID()}/receipt`, cookie)).statusCode).toBe(404);
  });
});
