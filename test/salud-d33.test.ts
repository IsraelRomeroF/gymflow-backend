import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ADJUSTABLE_BY_ROLE, PERMISSIONS, ROLE_BY_KEY } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, cuentaDePrueba, sedeDesechable, archivarSede, asignarAlCoach, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { descifrarSensible } from '../src/platform/sensitive.js';
import { registeredRoutes } from '../src/platform/http/registry.js';

/**
 * DATOS DE SALUD (auditoría 8, fase 4, bloque 4.7; decisión D-33 (d): «no por ahora»).
 *
 * Lo único de salud que el sistema guarda es LA NOTA DEL ALTA: la que escribe
 * quien se inscribe por QR (con su consentimiento de datos de salud) o la que
 * dicta el tutor de un menor al firmar en el mostrador. No hay peso, medidas
 * ni valoración del coach, y nadie la corrige después. Aquí está escrito
 * quién la lee, quién la escribe y que nada promete más:
 *
 *  LEE     la gerencia · el coach, de sus socios asignados · recepción no (por
 *          su puesto), salvo la persona a quien la gerencia se lo enciende · la
 *          dueña tampoco por su puesto (consulta cifras, no fichas).
 *  ESCRIBE el socio en su alta por QR · quien aprueba el alta de un menor Y
 *          puede leerla (la dicta su tutor). Recepción, con su puesto, registra
 *          el permiso del tutor pero no teclea la nota (choque 6 del consolidado).
 *  BORRA   retirar el consentimiento de datos de salud, y anonimizar.
 */
