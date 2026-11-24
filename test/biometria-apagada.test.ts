import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { CONSERVACION, MOTIVO_ROSTRO_BIOMETRIA_APAGADA, rostrosSeBorranAlApagar } from '@gymflow/core';
import { makeApp, loginAs, nombreUnico, telefonoUnico, CONSENTIMIENTOS } from './helpers.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { forgetModules } from '../src/platform/modules/module-state.js';
import { ModuleStateRepository } from '../src/platform/modules/module-state.repository.js';
import { ConsentDocumentRepository } from '../src/modules/members/index.js';
import { ConservacionService } from '../src/modules/privacy/index.js';

/**
 * FASE 3 · BLOQUE 3.12 (auditoría 8) · D-32, el paréntesis que faltaba:
 * «igual si se apaga Biometría, con aviso».
 *
 *  · Apagar Biometría (en todo el gimnasio o en una sucursal) con rostros
 *    guardados NO se puede sin confirmar el aviso con el número de rostros.
 *  · Confirmado, queda anotado qué día se borran (30 días después) y cuántos
 *    decía el aviso. Encender antes cancela el borrado.
 *  · El cierre diario los borra ese día, no antes, y se puede correr dos veces.
 *  · Un módulo que YA estaba apagado sin aviso (lo de antes de este cambio) no
 *    borra nada, nunca.
 *
 * Gimnasio propio en cada caso. El «ahora» del cierre se le pasa al servicio y
 * se deriva del día de borrado que quedó anotado: nada depende de la hora real.
 * El motor facial se simula: el cuadro `S<semilla>|…` da el rostro de esa semilla.
 */
const vector = (semilla: number) => { const v = Array.from({ length: 512 }, (_, i) => Math.sin((i + 1) * semilla)); const n = Math.hypot(...v); return v.map((x) => x / n); };
const cuadros = (semilla: number) => Array.from({ length: 3 }, () => `S${semilla}|${'x'.repeat(200)}`);
let siguiente = 11 + Math.random();
const semillaNueva = () => { siguiente += 0.731; return Number(siguiente.toFixed(4)); };
const DIA = 86_400_000;
/** Mediodía en la Ciudad de México de ese día de operación. */
const mediodia = (dia: Date) => new Date(dia.getTime() + 18 * 3_600_000);

type Borrado = { pending: boolean; count: number; on: string; warned: number | null } | null;
type Estado = { modules: Array<{ key: string; enabled: boolean; erasure?: Borrado; branches: Array<{ branchId: string; enabled: boolean; erasure?: Borrado }> }> };

