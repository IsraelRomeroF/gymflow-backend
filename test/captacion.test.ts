import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, CONSENTIMIENTOS, sedeDesechable, archivarSede } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { descifrarSensible } from '../src/platform/sensitive.js';

/**
 * CAPTACIÓN (auditoría 8, fase 2, bloque 2.4).
 *
 * Interesados: la etapa sale de los contactos, la bandeja tiene tres grupos
 * que ordena el servidor, cerrar pide motivo y reabrir conserva la etapa, y
 * una persona no se registra dos veces. Altas digitales: reenviar actualiza
 * el borrador, lo corregido se guarda sin aprobar, vincular lleva la nota de
 * salud, aprobar es una sola operación y convierte al interesado que era la
 * misma persona. Y un solo buscador de identidad para todas las puertas.
 */
describe('captación (2.4)', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let recepcion: string;
  let orgId: string;
  let cen: string;
  let nor: string;
  /** Sede propia para las altas por QR: no gasta el tope de pendientes de Centro. */
  let sede: { id: string; code: string };
  let version: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
    nor = f.demoBranches.find((b) => b.code === 'NOR')!.id;
    sede = await sedeDesechable(orgId, 'Captación');
    version = CONSENTIMIENTOS[0]!.documentVersion;
  });

  afterAll(async () => {
    // Nada queda por revisar en la sede de la prueba.
    await getDb().memberIntake.updateMany({ where: { branchId: sede.id, status: 'SUBMITTED' }, data: { status: 'REJECTED', rejectionReason: 'Fin de la prueba', reviewedAt: new Date() } });
    await archivarSede(sede.id);
    await app.close();
    await closeDb();
  });

  const post = (url: string, cookie: string, payload?: unknown) => app.inject({ method: 'POST', url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
  const enDias = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date(Date.now() + n * 86_400_000));

  async function interesado(over: Record<string, unknown> = {}, cookie = recepcion) {
    const datos = { branchId: cen, firstName: nombreUnico('Inte'), lastName: nombreUnico('Resado'), phoneE164: telefonoUnico(), ...over };
    const r = await post('/prospects', cookie, datos);
    expect(r.statusCode, r.body).toBe(201);
    return { id: r.json().id as string, ...datos } as { id: string; firstName: string; lastName: string; phoneE164: string; branchId: string };
  }
  const fila = async (p: { id: string; lastName: string }, cookie = gerencia, extra = '') =>
    (await get(`/prospects?q=${p.lastName.toLowerCase()}${extra}`, cookie)).json().items.find((x: { id: string }) => x.id === p.id);
  const contacto = (id: string, payload: Record<string, unknown>, cookie = recepcion) => post(`/prospects/${id}/follow-ups`, cookie, payload);

  const borrador = (over: Record<string, unknown> = {}) => ({
    firstName: nombreUnico('Alta'), lastName: nombreUnico('Cap'), phone: telefonoUnico().slice(3), email: null,
    birthDate: '1994-03-08', emergencyContactName: 'Contacto Emergencia', emergencyContactPhone: '5511223344',
    memberSince: null, healthNotes: null,
    consents: [{ consentType: 'PRIVACY_NOTICE', version, granted: true }, { consentType: 'HOUSE_RULES', version, granted: true }],
    ...over,
  });
  async function enviar(over: Record<string, unknown> = {}) {
    const datos = borrador(over);
    const r = await app.inject({ method: 'POST', url: `/intake/${sede.id}`, payload: datos });
    expect(r.statusCode, r.body).toBe(201);
    return { id: r.json().id as string, folio: r.json().folio as string, datos };
  }
  async function socioDeAlta(over: Record<string, unknown> = {}) {
    const r = await post('/members', gerencia, { firstName: nombreUnico('Socio'), lastName: nombreUnico('Cap'), phoneE164: telefonoUnico(), homeBranchId: cen, consents: CONSENTIMIENTOS, ...over });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; memberCode: string; firstName: string; lastName: string; phoneE164: string };
  }

  // ── Interesados ───────────────────────────────────────────────────────────
  describe('la etapa se deriva de los contactos (10-05)', () => {
    it('no contestó no lo mueve; hablar en persona es «Visitó»; venir a probar, «En prueba»; y no retrocede', async () => {
      const p = await interesado();
      expect((await contacto(p.id, { channel: 'CALL', outcome: 'NO_ANSWER', nextStepOn: enDias(1) })).json().status).toBe('NEW');
      expect((await contacto(p.id, { channel: 'WHATSAPP', outcome: 'INTAKE_SENT', nextStepOn: enDias(2) })).json().status).toBe('CONTACTED');
      expect((await contacto(p.id, { channel: 'VISIT', outcome: 'INTERESTED', nextStepOn: enDias(2) })).json().status).toBe('VISITED');
      const prueba = await contacto(p.id, { channel: 'VISIT', outcome: 'TRIAL_VISIT', nextStepOn: enDias(3) });
      expect(prueba.statusCode, prueba.body).toBe(201);
      expect(prueba.json().status).toBe('TRIAL');
      expect((await contacto(p.id, { channel: 'CALL', outcome: 'NO_ANSWER', nextStepOn: enDias(1) })).json().status).toBe('TRIAL');
      expect((await fila(p)).status).toBe('TRIAL');
    });

    it('la etapa que alguien eligió a mano antes de este bloque no retrocede con el siguiente contacto', async () => {
      const p = await interesado();
      // Como quedaban con el `select` de estado: «Visitó» sin ningún contacto que lo respalde.
      await getDb().prospect.update({ where: { id: p.id }, data: { status: 'VISITED' } });
      expect((await contacto(p.id, { channel: 'CALL', outcome: 'NO_ANSWER', nextStepOn: enDias(1) })).json().status).toBe('VISITED');
      expect((await contacto(p.id, { channel: 'CALL', outcome: 'ANSWERED', nextStepOn: enDias(1) })).json().status).toBe('VISITED');
      expect((await contacto(p.id, { channel: 'VISIT', outcome: 'TRIAL_VISIT', nextStepOn: enDias(1) })).json().status).toBe('TRIAL');
    });

    it('la etapa ya no se elige: `PATCH status` responde 422 y dice qué usar', async () => {
      const p = await interesado();
      const r = await app.inject({ method: 'PATCH', url: `/prospects/${p.id}`, headers: { cookie: recepcion }, payload: { status: 'VISITED' } });
      expect(r.statusCode).toBe(422);
      expect(r.json().message).toMatch(/sale de los contactos/);
      expect((await fila(p)).status).toBe('NEW');
    });

    it('«Vino a probar» y «Se le mandó el alta» son de un interesado: un socio en riesgo no los acepta', async () => {
      const socio = await socioDeAlta();
      for (const outcome of ['TRIAL_VISIT', 'INTAKE_SENT']) {
        const r = await post(`/members/${socio.id}/follow-ups`, gerencia, { channel: 'CALL', outcome });
        expect(r.statusCode, outcome).toBe(422);
      }
      // Y «Va a regresar» no es de un interesado.
      const p = await interesado();
      expect((await contacto(p.id, { channel: 'CALL', outcome: 'COMING_BACK' })).statusCode).toBe(422);
    });
  });

  describe('cerrar con motivo y reabrir (10-05, 10-09)', () => {
    it('«No le interesa» pide el motivo y lo cierra en el mismo paso; ya no se queda «Contactado» en seguimiento', async () => {
      const p = await interesado();
      await contacto(p.id, { channel: 'VISIT', outcome: 'INTERESTED', nextStepOn: enDias(2) });

      const sinMotivo = await contacto(p.id, { channel: 'CALL', outcome: 'NOT_INTERESTED' });
      expect(sinMotivo.statusCode).toBe(422);
      expect(sinMotivo.json().message).toMatch(/por qué/);
      const inventado = await contacto(p.id, { channel: 'CALL', outcome: 'NOT_INTERESTED', lostReasonCode: 'PORQUE_SI' });
      expect(inventado.statusCode).toBe(422);
      // Nada se escribió con los dos rechazos: sigue con un solo contacto.
      expect((await fila(p)).followUps).toBe(1);

      const cerrado = await contacto(p.id, { channel: 'CALL', outcome: 'NOT_INTERESTED', lostReasonCode: 'PRECIO', note: 'Le pareció caro' });
      expect(cerrado.statusCode, cerrado.body).toBe(201);
      expect(cerrado.json()).toMatchObject({ status: 'LOST', outcome: 'NOT_INTERESTED', nextStepOn: null });
      const f = await fila(p);
      expect(f).toMatchObject({ status: 'LOST', queue: null, lostReasonCode: 'PRECIO', lostReason: 'Precio · Le pareció caro', nextStepOn: null, dueOn: null });
      expect(f.closedAt).toBeTruthy();

      // Cerrado no admite más contactos ni otro cierre.
      expect((await contacto(p.id, { channel: 'CALL', outcome: 'ANSWERED' })).json().reason).toBe('PROSPECT_CLOSED');
      expect((await post(`/prospects/${p.id}/close`, recepcion, { reasonCode: 'HORARIO' })).statusCode).toBe(409);
      // El primer motivo no se pisó.
      expect((await fila(p)).lostReasonCode).toBe('PRECIO');
    });

    it('«Ya no se va a inscribir» exige un motivo de la lista; «Otro…» pide escribirlo', async () => {
      const p = await interesado();
      expect((await post(`/prospects/${p.id}/close`, recepcion, {})).statusCode).toBe(422);
      expect((await post(`/prospects/${p.id}/close`, recepcion, { reasonCode: 'NO_EXISTE' })).statusCode).toBe(422);
      expect((await post(`/prospects/${p.id}/close`, recepcion, { reasonCode: 'OTRO' })).statusCode).toBe(422);
      const r = await post(`/prospects/${p.id}/close`, recepcion, { reasonCode: 'OTRO', note: 'Se mudó de ciudad' });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().reason).toBe('Se mudó de ciudad');
      expect(await fila(p)).toMatchObject({ status: 'LOST', lostReasonCode: 'OTRO', lostReason: 'Se mudó de ciudad' });
    });

    it('«Reabrir» conserva la etapa que tenía (antes volvía a «Nuevo») y lo pone en «Te toca hoy»', async () => {
      const p = await interesado();
      await contacto(p.id, { channel: 'VISIT', outcome: 'TRIAL_VISIT', nextStepOn: enDias(5) });
      await post(`/prospects/${p.id}/close`, recepcion, { reasonCode: 'HORARIO' });
      // Solo se reabre lo cerrado.
      const otro = await interesado();
      expect((await post(`/prospects/${otro.id}/reopen`, recepcion)).statusCode).toBe(409);

      const r = await post(`/prospects/${p.id}/reopen`, recepcion);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().status).toBe('TRIAL');
      expect(await fila(p)).toMatchObject({ status: 'TRIAL', queue: 'TODAY', dueOn: hoy(), lostReasonCode: null, lostReason: null, closedAt: null });

      // El que nunca fue contactado vuelve a «Sin contactar».
      await post(`/prospects/${otro.id}/close`, recepcion, { reasonCode: 'NUNCA_CONTESTO' });
      expect((await post(`/prospects/${otro.id}/reopen`, recepcion)).json().status).toBe('NEW');
      expect(await fila(otro)).toMatchObject({ status: 'NEW', queue: 'UNCONTACTED', dueOn: null });
    });

    it('registrar, cerrar y reabrir quedan en la bitácora con su sucursal, sin nombres', async () => {
      const p = await interesado({ source: 'Instagram' });
      await post(`/prospects/${p.id}/close`, recepcion, { reasonCode: 'PRECIO' });
      await post(`/prospects/${p.id}/reopen`, recepcion);
      const asientos = await getDb().auditLog.findMany({ where: { organizationId: orgId, resourceId: p.id }, orderBy: { at: 'asc' } });
      expect(asientos.map((a) => a.action)).toEqual(['prospect.create', 'prospect.close', 'prospect.reopen']);
      expect(asientos.every((a) => a.branchId === cen)).toBe(true);
      expect(asientos[1]!.reason).toBe('Precio');
      expect(JSON.stringify(asientos.map((a) => [a.beforeState, a.afterState]))).not.toContain(p.firstName);
    });
  });

  describe('la bandeja: tres grupos que ordena el servidor (10-16)', () => {
    it('sin contactar, te toca hoy y esperando; el contactado sin próximo paso toca hoy', async () => {
      const apellido = nombreUnico('Bandeja');
      const sinContactar = await interesado({ lastName: apellido });
      const conPasoHoy = await interesado({ lastName: apellido, nextStepOn: hoy() });
      const esperando = await interesado({ lastName: apellido, nextStepOn: enDias(4) });
      const sinProximoPaso = await interesado({ lastName: apellido });
      await contacto(sinProximoPaso.id, { channel: 'CALL', outcome: 'ANSWERED' });
      const atrasado = await interesado({ lastName: apellido });
      await getDb().prospect.update({ where: { id: atrasado.id }, data: { dueOn: new Date(`${enDias(-6)}T00:00:00Z`), nextStepOn: new Date(`${enDias(-6)}T00:00:00Z`) } });
      const cerrado = await interesado({ lastName: apellido });
      await post(`/prospects/${cerrado.id}/close`, recepcion, { reasonCode: 'PRECIO' });

      const q = `/prospects?q=${apellido.toLowerCase()}`;
      const ids = async (vista: string) => (await get(`${q}&view=${vista}`, recepcion)).json().items.map((x: { id: string }) => x.id);
      // Lo más atrasado va primero.
      expect(await ids('today')).toEqual([atrasado.id, ...[conPasoHoy.id, sinProximoPaso.id].sort()]);
      expect(await ids('uncontacted')).toEqual([sinContactar.id]);
      expect(await ids('waiting')).toEqual([esperando.id]);
      expect(await ids('closed')).toEqual([cerrado.id]);

      const r = (await get(`${q}&view=today`, recepcion)).json();
      expect(r.counts).toEqual({ open: 5, closed: 1, today: 3, uncontacted: 1, waiting: 1 });
      expect(r.total).toBe(3);
      expect(r.items.every((x: { queue: string }) => x.queue === 'TODAY')).toBe(true);
      expect(r.items.find((x: { id: string }) => x.id === sinProximoPaso.id)).toMatchObject({ nextStepOn: null, dueOn: hoy(), status: 'CONTACTED' });
      // Las pestañas de antes siguen contando lo mismo.
      expect((await get(`${q}&open=true`, recepcion)).json().total).toBe(5);
      expect((await get(`${q}&open=false`, recepcion)).json().total).toBe(1);
    });

    it('cada grupo viaja por páginas en su orden: con más de una página, el que toca hoy no queda escondido en la segunda', async () => {
      const apellido = nombreUnico('Paginas');
      const todos: string[] = [];
      for (let i = 0; i < 5; i++) {
        const p = await interesado({ lastName: apellido });
        // Cada uno tocaba un día distinto, del más atrasado al de hoy.
        await getDb().prospect.update({ where: { id: p.id }, data: { dueOn: new Date(`${enDias(i - 4)}T00:00:00Z`) } });
        todos.push(p.id);
      }
      const vistos: string[] = [];
      let cursor: string | null = null;
      let paginas = 0;
      do {
        const r: { items: Array<{ id: string }>; nextCursor: string | null } = (await get(`/prospects?q=${apellido.toLowerCase()}&view=today&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, recepcion)).json();
        vistos.push(...r.items.map((x) => x.id));
        cursor = r.nextCursor;
        paginas++;
      } while (cursor);
      expect(paginas).toBe(3);
      expect(vistos).toEqual(todos);
    });

    it('el pendiente del Inicio cuenta los que tocan hoy y los que nadie ha contactado, con la forma común', async () => {
      const antes = (await get('/prospects/pending', recepcion)).json();
      await interesado();
      await interesado({ nextStepOn: hoy() });
      await interesado({ nextStepOn: enDias(3) });
      const r = await get('/prospects/pending', recepcion);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ clave: 'prospects', href: '/prospectos', today: antes.today + 1, uncontacted: antes.uncontacted + 1, cuantos: antes.cuantos + 2, tono: 'warn' });
      expect(r.json().masAntiguo).toBeTruthy();
      // De las sedes de quien pregunta: la gerencia ve al menos lo de recepción de Centro.
      expect((await get('/prospects/pending', gerencia)).json().cuantos).toBeGreaterThanOrEqual(r.json().cuantos);
    });
  });

  describe('una persona, un registro (10-07)', () => {
    it('mismo celular y mismo nombre: 409 con a quién se encontró; con otro nombre comparten celular y sí se registra', async () => {
      const p = await interesado();
      const repetido = await post('/prospects', recepcion, { branchId: cen, firstName: p.firstName.toUpperCase(), lastName: p.lastName, phoneE164: p.phoneE164 });
      expect(repetido.statusCode).toBe(409);
      expect(repetido.json()).toMatchObject({ reason: 'PROSPECT_ALREADY_OPEN', existing: { kind: 'PROSPECT', id: p.id, branchId: cen } });
      // La hermana, con el mismo celular.
      const hermana = await post('/prospects', recepcion, { branchId: cen, firstName: nombreUnico('Otra'), lastName: p.lastName, phoneE164: p.phoneE164 });
      expect(hermana.statusCode, hermana.body).toBe(201);
      // Y si la persona lo decide, se registra aunque se parezca.
      expect((await post('/prospects', recepcion, { branchId: cen, firstName: p.firstName, lastName: p.lastName, phoneE164: p.phoneE164, force: true })).statusCode).toBe(201);
    });

    it('si está en seguimiento en otra sede, recepción solo recibe el aviso (sin id para abrirlo)', async () => {
      const p = await interesado({ branchId: nor }, gerencia);
      const r = await post('/prospects', recepcion, { branchId: cen, firstName: p.firstName, lastName: p.lastName, phoneE164: p.phoneE164 });
      expect(r.statusCode).toBe(409);
      expect(r.json().existing).toMatchObject({ kind: 'PROSPECT', id: null, branchId: nor });
    });

    it('quien ya es socio no se registra como interesado', async () => {
      const socio = await socioDeAlta();
      const r = await post('/prospects', recepcion, { branchId: cen, firstName: socio.firstName, lastName: socio.lastName, phoneE164: socio.phoneE164 });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ reason: 'ALREADY_MEMBER', existing: { kind: 'MEMBER', id: socio.id } });
    });

    it('recepción corrige lo que capturó (nombre, celular, fuente, nota y quién lo recomendó)', async () => {
      const p = await interesado({ notes: 'Preguntó por el anual' });
      const nuevo = telefonoUnico();
      const r = await app.inject({ method: 'PATCH', url: `/prospects/${p.id}`, headers: { cookie: recepcion }, payload: { firstName: 'Mariana', phoneE164: nuevo.slice(3), source: 'Recomendación', referredByName: 'Juan Pérez', notes: 'Le interesa el anual' } });
      expect(r.statusCode, r.body).toBe(200);
      const f = (await get(`/prospects?q=${nuevo.slice(-8)}`, recepcion)).json().items.find((x: { id: string }) => x.id === p.id);
      expect(f).toMatchObject({ firstName: 'Mariana', phoneE164: nuevo, source: 'Recomendación', referredByName: 'Juan Pérez', notes: 'Le interesa el anual' });
      // Se encuentra por su nombre nuevo.
      expect((await get(`/prospects?q=mariana ${p.lastName.toLowerCase()}`, recepcion)).json().items.map((x: { id: string }) => x.id)).toContain(p.id);
      // Sin contacto no se puede contactar.
      expect((await app.inject({ method: 'PATCH', url: `/prospects/${p.id}`, headers: { cookie: recepcion }, payload: { phoneE164: null } })).statusCode).toBe(422);
    });
  });

  describe('«Inscribir»: alta y conversión en una sola operación (10-06, 10-07)', () => {
    it('da de alta con las reglas del mostrador y deja al interesado ligado a su ficha', async () => {
      const p = await interesado({ branchId: nor }, gerencia);
      const r = await post(`/prospects/${p.id}/enroll`, gerencia, { firstName: p.firstName, lastName: p.lastName, phoneE164: p.phoneE164, homeBranchId: nor, consents: CONSENTIMIENTOS });
      expect(r.statusCode, r.body).toBe(201);
      // El socio nace en la sede del interesado.
      expect(r.json()).toMatchObject({ homeBranchId: nor });
      const f = await fila(p, gerencia);
      expect(f).toMatchObject({ status: 'CONVERTED', convertedMemberId: r.json().id, queue: null });
      // Ya inscrito, no se inscribe otra vez.
      expect((await post(`/prospects/${p.id}/enroll`, gerencia, { firstName: 'Otra', lastName: 'Persona', phoneE164: telefonoUnico(), homeBranchId: nor, consents: CONSENTIMIENTOS })).statusCode).toBe(409);
    });

    it('si el alta encuentra posibles duplicados, responde 409 como el mostrador y el interesado sigue abierto', async () => {
      const socio = await socioDeAlta();
      const p = await interesado({ firstName: nombreUnico('Dup'), phoneE164: telefonoUnico() });
      const r = await post(`/prospects/${p.id}/enroll`, recepcion, { firstName: socio.firstName, lastName: socio.lastName, phoneE164: socio.phoneE164, homeBranchId: cen, consents: CONSENTIMIENTOS });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ reason: 'DUPLICATE_MEMBER' });
      expect(r.json().candidates[0].candidateId).toBe(socio.id);
      expect((await fila(p)).status).toBe('NEW');
      // «Es esta persona»: ya era socio, y el interesado se cierra ligado a esa ficha.
      expect((await post(`/prospects/${p.id}/convert`, recepcion, { memberId: socio.id })).statusCode).toBe(200);
      expect(await fila(p)).toMatchObject({ status: 'CONVERTED', convertedMemberId: socio.id });
    });

    it('si el alta falla a medias, nada queda: ni socio ni interesado convertido', async () => {
      const p = await interesado();
      const antes = await getDb().member.count({ where: { organizationId: orgId } });
      // Una versión de texto que no existe: el alta revienta dentro de la unidad de trabajo.
      const r = await post(`/prospects/${p.id}/enroll`, recepcion, {
        firstName: p.firstName, lastName: p.lastName, phoneE164: p.phoneE164, homeBranchId: cen,
        consents: CONSENTIMIENTOS.map((c) => ({ ...c, documentVersion: 'v-no-existe' })),
      });
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(await getDb().member.count({ where: { organizationId: orgId } })).toBe(antes);
      expect((await fila(p)).status).toBe('NEW');
    });
  });

  describe('«¿Cómo se enteró?»: catálogo de la gerencia (10-17)', () => {
    it('nace con las de fábrica, la gerencia las cambia y recepción solo las lee', async () => {
      await getDb().prospectSource.deleteMany({ where: { organizationId: orgId } });
      const fabrica = (await get('/prospects/sources', recepcion)).json();
      expect(fabrica.defaults).toBe(true);
      expect(fabrica.sources).toEqual(expect.arrayContaining(['Recomendación', 'TikTok', 'Lona o volante']));

      const lista = ['Recomendación', 'Instagram', 'Convenio con la prepa', 'instagram'];
      expect((await app.inject({ method: 'PUT', url: '/prospects/sources', headers: { cookie: recepcion }, payload: { sources: lista } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PUT', url: '/prospects/sources', headers: { cookie: gerencia }, payload: { sources: [] } })).statusCode).toBe(422);
      const r = await app.inject({ method: 'PUT', url: '/prospects/sources', headers: { cookie: gerencia }, payload: { sources: lista } });
      expect(r.statusCode, r.body).toBe(200);
      // Sin repetidos, en el orden dado.
      expect((await get('/prospects/sources', recepcion)).json()).toEqual({ sources: ['Recomendación', 'Instagram', 'Convenio con la prepa'], defaults: false });
      await getDb().prospectSource.deleteMany({ where: { organizationId: orgId } });
    });
  });

  // ── Buscador de identidad ─────────────────────────────────────────────────
  describe('un solo buscador de identidad (check-duplicates ampliado)', () => {
    it('encuentra socios, interesados abiertos y altas por revisar, y dice qué es cada quien', async () => {
      const p = await interesado();
      const alta = await enviar();
      const socio = await socioDeAlta();

      const dePros = (await post('/members/check-duplicates', recepcion, { firstName: p.firstName, lastName: p.lastName, phoneE164: p.phoneE164 })).json();
      expect(dePros.candidates).toEqual([]);
      expect(dePros.blocking).toBe(false);
      expect(dePros.people[0]).toMatchObject({ kind: 'PROSPECT', id: p.id, fullName: `${p.firstName} ${p.lastName}`, score: 95, sharedPhone: false, phoneE164: p.phoneE164 });

      // El alta es de otra sede (la de la prueba): la gerencia la abre; recepción de Centro solo se entera.
      const cuerpo = { firstName: alta.datos.firstName, lastName: alta.datos.lastName, phoneE164: alta.datos.phone };
      expect((await post('/members/check-duplicates', gerencia, cuerpo)).json().people[0]).toMatchObject({ kind: 'INTAKE', id: alta.id, status: 'SUBMITTED' });
      expect((await post('/members/check-duplicates', recepcion, cuerpo)).json().people[0]).toMatchObject({ kind: 'INTAKE', id: null, branchId: sede.id });
      // Al revisar esa misma alta, ella no cuenta.
      expect((await post('/members/check-duplicates', gerencia, { ...cuerpo, excludeIntakeId: alta.id })).json().people).toEqual([]);

      const deSocio = (await post('/members/check-duplicates', recepcion, { firstName: socio.firstName, lastName: socio.lastName, phoneE164: socio.phoneE164 })).json();
      expect(deSocio.blocking).toBe(true);
      expect(deSocio.people[0]).toMatchObject({ kind: 'MEMBER', id: socio.id, memberCode: socio.memberCode });
    });

    it('con el celular primero (sin nombre todavía) ya avisa; y con otro nombre dice que comparten celular', async () => {
      const p = await interesado();
      const solo = (await post('/members/check-duplicates', recepcion, { phoneE164: p.phoneE164 })).json();
      expect(solo.people).toHaveLength(1);
      expect(solo.people[0]).toMatchObject({ kind: 'PROSPECT', id: p.id, explanation: 'Mismo celular', sharedPhone: false });

      const otra = (await post('/members/check-duplicates', recepcion, { firstName: nombreUnico('Hija'), lastName: nombreUnico('Distinta'), phoneE164: p.phoneE164 })).json();
      expect(otra.people[0]).toMatchObject({ kind: 'PROSPECT', id: p.id, sharedPhone: true });
      // Sin nada que buscar no busca.
      expect((await post('/members/check-duplicates', recepcion, {})).statusCode).toBe(422);
    });

    it('un exsocio sale como «fue socio», no como interesado nuevo', async () => {
      const socio = await socioDeAlta();
      expect((await post(`/members/${socio.id}/archive`, gerencia, { reason: 'Se dio de baja en la prueba' })).statusCode).toBeLessThan(300);
      const r = (await post('/members/check-duplicates', recepcion, { firstName: socio.firstName, lastName: socio.lastName, phoneE164: socio.phoneE164 })).json();
      expect(r.people[0]).toMatchObject({ kind: 'FORMER_MEMBER', id: socio.id, status: 'ARCHIVED' });
      const comoInteresado = await post('/prospects', recepcion, { branchId: cen, firstName: socio.firstName, lastName: socio.lastName, phoneE164: socio.phoneE164 });
      expect(comoInteresado.json()).toMatchObject({ reason: 'ALREADY_MEMBER', existing: { kind: 'FORMER_MEMBER' } });
    });
  });

  // ── Altas digitales ───────────────────────────────────────────────────────
  describe('alta digital corregida', () => {
    const detalle = async (id: string, cookie = gerencia) => (await get(`/intakes/${id}`, cookie)).json();
    const bandeja = async (extra = '') => (await get(`/intakes?status=SUBMITTED&branchId=${sede.id}&limit=200${extra}`, gerencia)).json();

    it('reenviar con el mismo celular y nombre actualiza el borrador; con otro nombre nace otro (9-18)', async () => {
      const a = await enviar({ emergencyContactName: null });
      const antes = (await bandeja()).total;
      const otraVez = await app.inject({ method: 'POST', url: `/intake/${sede.id}`, payload: { ...a.datos, emergencyContactName: 'Ahora sí' } });
      expect(otraVez.statusCode, otraVez.body).toBe(201);
      expect(otraVez.json().id).toBe(a.id);
      expect((await bandeja()).total).toBe(antes);
      expect((await detalle(a.id)).intake.emergencyContactName).toBe('Ahora sí');

      // La hija, con el celular de la mamá: otra alta.
      const hija = await app.inject({ method: 'POST', url: `/intake/${sede.id}`, payload: { ...a.datos, firstName: nombreUnico('Hija') } });
      expect(hija.json().id).not.toBe(a.id);
      expect((await bandeja()).total).toBe(antes + 1);
    });

    it('el tope de altas por revisar frena un alta nueva, no el reenvío de la propia', async () => {
      const chica = await sedeDesechable(orgId, 'Tope de altas');
      const conTope = await makeApp({ INTAKE_PENDING_MAX_PER_BRANCH: '1' });
      await conTope.ready();
      try {
        const datos = borrador();
        const primera = await conTope.inject({ method: 'POST', url: `/intake/${chica.id}`, payload: datos });
        expect(primera.statusCode, primera.body).toBe(201);
        // La bandeja está llena: otra persona no entra…
        expect((await conTope.inject({ method: 'POST', url: `/intake/${chica.id}`, payload: borrador() })).statusCode).toBe(409);
        // …pero quien ya está en ella puede volver a mandar la suya.
        const otraVez = await conTope.inject({ method: 'POST', url: `/intake/${chica.id}`, payload: { ...datos, emergencyContactName: 'Corregido' } });
        expect(otraVez.statusCode, otraVez.body).toBe(201);
        expect(otraVez.json().id).toBe(primera.json().id);
      } finally {
        await getDb().memberIntake.updateMany({ where: { branchId: chica.id, status: 'SUBMITTED' }, data: { status: 'REJECTED', rejectionReason: 'Fin de la prueba', reviewedAt: new Date() } });
        await archivarSede(chica.id);
        await conTope.close();
      }
    });

    it('la bandeja se filtra por sede y se busca por folio, nombre o celular (9-06, 9-09)', async () => {
      const a = await enviar();
      expect(a.folio).toMatch(/^[0-9A-F]{6}$/);
      const porFolio = await bandeja(`&q=${a.folio.toLowerCase()}`);
      expect(porFolio.items.map((x: { id: string }) => x.id)).toEqual([a.id]);
      expect(porFolio.items[0].folio).toBe(a.folio);
      expect((await bandeja(`&q=${String(a.datos.lastName).toLowerCase()}`)).items.map((x: { id: string }) => x.id)).toEqual([a.id]);
      expect((await bandeja(`&q=${String(a.datos.phone).slice(-7)}`)).items.map((x: { id: string }) => x.id)).toEqual([a.id]);
      expect((await bandeja('&q=zzzzqqqq')).items).toEqual([]);
      // Solo esa sede.
      expect((await bandeja()).items.every((x: { branchId: string }) => x.branchId === sede.id)).toBe(true);
      // Recepción de Centro no puede pedir la bandeja de otra sede.
      expect((await get(`/intakes?branchId=${sede.id}`, recepcion)).statusCode).toBe(403);
    });

    it('las insignias dicen qué falta y a quién se parece, en la fila y en el detalle (9-04)', async () => {
      const completo = await enviar({ memberSince: '2021-02-01' });
      const vacio = await enviar({ birthDate: null, emergencyContactName: null, emergencyContactPhone: null });
      const p = await interesado();
      const eraInteresado = await enviar({ firstName: p.firstName, lastName: p.lastName, phone: p.phoneE164.slice(3) });
      const socio = await socioDeAlta();
      const familiar = await enviar({ phone: socio.phoneE164.slice(3) });
      const duplicado = await enviar({ firstName: socio.firstName, lastName: socio.lastName, phone: socio.phoneE164.slice(3) });

      const filas = new Map<string, string[]>((await bandeja()).items.map((x: { id: string; flags: string[] }) => [x.id, x.flags]));
      expect(filas.get(completo.id)).toEqual(['RETURNING']);
      expect(filas.get(vacio.id)).toEqual(['MISSING_BIRTHDATE', 'MISSING_EMERGENCY']);
      expect(filas.get(eraInteresado.id)).toEqual(['WAS_PROSPECT']);
      expect(filas.get(familiar.id)).toEqual(['SHARED_PHONE']);
      expect(filas.get(duplicado.id)).toEqual(['POSSIBLE_DUPLICATE']);

      const d = await detalle(vacio.id);
      expect(d.pendingFields).toEqual(['birthDate', 'memberSince', 'emergencyContactName']);
      expect(d.flags).toEqual(['MISSING_BIRTHDATE', 'MISSING_EMERGENCY']);
      // La IP ya no viaja (9-15).
      expect(d.intake).not.toHaveProperty('ip');
      expect((await detalle(eraInteresado.id)).prospect).toMatchObject({ id: p.id, branchId: cen, status: 'NEW' });
      expect((await detalle(familiar.id)).matches[0]).toMatchObject({ candidateId: socio.id, sharedPhone: true, hasMembership: false });
      expect((await detalle(duplicado.id)).matches[0]).toMatchObject({ candidateId: socio.id, sharedPhone: false });
      // El historial no carga insignias.
      expect((await get(`/intakes?status=REJECTED&branchId=${sede.id}`, gerencia)).json().items.every((x: { flags: string[] }) => x.flags.length === 0)).toBe(true);
    });

    it('«Guardar sin aprobar»: lo corregido queda en el borrador, con quién y cuándo, y aprobar lo aplica (9-21)', async () => {
      const a = await enviar({ birthDate: null, emergencyContactName: null, emergencyContactPhone: null });
      const nuevo = telefonoUnico();
      const guardar = (corrections: unknown) => app.inject({ method: 'PATCH', url: `/intakes/${a.id}/corrections`, headers: { cookie: gerencia }, payload: { corrections } as Record<string, unknown> });

      const r = await guardar({ phoneE164: nuevo.slice(3), birthDate: '1990-01-15', emergencyContactName: 'Mamá', lastName: a.datos.lastName });
      expect(r.statusCode, r.body).toBe(200);
      // Lo que quedó igual que lo envió el socio no es una corrección.
      expect(r.json().corrections).toEqual({ phoneE164: nuevo, birthDate: '1990-01-15', emergencyContactName: 'Mamá' });
      expect(r.json().correctedByName).toBeTruthy();

      // Al reabrir (otra persona, otro día): el envío original intacto y lo corregido encima.
      const d = await detalle(a.id);
      expect(d.intake.phoneE164).toBe(`+52${a.datos.phone}`);
      expect(d.intake.birthDate).toBeNull();
      expect(d.intake.corrections).toEqual({ phoneE164: nuevo, birthDate: '1990-01-15', emergencyContactName: 'Mamá' });
      expect(d.intake.correctedAt).toBeTruthy();
      expect(d.pendingFields).toEqual(['memberSince']);
      expect(d.flags).toEqual(['CORRECTED']);

      // Lo que dejaría el alta sin contacto no se guarda.
      const sinContacto = await guardar({ phoneE164: null });
      expect(sinContacto.statusCode).toBe(422);
      // Recepción de otra sede no corrige esta alta.
      expect((await app.inject({ method: 'PATCH', url: `/intakes/${a.id}/corrections`, headers: { cookie: recepcion }, payload: { corrections: { emergencyContactName: 'X' } } })).statusCode).toBe(403);

      // Aprobar sin mandar nada más aplica lo guardado, y la bitácora dice el antes y el después.
      const ap = await post(`/intakes/${a.id}/approve`, gerencia, {});
      expect(ap.statusCode, ap.body).toBe(201);
      const socio = await getDb().member.findUniqueOrThrow({ where: { id: ap.json().memberId } });
      expect(socio).toMatchObject({ phoneE164: nuevo, emergencyContactName: 'Mamá' });
      expect(socio.birthDate?.toISOString().slice(0, 10)).toBe('1990-01-15');
      const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'intake.approve', resourceId: a.id } });
      expect((asiento.afterState as { corregido: Record<string, unknown> }).corregido.phoneE164).toEqual({ antes: `+52${a.datos.phone}`, despues: nuevo });
      // Ya aprobada, no se corrige.
      expect((await guardar({ emergencyContactName: 'Tarde' })).json().reason).toBe('INTAKE_ALREADY_REVIEWED');
    });

    it('descartar lo guardado deja el alta como la envió el socio', async () => {
      const a = await enviar();
      await app.inject({ method: 'PATCH', url: `/intakes/${a.id}/corrections`, headers: { cookie: gerencia }, payload: { corrections: { emergencyContactName: 'Otro' } } });
      const r = await app.inject({ method: 'PATCH', url: `/intakes/${a.id}/corrections`, headers: { cookie: gerencia }, payload: { corrections: null } });
      expect(r.json()).toEqual({ corrections: null, correctedAt: null, correctedByName: null });
      expect((await detalle(a.id)).intake.corrections).toBeNull();
    });

    it('aprobar convierte al interesado que era la misma persona, en la misma operación (10-10)', async () => {
      const p = await interesado();
      await contacto(p.id, { channel: 'WHATSAPP', outcome: 'INTAKE_SENT', nextStepOn: enDias(2) });
      const a = await enviar({ firstName: p.firstName, lastName: p.lastName, phone: p.phoneE164.slice(3) });
      const ap = await post(`/intakes/${a.id}/approve`, gerencia, {});
      expect(ap.statusCode, ap.body).toBe(201);
      expect(ap.json().convertedProspectId).toBe(p.id);
      expect(await fila(p)).toMatchObject({ status: 'CONVERTED', convertedMemberId: ap.json().memberId });
      // Quien solo comparte celular con un interesado no lo convierte.
      const otro = await interesado();
      const hija = await enviar({ phone: otro.phoneE164.slice(3) });
      expect((await post(`/intakes/${hija.id}/approve`, gerencia, {})).json().convertedProspectId).toBeNull();
      expect((await fila(otro)).status).toBe('NEW');
    });

    it('dos aprobaciones A LA VEZ dejan un solo socio, y la segunda dice quién la aprobó (9-20)', async () => {
      // Sin celular: el índice único del teléfono no ayuda; solo el alta tomada evita la segunda ficha.
      const a = await enviar({ phone: null, email: `${nombreUnico('correo').toLowerCase()}@prueba.mx` });
      const antes = await getDb().member.count({ where: { organizationId: orgId } });
      const [uno, dos] = await Promise.all([post(`/intakes/${a.id}/approve`, gerencia, { force: true }), post(`/intakes/${a.id}/approve`, gerencia, { force: true })]);
      expect([uno.statusCode, dos.statusCode].sort()).toEqual([201, 409]);
      const perdio = uno.statusCode === 409 ? uno : dos;
      expect(perdio.json().reason).toBe('INTAKE_ALREADY_REVIEWED');
      expect(perdio.json().message).toMatch(/ya aprobó esta alta/);
      expect(await getDb().member.count({ where: { organizationId: orgId } })).toBe(antes + 1);
    });

    it('«Es esta persona» lleva lo corregido y la nota de salud, en una operación (9-03), y dice si ya tiene plan (9-17)', async () => {
      const socio = await socioDeAlta();
      const salud = (await getDb().consentDocument.findFirstOrThrow({ where: { organizationId: orgId, consentType: 'HEALTH_DATA', status: 'PUBLISHED' } })).version;
      const a = await enviar({
        firstName: socio.firstName, lastName: socio.lastName, phone: socio.phoneE164.slice(3), healthNotes: 'Lesión de hombro',
        emergencyContactName: null, emergencyContactPhone: null,
        consents: [{ consentType: 'PRIVACY_NOTICE', version, granted: true }, { consentType: 'HOUSE_RULES', version, granted: true }, { consentType: 'HEALTH_DATA', version: salud, granted: true }],
      });
      expect((await detalle(a.id)).matches[0]).toMatchObject({ candidateId: socio.id, hasMembership: false });
      const antes = await getDb().memberConsent.count({ where: { memberId: socio.id } });

      const correo = `${nombreUnico('nuevo').toLowerCase()}@prueba.mx`;
      const r = await post(`/intakes/${a.id}/link`, gerencia, { memberId: socio.id, corrections: { email: correo, emergencyContactName: 'Su hermana' } });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({ memberId: socio.id, memberCode: socio.memberCode });

      const ficha = await getDb().member.findUniqueOrThrow({ where: { id: socio.id } });
      expect(ficha).toMatchObject({ email: correo, emergencyContactName: 'Su hermana' });
      expect(descifrarSensible(ficha.healthNotes)).toBe('Lesión de hombro');
      expect(await getDb().memberConsent.count({ where: { memberId: socio.id } })).toBe(antes + 3);
      const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'intake.link', resourceId: a.id } });
      expect(asiento.afterState).toMatchObject({ healthNotes: true, corregido: { email: { antes: null, despues: correo } } });
      // La nota no va a la bitácora.
      expect(JSON.stringify(asiento.afterState)).not.toContain('hombro');
    });

    it('si vincular falla a medias, la ficha no queda tocada', async () => {
      const socio = await socioDeAlta();
      const otro = await socioDeAlta();
      const a = await enviar({ firstName: socio.firstName, lastName: socio.lastName, phone: socio.phoneE164.slice(3), emergencyContactName: 'No debe quedar' });
      // Corregir el celular al de OTRO socio activo: se explica y no se escribe nada (9-02).
      const r = await post(`/intakes/${a.id}/link`, gerencia, { memberId: socio.id, corrections: { phoneE164: otro.phoneE164.slice(3) } });
      expect(r.statusCode).toBe(409);
      expect(r.json().reason).toBe('PHONE_IN_USE');
      expect(r.json().message).toContain(otro.memberCode);
      const ficha = await getDb().member.findUniqueOrThrow({ where: { id: socio.id } });
      expect(ficha.emergencyContactName).not.toBe('No debe quedar');
      expect((await detalle(a.id)).intake.status).toBe('SUBMITTED');
    });

    it('celular de otro socio: «Es otra persona» ya no responde el 409 genérico; dice de quién es y qué hacer (9-02)', async () => {
      const mama = await socioDeAlta();
      const hija = await enviar({ phone: mama.phoneE164.slice(3) });
      const r = await post(`/intakes/${hija.id}/approve`, gerencia, { force: true });
      expect(r.statusCode).toBe(409);
      expect(r.json().reason).toBe('PHONE_IN_USE');
      expect(r.json().message).toContain(`${mama.firstName} ${mama.lastName}`);
      // Desde D-09 (fase 3, bloque 3.4) el celular se puede compartir: lo que se pide es anotar al responsable.
      expect(r.json().message).toMatch(/responsable del número/);
      const ok = await post(`/intakes/${hija.id}/approve`, gerencia, { responsible: { kind: 'MEMBER', memberId: mama.id } });
      expect(ok.statusCode, ok.body).toBe(201);
    });

    it('rechazar con un motivo de un toque queda en la bitácora con su sucursal (9-15)', async () => {
      const a = await enviar();
      expect((await post(`/intakes/${a.id}/reject`, gerencia, {})).statusCode).toBe(422);
      expect((await post(`/intakes/${a.id}/reject`, gerencia, { reasonCode: 'NO_EXISTE' })).statusCode).toBe(422);
      const r = await post(`/intakes/${a.id}/reject`, gerencia, { reasonCode: 'NO_SE_PRESENTO' });
      expect(r.statusCode, r.body).toBe(200);
      expect((await getDb().memberIntake.findUniqueOrThrow({ where: { id: a.id } })).rejectionReason).toBe('No se presentó');
      const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'intake.reject', resourceId: a.id } });
      expect(asiento.branchId).toBe(sede.id);
      // El texto libre de antes sigue valiendo.
      const b = await enviar();
      expect((await post(`/intakes/${b.id}/reject`, gerencia, { reason: 'Duplicado confirmado' })).statusCode).toBe(200);
      // Y rechazada ya no se decide otra vez.
      expect((await post(`/intakes/${b.id}/reject`, gerencia, { reasonCode: 'PRUEBA' })).json().reason).toBe('INTAKE_ALREADY_REVIEWED');
    });
  });

  // ── Cierre del alta ───────────────────────────────────────────────────────
  describe('el cierre del alta, por el estado del socio (9-01)', () => {
    it('a un socio recién aprobado le falta vender, portal y lo que no llenó; el primero es vender', async () => {
      const a = await enviar({ birthDate: null });
      const ap = (await post(`/intakes/${a.id}/approve`, gerencia, {})).json();
      const r = await get(`/members/${ap.memberId}/onboarding`, gerencia);
      expect(r.statusCode, r.body).toBe(200);
      const o = r.json();
      expect(o).toMatchObject({ memberId: ap.memberId, memberCode: ap.memberCode, next: 'SELL', show: true, daysSinceCreated: 0, membership: null, owesCents: '0', missingFields: ['birthDate'] });
      expect(o.steps[0]).toEqual({ key: 'SELL', done: false, optional: false });
      expect(o.steps.map((s: { key: string }) => s.key)).toEqual(expect.arrayContaining(['SELL', 'DATA']));
      // Sin cobrar todavía: no hay nada que cobrar hasta que se le venda.
      expect(o.steps.map((s: { key: string }) => s.key)).not.toContain('COLLECT');
    });

    it('pasada la semana la franja ya no se pinta, aunque los pasos sigan diciendo qué falta', async () => {
      const socio = await socioDeAlta();
      await getDb().member.update({ where: { id: socio.id }, data: { createdAt: new Date(Date.now() - 9 * 86_400_000) } });
      const o = (await get(`/members/${socio.id}/onboarding`, gerencia)).json();
      expect(o.show).toBe(false);
      expect(o.daysSinceCreated).toBe(9);
      expect(o.next).toBe('SELL');
    });

    it('es del mostrador: un socio ajeno responde 404 y el coach no lo consulta', async () => {
      const f = await orgFixtures();
      const ajeno = await getDb().member.findFirst({ where: { organizationId: f.other.id } });
      if (ajeno) expect((await get(`/members/${ajeno.id}/onboarding`, gerencia)).statusCode).toBe(404);
      const coach = await loginAs(app, 'coach@demo.mx');
      const socio = await socioDeAlta();
      // Sin el permiso del mostrador no hay respuesta (403, o 404 si ni siquiera ve al socio).
      expect([403, 404]).toContain((await get(`/members/${socio.id}/onboarding`, coach)).statusCode);
    });
  });
});
