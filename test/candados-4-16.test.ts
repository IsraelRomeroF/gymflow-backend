import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { hashToken } from '../src/platform/crypto.js';
import { gimnasioPropio, socioPropio, abrirTurno, type GimnasioPropio } from './gimnasio-propio.js';

/**
 * FASE 4 · BLOQUE 4.16 · CANDADOS DEL CORTE Y DEL ÚLTIMO USO.
 *
 *  · El conteo se anota dentro del turno de dinero y se conserva aunque el
 *    cierre se rechace (punto de retorno): un faltante sin motivo deja el
 *    primer conteo y su intento; un reconteo sin motivo también.
 *  · Un turno ya cerrado no suma intentos ni cae en 500; dos cortes a la vez
 *    del mismo turno: uno cierra y el otro dice «ya está cerrado».
 *  · El «último uso» de la sesión (panel y portal) no hace esperar ni tumba
 *    a las peticiones simultáneas aunque otra tenga tomada la fila.
 */
describe('candados · corte de caja y último uso', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let recepcion: string; let gerente: string;
  const FONDO = 100_000n;
  const db = () => getDb();

  const cortar = (turno: string, contado: bigint, motivo?: string) => app.inject({
    method: 'POST', url: `/cash-sessions/${turno}/close`, headers: { cookie: recepcion },
    payload: { countedCashCents: contado.toString(), ...(motivo ? { varianceReason: motivo } : {}) },
  });
  const fila = (turno: string) => db().cashSession.findUniqueOrThrow({
    where: { id: turno }, select: { status: true, firstCountedCashCents: true, countAttempts: true, countedCashCents: true },
  });

  /** Toma la fila con otra transacción y la suelta cuando se le pide. */
  async function tomarFila(sql: (tx: { $queryRawUnsafe: (q: string, ...v: unknown[]) => Promise<unknown> }) => Promise<unknown>) {
    let soltar!: () => void;
    const suelta = new Promise<void>((r) => { soltar = r; });
    let tomada!: () => void;
    const lista = new Promise<void>((r) => { tomada = r; });
    const tx = db().$transaction(async (t) => {
      await sql(t as never);
      tomada();
      await suelta;
    }, { timeout: 30_000, maxWait: 5_000 });
    await lista;
    return { soltar: async () => { soltar(); await tx; } };
  }

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio({ sedes: [{ name: 'Sede de los candados', cajas: 2 }] });
    recepcion = await loginAs(app, g.correos.recepcion);
    gerente = await loginAs(app, g.correos.gerente);
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  it('un faltante sin motivo se rechaza, pero el conteo y su intento quedan', async () => {
    const turno = await abrirTurno(app, recepcion, g.sedes[0]!.cajas[0]!, FONDO.toString());
    const r = await cortar(turno, FONDO - 5_000n);
    expect(r.statusCode, r.body).toBe(422);
    expect(await fila(turno)).toMatchObject({ status: 'OPEN', firstCountedCashCents: FONDO - 5_000n, countAttempts: 1, countedCashCents: null });
    // Ningún asiento de cierre: lo que hizo el cierre se deshizo solo.
    expect(await db().auditLog.count({ where: { organizationId: g.organizationId, action: 'cash.session.close', resourceId: turno } })).toBe(0);

    // Recontar justo lo esperado, sin motivo: «segundo conteo», y también queda el intento.
    const tapar = await cortar(turno, FONDO);
    expect(tapar.statusCode, tapar.body).toBe(422);
    expect(tapar.json().message).toMatch(/segundo conteo/i);
    expect(tapar.json().message).toMatch(/950\.00/);
    expect(await fila(turno)).toMatchObject({ status: 'OPEN', firstCountedCashCents: FONDO - 5_000n, countAttempts: 2 });

    // Con motivo cierra; el primer conteo sigue siendo el primero y la bitácora lo guarda.
    const ok = await cortar(turno, FONDO, 'Había un sobre con $50 bajo la charola');
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await fila(turno)).toMatchObject({ status: 'CLOSED', firstCountedCashCents: FONDO - 5_000n, countAttempts: 3, countedCashCents: FONDO });
    const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'cash.session.close', resourceId: turno } });
    expect(asiento.afterState).toMatchObject({ firstCountedCashCents: (FONDO - 5_000n).toString(), countedCashCents: FONDO.toString() });
  });

  it('un turno ya cerrado no suma intentos ni cae en 500', async () => {
    const turno = await abrirTurno(app, recepcion, g.sedes[0]!.cajas[0]!, FONDO.toString());
    expect((await cortar(turno, FONDO)).statusCode).toBe(200);
    const antes = await fila(turno);
    const otra = await cortar(turno, FONDO - 1_000n, 'Intento sobre un turno ya cortado');
    expect(otra.statusCode, otra.body).toBe(422);
    expect(otra.json().message).toMatch(/ya está cerrado/i);
    expect(await fila(turno)).toEqual(antes);
  });

  it('dos cortes a la vez del mismo turno: uno cierra y el otro dice «ya está cerrado»', async () => {
    const turno = await abrirTurno(app, recepcion, g.sedes[0]!.cajas[1]!, FONDO.toString());
    const [a, b] = await Promise.all([cortar(turno, FONDO), cortar(turno, FONDO)]);
    const codigos = [a.statusCode, b.statusCode].sort();
    expect(codigos, `${a.body} | ${b.body}`).toEqual([200, 422]);
    const rechazo = a.statusCode === 422 ? a : b;
    expect(rechazo.json().message).toMatch(/ya está cerrado/i);
    // El segundo llegó con el turno ya cerrado: su conteo no se sumó.
    expect(await fila(turno)).toMatchObject({ status: 'CLOSED', countAttempts: 1 });
    expect(await db().auditLog.count({ where: { organizationId: g.organizationId, action: 'cash.session.close', resourceId: turno } })).toBe(1);
  });

  it('con la fila del turno tomada un momento, el corte espera y cierra (no 500)', async () => {
    const turno = await abrirTurno(app, recepcion, g.sedes[0]!.cajas[0]!, FONDO.toString());
    const candado = await tomarFila((t) => t.$queryRawUnsafe('SELECT 1 FROM "cash_sessions" WHERE "id" = $1::uuid FOR UPDATE', turno));
    const corte = cortar(turno, FONDO);
    await new Promise((r) => setTimeout(r, 800));
    await candado.soltar();
    const r = await corte;
    expect(r.statusCode, r.body).toBe(200);
    expect(await fila(turno)).toMatchObject({ status: 'CLOSED', countAttempts: 1 });
  });

  it('panel: con la fila de la sesión tomada, cuatro peticiones a la vez responden enseguida y el último uso se anota después', async () => {
    const id = (await db().session.findFirstOrThrow({ where: { tokenHash: hashToken(gerente.replace('gf_session=', '')) } })).id;
    const hace5 = new Date(Date.now() - 5 * 60_000);
    await db().session.update({ where: { id }, data: { lastSeenAt: hace5 } });

    const candado = await tomarFila((t) => t.$queryRawUnsafe('SELECT 1 FROM "sessions" WHERE "id" = $1::uuid FOR UPDATE', id));
    try {
      const inicio = Date.now();
      const rs = await Promise.all([1, 2, 3, 4].map(() => app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: gerente } })));
      const tardo = Date.now() - inicio;
      expect(rs.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
      // Antes esperaban el candado hasta su tope (5 s) y caían en 500.
      expect(tardo).toBeLessThan(3_000);
    } finally {
      await candado.soltar();
    }
    // Nadie lo pudo anotar con la fila tomada; la siguiente petición sí.
    expect((await db().session.findUniqueOrThrow({ where: { id } })).lastSeenAt.getTime()).toBe(hace5.getTime());
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: gerente } })).statusCode).toBe(200);
    expect((await db().session.findUniqueOrThrow({ where: { id } })).lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('portal: con la fila de la sesión del socio tomada, las peticiones a la vez no esperan ni fallan', async () => {
    const socio = await socioPropio(g);
    const inv = await app.inject({ method: 'POST', url: `/members/${socio}/portal-invite`, headers: { cookie: gerente } });
    expect(inv.statusCode, inv.body).toBe(201);
    const act = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: inv.json().code } });
    expect(act.statusCode, act.body).toBe(201);
    const cookie = `gf_portal=${act.cookies.find((c) => c.name === 'gf_portal')!.value}`;
    const id = (await db().memberSession.findFirstOrThrow({ where: { tokenHash: hashToken(cookie.replace('gf_portal=', '')) } })).id;
    const viejo = new Date(Date.now() - 2 * 3_600_000);
    await db().memberSession.update({ where: { id }, data: { lastSeenAt: viejo } });

    const candado = await tomarFila((t) => t.$queryRawUnsafe('SELECT 1 FROM "member_sessions" WHERE "id" = $1::uuid FOR UPDATE', id));
    try {
      const inicio = Date.now();
      const rs = await Promise.all([1, 2, 3].map(() => app.inject({ method: 'GET', url: '/portal/me', headers: { cookie } })));
      expect(rs.map((r) => r.statusCode)).toEqual([200, 200, 200]);
      expect(Date.now() - inicio).toBeLessThan(3_000);
    } finally {
      await candado.soltar();
    }
    expect((await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie } })).statusCode).toBe(200);
    expect((await db().memberSession.findUniqueOrThrow({ where: { id } })).lastSeenAt.getTime()).toBeGreaterThan(viejo.getTime());
  });
});