describe('fase 3 · apagar Biometría borra los rostros a los 30 días, con aviso (3.12, D-32)', () => {
  let app: FastifyInstance; let motor: Server;
  const servicio = new ConservacionService();
  const abiertos: GimnasioPropio[] = [];

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
  afterAll(async () => {
    for (const g of abiertos) await g.cerrar();
    await app.close(); motor.close(); await closeDb();
  });

  /** Un gimnasio propio de dos sedes, con su texto biométrico publicado. */
  async function gimnasio() {
    const g = await gimnasioPropio({ sedes: [{ name: 'Sede A', cajas: 1 }, { name: 'Sede B', cajas: 1 }] });
    abiertos.push(g);
    const textos = new ConsentDocumentRepository(g.organizationId);
    const b = await textos.create({ consentType: 'BIOMETRIC', version: 'v1.0', title: 'Rostro (prueba)', bodyText: 'Texto de prueba BIOMETRIC' });
    await textos.publish(b.id, null);
    return { g, org: g.organizationId, a: g.sedes[0]!.id, b: g.sedes[1]!.id, gerente: await loginAs(app, g.correos.gerente), recepcion: await loginAs(app, g.correos.recepcion) };
  }
  async function conRostro(cookie: string, sede: string): Promise<{ memberId: string; enrollmentId: string }> {
    const alta = await app.inject({
      method: 'POST', url: '/members', headers: { cookie },
      payload: { firstName: nombreUnico('Apa'), lastName: nombreUnico('Gada'), phoneE164: telefonoUnico(), homeBranchId: sede, consents: CONSENTIMIENTOS },
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const memberId = alta.json().id as string;
    const r = await app.inject({ method: 'POST', url: `/members/${memberId}/biometric-enrollments/face`, headers: { cookie }, payload: { branchId: sede, frames: cuadros(semillaNueva()) } });
    expect(r.statusCode, r.body).toBe(201);
    return { memberId, enrollmentId: r.json().id as string };
  }
  const estado = async (cookie: string) => {
    const r = await app.inject({ method: 'GET', url: '/organization/modules', headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as Estado).modules.find((m) => m.key === 'biometrics')!;
  };
  const apagar = (cookie: string, cuerpo: Record<string, unknown> = {}) =>
    app.inject({ method: 'PUT', url: '/organization/modules/biometrics', headers: { cookie }, payload: { enabled: false, reason: 'Quitamos la cámara', ...cuerpo } });
  const encender = (cookie: string) => app.inject({ method: 'PUT', url: '/organization/modules/biometrics', headers: { cookie }, payload: { enabled: true } });
  const enSede = (cookie: string, sede: string, cuerpo: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/organization/modules/biometrics/branches/${sede}`, headers: { cookie }, payload: cuerpo });
  const rostros = (org: string, sede?: string) => getDb().faceTemplate.count({ where: { organizationId: org, ...(sede ? { branchId: sede } : {}) } });
  const fila = (org: string) => getDb().organizationModule.findUnique({ where: { organizationId_moduleKey: { organizationId: org, moduleKey: 'biometrics' } } });

  it('sin confirmar el aviso (o con otro número) no se apaga; el aviso dice cuántos rostros y qué día se borran', async () => {
    const { org, a, b, gerente } = await gimnasio();
    await conRostro(gerente, a); await conRostro(gerente, a); await conRostro(gerente, b);

    const antes = await estado(gerente);
    expect(antes.enabled).toBe(true);
    expect(antes.erasure).toMatchObject({ pending: false, count: 3, warned: null });
    expect(antes.branches.find((s) => s.branchId === a)!.erasure).toMatchObject({ pending: false, count: 2 });
    expect(antes.branches.find((s) => s.branchId === b)!.erasure).toMatchObject({ pending: false, count: 1 });

    for (const cuerpo of [{}, { erasureAcknowledged: 2 }, { erasureAcknowledged: 0 }]) {
      const r = await apagar(gerente, cuerpo);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().reason).toBe('MODULE_ERASURE_WARNING');
      expect(r.json().message).toMatch(/^Biometría tiene 3 rostros guardados: al apagarla dejan de reconocerse y se borran el \d{1,2} de \w+ de \d{4} si no se vuelve a encender\. Confirma el aviso para apagarla\.$/);
    }
    // No cambió nada: sigue encendida, con sus tres rostros y sin fecha de borrado.
    expect((await estado(gerente)).enabled).toBe(true);
    expect(await rostros(org)).toBe(3);
    expect((await fila(org))?.erasureOn ?? null).toBeNull();
    // El motivo sigue siendo obligatorio aunque el aviso venga confirmado.
    expect((await app.inject({ method: 'PUT', url: '/organization/modules/biometrics', headers: { cookie: gerente }, payload: { enabled: false, erasureAcknowledged: 3 } })).statusCode).toBe(422);
  });

  it('con el aviso confirmado queda la fecha; el cierre diario no borra antes, borra ese día y no repite', async () => {
    const { org, a, b, gerente } = await gimnasio();
    const uno = await conRostro(gerente, a); await conRostro(gerente, a); await conRostro(gerente, b);

    const r = await apagar(gerente, { erasureAcknowledged: 3 });
    expect(r.statusCode, r.body).toBe(200);
    const anotado = (await fila(org))!;
    expect(anotado).toMatchObject({ enabled: false, erasureWarned: 3, reason: 'Quitamos la cámara' });
    // 30 días después del día (del gimnasio) en que se apagó: la misma regla del núcleo.
    const apagadaEl = new Date(anotado.erasureOn!.getTime() - CONSERVACION.rostroDiasTrasLaBaja * DIA);
    expect(rostrosSeBorranAlApagar(apagadaEl).toISOString()).toBe(anotado.erasureOn!.toISOString());
    // Queda en la bitácora lo que el aviso decía, y es «Para revisar» (`settings.module.`).
    const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'settings.module.disable' }, orderBy: { chainSeq: 'desc' } });
    expect(asiento.afterState).toMatchObject({ module: 'biometrics', erasureWarned: 3, erasureOn: anotado.erasureOn!.toISOString().slice(0, 10) });
    // La pantalla lo sigue diciendo mientras esté apagada: cuántos quedan y cuándo se borran.
    forgetModules(org);
    expect((await estado(gerente)).erasure).toEqual({ pending: true, count: 3, on: anotado.erasureOn!.toISOString().slice(0, 10), warned: 3 });

    // Apagada, los rostros se guardan (sin usarse) hasta el día anotado.
    const vispera = await servicio.pasada(org, mediodia(new Date(anotado.erasureOn!.getTime() - DIA)));
    expect(vispera).toMatchObject({ rostrosBorrados: 0, rostrosPorBiometriaApagada: 0, rostrosEnEspera: 3, errores: [] });
    expect(await rostros(org)).toBe(3);

    const elDia = await servicio.pasada(org, mediodia(anotado.erasureOn!));
    expect(elDia).toMatchObject({ rostrosBorrados: 3, rostrosPorBiometriaApagada: 3, rostrosEnEspera: 0, errores: [] });
    expect(await rostros(org)).toBe(0);
    // Cada rostro deja su asiento (del sistema, con el motivo), su enrolamiento queda revocado y su permiso biométrico, retirado.
    const enr = await getDb().biometricEnrollment.findUniqueOrThrow({ where: { id: uno.enrollmentId } });
    expect(enr.revokedAt).not.toBeNull();
    expect(enr.templateDeletedAt).not.toBeNull();
    expect(await getDb().auditLog.count({ where: { organizationId: org, action: 'access.biometric.revoke', actorType: 'SYSTEM', reason: MOTIVO_ROSTRO_BIOMETRIA_APAGADA } })).toBe(3);
    expect(await getDb().memberConsent.count({ where: { memberId: uno.memberId, consentType: 'BIOMETRIC', granted: true, revokedAt: null } })).toBe(0);

    // Otra pasada, el mismo día o después: nada que borrar, ningún error.
    for (const cuando of [mediodia(anotado.erasureOn!), mediodia(new Date(anotado.erasureOn!.getTime() + 40 * DIA))]) {
      expect(await servicio.pasada(org, cuando)).toMatchObject({ rostrosBorrados: 0, rostrosPorBiometriaApagada: 0, errores: [] });
    }
    expect((await estado(gerente)).erasure).toMatchObject({ pending: true, count: 0 });
  });

  it('encenderla antes del plazo cancela el borrado: los rostros vuelven a reconocerse sin registrarlos otra vez', async () => {
    const { org, a, gerente } = await gimnasio();
    const s = await conRostro(gerente, a);
    expect((await apagar(gerente, { erasureAcknowledged: 1 })).statusCode).toBe(200);
    const anotado = (await fila(org))!;
    expect(anotado.erasureOn).not.toBeNull();

    forgetModules(org);
    expect((await encender(gerente)).statusCode).toBe(200);
    expect(await fila(org)).toMatchObject({ enabled: true, erasureOn: null, erasureWarned: null });
    // Ni el día que estaba anotado ni mucho después.
    for (const cuando of [mediodia(anotado.erasureOn!), mediodia(new Date(anotado.erasureOn!.getTime() + 90 * DIA))]) {
      expect((await servicio.pasada(org, cuando)).rostrosPorBiometriaApagada).toBe(0);
    }
    expect(await rostros(org)).toBe(1);
    expect((await getDb().biometricEnrollment.findUniqueOrThrow({ where: { id: s.enrollmentId } })).revokedAt).toBeNull();
    forgetModules(org);
    expect((await estado(gerente)).erasure).toMatchObject({ pending: false, count: 1 });
  });

  it('apagada en una sola sucursal: mismo aviso con los rostros de ahí, y solo esos se borran', async () => {
    const { org, a, b, gerente } = await gimnasio();
    await conRostro(gerente, a); await conRostro(gerente, a);
    const deB = await conRostro(gerente, b);

    const sinAviso = await enSede(gerente, a, { enabled: false, reason: 'Esta sede no tiene cámara' });
    expect(sinAviso.statusCode, sinAviso.body).toBe(409);
    expect(sinAviso.json().reason).toBe('MODULE_ERASURE_WARNING');
    expect(sinAviso.json().message).toContain('tiene 2 rostros guardados en Sede A');
    const r = await enSede(gerente, a, { enabled: false, reason: 'Esta sede no tiene cámara', erasureAcknowledged: 2 });
    expect(r.statusCode, r.body).toBe(200);
    const anotado = await getDb().branchModuleOverride.findUniqueOrThrow({ where: { branchId_moduleKey: { branchId: a, moduleKey: 'biometrics' } } });
    expect(anotado).toMatchObject({ enabled: false, erasureWarned: 2 });
    forgetModules(org);
    const visto = await estado(gerente);
    expect(visto.branches.find((s) => s.branchId === a)!.erasure).toMatchObject({ pending: true, count: 2, warned: 2 });
    expect(visto.branches.find((s) => s.branchId === b)!.erasure).toMatchObject({ pending: false, count: 1 });

    expect((await servicio.pasada(org, mediodia(new Date(anotado.erasureOn!.getTime() - DIA)))).rostrosPorBiometriaApagada).toBe(0);
    expect((await servicio.pasada(org, mediodia(anotado.erasureOn!))).rostrosPorBiometriaApagada).toBe(2);
    expect(await rostros(org, a)).toBe(0);
    expect(await rostros(org, b)).toBe(1);
    expect((await getDb().biometricEnrollment.findUniqueOrThrow({ where: { id: deB.enrollmentId } })).revokedAt).toBeNull();

    // Retomarla en la sucursal quita la fecha (ya no hay nada que borrar ahí, pero tampoco queda un aviso viejo).
    expect((await enSede(gerente, a, { enabled: true })).statusCode).toBe(200);
    expect(await getDb().branchModuleOverride.findUniqueOrThrow({ where: { branchId_moduleKey: { branchId: a, moduleKey: 'biometrics' } } })).toMatchObject({ enabled: true, erasureOn: null, erasureWarned: null });
  });

  it('LO QUE YA EXISTE: una Biometría apagada sin aviso (como todas las de antes de este cambio) no borra ningún rostro, nunca', async () => {
    const { org, a, gerente } = await gimnasio();
    await conRostro(gerente, a);
    // Así deja la fila el código anterior (y la migración): apagada, sin fecha de borrado.
    await new ModuleStateRepository(org).set('biometrics', false, null, 'Apagada antes del aviso');
    forgetModules(org);
    expect(await fila(org)).toMatchObject({ enabled: false, erasureOn: null, erasureWarned: null });
    for (const dias of [0, 31, 400]) {
      expect((await servicio.pasada(org, new Date(Date.UTC(2027, 0, 15, 18) + dias * DIA))).rostrosPorBiometriaApagada).toBe(0);
    }
    expect(await rostros(org)).toBe(1);
    // Y la pantalla no anuncia ningún borrado.
    expect((await estado(gerente)).erasure ?? null).toBeNull();
  });

  it('sin ningún rostro guardado se apaga como cualquier módulo: no hay aviso ni fecha; y solo la gerencia ve las cifras', async () => {
    const { org, gerente, recepcion } = await gimnasio();
    expect((await estado(gerente)).erasure ?? null).toBeNull();
    // Recepción recibe la lista de módulos para su menú, sin detalle.
    expect((await estado(recepcion)).erasure).toBeUndefined();
    const r = await apagar(gerente);
    expect(r.statusCode, r.body).toBe(200);
    expect(await fila(org)).toMatchObject({ enabled: false, erasureOn: null, erasureWarned: null });
  });
});
