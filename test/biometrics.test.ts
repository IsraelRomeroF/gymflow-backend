import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7, normalizedNameKey } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * ENROLAMIENTO BIOMÉTRICO (ADR-032).
 *
 * Lo que se prueba aquí no es que se guarde una fila: es que **la nube nunca
 * custodia una plantilla**, que no hay enrolamiento sin consentimiento, y que
 * revocar deja una obligación de borrado que alguien tiene que cumplir.
 */
describe('enrolamiento biométrico', () => {
  let app: FastifyInstance;
  let cookie: string;
  let orgId: string;
  let branchId: string;
  let otraSede: string;

  async function crearSocio(): Promise<string> {
    const nombre = nombreUnico('Bio');
    const row = await getDb().member.create({
      data: {
        id: uuidv7(), organizationId: orgId,
        memberCode: `BIO-${Date.now() % 1_000_000}-${Math.floor(Math.random() * 999)}`,
        firstName: nombre, lastName: nombreUnico('Metria'),
        nameKey: normalizedNameKey(`${nombre} metria`),
        homeBranchId: branchId, joinedAt: new Date(),
      },
    });
    return row.id;
  }

  const cuerpo = (over: Record<string, unknown> = {}) => ({
    modality: 'FACE',
    branchId,
    templateRef: `tpl_${uuidv7()}`,
    algorithmVendor: 'insightface/buffalo_sc',
    algorithmVersion: '0.7.3',
    reason: 'Alta del socio en el torniquete',
    ...over,
  });

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    cookie = await loginAs(app, 'gerencia@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    branchId = f.demoBranches[0]!.id;
    otraSede = f.demoBranches[1]!.id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('enrola y NO guarda ninguna plantilla, solo su referencia', async () => {
    const memberId = await crearSocio();
    const res = await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`,
      headers: { cookie }, payload: cuerpo(),
    });
    expect(res.statusCode, res.body).toBe(201);

    const row = await getDb().biometricEnrollment.findUniqueOrThrow({ where: { id: res.json().id } });
    // El vector vive en el equipo de la sucursal (ADR-014). Aquí no hay
    // ninguna columna donde pudiera caber, y eso es el diseño, no un olvido.
    expect(Object.keys(row)).not.toContain('template');
    expect(Object.keys(row)).not.toContain('embedding');
    expect(row.templateRef).toMatch(/^tpl_/);
    expect(row.algorithmVendor).toBe('insightface/buffalo_sc');
  });

  it('el enrolamiento EXIGE consentimiento biométrico, y lo crea primero', async () => {
    const memberId = await crearSocio();
    const res = await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`,
      headers: { cookie }, payload: cuerpo(),
    });

    const row = await getDb().biometricEnrollment.findUniqueOrThrow({ where: { id: res.json().id } });
    const consent = await getDb().memberConsent.findUniqueOrThrow({ where: { id: row.consentId } });

    // Aceptar el aviso de privacidad NO autoriza a tomar biometría: ADR-014
    // exige consentimiento expreso y separado.
    expect(consent.consentType).toBe('BIOMETRIC');
    expect(consent.granted).toBe(true);

    // Y queda firmado contra el texto PUBLICADO, no contra uno que mande el
    // mostrador: la constancia tiene que decir lo que el dueño publicó.
    const vigente = await getDb().consentDocument.findFirstOrThrow({
      where: { organizationId: orgId, consentType: 'BIOMETRIC', status: 'PUBLISHED' },
    });
    expect(consent.documentVersion).toBe(vigente.version);
    expect(consent.documentText).toBe(vigente.bodyText);
  });

  it('el texto lo pone el servidor: lo que mande el cliente se ignora', async () => {
    const memberId = await crearSocio();
    const res = await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`,
      headers: { cookie },
      payload: cuerpo({ consentVersion: 'inventada', consentText: 'Acepto lo que sea.' }),
    });
    expect(res.statusCode, res.body).toBe(201);

    const row = await getDb().biometricEnrollment.findUniqueOrThrow({ where: { id: res.json().id } });
    const consent = await getDb().memberConsent.findUniqueOrThrow({ where: { id: row.consentId } });
    expect(consent.documentVersion).not.toBe('inventada');
    expect(consent.documentText).not.toContain('Acepto lo que sea');
  });

  it('sin texto BIOMETRIC publicado no se enrola, y no queda consentimiento huérfano', async () => {
    // Otra organización, sin textos publicados: así la prueba no retira el
    // texto de la demo mientras otras corren.
    const f = await orgFixtures();
    const otraOrg = f.other.id;
    const sede = f.otherBranches[0]!.id;
    const socio = await getDb().member.create({
      data: {
        id: uuidv7(), organizationId: otraOrg,
        memberCode: `BIO-X-${Date.now() % 1_000_000}`,
        firstName: 'Sin', lastName: 'Texto', nameKey: normalizedNameKey('sin texto'),
        homeBranchId: sede, joinedAt: new Date(),
      },
    });
    const cookieOtra = await loginAs(app, 'gerencia@otro.mx');

    const res = await app.inject({
      method: 'POST', url: `/members/${socio.id}/biometric-enrollments`,
      headers: { cookie: cookieOtra }, payload: cuerpo({ branchId: sede }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/consentimiento biométrico publicado/i);
    expect(await getDb().memberConsent.count({ where: { memberId: socio.id } })).toBe(0);
  });

  it('exige motivo: enrolar biometría es una decisión, no una rutina', async () => {
    const memberId = await crearSocio();
    const res = await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`,
      headers: { cookie }, payload: { ...cuerpo(), reason: '' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('no admite DOS enrolamientos vivos en la misma sede y modalidad', async () => {
    const memberId = await crearSocio();
    await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`,
      headers: { cookie }, payload: cuerpo(),
    });

    const segundo = await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`,
      headers: { cookie }, payload: cuerpo(),
    });
    // Dos plantillas del mismo socio en el mismo equipo = nadie sabe cuál
    // está en uso ni cuál hay que borrar.
    expect(segundo.statusCode).toBe(409);
    expect(segundo.json().message).toMatch(/ya tiene un enrolamiento vivo/i);
  });

  it('pero SÍ en otra sucursal: es la consecuencia de que la plantilla no viaje', async () => {
    const memberId = await crearSocio();
    const uno = await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`,
      headers: { cookie }, payload: cuerpo(),
    });
    const dos = await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`,
      headers: { cookie }, payload: cuerpo({ branchId: otraSede }),
    });
    expect(uno.statusCode).toBe(201);
    expect(dos.statusCode).toBe(201);
  });

  it('revocar deja una obligación de borrado que alguien tiene que cumplir', async () => {
    const memberId = await crearSocio();
    const alta = await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`,
      headers: { cookie }, payload: cuerpo(),
    });
    const id = alta.json().id;

    const revocado = await app.inject({
      method: 'POST', url: `/biometric-enrollments/${id}/revoke`,
      headers: { cookie }, payload: { reason: 'El socio retiró su consentimiento' },
    });
    expect(revocado.statusCode).toBe(200);

    const pendientes = await app.inject({
      method: 'GET', url: '/biometric-enrollments/pending-deletion', headers: { cookie },
    });
    const todas = [...pendientes.json().overdue, ...pendientes.json().waiting];
    expect(todas.map((e: { id: string }) => e.id)).toContain(id);

    // Hasta que la SUCURSAL confirme, la obligación sigue abierta.
    const confirmado = await app.inject({
      method: 'POST', url: `/biometric-enrollments/${id}/template-deleted`, headers: { cookie },
    });
    expect(confirmado.statusCode).toBe(200);

    const despues = await app.inject({
      method: 'GET', url: '/biometric-enrollments/pending-deletion', headers: { cookie },
    });
    const restantes = [...despues.json().overdue, ...despues.json().waiting];
    expect(restantes.map((e: { id: string }) => e.id)).not.toContain(id);
  });

  it('no se puede confirmar el borrado de un enrolamiento VIVO', async () => {
    const memberId = await crearSocio();
    const alta = await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`,
      headers: { cookie }, payload: cuerpo(),
    });
    const res = await app.inject({
      method: 'POST', url: `/biometric-enrollments/${alta.json().id}/template-deleted`,
      headers: { cookie },
    });
    // Si se pudiera, el socio dejaría de ser reconocido sin que nada lo
    // explicara.
    expect(res.statusCode).toBe(409);
  });

  it('revocar exige motivo, y revocar dos veces no', async () => {
    const memberId = await crearSocio();
    const alta = await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`,
      headers: { cookie }, payload: cuerpo(),
    });
    const id = alta.json().id;

    const sinMotivo = await app.inject({
      method: 'POST', url: `/biometric-enrollments/${id}/revoke`, headers: { cookie }, payload: {},
    });
    expect(sinMotivo.statusCode).toBe(422);

    await app.inject({
      method: 'POST', url: `/biometric-enrollments/${id}/revoke`,
      headers: { cookie }, payload: { reason: 'Baja del socio' },
    });
    const otraVez = await app.inject({
      method: 'POST', url: `/biometric-enrollments/${id}/revoke`,
      headers: { cookie }, payload: { reason: 'Otra vez' },
    });
    expect(otraVez.statusCode).toBe(409);
  });

  it('el listado dice qué le falta a cada enrolamiento para servir', async () => {
    const memberId = await crearSocio();
    await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`,
      headers: { cookie }, payload: cuerpo(),
    });

    const res = await app.inject({
      method: 'GET', url: `/members/${memberId}/biometric-enrollments`, headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enrollments[0].gaps).toEqual([]);
    // Y no expone nada que se parezca a una plantilla.
    expect(res.body).not.toContain('templateRef');
  });

  it('la bitácora registra quién enroló, a quién y con qué consentimiento', async () => {
    const memberId = await crearSocio();
    const alta = await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`,
      headers: { cookie }, payload: cuerpo({ reason: 'Enrolamiento en mostrador' }),
    });

    const entrada = await getDb().auditLog.findFirstOrThrow({
      where: { action: 'access.biometric.enroll', resourceId: alta.json().id },
    });
    expect(entrada.reason).toBe('Enrolamiento en mostrador');
    expect(entrada.actorUserId).toBeTruthy();
    // La referencia de la plantilla NO entra a la bitácora.
    expect(JSON.stringify(entrada.afterState)).not.toContain('tpl_');
  });
});