describe('salud: solo la nota del alta (D-33)', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let recepcion: string;
  let coach: string;
  let orgId: string;
  let sede: { id: string; code: string };
  let version: string;
  let versionSalud: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    coach = await loginAs(app, 'coach@demo.mx');
    orgId = (await orgFixtures()).demo.id;
    sede = await sedeDesechable(orgId, 'Salud');
    version = CONSENTIMIENTOS[0]!.documentVersion;
    versionSalud = (await getDb().consentDocument.findFirstOrThrow({ where: { organizationId: orgId, consentType: 'HEALTH_DATA', status: 'PUBLISHED' } })).version;
  });
  afterAll(async () => {
    await getDb().memberIntake.updateMany({ where: { branchId: sede.id, status: 'SUBMITTED' }, data: { status: 'REJECTED', rejectionReason: 'Fin de la prueba', reviewedAt: new Date() } });
    await archivarSede(sede.id);
    await app.close();
    await closeDb();
  });

  const pedir = (cookie: string | null, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, ...(cookie ? { headers: { cookie } } : {}), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
  const naceHace = (n: number) => { const [a, m] = hoy().split('-').map(Number) as [number, number]; const mes = m > 1 ? m - 1 : 12; return `${m > 1 ? a - n : a - n - 1}-${String(mes).padStart(2, '0')}-01`; };
  const firmas = [{ consentType: 'PRIVACY_NOTICE', version: '', granted: true }, { consentType: 'HOUSE_RULES', version: '', granted: true }];
  async function altaPorQr(over: Record<string, unknown> = {}): Promise<string> {
    const r = await pedir(null, 'POST', `/intake/${sede.id}`, {
      firstName: nombreUnico('Alta'), lastName: nombreUnico('Salud'), phone: telefonoUnico().slice(3), email: null,
      birthDate: '1994-03-08', emergencyContactName: null, emergencyContactPhone: null, memberSince: null, healthNotes: null, adult: true,
      consents: firmas.map((f) => ({ ...f, version })), ...over,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }
  const menor = () => altaPorQr({ adult: false, birthDate: naceHace(16), guardianName: 'Tutora De Prueba', guardianPhone: telefonoUnico().slice(3) });
  const notaEnFicha = async (memberId: string) => descifrarSensible((await getDb().member.findUniqueOrThrow({ where: { id: memberId }, select: { healthNotes: true } })).healthNotes);
  /** Una cuenta de recepción de la sede de la prueba; con `ve`, la gerencia le encendió «Ver la nota de salud». */
  async function recepcionista(ve: boolean): Promise<string> {
    const correo = await cuentaDePrueba(orgId, 'RECEPTION', [sede.id]);
    if (ve) await getDb().user.updateMany({ where: { email: correo }, data: { permissionOverrides: { add: ['members:health:read'], remove: [] } } });
    return loginAs(app, correo);
  }

  // ── El permiso y lo que promete ───────────────────────────────────────────

  it('el permiso dice lo que pasa: «Ver la nota de salud del socio»; no hay permiso de escribirla ni nada de peso, medidas o valoración', () => {
    const catalogo = PERMISSIONS as ReadonlyArray<{ key: string; description: string }>;
    const deSalud = catalogo.filter((p) => /health|salud|medid|peso|measure|weight|progress|valoraci/i.test(`${p.key} ${p.description}`));
    expect(deSalud.map((p) => `${p.key} · ${p.description}`)).toEqual(['members:health:read · Ver la nota de salud del socio']);
  });

  it('quién lo tiene: gerencia y coach por su puesto; recepción y la dueña no, y a recepción solo se le enciende por persona', () => {
    const de = (puesto: string) => ROLE_BY_KEY.get(puesto)!.permissions as readonly string[];
    for (const puesto of ['MANAGER', 'COACH']) expect(de(puesto), puesto).toContain('members:health:read');
    for (const puesto of ['RECEPTION', 'OWNER']) expect(de(puesto), puesto).not.toContain('members:health:read');
    const ajustable = (puesto: 'RECEPTION' | 'COACH') => ADJUSTABLE_BY_ROLE[puesto].flatMap((g) => g.permissions);
    // A recepción se le puede encender por persona (queda en la bitácora, con motivo); al coach se le puede quitar.
    expect(ajustable('RECEPTION')).toContain('members:health:read');
    expect(ajustable('COACH')).toContain('members:health:read');
  });

  it('ninguna ruta promete más: no hay rutas de medidas, peso, progreso ni valoración, y la única de salud es de lectura', () => {
    const rutas = registeredRoutes().map((r) => `${r.method} ${r.url}`);
    // `/access/face/measurements…` es la medición del MOTOR FACIAL (calidad de la cámara), no del cuerpo de nadie.
    const sospechosas = rutas.filter((r) => /measure|medid|weight|peso|progress|valoraci|assessment|body/i.test(r) && !r.includes(' /access/face/measurements'));
    // El avance de la rutina («día hecho») no es un dato de salud: es qué día de su rutina marcó el socio.
    expect(sospechosas).toEqual([]);
    expect(rutas.filter((r) => /health/i.test(r)).sort()).toEqual(['GET /health', 'GET /health/ready', 'GET /members/:id/health'].filter((r) => rutas.includes(r)).sort());
    expect(rutas).toContain('GET /members/:id/health');
    const conPermisoDeSalud = registeredRoutes().filter((r) => r.security.kind === 'permission' && [r.security.permission, ...(r.security.anyOf ?? [])].includes('members:health:read'));
    expect(conPermisoDeSalud.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /members/:id/health']);
  });

  it('en el código, la nota de salud solo se escribe desde el alta (y se borra al retirar el permiso o anonimizar)', () => {
    const archivos = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? archivos(p) : p.endsWith('.ts') ? [p] : []; });
    const raiz = join(process.cwd(), 'src');
    const conNota = archivos(raiz).filter((f) => /healthNotes/.test(readFileSync(f, 'utf8'))).map((f) => relative(raiz, f)).sort();
    // Si aparece un archivo nuevo aquí, alguien más lee o escribe la nota: que venga a decir quién y con qué permiso.
    expect(conNota).toEqual([
      'modules/intake/intake.repository.ts', 'modules/intake/intake.routes.ts', 'modules/intake/intake.service.ts',
      'modules/members/consent.service.ts', 'modules/members/health.routes.ts', 'modules/members/member.repository.ts',
      'modules/privacy/privacy.service.ts',
    ]);
  });

  // ── Quién la lee ──────────────────────────────────────────────────────────

  it('la leen la gerencia y el coach del socio, con rastro; recepción no, ni el coach de otro', async () => {
    const id = await altaPorQr({ healthNotes: 'Operada de la rodilla derecha', consents: [...firmas.map((f) => ({ ...f, version })), { consentType: 'HEALTH_DATA', version: versionSalud, granted: true }] });
    // Recepción aprueba: la nota que escribió la socia pasa a su ficha sin que recepción la vea ni la teclee.
    const deLaSede = await recepcionista(false);
    const detalle = (await pedir(deLaSede, 'GET', `/intakes/${id}`)).json();
    expect(detalle.intake).toMatchObject({ healthNotes: null, hasHealthNotes: true });
    const aprobada = await pedir(deLaSede, 'POST', `/intakes/${id}/approve`, { force: true });
    expect(aprobada.statusCode, aprobada.body).toBe(201);
    const memberId = aprobada.json().memberId as string;
    expect(await notaEnFicha(memberId)).toBe('Operada de la rodilla derecha');

    const antes = await getDb().auditLog.count({ where: { organizationId: orgId, action: 'health.read', resourceId: memberId } });
    const deGerencia = await pedir(gerencia, 'GET', `/members/${memberId}/health`);
    expect(deGerencia.statusCode).toBe(200);
    expect(deGerencia.json()).toEqual({ healthNotes: 'Operada de la rodilla derecha' });
    expect(await getDb().auditLog.count({ where: { organizationId: orgId, action: 'health.read', resourceId: memberId } })).toBe(antes + 1);

    expect((await pedir(recepcion, 'GET', `/members/${memberId}/health`)).statusCode).toBe(403);
    expect((await pedir(deLaSede, 'GET', `/members/${memberId}/health`)).statusCode).toBe(403);
    // La persona de recepción a quien la gerencia se lo encendió, sí (como hoy).
    expect((await pedir(await recepcionista(true), 'GET', `/members/${memberId}/health`)).statusCode).toBe(200);

    // El coach: solo de quien tiene asignado.
    expect([403, 404]).toContain((await pedir(coach, 'GET', `/members/${memberId}/health`)).statusCode);
    await asignarAlCoach(memberId);
    expect((await pedir(coach, 'GET', `/members/${memberId}/health`)).json()).toEqual({ healthNotes: 'Operada de la rodilla derecha' });
    // Y la ficha normal no la trae para nadie: va aparte, por su ruta.
    expect(JSON.stringify((await pedir(gerencia, 'GET', `/members/${memberId}`)).json())).not.toContain('rodilla');
  });

  // ── Quién la escribe ──────────────────────────────────────────────────────

  it('nadie la escribe ni la corrige desde la ficha: ni en el alta del mostrador, ni al editar, ni la gerencia', async () => {
    const alta = await pedir(await recepcionista(false), 'POST', '/members', {
      firstName: nombreUnico('Mostrador'), lastName: nombreUnico('Salud'), phoneE164: telefonoUnico(), homeBranchId: sede.id, force: true,
      consents: CONSENTIMIENTOS, healthNotes: 'Escrita en el mostrador',
    });
    // La API no conoce ese campo: o lo ignora o rechaza la petición, pero no lo guarda.
    expect([201, 422], alta.body).toContain(alta.statusCode);
    if (alta.statusCode === 201) expect(await notaEnFicha(alta.json().id)).toBeNull();

    const socia = await pedir(gerencia, 'POST', '/members', { firstName: nombreUnico('Editar'), lastName: nombreUnico('Salud'), phoneE164: telefonoUnico(), homeBranchId: sede.id, force: true, consents: CONSENTIMIENTOS });
    expect(socia.statusCode, socia.body).toBe(201);
    const cambio = await pedir(gerencia, 'PATCH', `/members/${socia.json().id}`, { healthNotes: 'Escrita por la gerencia' });
    expect([200, 422]).toContain(cambio.statusCode);
    expect(await notaEnFicha(socia.json().id)).toBeNull();
    for (const [metodo, url] of [['POST', `/members/${socia.json().id}/health`], ['PATCH', `/members/${socia.json().id}/health`]] as const) {
      expect((await pedir(gerencia, metodo, url, { healthNotes: 'x' })).statusCode, `${metodo} ${url}`).toBe(404);
    }
  });

  it('la nota de un menor la dicta su tutor y la teclea quien puede leerla: recepción registra el permiso, no la nota', async () => {
    const tutor = (nota?: string) => ({ guardian: { name: 'Tutora Presente', healthConsent: true, ...(nota ? { healthNotes: nota } : {}) }, force: true });
    const deRecepcion = await recepcionista(false);

    // Recepción con la nota: no pasa, y el alta sigue por revisar (no se aprobó a medias).
    const a = await menor();
    const negada = await pedir(deRecepcion, 'POST', `/intakes/${a}/approve`, tutor('Asma leve'));
    expect(negada.statusCode, negada.body).toBe(403);
    expect(negada.json().detail).toMatch(/la escribe quien puede verla/);
    expect((await getDb().memberIntake.findUniqueOrThrow({ where: { id: a } })).status).toBe('SUBMITTED');

    // Recepción sin la nota: aprueba, y el permiso del tutor para datos de salud queda firmado.
    const sinNota = await pedir(deRecepcion, 'POST', `/intakes/${a}/approve`, tutor());
    expect(sinNota.statusCode, sinNota.body).toBe(201);
    expect(await notaEnFicha(sinNota.json().memberId)).toBeNull();
    const permiso = await getDb().memberConsent.findFirst({ where: { memberId: sinNota.json().memberId, consentType: 'HEALTH_DATA', granted: true } });
    expect(permiso, 'el permiso de datos de salud que dio el tutor').toBeTruthy();

    // La gerencia, que puede leerla, sí la teclea.
    const b = await menor();
    const deGerencia = await pedir(gerencia, 'POST', `/intakes/${b}/approve`, tutor('Asma leve'));
    expect(deGerencia.statusCode, deGerencia.body).toBe(201);
    expect(await notaEnFicha(deGerencia.json().memberId)).toBe('Asma leve');

    // Y la persona de recepción a quien la gerencia le encendió verla.
    const c = await menor();
    const autorizada = await pedir(await recepcionista(true), 'POST', `/intakes/${c}/approve`, tutor('Alergia al látex'));
    expect(autorizada.statusCode, autorizada.body).toBe(201);
    expect(await notaEnFicha(autorizada.json().memberId)).toBe('Alergia al látex');

    // Vincular a una ficha que ya existía sigue la misma regla.
    const d = await menor();
    const ficha = await pedir(gerencia, 'POST', '/members', { firstName: nombreUnico('Ya'), lastName: nombreUnico('Existia'), phoneE164: telefonoUnico(), homeBranchId: sede.id, force: true, consents: CONSENTIMIENTOS });
    expect(ficha.statusCode, ficha.body).toBe(201);
    expect((await pedir(deRecepcion, 'POST', `/intakes/${d}/link`, { memberId: ficha.json().id, ...tutor('Asma leve') })).statusCode).toBe(403);
    expect(await notaEnFicha(ficha.json().id)).toBeNull();
  });
});
