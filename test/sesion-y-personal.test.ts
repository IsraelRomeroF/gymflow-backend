import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { makeApp, PASSWORD } from './helpers.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { ponerReloj, relojReal } from './reloj.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { hashToken } from '../src/platform/crypto.js';

/**
 * LA SESIÓN QUE SE RENUEVA Y LAS ESCRITURAS DE PERSONAL, A LA VEZ (fase 4, bloque 4.1).
 *
 * Cambiar lo que ve una persona, darla de baja o reactivarla le CIERRA sus
 * sesiones; la petición que lo pide toca (o renueva, si es el teléfono de la
 * dueña) la sesión de quien lo pide. Son filas distintas de `sessions` y
 * ninguna de las dos cosas va dentro de una transacción que espere a la
 * otra: aquí se comprueba con todo pasando al mismo tiempo, justo cuando a la
 * sesión de la dueña le toca renovarse, que nadie se queda esperando.
 */
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const HORA = 3_600_000;
const DateDeVerdad = Date;
const dentroDe = (ms: number) => ponerReloj(new DateDeVerdad(DateDeVerdad.now() + ms).toISOString());

/** Ninguna respuesta puede tardar más que esto: los topes de la base (5 s de candado, 15 s de consulta) quedan lejos. */
const TOPE_MS = 10_000;
function sinColgarse<T>(p: Promise<T>, que: string): Promise<T> {
  let reloj: ReturnType<typeof setTimeout>;
  const tope = new Promise<never>((_, no) => { reloj = setTimeout(() => no(new Error(`COLGADA: ${que} no respondió en ${TOPE_MS / 1000} s`)), TOPE_MS); });
  return Promise.race([p, tope]).finally(() => clearTimeout(reloj));
}

describe('la sesión que se renueva y las escrituras de personal, a la vez', () => {
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

  async function entrar(email: string, ua?: string): Promise<string> {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD }, headers: ua ? { 'user-agent': ua } : {} });
    expect(r.statusCode, r.body).toBe(200);
    return `gf_session=${r.cookies.find((c) => c.name === 'gf_session')!.value}`;
  }
  const fila = (cookie: string) => db().session.findUniqueOrThrow({ where: { tokenHash: hashToken(cookie.split('=')[1]!) } });
  const idDe = async (email: string) => (await db().user.findFirstOrThrow({ where: { email } })).id;

  it('la dueña, desde su teléfono y justo al renovarse su sesión, cambia lo que ve recepción mientras recepción y gerencia siguen pidiendo: todo responde', async () => {
    const duena = await entrar(g.correos.owner, UA_IPHONE);
    const recepcion = await entrar(g.correos.recepcion);
    const gerente = await entrar(g.correos.gerente);
    const idRecepcion = await idDe(g.correos.recepcion);
    const antes = (await fila(duena)).expiresAt.getTime();

    // Dos horas después: a la sesión de la dueña le toca renovarse en su siguiente petición, y a las demás, anotar su uso.
    dentroDe(2 * HORA);
    const t0 = Date.now();
    const pedir = (cookie: string, url: string, ua?: string) => app.inject({ method: 'GET', url, headers: { cookie, ...(ua ? { 'user-agent': ua } : {}) } });
    const respuestas = await sinColgarse(Promise.all([
      // La escritura que cierra las sesiones de recepción, pedida con la sesión que se renueva…
      app.inject({ method: 'PUT', url: `/users/${idRecepcion}/sections`, headers: { cookie: duena, 'user-agent': UA_IPHONE }, payload: { sections: ['planes'], reason: 'Lleva el catálogo de la sucursal' } }),
      // …mientras la propia dueña pide otras cosas con esa misma sesión,
      ...Array.from({ length: 6 }, () => pedir(duena, '/auth/me', UA_IPHONE)),
      pedir(duena, '/users', UA_IPHONE),
      // la persona afectada sigue usando la suya (se le cierra a media ráfaga),
      ...Array.from({ length: 6 }, () => pedir(recepcion, '/auth/me')),
      // y gerencia da de alta a alguien y consulta al personal.
      app.inject({ method: 'POST', url: '/users', headers: { cookie: gerente }, payload: { email: `a-la-vez.${Date.now()}@propio.mx`, fullName: 'Alta A La Vez', phoneE164: null, roleKey: 'RECEPTION', branchIds: [g.sedes[0]!.id], reason: 'Cuenta de una prueba' } }),
      pedir(gerente, '/users'),
    ]), 'la ráfaga de personal');
    expect(Date.now() - t0).toBeLessThan(TOPE_MS);

    const [secciones, ...resto] = respuestas as LightMyRequestResponse[];
    expect(secciones!.statusCode, secciones!.body).toBe(200);
    // Ninguna quedó en error del servidor: 200, 201 o el 401 de la sesión que se cerró.
    for (const r of resto) expect([200, 201, 401], `${r.statusCode} ${r.body.slice(0, 200)}`).toContain(r.statusCode);
    // La sesión de recepción quedó cerrada con su motivo, y la de la dueña, renovada una sola vez.
    const cerrada = await pedir(recepcion, '/auth/me');
    expect(cerrada.statusCode).toBe(401);
    expect(cerrada.json().reason).toBe('ACCESS_CHANGED');
    const despues = await fila(duena);
    expect(despues.revokedAt).toBeNull();
    expect(despues.expiresAt.getTime()).toBeGreaterThan(antes + HORA);
    const puestas = respuestas.flatMap((r) => r.cookies.filter((c) => c.name === 'gf_session'));
    expect(puestas.length).toBeGreaterThanOrEqual(1);
    expect(new Set(puestas.map((c) => c.value)).size).toBe(1);
  });

  it('baja y reactivación de una persona mientras ella y quien la da de baja siguen pidiendo: todo responde y sus sesiones quedan cerradas', async () => {
    const gerente = await entrar(g.correos.gerente);
    const idRecepcion = await idDe(g.correos.recepcion);
    // Su contraseña y su estado se devuelven al final: el gimnasio es de este archivo, pero la cuenta se usa arriba.
    const original = await db().user.findUniqueOrThrow({ where: { id: idRecepcion }, select: { passwordHash: true } });
    await db().session.updateMany({ where: { userId: idRecepcion, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'fin_de_prueba' } });
    const recepcion = await entrar(g.correos.recepcion);
    try {
      for (const cuerpo of [{ isActive: false, reason: 'Fin de contrato (prueba)' }, { isActive: true, reason: 'Regresa a trabajar (prueba)' }]) {
        const respuestas = await sinColgarse(Promise.all([
          app.inject({ method: 'PATCH', url: `/users/${idRecepcion}`, headers: { cookie: gerente }, payload: cuerpo }),
          ...Array.from({ length: 5 }, () => app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: recepcion } })),
          ...Array.from({ length: 5 }, () => app.inject({ method: 'GET', url: '/users', headers: { cookie: gerente } })),
        ]), `PATCH /users (${JSON.stringify(cuerpo)})`);
        expect(respuestas[0]!.statusCode, respuestas[0]!.body).toBe(200);
        for (const r of respuestas.slice(1)) expect([200, 401], `${r.statusCode} ${r.body.slice(0, 200)}`).toContain(r.statusCode);
      }
      expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: recepcion } })).statusCode).toBe(401);
      expect((await fila(recepcion)).revokedAt).not.toBeNull();
    } finally {
      await db().user.update({ where: { id: idRecepcion }, data: { isActive: true, mustChangePassword: false, passwordResetAt: null, passwordHash: original.passwordHash } });
    }
  });
});
