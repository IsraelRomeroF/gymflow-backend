import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  AccessAttemptPreview, AccessAttemptResult, AccessException, CollectAndOpenResult, FaceAccessResult,
  FaceEngineStatus, ManualEntryPolicy, OpenCashSessionsLite, diferenciasConElContrato,
} from '@gymflow/core/contracts';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { ConsentDocumentRepository } from '../src/modules/members/index.js';

/**
 * PIEZAS DEL MOSTRADOR (auditoría 8, fase 1.4).
 *
 * - `POST /access/attempts/preview`: lo que pasaría, sin registrar nada (5-03).
 * - El motivo de la entrada por el mostrador se exige DESPUÉS del veredicto:
 *   un rechazo se registra sin motivo; solo el verde lo pide.
 * - «Cobrar y abrir» sobre el NETO de su saldo a favor y con veredicto (4-09, 4-18).
 * - «Renovar y abrir»: la entrada tras la venta resuelve el rechazo, una vez (5-25).
 * - `GET /cash-sessions/open-lite`: a qué cajón entra el cobro, sin llevar Caja (7-03).
 * - La Estación avisa «debe volver a firmar» (`debeVolverAFirmar` en `/access/face`).
 * - Las rutas de la entrada responden con la forma exacta de su contrato.
 */
const sello = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4);
const vector = (semilla: number) => { const v = Array.from({ length: 512 }, (_, i) => Math.sin((i + 1) * semilla)); const n = Math.hypot(...v); return v.map((x) => x / n); };
const cuadro = (letra: string) => letra + 'x'.repeat(200);
const SAL = 20 + Math.random() * 10;
const TOKEN = 'token-del-motor-en-las-pruebas-0123456789abcdef';

