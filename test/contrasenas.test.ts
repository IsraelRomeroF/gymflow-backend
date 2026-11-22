import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { makeApp, loginAs, loginPlataforma, orgFixtures, correoUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { CAMBIO_SIN_ACTUAL_MIN, PASSWORD_MIN, TEMPORAL_DIAS } from '../src/modules/identity/auth.service.js';

/**
 * CONTRASEÑAS (fase 0, bloque 0.2 · 22-03, A4-N1, 24-10).
 *
 * La temporal la conoce quien la dio: solo sirve para que su dueño elija la
 * suya, vence a los siete días y el cambio obligatorio no la vuelve a pedir.
 * La longitud mínima es una para todos.
 */
describe('contraseñas temporales y la regla única', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let sede: string;
  let demoId: string;
  const creados: string[] = [];
  const NUEVA = 'Mi-Clave-Propia-2026';

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    const { demo, demoBranches } = await orgFixtures();
    demoId = demo.id;
    sede = demoBranches[0]!.id;
  });
  afterAll(async () => {
    const db = getDb();
    for (const id of creados) {
      await db.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'fin_de_prueba' } });
      await db.user.update({ where: { id }, data: { isActive: false, deletedAt: new Date(), email: `${id}@borrado.local` } });
    }
    await app.close();
    await closeDb();
  });

  /** Una recepcionista nueva, dada de alta por la gerencia: nace con temporal. */
  async function personaNueva(): Promise<{ id: string; email: string; temporal: string }> {
    const email = correoUnico('temporal');
    const r = await app.inject({
      method: 'POST', url: '/users', headers: { cookie: gerencia },
      payload: { email, fullName: 'Prueba Temporal', roleKey: 'RECEPTION', branchIds: [sede], reason: 'Prueba de contraseña temporal' },
    });
    expect(r.statusCode, r.body).toBe(201);
    creados.push(r.json().user.id);
    return { id: r.json().user.id, email, temporal: r.json().temporaryPassword };
  }
  const entrar = (email: string, password: string, ip?: string) => app.inject({
    method: 'POST', url: '/auth/login', payload: { email, password }, ...(ip ? { remoteAddress: ip } : {}),
  });
  const sesion = (r: LightMyRequestResponse) => `gf_session=${r.cookies.find((c) => c.name === 'gf_session')!.value}`;
  const cambiar = (cookie: string, payload: Record<string, string>) => app.inject({ method: 'POST', url: '/auth/password', headers: { cookie }, payload });
  const campo = (r: LightMyRequestResponse, c: string) => (r.json().issues as Array<{ path: string; message: string }> | undefined)?.find((i) => i.path === c)?.message;

  it('la regla es una para todos: 12 caracteres, la temporal vale 7 días y el cambio sin «actual», 15 minutos', () => {
    expect([PASSWORD_MIN, TEMPORAL_DIAS, CAMBIO_SIN_ACTUAL_MIN]).toEqual([12, 7, 15]);
  });

  it('con la temporal no se opera nada: solo saber quién es, elegir la suya y salir (A4-N1)', async () => {
    const p = await personaNueva();
    const login = await entrar(p.email, p.temporal);
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json()).toMatchObject({ status: 'AUTHENTICATED', platform: false, mustChangePassword: true });
    const cookie = sesion(login);

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().mustChangePassword).toBe(true);
    // Leer, pedir una firma o recibir avisos: nada responde a una sesión temporal.
    for (const [method, url] of [['GET', '/members?limit=1'], ['GET', '/organization'], ['GET', '/branches'], ['GET', '/approvals/inbox'], ['GET', '/me/shift']] as const) {
      expect((await app.inject({ method, url, headers: { cookie } })).statusCode, url).toBe(401);
    }
    const firma = await app.inject({
      method: 'POST', url: '/approvals/requests', headers: { cookie },
      payload: { permission: 'cash:withdraw', branchId: sede, resourceId: '0190e000-0000-7000-8000-000000000001', amountCents: '100', summary: 'Retiro de prueba' },
    });
    expect(firma.statusCode).toBe(401);
    // Salir sí.
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('elige la suya sin volver a escribir la temporal, y desde ahí la sesión ya opera (24-10)', async () => {
    const p = await personaNueva();
    const cookie = sesion(await entrar(p.email, p.temporal));

    const corta = await cambiar(cookie, { next: 'Once-letras' });
    expect(corta.statusCode).toBe(422);
    expect(campo(corta, 'next')).toMatch(/12/);
    // La temporal no se queda como la de siempre: la conoce quien la dio.
    const igual = await cambiar(cookie, { next: p.temporal });
    expect(igual.statusCode).toBe(422);
    expect(campo(igual, 'next')).toMatch(/distinta de la temporal/);

    const ok = await cambiar(cookie, { next: NUEVA });
    expect(ok.statusCode, ok.body).toBe(200);
    // La misma sesión sigue y ahora sí trabaja.
    expect((await app.inject({ method: 'GET', url: '/members?limit=1', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json().mustChangePassword).toBe(false);
    // La temporal dejó de servir; la suya entra como cualquiera.
    expect((await entrar(p.email, p.temporal)).statusCode).toBe(401);
    const otra = await entrar(p.email, NUEVA);
    expect(otra.statusCode).toBe(200);
    expect(otra.json().mustChangePassword).toBe(false);
    // Queda en la bitácora que fue el cambio obligatorio.
    const asiento = await getDb().auditLog.findFirst({ where: { organizationId: demoId, action: 'auth.password_change', resourceId: p.id } });
    expect(asiento?.afterState).toMatchObject({ forced: true });
  });

  it('sin «actual» solo en el cambio obligatorio y en los minutos siguientes a entrar con la temporal', async () => {
    // Quien ya eligió la suya tiene que escribirla para cambiarla.
    const p = await personaNueva();
    const c1 = sesion(await entrar(p.email, p.temporal));
    expect((await cambiar(c1, { next: NUEVA })).statusCode).toBe(200);
    const sinActual = await cambiar(c1, { next: 'Otra-Clave-Propia-2026' });
    expect(sinActual.statusCode).toBe(422);
    expect(campo(sinActual, 'current')).toMatch(/actual/);

    // Una sesión temporal que se quedó abierta más de 15 minutos ya no elige sin escribir la temporal.
    const q = await personaNueva();
    const c2 = sesion(await entrar(q.email, q.temporal));
    await getDb().user.update({ where: { id: q.id }, data: { lastLoginAt: new Date(Date.now() - (CAMBIO_SIN_ACTUAL_MIN + 1) * 60_000) } });
    const tarde = await cambiar(c2, { next: NUEVA });
    expect(tarde.statusCode).toBe(403);
    expect(tarde.json().message).toMatch(/15 minutos/);
    // Escribiéndola, sí (el diálogo del panel todavía la pide).
    expect((await cambiar(c2, { current: q.temporal, next: NUEVA })).statusCode).toBe(200);
  });

  it('cambiar la suya con la actual sigue igual, con el mismo mínimo de 12', async () => {
    const p = await personaNueva();
    const cookie = sesion(await entrar(p.email, p.temporal));
    expect((await cambiar(cookie, { next: NUEVA })).statusCode).toBe(200);
    expect((await cambiar(cookie, { current: NUEVA, next: 'Once-letras' })).statusCode).toBe(422);
    expect(campo(await cambiar(cookie, { current: NUEVA, next: NUEVA }), 'next')).toMatch(/distinta/);
    expect((await cambiar(cookie, { current: 'no-es-la-mia', next: 'Una-Clave-Nueva-2026' })).statusCode).toBe(401);
    expect((await cambiar(cookie, { current: NUEVA, next: 'Una-Clave-Nueva-2026' })).statusCode).toBe(200);
  });

  it(`la temporal vence a los ${TEMPORAL_DIAS} días: ya no entra y la sesión que abrió se cierra`, async () => {
    const db = getDb();
    const hace = (dias: number) => new Date(Date.now() - dias * 86_400_000);

    // Con seis días todavía sirve.
    const vigente = await personaNueva();
    await db.user.update({ where: { id: vigente.id }, data: { passwordResetAt: hace(TEMPORAL_DIAS - 1) } });
    expect((await entrar(vigente.email, vigente.temporal)).statusCode).toBe(200);

    // Con ocho, no: se le dice a quien la tecleó bien, y no cuenta como intento fallido.
    const vieja = await personaNueva();
    await db.user.update({ where: { id: vieja.id }, data: { passwordResetAt: hace(TEMPORAL_DIAS + 1) } });
    const r = await entrar(vieja.email, vieja.temporal);
    expect(r.statusCode).toBe(403);
    expect(r.json().message).toMatch(/venció/);
    expect((await db.user.findUniqueOrThrow({ where: { id: vieja.id } })).failedLogins).toBe(0);
    // Con la contraseña equivocada, la respuesta sigue siendo la genérica.
    expect((await entrar(vieja.email, 'no-es-la-temporal')).json().message).toBe('El correo o la contraseña no coinciden');

    // La sesión que se abrió con ella muere cuando vence.
    const abierta = await personaNueva();
    const cookie = sesion(await entrar(abierta.email, abierta.temporal));
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(200);
    await db.user.update({ where: { id: abierta.id }, data: { passwordResetAt: hace(TEMPORAL_DIAS + 1) } });
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
    const s = await db.session.findFirstOrThrow({ where: { userId: abierta.id }, orderBy: { createdAt: 'desc' } });
    expect(s.revokedReason).toBe('temporal_vencida');
  });

  it('una temporal nueva desde la plataforma desbloquea la cuenta y cierra las sesiones que tenía', async () => {
    const db = getDb();
    const p = await personaNueva();
    const primera = sesion(await entrar(p.email, p.temporal));
    expect((await cambiar(primera, { next: NUEVA })).statusCode).toBe(200);
    const deSiempre = sesion(await entrar(p.email, NUEVA, '10.0.0.41'));
    expect((await app.inject({ method: 'GET', url: '/members?limit=1', headers: { cookie: deSiempre } })).statusCode).toBe(200);
    // Se quedó bloqueada por intentos fallidos.
    await db.user.update({ where: { id: p.id }, data: { failedLogins: 9, lockedUntil: new Date(Date.now() + 30 * 60_000) } });

    const plataforma = await loginPlataforma(app);
    const reset = await app.inject({ method: 'POST', url: `/platform/organizations/${demoId}/users/${p.id}/password-reset`, headers: { cookie: plataforma }, payload: { reason: 'La olvidó y quedó bloqueada' } });
    expect(reset.statusCode, reset.body).toBe(200);
    // La sesión de antes ya no opera mientras la cuenta espera que su dueña elija.
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: deSiempre } })).statusCode).toBe(401);
    // Entra con la temporal nueva aunque sea desde otro equipo: la temporal desbloquea.
    const nueva = await entrar(p.email, reset.json().password, '198.51.100.77');
    expect(nueva.statusCode, nueva.body).toBe(200);
    expect(nueva.json().mustChangePassword).toBe(true);
  });
});
