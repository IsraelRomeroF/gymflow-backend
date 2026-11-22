import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { hkdfSync, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, aprobacion, sedeDesechable, archivarSede, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { systemContext } from '../src/platform/jobs/types.js';
import { registeredRoutes } from '../src/platform/http/registry.js';
import { encryptSecret } from '../src/platform/crypto.js';
import { loadEnv } from '../src/platform/env.js';
import { EnrollmentService } from '../src/modules/access/index.js';
import { FaceEngine } from '../src/modules/access/face.engine.js';

/**
 * FASE 0 · BLOQUE 0.7 (auditoría 8): datos y rostros.
 *
 *  · 2-01: el alta pregunta «¿desde cuándo viene?» y la gerencia lo corrige con motivo.
 *  · 6-07: la cámara no compara a quien se dio de baja (D-32).
 *  · A1-N1: anonimizar BORRA la plantilla, y la limpieza única borra las que quedaron.
 *  · 5-24: el consumo de visita se liga a la asistencia.
 *  · 5-10: un rechazo se resuelve una sola vez.
 *
 * El motor facial se simula: el cuadro `S<semilla>|…` da el rostro de esa
 * semilla (una por socio y por corrida, para que dos plantillas nunca se
 * parezcan) y `X…`, ninguno.
 */
const vector = (semilla: number) => { const v = Array.from({ length: 512 }, (_, i) => Math.sin((i + 1) * semilla)); const n = Math.hypot(...v); return v.map((x) => x / n); };
const cuadros = (semilla: number) => Array.from({ length: 3 }, () => `S${semilla}|${'x'.repeat(200)}`);
let siguiente = 3 + Math.random();
const semillaNueva = () => { siguiente += 0.731; return Number(siguiente.toFixed(4)); };
const diaEnCdmx = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

describe('fase 0 · datos y rostros (0.7)', () => {
  let app: FastifyInstance; let motor: Server;
  let gerencia: string; let gerente: string; let recepcion: string;
  let orgId: string; let cen: string; let planId: string; let gerenciaId: string;

  beforeAll(async () => {
    motor = createServer((req, res) => {
      let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', model_loaded: true }));
        const { frames } = JSON.parse(body) as { frames: string[] };
        // `N<semilla>|`: el rostro "opuesto" (parecido −1 con el de esa semilla).
        const m = /^([SN])([0-9.]+)\|/.exec(frames[0] ?? '');
        if (!m) return res.end(JSON.stringify({ ok: false, error: 'No se detectó ningún rostro', liveness_checked: false }));
        const v = vector(Number(m[2]));
        res.end(JSON.stringify({ ok: true, embedding: m[1] === 'N' ? v.map((x) => -x) : v, liveness_checked: true, liveness_ok: true }));
      });
    }).listen(0);
    const port = (motor.address() as { port: number }).port;
    app = await makeApp({ FACE_SIDECAR_URL: `http://127.0.0.1:${port}` }); await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    gerente = await loginAs(app, 'gerente@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
    planId = (await getDb().plan.findFirstOrThrow({ where: { organizationId: orgId, code: 'MEN' } })).id;
    gerenciaId = (await getDb().user.findFirstOrThrow({ where: { email: 'gerencia@demo.mx' } })).id;
  });
  afterAll(async () => { await app.close(); motor.close(); await closeDb(); });

  async function alta(cookie = gerencia, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST', url: '/members', headers: { cookie },
      payload: { firstName: nombreUnico('Dat'), lastName: nombreUnico('Ros'), phoneE164: telefonoUnico(), homeBranchId: cen, consents: CONSENTIMIENTOS, ...extra },
    });
  }
  async function socio(): Promise<string> {
    const r = await alta();
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }
  /** Socio con su rostro de la cámara en Centro. */
  async function conRostro(): Promise<{ memberId: string; enrollmentId: string; semilla: number }> {
    const memberId = await socio();
    const semilla = semillaNueva();
    const r = await app.inject({ method: 'POST', url: `/members/${memberId}/biometric-enrollments/face`, headers: { cookie: gerencia },
      payload: { branchId: cen, frames: cuadros(semilla), reto: 'turn_left', reason: 'Alta en recepción' } });
    expect(r.statusCode, r.body).toBe(201);
    return { memberId, enrollmentId: r.json().id as string, semilla };
  }
  const leer = (semilla: number) => app.inject({ method: 'POST', url: '/access/face', headers: { cookie: gerencia }, payload: { branchId: cen, frames: cuadros(semilla), reto: 'turn_left' } });
  const darDeBaja = (memberId: string) => app.inject({ method: 'POST', url: `/members/${memberId}/archive`, headers: { cookie: gerencia }, payload: { reason: 'Pidió su baja' } });
  const plantillasDe = (memberId: string) => getDb().faceTemplate.count({ where: { memberId } });

  // ── 2-01 · «¿Desde cuándo viene?» ────────────────────────────────────────
  describe('antigüedad en el alta (2-01)', () => {
    it('el alta guarda el día declarado a mediodía de CDMX; sin él, es hoy', async () => {
      const con = await alta(recepcion, { joinedAt: '2024-03-01' });
      expect(con.statusCode, con.body).toBe(201);
      expect(con.json().joinedAt).toBe('2024-03-01T18:00:00.000Z');

      const sin = await alta(recepcion);
      expect(sin.statusCode, sin.body).toBe(201);
      expect(Math.abs(new Date(sin.json().joinedAt).getTime() - Date.now())).toBeLessThan(60_000);

      // Hoy también se puede declarar: nunca queda en el futuro.
      const hoy = await alta(recepcion, { joinedAt: diaEnCdmx() });
      expect(hoy.statusCode, hoy.body).toBe(201);
      expect(new Date(hoy.json().joinedAt).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('una fecha futura o un año mal tecleado se rechazan en su campo, sin crear al socio', async () => {
      const pasadoManana = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      const futuro = await alta(recepcion, { joinedAt: pasadoManana });
      expect(futuro.statusCode).toBe(422);
      expect(futuro.json().issues[0]).toMatchObject({ path: 'joinedAt' });
      expect(futuro.json().issues[0].message).toMatch(/futura/);

      const viejo = await alta(recepcion, { joinedAt: '1924-05-01' });
      expect(viejo.statusCode).toBe(422);
      expect(viejo.json().issues[0]).toMatchObject({ path: 'joinedAt' });

      expect((await alta(recepcion, { joinedAt: '01/03/2024' })).statusCode).toBe(422);
    });

    it('la gerencia la corrige con motivo y la bitácora guarda el antes y el después; recepción no', async () => {
      const r = await alta(gerencia, { joinedAt: '2025-06-10' });
      const id = r.json().id as string;

      const sinMotivo = await app.inject({ method: 'PATCH', url: `/members/${id}`, headers: { cookie: gerencia }, payload: { joinedAt: '2023-01-15' } });
      expect(sinMotivo.statusCode).toBe(422);
      expect(sinMotivo.json().issues[0]).toMatchObject({ path: 'reason' });

      const ok = await app.inject({ method: 'PATCH', url: `/members/${id}`, headers: { cookie: gerencia },
        payload: { joinedAt: '2023-01-15', reason: 'Venía desde 2023; se capturó mal al darlo de alta' } });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().joinedAt).toBe('2023-01-15T18:00:00.000Z');

      const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'member.update', resourceId: id }, orderBy: { at: 'desc' } });
      expect(asiento.reason).toMatch(/2023/);
      expect(asiento.beforeState).toMatchObject({ joinedAt: '2025-06-10' });
      expect(asiento.afterState).toMatchObject({ joinedAt: '2023-01-15', changedFields: ['joinedAt'] });

      // Guardar sin cambiarla no pide motivo: el formulario manda lo que ya había.
      const igual = await app.inject({ method: 'PATCH', url: `/members/${id}`, headers: { cookie: gerencia }, payload: { joinedAt: '2023-01-15', firstName: 'Corregido' } });
      expect(igual.statusCode, igual.body).toBe(200);

      const futuro = await app.inject({ method: 'PATCH', url: `/members/${id}`, headers: { cookie: gerencia },
        payload: { joinedAt: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), reason: 'Prueba de fecha futura' } });
      expect(futuro.statusCode).toBe(422);

      const deRecepcion = await app.inject({ method: 'PATCH', url: `/members/${id}`, headers: { cookie: recepcion }, payload: { joinedAt: '2020-01-01', reason: 'Recepción no corrige antigüedad' } });
      expect(deRecepcion.statusCode).toBe(403);
    });
  });

  // ── Encargo del bloque 0.8 en un archivo de este bloque (28-04) ─────────
  describe('anotar el seguimiento de Retención es escribir (28-04)', () => {
    it('POST /members/:id/follow-ups pide retention:followup:write, no el permiso de ver reportes', async () => {
      const ruta = registeredRoutes().find((r) => r.method === 'POST' && r.url === '/members/:id/follow-ups');
      expect(ruta?.security).toMatchObject({ kind: 'permission', permission: 'retention:followup:write' });
      const r = await app.inject({ method: 'POST', url: `/members/${await socio()}/follow-ups`, headers: { cookie: gerencia }, payload: { channel: 'CALL', outcome: 'COMING_BACK' } });
      expect(r.statusCode, r.body).toBe(201);
    });
  });

  // ── 6-07 · La cámara no compara a dados de baja ──────────────────────────
  describe('la cámara y quien se da de baja (6-07, D-32)', () => {
    it('el dado de baja deja de reconocerse en el acto; si regresa, vuelve a reconocerse sin enrolarlo otra vez', async () => {
      const { memberId, enrollmentId, semilla } = await conRostro();
      expect((await leer(semilla)).json()).toMatchObject({ reconocido: true, memberId });

      expect((await darDeBaja(memberId)).statusCode).toBeLessThan(300);
      const deBaja = (await leer(semilla)).json();
      expect(deBaja.reconocido).toBe(false);
      // La plantilla no se borra con la baja: D-32 da 30 días por si regresa.
      expect(await plantillasDe(memberId)).toBe(1);

      const vuelve = await app.inject({ method: 'POST', url: `/members/${memberId}/reactivate`, headers: { cookie: gerencia }, payload: { reason: 'Regresó al gimnasio' } });
      expect(vuelve.statusCode, vuelve.body).toBe(200);
      expect((await leer(semilla)).json()).toMatchObject({ reconocido: true, memberId });

      await app.inject({ method: 'POST', url: `/biometric-enrollments/${enrollmentId}/revoke`, headers: { cookie: gerencia }, payload: { reason: 'Fin de la prueba' } });
    });

    it('la estación no se cae con un parecido negativo: guarda la evidencia acotada y dice "no te reconocí"', async () => {
      // Una sede con UN solo rostro: el mejor parecido de una cara opuesta es −1.
      const sede = await sedeDesechable(orgId, 'Sede de prueba de la cámara');
      try {
        const memberId = await socio();
        const semilla = semillaNueva();
        const alta = await app.inject({ method: 'POST', url: `/members/${memberId}/biometric-enrollments/face`, headers: { cookie: gerencia },
          payload: { branchId: sede.id, frames: cuadros(semilla), reto: 'turn_left', reason: 'Alta en recepción' } });
        expect(alta.statusCode, alta.body).toBe(201);
        const opuesta = Array.from({ length: 3 }, () => `N${semilla}|${'x'.repeat(200)}`);
        const r = await app.inject({ method: 'POST', url: '/access/face', headers: { cookie: gerencia }, payload: { branchId: sede.id, frames: opuesta, reto: 'turn_left' } });
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json()).toMatchObject({ reconocido: false, sinRostro: false });
        const d = await getDb().accessDecision.findFirstOrThrow({ where: { organizationId: orgId, branchId: sede.id, credentialKind: 'FACE' }, orderBy: { at: 'desc' } });
        expect(d.denialReason).toBe('MEMBER_UNKNOWN');
        expect(d.matchScore).toBe(0);
        // Con un solo rostro, el mismo socio se reconoce (ventaja 1, el tope).
        expect((await app.inject({ method: 'POST', url: '/access/face', headers: { cookie: gerencia }, payload: { branchId: sede.id, frames: cuadros(semilla), reto: 'turn_left' } })).json())
          .toMatchObject({ reconocido: true, memberId });
        await app.inject({ method: 'POST', url: `/biometric-enrollments/${alta.json().id}/revoke`, headers: { cookie: gerencia }, payload: { reason: 'Fin de la prueba' } });
      } finally { await archivarSede(sede.id); }
    });
  });

  // ── A1-N1 · Anonimizar borra el rostro ───────────────────────────────────
  describe('anonimizar borra el rostro (A1-N1)', () => {
    it('anonimizar deja vacía face_templates del socio y asienta el borrado', async () => {
      const { memberId, enrollmentId } = await conRostro();
      expect((await darDeBaja(memberId)).statusCode).toBeLessThan(300);
      const r = await app.inject({
        method: 'POST', url: `/members/${memberId}/anonymize`, headers: { cookie: gerente },
        payload: { reason: 'Solicitud ARCO', approvalToken: await aprobacion(app, gerente, 'members:anonymize', 'owner@demo.mx', cen, { resourceId: memberId }) },
      });
      expect(r.statusCode, r.body).toBe(204);

      expect(await plantillasDe(memberId)).toBe(0);
      const e = await getDb().biometricEnrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
      expect(e.revokedAt).not.toBeNull();
      expect(e.templateDeletedAt).not.toBeNull();
      // Ya no es una obligación pendiente que alguien "confirme" sin que haya pasado.
      const pendientes = (await app.inject({ method: 'GET', url: '/biometric-enrollments/pending-deletion', headers: { cookie: await loginAs(app, 'owner@demo.mx') } })).json();
      expect([...pendientes.overdue, ...pendientes.waiting].some((x: { id: string }) => x.id === enrollmentId)).toBe(false);
      const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'member.anonymize', resourceId: memberId } });
      expect(asiento.afterState).toMatchObject({ faceTemplatesDeleted: 1 });
    });
  });

  // ── Limpieza única ───────────────────────────────────────────────────────
  describe('limpieza única de rostros (A1-N1)', () => {
    it('cuenta sin borrar, borra con aplicar, solo toca bajas vencidas si se pide, deja bitácora y no repite', async () => {
      const db = getDb();
      // 1) Anonimizado con el defecto de antes: se revocó, pero el rostro quedó.
      const anon = await conRostro();
      await darDeBaja(anon.memberId);
      await db.biometricEnrollment.update({ where: { id: anon.enrollmentId }, data: { revokedAt: new Date(), revokedReason: 'Anonimización ARCO' } });
      await db.member.update({ where: { id: anon.memberId }, data: { anonymizedAt: new Date(), firstName: 'Socio', lastName: 'anonimizado', nameKey: '' } });
      // 2) Enrolamiento revocado cuya plantilla quedó.
      const rev = await conRostro();
      await db.biometricEnrollment.update({ where: { id: rev.enrollmentId }, data: { revokedAt: new Date(), revokedReason: 'Prueba de plantilla que quedó' } });
      // 3) Baja de hace 40 días y 4) baja de hace 5 días, con su rostro vivo.
      const vieja = await conRostro();
      await darDeBaja(vieja.memberId);
      await db.member.update({ where: { id: vieja.memberId }, data: { deletedAt: new Date(Date.now() - 40 * 86_400_000) } });
      const reciente = await conRostro();
      await darDeBaja(reciente.memberId);
      await db.member.update({ where: { id: reciente.memberId }, data: { deletedAt: new Date(Date.now() - 5 * 86_400_000) } });

      const servicio = new EnrollmentService();
      const ctx = systemContext(orgId);
      const seco = await servicio.limpiarRostrosHuerfanos(ctx, { aplicar: false, bajasDeMasDeDias: 30 });
      expect(seco).toMatchObject({ aplicado: false });
      expect(seco.anonimizados).toBeGreaterThanOrEqual(1);
      expect(seco.revocados).toBeGreaterThanOrEqual(1);
      expect(seco.bajas).toBeGreaterThanOrEqual(1);
      for (const s of [anon, rev, vieja, reciente]) expect(await plantillasDe(s.memberId)).toBe(1);

      await servicio.limpiarRostrosHuerfanos(ctx, { aplicar: true });
      expect(await plantillasDe(anon.memberId)).toBe(0);
      expect(await plantillasDe(rev.memberId)).toBe(0);
      expect(await plantillasDe(vieja.memberId)).toBe(1);
      expect(await plantillasDe(reciente.memberId)).toBe(1);
      expect((await db.biometricEnrollment.findUniqueOrThrow({ where: { id: anon.enrollmentId } })).templateDeletedAt).not.toBeNull();
      const asiento = await db.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'access.biometric.template_deleted', resourceId: anon.enrollmentId } });
      expect(asiento.actorType).toBe('SYSTEM');
      expect(asiento.reason).toMatch(/anonimizado/);

      await servicio.limpiarRostrosHuerfanos(ctx, { aplicar: true, bajasDeMasDeDias: 30 });
      expect(await plantillasDe(vieja.memberId)).toBe(0);
      const ev = await db.biometricEnrollment.findUniqueOrThrow({ where: { id: vieja.enrollmentId } });
      expect(ev.revokedReason).toMatch(/D-32/);
      expect(ev.templateDeletedAt).not.toBeNull();
      expect(await plantillasDe(reciente.memberId)).toBe(1);

      const otraVez = await servicio.limpiarRostrosHuerfanos(ctx, { aplicar: true, bajasDeMasDeDias: 30 });
      expect(otraVez).toMatchObject({ anonimizados: 0, revocados: 0, bajas: 0, sinConfirmar: 0 });
      expect(await plantillasDe(reciente.memberId)).toBe(1);

      await db.biometricEnrollment.update({ where: { id: reciente.enrollmentId }, data: { revokedAt: new Date(), revokedReason: 'Fin de la prueba' } });
      await servicio.limpiarRostrosHuerfanos(ctx, { aplicar: true });
      expect(await plantillasDe(reciente.memberId)).toBe(0);
    });
  });

  // ── 5-24 · La visita se consume con el id de la asistencia ───────────────
  describe('libro de visitas (5-24)', () => {
    it('el consumo apunta a la asistencia, y el reintento sabe que ya descontó', async () => {
      const memberId = await socio();
      const hoy = new Date(`${diaEnCdmx()}T00:00:00.000Z`);
      const pack = await getDb().visitPack.create({ data: {
        id: uuidv7(), organizationId: orgId, memberId, soldAtBranchId: cen, visitsPurchased: 10, purchasedOn: hoy, status: 'ACTIVE', createdByUserId: gerenciaId,
      } });
      await getDb().visitLedgerEntry.create({ data: { id: uuidv7(), organizationId: orgId, visitPackId: pack.id, branchId: cen, entryType: 'PURCHASE', delta: 10, createdByUserId: gerenciaId, businessDate: hoy } });

      const requestKey = `clave-${uuidv7()}`;
      const entrar = () => app.inject({ method: 'POST', url: '/access/attempts', headers: { cookie: recepcion },
        payload: { branchId: cen, memberId, credentialKind: 'MANUAL', reason: 'La cámara no lo reconoció', requestKey } });
      const r = await entrar();
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({ outcome: 'GRANTED', consumedVisit: true });
      const { attendanceId, decisionId } = r.json() as { attendanceId: string; decisionId: string };

      const consumo = await getDb().visitLedgerEntry.findFirstOrThrow({ where: { visitPackId: pack.id, entryType: 'CONSUME' } });
      expect(consumo.attendanceEventId).toBe(attendanceId);
      expect(consumo.attendanceEventId).not.toBe(decisionId);
      const asistencia = await getDb().attendanceEvent.findUniqueOrThrow({ where: { id: attendanceId } });
      expect(asistencia.accessDecisionId).toBe(decisionId);

      const otra = await entrar();
      expect(otra.json()).toMatchObject({ decisionId, consumedVisit: true });
      expect(await getDb().visitLedgerEntry.count({ where: { visitPackId: pack.id, entryType: 'CONSUME' } })).toBe(1);
    });
  });

  // ── 5-10 · Un rechazo se resuelve una sola vez ───────────────────────────
  describe('un rechazo se resuelve una sola vez (5-10)', () => {
    /** Socio con la membresía suspendida y $650 de deuda: la puerta lo rechaza y se puede levantar. */
    async function rechazado(): Promise<{ memberId: string; decisionId: string }> {
      const memberId = await socio();
      const db = getDb();
      const hoy = new Date(`${diaEnCdmx()}T00:00:00.000Z`);
      await db.membership.create({ data: {
        id: uuidv7(), organizationId: orgId, memberId, planId, soldAtBranchId: cen, status: 'SUSPENDED',
        startDate: new Date(hoy.getTime() - 60 * 86_400_000), currentPeriodStart: new Date(hoy.getTime() - 30 * 86_400_000), currentPeriodEnd: hoy,
        billingAnchorDay: 1, autoRenew: false, createdByUserId: gerenciaId,
      } });
      await db.charge.create({ data: {
        id: uuidv7(), organizationId: orgId, memberId, branchId: cen, chargeType: 'MANUAL_ADJUSTMENT', status: 'OPEN',
        concept: 'Cuota vencida de prueba', subtotalCents: 65000n, amountCents: 65000n, dueDate: hoy, issuedAt: new Date(),
      } });
      const r = await app.inject({ method: 'POST', url: '/access/attempts', headers: { cookie: recepcion },
        payload: { branchId: cen, memberId, credentialKind: 'MANUAL', reason: 'Viene a pagar' } });
      expect(r.json()).toMatchObject({ outcome: 'DENIED', overridable: true });
      return { memberId, decisionId: r.json().decisionId as string };
    }
    const dejarPasar = (decisionId: string, cookie = recepcion) => app.inject({ method: 'POST', url: `/access/decisions/${decisionId}/grant`, headers: { cookie }, payload: { reason: 'Paga mañana; lo autorizó la gerente' } });
    const cobrar = (decisionId: string) => app.inject({ method: 'POST', url: `/access/decisions/${decisionId}/collect`, headers: { cookie: recepcion },
      payload: { method: 'SPEI_TRANSFER', amountCents: '65000', externalRef: `SPEI-${uuidv7().slice(-8)}` } });

    it('dejar pasar dos veces: la segunda es 409 con quién y cuándo, y no hay otra entrada', async () => {
      const { memberId, decisionId } = await rechazado();
      const uno = await dejarPasar(decisionId);
      expect(uno.statusCode, uno.body).toBe(201);
      const dos = await dejarPasar(decisionId, gerencia);
      expect(dos.statusCode).toBe(409);
      expect(dos.json()).toMatchObject({ detail: 'ALREADY_RESOLVED' });
      expect(dos.json().message).toMatch(/ya se resolvió: lo resolvió .+ a las \d{2}:\d{2}/);
      expect(await getDb().attendanceEvent.count({ where: { memberId } })).toBe(1);

      const historial = (await app.inject({ method: 'GET', url: `/access/decisions?memberId=${memberId}`, headers: { cookie: gerencia } })).json().decisions as Array<{ id: string; resolvesDecisionId: string | null; resolvedByDecisionId: string | null }>;
      expect(historial.find((d) => d.id === decisionId)?.resolvedByDecisionId).toBe(uno.json().decisionId);
      expect(historial.find((d) => d.id === uno.json().decisionId)?.resolvesDecisionId).toBe(decisionId);
      const vista = (await app.inject({ method: 'GET', url: `/access/decisions/${decisionId}/exception`, headers: { cookie: recepcion } })).json();
      expect(vista.resolution).toMatchObject({ decisionId: uno.json().decisionId });
      expect(vista.resolution.byName).toBeTruthy();
    });

    it('cobrar y abrir un rechazo ya resuelto no cobra nada', async () => {
      const { memberId, decisionId } = await rechazado();
      expect((await dejarPasar(decisionId)).statusCode).toBe(201);
      const r = await cobrar(decisionId);
      expect(r.statusCode).toBe(409);
      expect(await getDb().payment.count({ where: { memberId } })).toBe(0);
    });

    it('dos cobros al mismo tiempo sobre el mismo rechazo: un solo pago y una sola entrada', async () => {
      const { memberId, decisionId } = await rechazado();
      const [a, b] = await Promise.all([cobrar(decisionId), cobrar(decisionId)]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
      expect(await getDb().payment.count({ where: { memberId } })).toBe(1);
      expect(await getDb().accessDecision.count({ where: { resolvesDecisionId: decisionId } })).toBe(1);
      expect(await getDb().attendanceEvent.count({ where: { memberId } })).toBe(1);
    });
  });
});

