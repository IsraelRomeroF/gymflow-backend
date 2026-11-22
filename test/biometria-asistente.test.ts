import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs } from './helpers.js';
import { gimnasioPropio, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { ConsentDocumentRepository } from '../src/modules/members/index.js';
import { analizarMedicion, type IntentoMedido } from '../src/modules/access/face-measure.js';

/**
 * FASE 2 · BLOQUE 2.3 (auditoría 8): biometría.
 *
 *  · 6-14: la captura se comprueba antes de registrar (`/access/face/check`).
 *  · 6-09, D6-06: el alta es de frente, sin reto y sin motivo, en una unidad.
 *  · 6-05: «Actualizar» sustituye el rostro sin retirar el permiso.
 *  · 5-16, 6-13: el rostro vale en todo el gimnasio SOLO con
 *    `FACE_RECOGNITION_SCOPE=organization`; por omisión, como siempre.
 *  · 6-10: la medición guarda parecidos, propone un umbral y no cambia nada.
 *
 * Gimnasio propio: publica textos biométricos y no debe mover los del Demo.
 * El motor se simula: el cuadro `S<semilla>|…` da el rostro de esa semilla,
 * `X…` ninguno y `P…` un rostro que no está de frente.
 */
const vector = (semilla: number) => { const v = Array.from({ length: 512 }, (_, i) => Math.sin((i + 1) * semilla)); const n = Math.hypot(...v); return v.map((x) => x / n); };
const cuadros = (semilla: number, n = 6) => Array.from({ length: n }, () => `S${semilla}|${'x'.repeat(200)}`);
let siguiente = 11 + Math.random();
const semillaNueva = () => { siguiente += 0.731; return Number(siguiente.toFixed(4)); };

describe('fase 2 · biometría (2.3)', () => {
  let motor: Server; let url: string;
  let app: FastifyInstance; let appGimnasio: FastifyInstance;
  let g: GimnasioPropio; let gerente: string; let gerenteGimnasio: string; let owner: string;
  let sedeA: string; let sedeB: string;
  const recibidos: Array<{ url: string; action: unknown; aggregate: unknown; frontal_only: unknown }> = [];

  beforeAll(async () => {
    motor = createServer((req, res) => {
      let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', servicio: 'gymflow-motor-facial', modelo: 'buffalo_sc', model_loaded: true }));
        const j = JSON.parse(body) as { frames: string[]; action?: string | null; aggregate?: boolean; frontal_only?: boolean };
        recibidos.push({ url: req.url ?? '', action: j.action ?? null, aggregate: j.aggregate, frontal_only: j.frontal_only });
        const primero = j.frames[0] ?? '';
        if (primero.startsWith('P')) return res.end(JSON.stringify({ ok: false, faces_detected: j.frames.length, frontal_frames: 1, error: 'Mira de frente a la cámara, sin girar la cabeza, y no te muevas un momento.' }));
        const m = /^S([0-9.]+)\|/.exec(primero);
        if (!m) return res.end(JSON.stringify({ ok: false, faces_detected: 0, frontal_frames: 0, error: 'No se detectó ningún rostro', liveness_checked: false }));
        res.end(JSON.stringify({ ok: true, embedding: vector(Number(m[1])), faces_detected: j.frames.length, frontal_frames: j.frames.length, liveness_checked: !!j.action, liveness_ok: true }));
      });
    }).listen(0);
    url = `http://127.0.0.1:${(motor.address() as { port: number }).port}`;
    app = await makeApp({ FACE_SIDECAR_URL: url }); await app.ready();
    appGimnasio = await makeApp({ FACE_SIDECAR_URL: url, FACE_RECOGNITION_SCOPE: 'organization' }); await appGimnasio.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Sede A' }, { name: 'Sede B' }] });
    sedeA = g.sedes[0]!.id; sedeB = g.sedes[1]!.id;
    const textos = new ConsentDocumentRepository(g.organizationId);
    const v1 = await textos.create({ consentType: 'BIOMETRIC', version: 'bio-1', title: 'Biométrico de prueba', bodyText: 'Texto biométrico de prueba, versión 1' });
    await textos.publish(v1.id, null);
    gerente = await loginAs(app, g.correos.gerente);
    owner = await loginAs(app, g.correos.owner);
    gerenteGimnasio = await loginAs(appGimnasio, g.correos.gerente);
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await appGimnasio.close(); motor.close(); await closeDb(); });

  const registrar = (memberId: string, semilla: number, sede = sedeA, a = app, cookie = gerente) =>
    a.inject({ method: 'POST', url: `/members/${memberId}/biometric-enrollments/face`, headers: { cookie }, payload: { branchId: sede, frames: cuadros(semilla) } });
  const estacion = (semilla: number, sede: string, a = app, cookie = gerente) =>
    a.inject({ method: 'POST', url: '/access/face', headers: { cookie }, payload: { branchId: sede, frames: cuadros(semilla, 3), reto: 'turn_left' } });
  const firmasVivas = (memberId: string) => getDb().memberConsent.findMany({ where: { memberId, consentType: 'BIOMETRIC', revokedAt: null, granted: true }, orderBy: { grantedAt: 'asc' } });

  it('el estado del motor dice con qué decide la Estación, y por omisión el rostro vale en su sucursal', async () => {
    const s = (await app.inject({ method: 'GET', url: '/access/face/status', headers: { cookie: gerente } })).json();
    expect(s).toMatchObject({ disponible: true, motivo: null, modelo: 'buffalo_sc', umbral: 0.38, margen: 0.05, alcance: 'branch' });
    const s2 = (await appGimnasio.inject({ method: 'GET', url: '/access/face/status', headers: { cookie: gerenteGimnasio } })).json();
    expect(s2.alcance).toBe('organization');
  });

  it('la captura se comprueba antes de registrar: dice el problema y no guarda nada (6-14)', async () => {
    const antes = await getDb().biometricEnrollment.count({ where: { organizationId: g.organizationId } });
    const bien = await app.inject({ method: 'POST', url: '/access/face/check', headers: { cookie: gerente }, payload: { branchId: sedeA, frames: cuadros(semillaNueva()) } });
    expect(bien.statusCode, bien.body).toBe(200);
    expect(bien.json()).toEqual({ ok: true, problema: null, cuadrosConRostro: 6, cuadrosDeFrente: 6 });
    // El motor recibió la captura de frente, sin reto.
    expect(recibidos.at(-1)).toMatchObject({ action: null, aggregate: true, frontal_only: true });

    const sinRostro = (await app.inject({ method: 'POST', url: '/access/face/check', headers: { cookie: gerente }, payload: { branchId: sedeA, frames: [`X${'x'.repeat(200)}`, `X${'x'.repeat(200)}`, `X${'x'.repeat(200)}`] } })).json();
    expect(sinRostro.ok).toBe(false);
    expect(sinRostro.problema).toMatch(/No se vio su rostro/);
    const dePerfil = (await app.inject({ method: 'POST', url: '/access/face/check', headers: { cookie: gerente }, payload: { branchId: sedeA, frames: [`P${'x'.repeat(200)}`, `P${'x'.repeat(200)}`, `P${'x'.repeat(200)}`] } })).json();
    expect(dePerfil).toMatchObject({ ok: false, cuadrosDeFrente: 1 });
    expect(dePerfil.problema).toMatch(/Mira de frente/);
    expect(await getDb().biometricEnrollment.count({ where: { organizationId: g.organizationId } })).toBe(antes);

    // La dueña consulta: no registra rostros, tampoco comprueba capturas.
    const duena = await app.inject({ method: 'POST', url: '/access/face/check', headers: { cookie: owner }, payload: { branchId: sedeA, frames: cuadros(1) } });
    expect(duena.statusCode).toBe(403);
  });

  it('el alta es de frente, sin reto y sin motivo, y queda entera o no queda (6-09, D6-06, 6-18)', async () => {
    const socio = await socioPropio(g);
    const semilla = semillaNueva();
    const alta = await registrar(socio, semilla);
    expect(alta.statusCode, alta.body).toBe(201);
    expect(alta.json()).toMatchObject({ modality: 'FACE', branchId: sedeA, consentVersion: 'bio-1' });
    expect(recibidos.at(-1)).toMatchObject({ action: null, aggregate: true, frontal_only: true });
    expect(await getDb().faceTemplate.findUnique({ where: { enrollmentId: alta.json().id } })).not.toBeNull();
    const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'access.biometric.enroll', resourceId: alta.json().id } });
    expect(asiento.reason).toBe('Registro de rostro en el mostrador');
    expect(await firmasVivas(socio)).toHaveLength(1);

    // Otra vez: no es «enrolar de nuevo», es Actualizar. Y la firma no se duplica ni queda huérfana.
    const otra = await registrar(socio, semillaNueva());
    expect(otra.statusCode, otra.body).toBe(409);
    expect(otra.json().message).toMatch(/Actualizar/);
    expect(await getDb().memberConsent.count({ where: { memberId: socio, consentType: 'BIOMETRIC' } })).toBe(1);

    // Con reto y motivo sigue funcionando como antes (quien todavía lo mande).
    const socio2 = await socioPropio(g);
    const conReto = await app.inject({ method: 'POST', url: `/members/${socio2}/biometric-enrollments/face`, headers: { cookie: gerente },
      payload: { branchId: sedeA, frames: cuadros(semillaNueva(), 3), reto: 'turn_left', reason: 'Alta en recepción' } });
    expect(conReto.statusCode, conReto.body).toBe(201);
    expect(recibidos.at(-1)).toMatchObject({ action: 'turn_left', aggregate: true });
    expect(recibidos.at(-1)!.frontal_only).toBeUndefined();

    // La pestaña sabe dónde vive la plantilla y qué texto firmó.
    const lista = (await app.inject({ method: 'GET', url: `/members/${socio}/biometric-enrollments`, headers: { cookie: gerente } })).json();
    expect(lista.enrollments[0]).toMatchObject({ templateKind: 'server', consentVersion: 'bio-1', revokedAt: null });
  });

  it('«Actualizar» sustituye el rostro en una operación y no retira el permiso (6-05)', async () => {
    const socio = await socioPropio(g);
    const vieja = semillaNueva(); const nueva = semillaNueva();
    const alta = (await registrar(socio, vieja)).json();
    expect((await estacion(vieja, sedeA)).json()).toMatchObject({ reconocido: true, memberId: socio });

    const r = await app.inject({ method: 'POST', url: `/biometric-enrollments/${alta.id}/renew`, headers: { cookie: gerente }, payload: { frames: cuadros(nueva) } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ replacedEnrollmentId: alta.id, consentVersion: 'bio-1', branchId: sedeA });
    expect(r.json().id).not.toBe(alta.id);

    const anterior = await getDb().biometricEnrollment.findUniqueOrThrow({ where: { id: alta.id } });
    expect(anterior.revokedAt).not.toBeNull();
    expect(anterior.revokedReason).toBe('Actualización de rostro');
    expect(anterior.templateDeletedAt).not.toBeNull();
    expect(await getDb().faceTemplate.findUnique({ where: { enrollmentId: alta.id } })).toBeNull();
    const actual = await getDb().biometricEnrollment.findUniqueOrThrow({ where: { id: r.json().id } });
    expect(actual.revokedAt).toBeNull();
    // La misma firma: no se volvió a firmar ni se retiró.
    expect(actual.consentId).toBe(anterior.consentId);
    expect(await firmasVivas(socio)).toHaveLength(1);

    // La cámara reconoce el rostro nuevo y ya no el anterior.
    expect((await estacion(nueva, sedeA)).json()).toMatchObject({ reconocido: true, memberId: socio });
    expect((await estacion(vieja, sedeA)).json().reconocido).toBe(false);

    // Lo ya sustituido no se actualiza otra vez; lo de otro gimnasio no existe.
    const repetir = await app.inject({ method: 'POST', url: `/biometric-enrollments/${alta.id}/renew`, headers: { cookie: gerente }, payload: { frames: cuadros(nueva) } });
    expect(repetir.statusCode).toBe(409);
    // Una captura mala no toca nada.
    const mala = await app.inject({ method: 'POST', url: `/biometric-enrollments/${r.json().id}/renew`, headers: { cookie: gerente }, payload: { frames: [`X${'x'.repeat(200)}`, `X${'x'.repeat(200)}`, `X${'x'.repeat(200)}`] } });
    expect(mala.statusCode).toBe(422);
    expect((await getDb().biometricEnrollment.findUniqueOrThrow({ where: { id: r.json().id } })).revokedAt).toBeNull();
  });

  it('por omisión el rostro vale donde se tomó; con FACE_RECOGNITION_SCOPE=organization, en todo el gimnasio y decide la puerta (5-16)', async () => {
    const socio = await socioPropio(g);
    const semilla = semillaNueva();
    expect((await registrar(socio, semilla, sedeA)).statusCode).toBe(201);

    // Hoy: en la otra sucursal no se le reconoce.
    expect((await estacion(semilla, sedeA)).json()).toMatchObject({ reconocido: true, memberId: socio });
    expect((await estacion(semilla, sedeB)).json().reconocido).toBe(false);

    // Con el alcance del gimnasio: se le reconoce en B y la regla de la puerta decide (no tiene plan: no pasa).
    const enB = (await estacion(semilla, sedeB, appGimnasio, gerenteGimnasio)).json();
    expect(enB, JSON.stringify(enB)).toMatchObject({ reconocido: true, memberId: socio, outcome: 'DENIED' });

    // Dos rostros de la MISMA persona (uno por sede) no se quitan la ventaja entre sí.
    expect((await registrar(socio, semilla, sedeB)).statusCode).toBe(201);
    expect((await estacion(semilla, sedeA, appGimnasio, gerenteGimnasio)).json()).toMatchObject({ reconocido: true, memberId: socio });
  });

  it('si el texto biométrico cambió, «Actualizar» pide leer y aceptar el vigente', async () => {
    const socio = await socioPropio(g);
    const alta = (await registrar(socio, semillaNueva())).json();
    const textos = new ConsentDocumentRepository(g.organizationId);
    const v2 = await textos.create({ consentType: 'BIOMETRIC', version: 'bio-2', title: 'Biométrico de prueba', bodyText: 'Texto biométrico de prueba, versión 2' });
    await textos.publish(v2.id, null);

    const nueva = semillaNueva();
    const sinLeer = await app.inject({ method: 'POST', url: `/biometric-enrollments/${alta.id}/renew`, headers: { cookie: gerente }, payload: { frames: cuadros(nueva) } });
    expect(sinLeer.statusCode).toBe(409);
    expect(sinLeer.json().reason).toBe('CONSENT_TEXT_CHANGED');
    expect((await getDb().biometricEnrollment.findUniqueOrThrow({ where: { id: alta.id } })).revokedAt).toBeNull();

    const leida = await app.inject({ method: 'POST', url: `/biometric-enrollments/${alta.id}/renew`, headers: { cookie: gerente }, payload: { frames: cuadros(nueva), documentVersion: 'bio-2' } });
    expect(leida.statusCode, leida.body).toBe(201);
    expect(leida.json().consentVersion).toBe('bio-2');
    const firmas = await firmasVivas(socio);
    expect(firmas.map((f) => f.documentVersion)).toContain('bio-2');
    const actual = await getDb().biometricEnrollment.findUniqueOrThrow({ where: { id: leida.json().id } });
    expect(firmas.find((f) => f.id === actual.consentId)?.documentVersion).toBe('bio-2');
  });

  it('las cifras de Biometría son reales (6-06)', async () => {
    const r = await app.inject({ method: 'GET', url: '/biometric-enrollments/summary', headers: { cookie: owner } });
    expect(r.statusCode, r.body).toBe(200);
    const vivos = await getDb().biometricEnrollment.count({ where: { organizationId: g.organizationId, revokedAt: null } });
    const s = r.json();
    expect(s.facesLive).toBe(vivos);
    expect(s.deviceLive).toBe(0);
    expect(s.membersWithFace).toBeLessThanOrEqual(vivos);
    expect(s.revokedLast30Days).toBeGreaterThanOrEqual(2);
    expect(s.byBranch.reduce((n: number, b: { facesLive: number }) => n + b.facesLive, 0)).toBe(vivos);
  });

  it('la medición guarda parecidos, no entradas; propone y no cambia nada (6-10)', async () => {
    const socio = await socioPropio(g);
    const semilla = semillaNueva();
    await registrar(socio, semilla);
    const decisionesAntes = await getDb().accessDecision.count({ where: { organizationId: g.organizationId } });

    const es = await app.inject({ method: 'POST', url: '/access/face/measurements', headers: { cookie: gerente },
      payload: { branchId: sedeA, frames: cuadros(semilla, 3), reto: 'turn_left', kind: 'MEMBER', memberId: socio } });
    expect(es.statusCode, es.body).toBe(200);
    expect(es.json()).toMatchObject({ ok: true, attempt: { kind: 'MEMBER', memberId: socio } });
    expect(es.json().attempt.ownScore).toBeGreaterThan(0.99);
    expect(es.json().attempt.bestOtherScore).toBeLessThan(0.9);
    expect(es.json().attempt.compared).toBeGreaterThan(1);

    const noEs = await app.inject({ method: 'POST', url: '/access/face/measurements', headers: { cookie: gerente },
      payload: { branchId: sedeA, frames: cuadros(semillaNueva(), 3), reto: 'turn_left', kind: 'STRANGER' } });
    expect(noEs.json()).toMatchObject({ ok: true, attempt: { kind: 'STRANGER', memberId: null, ownScore: null } });

    // Sin rostro: se dice, y no cuenta como intento.
    const nada = (await app.inject({ method: 'POST', url: '/access/face/measurements', headers: { cookie: gerente },
      payload: { branchId: sedeA, frames: [`X${'x'.repeat(200)}`], reto: 'turn_left', kind: 'STRANGER' } })).json();
    expect(nada.ok).toBe(false);
    // Un socio sin rostro no se mide como «es»; «es» sin socio no existe.
    const sinRostro = await socioPropio(g);
    expect((await app.inject({ method: 'POST', url: '/access/face/measurements', headers: { cookie: gerente }, payload: { branchId: sedeA, frames: cuadros(1, 3), kind: 'MEMBER', memberId: sinRostro } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/access/face/measurements', headers: { cookie: gerente }, payload: { branchId: sedeA, frames: cuadros(1, 3), kind: 'MEMBER' } })).statusCode).toBe(422);

    // No dejó entradas ni rechazos, y en la tabla solo hay números.
    expect(await getDb().accessDecision.count({ where: { organizationId: g.organizationId } })).toBe(decisionesAntes);
    const filas = await getDb().faceMeasurement.findMany({ where: { organizationId: g.organizationId } });
    expect(filas).toHaveLength(2);
    expect(Object.keys(filas[0]!).sort()).toEqual(['bestOtherScore', 'branchId', 'compared', 'createdAt', 'id', 'kind', 'memberId', 'organizationId', 'ownScore', 'recordedByUserId']);

    // La dueña lo consulta; no mide.
    const informe = await app.inject({ method: 'GET', url: '/access/face/measurements', headers: { cookie: owner } });
    expect(informe.statusCode, informe.body).toBe(200);
    expect(informe.json().attempts).toHaveLength(2);
    expect(informe.json().analysis).toMatchObject({ members: 1, strangers: 1, enough: false, currentThreshold: 0.38, membersNeeded: 30, strangersNeeded: 10 });
    expect((await app.inject({ method: 'POST', url: '/access/face/measurements', headers: { cookie: owner }, payload: { branchId: sedeA, frames: cuadros(1, 3), kind: 'STRANGER' } })).statusCode).toBe(403);

    // Descartar uno y empezar de nuevo.
    const uno = await app.inject({ method: 'POST', url: '/access/face/measurements/discard', headers: { cookie: gerente }, payload: { attemptId: es.json().attempt.id } });
    expect(uno.json()).toEqual({ discarded: 1 });
    const todos = await app.inject({ method: 'POST', url: '/access/face/measurements/discard', headers: { cookie: gerente }, payload: { all: true } });
    expect(todos.json()).toEqual({ discarded: 1 });
    expect(await getDb().faceMeasurement.count({ where: { organizationId: g.organizationId } })).toBe(0);
  });
});

describe('analizarMedicion (pura)', () => {
  const hoy = { umbral: 0.38, margen: 0.05 };
  const socio = (n: number, propio: number, ajeno: number): IntentoMedido => ({ kind: 'MEMBER', memberId: `socio-${n}`, ownScore: propio, bestOtherScore: ajeno });
  const ajeno = (s: number): IntentoMedido => ({ kind: 'STRANGER', memberId: null, ownScore: null, bestOtherScore: s });

  it('sin intentos de los dos tipos no propone nada', () => {
    const a = analizarMedicion([], hoy);
    expect(a).toMatchObject({ members: 0, strangers: 0, enough: false, suggestedThreshold: null, lowestOwn: null, highestOther: null });
    expect(a.verdict).toMatch(/Todavía no hay intentos/);
  });

  const medicionCompleta = (propioBase: number, ajenoTope: number) => [
    ...Array.from({ length: 30 }, (_, i) => socio(i, propioBase + (i % 5) * 0.05, 0.10 + (i % 4) * 0.03)),
    ...Array.from({ length: 10 }, (_, i) => ajeno(Math.min(ajenoTope, 0.12 + i * 0.02))),
  ];

  it('el umbral de hoy cae en la franja segura: se queda, no se propone bajarlo', () => {
    const a = analizarMedicion(medicionCompleta(0.62, 0.30), hoy);
    expect(a).toMatchObject({ members: 30, strangers: 10, enough: true, lowestOwn: 0.62, highestOther: 0.3 });
    // Franja: 0.30 + 0.05 = 0.35 … 0.62 − 0.05 = 0.57. Hoy 0.38 está dentro.
    expect(a).toMatchObject({ safeFrom: 0.35, safeTo: 0.57, suggestedThreshold: 0.38, suggestedFalseRejects: 0, currentFalseAccepts: 0, currentFalseRejects: 0 });
    expect(a.verdict).toMatch(/sirve.*No hace falta cambiarlo/);
    expect(a.verdict).not.toMatch(/no se da por medido/);
  });

  it('alguien ajeno se parece más que el umbral de hoy: propone subirlo al inicio de la franja', () => {
    const a = analizarMedicion([...medicionCompleta(0.62, 0.30), ajeno(0.41)], hoy);
    expect(a.currentFalseAccepts).toBe(1);
    expect(a).toMatchObject({ safeFrom: 0.46, safeTo: 0.57, suggestedThreshold: 0.46, suggestedFalseRejects: 0 });
    expect(a.verdict).toMatch(/es bajo.*subirlo a 0\.46/);
    const fila = a.table.find((f) => f.threshold === 0.4)!;
    expect(fila).toEqual({ threshold: 0.4, falseRejects: 0, falseAccepts: 1 });
  });

  it('el umbral de hoy deja fuera a socios: propone bajarlo solo hasta el final de la franja', () => {
    const a = analizarMedicion(medicionCompleta(0.40, 0.2), { umbral: 0.5, margen: 0.05 });
    // Franja: 0.25 … 0.35. Hoy 0.50 rechaza a los de 0.40 y 0.45.
    expect(a).toMatchObject({ safeFrom: 0.25, safeTo: 0.35, suggestedThreshold: 0.35, suggestedFalseRejects: 0 });
    expect(a.currentFalseRejects).toBe(12);
    expect(a.verdict).toMatch(/es alto.*bajar a 0\.35/);
  });

  it('sin franja (se traslapan): manda no confundir y dice a cuántos socios deja fuera', () => {
    const a = analizarMedicion([socio(1, 0.7, 0.2), socio(2, 0.44, 0.15), ajeno(0.41)], hoy);
    expect(a).toMatchObject({ safeFrom: 0.46, safeTo: null, suggestedThreshold: 0.46, suggestedFalseRejects: 1, currentFalseAccepts: 1 });
    expect(a.verdict).toMatch(/No hay un umbral que sirva para todos/);
    expect(a.verdict).toMatch(/1 de 2 intentos de socios no se reconocerían/);
    expect(a.verdict).toMatch(/no se da por medido/);
  });

  it('cuenta a los socios distintos, no los intentos, y la ventaja sobre el segundo', () => {
    const a = analizarMedicion([socio(1, 0.6, 0.57), socio(1, 0.65, 0.2), ajeno(0.1)], hoy);
    expect(a.members).toBe(1);
    expect(a.currentMarginFailures).toBe(1);
  });
});
