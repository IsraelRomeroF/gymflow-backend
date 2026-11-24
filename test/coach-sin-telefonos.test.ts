import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ROLE_BY_KEY, adjustableFor, uuidv7 } from '@gymflow/core';
import { makeApp, loginAs, nombreUnico, telefonoUnico, cuentaDePrueba, CONSENTIMIENTOS } from './helpers.js';
import { gimnasioPropio, sesionesDe, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { registeredRoutes } from '../src/platform/http/registry.js';
import { CONSULTAS, OTROS_PARAMETROS, RECURSO_POR_PREFIJO } from './rutas-clasificacion.js';
import type { GimnasioDeRutas, RecursoClase } from './rutas-fixtures.js';

/**
 * EL COACH NO VE TELÉFONOS (auditoría 8, fase 4, bloque 4.7; decisión D-30 (a)).
 *
 * Israel decidió «no, como hoy»: el coach no ve el teléfono ni el correo de
 * nadie, ni de sus propios socios, y no tiene botón de WhatsApp. Esta prueba
 * no revisa una ruta: RECORRE lo que la API le entrega a un coach. Siembra un
 * gimnasio con datos de contacto reconocibles (de su socio, de un socio que
 * no es suyo, del adulto responsable de un menor, de un interesado y de un
 * alta por revisar), pide como coach TODAS las lecturas del registro de rutas
 * más las búsquedas que se hacen con POST, y exige dos cosas de cada
 * respuesta:
 *   1. en ninguna parte del cuerpo aparece uno de esos teléfonos o correos;
 *   2. ningún campo de teléfono, correo o WhatsApp trae un valor, salvo los
 *      declarados abajo (los suyos y los del gimnasio, que no son de un socio).
 * Una ruta nueva que le entregue un teléfono a un coach hace fallar esto sin
 * que nadie tenga que acordarse de agregarla.
 */
describe('el coach no ve teléfonos ni correos de los socios (D-30)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente: string;
  let recepcion: string;
  let sede: string;
  const coach = { id: '', correo: '', cookie: '' };
  /** Lo que NO debe salir: cada dato con su dueño, para que el fallo diga de quién era. */
  const secretos: Array<{ de: string; valor: string }> = [];
  const ids = {} as Record<RecursoClase, string>;
  let suyo: { id: string; nombre: string; apellido: string; telefono: string };
  let ajeno: { id: string; apellido: string };
  let menor: { id: string };

  const NADIE = '01890000-0000-7000-8000-000000000000';
  const HORA = 3_600_000;
  type Metodo = 'GET' | 'POST' | 'PUT' | 'PATCH';
  const pedir = (cookie: string | null, method: Metodo, url: string, payload?: unknown) =>
    app.inject({ method, url, ...(cookie ? { headers: { cookie } } : {}), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

  /** Un teléfono se busca como viaja (`+52…`) y como se escribe (10 dígitos); un correo, sin distinguir mayúsculas. */
  function secreto(de: string, valor: string): string {
    secretos.push({ de, valor: valor.toLowerCase() });
    if (valor.startsWith('+52')) secretos.push({ de, valor: valor.slice(3) });
    return valor;
  }
  const correoDe = (quien: string) => `${nombreUnico(quien).toLowerCase()}@contacto-secreto.mx`;

  async function socio(etiqueta: string, extra: Record<string, unknown> = {}): Promise<{ id: string; nombre: string; apellido: string; telefono: string }> {
    const nombre = nombreUnico('Socia');
    const apellido = nombreUnico(etiqueta);
    const telefono = secreto(`el celular de ${etiqueta}`, telefonoUnico());
    const r = await pedir(recepcion, 'POST', '/members', {
      firstName: nombre, lastName: apellido, phoneE164: telefono, email: secreto(`el correo de ${etiqueta}`, correoDe(etiqueta)),
      emergencyContactName: 'Contacto De Emergencia', emergencyContactPhone: secreto(`el contacto de emergencia de ${etiqueta}`, telefonoUnico()),
      homeBranchId: sede, force: true, consents: CONSENTIMIENTOS, ...extra,
    });
    expect(r.statusCode, r.body).toBe(201);
    return { id: r.json().id as string, nombre, apellido, telefono };
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio();
    ({ gerente, recepcion } = await sesionesDe(app, g));
    sede = g.sedes[0]!.id;
    const db = getDb();

    coach.correo = await cuentaDePrueba(g.organizationId, 'COACH', [null]);
    coach.id = (await db.user.findFirstOrThrow({ where: { email: coach.correo }, select: { id: true } })).id;
    coach.cookie = await loginAs(app, coach.correo);

    // Su socio, con todo lo que se le puede saber: celular, correo y contacto de emergencia.
    suyo = await socio('Suya', { coachUserId: coach.id });
    // Un socio que no es suyo.
    ajeno = await socio('Ajena');
    // Un menor que también es suyo y cuyo celular es el de un adulto que no es socio (D-09, D-10).
    const m = await socio('Menor', { coachUserId: coach.id });
    menor = { id: m.id };
    await db.member.update({
      where: { id: m.id },
      data: { responsibleKind: 'ADULT', responsibleName: 'Tutor Responsable', responsiblePhoneE164: secreto('el celular del tutor del menor', telefonoUnico()) },
    });

    // Con plan, en una clase del coach, con rutina, con un contacto anotado y con un cargo: lo que llena sus pantallas.
    const plan = uuidv7();
    await db.plan.create({ data: { id: plan, organizationId: g.organizationId, code: 'CONCLASES', name: 'Con clases', billingModel: 'RECURRING', durationUnit: 'MONTH', durationValue: 1, priceCents: 90_000n, includesClasses: true } });
    await db.planBranchAvailability.create({ data: { planId: plan, branchId: sede, organizationId: g.organizationId } });
    const membresia = uuidv7();
    for (const [id, memberId] of [[membresia, suyo.id], [uuidv7(), menor.id], [uuidv7(), ajeno.id]] as const) {
      await db.membership.create({
        data: {
          id, organizationId: g.organizationId, memberId, planId: plan, soldAtBranchId: sede, status: 'ACTIVE',
          startDate: new Date(), currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 90 * 24 * HORA), billingAnchorDay: 1,
        },
      });
    }
    const tipo = await pedir(gerente, 'POST', '/classes/types', { name: 'Funcional', defaultCapacity: 12 });
    expect(tipo.statusCode, tipo.body).toBe(201);
    const empieza = new Date(Date.now() + 2 * HORA);
    const sesion = uuidv7();
    await db.classSchedule.create({
      data: {
        id: sesion, organizationId: g.organizationId, branchId: sede, classTypeId: tipo.json().id, coachUserId: coach.id,
        occurrenceKey: `prueba:${uuidv7()}`, startsAt: empieza, endsAt: new Date(empieza.getTime() + HORA), businessDate: new Date(empieza.toISOString().slice(0, 10)), capacity: 10,
      },
    });
    const reservas: string[] = [];
    // En la lista de SU clase hay una socia suya y una que no lo es.
    for (const memberId of [suyo.id, ajeno.id]) {
      const r = await pedir(recepcion, 'POST', `/classes/schedules/${sesion}/bookings`, { memberId });
      expect(r.statusCode, r.body).toBe(201);
      reservas.push(r.json().id as string);
    }
    const ejercicios = (await pedir(coach.cookie, 'GET', '/exercises')).json().exercises as Array<{ id: string }>;
    const rutina = await pedir(coach.cookie, 'POST', '/routines', {
      name: nombreUnico('Rutina'), goal: 'FUERZA', level: 'INTERMEDIO', days: [{ name: 'Pierna', items: [{ exerciseId: ejercicios[0]!.id, sets: 4, reps: '8', restSeconds: 90 }] }],
    });
    expect(rutina.statusCode, rutina.body).toBe(201);
    expect((await pedir(coach.cookie, 'POST', `/members/${suyo.id}/routine`, { routineId: rutina.json().id })).statusCode).toBe(201);
    expect((await pedir(recepcion, 'POST', `/members/${suyo.id}/follow-ups`, { channel: 'CALL', outcome: 'ANSWERED', note: 'Dice que regresa el lunes' })).statusCode).toBe(201);

    // Un interesado y un alta por revisar de la misma sede: tampoco son para el coach.
    const interesado = await pedir(recepcion, 'POST', '/prospects', {
      branchId: sede, firstName: nombreUnico('Inte'), lastName: nombreUnico('Resada'),
      phoneE164: secreto('el celular de una interesada', telefonoUnico()), email: secreto('el correo de una interesada', correoDe('interesada')),
    });
    expect(interesado.statusCode, interesado.body).toBe(201);
    const celularDelAlta = secreto('el celular de un alta por revisar', telefonoUnico());
    const alta = await pedir(null, 'POST', `/intake/${sede}`, {
      firstName: nombreUnico('Alta'), lastName: nombreUnico('Digital'), phone: celularDelAlta.slice(3), email: secreto('el correo de un alta por revisar', correoDe('alta')),
      birthDate: '1994-03-08', emergencyContactName: 'Contacto Emergencia', emergencyContactPhone: secreto('la emergencia de un alta por revisar', telefonoUnico()).slice(3),
      memberSince: null, healthNotes: null, adult: true,
      consents: CONSENTIMIENTOS.map((c) => ({ consentType: c.consentType, version: c.documentVersion, granted: true })),
    });
    expect(alta.statusCode, alta.body).toBe(201);

    // Con qué id se llena cada `:id` del registro de rutas; lo que no se sembró, un id que no existe.
    for (const clase of new Set<RecursoClase>([...Object.values(RECURSO_POR_PREFIJO), ...Object.values(OTROS_PARAMETROS).filter((x): x is RecursoClase => typeof x === 'string')])) ids[clase] = NADIE;
    Object.assign(ids, {
      member: suyo.id, user: coach.id, branch: sede, plan, membership: membresia, classSchedule: sesion, classType: tipo.json().id,
      classBooking: reservas[0]!, routine: rutina.json().id, prospect: interesado.json().id, intake: alta.json().id,
    } satisfies Partial<Record<RecursoClase, string>>);
  }, 120_000);

  afterAll(async () => {
    await getDb().memberIntake.updateMany({ where: { organizationId: g.organizationId, status: 'SUBMITTED' }, data: { status: 'REJECTED', rejectionReason: 'Fin de la prueba', reviewedAt: new Date() } });
    await g.cerrar();
    await app.close();
    await closeDb();
  });

  /** Campos que, por su nombre, llevan un teléfono, un correo o un WhatsApp. */
  const ES_CONTACTO = /phone|email|whatsapp|celular|telefono|correo/i;
  /**
   * Los únicos datos de contacto que un coach puede recibir, y por qué: ninguno es de un socio.
   * Cada entrada es `ruta → campos`; lo que no esté aquí y traiga valor hace fallar la prueba.
   */
  const PERMITIDOS: Record<string, { campos: RegExp; porque: string }> = {
    'GET /auth/me': { campos: /./, porque: 'su propia cuenta: su correo y el del gimnasio' },
    'GET /auth/sessions': { campos: /./, porque: 'sus propias sesiones' },
    'GET /organization': { campos: /./, porque: 'los datos del gimnasio (correo de facturación, teléfonos de la marca), no de un socio' },
    'GET /branches': { campos: /./, porque: 'el teléfono de la sucursal' },
    'GET /branches/:id': { campos: /./, porque: 'el teléfono de la sucursal' },
  };

  /** Todo valor no vacío de un campo de contacto, con su camino dentro del JSON. */
  function contactosEn(valor: unknown, camino = ''): Array<{ camino: string; valor: unknown }> {
    if (Array.isArray(valor)) return valor.flatMap((v, i) => contactosEn(v, `${camino}[${i}]`));
    if (valor === null || typeof valor !== 'object') return [];
    return Object.entries(valor as Record<string, unknown>).flatMap(([k, v]) => {
      const aqui = `${camino}.${k}`;
      if (ES_CONTACTO.test(k) && v !== null && v !== '' && v !== false && typeof v !== 'object') {
        // Banderas y cuentas («hasPhone», «phoneShared: true», «emails: 3») no son el dato; un texto o un número largo, sí.
        if (typeof v === 'boolean' || (typeof v === 'number' && v < 1_000_000)) return [];
        return [{ camino: aqui, valor: v }];
      }
      return contactosEn(v, aqui);
    });
  }

  type Hallazgo = { ruta: string; url: string; que: string };
  /** Revisa una respuesta ya recibida. Devuelve lo que no debía venir. */
  function revisar(ruta: string, url: string, status: number, cuerpo: string): Hallazgo[] {
    if (status >= 400) return [];
    const mal: Hallazgo[] = [];
    const texto = cuerpo.toLowerCase();
    for (const s of secretos) if (texto.includes(s.valor)) mal.push({ ruta, url, que: `trae ${s.de}` });
    let json: unknown = null;
    try { json = JSON.parse(cuerpo); } catch { return mal; }
    const permitido = PERMITIDOS[ruta];
    for (const c of contactosEn(json)) {
      if (permitido && permitido.campos.test(c.camino)) continue;
      mal.push({ ruta, url, que: `el campo ${c.camino} trae un valor (${String(c.valor).slice(0, 4)}…)` });
    }
    return mal;
  }

  function urlDe(r: { method: string; url: string }): string {
    const clase = RECURSO_POR_PREFIJO[r.url.split('/:')[0]!];
    const camino = r.url.replace(/:\w+/g, (param) => {
      if (param === ':id') return clase ? ids[clase] : NADIE;
      const otro = OTROS_PARAMETROS[param];
      if (!otro) return param === ':key' ? 'classes' : NADIE;
      return typeof otro === 'string' ? ids[otro] : otro.literal;
    });
    const propia = CONSULTAS[`${r.method} ${r.url}`];
    const consulta = typeof propia === 'function' ? propia({ ids, mes: new Date().toISOString().slice(0, 7), organizationId: g.organizationId, sedeA: sede, sedeB: sede } as unknown as GimnasioDeRutas) : propia;
    return consulta ? `${camino}?${consulta}` : camino;
  }

  it('el puesto: no edita ni da de alta socios (de ahí cuelga ver el contacto), y no hay forma de encendérselo por persona', () => {
    const permisos = ROLE_BY_KEY.get('COACH')!.permissions as readonly string[];
    // `vista()` de `members.serializers.ts` entrega teléfono, correo y emergencia solo con uno de estos dos.
    // Los otros son los que abren las pantallas con botón de WhatsApp o de llamar (Mensajes, Retención, Prospectos) y las altas.
    for (const p of ['members:update', 'members:create', 'members:message:send', 'members:intake:read', 'members:intake:review', 'members:export', 'reports:branch:read', 'retention:followup:write']) {
      expect(permisos, p).not.toContain(p);
      expect(adjustableFor('COACH').has(p), `${p} no se le enciende a un coach`).toBe(false);
    }
  });

  it('NINGUNA lectura de la API le entrega a un coach un teléfono o un correo: todas las rutas GET del registro, con sus socios en ellas', async () => {
    const rutas = registeredRoutes().filter((r) => r.method === 'GET' && (r.security.kind === 'permission' || r.security.kind === 'session'));
    expect(rutas.length).toBeGreaterThan(150);
    const mal: Hallazgo[] = [];
    const respondieron: string[] = [];
    for (const r of rutas) {
      const ruta = `GET ${r.url}`;
      const url = urlDe(r);
      const res = await pedir(coach.cookie, 'GET', url);
      if (res.statusCode < 400) respondieron.push(ruta);
      mal.push(...revisar(ruta, url, res.statusCode, res.body));
    }
    expect(mal.map((h) => `${h.ruta} → ${h.que}`).sort()).toEqual([]);

    // La prueba no pasa por vacía: el coach SÍ recibió a sus socios en las pantallas que usa.
    for (const ruta of ['GET /members', 'GET /members/:id', 'GET /coach/today', 'GET /classes/schedules/:id/bookings', 'GET /members/:id/routine', 'GET /members/:id/history']) {
      expect(respondieron, `${ruta} le respondió al coach`).toContain(ruta);
    }
    expect(respondieron.length).toBeGreaterThan(25);
    // …y lo que ve de ella es su nombre, con el contacto marcado como oculto (no como «no tiene»).
    const ficha = (await pedir(coach.cookie, 'GET', `/members/${suyo.id}`)).json();
    expect(ficha).toMatchObject({ firstName: suyo.nombre, phoneE164: null, email: null, emergencyContactName: null, emergencyContactPhone: null });
    expect(ficha.hidden).toContain('contact');
    // La gerencia, con la misma ruta, sí lo ve: el dato existe y es el permiso el que lo tapa.
    expect((await pedir(gerente, 'GET', `/members/${suyo.id}`)).json().phoneE164).toBe(suyo.telefono);
  }, 180_000);

  it('tampoco buscando: ni el padrón, ni el buscador, ni «¿ya existe?» le devuelven un teléfono, aunque lo teclee completo', async () => {
    const mal: Hallazgo[] = [];
    const lecturas = [
      `/members?q=${encodeURIComponent(suyo.apellido)}`, `/members?q=${suyo.telefono.slice(3)}`, `/members?q=${encodeURIComponent(ajeno.apellido)}`,
      `/members/search?q=${encodeURIComponent(suyo.apellido)}`, `/members/search?q=${suyo.telefono.slice(3)}`, `/members/search?q=${suyo.telefono.slice(-4)}`,
      `/members/${menor.id}`, `/members/${menor.id}/shared-phone`, `/members/${suyo.id}/shared-phone`, `/members/${ajeno.id}`, `/members/${ajeno.id}/health`,
      `/members/${suyo.id}/history`, `/members/${suyo.id}/follow-ups`, `/members/follow-ups/latest?ids=${suyo.id},${menor.id}`,
      `/coaches/${coach.id}/members`, `/prospects`, `/prospects?view=uncontacted`, `/prospects/${ids.prospect}/follow-ups`, `/intakes`, `/intakes/${ids.intake}`,
      `/classes/schedules/${ids.classSchedule}/bookings`, `/members/${suyo.id}/bookings`, `/outbound/messages`, `/retention/alerts`,
    ];
    for (const url of lecturas) {
      const res = await pedir(coach.cookie, 'GET', url);
      // El buscador repite lo que se le tecleó (`query`): eso no es un dato entregado, se quita antes de revisar.
      const cuerpo = res.statusCode < 400 && url.startsWith('/members/search') ? JSON.stringify({ ...res.json(), query: undefined }) : res.body;
      mal.push(...revisar(`GET ${url.split('?')[0]}`, url, res.statusCode, cuerpo));
    }

    // BUSCAR POR TELÉFONO NO LE DICE NADA. Si el buscador encontrara a su socia por los dígitos que teclea, el coach
    // podría ir leyendo el número cifra por cifra. Por nombre sí la encuentra; por su celular, completo o a pedazos, no.
    const resultados = async (q: string) => ((await pedir(coach.cookie, 'GET', `/members/search?q=${encodeURIComponent(q)}`)).json().results as Array<{ id: string }>).map((x) => x.id);
    const padron = async (q: string) => ((await pedir(coach.cookie, 'GET', `/members?q=${encodeURIComponent(q)}`)).json().members as Array<{ id: string }>).map((x) => x.id);
    expect(await resultados(suyo.apellido)).toContain(suyo.id);
    expect(await padron(suyo.apellido)).toContain(suyo.id);
    const diez = suyo.telefono.slice(3);
    for (const q of [suyo.telefono, diez, diez.slice(0, 4), diez.slice(-4), diez.slice(2, 8)]) {
      expect(await resultados(q), `buscador con «${q}»`).not.toContain(suyo.id);
      expect(await padron(q), `padrón con «${q}»`).not.toContain(suyo.id);
    }
    // A recepción, que sí ve el teléfono, el mismo buscador se lo sigue encontrando por el celular.
    const deRecepcion = (await pedir(recepcion, 'GET', `/members/search?q=${diez}`)).json().results as Array<{ id: string }>;
    expect(deRecepcion.map((x) => x.id)).toContain(suyo.id);
    expect(((await pedir(recepcion, 'GET', `/members?q=${diez.slice(-4)}`)).json().members as Array<{ id: string }>).map((x) => x.id)).toContain(suyo.id);
    const busquedas: Array<[string, unknown]> = [
      ['/members/check-duplicates', { firstName: suyo.nombre, lastName: suyo.apellido }],
      ['/members/check-duplicates', { phoneE164: suyo.telefono }],
    ];
    for (const [url, cuerpo] of busquedas) {
      const res = await pedir(coach.cookie, 'POST', url, cuerpo);
      // Lo tecleado por el propio coach no cuenta como entregado: se quita antes de revisar.
      const sinLoTecleado = res.body.split(suyo.telefono).join('').split(suyo.telefono.slice(3)).join('');
      mal.push(...revisar(`POST ${url}`, url, res.statusCode, typeof cuerpo === 'object' && cuerpo && 'phoneE164' in cuerpo ? sinLoTecleado : res.body));
    }
    expect(mal.map((h) => `${h.url} → ${h.que}`).sort()).toEqual([]);

    // A las interesadas y a las altas por revisar ni siquiera las lista: no son de su trabajo.
    expect((await pedir(coach.cookie, 'GET', '/prospects')).json().items ?? []).toEqual([]);
    expect((await pedir(coach.cookie, 'GET', '/intakes')).statusCode).toBe(403);
    // Y a la socia que no es suya no la abre.
    expect([403, 404]).toContain((await pedir(coach.cookie, 'GET', `/members/${ajeno.id}`)).statusCode);
  });

  it('al sumarse a un socio con su código («Hacerme su coach») tampoco recibe su contacto', async () => {
    const nueva = await socio('PorSumar');
    const invite = await pedir(gerente, 'POST', `/members/${nueva.id}/portal-invite`);
    expect(invite.statusCode, invite.body).toBe(201);
    const enroll = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code } });
    expect(enroll.statusCode, enroll.body).toBe(201);
    const portal = `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}`;
    const codigo = await pedir(portal, 'POST', '/portal/coach/code');
    expect(codigo.statusCode, codigo.body).toBe(201);
    const r = await pedir(coach.cookie, 'POST', '/coach/claim', { code: codigo.json().code });
    expect(r.statusCode, r.body).toBe(200);
    expect(revisar('POST /coach/claim', '/coach/claim', r.statusCode, r.body)).toEqual([]);
    const ficha = (await pedir(coach.cookie, 'GET', `/members/${nueva.id}`)).json();
    expect(ficha).toMatchObject({ id: nueva.id, phoneE164: null, email: null });
  });
});