describe('piezas del mostrador (1.4)', () => {
  let app: FastifyInstance;
  let motor: Server;
  let gerencia: string;
  let recepcion: string;
  let orgId: string;
  let cen: string;
  let planId: string;
  let turno: string;

  const spei = () => ({ method: 'SPEI_TRANSFER', externalRef: `SPEI-${randomUUID().slice(0, 8)}` });

  async function nuevoSocio(): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Pieza'), lastName: nombreUnico('Mostrador'), phoneE164: telefonoUnico(), homeBranchId: cen, force: true, consents: CONSENTIMIENTOS },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  async function conMembresia(estado: 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED'): Promise<string> {
    const memberId = await nuevoSocio();
    const mem = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships`, headers: { cookie: gerencia },
      payload: { reason: 'Fixture de prueba', planId, soldAtBranchId: cen },
    });
    expect(mem.statusCode, mem.body).toBe(201);
    await app.inject({ method: 'POST', url: `/memberships/${mem.json().id}/activate`, headers: { cookie: gerencia }, payload: { reason: 'Fixture de prueba' } });
    if (estado !== 'ACTIVE') await getDb().membership.update({ where: { id: mem.json().id }, data: { status: estado } });
    return memberId;
  }

  /** En mora, con $650 de deuda y, si se pide, saldo a favor nacido ANTES del cargo (no se aplicó solo). */
  async function enMora(creditoCents: string | null = null): Promise<string> {
    const memberId = await conMembresia('PAST_DUE');
    if (creditoCents) {
      const abono = await app.inject({
        method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: gerencia },
        payload: { idempotencyKey: `abono-${randomUUID()}`, amountCents: creditoCents, branchId: cen, ...spei() },
      });
      expect(abono.statusCode, abono.body).toBe(201);
    }
    const cargo = await app.inject({
      method: 'POST', url: `/members/${memberId}/charges`, headers: { cookie: gerencia },
      payload: { chargeType: 'MANUAL_ADJUSTMENT', concept: 'Cuota vencida', subtotalCents: '65000', reason: 'Prueba de las piezas del mostrador', branchId: cen },
    });
    expect(cargo.statusCode, cargo.body).toBe(201);
    return memberId;
  }

  const intentar = (memberId: string, extra: Record<string, unknown> = {}) => app.inject({
    method: 'POST', url: '/access/attempts', headers: { cookie: recepcion },
    payload: { branchId: cen, memberId, credentialKind: 'MANUAL', ...extra },
  });
  const previa = (memberId: string, cookie = recepcion) => app.inject({
    method: 'POST', url: '/access/attempts/preview', headers: { cookie }, payload: { branchId: cen, memberId },
  });

  beforeAll(async () => {
    motor = createServer((req, res) => {
      let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', model_loaded: true }));
        const { frames } = JSON.parse(body) as { frames: string[] };
        if (frames[0]![0] === 'X') return res.end(JSON.stringify({ ok: false, error: 'No se detectó ningún rostro', liveness_checked: false }));
        res.end(JSON.stringify({ ok: true, embedding: vector(SAL), liveness_checked: true, liveness_ok: true }));
      });
    }).listen(0);
    app = await makeApp({ FACE_SIDECAR_URL: `http://127.0.0.1:${(motor.address() as { port: number }).port}`, FACE_SIDECAR_TOKEN: TOKEN });
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
    planId = (await getDb().plan.findFirstOrThrow({ where: { organizationId: orgId, code: 'MEN' } })).id;

    const caja = await app.inject({
      method: 'POST', url: '/cash-registers', headers: { cookie: gerencia },
      payload: { branchId: cen, code: `P${sello()}`.slice(0, 8), name: `Caja piezas ${sello()}` },
    });
    expect(caja.statusCode, caja.body).toBe(201);
    const abierta = await app.inject({
      method: 'POST', url: '/cash-sessions', headers: { cookie: gerencia },
      payload: { cashRegisterId: caja.json().id, openingFloatCents: '0' },
    });
    expect(abierta.statusCode, abierta.body).toBe(201);
    turno = abierta.json().id as string;
  });

  afterAll(async () => {
    const rep = await app.inject({ method: 'GET', url: `/cash-sessions/${turno}`, headers: { cookie: gerencia } });
    if (rep.statusCode === 200 && rep.json().session.status === 'OPEN') {
      await app.inject({ method: 'POST', url: `/cash-sessions/${turno}/close`, headers: { cookie: gerencia }, payload: { countedCashCents: rep.json().expectedCashCents } });
    }
    await app.close();
    motor.close();
    await closeDb();
  });

  // ── Lo que pasaría ────────────────────────────────────────────────────────
  describe('POST /access/attempts/preview', () => {
    it('dice lo que pasaría con la forma del contrato y NO registra nada', async () => {
      const memberId = await conMembresia('ACTIVE');
      const r = await previa(memberId);
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(AccessAttemptPreview, r.json())).toEqual([]);
      expect(r.json()).toMatchObject({ outcome: 'GRANTED', reason: null, outstandingCents: null, creditCents: '0' });
      // La misma política que `GET /access/manual-policy`, en la misma llamada.
      const pol = await app.inject({ method: 'GET', url: `/access/manual-policy?branchId=${cen}&memberId=${memberId}`, headers: { cookie: recepcion } });
      expect(diferenciasConElContrato(ManualEntryPolicy, pol.json())).toEqual([]);
      expect(r.json().policy).toEqual(pol.json());

      expect(await getDb().accessDecision.count({ where: { memberId } })).toBe(0);
      expect(await getDb().attendanceEvent.count({ where: { memberId } })).toBe(0);
      expect(await getDb().auditLog.count({ where: { organizationId: orgId, action: 'access.manual_entry', afterState: { path: ['memberId'], equals: memberId } } })).toBe(0);
    });

    it('con adeudo trae lo que debe, el mínimo y su saldo a favor; sin registrar el rechazo', async () => {
      const memberId = await enMora('20000');
      const r = await previa(memberId);
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(AccessAttemptPreview, r.json())).toEqual([]);
      expect(r.json()).toMatchObject({ outcome: 'DENIED', reason: 'MEMBERSHIP_PAST_DUE', overridable: true, outstandingCents: '65000', creditCents: '20000' });
      expect(await getDb().accessDecision.count({ where: { memberId } })).toBe(0);
    });

    it('exige el permiso de la puerta en ESA sucursal y un socio en el cuerpo', async () => {
      const memberId = await conMembresia('ACTIVE');
      const nor = (await orgFixtures()).demoBranches.find((b) => b.id !== cen)!.id;
      const otraSede = await app.inject({ method: 'POST', url: '/access/attempts/preview', headers: { cookie: recepcion }, payload: { branchId: nor, memberId } });
      expect(otraSede.statusCode).toBe(403);
      const sinSocio = await app.inject({ method: 'POST', url: '/access/attempts/preview', headers: { cookie: recepcion }, payload: { branchId: cen } });
      expect(sinSocio.statusCode).toBe(422);
      expect((await app.inject({ method: 'POST', url: '/access/attempts/preview', payload: { branchId: cen, memberId } })).statusCode).toBe(401);
    });
  });

  // ── El veredicto va antes que el motivo (5-03) ────────────────────────────
  describe('el motivo de la entrada por el mostrador se pide después del veredicto', () => {
    it('un rechazo se registra SIN motivo; el verde sigue exigiéndolo donde hay biometría', async () => {
      const moroso = await enMora();
      const rojo = await intentar(moroso);
      expect(rojo.statusCode, rojo.body).toBe(201);
      expect(diferenciasConElContrato(AccessAttemptResult, rojo.json())).toEqual([]);
      expect(rojo.json()).toMatchObject({ outcome: 'DENIED', reason: 'MEMBERSHIP_PAST_DUE', outstandingCents: '65000' });
      // Sin motivo no hay excepción que asentar: el rechazo queda sin «quién lo dejó pasar».
      const fila = await getDb().accessDecision.findUniqueOrThrow({ where: { id: rojo.json().decisionId } });
      expect(fila.overrideReason).toBeNull();
      expect(fila.overriddenByUserId).toBeNull();

      const alCorriente = await conMembresia('ACTIVE');
      const sinMotivo = await intentar(alCorriente);
      expect(sinMotivo.statusCode).toBe(422);
      expect(await getDb().accessDecision.count({ where: { memberId: alCorriente } })).toBe(0);
      const conMotivo = await intentar(alCorriente, { reason: 'La cámara no lo reconoció' });
      expect(conMotivo.statusCode, conMotivo.body).toBe(201);
      expect(diferenciasConElContrato(AccessAttemptResult, conMotivo.json())).toEqual([]);
      expect(conMotivo.json().outcome).toBe('GRANTED');
    });
  });

  // ── Cobrar y abrir: neto y veredicto (4-09, 4-18, 5-11) ───────────────────
  describe('cobrar y abrir', () => {
    it('la pantalla de excepción trae el saldo a favor y el mínimo, con la forma del contrato', async () => {
      const memberId = await enMora('20000');
      const rojo = await intentar(memberId);
      const v = await app.inject({ method: 'GET', url: `/access/decisions/${rojo.json().decisionId}/exception`, headers: { cookie: recepcion } });
      expect(v.statusCode, v.body).toBe(200);
      expect(diferenciasConElContrato(AccessException, v.json())).toEqual([]);
      expect(v.json()).toMatchObject({ outstandingCents: '65000', creditCents: '20000', resolution: null });
    });

    it('cobra el NETO de su saldo a favor, en la caja, y dice si ya entra', async () => {
      const memberId = await enMora('20000');
      const decisionId = (await intentar(memberId)).json().decisionId as string;
      const cobrar = (amountCents: string) => app.inject({
        method: 'POST', url: `/access/decisions/${decisionId}/collect`, headers: { cookie: recepcion },
        payload: { method: 'CASH', amountCents, cashSessionId: turno },
      });

      // El bruto ya no se cobra: $200 los cubre lo que tiene a favor.
      const bruto = await cobrar('65000');
      expect(bruto.statusCode).toBe(422);
      expect(bruto.json().message).toMatch(/Debe \$450\.00 \(ya descontados \$200\.00 que tiene a favor\)/);
      expect(await getDb().payment.count({ where: { memberId, method: 'CASH' } })).toBe(0);

      const neto = await cobrar('45000');
      expect(neto.statusCode, neto.body).toBe(201);
      expect(diferenciasConElContrato(CollectAndOpenResult, neto.json())).toEqual([]);
      expect(neto.json()).toMatchObject({ creditAppliedCents: '20000', toEnterCents: null });
      expect(neto.json().folio).toBeTruthy();
      expect(neto.json().attendanceId).toBeTruthy();
      // El veredicto: la membresía que importa y si mañana entra sin que nadie le abra.
      expect(neto.json().membership).toMatchObject({ canEnter: expect.any(Boolean) });

      // El efectivo entró a la caja elegida y la cuenta quedó en ceros, sin crédito colgado.
      const pago = await getDb().payment.findUniqueOrThrow({ where: { id: neto.json().paymentId } });
      expect(pago.cashSessionId).toBe(turno);
      const cuenta = (await app.inject({ method: 'GET', url: `/members/${memberId}/statement`, headers: { cookie: gerencia } })).json();
      expect(cuenta).toMatchObject({ outstandingCents: '0', creditCents: '0' });

      // Resuelto una vez: la pantalla lo dice y otro cobro responde 409 sin tocar dinero.
      const vista = (await app.inject({ method: 'GET', url: `/access/decisions/${decisionId}/exception`, headers: { cookie: recepcion } })).json();
      expect(diferenciasConElContrato(AccessException, vista)).toEqual([]);
      expect(vista.resolution?.decisionId).toBe(neto.json().decisionId);
      expect((await cobrar('45000')).statusCode).toBe(409);
    });

    it('si su saldo a favor cubre todo lo que debe, la puerta no cobra: lo dice', async () => {
      const memberId = await enMora('65000');
      const decisionId = (await intentar(memberId)).json().decisionId as string;
      const r = await app.inject({
        method: 'POST', url: `/access/decisions/${decisionId}/collect`, headers: { cookie: recepcion },
        payload: { method: 'CASH', amountCents: '100', cashSessionId: turno },
      });
      expect(r.statusCode).toBe(422);
      expect(r.json().message).toMatch(/saldo a favor .* cubre lo que debe/);
    });
  });

  // ── Renovar y abrir (5-25) ────────────────────────────────────────────────
  describe('renovar y abrir', () => {
    it('la entrada tras la venta resuelve el rechazo «sin membresía», una sola vez', async () => {
      const memberId = await nuevoSocio();
      const rojo = await intentar(memberId);
      expect(rojo.statusCode, rojo.body).toBe(201);
      expect(rojo.json()).toMatchObject({ outcome: 'DENIED', reason: 'NO_MEMBERSHIP' });
      const rechazo = rojo.json().decisionId as string;

      // Ligar sin haber vendido nada no abre: la puerta decide de verdad y el rechazo sigue pendiente.
      const sinVenta = await intentar(memberId, { reason: 'Renovó en el mostrador', resolvesDecisionId: rechazo });
      expect(sinVenta.json().outcome).toBe('DENIED');
      expect(await getDb().accessDecision.count({ where: { resolvesDecisionId: rechazo } })).toBe(0);

      const venta = await app.inject({
        method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: gerencia },
        payload: { planId, branchId: cen, payment: spei() },
      });
      expect(venta.statusCode, venta.body).toBe(201);

      const verde = await intentar(memberId, { reason: 'Renovó en el mostrador', resolvesDecisionId: rechazo });
      expect(verde.statusCode, verde.body).toBe(201);
      expect(verde.json().outcome).toBe('GRANTED');
      expect(verde.json().attendanceId).toBeTruthy();
      const fila = await getDb().accessDecision.findUniqueOrThrow({ where: { id: verde.json().decisionId } });
      expect(fila.resolvesDecisionId).toBe(rechazo);

      // El monitor lo pinta resuelto; y no se resuelve dos veces.
      const historial = (await app.inject({ method: 'GET', url: `/access/decisions?memberId=${memberId}`, headers: { cookie: gerencia } })).json().decisions as Array<{ id: string; resolvedByDecisionId: string | null }>;
      expect(historial.find((d) => d.id === rechazo)?.resolvedByDecisionId).toBe(verde.json().decisionId);
      const otra = await intentar(memberId, { reason: 'Renovó en el mostrador', resolvesDecisionId: rechazo });
      expect([201, 409]).toContain(otra.statusCode);
      // (Doble paso en 8 s → DENIED sin ligar; pasado ese tiempo → 409.) En ningún caso hay dos resoluciones.
      expect(await getDb().accessDecision.count({ where: { resolvesDecisionId: rechazo } })).toBe(1);
    });

    it('no liga el rechazo de otro socio', async () => {
      const uno = await nuevoSocio();
      const rechazo = (await intentar(uno)).json().decisionId as string;
      const otro = await conMembresia('ACTIVE');
      const r = await intentar(otro, { reason: 'Renovó en el mostrador', resolvesDecisionId: rechazo });
      expect(r.statusCode).toBe(422);
      expect(await getDb().accessDecision.count({ where: { memberId: otro } })).toBe(0);
    });
  });

  // ── A qué cajón entra el cobro (7-03) ─────────────────────────────────────
  describe('GET /cash-sessions/open-lite', () => {
    it('lista las cajas abiertas de la sede con nombres y nada del corte', async () => {
      const r = await app.inject({ method: 'GET', url: `/cash-sessions/open-lite?branchId=${cen}`, headers: { cookie: recepcion } });
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(OpenCashSessionsLite, r.json())).toEqual([]);
      const mia = (r.json().sessions as Array<Record<string, unknown>>).find((s) => s.id === turno)!;
      expect(mia).toBeTruthy();
      expect(Object.keys(mia).sort()).toEqual(['cashRegisterId', 'id', 'openedAt', 'openedByName', 'openedByUserId', 'registerCode', 'registerName']);
      expect(mia.registerName).toMatch(/^Caja piezas/);
      expect(mia.openedByName).toBeTruthy();
    });

    it('quien no cobra no la ve; ni de una sede que no es la suya', async () => {
      const coach = await loginAs(app, 'coach@demo.mx');
      expect((await app.inject({ method: 'GET', url: `/cash-sessions/open-lite?branchId=${cen}`, headers: { cookie: coach } })).statusCode).toBe(403);
      const nor = (await orgFixtures()).demoBranches.find((b) => b.id !== cen)!.id;
      expect((await app.inject({ method: 'GET', url: `/cash-sessions/open-lite?branchId=${nor}`, headers: { cookie: recepcion } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/cash-sessions/open-lite', headers: { cookie: recepcion } })).statusCode).toBe(422);
    });
  });

  // ── La Estación avisa «debe volver a firmar» ──────────────────────────────
  describe('POST /access/face', () => {
    it('avisa si firmó un texto biométrico anterior al vigente, sin cambiar si entra', async () => {
      const textos = new ConsentDocumentRepository(orgId);
      const publicar = async () => {
        const version = `prueba-${randomUUID().slice(0, 8)}`;
        const doc = await textos.create({ consentType: 'BIOMETRIC', version, title: 'Consentimiento biométrico de prueba', bodyText: `Texto biométrico de prueba ${version}: plantilla cifrada en el servidor del gimnasio.` });
        await textos.publish(doc.id, null);
        return version;
      };
      if (!await textos.findPublished('BIOMETRIC')) await publicar();

      const estado = await app.inject({ method: 'GET', url: '/access/face/status', headers: { cookie: gerencia } });
      expect(diferenciasConElContrato(FaceEngineStatus, estado.json())).toEqual([]);

      const memberId = await conMembresia('ACTIVE');
      const alta = await app.inject({
        method: 'POST', url: `/members/${memberId}/biometric-enrollments/face`, headers: { cookie: gerencia },
        payload: { branchId: cen, frames: [cuadro('A'), cuadro('A'), cuadro('A')], reto: 'turn_left', reason: 'Alta en recepción' },
      });
      expect(alta.statusCode, alta.body).toBe(201);
      const leer = async () => {
        const r = await app.inject({ method: 'POST', url: '/access/face', headers: { cookie: gerencia }, payload: { branchId: cen, frames: [cuadro('A')], reto: 'turn_left' } });
        expect(r.statusCode, r.body).toBe(200);
        expect(diferenciasConElContrato(FaceAccessResult, r.json())).toEqual([]);
        return r.json() as { reconocido: boolean; memberId?: string; outcome?: string; reason?: string | null; debeVolverAFirmar?: boolean };
      };

      const alDia = await leer();
      expect(alDia).toMatchObject({ reconocido: true, memberId, outcome: 'GRANTED', debeVolverAFirmar: false });

      const nueva = await publicar();
      const porFirmar = await leer();
      // Sigue reconocido y la puerta decide igual (doble paso en 8 s o entra): solo cambia el aviso.
      expect(porFirmar).toMatchObject({ reconocido: true, memberId, debeVolverAFirmar: true });
      expect(porFirmar.outcome === 'GRANTED' || porFirmar.reason === 'DUPLICATE_SCAN').toBe(true);

      const firma = await app.inject({ method: 'POST', url: `/members/${memberId}/consents/renew-biometric`, headers: { cookie: recepcion }, payload: { documentVersion: nueva } });
      expect(firma.statusCode, firma.body).toBe(201);
      expect((await leer()).debeVolverAFirmar).toBe(false);

      const nadie = await app.inject({ method: 'POST', url: '/access/face', headers: { cookie: gerencia }, payload: { branchId: cen, frames: [cuadro('X')], reto: 'turn_left' } });
      expect(diferenciasConElContrato(FaceAccessResult, nadie.json())).toEqual([]);
      expect(nadie.json()).toMatchObject({ reconocido: false, sinRostro: true });

      // Se deja sin rostro para no estorbar a otras pruebas de la misma sede.
      await app.inject({ method: 'POST', url: `/biometric-enrollments/${alta.json().id}/revoke`, headers: { cookie: gerencia }, payload: { reason: 'Fin de la prueba' } });
    });
  });
});
