import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MeHome, diferenciasConElContrato } from '@gymflow/core/contracts';
import { makeApp, cuentaDePrueba } from './helpers.js';
import { gimnasioPropio, sesionesDe, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * FASE 3 · BLOQUE 3.16 · «SOCIOS NUEVOS SIN COACH» EN EL INICIO (recomendación de D-29).
 *
 * Recepción elige el coach al alta; lo que queda sin coach lo pone la
 * gerencia. Su Inicio (`GET /me/home`, asunto `coachless`) le dice cuántos
 * socios de los últimos 7 días siguen sin coach y quiénes (hasta cuatro).
 * Solo a quien puede ponérselo y solo si el gimnasio tiene algún coach activo.
 * Gimnasio propio: la cuenta depende de que nadie más dé de alta socios ahí.
 */
describe('inicio · socios nuevos sin coach (D-29, 3.16)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let s: { owner: string; gerente: string; gerente2: string; recepcion: string };
  let consultas = 0;

  const home = async (cookie: string): Promise<MeHome> => {
    const r = await app.inject({ method: 'GET', url: '/me/home', headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(MeHome, r.json())).toEqual([]);
    return r.json() as MeHome;
  };
  const sinCoach = async (cookie: string) => (await home(cookie)).items.find((i) => i.key === 'coachless');
  const puede = async (cookie: string) => ((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json().permissions as string[]).includes('members:coach:assign');

  beforeAll(async () => {
    // Para contar consultas: el cliente que dejó `setup.ts` nació sin el registro de consultas; se abre uno nuevo que sí lo lleva.
    process.env.DB_LOG_QUERIES = '1';
    await closeDb();
    app = await makeApp();
    await app.ready();
    (getDb() as unknown as { $on: (e: string, f: () => void) => void }).$on('query', () => { consultas++; });
    g = await gimnasioPropio();
    s = await sesionesDe(app, g);
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  it('sin ningún coach activo en el gimnasio no hay aviso: no habría a quién ponerles', async () => {
    await socioPropio(g);
    expect(await puede(s.gerente)).toBe(true);
    expect(await sinCoach(s.gerente)).toBeUndefined();
  });

  it('con coach: la gerencia ve cuántos socios de la semana siguen sin coach y quiénes; baja al asignarlo; no cuenta a los de antes ni a las bajas', async () => {
    const sede = g.sedes[0]!.id;
    const db = getDb();
    const coachId = (await db.user.findFirstOrThrow({ where: { email: await cuentaDePrueba(g.organizationId, 'COACH', [sede]) } })).id;
    const nuevos = [await socioPropio(g), await socioPropio(g), await socioPropio(g), await socioPropio(g), await socioPropio(g)];
    // Cada uno un segundo más nuevo que el anterior: en CI cinco altas seguidas caen en el mismo milisegundo.
    for (const [i, id] of nuevos.entries()) await db.member.update({ where: { id }, data: { createdAt: new Date(Date.now() - (nuevos.length - i) * 1000) } });
    // Uno de hace ocho días y una baja: ninguno cuenta.
    const viejo = await socioPropio(g);
    await db.member.update({ where: { id: viejo }, data: { createdAt: new Date(Date.now() - 8 * 86_400_000) } });
    const baja = await socioPropio(g);
    await db.member.update({ where: { id: baja }, data: { deletedAt: new Date(), status: 'ARCHIVED' } });

    // 5 de este caso + 1 del anterior.
    const r = (await sinCoach(s.gerente))!;
    expect(r).toMatchObject({ count: 6, tone: 'info' });
    expect(r.detail).toHaveLength(4);
    const ultimo = await db.member.findUniqueOrThrow({ where: { id: nuevos.at(-1)! } });
    expect(r.detail[0]).toBe(`${ultimo.firstName} ${ultimo.lastName}`);

    // Quien no puede poner el coach no recibe el aviso (recepción lo elige al alta, no después).
    for (const cookie of [s.recepcion, s.owner]) if (!(await puede(cookie))) expect(await sinCoach(cookie)).toBeUndefined();
    expect(await puede(s.recepcion)).toBe(false);

    // La gerencia le pone coach a uno: uno menos.
    const poner = await app.inject({ method: 'PUT', url: `/members/${nuevos[0]}/coach`, headers: { cookie: s.gerente }, payload: { coachUserId: coachId } });
    expect(poner.statusCode, poner.body).toBe(200);
    expect((await sinCoach(s.gerente))!.count).toBe(5);

    // Es UNA consulta, haya los socios que haya.
    const medir = async () => { await home(s.gerente); const antes = consultas; await home(s.gerente); return consultas - antes; };
    const con5 = await medir();
    expect(con5).toBeGreaterThan(0);
    for (let i = 0; i < 6; i++) await socioPropio(g);
    expect((await sinCoach(s.gerente))!.count).toBe(11);
    expect(await medir()).toBe(con5);

    // Si el coach deja de estar activo, el aviso se va.
    await db.user.update({ where: { id: coachId }, data: { isActive: false } });
    expect(await sinCoach(s.gerente)).toBeUndefined();
  });
});
