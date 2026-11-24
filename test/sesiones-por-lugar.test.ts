import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { makeApp, loginPlataforma, PASSWORD, CONSENTIMIENTOS, nombreUnico } from './helpers.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { ponerReloj, relojReal } from './reloj.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { hashToken } from '../src/platform/crypto.js';
import { AuthService } from '../src/modules/identity/auth.service.js';
import { esTelefono } from '../src/modules/identity/equipo.js';
import { OWNER_PHONE_IDLE_DAYS, OWNER_PHONE_MAX_DAYS, SessionRepository } from '../src/modules/identity/session.repository.js';
import { CIERRE_POR_REGLA_ANTERIOR, MEMBER_IDLE_DAYS } from '../src/modules/portal/portal.repository.js';
import { loadEnv } from '../src/platform/env.js';

/**
 * SESIONES POR LUGAR (D-04, opción a; fase 4, bloque 4.1).
 *
 * - Mostrador: 12 h desde que se entra, pase lo que pase.
 * - Teléfono de la dueña: 30 días mientras se use (se renueva con el uso), con tope de 90.
 * - Portal del socio: abierto mientras se use; se cierra tras 30 días sin abrirlo.
 *
 * Con el reloj de prueba (`reloj.ts`): la hora se adelanta en este proceso y
 * todo lo que decide si una sesión vive sale de ese reloj, no del de la base.
 * Gimnasio propio: nada de esto toca al de los demás archivos.
 */
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const UA_TABLETA = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const UA_IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const UA_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const HORA = 3_600_000;
const DIA = 24 * HORA;

/** El reloj de verdad, guardado antes de que nadie lo corra. */
const DateDeVerdad = Date;
/** Pone el reloj `ms` después de AHORA (del de verdad) y lo deja caminar. */
const dentroDe = (ms: number) => ponerReloj(new DateDeVerdad(DateDeVerdad.now() + ms).toISOString());

