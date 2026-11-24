import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7, normalizedNameKey } from '@gymflow/core';
import { AccessPending, MeHome, diferenciasConElContrato } from '@gymflow/core/contracts';
import { makeApp, loginAs, nombreUnico } from './helpers.js';
import { gimnasioPropio, socioPropio, abrirTurno, sesionesDe, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { ModuleStateRepository } from '../src/platform/modules/module-state.repository.js';
import { forgetModules } from '../src/platform/modules/module-state.js';
import { altaSinCobro } from './membresia-de-prueba.js';

/**
 * EL INICIO COMO BANDEJA (auditoría 8, bloque 2.1; 1-01, 5-05, 5-12).
 *
 * - `GET /access/pending`: los rechazos de hoy sin resolver, uno por socio y
 *   sede, y dejan de estar cuando se resuelven.
 * - `GET /me/home`: «Hoy te toca». Cada asunto solo para quien lo puede
 *   resolver, con su módulo encendido, y sin renglones en cero.
 *
 * Gimnasio propio: las cuentas dependen de que nadie más deje rechazos, cajas
 * o firmas en el mismo gimnasio.
 */
describe('el inicio como bandeja (2.1)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let s: { owner: string; gerente: string; gerente2: string; recepcion: string };

  type Renglon = MeHome['items'][number];
  const home = async (cookie: string): Promise<MeHome> => {
    const r = await app.inject({ method: 'GET', url: '/me/home', headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(MeHome, r.json())).toEqual([]);
    return r.json() as MeHome;
  };
  const renglon = async (cookie: string, key: Renglon['key']): Promise<Renglon | undefined> => (await home(cookie)).items.find((i) => i.key === key);
  const pendientes = async (cookie: string, consulta = ''): Promise<AccessPending> => {
    const r = await app.inject({ method: 'GET', url: `/access/pending${consulta}`, headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(AccessPending, r.json())).toEqual([]);
    return r.json() as AccessPending;
  };
  const intentar = (memberId: string, sede = g.sedes[0]!.id) => app.inject({
    method: 'POST', url: '/access/attempts', headers: { cookie: s.gerente }, payload: { branchId: sede, memberId, credentialKind: 'MANUAL' },
  });

  /** Un socio con su membresía suspendida: la puerta lo rechaza y el mostrador SÍ puede levantarlo. */
  async function suspendido(finDelPeriodo = new Date(Date.now() + 10 * 86_400_000), sede = g.sedes[0]!): Promise<string> {
    const memberId = await socioPropio(g, sede);
    const mem = await altaSinCobro(app, s.gerente, memberId, { reason: 'Fixture de la bandeja', planId: g.planMensual, soldAtBranchId: sede.id });
    expect(mem.statusCode, mem.body).toBe(201);
    const inicio = new Date(finDelPeriodo.getTime() - 30 * 86_400_000);
    await getDb().membership.update({ where: { id: mem.json().id }, data: { status: 'SUSPENDED', currentPeriodStart: inicio, currentPeriodEnd: finDelPeriodo } });
    return memberId;
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Sede uno', cajas: 1 }, { name: 'Sede dos', cajas: 1 }] });
    s = await sesionesDe(app, g);
  });

  afterAll(async () => {
    await g.cerrar();
    await app.close();
    await closeDb();
  });

  it('las dos rutas piden sesión', async () => {
    expect((await app.inject({ method: 'GET', url: '/me/home' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/access/pending' })).statusCode).toBe(401);
  });

  it('sin nada pendiente no viaja ningún renglón en cero, y los asuntos van en su orden', async () => {
    const h = await home(s.gerente);
    expect(h.unchecked).toEqual([]);
    for (const i of h.items) expect(i.count).toBeGreaterThan(0);
    expect(h.items.find((i) => i.key === 'door')).toBeUndefined();
    expect(h.items.find((i) => i.key === 'registers')).toBeUndefined();
    expect(h.items.find((i) => i.key === 'signatures')).toBeUndefined();
  });

  describe('por resolver en la puerta', () => {
    let socio: string;
    let decision: string;

    it('un rechazo queda pendiente, con el nombre y el motivo', async () => {
      socio = await suspendido();
      const r = await intentar(socio);
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().outcome).toBe('DENIED');
      decision = r.json().decisionId as string;

      const p = await pendientes(s.recepcion);
      expect(p.total).toBe(1);
      expect(p.pending[0]).toMatchObject({ decisionId: decision, memberId: socio, branchId: g.sedes[0]!.id, attempts: 1, reason: r.json().reason });
      expect(p.pending[0]!.memberName.length).toBeGreaterThan(3);
    });

    it('dos rechazos del mismo socio son UN pendiente: el último, con «2 intentos»', async () => {
      const otro = await intentar(socio);
      expect(otro.json().outcome).toBe('DENIED');
      const p = await pendientes(s.recepcion);
      expect(p.total).toBe(1);
      expect(p.pending[0]).toMatchObject({ memberId: socio, attempts: 2, decisionId: otro.json().decisionId });
      decision = otro.json().decisionId as string;
    });

    it('la bandeja lo cuenta para recepción y para la gerencia, con la misma cifra que la lista', async () => {
      expect(await renglon(s.recepcion, 'door')).toMatchObject({ count: 1, tone: 'danger' });
      expect(await renglon(s.gerente, 'door')).toMatchObject({ count: 1 });
    });

    it('recepción no ve los pendientes de una sede que no es suya', async () => {
      const ajeno = await socioPropio(g, g.sedes[1]!);
      expect((await intentar(ajeno, g.sedes[1]!.id)).json().outcome).toBe('DENIED');
      expect((await pendientes(s.recepcion)).total).toBe(1);
      expect((await pendientes(s.gerente)).total).toBe(2);
      expect((await pendientes(s.gerente, `?branchId=${g.sedes[1]!.id}`)).total).toBe(1);
      const r = await app.inject({ method: 'GET', url: `/access/pending?branchId=${g.sedes[1]!.id}`, headers: { cookie: s.recepcion } });
      expect(r.statusCode).toBe(403);
    });

    it('el gerente de otro gimnasio no ve nada de este', async () => {
      const demo = await loginAs(app, 'gerencia@demo.mx');
      const p = await pendientes(demo);
      expect(p.pending.some((x) => x.memberId === socio)).toBe(false);
    });

    it('al resolverlo (paso concedido) deja de estar pendiente', async () => {
      const r = await app.inject({
        method: 'POST', url: `/access/decisions/${decision}/grant`, headers: { cookie: s.gerente }, payload: { reason: 'Prueba de la bandeja del inicio' },
      });
      expect(r.statusCode, r.body).toBe(201);
      const p = await pendientes(s.recepcion);
      expect(p.total).toBe(0);
      expect(await renglon(s.recepcion, 'door')).toBeUndefined();
    });
  });

  it('una caja abierta desde un día anterior aparece con su nombre; la de hoy, no', async () => {
    const turno = await abrirTurno(app, s.recepcion, g.sedes[0]!.cajas[0]!);
    expect(await renglon(s.gerente, 'registers')).toBeUndefined();
    const ayer = new Date(Date.now() - 2 * 86_400_000);
    await getDb().cashSession.update({ where: { id: turno }, data: { businessDate: ayer, openedAt: ayer } });
    const r = await renglon(s.gerente, 'registers');
    expect(r).toMatchObject({ count: 1, tone: 'warn' });
    expect(r!.detail[0]).toContain('Caja 1');
    expect(r!.detail[0]).toContain('Sede uno');
  });

  it('las firmas que YO pedí y siguen esperando: solo a quien las pidió, con su vencimiento', async () => {
    const gerente = await getDb().user.findFirstOrThrow({ where: { email: g.correos.gerente } });
    const vence = new Date(Date.now() + 8 * 60_000);
    await getDb().approvalRequest.create({
      data: { id: uuidv7(), organizationId: g.organizationId, requestedByUserId: gerente.id, permission: 'payments:refund', summary: 'Prueba de la bandeja', status: 'PENDING', expiresAt: vence },
    });
    // Una vencida no cuenta.
    await getDb().approvalRequest.create({
      data: { id: uuidv7(), organizationId: g.organizationId, requestedByUserId: gerente.id, permission: 'payments:refund', summary: 'Vencida', status: 'PENDING', expiresAt: new Date(Date.now() - 60_000) },
    });
    const r = await renglon(s.gerente, 'signatures');
    expect(r).toMatchObject({ count: 1, tone: 'danger', until: vence.toISOString() });
    expect(await renglon(s.gerente2, 'signatures')).toBeUndefined();
    expect(await renglon(s.recepcion, 'signatures')).toBeUndefined();
    // Va primero: es lo que detiene al mostrador.
    expect((await home(s.gerente)).items[0]!.key).toBe('signatures');
  });

  it('suspendidas por decidir: solo las que ya pasaron su periodo', async () => {
    const antes = (await renglon(s.gerente, 'debts'))?.count ?? 0;
    const nueva = (fin: Date) => suspendido(fin);
    await nueva(new Date(Date.now() + 10 * 86_400_000));
    expect((await renglon(s.gerente, 'debts'))?.count ?? 0).toBe(antes);
    await nueva(new Date(Date.now() - 10 * 86_400_000));
    expect(await renglon(s.gerente, 'debts')).toMatchObject({ count: antes + 1, tone: 'warn' });
  });

  it('interesados por atender: con un contacto y próximo paso a futuro dejan de contar, y con el módulo apagado el renglón no existe', async () => {
    const db = getDb();
    const nombre = nombreUnico('Interesado'); const apellido = nombreUnico('Bandeja');
    const id = uuidv7();
    await db.prospect.create({
      data: { id, organizationId: g.organizationId, branchId: g.sedes[0]!.id, firstName: nombre, lastName: apellido, nameKey: normalizedNameKey(`${nombre} ${apellido}`), status: 'NEW' },
    });
    expect(await renglon(s.gerente, 'prospects')).toMatchObject({ count: 1, tone: 'info' });
    expect(await renglon(s.recepcion, 'prospects')).toMatchObject({ count: 1 });

    const estado = new ModuleStateRepository(g.organizationId);
    await estado.set('prospects', false, null, null); forgetModules(g.organizationId);
    expect(await renglon(s.gerente, 'prospects')).toBeUndefined();
    await estado.set('prospects', true, null, null); forgetModules(g.organizationId);

    const gerente = await db.user.findFirstOrThrow({ where: { email: g.correos.gerente } });
    await db.followUp.create({
      data: { id: uuidv7(), organizationId: g.organizationId, branchId: g.sedes[0]!.id, prospectId: id, channel: 'CALL', outcome: 'ANSWERED', createdByUserId: gerente.id },
    });
    // La cuenta es la de la bandeja de interesados (2.4): contactado y con próximo paso a futuro ya no toca hoy.
    await db.prospect.update({ where: { id }, data: { status: 'CONTACTED', lastContactAt: new Date(), dueOn: new Date(Date.now() + 5 * 86_400_000) } });
    expect(await renglon(s.gerente, 'prospects')).toBeUndefined();
  });

  it('a cada quien solo lo que puede resolver: recepción no recibe textos ni firmas ajenas; la dueña no recibe la puerta', async () => {
    const deRecepcion = await home(s.recepcion);
    expect(deRecepcion.items.some((i) => i.key === 'texts')).toBe(false);
    expect(deRecepcion.items.some((i) => i.key === 'signatures')).toBe(false);
    // Deja un rechazo sin resolver: la gerencia lo ve; la dueña, que no opera la puerta, no.
    const socio = await socioPropio(g);
    expect((await intentar(socio)).json().outcome).toBe('DENIED');
    expect(await renglon(s.gerente, 'door')).toBeDefined();
    const deLaDuena = await app.inject({ method: 'GET', url: '/access/pending', headers: { cookie: s.owner } });
    if (deLaDuena.statusCode === 403) expect(await renglon(s.owner, 'door')).toBeUndefined();
  });

  it('un texto obligatorio sin publicar se le dice a quien puede publicarlo, con cuál falta', async () => {
    const r = await renglon(s.gerente, 'texts');
    const publicados = new Set((await getDb().consentDocument.findMany({ where: { organizationId: g.organizationId, status: 'PUBLISHED' }, select: { consentType: true } })).map((d) => d.consentType as string));
    const faltan = ['PRIVACY_NOTICE', 'HOUSE_RULES', 'BIOMETRIC'].filter((t) => !publicados.has(t));
    if (faltan.length === 0) expect(r).toBeUndefined();
    else expect(r).toMatchObject({ count: faltan.length, tone: 'warn', detail: faltan });
  });
});
