import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ACCESS_POLICY_VERSION } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

const db = () => getDb();
const sello = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4);

const CONSENTS = [
  { consentType: 'PRIVACY_NOTICE', documentVersion: 'v1.0', granted: true },
  { consentType: 'HOUSE_RULES', documentVersion: 'v1.0', granted: true },
];


describe('control de acceso', () => {
  let app: FastifyInstance;
  let owner: string;
  let reception: string;
  let orgId: string;
  let branchId: string;
  let otraSede: string;
  let planId: string;        // MEN -> HOME_BRANCH
  let planMultiId: string;   // MULTI -> ALL_BRANCHES

  async function nuevoSocio(homeBranchId = branchId): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: owner },
      payload: {
        firstName: nombreUnico('Acc'), lastName: nombreUnico('Eso'),
        phoneE164: telefonoUnico(), homeBranchId, consents: CONSENTS,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  async function conMembresiaActiva(plan = planId): Promise<string> {
    const memberId = await nuevoSocio();
    const m = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships`, headers: { cookie: owner },
      payload: { reason: 'Fixture de prueba', planId: plan, soldAtBranchId: branchId },
    });
    expect(m.statusCode, m.body).toBe(201);
    await app.inject({
      method: 'POST', url: `/memberships/${m.json().id}/activate`, headers: { cookie: owner }, payload: { reason: 'Fixture de prueba' },
    });
    return memberId;
  }

  // Desde el panel solo se registra la entrada por el mostrador (5-08); donde
  // la sede usa biometría, con motivo.
  async function intentar(memberId: string | null, over: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST', url: '/access/attempts', headers: { cookie: reception },
      payload: { branchId, memberId, credentialKind: 'MANUAL', reason: 'Prueba de la puerta', ...over },
    });
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    reception = await loginAs(app, 'recepcion@demo.mx');

    const { demo, demoBranches } = await orgFixtures();
    orgId = demo.id;
    branchId = demoBranches.find((b) => b.code === 'CEN')!.id;
    otraSede = demoBranches.find((b) => b.code === 'NOR')!.id;
    // Dos planes con ALCANCE DISTINTO a propósito: el control por sucursal lo
    // decide el PLAN, y sin los dos casos la regla no queda demostrada.
    planId = (await db().plan.findFirstOrThrow({
      where: { organizationId: orgId, code: 'MEN' },
    })).id;
    planMultiId = (await db().plan.findFirstOrThrow({
      where: { organizationId: orgId, code: 'MULTI' },
    })).id;
  });

  afterAll(async () => { await app.close(); await closeDb(); });

  // ── Decisión ──────────────────────────────────────────────────────────────
  it('un socio con membresía activa ENTRA, y queda la asistencia', async () => {
    const memberId = await conMembresiaActiva();
    const res = await intentar(memberId);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().outcome).toBe('GRANTED');
    expect(res.json().attendanceId).toBeTruthy();
    expect(res.json().policyVersion).toBe(ACCESS_POLICY_VERSION);
  });

  /** ADR-032: un intento con QR ya no es una entrada válida de la API. */
  it('SUSPENDIDO por mora no es "sin membresía": se puede cobrar y abrir en el mostrador', async () => {
    const memberId = await conMembresiaActiva();
    await app.inject({
      method: 'POST', url: `/members/${memberId}/charges`, headers: { cookie: owner },
      payload: { chargeType: 'MANUAL_ADJUSTMENT', concept: 'Cuota vencida', subtotalCents: '65000', reason: 'Prueba de suspensión', branchId },
    });
    await db().membership.updateMany({ where: { memberId }, data: { status: 'SUSPENDED' } });
    const res = await intentar(memberId, { credentialKind: 'MANUAL', reason: 'Excepción de prueba' });
    expect(res.json()).toMatchObject({ outcome: 'DENIED', reason: 'MEMBERSHIP_SUSPENDED', overridable: true });
    expect(BigInt(res.json().outstandingCents)).toBeGreaterThan(0n);
  });

  it('un intento con QR se rechaza: el QR se retiró', async () => {
    const res = await app.inject({
      method: 'POST', url: '/access/attempts', headers: { cookie: reception },
      payload: { branchId, memberId: null, credentialKind: 'QR' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('una credencial desconocida NO entra y NO genera asistencia', async () => {
    const res = await intentar(null);
    expect(res.json().outcome).toBe('DENIED');
    expect(res.json().reason).toBe('MEMBER_UNKNOWN');
    expect(res.json().attendanceId).toBeNull();
  });

  /**
   * El caso que motivó todo. Antes del Sprint 7 había 15,073 membresías vivas
   * de socios archivados: sin esta regla, todas abrirían la puerta.
   */
  it('un socio ARCHIVADO no entra aunque su membresía figure activa', async () => {
    const memberId = await conMembresiaActiva();
    // Se archiva el socio SIN tocar la membresía, que es lo que pasaba.
    await db().member.update({
      where: { id: memberId },
      data: { status: 'ARCHIVED', deletedAt: new Date() },
    });

    const res = await intentar(memberId);
    expect(res.json().outcome).toBe('DENIED');
    expect(res.json().reason).toBe('MEMBER_ARCHIVED');
  });

  it('una decisión NEGADA también se registra: los rechazos son el dato valioso', async () => {
    const antes = await db().accessDecision.count({
      where: { organizationId: orgId, outcome: 'DENIED' },
    });
    await intentar(null);
    const despues = await db().accessDecision.count({
      where: { organizationId: orgId, outcome: 'DENIED' },
    });
    expect(despues).toBe(antes + 1);
  });

  it('anti-replay: dos pasos seguidos, el segundo se rechaza', async () => {
    const memberId = await conMembresiaActiva();
    const uno = await intentar(memberId);
    expect(uno.json().outcome).toBe('GRANTED');
    const dos = await intentar(memberId);
    expect(dos.json().outcome).toBe('DENIED');
    expect(dos.json().reason).toBe('DUPLICATE_SCAN');
  });

  it('una credencial revocada no entra', async () => {
    const memberId = await conMembresiaActiva();
    const res = await intentar(memberId, { credentialRevoked: true });
    expect(res.json().reason).toBe('CREDENTIAL_REVOKED');
  });

  // ── Decisión y asistencia son COSAS DISTINTAS ────────────────────────────
  it('hay más decisiones que asistencias: las negativas no producen entrada', async () => {
    const decisiones = await db().accessDecision.count({ where: { organizationId: orgId } });
    const asistencias = await db().attendanceEvent.count({ where: { organizationId: orgId } });
    expect(decisiones).toBeGreaterThan(asistencias);
  });

  it('toda asistencia tiene su decisión, y es PERMITIDA', async () => {
    const huerfanas = await db().$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "attendance_events" a
      LEFT JOIN "access_decisions" d ON d."id" = a."accessDecisionId"
      WHERE a."organizationId" = ${orgId}::uuid
        AND (d."id" IS NULL OR d."outcome" <> 'GRANTED')`;
    expect(huerfanas[0]!.n).toBe(0);
  });

  it('la base RECHAZA una negativa sin motivo', async () => {
    await expect(db().$executeRawUnsafe(`
      INSERT INTO "access_decisions" ("id","organizationId","branchId","outcome","credentialKind","policyVersion","businessDate")
      VALUES (gen_random_uuid(), '${orgId}', '${branchId}', 'DENIED', 'QR', '1.0.0', CURRENT_DATE)
    `)).rejects.toThrow(/decisions_denial_reason_check/);
  });

  it('la bitácora de acceso es append-only', async () => {
    const d = await db().accessDecision.findFirstOrThrow({ where: { organizationId: orgId } });
    await expect(db().accessDecision.delete({ where: { id: d.id } }))
      .rejects.toThrow(/permission denied|append-only/);
  });

  // ── Motivos agrupados ─────────────────────────────────────────────────────
  it('agrupa los motivos de rechazo, que es lo que alimenta la retención', async () => {
    const res = await app.inject({
      method: 'GET', url: '/access/denials?days=1', headers: { cookie: owner },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().total).toBeGreaterThan(0);
    expect(res.json().denials.some((d: { reason: string }) => d.reason === 'MEMBER_UNKNOWN')).toBe(true);
  });

  // ── MORA: la puerta se cierra, y dice cuánto ─────────────────────────────
  it('un socio EN MORA no entra', async () => {
    const memberId = await conMembresiaActiva();
    const m = await db().membership.findFirstOrThrow({ where: { memberId, organizationId: orgId } });
    await db().membership.update({ where: { id: m.id }, data: { status: 'PAST_DUE' } });

    const res = await intentar(memberId);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().outcome).toBe('DENIED');
    expect(res.json().reason).toBe('MEMBERSHIP_PAST_DUE');
  });

  it('el rechazo por mora dice CUÁNTO debe: la puerta es canal de cobranza', async () => {
    const memberId = await conMembresiaActiva();
    const m = await db().membership.findFirstOrThrow({ where: { memberId, organizationId: orgId } });
    await db().membership.update({ where: { id: m.id }, data: { status: 'PAST_DUE' } });

    await app.inject({
      method: 'POST', url: `/members/${memberId}/charges`, headers: { cookie: owner },
      payload: {
        chargeType: 'MANUAL_ADJUSTMENT', concept: 'Cuota vencida',
        subtotalCents: '65000', reason: 'Prueba de cobro en la puerta', branchId,
      },
    });

    const res = await intentar(memberId);
    expect(res.json().outcome).toBe('DENIED');
    expect(res.json().outstandingCents).toBe('65000');
    expect(res.json().overridable).toBe(true);
  });

  it('RECEPCIÓN puede levantar el rechazo, con nombre y motivo', async () => {
    const memberId = await conMembresiaActiva();
    const m = await db().membership.findFirstOrThrow({ where: { memberId, organizationId: orgId } });
    await db().membership.update({ where: { id: m.id }, data: { status: 'PAST_DUE' } });

    const rechazo = await intentar(memberId);
    const decisionId = rechazo.json().decisionId as string;

    const paso = await app.inject({
      method: 'POST', url: `/access/decisions/${decisionId}/grant`, headers: { cookie: reception },
      payload: { reason: 'Paga hoy al salir, lo autorizó el gerente' },
    });
    expect(paso.statusCode, paso.body).toBe(201);
    expect(paso.json().outcome).toBe('GRANTED');
    expect(paso.json().attendanceId).toBeTruthy();

    // El rechazo ORIGINAL sigue constando: la bitácora es append-only.
    const original = await db().accessDecision.findUniqueOrThrow({ where: { id: decisionId } });
    expect(original.outcome).toBe('DENIED');

    // Y la concesión queda con actor y motivo.
    const concesion = await db().accessDecision.findUniqueOrThrow({
      where: { id: paso.json().decisionId },
    });
    expect(concesion.overriddenByUserId).toBeTruthy();
    expect(concesion.overrideReason).toMatch(/gerente/);
  });

  it('una credencial REVOCADA no se levanta: no es trámite de mostrador', async () => {
    const memberId = await conMembresiaActiva();
    const rechazo = await intentar(memberId, { credentialRevoked: true });
    expect(rechazo.json().overridable).toBe(false);

    const paso = await app.inject({
      method: 'POST', url: `/access/decisions/${rechazo.json().decisionId}/grant`,
      headers: { cookie: reception },
      payload: { reason: 'Intento de levantar una revocación' },
    });
    expect(paso.statusCode).toBe(422);
  });

  it('un gimnasio PUEDE configurar que la mora sí entre', async () => {
    const memberId = await conMembresiaActiva();
    const m = await db().membership.findFirstOrThrow({ where: { memberId, organizationId: orgId } });
    await db().membership.update({ where: { id: m.id }, data: { status: 'PAST_DUE' } });

    await db().organization.update({
      where: { id: orgId },
      data: { settings: { access: { allowAccessWhilePastDue: true } } },
    });
    try {
      const res = await intentar(memberId);
      expect(res.json().outcome).toBe('GRANTED');
      expect(res.json().warning).toMatch(/pago pendiente/);
    } finally {
      await db().organization.update({ where: { id: orgId }, data: { settings: {} } });
    }
  });

  // ── Handshake de versión ──────────────────────────────────────────────────
  it('un gateway con la MISMA versión de política se reporta en orden', async () => {
    const g = await app.inject({
      method: 'POST', url: '/access/gateways', headers: { cookie: owner },
      payload: { branchId, code: `G${sello()}`.slice(0, 16), name: 'Torniquete de prueba' },
    });
    expect(g.statusCode, g.body).toBe(201);

    const hb = await app.inject({
      method: 'POST', url: `/access/gateways/${g.json().id}/heartbeat`, headers: { cookie: owner },
      payload: { policyVersion: ACCESS_POLICY_VERSION, status: 'ONLINE' },
    });
    expect(hb.statusCode, hb.body).toBe(200);
    expect(hb.json().policy.ok).toBe(true);
  });

  /**
   * En el monorepo esto no podía pasar: un import, una versión. Con dos
   * desplegables independientes, la divergencia ocurre SIN error visible.
   */
  it('un gateway con versión MAYOR distinta se marca como INCIDENTE', async () => {
    const g = await app.inject({
      method: 'POST', url: '/access/gateways', headers: { cookie: owner },
      payload: { branchId, code: `G${sello()}`.slice(0, 16), name: 'Torniquete desactualizado' },
    });

    const hb = await app.inject({
      method: 'POST', url: `/access/gateways/${g.json().id}/heartbeat`, headers: { cookie: owner },
      payload: { policyVersion: '0.9.0' },
    });
    expect(hb.json().policy.ok).toBe(false);
    expect(hb.json().policy.severity).toBe('BLOCK');
    expect(hb.json().policy.detail).toMatch(/decidiendo distinto/);

    // Y queda en la bitácora: es un incidente operativo, no un log.
    const bitacora = await db().auditLog.findFirst({
      where: { organizationId: orgId, action: 'access.policy.version_mismatch' },
      orderBy: { at: 'desc' },
    });
    expect(bitacora).toBeTruthy();
  });

  it('el monitor muestra qué gateways NO coinciden con la nube', async () => {
    const res = await app.inject({
      method: 'GET', url: `/access/gateways?branchId=${branchId}`, headers: { cookie: owner },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cloudPolicyVersion).toBe(ACCESS_POLICY_VERSION);
    const desalineados = res.json().gateways.filter((g: { policyMatches: boolean | null }) => g.policyMatches === false);
    expect(desalineados.length).toBeGreaterThan(0);
  });

  // ── Permisos y aislamiento ────────────────────────────────────────────────
  it('un gateway de OTRA organización devuelve 404', async () => {
    const { other } = await orgFixtures();
    const branch = await db().branch.findFirstOrThrow({ where: { organizationId: other.id } });
    const ajeno = await db().accessGateway.create({
      data: {
        id: crypto.randomUUID(), organizationId: other.id, branchId: branch.id,
        code: `AJE${sello()}`.slice(0, 16), name: 'Gateway ajeno',
      },
    });
    const res = await app.inject({
      method: 'POST', url: `/access/gateways/${ajeno.id}/heartbeat`, headers: { cookie: owner },
      payload: { policyVersion: ACCESS_POLICY_VERSION },
    });
    expect(res.statusCode).toBe(404);
  });

  it('el coach NO puede resolver accesos', async () => {
    const coach = await loginAs(app, 'coach@demo.mx');
    const res = await app.inject({
      method: 'POST', url: '/access/attempts', headers: { cookie: coach },
      payload: { branchId, memberId: null, credentialKind: 'MANUAL' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('otra sede: una membresía de alcance ALL entra en cualquiera', async () => {
    const memberId = await conMembresiaActiva(planMultiId);
    // Con el DUEÑO: recepción está acotada a su sucursal y no puede resolver
    // accesos en otra, que es justamente lo correcto.
    const res = await app.inject({
      method: 'POST', url: '/access/attempts', headers: { cookie: owner },
      payload: { branchId: otraSede, memberId, credentialKind: 'MANUAL', reason: 'Prueba de la puerta' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().outcome).toBe('GRANTED');
  });

  it('un plan de sede ÚNICA NO entra en otra sucursal', async () => {
    const memberId = await conMembresiaActiva(planId);   // MEN -> HOME_BRANCH
    const res = await app.inject({
      method: 'POST', url: '/access/attempts', headers: { cookie: owner },
      payload: { branchId: otraSede, memberId, credentialKind: 'MANUAL', reason: 'Prueba de la puerta' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().outcome).toBe('DENIED');
    // Motivo PROPIO: recepción tiene que poder ofrecerle el plan multi-sede.
    expect(res.json().reason).toBe('BRANCH_NOT_ALLOWED');
  });

  it('recepción NO puede resolver accesos de una sucursal que no cubre', async () => {
    const memberId = await conMembresiaActiva();
    const res = await intentar(memberId, { branchId: otraSede });
    expect(res.statusCode).toBe(403);
  });

  describe('entrada por el mostrador donde hay biometría (2026-10-09)', () => {
    it('es una excepción: sin motivo no se registra; con motivo queda quién, por qué y en la bitácora', async () => {
      const socio = await conMembresiaActiva();
      const pol = (await app.inject({ method: 'GET', url: `/access/manual-policy?branchId=${branchId}&memberId=${socio}`, headers: { cookie: reception } })).json();
      // `faceRequired` (D-06, bloque 3.3): la regla del rostro nace apagada.
      expect(pol).toEqual({ requiresReason: true, hasBiometric: false, faceRequired: false });

      const sin = await intentar(socio, { credentialKind: 'MANUAL', reason: undefined });
      expect(sin.statusCode).toBe(422);
      expect(sin.json().message).toMatch(/rostro o huella/);

      const con = await intentar(socio, { credentialKind: 'MANUAL', reason: 'El lector no respondió' });
      expect(con.statusCode, con.body).toBe(201);
      expect(con.json().outcome).toBe('GRANTED');

      const hist = (await app.inject({ method: 'GET', url: `/access/decisions?memberId=${socio}`, headers: { cookie: owner } })).json().decisions;
      expect(hist[0]).toMatchObject({ credentialKind: 'MANUAL', overrideReason: 'El lector no respondió' });
      expect(hist[0].recordedByName).toBeTruthy();

      const bit = (await app.inject({ method: 'GET', url: '/audit?limit=20', headers: { cookie: owner } })).json();
      const entradas = (bit.entries ?? bit.items ?? []).filter((e: { action: string }) => e.action === 'access.manual_entry');
      expect(entradas.some((e: { reason: string | null }) => e.reason === 'El lector no respondió')).toBe(true);
    });
  });

  describe('bloque 8: entradas sin dobles y paquetes', () => {
    async function paquete(pagar: boolean) {
      const memberId = await nuevoSocio();
      const plan = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie: owner } })).json()
        .find((p: { code: string }) => p.code === 'V10');
      const r = await app.inject({
        method: 'POST', url: `/members/${memberId}/visit-packs`, headers: { cookie: reception },
        payload: {
          planId: plan.id, soldAtBranchId: branchId, saleKey: crypto.randomUUID(),
          payment: pagar ? { method: 'SPEI_TRANSFER', externalRef: `SPEI-${crypto.randomUUID().slice(0, 8)}` } : null,
        },
      });
      expect(r.statusCode, r.body).toBe(201);
      return { memberId, packId: r.json().id as string, venta: r.json() };
    }

    it('un paquete sin pagar NO da acceso; pagado, sí (BE2-03)', async () => {
      const sinPagar = await paquete(false);
      expect(sinPagar.venta.status).toBe('PENDING_PAYMENT');
      expect((await intentar(sinPagar.memberId, { credentialKind: 'MANUAL', reason: 'Excepción de prueba' })).json().outcome).toBe('DENIED');
      const pagado = await paquete(true);
      expect(pagado.venta.status).toBe('ACTIVE');
      expect((await intentar(pagado.memberId, { credentialKind: 'MANUAL', reason: 'Excepción de prueba' })).json().outcome).toBe('GRANTED');
    });

    it('vender el paquete con la misma clave de venta no crea otro (UXA-18)', async () => {
      const memberId = await nuevoSocio();
      const plan = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie: owner } })).json()
        .find((p: { code: string }) => p.code === 'V10');
      const saleKey = crypto.randomUUID();
      const vender = () => app.inject({
        method: 'POST', url: `/members/${memberId}/visit-packs`, headers: { cookie: reception },
        payload: { planId: plan.id, soldAtBranchId: branchId, saleKey, payment: null },
      });
      const a = (await vender()).json();
      const b = (await vender()).json();
      expect(b.id).toBe(a.id);
      expect(await getDb().visitPack.count({ where: { memberId } })).toBe(1);
    });

    it('el resumen de acceso dice lo mismo que la puerta: suspendido NO, paquete con sus visitas (UXA-04, UXA-03)', async () => {
      const suspendido = await conMembresiaActiva();
      await getDb().membership.updateMany({ where: { memberId: suspendido }, data: { status: 'SUSPENDED' } });
      const conPaquete = (await paquete(true)).memberId;
      const r = await app.inject({ method: 'GET', url: `/members/access-summary?ids=${suspendido},${conPaquete}`, headers: { cookie: reception } });
      expect(r.statusCode, r.body).toBe(200);
      const [a, b] = r.json().members;
      expect(a.membership.status).toBe('SUSPENDED');
      expect(a.canEnter).toBe(false);
      expect((await intentar(suspendido, { credentialKind: 'MANUAL', reason: 'Excepción de prueba' })).json().outcome).toBe('DENIED');
      expect(b.pack).toMatchObject({ status: 'ACTIVE', visitsLeft: 10 });
      expect(b.canEnter).toBe(true);
    });

    it('doce consumos simultáneos no pasan de cero (BE2-04)', async () => {
      const { packId } = await paquete(true);
      const intentos = await Promise.all(Array.from({ length: 12 }, () => app.inject({
        method: 'POST', url: `/visit-packs/${packId}/consume`, headers: { cookie: reception }, payload: { branchId },
      })));
      expect(intentos.filter((r) => r.statusCode === 201)).toHaveLength(10);
      const pack = await getDb().visitPack.findUniqueOrThrow({ where: { id: packId } });
      expect(pack.status).toBe('EXHAUSTED');
      const saldo = await getDb().visitLedgerEntry.aggregate({ where: { visitPackId: packId }, _sum: { delta: true } });
      expect(saldo._sum.delta).toBe(0);
    });

    it('el mismo intento enviado dos veces es UNA entrada, y en paralelo tampoco duplica (UXA-01)', async () => {
      const { memberId } = await paquete(true);
      const requestKey = crypto.randomUUID();
      const [a, b] = await Promise.all([
        intentar(memberId, { credentialKind: 'MANUAL', reason: 'Excepción de prueba', requestKey }),
        intentar(memberId, { credentialKind: 'MANUAL', reason: 'Excepción de prueba', requestKey }),
      ]);
      expect(a.json().outcome).toBe('GRANTED');
      expect(b.json().outcome).toBe('GRANTED');
      expect(b.json().decisionId).toBe(a.json().decisionId);
      expect(await getDb().attendanceEvent.count({ where: { memberId } })).toBe(1);
      const consumos = await getDb().visitLedgerEntry.count({ where: { entryType: 'CONSUME', visitPack: { memberId } } });
      expect(consumos).toBe(1);
    });
  });
});