/**
 * LA LLAVE DEL ROSTRO sale de `SENSITIVE_DATA_KEY` (bloques 0.3 y 0.7), con la
 * MISMA derivación de siempre: si cambiara, todo rostro guardado quedaría
 * ilegible. El nombre anterior, `MFA_ENCRYPTION_KEY`, se acepta una versión más.
 */
describe('la llave del rostro sale de la llave de datos sensibles', () => {
  const llave = randomBytes(32).toString('base64');
  const motorCon = (vars: Record<string, string>) => new FaceEngine(loadEnv({ ...process.env, NODE_ENV: 'test', ...vars }));
  const v = vector(2.345);

  it('con el nombre nuevo o el anterior es la misma llave, y lee lo cifrado con la fórmula de antes', () => {
    const nueva = motorCon({ SENSITIVE_DATA_KEY: llave, MFA_ENCRYPTION_KEY: '' });
    const anterior = motorCon({ SENSITIVE_DATA_KEY: '', MFA_ENCRYPTION_KEY: llave });
    expect(anterior.descifrar(nueva.cifrar(v))).toEqual(v);
    // Una plantilla guardada antes del cambio (HKDF directo sobre la llave con la etiqueta del rostro).
    const deAntes = encryptSecret(JSON.stringify(v), Buffer.from(hkdfSync('sha256', Buffer.from(llave, 'base64'), Buffer.alloc(0), 'gymflow/biometria/rostro', 32)));
    expect(nueva.descifrar(deAntes)).toEqual(v);
    // Otra llave no la abre.
    expect(() => motorCon({ SENSITIVE_DATA_KEY: randomBytes(32).toString('base64'), MFA_ENCRYPTION_KEY: '' }).descifrar(deAntes)).toThrow();
  });
});
