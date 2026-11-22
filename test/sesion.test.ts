import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { hash } from '@node-rs/argon2';
import { makeApp, loginAs, loginPlataforma, orgFixtures, PASSWORD, correoUnico, nombreUnico, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { hashToken } from '../src/platform/crypto.js';
import { equipoDe } from '../src/modules/identity/equipo.js';
import { SESSION_END_REASONS, TEXTO_DE_FIN_DE_SESION } from '@gymflow/core';
import { textoDeFin } from '../src/modules/identity/fin-de-sesion.js';

/**
 * SESIÓN (fase 1, bloque 1.12 · 24-04 a 24-08, 24-13 a 24-15).
 *
 * El 401 de una sesión que terminó dice por qué (`reason`), la sesión dura
 * lo que dura su cookie y ni un minuto más, «Mis sesiones» muestra solo las
 * vivas con su equipo, cerrar sesión apaga los avisos de ese equipo y la
 * cookie va con `Secure` cuando la petición llega por https.
 */
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const UA_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const HORA = 3_600_000;

describe('sesión: motivo, tope, «Mis sesiones», avisos y cookie', () => {
  let app: FastifyInstance;
  let demoId: string;
  const creados: string[] = [];
  const db = () => getDb();

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    demoId = (await orgFixtures()).demo.id;
  });
  afterAll(async () => {
    for (const id of creados) {
      await db().pushSubscription.deleteMany({ where: { userId: id } });
      await db().session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'fin_de_prueba' } });
      await db().roleAssignment.deleteMany({ where: { userId: id } });
      await db().user.update({ where: { id }, data: { isActive: false, deletedAt: new Date(), email: `${id}@borrado.local` } });
    }
    await app.close();
    await closeDb();
  });

  /** Una persona desechable del gimnasio de pruebas (o de la plataforma, sin gimnasio). */
  async function persona(rol: 'RECEPTION' | 'MANAGER' | null, extra: { mustChangePassword?: boolean } = {}): Promise<{ id: string; email: string }> {
    const email = rol ? correoUnico(`sesion-${rol.toLowerCase()}`) : `plataforma.${nombreUnico('s').toLowerCase()}@gymflow.mx`;
    const id = uuidv7();
    await db().user.create({
      data: {
        id, organizationId: rol ? demoId : null, email, fullName: 'Prueba de Sesión',
        mustChangePassword: extra.mustChangePassword ?? false, ...(extra.mustChangePassword ? { passwordResetAt: new Date() } : {}),
        passwordHash: await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      },
    });
    creados.push(id);
    if (rol) {
      const role = await db().role.findFirstOrThrow({ where: { organizationId: null, key: rol } });
      await db().roleAssignment.create({ data: { id: uuidv7(), organizationId: demoId, userId: id, roleId: role.id, branchId: null } });
    }
    return { id, email };
  }

  const galleta = (r: LightMyRequestResponse) => `gf_session=${r.cookies.find((c) => c.name === 'gf_session')!.value}`;
  const tokenDe = (cookie: string) => cookie.split('=')[1]!;
  async function entrar(email: string, opts: { ua?: string; ip?: string; cookie?: string; en?: FastifyInstance } = {}): Promise<string> {
    const r = await (opts.en ?? app).inject({
      method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD },
      headers: { ...(opts.ua ? { 'user-agent': opts.ua } : {}), ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      ...(opts.ip ? { remoteAddress: opts.ip } : {}),
    });
    expect(r.statusCode, r.body).toBe(200);
    return galleta(r);
  }
  const yo = (cookie?: string, url = '/auth/me', en = app) => en.inject({ method: 'GET', url, ...(cookie ? { headers: { cookie } } : {}) });
  const fila = (cookie: string) => db().session.findUniqueOrThrow({ where: { tokenHash: hashToken(tokenDe(cookie)) } });
  async function suscribir(userId: string, endpoint: string) {
    await db().pushSubscription.create({ data: { id: uuidv7(), organizationId: demoId, userId, endpoint, p256dh: 'p256dh-de-prueba-0123456789', auth: 'auth-de-prueba' } });
  }
  const endpoints = async (userId: string) => (await db().pushSubscription.findMany({ where: { userId }, select: { endpoint: true } })).map((s) => s.endpoint).sort();

  it('la lista de motivos es estable (el panel y la consola dependen de ella)', () => {
    // La lista vive en el núcleo (bloque 1.2): la API y el panel leen la misma.
    expect(SESSION_END_REASONS).toEqual([
      'NO_SESSION', 'SESSION_EXPIRED', 'SESSION_IDLE', 'SESSION_LOGGED_OUT', 'SESSION_CLOSED_ELSEWHERE',
      'SESSION_CLOSED_EVERYWHERE', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'ACCOUNT_DEACTIVATED', 'ACCESS_CHANGED',
      'ACCOUNT_LOCKED', 'TEMPORARY_PASSWORD', 'TEMPORARY_PASSWORD_EXPIRED', 'SERVICE_SUSPENDED', 'SERVICE_PENDING',
      'NETWORK_NOT_ALLOWED', 'SESSION_REVOKED', 'PLATFORM_ACCOUNT',
    ]);
    // Y la API dice el texto del núcleo, sin copia propia.
    for (const r of SESSION_END_REASONS) expect(textoDeFin(r)).toBe(TEXTO_DE_FIN_DE_SESION[r]);
  });

  it('sin cookie, o con una que no existe, el 401 dice NO_SESSION', async () => {
    const sin = await yo();
    expect(sin.statusCode).toBe(401);
    expect(sin.json()).toMatchObject({ error: 'UNAUTHENTICATED', reason: 'NO_SESSION' });
    const inventada = await yo('gf_session=no-existe-esta-cookie');
    expect(inventada.json().reason).toBe('NO_SESSION');
  });

  it('salir: esa cookie ya no sirve y lo dice (SESSION_LOGGED_OUT)', async () => {
    const { email } = await persona('RECEPTION');
    const cookie = await entrar(email);
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })).statusCode).toBe(200);
    const despues = await yo(cookie);
    expect(despues.statusCode).toBe(401);
    expect(despues.json().reason).toBe('SESSION_LOGGED_OUT');
    expect(despues.json().message).toMatch(/se cerró/);
  });

  it('«Cerrar las demás»: esta sigue, la otra dice SESSION_CLOSED_ELSEWHERE y sus avisos se apagan (los de aquí no)', async () => {
    const { id, email } = await persona('MANAGER');
    const pc = await entrar(email, { ua: UA_WINDOWS });
    const telefono = await entrar(email, { ua: UA_IPHONE });
    await suscribir(id, 'https://push.ejemplo.mx/pc');
    await suscribir(id, 'https://push.ejemplo.mx/telefono');

    const r = await app.inject({ method: 'POST', url: '/auth/logout-others', headers: { cookie: pc }, payload: { endpoint: 'https://push.ejemplo.mx/pc' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ closed: 1, notificationsOff: 1 });
    expect((await yo(pc)).statusCode).toBe(200);
    const fuera = await yo(telefono);
    expect(fuera.statusCode).toBe(401);
    expect(fuera.json().reason).toBe('SESSION_CLOSED_ELSEWHERE');
    expect(await endpoints(id)).toEqual(['https://push.ejemplo.mx/pc']);
  });

  it('salir en este equipo apaga SUS avisos (24-15); los de otra persona no se tocan', async () => {
    const yoMismo = await persona('MANAGER');
    const otra = await persona('MANAGER');
    const cookie = await entrar(yoMismo.email);
    await suscribir(yoMismo.id, 'https://push.ejemplo.mx/tableta');
    await suscribir(yoMismo.id, 'https://push.ejemplo.mx/su-telefono');
    await suscribir(otra.id, 'https://push.ejemplo.mx/de-otra');
    // Aunque mande el de otra persona, solo se borra lo suyo.
    const ajeno = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: await entrar(yoMismo.email) }, payload: { endpoint: 'https://push.ejemplo.mx/de-otra' } });
    expect(ajeno.json().notificationsOff).toBe(0);
    const r = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie }, payload: { endpoint: 'https://push.ejemplo.mx/tableta' } });
    expect(r.json()).toEqual({ status: 'LOGGED_OUT', notificationsOff: 1 });
    expect(await endpoints(yoMismo.id)).toEqual(['https://push.ejemplo.mx/su-telefono']);
    expect(await endpoints(otra.id)).toEqual(['https://push.ejemplo.mx/de-otra']);
    // Sin cuerpo sigue funcionando (así salen la consola y los guiones).
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: await entrar(yoMismo.email) } })).statusCode).toBe(200);
  });

  it('cerrar en todos lados: SESSION_CLOSED_EVERYWHERE y ningún equipo sigue con avisos', async () => {
    const { id, email } = await persona('MANAGER');
    const a = await entrar(email);
    const b = await entrar(email);
    await suscribir(id, 'https://push.ejemplo.mx/uno');
    const r = await app.inject({ method: 'POST', url: '/auth/logout-all', headers: { cookie: a } });
    expect(r.json()).toMatchObject({ status: 'LOGGED_OUT', revoked: 2, notificationsOff: 1 });
    expect((await yo(b)).json().reason).toBe('SESSION_CLOSED_EVERYWHERE');
    expect(await endpoints(id)).toEqual([]);
  });

  it('cambiar la contraseña cierra las demás con PASSWORD_CHANGED', async () => {
    const { email } = await persona('RECEPTION');
    const aqui = await entrar(email);
    const alla = await entrar(email);
    const cambio = await app.inject({ method: 'POST', url: '/auth/password', headers: { cookie: aqui }, payload: { current: PASSWORD, next: 'Otra-Clave-Larga-2026' } });
    expect(cambio.statusCode, cambio.body).toBe(200);
    expect((await yo(aqui)).statusCode).toBe(200);
    expect((await yo(alla)).json().reason).toBe('PASSWORD_CHANGED');
  });

  it('lo que cierran otros también se dice: temporal nueva, baja, puesto, bloqueo, temporal vencida y lo desconocido', async () => {
    const casos: Array<[string, string]> = [
      ['password_reset', 'PASSWORD_RESET'], ['deactivated', 'ACCOUNT_DEACTIVATED'], ['staff_deactivated', 'ACCOUNT_DEACTIVATED'],
      ['platform_suspend', 'ACCOUNT_DEACTIVATED'], ['role_changed', 'ACCESS_CHANGED'], ['permissions_changed', 'ACCESS_CHANGED'],
      ['sections_changed', 'ACCESS_CHANGED'], ['locked', 'ACCOUNT_LOCKED'], ['temporal_vencida', 'TEMPORARY_PASSWORD_EXPIRED'],
      ['idle', 'SESSION_IDLE'], ['algo_que_no_existe', 'SESSION_REVOKED'],
    ];
    const { email } = await persona('RECEPTION');
    for (const [causa, motivo] of casos) {
      const cookie = await entrar(email);
      await db().session.update({ where: { tokenHash: hashToken(tokenDe(cookie)) }, data: { revokedAt: new Date(), revokedReason: causa } });
      const r = await yo(cookie);
      expect(r.statusCode, causa).toBe(401);
      expect(r.json().reason, causa).toBe(motivo);
    }
    // La temporal vencida dice cuánto dura.
    const vencida = await entrar(email);
    await db().session.update({ where: { tokenHash: hashToken(tokenDe(vencida)) }, data: { revokedAt: new Date(), revokedReason: 'temporal_vencida' } });
    expect((await yo(vencida)).json().message).toMatch(/dura 7 días/);
  });

  it('dada de baja sin que se cerraran sus sesiones: ACCOUNT_DEACTIVATED', async () => {
    const { id, email } = await persona('RECEPTION');
    const cookie = await entrar(email);
    await db().user.update({ where: { id }, data: { isActive: false } });
    const r = await yo(cookie);
    expect(r.statusCode).toBe(401);
    expect(r.json().reason).toBe('ACCOUNT_DEACTIVATED');
  });

  it('con la temporal, fuera de sus cuatro rutas: TEMPORARY_PASSWORD', async () => {
    const { email } = await persona('RECEPTION', { mustChangePassword: true });
    const cookie = await entrar(email);
    expect((await yo(cookie)).statusCode).toBe(200);
    const fuera = await yo(cookie, '/organization');
    expect(fuera.statusCode).toBe(401);
    expect(fuera.json().reason).toBe('TEMPORARY_PASSWORD');
  });

  it('el tope: dura lo que su cookie (12 h desde que entra), usarla no lo corre y /auth/me dice a qué hora se cierra', async () => {
    const { email } = await persona('RECEPTION');
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
    const cookie = galleta(r);
    const s = await fila(cookie);
    expect(s.expiresAt.getTime() - s.createdAt.getTime()).toBeCloseTo(12 * HORA, -4);
    // La cookie vence lo mismo que la sesión.
    const expira = r.cookies.find((c) => c.name === 'gf_session')!.expires as Date;
    expect(Math.abs(new Date(expira).getTime() - s.expiresAt.getTime())).toBeLessThan(1500);
    const me = (await yo(cookie)).json();
    expect(new Date(me.session.startedAt).getTime()).toBe(s.createdAt.getTime());
    expect(new Date(me.session.endsAt).getTime()).toBe(s.expiresAt.getTime());

    // Usarla anota el último uso, pero no corre el vencimiento.
    await db().session.update({ where: { id: s.id }, data: { lastSeenAt: new Date(Date.now() - 5 * 60_000) } });
    expect((await yo(cookie)).statusCode).toBe(200);
    const tras = await fila(cookie);
    expect(tras.expiresAt.getTime()).toBe(s.expiresAt.getTime());
    expect(tras.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('una sesión de antes, con el vencimiento corrido más allá de su tope, ya no sirve: SESSION_EXPIRED', async () => {
    const { email } = await persona('RECEPTION');
    const vieja = await entrar(email);
    await db().session.update({ where: { tokenHash: hashToken(tokenDe(vieja)) }, data: { createdAt: new Date(Date.now() - 13 * HORA), expiresAt: new Date(Date.now() + 5 * HORA) } });
    const r = await yo(vieja);
    expect(r.statusCode).toBe(401);
    expect(r.json().reason).toBe('SESSION_EXPIRED');
    const vencida = await entrar(email);
    await db().session.update({ where: { tokenHash: hashToken(tokenDe(vencida)) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await yo(vencida)).json().reason).toBe('SESSION_EXPIRED');
  });

  it('«Mis sesiones»: solo las vivas, con su equipo, a qué hora se cierran y cuál es esta', async () => {
    const { email } = await persona('MANAGER');
    const pc = await entrar(email, { ua: UA_WINDOWS });
    const telefono = await entrar(email, { ua: UA_IPHONE });
    const cerrada = await entrar(email, { ua: UA_IPHONE });
    await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: cerrada } });
    const vencida = await entrar(email, { ua: UA_IPHONE });
    await db().session.update({ where: { tokenHash: hashToken(tokenDe(vencida)) }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const r = await yo(pc, '/auth/sessions');
    expect(r.statusCode, r.body).toBe(200);
    const lista = r.json() as Array<{ id: string; current: boolean; device: string | null; endsAt: string; lastSeenAt: string }>;
    const [idPc, idTel] = [(await fila(pc)).id, (await fila(telefono)).id];
    expect(lista.map((x) => x.id).sort()).toEqual([idPc, idTel].sort());
    expect(lista.find((x) => x.id === idPc)).toMatchObject({ current: true, device: 'Windows · Chrome' });
    expect(lista.find((x) => x.id === idTel)).toMatchObject({ current: false, device: 'iPhone · Safari' });
    expect(new Date(lista[0]!.endsAt).getTime()).toBeGreaterThan(Date.now() + 11 * HORA);
    // El equipo también queda escrito en la sesión.
    expect((await fila(telefono)).deviceLabel).toBe('iPhone · Safari');
  });

  it('entrar otra vez en el mismo navegador cierra la sesión que traía (no queda viva sin dueño)', async () => {
    const { email } = await persona('RECEPTION');
    const antes = await entrar(email, { ua: UA_WINDOWS });
    const nueva = await entrar(email, { ua: UA_WINDOWS, cookie: antes });
    expect((await fila(antes)).revokedReason).toBe('replaced');
    expect((await yo(nueva, '/auth/sessions')).json()).toHaveLength(1);
  });

  describe('plataforma', () => {
    it('sin uso, SESSION_IDLE; en el panel de un gimnasio, PLATFORM_ACCOUNT', async () => {
      const cookie = await loginPlataforma(app);
      const enPanel = await yo(cookie);
      expect(enPanel.statusCode).toBe(401);
      expect(enPanel.json().reason).toBe('PLATFORM_ACCOUNT');
      await db().session.update({ where: { tokenHash: hashToken(tokenDe(cookie)) }, data: { lastSeenAt: new Date(Date.now() - 31 * 60_000) } });
      const r = await yo(cookie, '/platform/me');
      expect(r.statusCode).toBe(401);
      expect(r.json().reason).toBe('SESSION_IDLE');
    });

    it('dura 8 h desde que entra y Seguridad solo lista las vivas, con su equipo', async () => {
      const { email } = await persona(null);
      const aqui = await entrar(email, { ua: UA_WINDOWS });
      const dormida = await entrar(email, { ua: UA_IPHONE });
      const s = await fila(aqui);
      expect(s.expiresAt.getTime() - s.createdAt.getTime()).toBeCloseTo(8 * HORA, -4);
      await db().session.update({ where: { tokenHash: hashToken(tokenDe(dormida)) }, data: { lastSeenAt: new Date(Date.now() - 31 * 60_000) } });
      const seg = (await yo(aqui, '/platform/security')).json();
      expect(seg.sessions).toHaveLength(1);
      expect(seg.sessions[0]).toMatchObject({ current: true, deviceLabel: 'Windows · Chrome' });
      expect(new Date(seg.sessions[0].endsAt).getTime()).toBe(s.expiresAt.getTime());
    });

    it('desde una red no permitida el login no abre sesión (24-13) y una sesión de otra red tampoco sirve', async () => {
      const restringida = await makeApp({ PLATFORM_ALLOWED_IPS: '10.9.9.9' });
      await restringida.ready();
      try {
        const { id, email } = await persona(null);
        const r = await restringida.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
        expect(r.statusCode).toBe(403);
        expect(r.json()).toMatchObject({ reason: 'NETWORK_NOT_ALLOWED' });
        expect(r.json().message).toMatch(/red no puede entrar/);
        expect(r.cookies.find((c) => c.name === 'gf_session')).toBeUndefined();
        expect(await db().session.count({ where: { userId: id } })).toBe(0);
        // No cuenta como intento fallido: la contraseña era la buena.
        expect((await db().user.findUniqueOrThrow({ where: { id } })).failedLogins).toBe(0);
        // Desde la red permitida, sí.
        await entrar(email, { en: restringida, ip: '10.9.9.9' });
        // Y la sesión abierta desde otra red no le sirve.
        const deFuera = await entrar(email);
        const fuera = await yo(deFuera, '/platform/me', restringida);
        expect(fuera.statusCode).toBe(401);
        expect(fuera.json().reason).toBe('NETWORK_NOT_ALLOWED');
      } finally {
        await restringida.close();
      }
    });

    it('reconfirmar mal hasta bloquear la cuenta cierra la sesión con ACCOUNT_LOCKED', async () => {
      const { email } = await persona(null);
      const cookie = await entrar(email);
      let ultima: LightMyRequestResponse | null = null;
      for (let i = 0; i < 5; i++) ultima = await app.inject({ method: 'POST', url: '/platform/reauth', headers: { cookie }, payload: { password: 'no-es-la-buena' } });
      expect(ultima!.statusCode).toBe(401);
      expect(ultima!.json().reason).toBe('ACCOUNT_LOCKED');
      expect((await yo(cookie, '/platform/me')).json().reason).toBe('ACCOUNT_LOCKED');
    });
  });

  it('sin liberar y suspendido: el login y la sesión dicen SERVICE_PENDING y SERVICE_SUSPENDED (24-07)', async () => {
    const plataforma = await loginPlataforma(app);
    const sufijo = nombreUnico('');
    const alta = await app.inject({
      method: 'POST', url: '/platform/organizations', headers: { cookie: plataforma },
      payload: {
        legalName: `Sesion ${sufijo} S.A. de C.V.`, tradeName: `Sesion ${sufijo}`, template: 'barrio',
        branch: { code: 'SES', name: 'Matriz', addressLine: 'Calle de Prueba 1' },
        owner: { fullName: 'Dueña de Prueba de Sesion', email: correoUnico('sesion-duena') },
        reason: 'Prueba de motivos de sesión',
      },
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const { organizationId, credentials } = alta.json();
    const duena = credentials[0] as { email: string; password: string };
    const antes = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: duena.email, password: duena.password } });
    expect(antes.statusCode).toBe(403);
    expect(antes.json().reason).toBe('SERVICE_PENDING');

    const servicio = (status: 'ACTIVE' | 'SUSPENDED') => app.inject({ method: 'POST', url: `/platform/organizations/${organizationId}/service`, headers: { cookie: plataforma }, payload: { status, reason: 'Prueba de motivos de sesión' } });
    expect((await servicio('ACTIVE')).statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: duena.email, password: duena.password } });
    const cookie = galleta(login);
    expect((await app.inject({ method: 'POST', url: '/auth/password', headers: { cookie }, payload: { next: 'Clave-De-La-Duena-2026' } })).statusCode).toBe(200);
    expect((await yo(cookie)).statusCode).toBe(200);
    await servicio('SUSPENDED');
    const suspendida = await yo(cookie);
    expect(suspendida.statusCode).toBe(401);
    expect(suspendida.json()).toMatchObject({ reason: 'SERVICE_SUSPENDED' });
    expect(suspendida.json().message).toMatch(/suspendido/);
    const otraVez = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: duena.email, password: 'Clave-De-La-Duena-2026' } });
    expect(otraVez.json().reason).toBe('SERVICE_SUSPENDED');
    await servicio('ACTIVE');
    expect((await yo(cookie)).statusCode).toBe(200);
  });

  it('cookie `Secure` cuando la petición llega por https detrás de un proxy de confianza (personal y socio)', async () => {
    const tras = await makeApp({ TRUSTED_PROXIES: '127.0.0.1' });
    const directa = await makeApp({ TRUSTED_PROXIES: '' });
    await tras.ready();
    await directa.ready();
    try {
      const { email } = await persona('MANAGER');
      const login = (en: FastifyInstance, https: boolean) => en.inject({
        method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD },
        headers: https ? { 'x-forwarded-proto': 'https' } : {},
      });
      const segura = (await login(tras, true)).cookies.find((c) => c.name === 'gf_session')!;
      expect(segura.secure).toBe(true);
      expect(segura.httpOnly).toBe(true);
      expect((await login(tras, false)).cookies.find((c) => c.name === 'gf_session')!.secure).toBeFalsy();
      // Sin proxy de confianza, la cabecera no se cree: cualquiera podía mandarla.
      expect((await login(directa, true)).cookies.find((c) => c.name === 'gf_session')!.secure).toBeFalsy();

      // Salir borra la cookie con los mismos atributos.
      const cookie = `gf_session=${segura.value}`;
      const salida = await tras.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, 'x-forwarded-proto': 'https' } });
      const borrada = salida.cookies.find((c) => c.name === 'gf_session')!;
      expect(borrada.value).toBe('');
      expect(borrada.secure).toBe(true);

      // El portal del socio, igual.
      const gerencia = await loginAs(tras, 'gerencia@demo.mx');
      const sede = (await orgFixtures()).demoBranches[0]!.id;
      const socio = await tras.inject({ method: 'POST', url: '/members', headers: { cookie: gerencia }, payload: { firstName: nombreUnico('Cookie'), lastName: nombreUnico('Segura'), homeBranchId: sede, consents: CONSENTIMIENTOS, force: true } });
      expect(socio.statusCode, socio.body).toBeLessThan(300);
      const invitacion = await tras.inject({ method: 'POST', url: `/members/${socio.json().id}/portal-invite`, headers: { cookie: gerencia } });
      const enroll = await tras.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invitacion.json().code }, headers: { 'x-forwarded-proto': 'https' } });
      expect(enroll.statusCode, enroll.body).toBe(201);
      expect(enroll.cookies.find((c) => c.name === 'gf_portal')!.secure).toBe(true);
    } finally {
      await tras.close();
      await directa.close();
    }
  });
});

describe('el equipo de una sesión, en palabras de quien la abrió', () => {
  it.each([
    [UA_IPHONE, 'iPhone · Safari'],
    [UA_WINDOWS, 'Windows · Chrome'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'Windows · Edge'],
    ['Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 'Teléfono Android · Chrome'],
    ['Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Safari/537.36', 'Tableta Android · Samsung Internet'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Mac · Safari'],
    ['Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Linux · Firefox'],
    ['Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1', 'iPad · Chrome'],
  ])('%s', (ua, equipo) => {
    expect(equipoDe(ua)).toBe(equipo);
  });

  it('sin navegador conocido no inventa', () => {
    expect(equipoDe(undefined)).toBeNull();
    expect(equipoDe('')).toBeNull();
    expect(equipoDe('curl/8.5.0')).toBeNull();
  });
});
