import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, CONSENTIMIENTOS, sedeDesechable, archivarSede, asignarAlCoach } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { descifrarSensible } from '../src/platform/sensitive.js';

/**
 * ALTAS (auditoría 8, fase 3, bloque 3.4).
 *
 * D-09: dos socios pueden compartir celular si se anota quién responde por el
 * número, y compartir no mezcla a dos personas. D-10: un menor de 15 a 17 por
 * QR queda «falta su tutor»; se aprueba cuando el tutor firma en el mostrador,
 * la aceptación queda a nombre del tutor y sin ella no hay nota de salud.
 * D-11: el alta mínima pide un medio de contacto y recepción solo llena lo vacío.
 */
describe('altas (3.4)', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let recepcion: string;
  let coach: string;
  let orgId: string;
  let cen: string;
  let sede: { id: string; code: string };
  let version: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    coach = await loginAs(app, 'coach@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
    sede = await sedeDesechable(orgId, 'Altas fase tres');
    version = CONSENTIMIENTOS[0]!.documentVersion;
  });

  afterAll(async () => {
    await getDb().memberIntake.updateMany({ where: { branchId: sede.id, status: 'SUBMITTED' }, data: { status: 'REJECTED', rejectionReason: 'Fin de la prueba', reviewedAt: new Date() } });
    await archivarSede(sede.id);
    await app.close();
    await closeDb();
  });

  const pedir = (method: 'POST' | 'PUT' | 'PATCH', url: string, cookie: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const post = (url: string, cookie: string, payload?: unknown) => pedir('POST', url, cookie, payload);
  const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  /** El «hoy» de la sede (CDMX), no el de UTC: de noche ya es mañana allá. */
  const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
  /** Una fecha de nacimiento de alguien que hoy tiene `n` años cumplidos (cumplió hace un mes largo). */
  const naceHace = (n: number) => { const [a, m] = hoy().split('-').map(Number) as [number, number]; const mes = m > 1 ? m - 1 : 12; return `${m > 1 ? a - n : a - n - 1}-${String(mes).padStart(2, '0')}-01`; };

  type Socio = { id: string; memberCode: string; firstName: string; lastName: string; phoneE164: string };
  const alta = (over: Record<string, unknown> = {}, cookie = recepcion) =>
    post('/members', cookie, { firstName: nombreUnico('Persona'), lastName: nombreUnico('Altas'), phoneE164: telefonoUnico(), homeBranchId: cen, consents: CONSENTIMIENTOS, ...over });
  async function socio(over: Record<string, unknown> = {}, cookie = recepcion): Promise<Socio> {
    const r = await alta(over, cookie);
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as Socio;
  }
  const compartido = async (id: string, cookie = recepcion) => (await get(`/members/${id}/shared-phone`, cookie)).json();

  const borrador = (over: Record<string, unknown> = {}) => ({
    firstName: nombreUnico('Alta'), lastName: nombreUnico('Qr'), phone: telefonoUnico().slice(3), email: null,
    birthDate: '1994-03-08', emergencyContactName: null, emergencyContactPhone: null, memberSince: null, healthNotes: null, adult: true,
    consents: [{ consentType: 'PRIVACY_NOTICE', version, granted: true }, { consentType: 'HOUSE_RULES', version, granted: true }],
    ...over,
  });
  const mandar = (over: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `/intake/${sede.id}`, payload: borrador(over) });
  async function enviar(over: Record<string, unknown> = {}) {
    const r = await mandar(over);
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }
  const detalle = async (id: string) => (await get(`/intakes/${id}`, gerencia)).json();
  const menor = (over: Record<string, unknown> = {}) => ({ adult: false, birthDate: naceHace(16), guardianName: 'Tutora De Prueba', guardianPhone: telefonoUnico().slice(3), ...over });

  // ── D-09 ──────────────────────────────────────────────────────────────────
  describe('D-09 · dos socios comparten celular', () => {
    it('sin decir quién responde por el número, el alta se detiene y dice de quién es', async () => {
      const mama = await socio();
      const r = await alta({ phoneE164: mama.phoneE164, force: true });
      expect(r.statusCode).toBe(409);
      expect(r.json().reason).toBe('PHONE_IN_USE');
      expect(r.json().message).toContain(mama.memberCode);
      expect(r.json().message).toMatch(/responsable del número/);
      expect(await getDb().member.count({ where: { organizationId: orgId, phoneE164: mama.phoneE164 } })).toBe(1);
    });

    it('con la mamá como responsable, la hija entra con el mismo celular y sin «forzar»; cada ficha dice con quién lo comparte', async () => {
      const mama = await socio();
      const r = await alta({ phoneE164: mama.phoneE164, responsible: { kind: 'MEMBER', memberId: mama.id } });
      expect(r.statusCode, r.body).toBe(201);
      const hija = r.json() as Socio;
      expect(hija.id).not.toBe(mama.id);
      expect(hija.memberCode).not.toBe(mama.memberCode);

      const deLaHija = await compartido(hija.id);
      expect(deLaHija).toMatchObject({ hidden: false, missingResponsible: false, responsible: { kind: 'MEMBER', memberId: mama.id, memberCode: mama.memberCode } });
      expect(deLaHija.sharedWith.map((x: { id: string }) => x.id)).toEqual([mama.id]);
      // La mamá no tenía nada anotado: queda como la responsable de su propio número.
      const deLaMama = await compartido(mama.id);
      expect(deLaMama).toMatchObject({ missingResponsible: false, responsible: { kind: 'SELF' } });
      expect(deLaMama.sharedWith.map((x: { id: string }) => x.id)).toEqual([hija.id]);
      // El asiento dice la clase de responsable, no su nombre.
      const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'member.create', resourceId: hija.id } });
      expect(asiento.afterState).toMatchObject({ responsable: 'MEMBER' });
      expect(JSON.stringify(asiento.afterState)).not.toContain(mama.firstName);
    });

    it('un adulto que no es socio también puede ser el responsable; su teléfono propio se guarda solo si es otro', async () => {
      const hermano = await socio();
      const r = await alta({ phoneE164: hermano.phoneE164, responsible: { kind: 'ADULT', name: 'Abuela De Prueba', phoneE164: hermano.phoneE164 } });
      expect(r.statusCode, r.body).toBe(201);
      const c = await compartido(r.json().id);
      expect(c.responsible).toMatchObject({ kind: 'ADULT', name: 'Abuela De Prueba', phoneE164: null });
      // Al hermano nadie le anotó responsable: su ficha lo dice.
      expect((await compartido(hermano.id)).missingResponsible).toBe(true);
    });

    it('el responsable tiene que ser alguien que de verdad tiene ese celular', async () => {
      const mama = await socio();
      const ajeno = await socio();
      const r = await alta({ phoneE164: mama.phoneE164, responsible: { kind: 'MEMBER', memberId: ajeno.id } });
      expect(r.statusCode).toBe(422);
      expect(r.json().message).toMatch(/mismo celular/);
    });

    it('mismo celular y MISMO nombre sigue siendo la misma persona: se detiene aunque traiga responsable', async () => {
      const ana = await socio();
      const r = await alta({ firstName: ana.firstName, lastName: ana.lastName, phoneE164: ana.phoneE164, responsible: { kind: 'SELF' } });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('DUPLICATES_FOUND');
    });

    it('compartir no mezcla a las personas: el buscador las distingue, cada una tiene su código del portal y sus cargos', async () => {
      const mama = await socio();
      const hija = (await alta({ phoneE164: mama.phoneE164, responsible: { kind: 'MEMBER', memberId: mama.id } })).json() as Socio;
      // El buscador por celular enseña a las dos, cada una con su código.
      const encontrados = (await get(`/members/search?q=${mama.phoneE164.slice(3)}`, recepcion)).json();
      const lista = (encontrados.items ?? encontrados.results ?? encontrados) as Array<{ id: string; memberCode: string }>;
      expect(lista.map((x) => x.id).sort()).toEqual([mama.id, hija.id].sort());
      // El buscador de identidad: con el nombre de la hija, ella es ella y la mamá «comparte celular».
      const quien = (await post('/members/check-duplicates', recepcion, { firstName: hija.firstName, lastName: hija.lastName, phoneE164: hija.phoneE164 })).json();
      const deLaHija = quien.people.find((p: { id: string }) => p.id === hija.id);
      const deLaMama = quien.people.find((p: { id: string }) => p.id === mama.id);
      expect(deLaHija.sharedPhone).toBe(false);
      expect(deLaMama.sharedPhone).toBe(true);
      // El portal se activa con un código por socio, no con el celular.
      const invitaciones = await Promise.all([mama, hija].map((s) => post(`/members/${s.id}/portal-invite`, gerencia, {})));
      for (const i of invitaciones) expect(i.statusCode, i.body).toBeLessThan(300);
      const filas = await getDb().portalInvite.findMany({ where: { memberId: { in: [mama.id, hija.id] } }, select: { memberId: true } });
      expect(new Set(filas.map((x) => x.memberId)).size).toBe(2);
    });

    it('corregir el celular de una ficha al de otro socio pide al responsable, y con él lo guarda', async () => {
      const mama = await socio();
      const hijo = await socio();
      const sin = await pedir('PATCH', `/members/${hijo.id}`, gerencia, { phoneE164: mama.phoneE164 });
      expect(sin.statusCode).toBe(409);
      expect(sin.json().reason).toBe('PHONE_IN_USE');
      expect((await getDb().member.findUniqueOrThrow({ where: { id: hijo.id } })).phoneE164).toBe(hijo.phoneE164);
      const con = await pedir('PATCH', `/members/${hijo.id}`, gerencia, { phoneE164: mama.phoneE164, responsible: { kind: 'MEMBER', memberId: mama.id } });
      expect(con.statusCode, con.body).toBe(200);
      expect((await compartido(hijo.id)).responsible).toMatchObject({ kind: 'MEMBER', memberId: mama.id });
    });

    it('la gerencia cambia o quita al responsable; recepción no (no edita fichas)', async () => {
      const mama = await socio();
      const hija = (await alta({ phoneE164: mama.phoneE164, responsible: { kind: 'MEMBER', memberId: mama.id } })).json() as Socio;
      expect((await pedir('PUT', `/members/${hija.id}/responsible`, recepcion, { responsible: { kind: 'SELF' } })).statusCode).toBe(403);
      const r = await pedir('PUT', `/members/${hija.id}/responsible`, gerencia, { responsible: { kind: 'ADULT', name: 'Tía De Prueba', phoneE164: telefonoUnico() } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().responsible).toMatchObject({ kind: 'ADULT', name: 'Tía De Prueba' });
      expect(r.json().responsible.phoneE164).toMatch(/^\+52/);
      const quitar = await pedir('PUT', `/members/${hija.id}/responsible`, gerencia, { responsible: null });
      expect(quitar.json()).toMatchObject({ responsible: null, missingResponsible: true });
      expect(await getDb().auditLog.count({ where: { organizationId: orgId, action: 'member.responsible', resourceId: hija.id } })).toBe(2);
    });

    it('al coach, que no ve teléfonos, no se le dice con quién comparte', async () => {
      const mama = await socio();
      const hija = (await alta({ phoneE164: mama.phoneE164, responsible: { kind: 'MEMBER', memberId: mama.id } })).json() as Socio;
      await asignarAlCoach(hija.id);
      const r = await get(`/members/${hija.id}/shared-phone`, coach);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ hidden: true, sharedWith: [], responsible: null, missingResponsible: false });
    });

    it('un socio dado de baja no cuenta como alguien con quien se comparte', async () => {
      const antes = await socio();
      expect((await post(`/members/${antes.id}/archive`, gerencia, { reason: 'Prueba de celular compartido' })).statusCode).toBe(200);
      const nuevo = await alta({ phoneE164: antes.phoneE164, force: true });
      expect(nuevo.statusCode, nuevo.body).toBe(201);
      expect((await compartido(nuevo.json().id)).sharedWith).toEqual([]);
    });

    it('alta por QR con el celular de la mamá: la bandeja dice «Comparte celular» y aprobar pide al responsable', async () => {
      const mama = await socio({ homeBranchId: sede.id }, gerencia);
      const id = await enviar({ phone: mama.phoneE164.slice(3) });
      expect((await detalle(id)).flags).toContain('SHARED_PHONE');
      const sin = await post(`/intakes/${id}/approve`, gerencia, { force: true });
      expect(sin.statusCode).toBe(409);
      expect(sin.json().reason).toBe('PHONE_IN_USE');
      expect((await detalle(id)).intake.status).toBe('SUBMITTED');
      const con = await post(`/intakes/${id}/approve`, gerencia, { responsible: { kind: 'MEMBER', memberId: mama.id } });
      expect(con.statusCode, con.body).toBe(201);
      expect((await compartido(con.json().memberId, gerencia)).responsible).toMatchObject({ kind: 'MEMBER', memberId: mama.id });
    });
  });

  // ── D-10 ──────────────────────────────────────────────────────────────────
  describe('D-10 · menores de 15 a 17 por QR', () => {
    it('quien dice no tener 18 da su nacimiento, y de 15 a 17 el nombre y el celular de su tutor', async () => {
      const sinFecha = await mandar({ adult: false, birthDate: null });
      expect(sinFecha.statusCode).toBe(422);
      expect(sinFecha.body).toContain('birthDate');
      const sinTutor = await mandar({ adult: false, birthDate: naceHace(16) });
      expect(sinTutor.statusCode).toBe(422);
      expect(sinTutor.body).toContain('guardianName');
      expect(sinTutor.body).toContain('guardianPhone');
      // Menos de 15 sigue sin poder inscribirse en línea.
      expect((await mandar(menor({ birthDate: naceHace(13) }))).statusCode).toBe(422);
    });

    it('el alta queda «falta su tutor», con a quién llamar, y su nota de salud no se captura', async () => {
      const salud = (await getDb().consentDocument.findFirstOrThrow({ where: { organizationId: orgId, consentType: 'HEALTH_DATA', status: 'PUBLISHED' } })).version;
      const id = await enviar(menor({
        healthNotes: 'Asma leve',
        consents: [{ consentType: 'PRIVACY_NOTICE', version, granted: true }, { consentType: 'HOUSE_RULES', version, granted: true }, { consentType: 'HEALTH_DATA', version: salud, granted: true }],
      }));
      const d = await detalle(id);
      expect(d.intake).toMatchObject({ minor: true, guardianName: 'Tutora De Prueba', hasHealthNotes: false, healthNotes: null });
      expect(d.intake.guardianPhoneE164).toMatch(/^\+52\d{10}$/);
      expect(d.flags[0]).toBe('NEEDS_GUARDIAN');
      const fila = await getDb().memberIntake.findUniqueOrThrow({ where: { id } });
      expect(fila.healthNotes).toBeNull();
      expect((fila.acceptedConsents as Array<{ consentType: string; granted: boolean }>).find((c) => c.consentType === 'HEALTH_DATA')?.granted).toBe(false);
      // En la bandeja, la insignia va en la fila.
      const bandeja = (await get(`/intakes?branchId=${sede.id}&limit=100`, gerencia)).json();
      expect(bandeja.items.find((x: { id: string }) => x.id === id).flags).toContain('NEEDS_GUARDIAN');
    });

    it('un adulto no lleva tutor aunque lo escriba, ni la insignia', async () => {
      const id = await enviar({ guardianName: 'No Hace Falta', guardianPhone: telefonoUnico().slice(3) });
      const d = await detalle(id);
      expect(d.intake).toMatchObject({ minor: false, guardianName: null, guardianPhoneE164: null });
      expect(d.flags).not.toContain('NEEDS_GUARDIAN');
    });

    it('sin la firma del tutor no se aprueba ni se vincula; el alta sigue por revisar', async () => {
      const id = await enviar(menor());
      const r = await post(`/intakes/${id}/approve`, gerencia, {});
      expect(r.statusCode).toBe(409);
      expect(r.json().reason).toBe('GUARDIAN_REQUIRED');
      expect(r.json().message).toContain('Tutora De Prueba');
      const otro = await socio({ homeBranchId: sede.id }, gerencia);
      const v = await post(`/intakes/${id}/link`, gerencia, { memberId: otro.id });
      expect(v.statusCode).toBe(409);
      expect(v.json().reason).toBe('GUARDIAN_REQUIRED');
      expect((await detalle(id)).intake.status).toBe('SUBMITTED');
    });

    it('con el tutor firmando en el mostrador se aprueba: la aceptación queda a SU nombre y él es el responsable', async () => {
      const celTutor = telefonoUnico();
      const id = await enviar(menor({ guardianPhone: celTutor.slice(3) }));
      // El celular llega como se teclea (10 dígitos) y se guarda normalizado.
      const r = await post(`/intakes/${id}/approve`, gerencia, { guardian: { name: 'Mariana Tutora Prueba', phoneE164: celTutor.slice(3) } });
      expect(r.statusCode, r.body).toBe(201);
      const memberId = r.json().memberId as string;

      const firmas = await getDb().memberConsent.findMany({ where: { memberId }, orderBy: { consentType: 'asc' } });
      const obligatorias = firmas.filter((f) => f.consentType === 'PRIVACY_NOTICE' || f.consentType === 'HOUSE_RULES');
      expect(obligatorias).toHaveLength(2);
      for (const f of obligatorias) {
        expect(f).toMatchObject({ granted: true, signedByName: 'Mariana Tutora Prueba', signedByPhoneE164: celTutor, channel: 'ASSISTED' });
        expect(f.assistedByUserId).not.toBeNull();
        expect(f.documentText).toBeTruthy();
      }
      // Lo de salud: el tutor no lo aceptó, así que si hay fila es un «no», y no hay nota.
      expect(firmas.filter((f) => f.consentType === 'HEALTH_DATA' && f.granted)).toHaveLength(0);
      const ficha = await getDb().member.findUniqueOrThrow({ where: { id: memberId } });
      expect(ficha.healthNotes).toBeNull();
      expect(ficha).toMatchObject({ responsibleKind: 'ADULT', responsibleName: 'Mariana Tutora Prueba', responsiblePhoneE164: celTutor });
      expect(ficha.guardianSignedAt).not.toBeNull();
      const c = await compartido(memberId, gerencia);
      expect(c.responsible).toMatchObject({ kind: 'ADULT', name: 'Mariana Tutora Prueba' });
      expect(c.responsible.guardianSignedAt).toBeTruthy();
      // La bitácora dice que firmó su tutor, sin su nombre.
      const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'intake.approve', resourceId: id } });
      expect(asiento.afterState).toMatchObject({ firmoSuTutor: true });
      expect(JSON.stringify(asiento.afterState)).not.toContain('Mariana');
    });

    it('la nota de salud del menor solo se guarda si el tutor acepta ese permiso al firmar', async () => {
      const sin = await enviar(menor());
      const a = await post(`/intakes/${sin}/approve`, gerencia, { guardian: { name: 'Tutor Sin Permiso', healthConsent: false, healthNotes: 'No debe guardarse' } });
      expect(a.statusCode, a.body).toBe(201);
      expect((await getDb().member.findUniqueOrThrow({ where: { id: a.json().memberId } })).healthNotes).toBeNull();

      const con = await enviar(menor());
      const b = await post(`/intakes/${con}/approve`, gerencia, { guardian: { name: 'Tutor Con Permiso', healthConsent: true, healthNotes: 'Asma leve' } });
      expect(b.statusCode, b.body).toBe(201);
      const ficha = await getDb().member.findUniqueOrThrow({ where: { id: b.json().memberId } });
      expect(descifrarSensible(ficha.healthNotes)).toBe('Asma leve');
      const salud = await getDb().memberConsent.findFirstOrThrow({ where: { memberId: ficha.id, consentType: 'HEALTH_DATA' } });
      expect(salud).toMatchObject({ granted: true, signedByName: 'Tutor Con Permiso' });
      // Sin celular propio del tutor en la firma, vale el que el menor escribió en el QR.
      expect(salud.signedByPhoneE164).toMatch(/^\+52\d{10}$/);
    });

    it('si recepción corrige el nacimiento y resulta menor, también hace falta el tutor', async () => {
      const id = await enviar();
      expect((await detalle(id)).intake.minor).toBe(false);
      const r = await post(`/intakes/${id}/approve`, gerencia, { corrections: { birthDate: naceHace(17) } });
      expect(r.statusCode).toBe(409);
      expect(r.json().reason).toBe('GUARDIAN_REQUIRED');
      const ok = await post(`/intakes/${id}/approve`, gerencia, { corrections: { birthDate: naceHace(17) }, guardian: { name: 'Papá De Prueba', phoneE164: telefonoUnico() } });
      expect(ok.statusCode, ok.body).toBe(201);
    });

    it('el menor con el celular de su mamá socia: el tutor que firma vale también como responsable del número', async () => {
      const mama = await socio({ homeBranchId: sede.id }, gerencia);
      const id = await enviar(menor({ phone: mama.phoneE164.slice(3), guardianPhone: mama.phoneE164.slice(3) }));
      const r = await post(`/intakes/${id}/approve`, gerencia, { guardian: { name: `${mama.firstName} ${mama.lastName}`, phoneE164: mama.phoneE164 } });
      expect(r.statusCode, r.body).toBe(201);
      const c = await compartido(r.json().memberId, gerencia);
      expect(c.sharedWith.map((x: { id: string }) => x.id)).toEqual([mama.id]);
      // Mismo número que el menor: no se repite como teléfono propio del tutor.
      expect(c.responsible).toMatchObject({ kind: 'ADULT', phoneE164: null });
      expect(c.missingResponsible).toBe(false);
    });

    it('en el mostrador, si el tutor firma el alta de un menor, la aceptación también queda a su nombre', async () => {
      const r = await alta({ birthDate: naceHace(16), guardian: { name: 'Tutor De Mostrador', phoneE164: telefonoUnico() } });
      expect(r.statusCode, r.body).toBe(201);
      const firmas = await getDb().memberConsent.findMany({ where: { memberId: r.json().id } });
      expect(firmas.length).toBeGreaterThanOrEqual(2);
      for (const f of firmas) expect(f.signedByName).toBe('Tutor De Mostrador');
      // Un adulto dado de alta como siempre no lleva firmante.
      const adulto = await socio();
      for (const f of await getDb().memberConsent.findMany({ where: { memberId: adulto.id } })) expect(f.signedByName).toBeNull();
    });
  });

  // ── D-11 ──────────────────────────────────────────────────────────────────
  describe('D-11 · alta mínima en el mostrador', () => {
    it('basta nombre, celular (o correo), desde cuándo viene y la aceptación; lo demás queda «por completar»', async () => {
      const r = await alta({ joinedAt: '2024-03-01' });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().joinedAt.slice(0, 10)).toBe('2024-03-01');
      const cierre = (await get(`/members/${r.json().id}/onboarding`, recepcion)).json();
      expect(cierre.missingFields).toEqual(['birthDate', 'emergencyContactName']);
      expect(cierre.steps.map((s: { key: string }) => s.key)).toContain('DATA');
      // Solo con correo también vale.
      const conCorreo = await alta({ phoneE164: undefined, email: `${nombreUnico('minima').toLowerCase()}@prueba.mx` });
      expect(conCorreo.statusCode, conCorreo.body).toBe(201);
    });

    it('recepción completa lo vacío y nunca cambia lo ya capturado', async () => {
      const s = await socio();
      const r = await post(`/members/${s.id}/complete`, recepcion, {
        birthDate: '1990-05-02', emergencyContactName: 'Hermana De Prueba', emergencyContactPhone: '5511223344', phoneE164: telefonoUnico(),
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().filled.sort()).toEqual(['birthDate', 'emergencyContactName', 'emergencyContactPhone']);
      // El celular ya lo tenía: se deja como estaba y se dice.
      expect(r.json().skipped).toEqual(['phoneE164']);
      expect(r.json().missingFields).toEqual([]);
      const ficha = await getDb().member.findUniqueOrThrow({ where: { id: s.id } });
      expect(ficha.phoneE164).toBe(s.phoneE164);
      expect(ficha.birthDate?.toISOString().slice(0, 10)).toBe('1990-05-02');
      expect(ficha.emergencyContactName).toBe('Hermana De Prueba');

      // Otra vez, con otros valores: ya nada está vacío, nada cambia y no hay asiento nuevo.
      const otra = await post(`/members/${s.id}/complete`, recepcion, { birthDate: '1980-01-01', emergencyContactName: 'Otra Persona' });
      expect(otra.json()).toMatchObject({ filled: [], skipped: ['birthDate', 'emergencyContactName'] });
      const igual = await getDb().member.findUniqueOrThrow({ where: { id: s.id } });
      expect(igual.birthDate?.toISOString().slice(0, 10)).toBe('1990-05-02');
      expect(igual.emergencyContactName).toBe('Hermana De Prueba');
      const asientos = await getDb().auditLog.findMany({ where: { organizationId: orgId, action: 'member.complete', resourceId: s.id } });
      expect(asientos).toHaveLength(1);
      // Qué campos, no sus valores.
      expect(asientos[0]!.afterState).toMatchObject({ yaTenia: ['phoneE164'] });
      expect(JSON.stringify(asientos[0]!.afterState)).not.toContain('Hermana');
    });

    it('completar un celular que ya es de otro socio pide al responsable (D-09)', async () => {
      const mama = await socio();
      const hija = (await alta({ phoneE164: undefined, email: `${nombreUnico('hija').toLowerCase()}@prueba.mx` })).json() as Socio;
      const sin = await post(`/members/${hija.id}/complete`, recepcion, { phoneE164: mama.phoneE164 });
      expect(sin.statusCode).toBe(409);
      expect(sin.json().reason).toBe('PHONE_IN_USE');
      const con = await post(`/members/${hija.id}/complete`, recepcion, { phoneE164: mama.phoneE164, responsible: { kind: 'MEMBER', memberId: mama.id } });
      expect(con.statusCode, con.body).toBe(200);
      expect(con.json().filled.sort()).toEqual(['phoneE164', 'responsible']);
    });

    it('recepción anota al responsable que faltaba, pero no cambia uno ya anotado', async () => {
      const hermano = await socio();
      const otro = (await alta({ phoneE164: hermano.phoneE164, responsible: { kind: 'ADULT', name: 'Mamá De Prueba' } })).json() as Socio;
      expect((await compartido(hermano.id)).missingResponsible).toBe(true);
      const r = await post(`/members/${hermano.id}/complete`, recepcion, { responsible: { kind: 'ADULT', name: 'Mamá De Prueba' } });
      expect(r.json().filled).toEqual(['responsible']);
      expect((await compartido(hermano.id)).missingResponsible).toBe(false);
      const ya = await post(`/members/${otro.id}/complete`, recepcion, { responsible: { kind: 'SELF' } });
      expect(ya.json()).toMatchObject({ filled: [], skipped: ['responsible'] });
      expect((await compartido(otro.id)).responsible).toMatchObject({ kind: 'ADULT', name: 'Mamá De Prueba' });
    });
  });
});
