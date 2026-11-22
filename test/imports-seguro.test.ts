import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7, normalizedNameKey } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, sedeDesechable, archivarSede } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * IMPORTACIÓN SEGURA ANTES DE MIGRAR EL PADRÓN REAL (Auditoría 8, bloque
 * 0.11). Lo que se prueba es que el cambio de sistema no invente ni pierda
 * dinero ni membresías en silencio:
 *   · 18-01: un saldo inicial por socio y por registro del sistema anterior;
 *     reimportar el archivo corregido nunca mueve dinero dos veces.
 *   · 18-02: un saldo, una vigencia o una fecha de alta que no se entienden
 *     esperan a una persona: sin ese dato, corregido u omitido.
 *   · 18-03: cada plan del archivo con vigencias exige una decisión.
 *   · 16-04: la vigencia importada guarda su precio pactado.
 */
describe('importación segura', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let orgId: string;
  let centro: { id: string };
  let planId: string;
  const db = () => getDb();
  const enUnMes = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

  type Fila = { rowNumber: number; raw: Record<string, unknown>; fields: Record<string, string | number | null> };
  const persona = () => {
    const first = nombreUnico('Ana');
    const last = nombreUnico('Paz');
    return { first, last, nombre: `${first} ${last}`, tel: telefonoUnico() };
  };
  const subir = async (rows: Fila[], fileName = 'socios.csv') => {
    const r = await app.inject({
      method: 'POST', url: '/member-imports', headers: { cookie: gerencia },
      payload: { fileName, branchId: centro.id, cutoffDate: hoy, reason: 'Migración del sistema anterior', rows },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  const filas = async (id: string, query = '') =>
    (await app.inject({ method: 'GET', url: `/member-imports/${id}/rows?limit=200${query}`, headers: { cookie: gerencia } })).json().rows as Array<Record<string, any>>;
  const detalle = async (id: string) => (await app.inject({ method: 'GET', url: `/member-imports/${id}`, headers: { cookie: gerencia } })).json();
  const decidir = (id: string, rowId: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/member-imports/${id}/rows/${rowId}`, headers: { cookie: gerencia }, payload });
  const planes = (id: string, planMap: Record<string, string | null>) =>
    app.inject({ method: 'PUT', url: `/member-imports/${id}/maps`, headers: { cookie: gerencia }, payload: { planMap } });
  const aplicarUnaVez = (id: string) =>
    app.inject({ method: 'POST', url: `/member-imports/${id}/apply`, headers: { cookie: gerencia }, payload: { reason: 'Corte firmado por el dueño' } });
  const aplicar = async (id: string) => {
    for (let i = 0; i < 20; i++) {
      const r = await aplicarUnaVez(id);
      expect(r.statusCode, r.body).toBe(200);
      if (r.json().done) return;
    }
    throw new Error('no terminó');
  };
  const socioDe = async (p: { first: string; last: string }) =>
    db().member.findFirstOrThrow({ where: { organizationId: orgId, nameKey: normalizedNameKey(`${p.first} ${p.last}`) } });
  const saldosIniciales = async (memberId: string) =>
    (await db().charge.findMany({ where: { memberId, chargeType: 'OPENING_BALANCE' }, orderBy: { createdAt: 'asc' } })).map((c) => c.amountCents);

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    centro = f.demoBranches.find((b) => b.code === 'CEN')!;
    const lista = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie: gerencia } })).json();
    planId = lista.find((p: { code: string }) => p.code === 'MEN').id;
  });

  afterAll(async () => { await app.close(); await closeDb(); });

  it('saldo, vigencia o fecha de alta ilegibles esperan a una persona y bloquean aplicar (18-02)', async () => {
    const [a, b, c, d] = [persona(), persona(), persona(), persona()];
    const id = await subir([
      { rowNumber: 2, raw: {}, fields: { fullName: a.nombre, phone: a.tel, balance: 'mil pesos' } },
      { rowNumber: 3, raw: {}, fields: { fullName: b.nombre, phone: b.tel, periodEnd: '31/02/2027', plan: 'MENSUAL' } },
      { rowNumber: 4, raw: {}, fields: { fullName: c.nombre, phone: c.tel, joinedAt: 'ayer', balance: '$300' } },
      // Un teléfono ilegible no detiene la fila: solo queda la nota.
      { rowNumber: 5, raw: {}, fields: { fullName: d.nombre, phone: '55 1234', balance: '200' } },
    ]);
    const rows = await filas(id);
    const por = (n: number) => rows.find((x) => x.rowNumber === n)!;
    expect(por(2)).toMatchObject({ kind: 'NEW', decision: 'CREATE', dataStatus: 'PENDING', balanceCents: null });
    expect(por(2).doubtful).toEqual([{ field: 'balance', value: 'mil pesos', problem: 'Saldo no se entiende: mil pesos' }]);
    expect(por(3).doubtful.map((x: { field: string }) => x.field)).toEqual(['periodEnd']);
    expect(por(4)).toMatchObject({ dataStatus: 'PENDING', balanceCents: '30000' });
    expect(por(5).dataStatus).toBeNull();
    expect(por(5).problems.some((p: string) => p.startsWith('Teléfono no válido'))).toBe(true);

    const antes = await detalle(id);
    expect(antes.dataPending).toBe(3);
    expect(antes.blockers).toEqual(['Faltan 3 filas con datos dudosos por decidir']);
    const r = await aplicarUnaVez(id);
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toMatch(/datos dudosos/);
    expect((await filas(id, '&data=PENDING')).map((x) => x.rowNumber)).toEqual([2, 3, 4]);

    // Solo se decide lo que no se entendió, y cada decisión con sentido.
    expect((await decidir(id, por(5).id, { data: 'WITHOUT' })).statusCode).toBe(422);
    expect((await decidir(id, por(2).id, { data: 'FIXED', fix: { periodEnd: '2027-01-01' } })).statusCode).toBe(422);
    expect((await decidir(id, por(2).id, { data: 'WITHOUT', fix: { balanceCents: '100' } })).statusCode).toBe(422);
    expect((await decidir(id, por(2).id, { data: 'FIXED', fix: { balanceCents: '650.00' } })).statusCode).toBe(422);
    expect((await decidir(id, por(4).id, { data: 'FIXED', fix: { joinedAt: '2099-01-01' } })).statusCode).toBe(422);

    const corregida = await decidir(id, por(2).id, { data: 'FIXED', fix: { balanceCents: '65000' } });
    expect(corregida.statusCode, corregida.body).toBe(200);
    expect(corregida.json()).toMatchObject({ dataStatus: 'FIXED', balanceCents: '65000' });
    expect((await decidir(id, por(3).id, { data: 'WITHOUT' })).json()).toMatchObject({ dataStatus: 'WITHOUT', periodEnd: null });
    expect((await decidir(id, por(4).id, { data: 'FIXED', fix: { joinedAt: '2019-05-01' } })).json()).toMatchObject({ joinedAt: '2019-05-01' });
    // Cambiar de opinión: «sin ese dato» borra la corrección; volver a corregir la repone.
    expect((await decidir(id, por(4).id, { data: 'WITHOUT' })).json()).toMatchObject({ dataStatus: 'WITHOUT', joinedAt: null, balanceCents: '30000' });
    expect((await decidir(id, por(4).id, { data: 'FIXED', fix: { joinedAt: '2019-05-01' } })).json()).toMatchObject({ dataStatus: 'FIXED', joinedAt: '2019-05-01' });

    const listo = await detalle(id);
    expect(listo).toMatchObject({ dataPending: 0, blockers: [], byData: { FIXED: 2, WITHOUT: 1 } });
    await aplicar(id);

    const fin = await filas(id);
    const f = (n: number) => fin.find((x) => x.rowNumber === n)!;
    const sa = await socioDe(a);
    expect(await saldosIniciales(sa.id)).toEqual([65000n]);
    expect(f(2).applyNote).toMatch(/Se corrigió a mano: saldo/);
    const sb = await socioDe(b);
    expect(await db().membership.count({ where: { memberId: sb.id } })).toBe(0);
    expect(f(3).applyNote).toMatch(/Entró sin: vigencia/);
    const sc = await socioDe(c);
    expect(sc.joinedAt.toISOString().slice(0, 10)).toBe('2019-05-01');
    expect(await saldosIniciales(sc.id)).toEqual([30000n]);
    const sd = await socioDe(d);
    expect(sd.phoneE164).toBeNull();
    expect(await saldosIniciales(sd.id)).toEqual([20000n]);
    // Ya aplicada, una fila no se vuelve a decidir.
    expect((await decidir(id, f(3).id, { data: 'WITHOUT' })).statusCode).toBe(409);
  });

  it('cada plan del archivo con vigencias exige una decisión, también las vigencias que vienen sin plan (18-03)', async () => {
    const [e, f, g] = [persona(), persona(), persona()];
    const etiqueta = `ANUAL ${nombreUnico('')}`;
    const id = await subir([
      { rowNumber: 2, raw: {}, fields: { fullName: e.nombre, phone: e.tel, plan: etiqueta, periodEnd: enUnMes } },
      { rowNumber: 3, raw: {}, fields: { fullName: f.nombre, phone: f.tel, periodEnd: enUnMes } },
      { rowNumber: 4, raw: {}, fields: { fullName: g.nombre, phone: g.tel, plan: etiqueta } },
    ]);
    const d = await detalle(id);
    expect(d.labels.plans).toEqual([{ label: etiqueta, rows: 2, vigentes: 1 }, { label: '', rows: 1, vigentes: 1 }]);
    expect(d.blockers).toEqual([`Falta decidir qué plan de GymFlow corresponde a: ${etiqueta} (1 con vigencia), Sin plan en el archivo (1 con vigencia)`]);
    let r = await aplicarUnaVez(id);
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toMatch(/Falta decidir qué plan/);

    // Decidir uno no basta: las vigencias sin plan también se deciden.
    expect((await planes(id, { [etiqueta]: planId })).statusCode).toBe(200);
    r = await aplicarUnaVez(id);
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toMatch(/Sin plan en el archivo/);
    expect(r.json().message).not.toContain(etiqueta);

    // «No cargar su vigencia» es una decisión explícita (null), no un hueco.
    expect((await planes(id, { [etiqueta]: planId, '': null })).statusCode).toBe(200);
    expect((await detalle(id)).blockers).toEqual([]);
    await aplicar(id);

    const se = await socioDe(e);
    const m = await db().membership.findFirstOrThrow({ where: { memberId: se.id } });
    expect(m.planId).toBe(planId);
    const sf = await socioDe(f);
    expect(await db().membership.count({ where: { memberId: sf.id } })).toBe(0);
    const fin = await filas(id);
    expect(fin.find((x) => x.rowNumber === 3)!.applyNote).toMatch(/se decidió no cargar las vigencias sin plan/);
  });

  it('la vigencia importada guarda su precio pactado de la sucursal y renueva aunque la sede deje de venderlo (16-04)', async () => {
    // Datos propios: una sede con nombre único y su precio propio de la mensualidad. No depende de cómo
    // otras pruebas dejaron la Frontera de la semilla (en la base integrada se llama «Otra»).
    const nombreSede = `Sede ${nombreUnico('Precio')}`;
    const sede = await sedeDesechable(orgId, nombreSede);
    const precioSede = 72_300n;
    await db().planBranchAvailability.create({ data: { planId, branchId: sede.id, organizationId: orgId, isAvailable: true, priceOverrideCents: precioSede } });
    try {
      const h = persona();
      const id = await subir([{ rowNumber: 2, raw: {}, fields: { fullName: h.nombre, phone: h.tel, branch: nombreSede, plan: 'MENSUAL', periodEnd: enUnMes } }]);
      // La sucursal del archivo se reconoce por su nombre exacto.
      expect((await detalle(id)).branchMap).toEqual({ [nombreSede]: sede.id });
      expect((await planes(id, { MENSUAL: planId })).statusCode).toBe(200);
      await aplicar(id);

      const socio = await socioDe(h);
      const m = await db().membership.findFirstOrThrow({ where: { memberId: socio.id } });
      expect(m.soldAtBranchId).toBe(sede.id);
      expect(m.agreedPriceCents).toBe(precioSede);
      const cuota = await db().charge.findFirstOrThrow({ where: { membershipId: m.id, chargeType: 'MEMBERSHIP_PERIOD' } });
      expect(cuota.amountCents).toBe(precioSede);
      expect(cuota.amountCents - cuota.adjustedCents).toBe(0n);

      // La sede deja de vender la mensualidad: la cuota de quien ya la tiene sale con su precio pactado, no con un 409.
      await db().planBranchAvailability.update({ where: { planId_branchId: { planId, branchId: sede.id } }, data: { isAvailable: false } });
      const r = await app.inject({ method: 'POST', url: `/memberships/${m.id}/period-charge`, headers: { cookie: gerencia } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().created).toBe(false);
    } finally {
      await archivarSede(sede.id);
    }
  });

  it('dos «Aplicar» al mismo tiempo no duplican fichas ni saldos', async () => {
    const ps = [persona(), persona(), persona()];
    const id = await subir(ps.map((p, i) => ({ rowNumber: i + 2, raw: {}, fields: { fullName: p.nombre, phone: p.tel, balance: ['100', '200', '-300'][i]! } })));
    const [r1, r2] = await Promise.all([aplicarUnaVez(id), aplicarUnaVez(id)]);
    // El segundo espera a que el primero confirme cada fila; si llega tarde, la importación ya está cerrada.
    expect([200, 409]).toContain(r1.statusCode);
    expect([200, 409]).toContain(r2.statusCode);
    expect((await detalle(id)).status).toBe('APPLIED');
    for (const p of ps) {
      expect(await db().member.count({ where: { organizationId: orgId, nameKey: normalizedNameKey(`${p.first} ${p.last}`) } })).toBe(1);
    }
    expect(await saldosIniciales((await socioDe(ps[0]!)).id)).toEqual([10000n]);
    expect(await saldosIniciales((await socioDe(ps[1]!)).id)).toEqual([20000n]);
    expect((await db().payment.findMany({ where: { memberId: (await socioDe(ps[2]!)).id, method: 'CREDIT_NOTE' } })).map((p) => p.amountCents)).toEqual([30000n]);
    expect(await db().auditLog.count({ where: { organizationId: orgId, action: 'members.import.apply', resourceId: id } })).toBe(1);
  });

  it('un saldo inicial capturado a mano en GymFlow no se duplica con el del archivo', async () => {
    const k = persona();
    const socio = await db().member.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberCode: `IMS-${Date.now() % 1e6}`, homeBranchId: centro.id,
        firstName: k.first, lastName: k.last, nameKey: normalizedNameKey(k.nombre), phoneE164: k.tel, joinedAt: new Date('2024-01-01T18:00:00Z'),
      },
    });
    await db().charge.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberId: socio.id, branchId: centro.id, chargeType: 'OPENING_BALANCE',
        concept: 'Saldo capturado en el mostrador', subtotalCents: 40000n, amountCents: 40000n, dueDate: new Date(`${hoy}T00:00:00Z`),
      },
    });
    const id = await subir([{ rowNumber: 2, raw: {}, fields: { firstName: k.first, lastName: k.last, phone: k.tel, balance: '650' } }]);
    const [fila] = await filas(id);
    expect(fila!.kind).toBe('MATCH');
    await aplicar(id);
    expect(await saldosIniciales(socio.id)).toEqual([40000n]);
    const [fin] = await filas(id);
    expect(fin!.balanceLoadedCents).toBeNull();
    expect(fin!.applyNote).toMatch(/Ya tiene un saldo inicial capturado en GymFlow \(\$400\.00\): no se cargó el del archivo \(\$650\.00\)/);
  });

  it('el mismo código dos veces en el archivo es un solo registro: su saldo entra una vez', async () => {
    const p = persona();
    const codigo = `D-${Math.floor(Math.random() * 1e6)}`;
    const fila = (rowNumber: number) => ({ rowNumber, raw: {}, fields: { fullName: p.nombre, phone: p.tel, legacyCode: codigo, branch: 'Centro', balance: '100' } });
    const id = await subir([fila(2), fila(3)]);
    const rows = await filas(id);
    expect(rows[1]!.kind).toBe('FILE_DUP');
    expect(rows[1]!.openingNote).toMatch(/El renglón 2 ya trae el saldo de este registro/);
    await aplicar(id);
    expect(await saldosIniciales((await socioDe(p)).id)).toEqual([10000n]);
    expect((await filas(id))[1]!.applyNote).toMatch(/Ya tenía su saldo inicial de \$100\.00 \(renglón 2 de este archivo\): no se volvió a cargar/);
  });

  it('la misma persona importada sucursal por sucursal suma un saldo por sucursal, y reimportar no repite ninguno (§4.4)', async () => {
    const p = persona();
    const sufijo = Math.floor(Math.random() * 1e6);
    const idCentro = await subir([{ rowNumber: 2, raw: {}, fields: { fullName: p.nombre, phone: p.tel, legacyCode: `C-${sufijo}`, branch: 'Centro', balance: '100' } }], 'centro.csv');
    await aplicar(idCentro);
    const norte = [{ rowNumber: 2, raw: {}, fields: { fullName: p.nombre, phone: p.tel, legacyCode: `N-${sufijo}`, branch: 'Norte', balance: '200' } }];
    const idNorte = await subir(norte, 'norte.csv');
    expect((await filas(idNorte))[0]!.kind).toBe('MATCH');
    await aplicar(idNorte);
    const socio = await socioDe(p);
    expect(await saldosIniciales(socio.id)).toEqual([10000n, 20000n]);
    // El archivo de Norte otra vez: se reconoce por su código y no carga nada.
    const idOtraVez = await subir(norte, 'norte.csv');
    await aplicar(idOtraVez);
    expect(await saldosIniciales(socio.id)).toEqual([10000n, 20000n]);
    expect((await filas(idOtraVez))[0]!.applyNote).toMatch(/Ya tenía su saldo inicial de \$200\.00/);
    expect((await db().member.findUniqueOrThrow({ where: { id: socio.id } })).balanceCentsCached).toBe(30000n);
  });
});
