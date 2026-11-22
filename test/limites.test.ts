import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { makeApp, orgFixtures, nombreUnico, telefonoUnico, PASSWORD } from './helpers.js';
import { closeDb } from '../src/platform/db/client.js';
import { Cupos, tiempoParaReintentar } from '../src/platform/http/rate-limit.js';

/**
 * LÍMITES POR PERSONA, NO POR GIMNASIO (24-01, 24-02, 28-01, 28-02, 9-05).
 *
 * Detrás del proxy del panel todo el gimnasio llegaba como 127.0.0.1: un solo
 * cupo de 30 inicios de sesión para todos, cinco altas por QR cada diez
 * minutos para todo el gimnasio, y el aviso en inglés como `BAD_REQUEST`.
 */
const PROXIES = '127.0.0.1,::1';
const correoNuevo = () => `nadie.${randomUUID().slice(0, 8)}@ejemplo.mx`;

describe('cuenta regresiva y cupos', () => {
  it('lo que falta se dice en español y redondeado hacia arriba', () => {
    expect(tiempoParaReintentar(1)).toBe('1 segundo');
    expect(tiempoParaReintentar(44.2)).toBe('45 segundos');
    expect(tiempoParaReintentar(60)).toBe('1 minuto');
    expect(tiempoParaReintentar(61)).toBe('2 minutos');
    expect(tiempoParaReintentar(3600)).toBe('1 hora');
    expect(tiempoParaReintentar(3601)).toBe('61 minutos');
    expect(tiempoParaReintentar(5401)).toBe('2 horas');
  });

  it('el intento max + 1 de la ventana se rechaza, y al pasar la ventana vuelve el cupo', () => {
    let ahora = 1_000_000;
    const cupos = new Cupos(2, 60_000, () => ahora);
    cupos.consumir('a', (t) => t);
    cupos.consumir('a', (t) => t);
    expect(() => cupos.consumir('a', (t) => `espera ${t}`)).toThrow('espera 1 minuto');
    expect(cupos.espera('b')).toBe(0);
    ahora += 30_000;
    expect(cupos.espera('a')).toBe(30);
    ahora += 30_000;
    expect(cupos.espera('a')).toBe(0);
    expect(() => cupos.consumir('a', (t) => t)).not.toThrow();
  });
});