describe('sesiones por lugar (D-04)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  const db = () => getDb();

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio();
  });
  afterEach(() => relojReal());
  afterAll(async () => {
    relojReal();
    await db().session.updateMany({ where: { organizationId: g.organizationId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'fin_de_prueba' } });
    await g.cerrar();
    await app.close();
    await closeDb();
  });

  const galletaDe = (r: LightMyRequestResponse, nombre = 'gf_session') => r.cookies.find((c) => c.name === nombre);
  async function entrar(email: string, ua?: string): Promise<{ cookie: string; respuesta: LightMyRequestResponse }> {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD }, headers: ua ? { 'user-agent': ua } : {} });
    expect(r.statusCode, r.body).toBe(200);
    return { cookie: `gf_session=${galletaDe(r)!.value}`, respuesta: r };
  }
  const usar = (cookie: string, ua?: string, url = '/auth/me') => app.inject({ method: 'GET', url, headers: { cookie, ...(ua ? { 'user-agent': ua } : {}) } });
  const fila = (cookie: string) => db().session.findUniqueOrThrow({ where: { tokenHash: hashToken(cookie.split('=')[1]!) } });
  /** Cuánto le falta a una cookie recién puesta, según el reloj de la prueba. */
  const faltan = (c: { expires?: Date | undefined } | undefined) => new Date(c!.expires!).getTime() - Date.now();

  // ── Qué es «mostrador» y qué es «teléfono de la dueña» ───────────────────────

  it('qué navegador cuenta como teléfono: iPhone y Android de bolsillo; tableta, computadora o nada, no', () => {
    expect(esTelefono(UA_IPHONE)).toBe(true);
    expect(esTelefono(UA_ANDROID)).toBe(true);
    for (const ua of [UA_TABLETA, UA_IPAD, UA_WINDOWS, '', undefined, null, 'curl/8.5.0', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.5 Mobile/15E148 Safari/604.1']) {
      expect(esTelefono(ua), String(ua)).toBe(false);
    }
  });

  it('el lugar se decide al entrar: solo la dueña, en un teléfono y sin contraseña temporal; todo lo demás es mostrador', () => {
    const auth = new AuthService(loadEnv({ ...process.env, NODE_ENV: 'test' }));
    const deGimnasio = { organizationId: g.organizationId, mustChangePassword: false };
    expect(auth.lugarDe(deGimnasio, ['OWNER'], UA_IPHONE)).toBe('OWNER_PHONE');
    expect(auth.lugarDe(deGimnasio, ['OWNER'], UA_ANDROID)).toBe('OWNER_PHONE');
    // La dueña fuera de su teléfono: la corta.
    for (const ua of [UA_WINDOWS, UA_IPAD, UA_TABLETA, undefined]) expect(auth.lugarDe(deGimnasio, ['OWNER'], ua), String(ua)).toBe('COUNTER');
    // Los demás puestos, también en su teléfono: la corta.
    for (const puesto of ['MANAGER', 'RECEPTION', 'COACH']) expect(auth.lugarDe(deGimnasio, [puesto], UA_IPHONE), puesto).toBe('COUNTER');
    expect(auth.lugarDe(deGimnasio, [], UA_IPHONE)).toBe('COUNTER');
    // Con contraseña temporal, y la consola de plataforma: la corta.
    expect(auth.lugarDe({ organizationId: g.organizationId, mustChangePassword: true }, ['OWNER'], UA_IPHONE)).toBe('COUNTER');
    expect(auth.lugarDe({ organizationId: null, mustChangePassword: false }, ['OWNER'], UA_IPHONE)).toBe('COUNTER');
  });

  it('al entrar queda escrito el lugar: gerencia y recepción en su teléfono y la dueña en la computadora son mostrador (12 h)', async () => {
    for (const [email, ua] of [[g.correos.gerente, UA_IPHONE], [g.correos.recepcion, UA_ANDROID], [g.correos.owner, UA_WINDOWS], [g.correos.owner, UA_IPAD], [g.correos.owner, undefined]] as const) {
      const { cookie, respuesta } = await entrar(email, ua);
      const s = await fila(cookie);
      expect(s.kind, `${email} ${ua}`).toBe('COUNTER');
      expect(s.expiresAt.getTime() - s.createdAt.getTime()).toBeCloseTo(12 * HORA, -4);
      expect(Math.abs(faltan(galletaDe(respuesta)) - 12 * HORA)).toBeLessThan(5000);
      const me = (await usar(cookie, ua)).json();
      expect(me.session).toMatchObject({ kind: 'COUNTER', renews: false, idleDays: null });
      expect(me.session.maxEndsAt).toBe(me.session.endsAt);
    }
  });

  it('la consola de plataforma en un teléfono sigue con su sesión corta (8 h)', async () => {
    const cookie = await loginPlataforma(app);
    const s = await fila(cookie);
    expect(s.kind).toBe('COUNTER');
    expect(s.expiresAt.getTime() - s.createdAt.getTime()).toBeCloseTo(8 * HORA, -4);
  });

  // ── Mostrador ────────────────────────────────────────────────────────────────

  it('mostrador: se cierra a las 12 h de haber entrado aunque se use sin parar, y usarla no vuelve a poner la cookie', async () => {
    const { cookie } = await entrar(g.correos.recepcion, UA_WINDOWS);
    const al = (await fila(cookie)).expiresAt.getTime();
    for (const horas of [3, 6, 9, 11.9]) {
      dentroDe(horas * HORA);
      const r = await usar(cookie, UA_WINDOWS);
      expect(r.statusCode, `a las ${horas} h`).toBe(200);
      expect(galletaDe(r), 'no se renueva').toBeUndefined();
    }
    expect((await fila(cookie)).expiresAt.getTime()).toBe(al);
    dentroDe(12 * HORA + 60_000);
    const r = await usar(cookie, UA_WINDOWS);
    expect(r.statusCode).toBe(401);
    expect(r.json().reason).toBe('SESSION_EXPIRED');
  });

  it('la dueña en la computadora del gimnasio también se cierra a las 12 h, y desde su teléfono con ESA cookie no se alarga', async () => {
    const { cookie } = await entrar(g.correos.owner, UA_WINDOWS);
    const al = (await fila(cookie)).expiresAt.getTime();
    dentroDe(6 * HORA);
    // La cookie del mostrador presentada con un navegador de teléfono: sigue siendo de mostrador.
    const r = await usar(cookie, UA_IPHONE);
    expect(r.statusCode).toBe(200);
    expect(galletaDe(r)).toBeUndefined();
    expect((await fila(cookie)).expiresAt.getTime()).toBe(al);
    dentroDe(12 * HORA + 60_000);
    expect((await usar(cookie, UA_IPHONE)).json().reason).toBe('SESSION_EXPIRED');
  });

  // ── Teléfono de la dueña ─────────────────────────────────────────────────────

  it('teléfono de la dueña: nace con 30 días, /auth/me lo dice, y cada uso la renueva (cookie y base con la misma fecha)', async () => {
    const { cookie, respuesta } = await entrar(g.correos.owner, UA_IPHONE);
    const s = await fila(cookie);
    expect(s.kind).toBe('OWNER_PHONE');
    expect(s.expiresAt.getTime() - s.createdAt.getTime()).toBeCloseTo(OWNER_PHONE_IDLE_DAYS * DIA, -4);
    expect(Math.abs(faltan(galletaDe(respuesta)) - 30 * DIA)).toBeLessThan(5000);
    expect(respuesta.json().secondsLeft).toBeGreaterThan(30 * 86_400 - 5);

    const me = (await usar(cookie, UA_IPHONE)).json();
    expect(me.session).toMatchObject({ kind: 'OWNER_PHONE', renews: true, idleDays: 30 });
    expect(new Date(me.session.maxEndsAt).getTime()).toBe(s.createdAt.getTime() + OWNER_PHONE_MAX_DAYS * DIA);
    expect(new Date(me.session.endsAt).getTime()).toBe(s.expiresAt.getTime());

    // Al día siguiente (un mostrador ya estaría cerrado): sigue, y se renueva.
    dentroDe(10 * DIA);
    const r = await usar(cookie, UA_IPHONE);
    expect(r.statusCode).toBe(200);
    const nueva = galletaDe(r)!;
    expect(nueva.value, 'la misma sesión, no una nueva').toBe(cookie.split('=')[1]);
    expect(nueva.httpOnly).toBe(true);
    expect(Math.abs(faltan(nueva) - 30 * DIA)).toBeLessThan(5000);
    const tras = await fila(cookie);
    expect(Math.abs(tras.expiresAt.getTime() - (Date.now() + 30 * DIA))).toBeLessThan(5000);
    expect(Math.abs(new Date(nueva.expires!).getTime() - tras.expiresAt.getTime())).toBeLessThan(1500);
    expect(new Date(r.json().session.endsAt).getTime()).toBe(tras.expiresAt.getTime());

    // Enseguida no se vuelve a renovar (como mucho una vez por hora).
    const otra = await usar(cookie, UA_IPHONE);
    expect(otra.statusCode).toBe(200);
    expect(galletaDe(otra)).toBeUndefined();
    expect((await fila(cookie)).expiresAt.getTime()).toBe(tras.expiresAt.getTime());

    // 29 días después del último uso (39 desde que entró) sigue abierta.
    dentroDe(39 * DIA);
    expect((await usar(cookie, UA_IPHONE)).statusCode).toBe(200);
  });

  it('teléfono de la dueña: 30 días sin usarla y se cierra (SESSION_IDLE); presentar la cookie después no la revive', async () => {
    const { cookie } = await entrar(g.correos.owner, UA_IPHONE);
    dentroDe(5 * DIA);
    expect((await usar(cookie, UA_IPHONE)).statusCode).toBe(200);
    const al = (await fila(cookie)).expiresAt.getTime();
    dentroDe(35 * DIA + 60_000);
    const r = await usar(cookie, UA_IPHONE);
    expect(r.statusCode).toBe(401);
    expect(r.json().reason).toBe('SESSION_IDLE');
    expect(r.json().message).toMatch(/30 días sin usar GymFlow en este teléfono/);
    expect(galletaDe(r)).toBeUndefined();
    expect((await fila(cookie)).expiresAt.getTime()).toBe(al);
    expect((await usar(cookie, UA_IPHONE)).statusCode).toBe(401);
  });

  it('teléfono de la dueña: usándola cada 20 días llega a su tope de 90 desde que entró y ahí se cierra (SESSION_EXPIRED)', async () => {
    const { cookie } = await entrar(g.correos.owner, UA_ANDROID);
    const s = await fila(cookie);
    for (const dias of [20, 40, 60, 80]) {
      dentroDe(dias * DIA);
      expect((await usar(cookie, UA_ANDROID)).statusCode, `día ${dias}`).toBe(200);
    }
    // La renovación del día 80 no pasa del día 90.
    const tras = await fila(cookie);
    expect(tras.expiresAt.getTime()).toBe(s.createdAt.getTime() + OWNER_PHONE_MAX_DAYS * DIA);
    dentroDe(89 * DIA);
    const casi = await usar(cookie, UA_ANDROID);
    expect(casi.statusCode).toBe(200);
    expect(galletaDe(casi), 'ya no hay nada que correr').toBeUndefined();
    dentroDe(90 * DIA + 60_000);
    const r = await usar(cookie, UA_ANDROID);
    expect(r.statusCode).toBe(401);
    expect(r.json().reason).toBe('SESSION_EXPIRED');
  });

  it('la cookie del teléfono usada desde una computadora no se renueva', async () => {
    const { cookie } = await entrar(g.correos.owner, UA_IPHONE);
    const al = (await fila(cookie)).expiresAt.getTime();
    dentroDe(5 * DIA);
    for (const ua of [UA_WINDOWS, undefined, UA_IPAD]) {
      const r = await usar(cookie, ua);
      expect(r.statusCode).toBe(200);
      expect(galletaDe(r), String(ua)).toBeUndefined();
    }
    expect((await fila(cookie)).expiresAt.getTime()).toBe(al);
  });

  // ── Nada alarga una sesión cortada ──────────────────────────────────────────

  it('«Cerrar las demás» desde otra sesión corta la del teléfono, y el uso posterior no la revive ni le pone cookie', async () => {
    const telefono = await entrar(g.correos.owner, UA_IPHONE);
    const pc = await entrar(g.correos.owner, UA_WINDOWS);
    const lista = (await usar(pc.cookie, UA_WINDOWS, '/auth/sessions')).json() as Array<{ id: string; kind: string; renews: boolean; current: boolean }>;
    const idTel = (await fila(telefono.cookie)).id;
    expect(lista.find((x) => x.id === idTel)).toMatchObject({ kind: 'OWNER_PHONE', renews: true, current: false });
    expect(lista.find((x) => x.current)).toMatchObject({ kind: 'COUNTER', renews: false });

    const cerrar = await app.inject({ method: 'POST', url: '/auth/logout-others', headers: { cookie: pc.cookie, 'user-agent': UA_WINDOWS }, payload: {} });
    expect(cerrar.statusCode, cerrar.body).toBe(200);
    const al = (await fila(telefono.cookie)).expiresAt.getTime();
    // Horas después (cuando tocaría renovar), con el navegador del teléfono: sigue cerrada.
    dentroDe(3 * HORA);
    const r = await usar(telefono.cookie, UA_IPHONE);
    expect(r.statusCode).toBe(401);
    expect(r.json().reason).toBe('SESSION_CLOSED_ELSEWHERE');
    expect(galletaDe(r)).toBeUndefined();
    const tras = await fila(telefono.cookie);
    expect(tras.revokedAt).not.toBeNull();
    expect(tras.expiresAt.getTime()).toBe(al);
  });

  it('cambiar la contraseña corta la sesión del teléfono (PASSWORD_CHANGED) y salir la cierra en el acto', async () => {
    const telefono = await entrar(g.correos.owner, UA_IPHONE);
    const pc = await entrar(g.correos.owner, UA_WINDOWS);
    const nueva = `${PASSWORD}.nueva`;
    const cambio = await app.inject({ method: 'POST', url: '/auth/password', headers: { cookie: pc.cookie }, payload: { current: PASSWORD, next: nueva } });
    expect(cambio.statusCode, cambio.body).toBe(200);
    try {
      dentroDe(2 * HORA);
      const r = await usar(telefono.cookie, UA_IPHONE);
      expect(r.statusCode).toBe(401);
      expect(r.json().reason).toBe('PASSWORD_CHANGED');
      expect(galletaDe(r)).toBeUndefined();
    } finally {
      relojReal();
      const { hash } = await import('@node-rs/argon2');
      await db().user.update({ where: { id: g.ownerId }, data: { passwordHash: await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 }) } });
    }
    // Salir desde el propio teléfono.
    const otra = await entrar(g.correos.owner, UA_IPHONE);
    const salir = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: otra.cookie, 'user-agent': UA_IPHONE }, payload: {} });
    expect(salir.statusCode).toBe(200);
    dentroDe(2 * HORA);
    expect((await usar(otra.cookie, UA_IPHONE)).json().reason).toBe('SESSION_LOGGED_OUT');
  });

  it('renovar solo corre una sesión de teléfono, sin cerrar y sin vencer; nunca una de mostrador', async () => {
    const repo = new SessionRepository();
    const lejos = () => new Date(Date.now() + 60 * DIA);
    const mostrador = await entrar(g.correos.recepcion, UA_WINDOWS);
    expect(await repo.renovar((await fila(mostrador.cookie)).id, lejos())).toBe(false);

    const cerrada = await entrar(g.correos.owner, UA_IPHONE);
    const idCerrada = (await fila(cerrada.cookie)).id;
    await repo.revoke(idCerrada, 'logout_others');
    expect(await repo.renovar(idCerrada, lejos())).toBe(false);

    const vencida = await entrar(g.correos.owner, UA_IPHONE);
    const idVencida = (await fila(vencida.cookie)).id;
    await db().session.update({ where: { id: idVencida }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await repo.renovar(idVencida, lejos())).toBe(false);

    const viva = await entrar(g.correos.owner, UA_IPHONE);
    const idViva = (await fila(viva.cookie)).id;
    // Hacia atrás tampoco: no acorta ni mueve lo que ya valía más.
    expect(await repo.renovar(idViva, new Date(Date.now() + DIA))).toBe(false);
    expect(await repo.renovar(idViva, lejos())).toBe(true);
  });

  it('si deja de ser dueña sin que se le cierren las sesiones, la del teléfono vale lo que una de mostrador y no se renueva', async () => {
    const otro = await gimnasioPropio();
    try {
      const { cookie } = await entrar(otro.correos.owner, UA_IPHONE);
      const al = (await fila(cookie)).expiresAt.getTime();
      const gerente = await db().role.findFirstOrThrow({ where: { organizationId: null, key: 'MANAGER' } });
      await db().roleAssignment.updateMany({ where: { userId: otro.ownerId }, data: { roleId: gerente.id } });
      dentroDe(6 * HORA);
      const r = await usar(cookie, UA_IPHONE);
      expect(r.statusCode).toBe(200);
      expect(galletaDe(r)).toBeUndefined();
      expect((await fila(cookie)).expiresAt.getTime()).toBe(al);
      dentroDe(12 * HORA + 60_000);
      const fin = await usar(cookie, UA_IPHONE);
      expect(fin.statusCode).toBe(401);
      expect(fin.json().reason).toBe('ACCESS_CHANGED');
      expect((await fila(cookie)).revokedReason).toBe('role_changed');
    } finally {
      relojReal();
      await db().session.updateMany({ where: { organizationId: otro.organizationId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'fin_de_prueba' } });
      await otro.cerrar();
    }
  });

  // ── Las sesiones que ya estaban abiertas al aplicar el cambio ───────────────

  it('una sesión de antes del cambio (sin lugar escrito) queda como mostrador: la de la dueña en su teléfono se cierra a sus 12 h', async () => {
    // Como la dejó el código anterior: la columna nueva toma su valor por omisión.
    const token = `de-antes-${uuidv7()}`;
    await db().$executeRaw`
      INSERT INTO sessions (id, "organizationId", "userId", "tokenHash", "userAgent", "mfaSatisfied", "expiresAt")
      VALUES (${uuidv7()}::uuid, ${g.organizationId}::uuid, ${g.ownerId}::uuid, ${hashToken(token)}, ${UA_IPHONE}, true, ${new Date(Date.now() + 12 * HORA)})`;
    const cookie = `gf_session=${token}`;
    const s = await fila(cookie);
    expect(s.kind).toBe('COUNTER');
    dentroDe(6 * HORA);
    const r = await usar(cookie, UA_IPHONE);
    expect(r.statusCode).toBe(200);
    expect(r.json().session).toMatchObject({ kind: 'COUNTER', renews: false });
    expect(galletaDe(r)).toBeUndefined();
    expect((await fila(cookie)).expiresAt.getTime()).toBe(s.expiresAt.getTime());
    dentroDe(12 * HORA + 60_000);
    expect((await usar(cookie, UA_IPHONE)).json().reason).toBe('SESSION_EXPIRED');
  });

  // ── Portal del socio ─────────────────────────────────────────────────────────

  describe('portal del socio', () => {
    let gerencia: string;
    beforeAll(async () => { gerencia = (await entrar(g.correos.gerente)).cookie; });

    async function socioConPortal(): Promise<{ id: string; portal: string; activar: LightMyRequestResponse }> {
      const alta = await app.inject({
        method: 'POST', url: '/members', headers: { cookie: gerencia },
        payload: { firstName: nombreUnico('Lugar'), lastName: nombreUnico('Portal'), homeBranchId: g.sedes[0]!.id, consents: CONSENTIMIENTOS, force: true },
      });
      expect(alta.statusCode, alta.body).toBeLessThan(300);
      const id = alta.json().id as string;
      const invitacion = await app.inject({ method: 'POST', url: `/members/${id}/portal-invite`, headers: { cookie: gerencia } });
      const activar = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invitacion.json().code }, headers: { 'user-agent': UA_ANDROID } });
      expect(activar.statusCode, activar.body).toBe(201);
      return { id, portal: `gf_portal=${galletaDe(activar, 'gf_portal')!.value}`, activar };
    }
    const abrir = (portal: string, url = '/portal/me') => app.inject({ method: 'GET', url, headers: { cookie: portal } });
    const filaPortal = (portal: string) => db().memberSession.findUniqueOrThrow({ where: { tokenHash: hashToken(portal.split('=')[1]!) } });

    it('queda abierto mientras se use: cada uso corre el vencimiento 30 días y vuelve a poner la cookie, también en rutas de otros módulos', async () => {
      const { portal, activar } = await socioConPortal();
      expect(MEMBER_IDLE_DAYS).toBe(30);
      expect(Math.abs(faltan(galletaDe(activar, 'gf_portal')) - 30 * DIA)).toBeLessThan(5000);
      const sesiones = (await abrir(portal, '/portal/sessions')).json();
      expect(sesiones.current.idleDays).toBe(30);

      // Lo usa cada 20 días durante 200: con la regla anterior se habría cerrado a los 7 sin uso y, de todos modos, a los 30 de activado.
      for (let dias = 20; dias <= 200; dias += 20) {
        dentroDe(dias * DIA);
        // Alterna entre una ruta del portal y una de otro módulo (clases): la cookie se renueva en las dos.
        const r = await abrir(portal, dias % 40 === 0 ? '/portal/bookings' : '/portal/me');
        expect(r.statusCode, `día ${dias}: ${r.body}`).toBe(200);
        const nueva = galletaDe(r, 'gf_portal')!;
        expect(nueva, `día ${dias}`).toBeDefined();
        expect(nueva.value).toBe(portal.split('=')[1]);
        expect(nueva.httpOnly).toBe(true);
        expect(Math.abs(faltan(nueva) - 30 * DIA)).toBeLessThan(5000);
        const s = await filaPortal(portal);
        expect(Math.abs(new Date(nueva.expires!).getTime() - s.expiresAt.getTime())).toBeLessThan(1500);
        // En la misma hora no se vuelve a poner.
        expect(galletaDe(await abrir(portal), 'gf_portal')).toBeUndefined();
      }
      const fin = (await abrir(portal, '/portal/sessions')).json();
      expect(Math.abs(new Date(fin.current.expiresAt).getTime() - (Date.now() + 30 * DIA))).toBeLessThan(5000);
    });

    it('30 días sin abrirlo y se cierra (SESSION_IDLE); a los 29 sigue abierto', async () => {
      const { portal } = await socioConPortal();
      dentroDe(29 * DIA);
      expect((await abrir(portal)).statusCode).toBe(200);
      const al = (await filaPortal(portal)).expiresAt.getTime();
      dentroDe(29 * DIA + 30 * DIA + 60_000);
      const r = await abrir(portal);
      expect(r.statusCode).toBe(401);
      expect(r.json().reason).toBe('SESSION_IDLE');
      expect(r.json().message).toMatch(/30 días sin abrir el portal/);
      expect(galletaDe(r, 'gf_portal')).toBeUndefined();
      expect((await filaPortal(portal)).expiresAt.getTime()).toBe(al);
    });

    it('recepción lo cierra desde la ficha y el uso posterior no lo revive; salir borra la cookie aunque tocara renovarla', async () => {
      const { id, portal } = await socioConPortal();
      const cierre = await app.inject({ method: 'POST', url: `/members/${id}/portal-sessions/revoke`, headers: { cookie: gerencia }, payload: {} });
      expect(cierre.statusCode, cierre.body).toBe(200);
      expect(cierre.json().revoked).toBe(1);
      const al = (await filaPortal(portal)).expiresAt.getTime();
      dentroDe(2 * DIA);
      const r = await abrir(portal);
      expect(r.statusCode).toBe(401);
      expect(r.json().reason).toBe('SESSION_CLOSED_EVERYWHERE');
      expect(galletaDe(r, 'gf_portal')).toBeUndefined();
      expect((await filaPortal(portal)).expiresAt.getTime()).toBe(al);
      relojReal();

      // «Cerrar sesión en todos mis teléfonos» días después: la respuesta borra la cookie, no la renueva.
      const otro = await socioConPortal();
      dentroDe(3 * DIA);
      const salir = await app.inject({ method: 'POST', url: '/portal/logout-all', headers: { cookie: otro.portal } });
      expect(salir.statusCode, salir.body).toBe(200);
      const puestas = salir.cookies.filter((c) => c.name === 'gf_portal');
      expect(puestas).toHaveLength(1);
      expect(puestas[0]!.value).toBe('');
      expect((await abrir(otro.portal)).statusCode).toBe(401);
    });

    it('dar de baja al socio corta su portal aunque lo use a diario', async () => {
      const { id, portal } = await socioConPortal();
      dentroDe(10 * DIA);
      expect((await abrir(portal)).statusCode).toBe(200);
      // La baja la da gerencia hoy (su sesión de mostrador no llega al día 10); el socio lo vuelve a abrir al día siguiente.
      relojReal();
      const baja = await app.inject({ method: 'POST', url: `/members/${id}/archive`, headers: { cookie: gerencia }, payload: { reason: 'Se mudó de ciudad' } });
      expect(baja.statusCode, baja.body).toBeLessThan(300);
      dentroDe(11 * DIA);
      const r = await abrir(portal);
      expect(r.statusCode).toBe(401);
      expect(r.json().reason).toBe('ACCOUNT_DEACTIVATED');
      expect(galletaDe(r, 'gf_portal')).toBeUndefined();
    });

    it('las que la migración cerró por llevar más de 7 días sin uso dicen «por falta de uso», con la causa que escribe la migración', async () => {
      const sql = readFileSync(resolve(import.meta.dirname, '../../gymflow-db/prisma/migrations/20261125041000_sesiones_por_lugar/migration.sql'), 'utf8');
      expect(sql).toContain(`'${CIERRE_POR_REGLA_ANTERIOR}'`);
      const { portal } = await socioConPortal();
      await db().memberSession.update({ where: { tokenHash: hashToken(portal.split('=')[1]!) }, data: { revokedAt: new Date(), revokedReason: CIERRE_POR_REGLA_ANTERIOR } });
      const r = await abrir(portal);
      expect(r.statusCode).toBe(401);
      expect(r.json().reason).toBe('SESSION_IDLE');
    });
  });
});
