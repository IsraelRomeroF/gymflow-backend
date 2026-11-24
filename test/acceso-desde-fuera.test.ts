import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { makeApp, PASSWORD } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { loadEnv } from '../src/platform/env.js';
import {
  abiertoAInternet, cookieConDominio, esDireccionProvisional, esHostLocal, problemasDeArranque, type Arranque,
} from '../src/platform/perfiles.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';

/**
 * BLOQUE 3.1 (auditoría 8, fase 3) · D-01, opción (b): ENTRAR DESDE FUERA CON
 * DIRECCIÓN FIJA. GymFlow sigue en la computadora del gimnasio; un túnel con
 * nombre publica el panel y el portal en un dominio propio. Aquí se prueba lo
 * que es de la API: que no arranca con una combinación insegura para ese
 * modo, que el cobro con tarjeta va apagado, que la cookie de sesión se
 * comporta según por dónde se entra, que el límite de intentos es por persona
 * (su IP real detrás del túnel y su equipo conocido) y lo que el panel
 * necesita para sus QR y sus avisos.
 *
 * Los dominios son inventados (`*.example`, reservado para ejemplos).
 */
const PANEL = 'https://panel.gimnasio.example';
const PORTAL = 'https://socios.gimnasio.example';
const LOCALES = 'http://localhost:3003,http://localhost:3002';

const fija = (over: Partial<Arranque> = {}): Arranque => ({
  NODE_ENV: 'development',
  API_PORT: 3001,
  DATABASE_URL: 'postgresql://gymflow_local_app:Una-Clave-Propia-1@127.0.0.1:5432/gymflow_local?schema=public',
  paymentProvider: 'none',
  trustedProxies: ['127.0.0.1', '::1'],
  CORS_ORIGINS: `${LOCALES},${PANEL},${PORTAL}`,
  portalOrigins: ['http://localhost:3002', PORTAL],
  PANEL_PUBLIC_URL: PANEL,
  PORTAL_PUBLIC_URL: PORTAL,
  ...over,
});

