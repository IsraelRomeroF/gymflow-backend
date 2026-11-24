import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { MOTIVO_ROSTRO_TRAS_LA_BAJA, REVOCABLES_EN_RECEPCION } from '@gymflow/core';
import { PrivacyConservation, diferenciasConElContrato } from '@gymflow/core/contracts';
import { makeApp, loginAs, nombreUnico, telefonoUnico, CONSENTIMIENTOS, PASSWORD } from './helpers.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { systemContext } from '../src/platform/jobs/types.js';
import { ORDEN_DIARIO } from '../src/platform/jobs/plan.js';
import { FaceTemplateRepository } from '../src/modules/access/index.js';
import { ConsentDocumentRepository, retirarConsentimiento } from '../src/modules/members/index.js';
import { ConservacionService, PRIVACY_JOBS } from '../src/modules/privacy/index.js';
import { ConservacionRepository } from '../src/modules/privacy/conservacion.repository.js';

/**
 * FASE 3 · BLOQUE 3.9 (auditoría 8): conservación de datos (D-32, opción a).
 *
 *  · El rostro deja de reconocerse con la baja y se borra a los 30 días si no
 *    regresa; si regresa antes, vuelve a reconocerse sin registrarlo otra vez.
 *  · Lo demás se anonimiza a los 24 meses de la baja (plazo por gimnasio),
 *    pero solo con la firma del dueño sobre la lista del mes: una por lista.
 *  · La primera pasada en un gimnasio no borra nada, y todo se puede correr
 *    dos veces sin daño.
 *
 * Cada bloque usa un gimnasio propio (el día de arranque es uno por gimnasio
 * y no se mueve) y un «ahora» fijo que se le pasa al servicio: nada depende
 * de la hora real ni de la fecha de la base. Las sedes están en la zona de la
 * Ciudad de México, y hay un caso de baja a las 21:00 (ya «mañana» en UTC).
 *
 * El motor facial se simula: el cuadro `S<semilla>|…` da el rostro de esa semilla.
 */
const vector = (semilla: number) => { const v = Array.from({ length: 512 }, (_, i) => Math.sin((i + 1) * semilla)); const n = Math.hypot(...v); return v.map((x) => x / n); };
const cuadros = (semilla: number) => Array.from({ length: 3 }, () => `S${semilla}|${'x'.repeat(200)}`);
let siguiente = 5 + Math.random();
const semillaNueva = () => { siguiente += 0.731; return Number(siguiente.toFixed(4)); };

const DIA = 86_400_000;
/** Mediodía en la Ciudad de México de un día cualquiera ya pasado. */
const T0 = new Date('2026-06-15T18:00:00.000Z');
const masDias = (n: number) => new Date(T0.getTime() + n * DIA);

