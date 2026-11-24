import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, sedeDesechable, archivarSede, CONSENTIMIENTOS,
} from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { activarSinCobro, altaSinCobro } from './membresia-de-prueba.js';

const db = () => getDb();
const sello = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4);

describe('pantalla de excepción y retención', () => {
  let app: FastifyInstance;
  let owner: string;
  let reception: string;
  let orgId: string;
  let branchId: string;
  let planId: string;
  let turno: string;

  async function socioEnMoraConDeuda(): Promise<{ memberId: string; decisionId: string }> {
    const alta = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: owner },
      payload: {
        firstName: nombreUnico('Exc'), lastName: nombreUnico('Epcion'),
        phoneE164: telefonoUnico(), homeBranchId: branchId, consents: CONSENTIMIENTOS,
      },
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const memberId = alta.json().id as string;

    const mem = await altaSinCobro(app, owner, memberId, { reason: 'Fixture de prueba', planId, soldAtBranchId: branchId });
    await activarSinCobro(app, owner, mem.json().id);
    await db().membership.update({ where: { id: mem.json().id }, data: { status: 'PAST_DUE' } });

    await app.inject({
      method: 'POST', url: `/members/${memberId}/charges`, headers: { cookie: owner },
      payload: {
        chargeType: 'MANUAL_ADJUSTMENT', concept: 'Cuota vencida',
        subtotalCents: '65000', reason: 'Prueba de pantalla de excepción', branchId,
      },
    });

    const intento = await app.inject({
      method: 'POST', url: '/access/attempts', headers: { cookie: reception },
      payload: { branchId, memberId, credentialKind: 'MANUAL', reason: 'Prueba de la puerta' },
    });
    expect(intento.json().outcome).toBe('DENIED');
    return { memberId, decisionId: intento.json().decisionId as string };
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    reception = await loginAs(app, 'recepcion@demo.mx');

    const { demo, demoBranches } = await orgFixtures();
    orgId = demo.id;
    branchId = demoBranches.find((b) => b.code === 'CEN')!.id;
    planId = (await db().plan.findFirstOrThrow({ where: { organizationId: orgId, code: 'MEN' } })).id;

    const caja = await app.inject({
      method: 'POST', url: '/cash-registers', headers: { cookie: owner },
      payload: { branchId, code: `E${sello()}`.slice(0, 8), name: `Caja excepción ${sello()}` },
    });
    const abierta = await app.inject({
      method: 'POST', url: '/cash-sessions', headers: { cookie: owner },
      payload: { cashRegisterId: caja.json().id, openingFloatCents: '0' },
    });
    turno = abierta.json().id as string;
  });

  afterAll(async () => {
    const rep = await app.inject({ method: 'GET', url: `/cash-sessions/${turno}`, headers: { cookie: owner } });
    if (rep.statusCode === 200 && rep.json().session.status === 'OPEN') {
      await app.inject({
        method: 'POST', url: `/cash-sessions/${turno}/close`, headers: { cookie: owner },
        payload: { countedCashCents: rep.json().expectedCashCents },
      });
    }
    await app.close();
    await closeDb();
  });

  // ── La pantalla ───────────────────────────────────────────────────────────
  it('devuelve TODO lo que recepción necesita en UNA llamada', async () => {
    const { decisionId } = await socioEnMoraConDeuda();
    const res = await app.inject({
      method: 'GET', url: `/access/decisions/${decisionId}/exception`, headers: { cookie: reception },
    });
    expect(res.statusCode, res.body).toBe(200);
    const v = res.json();

    expect(v.decision.reason).toBe('MEMBERSHIP_PAST_DUE');
    expect(v.member.fullName).toBeTruthy();
    expect(v.member.memberCode).toBeTruthy();
    // La ANTIGÜEDAD es el dato que cambia la decisión.
    expect(typeof v.member.tenureDays).toBe('number');
    expect(v.outstandingCents).toBe('65000');
    expect(v.outstandingLabel).toMatch(/650/);
    expect(Array.isArray(v.recentVisits)).toBe(true);
  });

  it('ofrece TRES acciones, con COBRAR como principal ante una deuda', async () => {
    const { decisionId } = await socioEnMoraConDeuda();
    const res = await app.inject({
      method: 'GET', url: `/access/decisions/${decisionId}/exception`, headers: { cookie: reception },
    });
    const opciones = res.json().options as Array<{ action: string; primary: boolean; requiresReason: boolean }>;

    expect(opciones).toHaveLength(3);
    expect(opciones.find((o) => o.primary)!.action).toBe('COLLECT_AND_OPEN');
    // Dejar pasar SIEMPRE exige motivo: es lo que lo convierte en dato.
    expect(opciones.find((o) => o.action === 'GRANT_ONCE')!.requiresReason).toBe(true);
  });

  it('un rechazo NO levantable ofrece una sola salida', async () => {
    const alta = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: owner },
      payload: {
        firstName: nombreUnico('Rev'), lastName: nombreUnico('Ocada'),
        phoneE164: telefonoUnico(), homeBranchId: branchId, consents: CONSENTIMIENTOS,
      },
    });
    const intento = await app.inject({
      method: 'POST', url: '/access/attempts', headers: { cookie: reception },
      payload: { branchId, memberId: alta.json().id, credentialKind: 'MANUAL', reason: 'Prueba de la puerta', credentialRevoked: true },
    });
    const res = await app.inject({
      method: 'GET', url: `/access/decisions/${intento.json().decisionId}/exception`,
      headers: { cookie: reception },
    });
    expect(res.json().options).toHaveLength(1);
    expect(res.json().options[0].action).toBe('REFUSE');
  });

  // ── Cobrar y abrir ────────────────────────────────────────────────────────
  it('COBRAR Y ABRIR: el socio paga y entra, en una sola acción', async () => {
    const { memberId, decisionId } = await socioEnMoraConDeuda();

    const res = await app.inject({
      method: 'POST', url: `/access/decisions/${decisionId}/collect`, headers: { cookie: reception },
      payload: { method: 'CASH', amountCents: '65000', cashSessionId: turno },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().paymentId).toBeTruthy();
    expect(res.json().folio).toMatch(/^CEN-/);
    expect(res.json().attendanceId).toBeTruthy();

    // La deuda quedó saldada…
    const st = await app.inject({
      method: 'GET', url: `/members/${memberId}/statement`, headers: { cookie: owner },
    });
    expect(st.json().outstandingCents).toBe('0');

    // …y el rechazo ORIGINAL sigue constando: la bitácora es append-only.
    const original = await db().accessDecision.findUniqueOrThrow({ where: { id: decisionId } });
    expect(original.outcome).toBe('DENIED');
  });

  it('el cobro deja constancia de POR QUÉ se abrió', async () => {
    const { decisionId } = await socioEnMoraConDeuda();
    const res = await app.inject({
      method: 'POST', url: `/access/decisions/${decisionId}/collect`, headers: { cookie: reception },
      payload: { method: 'CASH', amountCents: '65000', cashSessionId: turno },
    });
    const concesion = await db().accessDecision.findUniqueOrThrow({
      where: { id: res.json().decisionId },
    });
    expect(concesion.overriddenByUserId).toBeTruthy();
    expect(concesion.overrideReason).toMatch(/Pagó en el mostrador/);
  });

  /**
   * El orden importa: al revés, un fallo del cobro dejaría al socio dentro y
   * la deuda fuera — se regalaría el acceso y se perdería el cobro a la vez.
   */
  it('si el cobro FALLA, no se abre la puerta', async () => {
    const { memberId, decisionId } = await socioEnMoraConDeuda();
    const antes = await db().attendanceEvent.count({ where: { organizationId: orgId, memberId } });

    const res = await app.inject({
      method: 'POST', url: `/access/decisions/${decisionId}/collect`, headers: { cookie: reception },
      payload: { method: 'CASH', amountCents: '0', cashSessionId: turno },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await db().attendanceEvent.count({ where: { organizationId: orgId, memberId } })).toBe(antes);
  });

  // ── Monitor en vivo ───────────────────────────────────────────────────────
  it('el monitor resuelve los NOMBRES: se mira de lejos', async () => {
    await socioEnMoraConDeuda();
    const res = await app.inject({
      method: 'GET', url: `/access/monitor?branchId=${branchId}&limit=10`, headers: { cookie: reception },
    });
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json().decisions;
    expect(d.length).toBeGreaterThan(0);
    expect(d.some((x: { memberName: string | null }) => x.memberName !== null)).toBe(true);
  });

  // ── Alertas de retención ──────────────────────────────────────────────────
  it('clasifica el padrón y ordena la lista de contacto', async () => {
    const res = await app.inject({
      method: 'GET', url: `/retention/alerts?branchId=${branchId}&limit=200`, headers: { cookie: owner },
    });
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();

    expect(r.counts).toHaveProperty('ONBOARDING_AT_RISK');
    expect(r.counts).toHaveProperty('SLIPPING');
    expect(Array.isArray(r.outreach)).toBe(true);

    // La lista SOLO trae a quien hay que contactar.
    for (const m of r.outreach) {
      expect(['ONBOARDING_AT_RISK', 'SLIPPING', 'DORMANT']).toContain(m.state);
    }
  });

  it('un socio nuevo que no ha venido aparece como ONBOARDING_AT_RISK', async () => {
    // Su sucursal de casa es una sede propia de la prueba: la lista de contacto
    // se ordena por prioridad y se recorta a 500 (el tope de la ruta), y en una
    // base de pruebas compartida los socios que dejan otras corridas la llenan
    // antes de llegar al de esta prueba (el 2026-11-19 eran 641 en Centro y el
    // nuevo quedaba en el lugar 640, bien clasificado pero fuera del recorte).
    const sede = await sedeDesechable(orgId, 'Sede de prueba de retención');
    try {
      const alta = await app.inject({
        method: 'POST', url: '/members', headers: { cookie: owner },
        payload: {
          firstName: nombreUnico('Nue'), lastName: nombreUnico('Vito'),
          phoneE164: telefonoUnico(), homeBranchId: sede.id, consents: CONSENTIMIENTOS,
        },
      });
      expect(alta.statusCode, alta.body).toBe(201);
      const memberId = alta.json().id as string;
      const mem = await altaSinCobro(app, owner, memberId, { reason: 'Fixture de prueba', planId, soldAtBranchId: branchId });
      expect(mem.statusCode, mem.body).toBe(201);
      const activa = await activarSinCobro(app, owner, mem.json().id);
      expect(activa.statusCode, activa.body).toBe(200);
      // Se inscribió hace 30 días y no ha venido nunca.
      await db().member.update({
        where: { id: memberId },
        data: { joinedAt: new Date(Date.now() - 30 * 86_400_000) },
      });

      const res = await app.inject({
        method: 'GET', url: `/retention/alerts?branchId=${sede.id}&limit=500`, headers: { cookie: owner },
      });
      const m = res.json().outreach.find((x: { memberId: string }) => x.memberId === memberId);
      expect(m).toBeTruthy();
      expect(m.state).toBe('ONBOARDING_AT_RISK');
      expect(m.detail).toMatch(/hábito/);
    } finally { await archivarSede(sede.id); }
  });

  it('recepción NO ve la lista de retención de toda la organización', async () => {
    const coach = await loginAs(app, 'coach@demo.mx');
    const res = await app.inject({
      method: 'GET', url: '/retention/alerts', headers: { cookie: coach },
    });
    expect(res.statusCode).toBe(403);
  });

  it('una decisión de OTRA organización devuelve 404', async () => {
    const { other } = await orgFixtures();
    const branch = await db().branch.findFirstOrThrow({ where: { organizationId: other.id } });
    const ajena = await db().accessDecision.create({
      data: {
        id: crypto.randomUUID(), organizationId: other.id, branchId: branch.id,
        outcome: 'DENIED', denialReason: 'MEMBERSHIP_PAST_DUE', credentialKind: 'QR',
        policyVersion: '2.0.0', businessDate: new Date(),
      },
    });
    const res = await app.inject({
      method: 'GET', url: `/access/decisions/${ajena.id}/exception`, headers: { cookie: owner },
    });
    expect(res.statusCode).toBe(404);
  });
});
