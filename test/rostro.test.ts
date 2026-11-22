import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * CÁMARA DE RECEPCIÓN COMO LECTOR (2026-10-09). El motor facial se simula: un
 * cuadro que empieza con "A" da un rostro, con "B" otro, con "X" ninguno.
 * Como el motor de GymFlow (auditoría 8, bloque 0.4), exige el token en
 * `X-Face-Token` en toda ruta y responde 401 sin él.
 */
const vector = (semilla: number) => { const v = Array.from({ length: 512 }, (_, i) => Math.sin((i + 1) * semilla)); const n = Math.hypot(...v); return v.map((x) => x / n); };
const cuadro = (letra: string) => letra + 'x'.repeat(200);
// Semilla propia de cada corrida: si otra prueba dejó en la misma sede una
// plantilla con el mismo vector, dos socios «idénticos» son ambiguos y la
// estación, con razón, no reconoce a ninguno (margen cero).
const SAL = Math.random() * 10;
const TOKEN = 'token-del-motor-en-las-pruebas-0123456789abcdef';

describe('rostro con la cámara de recepción', () => {
  let app: FastifyInstance; let motor: Server; let owner: string; let cen: string; let url: string;
  const recibidos: Array<string | undefined> = [];
  beforeAll(async () => {
    motor = createServer((req, res) => {
      let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        const token = req.headers['x-face-token'] as string | undefined;
        recibidos.push(token);
        if (token !== TOKEN) { res.statusCode = 401; return res.end(JSON.stringify({ detail: 'No autorizado' })); }
        if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', servicio: 'gymflow-motor-facial', model_loaded: true }));
        const { frames } = JSON.parse(body) as { frames: string[] };
        const l = frames[0]![0];
        if (l === 'X') return res.end(JSON.stringify({ ok: false, error: 'No se detectó ningún rostro', liveness_checked: false }));
        res.end(JSON.stringify({ ok: true, embedding: vector((l === 'A' ? 1.7 : 2.9) + SAL), liveness_checked: true, liveness_ok: true }));
      });
    }).listen(0);
    url = `http://127.0.0.1:${(motor.address() as { port: number }).port}`;
    app = await makeApp({ FACE_SIDECAR_URL: url, FACE_SIDECAR_TOKEN: TOKEN }); await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    const { demoBranches } = await orgFixtures();
    cen = demoBranches.find((b) => b.code === 'CEN')!.id;
  });
  afterAll(async () => { await app.close(); motor.close(); await closeDb(); });

  it('alta con la cámara, reconoce con evidencia, desconoce a otro y borra la plantilla al revocar', async () => {
    expect((await app.inject({ method: 'GET', url: '/access/face/status', headers: { cookie: owner } })).json()).toMatchObject({ disponible: true, motivo: null });
    const socio = await app.inject({ method: 'POST', url: '/members', headers: { cookie: owner },
      payload: { firstName: nombreUnico('Ros'), lastName: nombreUnico('Tro'), phoneE164: telefonoUnico(), homeBranchId: cen, consents: CONSENTIMIENTOS } });
    const memberId = socio.json().id as string;

    const alta = await app.inject({ method: 'POST', url: `/members/${memberId}/biometric-enrollments/face`, headers: { cookie: owner },
      payload: { branchId: cen, frames: [cuadro('A'), cuadro('A'), cuadro('A')], reto: 'turn_left', reason: 'Alta en recepción' } });
    expect(alta.statusCode, alta.body).toBe(201);
    const t = await getDb().faceTemplate.findUnique({ where: { enrollmentId: alta.json().id } });
    expect(t?.embeddingEncrypted).toBeTruthy();
    // Cifrada, no el vector en claro: el texto cifrado es base64 con separadores
    // «.», sin corchetes ni comas (un «0.» suelto también puede salir en base64).
    expect(t?.embeddingEncrypted).toMatch(/^v1\./);
    expect(t?.embeddingEncrypted).not.toMatch(/[[\],]/);

    const r = (await app.inject({ method: 'POST', url: '/access/face', headers: { cookie: owner }, payload: { branchId: cen, frames: [cuadro('A')], reto: 'turn_left' } })).json();
    expect(r, JSON.stringify(r)).toMatchObject({ reconocido: true, memberId });
    const d = await getDb().accessDecision.findUniqueOrThrow({ where: { id: r.decisionId } });
    expect(d.credentialKind).toBe('FACE');
    expect(d.matchScore).toBeGreaterThan(0.9);
    expect(d.livenessPassed).toBe(true);
    // La estación graba 10 cuadros en 3 s: la API los acepta (antes el tope de 8 la rechazaba con 422).
    const diez = await app.inject({ method: 'POST', url: '/access/face', headers: { cookie: owner }, payload: { branchId: cen, frames: Array.from({ length: 10 }, () => cuadro('A')), reto: 'turn_left' } });
    expect(diez.statusCode, diez.body).toBe(200);
    expect(diez.json()).toMatchObject({ reconocido: true, memberId });

    const otro = (await app.inject({ method: 'POST', url: '/access/face', headers: { cookie: owner }, payload: { branchId: cen, frames: [cuadro('B')], reto: 'turn_left' } })).json();
    expect(otro.reconocido === false || otro.memberId !== memberId).toBe(true);
    const nadie = (await app.inject({ method: 'POST', url: '/access/face', headers: { cookie: owner }, payload: { branchId: cen, frames: [cuadro('X')], reto: 'turn_left' } })).json();
    expect(nadie).toMatchObject({ reconocido: false, sinRostro: true });

    const rev = await app.inject({ method: 'POST', url: `/biometric-enrollments/${alta.json().id}/revoke`, headers: { cookie: owner }, payload: { reason: 'Lo pidió el socio' } });
    expect(rev.statusCode, rev.body).toBeLessThan(300);
    expect(await getDb().faceTemplate.findUnique({ where: { enrollmentId: alta.json().id } })).toBeNull();
    const e = await getDb().biometricEnrollment.findUniqueOrThrow({ where: { id: alta.json().id } });
    expect(e.templateDeletedAt).not.toBeNull();
    // La API mandó su token en cada llamada al motor.
    expect(recibidos.length).toBeGreaterThan(0);
    expect(recibidos.every((t) => t === TOKEN)).toBe(true);
  });

  it('motor apagado, token equivocado o sin token: se dice tal cual, nunca «no vi tu rostro»', async () => {
    // Un puerto donde ya no escucha nadie: el motor «apagado».
    const libre = createServer().listen(0);
    const apagado = `http://127.0.0.1:${(libre.address() as { port: number }).port}`;
    await new Promise((ok) => libre.close(ok));
    const socio = await app.inject({ method: 'POST', url: '/members', headers: { cookie: owner },
      payload: { firstName: nombreUnico('Mot'), lastName: nombreUnico('Or'), phoneE164: telefonoUnico(), homeBranchId: cen, consents: CONSENTIMIENTOS } });
    const memberId = socio.json().id as string;

    const casos = [
      { vars: { FACE_SIDECAR_URL: url, FACE_SIDECAR_TOKEN: 'otro-token-que-no-es-el-del-motor-0123456789' }, motivo: /rechazó el token de esta API/ },
      { vars: { FACE_SIDECAR_URL: url, FACE_SIDECAR_TOKEN: '' }, motivo: /pide su token y esta API no lo tiene/ },
      { vars: { FACE_SIDECAR_URL: apagado, FACE_SIDECAR_TOKEN: TOKEN }, motivo: /no está encendido en este equipo/ },
    ];
    for (const caso of casos) {
      const otra = await makeApp(caso.vars); await otra.ready();
      try {
        const cookie = await loginAs(otra, 'gerencia@demo.mx');
        const estado = (await otra.inject({ method: 'GET', url: '/access/face/status', headers: { cookie } })).json();
        expect(estado.disponible, JSON.stringify(caso.vars)).toBe(false);
        expect(estado.motivo).toMatch(caso.motivo);

        // La estación recibe el motivo como error, no un «no vi tu rostro».
        const lectura = await otra.inject({ method: 'POST', url: '/access/face', headers: { cookie }, payload: { branchId: cen, frames: [cuadro('A')], reto: 'turn_left' } });
        // 503 con su porqué estable (bloque 1.2; antes 422): no es un dato mal mandado.
        expect(lectura.statusCode, lectura.body).toBe(503);
        expect(lectura.json()).toMatchObject({ error: 'UNAVAILABLE', reason: 'FACE_ENGINE_DOWN' });
        expect(lectura.json().message).toMatch(caso.motivo);
        expect(lectura.json()).not.toHaveProperty('sinRostro');

        // El alta tampoco crea nada.
        const alta = await otra.inject({ method: 'POST', url: `/members/${memberId}/biometric-enrollments/face`, headers: { cookie },
          payload: { branchId: cen, frames: [cuadro('A'), cuadro('A'), cuadro('A')], reto: 'turn_left', reason: 'Alta en recepción' } });
        expect(alta.statusCode, alta.body).toBe(503);
        expect(alta.json().reason).toBe('FACE_ENGINE_DOWN');
        expect(alta.json().message).toMatch(caso.motivo);
      } finally {
        await otra.close();
      }
    }
    expect(await getDb().biometricEnrollment.count({ where: { memberId } })).toBe(0);
  });
});