describe('D-01 · arranque seguro con dirección fija (las reglas)', () => {
  it('el uso real con su dirección fija completa arranca, con o sin dominio de cookie', () => {
    expect(problemasDeArranque(fija())).toEqual([]);
    expect(problemasDeArranque(fija({ SESSION_COOKIE_DOMAIN: 'gimnasio.example' }))).toEqual([]);
    expect(problemasDeArranque(fija({ SESSION_COOKIE_DOMAIN: '.gimnasio.example' }))).toEqual([]);
    expect(problemasDeArranque(fija({ SESSION_COOKIE_DOMAIN: 'panel.gimnasio.example' }))).toEqual([]);
  });

  it('qué es «abierto a internet»: una dirección pública que no es de esta computadora ni de la red del gimnasio', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '[::1]', '192.168.1.20', '10.0.0.5', '172.20.3.4', 'recepcion.local']) expect(esHostLocal(h), h).toBe(true);
    for (const h of ['panel.gimnasio.example', '8.8.8.8', '172.32.0.1', 'algo.trycloudflare.com']) expect(esHostLocal(h), h).toBe(false);
    expect(abiertoAInternet({ PANEL_PUBLIC_URL: undefined, PORTAL_PUBLIC_URL: 'http://localhost:4002' })).toBe(false);
    expect(abiertoAInternet({ PANEL_PUBLIC_URL: undefined, PORTAL_PUBLIC_URL: 'https://192.168.1.20:3443' })).toBe(false);
    expect(abiertoAInternet({ PANEL_PUBLIC_URL: PANEL, PORTAL_PUBLIC_URL: undefined })).toBe(true);
    expect(abiertoAInternet({ PANEL_PUBLIC_URL: undefined, PORTAL_PUBLIC_URL: 'https://uno-dos.trycloudflare.com' })).toBe(true);
    expect(esDireccionProvisional('https://uno-dos.trycloudflare.com')).toBe(true);
    expect(esDireccionProvisional(PORTAL)).toBe(false);
  });

  it('por internet solo se entra por https', () => {
    const p = problemasDeArranque(fija({ PANEL_PUBLIC_URL: 'http://panel.gimnasio.example', CORS_ORIGINS: `${LOCALES},http://panel.gimnasio.example,${PORTAL}` }));
    expect(p).toEqual([expect.stringMatching(/PANEL_PUBLIC_URL abre el panel a internet por http/)]);
    expect(problemasDeArranque(fija({ PORTAL_PUBLIC_URL: 'socios.gimnasio.example' }))).toEqual([expect.stringMatching(/PORTAL_PUBLIC_URL=«socios\.gimnasio\.example» no es una dirección/)]);
  });

  it('sin proxies de confianza no arranca: todos los teléfonos compartirían un solo cupo de intentos', () => {
    const p = problemasDeArranque(fija({ trustedProxies: [], DATABASE_URL: 'postgresql://gymflow_app:otra-clave-larga@db.interna:5432/gymflow_ensayo' }));
    expect(p).toEqual([expect.stringMatching(/dirección pública.*TRUSTED_PROXIES es obligatoria/)]);
  });

  it('el cobro con tarjeta va apagado: la caja de arena no se publica en internet, en ninguna base', () => {
    const enPruebas = problemasDeArranque(fija({
      API_PORT: 4001, paymentProvider: 'sandbox', DATABASE_URL: 'postgresql://gymflow_app:gymflow_app_dev@127.0.0.1:5432/gymflow_pruebas?schema=public',
    }));
    expect(enPruebas).toEqual([expect.stringMatching(/Con una dirección pública el cobro con tarjeta va apagado \(PAYMENT_PROVIDER=none\).*Paga en recepción/)]);
    // En el uso real ya lo impedía la base; ahora lo dicen las dos reglas.
    expect(problemasDeArranque(fija({ paymentProvider: 'sandbox' }))).toHaveLength(2);
    // Las pruebas en esta computadora siguen con su caja de arena.
    expect(problemasDeArranque(fija({
      API_PORT: 4001, paymentProvider: 'sandbox', DATABASE_URL: 'postgresql://gymflow_app:gymflow_app_dev@127.0.0.1:5432/gymflow_pruebas?schema=public',
      PANEL_PUBLIC_URL: undefined, PORTAL_PUBLIC_URL: 'http://localhost:4002', CORS_ORIGINS: 'http://localhost:4003,http://localhost:4002', portalOrigins: ['http://localhost:4002'],
    }))).toEqual([]);
  });

  it('los orígenes públicos tienen que estar en la lista: si no, la API rechazaría al panel y al portal desde fuera', () => {
    const p = problemasDeArranque(fija({ CORS_ORIGINS: LOCALES, portalOrigins: ['http://localhost:3002'] }));
    expect(p).toEqual([
      expect.stringMatching(/CORS_ORIGINS no incluye https:\/\/panel\.gimnasio\.example \(PANEL_PUBLIC_URL\)/),
      expect.stringMatching(/CORS_ORIGINS no incluye https:\/\/socios\.gimnasio\.example \(PORTAL_PUBLIC_URL\)/),
      expect.stringMatching(/PORTAL_ORIGINS no incluye https:\/\/socios\.gimnasio\.example/),
    ]);
  });

  it('el dominio de la cookie tiene que ser un dominio, y el de las direcciones públicas', () => {
    for (const malo of ['https://gimnasio.example', 'gimnasio.example:3003', 'localhost', '203.0.113.7']) {
      expect(problemasDeArranque(fija({ SESSION_COOKIE_DOMAIN: malo })), malo).toEqual([expect.stringMatching(/SESSION_COOKIE_DOMAIN=«.*» no es un dominio/)]);
    }
    expect(problemasDeArranque(fija({ SESSION_COOKIE_DOMAIN: 'otro-dominio.example' }))).toEqual([
      expect.stringMatching(/SESSION_COOKIE_DOMAIN=«otro-dominio\.example» no corresponde a ninguna dirección pública/),
    ]);
  });

  it('a quién se le pone el dominio en la cookie: solo a quien entró por él', () => {
    expect(cookieConDominio('panel.gimnasio.example', 'gimnasio.example')).toBe(true);
    expect(cookieConDominio('gimnasio.example:443', '.gimnasio.example')).toBe(true);
    expect(cookieConDominio('localhost:3003', 'gimnasio.example')).toBe(false);
    expect(cookieConDominio('192.168.1.20:3003', 'gimnasio.example')).toBe(false);
    expect(cookieConDominio('otrogimnasio.example', 'gimnasio.example')).toBe(false);
    expect(cookieConDominio('panel.gimnasio.example', '')).toBe(false);
    expect(cookieConDominio(undefined, 'gimnasio.example')).toBe(false);
  });

  it('la API de verdad se niega a arrancar, y lo dice todo junto y en español', () => {
    const base = {
      ...process.env, NODE_ENV: 'test', PANEL_PUBLIC_URL: PANEL, PORTAL_PUBLIC_URL: PORTAL,
      CORS_ORIGINS: `${LOCALES},${PANEL},${PORTAL}`, PORTAL_ORIGINS: `http://localhost:3002,${PORTAL}`, TRUSTED_PROXIES: '127.0.0.1,::1',
    };
    // En la base de pruebas, sin decir el procesador, nacería la caja de arena: con dirección pública no arranca.
    const sinApagar = { ...base } as NodeJS.ProcessEnv;
    delete sinApagar.PAYMENT_PROVIDER;
    expect(() => loadEnv(sinApagar)).toThrow(/el cobro con tarjeta va apagado/);
    expect(() => loadEnv({ ...base, PAYMENT_PROVIDER: 'none', TRUSTED_PROXIES: '' })).toThrow(/TRUSTED_PROXIES es obligatoria/);
    const env = loadEnv({ ...base, PAYMENT_PROVIDER: 'none' });
    expect(env).toMatchObject({ abiertoAInternet: true, panelPublicUrl: PANEL, portalPublicUrl: PORTAL, paymentProvider: 'none' });
    const local = { ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    delete local.PANEL_PUBLIC_URL; delete local.PORTAL_PUBLIC_URL;
    expect(loadEnv(local)).toMatchObject({ abiertoAInternet: false, panelPublicUrl: null });
  });
});

