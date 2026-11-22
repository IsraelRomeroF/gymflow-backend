import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * ALTA DIGITAL.
 *
 * Lo que se prueba aquí no es "el formulario guarda": es que el formulario
 * público NO puede escribir en el padrón, que un texto en borrador no sirve
 * como evidencia, y que la firma conserva la hora del socio y no la del visto
 * bueno de recepción.
 */
describe('alta digital', () => {
  let app: FastifyInstance;
  let cookie: string;
  let branchId: string;
  let orgId: string;
  let version: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    cookie = await loginAs(app, 'gerencia@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    branchId = f.demoBranches[0]!.id;
    // El aviso y el reglamento VIGENTES del entorno (los deja `setup.ts`). Antes
    // esta prueba publicaba los suyos, y con eso retiraba los del entorno: desde
    // el bloque 1.10 una versión retirada ya no se firma (21-06) y el aviso no
    // se publica sin su lista de verificación (21-08, probado en privacidad-ciclo).
    version = CONSENTIMIENTOS[0]!.documentVersion;
    expect(CONSENTIMIENTOS[1]!.documentVersion).toBe(version);
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const borrador = (over: Record<string, unknown> = {}) => ({
    firstName: nombreUnico('Alta'),
    lastName: nombreUnico('Digital'),
    phone: telefonoUnico().slice(3),
    email: null,
    birthDate: '1994-03-08',
    emergencyContactName: 'Contacto Emergencia',
    emergencyContactPhone: '5511223344',
    memberSince: '2022-05-01',
    healthNotes: null,
    consents: [
      { consentType: 'PRIVACY_NOTICE', version, granted: true },
      { consentType: 'HOUSE_RULES', version, granted: true },
    ],
    ...over,
  });

  it('el formulario público entrega los textos vigentes sin sesión', async () => {
    const res = await app.inject({ method: 'GET', url: `/intake/${branchId}/form` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.branchName).toBeTruthy();
    expect(body.documents.map((d: { consentType: string }) => d.consentType))
      .toEqual(expect.arrayContaining(['PRIVACY_NOTICE', 'HOUSE_RULES']));
    expect(body.blockedBy).toEqual([]);
  });

  it('el envío público crea un BORRADOR, no un socio', async () => {
    const antes = await getDb().member.count({ where: { organizationId: orgId } });
    const res = await app.inject({ method: 'POST', url: `/intake/${branchId}`, payload: borrador() });
    expect(res.statusCode).toBe(201);
    const despues = await getDb().member.count({ where: { organizationId: orgId } });
    expect(despues).toBe(antes);
  });

  it('el envío no devuelve más que su acuse: no es un lector de datos ajenos', async () => {
    const res = await app.inject({ method: 'POST', url: `/intake/${branchId}`, payload: borrador() });
    // El folio son los últimos 6 del propio id (bloque 2.4, 9-06): no dice nada de nadie.
    expect(Object.keys(res.json()).sort()).toEqual(['folio', 'id', 'submittedAt']);
    expect(res.json().folio).toBe(res.json().id.replace(/-/g, '').slice(-6).toUpperCase());
  });

  it('rechaza el alta sin ningún medio de contacto', async () => {
    const res = await app.inject({
      method: 'POST', url: `/intake/${branchId}`,
      payload: borrador({ phone: null, email: null }),
    });
    expect(res.statusCode).toBe(422);
  });

  it('rechaza el alta sin los consentimientos obligatorios', async () => {
    const res = await app.inject({
      method: 'POST', url: `/intake/${branchId}`,
      payload: borrador({ consents: [{ consentType: 'PRIVACY_NOTICE', version, granted: true }] }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/consentimiento/i);
  });

  it('rechaza el alta si el socio dijo que NO a un consentimiento obligatorio', async () => {
    const res = await app.inject({
      method: 'POST', url: `/intake/${branchId}`,
      payload: borrador({
        consents: [
          { consentType: 'PRIVACY_NOTICE', version, granted: true },
          { consentType: 'HOUSE_RULES', version, granted: false },
        ],
      }),
    });
    expect(res.statusCode).toBe(422);
  });

  it('una sucursal inexistente devuelve 404, no una pista del tenant', async () => {
    const { uuidv7 } = await import('@gymflow/core');
    const res = await app.inject({ method: 'GET', url: `/intake/${uuidv7()}/form` });
    expect(res.statusCode).toBe(404);
  });

  it('aprobar crea el socio y conserva la HORA DE LA FIRMA, no la de la aprobación', async () => {
    const enviado = await app.inject({ method: 'POST', url: `/intake/${branchId}`, payload: borrador() });
    const intakeId = enviado.json().id;

    const revision = await app.inject({ method: 'GET', url: `/intakes/${intakeId}`, headers: { cookie } });
    expect(revision.statusCode).toBe(200);
    expect(revision.json().suggestion).toBe('NEW_MEMBER');

    const aprobado = await app.inject({
      method: 'POST', url: `/intakes/${intakeId}/approve`, headers: { cookie }, payload: {},
    });
    expect(aprobado.statusCode).toBe(201);
    const { memberId } = aprobado.json();

    const db = getDb();
    const intake = await db.memberIntake.findUniqueOrThrow({ where: { id: intakeId } });
    const consents = await db.memberConsent.findMany({ where: { memberId } });

    expect(consents.length).toBe(2);
    for (const c of consents) {
      // La firma ocurrió en el teléfono del socio, no cuando recepción miró la
      // bandeja. Si esto fuera `reviewedAt`, la evidencia diría que firmó en un
      // momento en que no estaba delante de nada.
      expect(c.grantedAt.getTime()).toBe(intake.submittedAt.getTime());
      expect(c.channel).toBe('SELF_SERVICE');
      expect(c.ip).toBe(intake.ip);
      // El TEXTO exacto que vio queda archivado con la firma.
      expect(c.documentText).toContain('Texto de prueba');
    }
  });

  /** Aprueba un borrador y devuelve el socio creado, leído de la base. */
  async function aprobar(over: Record<string, unknown> = {}) {
    const enviado = await app.inject({ method: 'POST', url: `/intake/${branchId}`, payload: borrador(over) });
    expect(enviado.statusCode, enviado.body).toBe(201);
    const aprobado = await app.inject({
      method: 'POST', url: `/intakes/${enviado.json().id}/approve`, headers: { cookie }, payload: {},
    });
    expect(aprobado.statusCode, aprobado.body).toBe(201);
    return getDb().member.findUniqueOrThrow({ where: { id: aprobado.json().memberId } });
  }

  it('recepción completa o corrige el alta antes de aprobar: la ficha toma lo corregido y el alta original no cambia', async () => {
    const enviado = await app.inject({ method: 'POST', url: `/intake/${branchId}`, payload: borrador({ emergencyContactName: undefined, emergencyContactPhone: undefined }) });
    expect(enviado.statusCode, enviado.body).toBe(201);
    const id = enviado.json().id;
    const malo = await app.inject({ method: 'POST', url: `/intakes/${id}/approve`, headers: { cookie }, payload: { corrections: { email: 'no-es-correo' } } });
    expect(malo.statusCode).toBe(422);
    const ok = await app.inject({
      method: 'POST', url: `/intakes/${id}/approve`, headers: { cookie },
      payload: { corrections: { lastName: 'Corregido Pérez', emergencyContactName: 'Mamá', emergencyContactPhone: '5512345678' } },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const socio = await getDb().member.findUniqueOrThrow({ where: { id: ok.json().memberId } });
    expect(socio.lastName).toBe('Corregido Pérez');
    expect(socio.emergencyContactName).toBe('Mamá');
    const original = await getDb().memberIntake.findUniqueOrThrow({ where: { id } });
    expect(original.lastName).not.toBe('Corregido Pérez');
    const bit = await getDb().auditLog.findFirstOrThrow({ where: { action: 'intake.approve', resourceId: id } });
    expect((bit.afterState as { corregido?: Record<string, unknown> }).corregido).toHaveProperty('lastName');
  });

  const versionSalud = async () => (await getDb().consentDocument.findFirstOrThrow({
    where: { organizationId: orgId, consentType: 'HEALTH_DATA', status: 'PUBLISHED' },
  })).version;

  /**
   * Antes se perdían al aprobar: la antigüedad que el socio declara es lo que
   * ADR-029 rescata del arranque en blanco, y el contacto de emergencia se
   * capturaba para nada.
   */
  it('aprobar conserva la antigüedad declarada y el contacto de emergencia', async () => {
    const socio = await aprobar({ memberSince: '2022-05-01' });
    expect(socio.joinedAt.toISOString().slice(0, 10)).toBe('2022-05-01');
    // Y es el mismo día visto desde México, no el 30 de abril.
    expect(socio.joinedAt.toLocaleDateString('en-CA', { timeZone: 'America/Tijuana' })).toBe('2022-05-01');
    expect(socio.emergencyContactName).toBe('Contacto Emergencia');
    expect(socio.emergencyContactPhone).toBe('+525511223344');

    const ficha = (await app.inject({ method: 'GET', url: `/members/${socio.id}`, headers: { cookie } })).json();
    expect(ficha.emergencyContactName).toBe('Contacto Emergencia');
  });

  it('una antigüedad en el futuro se rechaza desde el formulario', async () => {
    const res = await app.inject({ method: 'POST', url: `/intake/${branchId}`, payload: borrador({ memberSince: '2099-01-01' }) });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.json().detail)[0].field).toBe('memberSince');
  });

  it('la nota de salud SIN consentimiento de salud no se guarda en ningún lado', async () => {
    const enviado = await app.inject({
      method: 'POST', url: `/intake/${branchId}`, payload: borrador({ healthNotes: 'Asma leve' }),
    });
    const intake = await getDb().memberIntake.findUniqueOrThrow({ where: { id: enviado.json().id } });
    expect(intake.healthNotes).toBeNull();
  });

  it('con consentimiento, la nota de salud llega al socio y solo la lee quien tiene el permiso', async () => {
    const v = await versionSalud();
    const socio = await aprobar({
      healthNotes: 'Lesión de rodilla derecha',
      consents: [
        { consentType: 'PRIVACY_NOTICE', version, granted: true },
        { consentType: 'HOUSE_RULES', version, granted: true },
        { consentType: 'HEALTH_DATA', version: v, granted: true },
      ],
    });
    // En la base va cifrada (SEC-08); descifrada dice lo que escribió el socio.
    expect(socio.healthNotes).toMatch(/^enc:v1:/);
    const { descifrarSensible } = await import('../src/platform/sensitive.js');
    expect(descifrarSensible(socio.healthNotes)).toBe('Lesión de rodilla derecha');
    // Ya no se mezcla en las notas generales.
    expect(socio.notes).toBeNull();

    const dueño = await app.inject({ method: 'GET', url: `/members/${socio.id}/health`, headers: { cookie } });
    expect(dueño.json().healthNotes).toBe('Lesión de rodilla derecha');
    const recepcion = await loginAs(app, 'recepcion@demo.mx');
    const sinPermiso = await app.inject({ method: 'GET', url: `/members/${socio.id}/health`, headers: { cookie: recepcion } });
    expect(sinPermiso.statusCode).toBe(403);
    // Y la ficha general no la trae.
    const ficha = await app.inject({ method: 'GET', url: `/members/${socio.id}`, headers: { cookie: recepcion } });
    expect(ficha.body).not.toContain('rodilla');
  });

  it('recepción revisa el alta pero NO lee la nota de salud (solo sabe que existe)', async () => {
    const f = await orgFixtures();
    const cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
    const v = await versionSalud();
    const enviado = await app.inject({
      method: 'POST', url: `/intake/${cen}`,
      payload: borrador({
        healthNotes: 'Hipertensión controlada',
        consents: [
          { consentType: 'PRIVACY_NOTICE', version, granted: true },
          { consentType: 'HOUSE_RULES', version, granted: true },
          { consentType: 'HEALTH_DATA', version: v, granted: true },
        ],
      }),
    });
    expect(enviado.statusCode, enviado.body).toBe(201);
    const id = enviado.json().id;

    const recepcion = await loginAs(app, 'recepcion@demo.mx');
    const suya = (await app.inject({ method: 'GET', url: `/intakes/${id}`, headers: { cookie: recepcion } })).json();
    expect(suya.intake.healthNotes).toBeNull();
    expect(suya.intake.hasHealthNotes).toBe(true);

    const dueño = (await app.inject({ method: 'GET', url: `/intakes/${id}`, headers: { cookie } })).json();
    expect(dueño.intake.healthNotes).toBe('Hipertensión controlada');
  });

  it('recepción de Centro NO ve, abre ni aprueba altas de otra sucursal', async () => {
    const f = await orgFixtures();
    const nor = f.demoBranches.find((b) => b.code === 'NOR')!.id;
    const enviado = await app.inject({ method: 'POST', url: `/intake/${nor}`, payload: borrador() });
    const id = enviado.json().id;

    const recepcion = await loginAs(app, 'recepcion@demo.mx');
    const lista = (await app.inject({ method: 'GET', url: '/intakes?limit=200', headers: { cookie: recepcion } })).json();
    // `GET /intakes` viaja por páginas (bloque 1.6): los renglones van en `items`.
    expect(lista.items.some((i: { id: string }) => i.id === id)).toBe(false);
    expect(lista.items.every((i: { branchId: string }) => i.branchId !== nor)).toBe(true);

    const abrir = await app.inject({ method: 'GET', url: `/intakes/${id}`, headers: { cookie: recepcion } });
    expect(abrir.statusCode).toBe(403);
    const aprobar = await app.inject({ method: 'POST', url: `/intakes/${id}/approve`, headers: { cookie: recepcion }, payload: {} });
    expect(aprobar.statusCode).toBe(403);
  });

  it('"es la misma persona": el alta se vincula a la ficha existente y conserva sus firmas', async () => {
    const existente = await aprobar();
    const telNuevo = telefonoUnico().slice(3);
    const enviado = await app.inject({
      method: 'POST', url: `/intake/${branchId}`,
      payload: borrador({ firstName: existente.firstName, lastName: existente.lastName, phone: telNuevo, emergencyContactName: 'Nuevo Contacto' }),
    });
    const r = await app.inject({
      method: 'POST', url: `/intakes/${enviado.json().id}/link`, headers: { cookie }, payload: { memberId: existente.id },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().memberId).toBe(existente.id);

    const socio = await getDb().member.findUniqueOrThrow({ where: { id: existente.id } });
    expect(socio.phoneE164).toBe(`+52${telNuevo}`);
    expect(socio.emergencyContactName).toBe('Nuevo Contacto');
    const intake = await getDb().memberIntake.findUniqueOrThrow({ where: { id: enviado.json().id } });
    expect(intake.status).toBe('APPROVED');
    expect(intake.memberId).toBe(existente.id);
    // Sus firmas desde el teléfono quedan en la ficha con su canal real.
    const firmas = await getDb().memberConsent.findMany({ where: { memberId: existente.id, channel: 'SELF_SERVICE' } });
    expect(firmas.length).toBeGreaterThanOrEqual(4);
    // Y no se vincula dos veces.
    const otra = await app.inject({ method: 'POST', url: `/intakes/${enviado.json().id}/link`, headers: { cookie }, payload: { memberId: existente.id } });
    // 409 y con su porqué (bloque 2.4, 9-20): otra persona ya la decidió.
    expect(otra.statusCode).toBe(409);
    expect(otra.json().reason).toBe('INTAKE_ALREADY_REVIEWED');
  });

  it('aprobar dos veces no crea dos socios', async () => {
    const enviado = await app.inject({ method: 'POST', url: `/intake/${branchId}`, payload: borrador() });
    const intakeId = enviado.json().id;

    const primera = await app.inject({
      method: 'POST', url: `/intakes/${intakeId}/approve`, headers: { cookie }, payload: {},
    });
    expect(primera.statusCode).toBe(201);

    const segunda = await app.inject({
      method: 'POST', url: `/intakes/${intakeId}/approve`, headers: { cookie }, payload: {},
    });
    expect(segunda.statusCode).toBe(409);
    expect(segunda.json().reason).toBe('INTAKE_ALREADY_REVIEWED');
  });

  it('un alta que coincide con un socio existente NO se aprueba a ciegas', async () => {
    const datos = borrador();
    const primero = await app.inject({ method: 'POST', url: `/intake/${branchId}`, payload: datos });
    await app.inject({
      method: 'POST', url: `/intakes/${primero.json().id}/approve`, headers: { cookie }, payload: {},
    });

    // El mismo teléfono otra vez: es el caso REAL de una recaptura de padrón,
    // donde el socio rellena el formulario dos veces o ya lo registró
    // recepción. Fusionar mal junta dos historiales de cobro.
    const repetido = await app.inject({ method: 'POST', url: `/intake/${branchId}`, payload: datos });
    const revision = await app.inject({
      method: 'GET', url: `/intakes/${repetido.json().id}`, headers: { cookie },
    });
    expect(revision.json().suggestion).toBe('AUTO_LINK');
    expect(revision.json().matches.length).toBeGreaterThan(0);

    const aprobar = await app.inject({
      method: 'POST', url: `/intakes/${repetido.json().id}/approve`, headers: { cookie }, payload: {},
    });
    expect(aprobar.statusCode).toBe(422);
    expect(aprobar.json().message).toMatch(/coincide/i);
  });

  it('rechazar exige motivo y lo deja en la bitácora', async () => {
    const enviado = await app.inject({ method: 'POST', url: `/intake/${branchId}`, payload: borrador() });
    const intakeId = enviado.json().id;

    const sinMotivo = await app.inject({
      method: 'POST', url: `/intakes/${intakeId}/reject`, headers: { cookie }, payload: {},
    });
    expect(sinMotivo.statusCode).toBe(422);

    const conMotivo = await app.inject({
      method: 'POST', url: `/intakes/${intakeId}/reject`, headers: { cookie },
      payload: { reason: 'Datos evidentemente falsos' },
    });
    expect(conMotivo.statusCode).toBe(200);

    const entrada = await getDb().auditLog.findFirst({
      where: { action: 'intake.reject', resourceId: intakeId },
    });
    expect(entrada?.reason).toBe('Datos evidentemente falsos');
  });
});

describe('límites de la ruta pública', () => {
  it('el valor por defecto sigue siendo estricto, aunque las pruebas lo suban', async () => {
    const { loadEnv } = await import('../src/platform/env.js');
    const env = loadEnv({ ...process.env, NODE_ENV: 'test', INTAKE_SUBMIT_ATTEMPTS: undefined });
    // La suite manda decenas de formularios; bajar el límite real para que
    // quepan sería debilitar el control por comodidad. Se sube en `helpers`
    // y aquí se comprueba que lo que llega a producción sigue siendo bajo.
    expect(env.INTAKE_SUBMIT_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});

describe('textos de consentimiento', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    cookie = await loginAs(app, 'gerencia@demo.mx');
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('un documento nace en BORRADOR, nunca publicado', async () => {
    const res = await app.inject({
      method: 'POST', url: '/consent-documents', headers: { cookie },
      payload: {
        consentType: 'MARKETING', version: `b${Date.now()}`, title: 'Borrador',
        bodyText: 'Texto suficientemente largo para la validación de longitud.',
      },
    });
    expect(res.json().status).toBe('DRAFT');
  });

  it('publicar exige motivo', async () => {
    const creado = await app.inject({
      method: 'POST', url: '/consent-documents', headers: { cookie },
      payload: {
        consentType: 'MARKETING', version: `c${Date.now()}`, title: 'Sin motivo',
        bodyText: 'Texto suficientemente largo para la validación de longitud.',
      },
    });
    const res = await app.inject({
      method: 'POST', url: `/consent-documents/${creado.json().id}/publish`,
      headers: { cookie }, payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it('un PUBLICADO es inmutable: el texto firmado no se puede reescribir', async () => {
    const creado = await app.inject({
      method: 'POST', url: '/consent-documents', headers: { cookie },
      payload: {
        consentType: 'MARKETING', version: `d${Date.now()}`, title: 'Inmutable',
        bodyText: 'Texto original que el socio va a aceptar y que debe sobrevivir.',
      },
    });
    const id = creado.json().id;
    await app.inject({
      method: 'POST', url: `/consent-documents/${id}/publish`,
      headers: { cookie }, payload: { reason: 'Prueba de inmutabilidad' },
    });

    // Se intenta por la puerta de atrás, saltándose la API: es exactamente lo
    // que haría alguien con acceso a la base, y el trigger es lo que lo impide.
    await expect(
      getDb().consentDocument.update({ where: { id }, data: { bodyText: 'Texto cambiado' } }),
    ).rejects.toThrow(/inmutable|PUBLICADO/i);
  });

  it('publicar una versión nueva RETIRA la anterior: nunca hay dos vigentes', async () => {
    const tipo = 'MARKETING';
    const uno = await app.inject({
      method: 'POST', url: '/consent-documents', headers: { cookie },
      payload: {
        consentType: tipo, version: `e${Date.now()}`, title: 'Primera',
        bodyText: 'Texto de la primera versión, suficientemente largo.',
      },
    });
    await app.inject({
      method: 'POST', url: `/consent-documents/${uno.json().id}/publish`,
      headers: { cookie }, payload: { reason: 'Primera publicación' },
    });

    const dos = await app.inject({
      method: 'POST', url: '/consent-documents', headers: { cookie },
      payload: {
        consentType: tipo, version: `f${Date.now()}`, title: 'Segunda',
        bodyText: 'Texto de la segunda versión, suficientemente largo.',
      },
    });
    const publicada = await app.inject({
      method: 'POST', url: `/consent-documents/${dos.json().id}/publish`,
      headers: { cookie }, payload: { reason: 'Segunda publicación' },
    });
    expect(publicada.statusCode).toBe(200);

    // Acotado a ESTA organización: contar en toda la tabla hacía que la
    // prueba dependiera de lo que hubiera dejado cualquier otra.
    const vigentes = await getDb().consentDocument.count({
      where: { organizationId: (await orgFixtures()).demo.id, consentType: tipo, status: 'PUBLISHED' },
    });
    expect(vigentes).toBe(1);
  });
});

describe('enlace corto del alta (UXB-14)', () => {
  it('se abre con /alta/<enlace> y un enlace que no existe lo dice claro', async () => {
    const { makeApp: mk, loginAs: entrar, orgFixtures: fx, sedeDesechable: sede, archivarSede: archivar } = await import('./helpers.js');
    const app = await mk();
    await app.ready();
    const owner = await entrar(app, 'gerencia@demo.mx');
    const s = await sede((await fx()).demo.id, 'Sede del enlace');
    const slug = `prueba-${Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('')}`;
    expect((await app.inject({ method: 'PATCH', url: `/branches/${s.id}`, headers: { cookie: owner }, payload: { publicSlug: 'Con Espacios' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PATCH', url: `/branches/${s.id}`, headers: { cookie: owner }, payload: { publicSlug: slug } })).statusCode).toBe(200);
    const form = await app.inject({ method: 'GET', url: `/intake/${slug.toUpperCase()}/form` });
    expect(form.statusCode, form.body).toBe(200);
    expect(form.json().branchId).toBe(s.id);
    const nada = await app.inject({ method: 'GET', url: '/intake/no-existe-esta/form' });
    expect(nada.statusCode).toBe(404);
    expect(nada.json().message).toMatch(/no existe/);
    await archivar(s.id);
    await app.close();
  });
});