describe('fase 3 · conservación de datos (3.9, D-32)', () => {
  let app: FastifyInstance; let motor: Server;
  const servicio = new ConservacionService();

  beforeAll(async () => {
    motor = createServer((req, res) => {
      let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', model_loaded: true }));
        const { frames } = JSON.parse(body) as { frames: string[] };
        const m = /^S([0-9.]+)\|/.exec(frames[0] ?? '');
        if (!m) return res.end(JSON.stringify({ ok: false, error: 'No se detectó ningún rostro', liveness_checked: false }));
        res.end(JSON.stringify({ ok: true, embedding: vector(Number(m[1])), liveness_checked: true, liveness_ok: true }));
      });
    }).listen(0);
    const port = (motor.address() as { port: number }).port;
    app = await makeApp({ FACE_SIDECAR_URL: `http://127.0.0.1:${port}` }); await app.ready();
  });
  afterAll(async () => { await app.close(); motor.close(); await closeDb(); });

  /** Un gimnasio propio con su texto biométrico publicado y las tres sesiones. */
  async function gimnasio(): Promise<{ g: GimnasioPropio; sede: string; duena: string; gerente: string; recepcion: string }> {
    const g = await gimnasioPropio();
    const textos = new ConsentDocumentRepository(g.organizationId);
    const b = await textos.create({ consentType: 'BIOMETRIC', version: 'v1.0', title: 'Rostro (prueba)', bodyText: 'Texto de prueba BIOMETRIC' });
    await textos.publish(b.id, null);
    return {
      g, sede: g.sedes[0]!.id,
      duena: await loginAs(app, g.correos.owner), gerente: await loginAs(app, g.correos.gerente), recepcion: await loginAs(app, g.correos.recepcion),
    };
  }
  async function socio(cookie: string, sede: string): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie },
      payload: { firstName: nombreUnico('Con'), lastName: nombreUnico('Ser'), phoneE164: telefonoUnico(), homeBranchId: sede, consents: CONSENTIMIENTOS },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }
  async function conRostro(cookie: string, sede: string): Promise<{ memberId: string; enrollmentId: string }> {
    const memberId = await socio(cookie, sede);
    const r = await app.inject({ method: 'POST', url: `/members/${memberId}/biometric-enrollments/face`, headers: { cookie }, payload: { branchId: sede, frames: cuadros(semillaNueva()) } });
    expect(r.statusCode, r.body).toBe(201);
    return { memberId, enrollmentId: r.json().id as string };
  }
  /** Lo da de baja por la API y fija el instante de la baja (la API siempre pone «ahora»). */
  async function darDeBaja(cookie: string, memberId: string, cuando: Date): Promise<void> {
    const r = await app.inject({ method: 'POST', url: `/members/${memberId}/archive`, headers: { cookie }, payload: { reason: 'Pidió su baja' } });
    expect(r.statusCode, r.body).toBeLessThan(300);
    await getDb().$executeRaw`UPDATE "members" SET "deletedAt" = ${cuando} WHERE "id" = ${memberId}::uuid`;
  }
  const reactivar = (cookie: string, memberId: string) => app.inject({ method: 'POST', url: `/members/${memberId}/reactivate`, headers: { cookie }, payload: { reason: 'Regresó al gimnasio' } });
  const plantillasDe = (memberId: string) => getDb().faceTemplate.count({ where: { memberId } });
  const enElPadron = async (org: string, sede: string, memberId: string) => (await new FaceTemplateRepository(org).padron(sede, 'branch')).filter((p) => p.memberId === memberId).map((p) => p.enrollmentId);
  const ficha = (memberId: string) => getDb().member.findUniqueOrThrow({ where: { id: memberId } });
  const estado = async (cookie: string) => {
    const r = await app.inject({ method: 'GET', url: '/privacy/conservation', headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(PrivacyConservation, r.json())).toEqual([]);
    return r.json() as PrivacyConservation;
  };
  const firmar = (cookie: string, batchId: string, password = PASSWORD) => app.inject({ method: 'POST', url: '/privacy/conservation/sign', headers: { cookie }, payload: { batchId, password } });

  // ── El job tiene su lugar ─────────────────────────────────────────────────
  it('el job `privacy.conservation` existe y corre después de cerrar las bajas y antes de verificar la bitácora', () => {
    expect(PRIVACY_JOBS.map((j) => j.name)).toContain('privacy.conservation');
    const i = ORDEN_DIARIO.indexOf('privacy.conservation');
    expect(i).toBeGreaterThan(ORDEN_DIARIO.indexOf('membership.close-archived'));
    expect(i).toBeLessThan(ORDEN_DIARIO.indexOf('audit.verify-hash-chain'));
  });

  // ── El rostro ─────────────────────────────────────────────────────────────
  describe('el rostro de quien se da de baja', () => {
    it('deja de reconocerse con la baja; si regresa antes de los 30 días vuelve a reconocerse sin registrarlo otra vez', async () => {
      const { g, sede, gerente } = await gimnasio();
      const { memberId, enrollmentId } = await conRostro(gerente, sede);
      expect(await enElPadron(g.organizationId, sede, memberId)).toEqual([enrollmentId]);

      await darDeBaja(gerente, memberId, masDias(0));
      expect(await enElPadron(g.organizationId, sede, memberId)).toEqual([]);
      // No se borra con la baja: se guarda (sin reconocerse) por si regresa.
      expect(await plantillasDe(memberId)).toBe(1);
      expect((await new FaceTemplateRepository(g.organizationId).deExsocios()).map((p) => p.enrollmentId)).toEqual([enrollmentId]);

      // Dos pasadas dentro del plazo no lo tocan.
      await servicio.pasada(g.organizationId, masDias(0));
      expect((await servicio.pasada(g.organizationId, masDias(29))).rostrosBorrados).toBe(0);
      expect(await plantillasDe(memberId)).toBe(1);

      expect((await reactivar(gerente, memberId)).statusCode).toBe(200);
      // El mismo enrolamiento, sin registrarlo de nuevo; y su permiso biométrico sigue vigente.
      expect(await enElPadron(g.organizationId, sede, memberId)).toEqual([enrollmentId]);
      expect(await getDb().memberConsent.count({ where: { memberId, consentType: 'BIOMETRIC', granted: true, revokedAt: null } })).toBe(1);
      // Ya no es exsocio: una pasada muy posterior tampoco lo toca.
      expect((await servicio.pasada(g.organizationId, masDias(90))).rostrosBorrados).toBe(0);
      expect(await plantillasDe(memberId)).toBe(1);
      await g.cerrar();
    });

    it('si retiró su permiso biométrico estando de baja, al regresar no se reconoce: hay que registrarlo de nuevo', async () => {
      const { g, sede, gerente } = await gimnasio();
      const { memberId } = await conRostro(gerente, sede);
      await darDeBaja(gerente, memberId, masDias(0));
      await retirarConsentimiento(systemContext(g.organizationId), { memberId, consentType: 'BIOMETRIC', motivo: 'Lo pidió el socio', via: 'ficha', permitidos: REVOCABLES_EN_RECEPCION });
      expect(await plantillasDe(memberId)).toBe(0);
      expect((await reactivar(gerente, memberId)).statusCode).toBe(200);
      expect(await enElPadron(g.organizationId, sede, memberId)).toEqual([]);
      await g.cerrar();
    });

    it('la primera pasada no borra nada; el atraso cuenta 30 días desde el arranque y las bajas nuevas, desde su baja', async () => {
      const { g, sede, gerente } = await gimnasio();
      const org = g.organizationId;
      const vieja = await conRostro(gerente, sede);      // baja de hace 400 días: atraso
      const reciente = await conRostro(gerente, sede);   // baja de hace 5 días: también anterior al arranque
      const vigente = await conRostro(gerente, sede);    // sigue siendo socio
      await darDeBaja(gerente, vieja.memberId, masDias(-400));
      await darDeBaja(gerente, reciente.memberId, masDias(-5));

      // ANTES de la primera pasada se puede mirar qué haría, sin tocar nada.
      const previa = await servicio.vistaPrevia(org, T0);
      expect(previa).toMatchObject({ hoy: '2026-06-15', arranque: null, meses: 24 });
      expect(previa.rostros.map((r) => `${r.bajaEl} → ${r.seBorraEl}`).sort()).toEqual(['2025-05-11 → 2026-07-15', '2026-06-10 → 2026-07-15']);
      expect(previa.rostros.every((r) => !r.hoy)).toBe(true);
      expect(await new ConservacionRepository(org).arranque()).toBeNull();
      expect(await getDb().auditLog.count({ where: { organizationId: org, action: { startsWith: 'privacy.' } } })).toBe(0);

      // PRIMERA PASADA: fija el arranque, cuenta y no borra.
      const primera = await servicio.pasada(org, T0);
      expect(primera).toMatchObject({ arranco: true, rostrosBorrados: 0, rostrosEnEspera: 2, errores: [] });
      expect(await getDb().faceTemplate.count({ where: { organizationId: org } })).toBe(3);
      const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'privacy.conservation.start' } });
      expect(asiento.actorType).toBe('SYSTEM');
      expect(asiento.afterState).toMatchObject({ startedOn: '2026-06-15', facesWaiting: 2, faceDaysAfterArchive: 30 });
      // Repetirla el mismo día no cambia nada ni vuelve a asentar el arranque.
      expect(await servicio.pasada(org, T0)).toMatchObject({ arranco: false, rostrosBorrados: 0, rostrosEnEspera: 2 });
      expect(await getDb().auditLog.count({ where: { organizationId: org, action: 'privacy.conservation.start' } })).toBe(1);

      // La pantalla lo dice antes de que pase: cuántos esperan y cuándo se borra el primero.
      const e = await estado(gerente);
      expect(e).toMatchObject({ startedOn: '2026-06-15', faceDaysAfterArchive: 30, faces: { waiting: 2, nextDeletionOn: '2026-07-15' } });

      // Una baja posterior al arranque: sus 30 días cuentan desde su baja.
      const nueva = await conRostro(gerente, sede);
      await darDeBaja(gerente, nueva.memberId, masDias(10));

      // Día 29 desde el arranque: todavía nada.
      expect(await servicio.pasada(org, masDias(29))).toMatchObject({ rostrosBorrados: 0, rostrosEnEspera: 3 });
      // Día 30: se borran los dos del atraso; la baja nueva espera hasta su día 30 (el 40 desde el arranque).
      expect(await servicio.pasada(org, masDias(30))).toMatchObject({ rostrosBorrados: 2, rostrosEnEspera: 1, errores: [] });
      expect(await plantillasDe(vieja.memberId)).toBe(0);
      expect(await plantillasDe(reciente.memberId)).toBe(0);
      expect(await plantillasDe(nueva.memberId)).toBe(1);
      expect(await plantillasDe(vigente.memberId)).toBe(1);

      // Borrar es revocar: el enrolamiento queda revocado con su motivo, el borrado asentado y la bitácora como acción del sistema.
      const enr = await getDb().biometricEnrollment.findUniqueOrThrow({ where: { id: vieja.enrollmentId } });
      expect(enr.revokedAt).not.toBeNull();
      expect(enr.templateDeletedAt).not.toBeNull();
      expect(enr.revokedReason).toBe(MOTIVO_ROSTRO_TRAS_LA_BAJA);
      const rev = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'access.biometric.revoke', resourceId: vieja.enrollmentId } });
      expect(rev).toMatchObject({ actorType: 'SYSTEM', reason: MOTIVO_ROSTRO_TRAS_LA_BAJA });
      // Sin rostro ni huella, su permiso biométrico queda retirado: si regresa, firma y se registra de nuevo.
      expect(await getDb().memberConsent.count({ where: { memberId: vieja.memberId, consentType: 'BIOMETRIC', granted: true, revokedAt: null } })).toBe(0);
      // Sus demás datos siguen intactos: a los 30 días solo se va el rostro.
      expect((await ficha(vieja.memberId)).anonymizedAt).toBeNull();

      // Repetir la pasada no encuentra nada más que hacer.
      expect(await servicio.pasada(org, masDias(30))).toMatchObject({ rostrosBorrados: 0, rostrosEnEspera: 1 });
      expect(await servicio.pasada(org, masDias(39))).toMatchObject({ rostrosBorrados: 0, rostrosEnEspera: 1 });
      expect(await servicio.pasada(org, masDias(40))).toMatchObject({ rostrosBorrados: 1, rostrosEnEspera: 0 });
      expect(await plantillasDe(nueva.memberId)).toBe(0);
      // El del socio vigente nunca se tocó.
      expect(await enElPadron(org, sede, vigente.memberId)).toEqual([vigente.enrollmentId]);
      await g.cerrar();
    });
  });

  // ── La lista mensual ──────────────────────────────────────────────────────
  describe('la lista mensual de exsocios por anonimizar', () => {
    it('lista sin borrar, se firma una sola vez y solo entonces anonimiza; quien regresó o salió de la lista no se toca', async () => {
      const { g, sede, duena, gerente, recepcion } = await gimnasio();
      const org = g.organizationId;
      const db = getDb();
      const conCara = await conRostro(gerente, sede);                  // 30 meses de baja, con rostro guardado
      const regresa = await socio(gerente, sede);                     // 25 meses; regresa antes de la firma
      const justo = await socio(gerente, sede);                       // 24 meses exactos, de noche: 15 de junio a las 21:00 en su sede (16 en UTC)
      const casi = await socio(gerente, sede);                        // le falta un día: 16 de junio a la 01:00 en su sede
      const activo = await socio(gerente, sede);
      await darDeBaja(gerente, conCara.memberId, new Date('2023-12-15T18:00:00.000Z'));
      await darDeBaja(gerente, regresa, new Date('2024-05-15T18:00:00.000Z'));
      await darDeBaja(gerente, justo, new Date('2024-06-16T03:00:00.000Z'));
      await darDeBaja(gerente, casi, new Date('2024-06-16T07:00:00.000Z'));

      // Antes de la primera pasada: quién entraría a la lista, sin armarla.
      const previa = await servicio.vistaPrevia(org, T0);
      expect(previa.lista).toMatchObject({ periodo: '2026-06', yaExiste: false, enEspera: null });
      expect(previa.lista.exsocios.map((e) => e.bajaEl).sort()).toEqual(['2023-12-15', '2024-05-15', '2024-06-15']);
      expect(previa.corte).toBe('2024-06-15');
      expect(await db.privacyBatch.count({ where: { organizationId: org } })).toBe(0);

      // LA PRIMERA PASADA arma la lista y no anonimiza a nadie.
      const primera = await servicio.pasada(org, T0);
      expect(primera).toMatchObject({ arranco: true, listaArmada: '2026-06', anonimizados: 0, rostrosBorrados: 0, errores: [] });
      for (const id of [conCara.memberId, regresa, justo, casi, activo]) expect((await ficha(id)).anonymizedAt).toBeNull();
      expect(await plantillasDe(conCara.memberId)).toBe(1);
      // Repetirla no arma otra lista ni duplica renglones.
      expect((await servicio.pasada(org, T0)).listaArmada).toBeNull();
      expect((await servicio.pasada(org, masDias(3))).listaArmada).toBeNull();
      expect(await db.privacyBatch.count({ where: { organizationId: org } })).toBe(1);

      // La gerencia la ve, con el plazo por omisión (el gimnasio no fijó ninguno) y sin poder firmarla.
      const vista = await estado(gerente);
      expect(vista).toMatchObject({ monthsAfterArchive: 24, monthsIsDefault: true, canSign: false, canExclude: true });
      const lista = vista.batch!;
      expect(lista).toMatchObject({ period: '2026-06', status: 'PENDING', monthsAfterArchive: 24, cutoffOn: '2024-06-15', counts: { listed: 3, anonymized: 0, excluded: 0, skipped: 0 } });
      expect(lista.items.map((i) => i.memberId).sort()).toEqual([conCara.memberId, regresa, justo].sort());
      expect(lista.items.find((i) => i.memberId === justo)).toMatchObject({ archivedOn: '2024-06-15', status: 'LISTED' });
      expect(lista.items.every((i) => typeof i.fullName === 'string' && i.fullName.length > 3)).toBe(true);
      // La lista no guarda nombres: se leen de la ficha.
      expect(Object.keys((await db.privacyBatchItem.findFirstOrThrow({ where: { batchId: lista.id } }))).some((k) => /name/i.test(k))).toBe(false);
      const armada = await db.auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'privacy.batch.prepare' } });
      expect(armada).toMatchObject({ actorType: 'SYSTEM', resourceId: lista.id });
      expect(armada.afterState).toMatchObject({ period: '2026-06', listed: 3, monthsAfterArchive: 24 });
      // La dueña la ve y puede firmarla; recepción no la ve.
      expect(await estado(duena)).toMatchObject({ canSign: true, canExclude: false });
      expect((await app.inject({ method: 'GET', url: '/privacy/conservation', headers: { cookie: recepcion } })).statusCode).toBe(403);

      // NADA SE ANONIMIZA SIN LA FIRMA. La gerencia no firma; una contraseña equivocada no firma y queda asentada.
      expect((await firmar(gerente, lista.id)).statusCode).toBe(403);
      const mala = await firmar(duena, lista.id, 'no-es-la-contrasena');
      expect(mala.statusCode, mala.body).toBe(401);
      expect(await db.auditLog.count({ where: { organizationId: org, action: 'privacy.batch.sign.fail', resourceId: lista.id } })).toBe(1);
      expect((await db.privacyBatch.findUniqueOrThrow({ where: { id: lista.id } })).status).toBe('PENDING');
      for (const id of [conCara.memberId, regresa, justo]) expect((await ficha(id)).anonymizedAt).toBeNull();
      // Y la base tampoco deja marcar a nadie como anonimizado en una lista sin firmar.
      await expect(db.$executeRaw`UPDATE "privacy_batch_items" SET "status" = 'ANONYMIZED', "resolvedAt" = now() WHERE "batchId" = ${lista.id}::uuid AND "memberId" = ${justo}::uuid`)
        .rejects.toThrow(/nadie se anonimiza sin la firma de su lista/);

      // La gerencia saca a uno con motivo; la dueña no saca a nadie (firma o no firma).
      expect((await app.inject({ method: 'POST', url: '/privacy/conservation/exclude', headers: { cookie: duena }, payload: { batchId: lista.id, memberId: justo, reason: 'Tiene un adeudo por cobrar' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/privacy/conservation/exclude', headers: { cookie: gerente }, payload: { batchId: lista.id, memberId: justo, reason: 'x' } })).statusCode).toBe(422);
      const fuera = await app.inject({ method: 'POST', url: '/privacy/conservation/exclude', headers: { cookie: gerente }, payload: { batchId: lista.id, memberId: justo, reason: 'Tiene un adeudo por cobrar' } });
      expect(fuera.statusCode, fuera.body).toBe(204);
      expect((await app.inject({ method: 'POST', url: '/privacy/conservation/exclude', headers: { cookie: gerente }, payload: { batchId: lista.id, memberId: justo, reason: 'Otra vez' } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: '/privacy/conservation/exclude', headers: { cookie: gerente }, payload: { batchId: lista.id, memberId: activo, reason: 'No está en la lista' } })).statusCode).toBe(404);
      const sacado = await db.auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'privacy.batch.exclude', resourceId: justo } });
      expect(sacado.reason).toBe('Tiene un adeudo por cobrar');
      // Y uno regresa al gimnasio antes de la firma.
      expect((await reactivar(gerente, regresa)).statusCode).toBe(200);

      // LA FIRMA: una, de la dueña, con su contraseña.
      const firma = await firmar(duena, lista.id);
      expect(firma.statusCode, firma.body).toBe(200);
      const firmada = firma.json().batch as PrivacyConservation['history'][number] & { items: Array<{ memberId: string; status: string; note: string | null; fullName: string | null }> };
      expect(firmada).toMatchObject({ status: 'SIGNED', counts: { listed: 0, anonymized: 1, excluded: 1, skipped: 1 } });
      expect(firmada.signedByName).toBeTruthy();
      expect(firmada.items.find((i) => i.memberId === conCara.memberId)).toMatchObject({ status: 'ANONYMIZED', fullName: null });
      expect(firmada.items.find((i) => i.memberId === regresa)).toMatchObject({ status: 'SKIPPED', note: 'RETURNED' });
      expect(firmada.items.find((i) => i.memberId === justo)).toMatchObject({ status: 'EXCLUDED', note: 'Tiene un adeudo por cobrar' });

      // Quien estaba en la lista quedó sin nombre, sin teléfono y SIN ROSTRO, en el acto.
      const anon = await ficha(conCara.memberId);
      expect(anon.anonymizedAt).not.toBeNull();
      expect(anon.phoneE164).toBeNull();
      expect(await plantillasDe(conCara.memberId)).toBe(0);
      expect((await db.biometricEnrollment.findUniqueOrThrow({ where: { id: conCara.enrollmentId } })).templateDeletedAt).not.toBeNull();
      // Los demás, intactos: el que regresó sigue siendo socio; el que salió de la lista y el que no cumplía siguen de baja con su nombre.
      expect(await ficha(regresa)).toMatchObject({ anonymizedAt: null, deletedAt: null });
      for (const id of [justo, casi, activo]) expect((await ficha(id)).anonymizedAt).toBeNull();

      // La bitácora: firmó la dueña; anonimizó el sistema al amparo de esa firma, con el mes y el plazo en el motivo.
      const duenaId = g.ownerId;
      expect(await db.auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'privacy.batch.sign', resourceId: lista.id } })).toMatchObject({ actorUserId: duenaId });
      const asiento = await db.auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'member.anonymize', resourceId: conCara.memberId } });
      expect(asiento).toMatchObject({ actorType: 'SYSTEM', approvedByUserId: duenaId, reason: 'Lista de conservación 2026-06: pasaron 24 meses desde su baja' });
      expect(asiento.afterState).toMatchObject({ faceTemplatesDeleted: 1 });
      expect(await db.auditLog.count({ where: { organizationId: org, action: 'member.anonymize' } })).toBe(1);

      // UNA SOLA FIRMA POR LISTA: firmarla otra vez no hace nada, y la base no deja cambiar la firma ni desfirmar.
      expect((await firmar(duena, lista.id)).statusCode).toBe(409);
      await expect(db.$executeRaw`UPDATE "privacy_batches" SET "signedByUserId" = ${g.ownerId}::uuid, "signedAt" = now() WHERE "id" = ${lista.id}::uuid`).rejects.toThrow(/la firma de una lista no se cambia/);
      await expect(db.$executeRaw`UPDATE "privacy_batches" SET "status" = 'PENDING', "signedAt" = NULL, "signedByUserId" = NULL WHERE "id" = ${lista.id}::uuid`).rejects.toThrow(/no cambia de estado/);
      await expect(db.$executeRaw`UPDATE "privacy_batch_items" SET "status" = 'LISTED', "resolvedAt" = NULL WHERE "batchId" = ${lista.id}::uuid`).rejects.toThrow(/ya resuelto no se cambia/);
      // Las pasadas siguientes del mismo mes no reabren nada.
      expect(await servicio.pasada(org, masDias(10))).toMatchObject({ listaArmada: null, anonimizados: 0 });
      const despues = await estado(duena);
      expect(despues.batch).toBeNull();
      expect(despues.history.map((h) => `${h.period} ${h.status}`)).toEqual(['2026-06 SIGNED']);

      // EL MES SIGUIENTE: nueva lista con quien salió de la anterior y con quien ya cumplió.
      const julio = await servicio.pasada(org, new Date('2026-07-15T18:00:00.000Z'));
      expect(julio.listaArmada).toBe('2026-07');
      const listaJulio = (await estado(duena)).batch!;
      expect(listaJulio.items.map((i) => i.memberId).sort()).toEqual([justo, casi].sort());

      // NADIE LA FIRMA: en agosto se cierra como reemplazada (no borró nada) y nace la de agosto.
      const agosto = await servicio.pasada(org, new Date('2026-08-15T18:00:00.000Z'));
      expect(agosto).toMatchObject({ listaArmada: '2026-08', anonimizados: 0 });
      expect((await db.privacyBatch.findUniqueOrThrow({ where: { id: listaJulio.id } })).status).toBe('REPLACED');
      expect(await db.auditLog.count({ where: { organizationId: org, action: 'privacy.batch.replace', resourceId: listaJulio.id } })).toBe(1);
      expect((await firmar(duena, listaJulio.id)).statusCode).toBe(409);
      for (const id of [justo, casi]) expect((await ficha(id)).anonymizedAt).toBeNull();
      expect(await db.privacyBatch.count({ where: { organizationId: org, status: 'PENDING' } })).toBe(1);

      // EL PLAZO ES DEL GIMNASIO: lo alarga la gerencia (no recepción), con sus límites.
      expect((await app.inject({ method: 'PUT', url: '/privacy/settings', headers: { cookie: recepcion }, payload: { monthsAfterArchive: 36 } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PUT', url: '/privacy/settings', headers: { cookie: gerente }, payload: { monthsAfterArchive: 0 } })).statusCode).toBe(422);
      expect((await app.inject({ method: 'PUT', url: '/privacy/settings', headers: { cookie: gerente }, payload: { monthsAfterArchive: 121 } })).statusCode).toBe(422);
      const plazo = await app.inject({ method: 'PUT', url: '/privacy/settings', headers: { cookie: gerente }, payload: { monthsAfterArchive: 36 } });
      expect(plazo.statusCode, plazo.body).toBe(200);
      expect(plazo.json()).toEqual({ monthsAfterArchive: 36, effectiveMonths: 36 });
      const cambio = await db.auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'settings.privacy.update' } });
      expect(cambio.beforeState).toMatchObject({ monthsAfterArchive: null, effectiveMonths: 24 });
      expect(await estado(gerente)).toMatchObject({ monthsAfterArchive: 36, monthsIsDefault: false });
      // La lista de agosto se armó con 24 meses: si la dueña la firma ahora, nadie cumple ya el plazo vigente y nadie se toca.
      const listaAgosto = (await estado(duena)).batch!;
      const firmaAgosto = await firmar(duena, listaAgosto.id);
      expect(firmaAgosto.statusCode, firmaAgosto.body).toBe(200);
      expect(firmaAgosto.json().batch).toMatchObject({ status: 'SIGNED', counts: { listed: 0, anonymized: 0, excluded: 0, skipped: 2 } });
      for (const id of [justo, casi]) expect((await ficha(id)).anonymizedAt).toBeNull();
      // Con 36 meses, en septiembre no hay a quién listar: no nace ninguna lista.
      expect((await servicio.pasada(org, new Date('2026-09-15T18:00:00.000Z'))).listaArmada).toBeNull();
      // `null` vuelve al plazo por omisión.
      expect((await app.inject({ method: 'PUT', url: '/privacy/settings', headers: { cookie: gerente }, payload: { monthsAfterArchive: null } })).json()).toEqual({ monthsAfterArchive: null, effectiveMonths: 24 });
      expect((await app.inject({ method: 'GET', url: '/privacy/settings', headers: { cookie: gerente } })).json()).toEqual({ monthsAfterArchive: null, effectiveMonths: 24 });
      await g.cerrar();
    });

    it('lo que una lista firmada dejó a medias lo termina el cierre de la noche, y un gimnasio sin exsocios no arma lista', async () => {
      const { g, sede, duena, gerente } = await gimnasio();
      const org = g.organizationId;
      const db = getDb();
      // Sin exsocios que cumplan: ni lista ni nada que firmar.
      const vigente = await socio(gerente, sede);
      expect(await servicio.pasada(org, T0)).toMatchObject({ arranco: true, listaArmada: null, anonimizados: 0 });
      expect((await estado(duena)).batch).toBeNull();
      expect(await db.privacyBatch.count({ where: { organizationId: org } })).toBe(0);

      const a = await socio(gerente, sede); const b = await socio(gerente, sede);
      await darDeBaja(gerente, a, new Date('2023-01-10T18:00:00.000Z'));
      await darDeBaja(gerente, b, new Date('2023-02-10T18:00:00.000Z'));
      expect((await servicio.pasada(org, masDias(1))).listaArmada).toBe('2026-06');
      const lista = (await estado(duena)).batch!;
      // La firma quedó asentada pero la ejecución se cortó antes de tocar a nadie.
      expect(await new ConservacionRepository(org).firmar(lista.id, g.ownerId, masDias(2))).toBe(true);
      for (const id of [a, b]) expect((await ficha(id)).anonymizedAt).toBeNull();

      const noche = await servicio.pasada(org, masDias(2));
      expect(noche).toMatchObject({ anonimizados: 2, errores: [], listaArmada: null });
      for (const id of [a, b]) expect((await ficha(id)).anonymizedAt).not.toBeNull();
      expect((await ficha(vigente)).anonymizedAt).toBeNull();
      const cerrada = await db.privacyBatch.findUniqueOrThrow({ where: { id: lista.id } });
      expect(cerrada.closedAt).not.toBeNull();
      expect(await db.auditLog.count({ where: { organizationId: org, action: 'member.anonymize', approvedByUserId: g.ownerId } })).toBe(2);
      // Otra pasada no repite nada.
      expect(await servicio.pasada(org, masDias(2))).toMatchObject({ anonimizados: 0, listaArmada: null });
      expect(await db.auditLog.count({ where: { organizationId: org, action: 'member.anonymize' } })).toBe(2);
      await g.cerrar();
    });

    it('el job corre con el reloj de verdad y devuelve su resultado sin errores', async () => {
      const { g } = await gimnasio();
      const job = PRIVACY_JOBS.find((j) => j.name === 'privacy.conservation')!;
      const r = await job.handler(g.organizationId);
      expect(r).toMatchObject({ job: 'privacy.conservation', processed: 0, skipped: 0, errors: [] });
      expect(await new ConservacionRepository(g.organizationId).arranque()).not.toBeNull();
      expect((await job.handler(g.organizationId)).errors).toEqual([]);
      await g.cerrar();
    });
  });
});