describe('D-01 · la API con dirección fija', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  const db = () => getDb();
  /** Como llega una petición por el túnel: Cloudflare pone la IP real al final y el https; el panel, la dirección que se escribió. */
  const porElTunel = (ip: string, host = 'panel.gimnasio.example') => ({ 'x-forwarded-for': ip, 'x-forwarded-proto': 'https', 'x-forwarded-host': host });
  const entrar = (email: string, password: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/auth/login', payload: { email, password }, headers });
  const cookieDe = (r: Awaited<ReturnType<typeof entrar>>, nombre: string) => r.cookies.find((c) => c.name === nombre);
  const ip = () => `203.0.113.${1 + Math.floor(Math.random() * 250)}`;

  beforeAll(async () => {
    const previo = { panel: process.env.PANEL_PUBLIC_URL, portal: process.env.PORTAL_PUBLIC_URL };
    // `/public/config` lee las direcciones del entorno del proceso, como en el arranque de verdad.
    process.env.PANEL_PUBLIC_URL = PANEL; process.env.PORTAL_PUBLIC_URL = PORTAL;
    app = await makeApp({
      PANEL_PUBLIC_URL: PANEL, PORTAL_PUBLIC_URL: PORTAL, PAYMENT_PROVIDER: 'none', TRUSTED_PROXIES: '127.0.0.1,::1',
      CORS_ORIGINS: `${LOCALES},${PANEL},${PORTAL}`, PORTAL_ORIGINS: `http://localhost:3002,${PORTAL}`,
      SESSION_COOKIE_DOMAIN: 'gimnasio.example', AUTH_ATTEMPTS_PER_IP: '3', AUTH_ATTEMPTS_PER_NETWORK: '1000',
    });
    await app.ready();
    g = await gimnasioPropio();
    restaurar = () => {
      if (previo.panel === undefined) delete process.env.PANEL_PUBLIC_URL; else process.env.PANEL_PUBLIC_URL = previo.panel;
      if (previo.portal === undefined) delete process.env.PORTAL_PUBLIC_URL; else process.env.PORTAL_PUBLIC_URL = previo.portal;
    };
  });
  let restaurar = () => undefined as void;
  afterAll(async () => { restaurar(); await g.cerrar(); await app.close(); await closeDb(); });

  it('el panel sabe su dirección fija y la del portal: con ella arma los QR, que ya no cambian con cada arranque', async () => {
    const r = await app.inject({ method: 'GET', url: '/public/config' });
    expect(r.json()).toEqual({ portalUrl: PORTAL, panelUrl: PANEL, address: 'fixed' });
  });

  it('por el túnel la cookie va con Secure y con el dominio; en la computadora del gimnasio, sin ninguno de los dos', async () => {
    const fuera = await entrar(g.correos.owner, PASSWORD, porElTunel(ip()));
    expect(fuera.statusCode, fuera.body).toBe(200);
    expect(cookieDe(fuera, 'gf_session')).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax', domain: 'gimnasio.example', path: '/' });
    // El mostrador entra por localhost aunque no haya internet: su cookie no lleva dominio (el navegador la tiraría) ni Secure.
    const dentro = await entrar(g.correos.gerente, PASSWORD, { host: 'localhost:3003' });
    expect(dentro.statusCode, dentro.body).toBe(200);
    const local = cookieDe(dentro, 'gf_session')!;
    expect(local.domain).toBeUndefined();
    expect(local.secure).toBeFalsy();
    // Quien sale por donde entró borra la misma cookie: mismo dominio y misma ruta.
    const cookie = `gf_session=${cookieDe(fuera, 'gf_session')!.value}`;
    const salir = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, ...porElTunel(ip()) }, payload: {} });
    expect(salir.statusCode, salir.body).toBe(200);
    expect(cookieDe(salir as never, 'gf_session')).toMatchObject({ value: '', domain: 'gimnasio.example', path: '/' });
  });

  it('el límite de intentos es por persona: cada quien cuenta con su IP real, y falsificar la cabecera no da cupo nuevo', async () => {
    const correo = `nadie.${randomUUID().slice(0, 8)}@ejemplo.mx`;
    const intrusa = ip();
    for (let i = 0; i < 3; i++) expect((await entrar(correo, 'x', porElTunel(intrusa))).statusCode).toBe(401);
    const cuarta = await entrar(correo, 'x', porElTunel(intrusa));
    expect(cuarta.statusCode).toBe(429);
    expect(cuarta.json()).toMatchObject({ error: 'RATE_LIMITED' });
    expect(cuarta.json().message).toMatch(/Demasiados intentos para entrar con este correo/);
    // Anteponer IPs inventadas no cambia quién es: la real la pone Cloudflare al final.
    expect((await entrar(correo, 'x', porElTunel(`198.51.100.9, 10.1.1.1, ${intrusa}`))).statusCode).toBe(429);
    // Otra persona desde esa misma red (el Wi-Fi del gimnasio, un operador de celular) tiene su propio cupo…
    expect((await entrar(g.correos.recepcion, PASSWORD, porElTunel(intrusa))).statusCode).toBe(200);
    // …y la misma cuenta desde otro lugar no hereda el castigo de la intrusa.
    expect((await entrar(correo, 'x', porElTunel(ip()))).statusCode).toBe(401);
  });

  it('equipo conocido: con la cuenta bloqueada por fallos ajenos, la dueña entra desde su teléfono aunque su IP haya cambiado', async () => {
    const correo = g.correos.owner;
    // Entra una vez desde su teléfono: el navegador se queda con su llave de equipo.
    const primera = await entrar(correo, PASSWORD, porElTunel('203.0.113.201'));
    const equipo = cookieDe(primera, 'gf_equipo')!;
    expect(equipo).toMatchObject({ httpOnly: true, secure: true, domain: 'gimnasio.example' });
    expect(equipo.maxAge).toBeGreaterThan(170 * 86_400);
    const equipos = await db().knownDevice.count({ where: { userId: g.ownerId } });
    expect(equipos).toBeGreaterThanOrEqual(1);
    // En la base no queda la llave, solo su huella.
    expect(await db().knownDevice.count({ where: { userId: g.ownerId, keyHash: equipo.value } })).toBe(0);

    // Alguien teclea mal su contraseña hasta bloquearle la cuenta.
    await db().user.update({ where: { id: g.ownerId }, data: { failedLogins: 9, lockedUntil: new Date(Date.now() + 30 * 60_000) } });
    // Desde un equipo cualquiera, ni con la contraseña correcta (el bloqueo frena al que adivina)…
    expect((await entrar(correo, PASSWORD, porElTunel('198.51.100.77'))).statusCode).toBe(401);
    // …con la llave de equipo y la contraseña MAL, tampoco: la llave sola no abre nada.
    expect((await entrar(correo, 'no-es-la-contraseña', { ...porElTunel('198.51.100.78'), cookie: `gf_equipo=${equipo.value}` })).statusCode).toBe(401);
    await db().user.update({ where: { id: g.ownerId }, data: { lockedUntil: new Date(Date.now() + 30 * 60_000) } });
    // …y la titular, desde su teléfono con otra IP (datos móviles), entra.
    const titular = await entrar(correo, PASSWORD, { ...porElTunel('198.51.100.79'), cookie: `gf_equipo=${equipo.value}` });
    expect(titular.statusCode, titular.body).toBe(200);
    // El equipo conserva su llave: no se multiplica en cada ingreso.
    expect(cookieDe(titular, 'gf_equipo')!.value).toBe(equipo.value);
    expect(await db().knownDevice.count({ where: { userId: g.ownerId } })).toBe(equipos);
    expect((await db().user.findUniqueOrThrow({ where: { id: g.ownerId } })).lockedUntil).toBeNull();
  });

  it('una llave de equipo de otra cuenta no sirve para esta', async () => {
    const deRecepcion = cookieDe(await entrar(g.correos.recepcion, PASSWORD, porElTunel(ip())), 'gf_equipo')!.value;
    const gerente = await db().user.findFirstOrThrow({ where: { organizationId: g.organizationId, email: g.correos.gerente2 }, select: { id: true } });
    await db().user.update({ where: { id: gerente.id }, data: { failedLogins: 9, lockedUntil: new Date(Date.now() + 30 * 60_000) } });
    expect((await entrar(g.correos.gerente2, PASSWORD, { ...porElTunel('198.51.100.90'), cookie: `gf_equipo=${deRecepcion}` })).statusCode).toBe(401);
    await db().user.update({ where: { id: gerente.id }, data: { failedLogins: 0, lockedUntil: null } });
  });

  it('«Probar» los avisos responde a cuántos equipos salió: sin llaves en el servidor, a ninguno', async () => {
    const entro = await entrar(g.correos.gerente, PASSWORD, porElTunel(ip()));
    const cookie = `gf_session=${cookieDe(entro, 'gf_session')!.value}`;
    const r = await app.inject({ method: 'POST', url: '/me/push/test', headers: { cookie }, payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ sent: 0 });
    expect((await app.inject({ method: 'POST', url: '/me/push/test', payload: {} })).statusCode).toBe(401);
  });
});