describe('entrar: por correo e IP real', () => {
  let app: FastifyInstance;
  let sinProxies: FastifyInstance;

  beforeAll(async () => {
    app = await makeApp({ TRUSTED_PROXIES: PROXIES, AUTH_ATTEMPTS_PER_IP: '3', AUTH_ATTEMPTS_PER_NETWORK: '6' });
    sinProxies = await makeApp({ TRUSTED_PROXIES: '', AUTH_ATTEMPTS_PER_IP: '3', AUTH_ATTEMPTS_PER_NETWORK: '1000' });
    await app.ready();
    await sinProxies.ready();
  });
  afterAll(async () => { await app.close(); await sinProxies.close(); await closeDb(); });

  // Correos que no existen: el límite cuenta cualquier intento, y así no se
  // bloquea ninguna cuenta de las que usan las demás pruebas.
  const entrar = (a: FastifyInstance, email: string, ip?: string, password = 'no-es-la-clave', socket?: string) => a.inject({
    method: 'POST', url: '/auth/login', payload: { email, password },
    ...(ip ? { headers: { 'x-forwarded-for': ip } } : {}),
    ...(socket ? { remoteAddress: socket } : {}),
  });

  it('el cuarto intento del mismo correo desde la misma IP es un 429 en español, con cuenta regresiva', async () => {
    const correo = correoNuevo();
    for (let i = 0; i < 3; i++) expect((await entrar(app, correo, '203.0.113.10')).statusCode).toBe(401);
    const r = await entrar(app, correo, '203.0.113.10');
    expect(r.statusCode).toBe(429);
    const cuerpo = r.json();
    expect(cuerpo.error).toBe('RATE_LIMITED');
    expect(cuerpo.message).toMatch(/^Demasiados intentos para entrar con este correo\. Espera \d+ minutos? y vuelve a intentar\.$/);
    expect(cuerpo.retryAfterSeconds).toBeGreaterThan(200);
    expect(cuerpo.retryAfterSeconds).toBeLessThanOrEqual(300);
    expect(r.headers['retry-after']).toBe(String(cuerpo.retryAfterSeconds));
    expect(cuerpo.requestId).toBeTruthy();
  });

  it('otra persona desde esa IP, y ese correo desde otra IP, siguen entrando', async () => {
    const correo = correoNuevo();
    for (let i = 0; i < 4; i++) await entrar(app, correo, '203.0.113.20');
    expect((await entrar(app, correo, '203.0.113.20')).statusCode).toBe(429);
    expect((await entrar(app, correo, '203.0.113.21')).statusCode).toBe(401);
    const otra = await entrar(app, 'gerencia@demo.mx', '203.0.113.20', PASSWORD);
    expect(otra.statusCode, otra.body).toBe(200);
  });

  it('el tope por red frena a quien prueba muchos correos desde una sola IP', async () => {
    for (let i = 0; i < 6; i++) expect((await entrar(app, correoNuevo(), '203.0.113.30')).statusCode).toBe(401);
    const r = await entrar(app, correoNuevo(), '203.0.113.30');
    expect(r.statusCode).toBe(429);
    expect(r.json().message).toMatch(/^Demasiados intentos desde esta red\. Espera \d+ minutos? y vuelve a intentar\.$/);
    expect(r.headers['retry-after']).toBe(String(r.json().retryAfterSeconds));
    // Otra red no se entera.
    expect((await entrar(app, correoNuevo(), '203.0.113.31')).statusCode).toBe(401);
  });

  it('quien no es proxy de confianza no elige su IP con X-Forwarded-For', async () => {
    const correo = correoNuevo();
    for (let i = 0; i < 3; i++) await entrar(app, correo, `198.51.100.${i + 1}`, undefined, '192.0.2.50');
    expect((await entrar(app, correo, '198.51.100.99', undefined, '192.0.2.50')).statusCode).toBe(429);
  });

  it('con sesión, el cupo es de esa sesión: otra persona en el mismo equipo no se entera (24-20)', async () => {
    const sesion = async () => {
      const r = await entrar(app, 'recepcion@demo.mx', '203.0.113.50', PASSWORD);
      expect(r.statusCode, r.body).toBe(200);
      return `gf_session=${r.cookies.find((c) => c.name === 'gf_session')!.value}`;
    };
    const [una, otra] = [await sesion(), await sesion()];
    // Cuerpos incompletos: cuentan para el límite y no prueban ninguna contraseña.
    const firmar = (cookie: string) => app.inject({ method: 'POST', url: '/approvals', headers: { cookie, 'x-forwarded-for': '203.0.113.50' }, payload: {} });
    for (let i = 0; i < 3; i++) expect((await firmar(una)).statusCode).toBe(422);
    const r = await firmar(una);
    expect(r.statusCode).toBe(429);
    expect(r.json().message).toMatch(/^Demasiados intentos\. Espera \d+ minutos? y vuelve a intentar\.$/);
    expect((await firmar(otra)).statusCode).toBe(422);
  });

  it('sin TRUSTED_PROXIES la cabecera no cuenta: todo llega como el proxy (por eso el uso real la exige)', async () => {
    const correo = correoNuevo();
    for (let i = 0; i < 3; i++) await entrar(sinProxies, correo, `203.0.113.${40 + i}`);
    expect((await entrar(sinProxies, correo, '203.0.113.99')).statusCode).toBe(429);
  });
});

describe('alta por QR: por teléfono y por sucursal, nunca por red', () => {
  let porTelefono: FastifyInstance;
  let porSucursal: FastifyInstance;
  let branchId: string;
  let otraSede: string;
  let consents: { consentType: string; version: string; granted: boolean }[];

  beforeAll(async () => {
    porTelefono = await makeApp({ TRUSTED_PROXIES: PROXIES, INTAKE_SUBMIT_ATTEMPTS: '2', INTAKE_SUBMIT_PER_BRANCH: '1000' });
    porSucursal = await makeApp({ TRUSTED_PROXIES: PROXIES, INTAKE_SUBMIT_ATTEMPTS: '1000', INTAKE_SUBMIT_PER_BRANCH: '3' });
    await porTelefono.ready();
    await porSucursal.ready();
    const f = await orgFixtures();
    branchId = f.demoBranches[0]!.id;
    otraSede = f.demoBranches[1]!.id;
    const form = (await porTelefono.inject({ method: 'GET', url: `/intake/${branchId}/form` })).json();
    consents = (form.documents as { consentType: string; version: string; required: boolean }[])
      .filter((d) => d.required)
      .map((d) => ({ consentType: d.consentType, version: d.version, granted: true }));
  });
  afterAll(async () => { await porTelefono.close(); await porSucursal.close(); await closeDb(); });

  const alta = (a: FastifyInstance, sede: string, phone: string, extra: Record<string, unknown> = {}) => a.inject({
    method: 'POST', url: `/intake/${sede}`,
    // Todos desde la misma red, como en una promoción con el Wi-Fi del gimnasio.
    headers: { 'x-forwarded-for': '203.0.113.77' },
    payload: {
      firstName: nombreUnico('Limite'), lastName: nombreUnico('Alta'), phone, email: null,
      birthDate: '1994-03-08', emergencyContactName: 'Contacto Emergencia', emergencyContactPhone: '5511223344',
      memberSince: null, healthNotes: null, consents, ...extra,
    },
  });

  it('seis teléfonos desde la misma red entran todos: la sexta persona de la fila ya no ve un error', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await alta(porTelefono, branchId, telefonoUnico().slice(3));
      expect(r.statusCode, r.body).toBe(201);
    }
  });

  it('el mismo teléfono se frena al tercer envío, con un aviso que manda a recepción', async () => {
    const tel = telefonoUnico().slice(3);
    expect((await alta(porTelefono, branchId, tel)).statusCode).toBe(201);
    // Escrito de otra forma sigue siendo el mismo celular.
    expect((await alta(porTelefono, branchId, `${tel.slice(0, 2)} ${tel.slice(2, 6)} ${tel.slice(6)}`)).statusCode).toBe(201);
    const r = await alta(porTelefono, branchId, `+52 ${tel}`);
    expect(r.statusCode).toBe(429);
    expect(r.json().message).toMatch(/^Ya recibimos varios envíos con este teléfono\. Espera \d+ minutos? o pasa a recepción/);
    expect(r.json().retryAfterSeconds).toBeGreaterThan(0);
  });

  it('la sucursal acepta su tope por hora; lo que se rechaza por datos no gasta cupo; otra sede no se entera', async () => {
    const invalida = await alta(porSucursal, branchId, telefonoUnico().slice(3), { consents: [] });
    expect(invalida.statusCode).toBe(422);
    for (let i = 0; i < 3; i++) expect((await alta(porSucursal, branchId, telefonoUnico().slice(3))).statusCode).toBe(201);
    const llena = await alta(porSucursal, branchId, telefonoUnico().slice(3));
    expect(llena.statusCode).toBe(429);
    const cuerpo = llena.json();
    expect(cuerpo.error).toBe('RATE_LIMITED');
    expect(cuerpo.message).toMatch(/^En la última hora se registraron muchas personas en esta sucursal\. Pasa a recepción/);
    expect(cuerpo.retryAfterSeconds).toBeGreaterThan(3000);
    expect(cuerpo.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(llena.headers['retry-after']).toBe(String(cuerpo.retryAfterSeconds));
    const enOtra = await alta(porSucursal, otraSede, telefonoUnico().slice(3));
    expect(enOtra.statusCode, enOtra.body).not.toBe(429);
  });
});
