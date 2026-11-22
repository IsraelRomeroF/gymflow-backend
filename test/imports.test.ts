import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7, normalizedNameKey } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * IMPORTAR LA BASE DE SOCIOS (docs/09 §3–5). Lo que se prueba es que no se
 * equivoque de persona: lo seguro se une solo, lo dudoso espera a una
 * persona, lo repetido en el archivo no crea dos fichas y volver a importar
 * el mismo archivo no duplica a nadie.
 */
describe('importar socios', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let recepcion: string;
  let otra: string;
  let orgId: string;
  let centro: { id: string; code: string; name: string };
  let norte: { id: string; code: string; name: string };
  let planId: string;
  // El día del GIMNASIO (CDMX), no el de UTC: de noche ya es mañana en UTC.
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const enUnMes = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  // Un socio que ya existe en GymFlow, para que el archivo lo encuentre.
  const existente = { first: nombreUnico('Ana'), last: nombreUnico('Lopez'), phone: telefonoUnico(), id: '' };
  // Una "hija" con el mismo celular y otro nombre: NO se une sola.
  const familiar = nombreUnico('Sofia');
  const nuevo = { first: nombreUnico('Beto'), last: nombreUnico('Ruiz'), phone: telefonoUnico() };
  const repetido = { first: nombreUnico('Caro'), last: nombreUnico('Diaz'), phone: telefonoUnico() };
  const codigo = (s: string) => `${s}-${Math.floor(Math.random() * 1e6)}`;
  const codNuevo = codigo('N');
  const codRepetido = codigo('R');

  const archivo = () => [
    { rowNumber: 2, raw: {}, fields: { legacyCode: codNuevo, fullName: `${nuevo.first} ${nuevo.last}`, phone: nuevo.phone.slice(3), balance: '$650.00', periodEnd: enUnMes, plan: 'MENSUAL', branch: 'Centro', joinedAt: '15/03/2021' } },
    { rowNumber: 3, raw: {}, fields: { firstName: existente.first, lastName: existente.last, phone: existente.phone, email: `${existente.first.toLowerCase()}@correo.mx`, joinedAt: '01/01/2015', branch: 'Centro' } },
    { rowNumber: 4, raw: {}, fields: { firstName: familiar, lastName: existente.last, phone: existente.phone, branch: 'Centro' } },
    { rowNumber: 5, raw: {}, fields: { legacyCode: codRepetido, firstName: repetido.first, lastName: repetido.last, phone: repetido.phone, balance: '100', branch: 'Norte' } },
    { rowNumber: 6, raw: {}, fields: { firstName: repetido.first, lastName: repetido.last, phone: repetido.phone, balance: '-50', branch: 'Centro', joinedAt: '2019-06-01' } },
    { rowNumber: 7, raw: {}, fields: { phone: '5512345678' } },
  ];

  const subir = (cookie: string, rows = archivo(), branchId = centro.id) => app.inject({
    method: 'POST', url: '/member-imports', headers: { cookie },
    payload: { fileName: 'socios.csv', branchId, cutoffDate: hoy, reason: 'Migración del sistema anterior', rows },
  });
  const filas = async (id: string) => (await app.inject({ method: 'GET', url: `/member-imports/${id}/rows?limit=200`, headers: { cookie: gerencia } })).json().rows as Array<Record<string, any>>;
  const aplicar = async (id: string) => {
    for (let i = 0; i < 20; i++) {
      const r = await app.inject({ method: 'POST', url: `/member-imports/${id}/apply`, headers: { cookie: gerencia }, payload: { reason: 'Corte firmado por el dueño' } });
      expect(r.statusCode, r.body).toBe(200);
      if (r.json().done) return;
    }
    throw new Error('no terminó');
  };

  let importId = '';
  // Las fichas que creó la primera importación: la reimportación debe caer en ellas.
  let nuevoId = '';
  let repetidoId = '';

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    otra = await loginAs(app, 'gerencia@otro.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    centro = f.demoBranches.find((b) => b.code === 'CEN')!;
    norte = f.demoBranches.find((b) => b.code === 'NOR')!;
    const planes = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie: gerencia } })).json();
    planId = planes.find((p: { code: string }) => p.code === 'MEN').id;
    existente.id = (await getDb().member.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberCode: `IMP-${Date.now() % 1e6}`, homeBranchId: centro.id,
        firstName: existente.first, lastName: existente.last, nameKey: normalizedNameKey(`${existente.first} ${existente.last}`),
        phoneE164: existente.phone, joinedAt: new Date('2020-01-01T18:00:00Z'),
      },
    })).id;
  });

  afterAll(async () => { await app.close(); await closeDb(); });

  it('recepción no importa: es de la gerencia', async () => {
    expect((await subir(recepcion)).statusCode).toBe(403);
  });

  it('compara cada fila contra el padrón y contra el propio archivo', async () => {
    const r = await subir(gerencia);
    expect(r.statusCode, r.body).toBe(201);
    importId = r.json().id;
    const rows = await filas(importId);
    const por = (n: number) => rows.find((x) => x.rowNumber === n)!;

    expect(por(2).kind).toBe('NEW');
    expect(por(2).balanceCents).toBe('65000');
    expect(por(2).dataStatus).toBeNull();             // todo se entendió: no espera decisión de datos
    expect(por(3).kind).toBe('MATCH');                  // teléfono y nombre idénticos
    expect(por(3).matchMemberId).toBe(existente.id);
    expect(por(3).decision).toBe('MERGE');
    expect(por(4).kind).toBe('REVIEW');                 // mismo celular, otra persona: decide una persona
    expect(por(4).decision).toBe('PENDING');
    expect(por(6).kind).toBe('FILE_DUP');               // repetida en otra sucursal del archivo
    expect(por(6).matchRowId).toBe(por(5).id);
    expect(por(7).kind).toBe('INVALID');
    expect(por(7).decision).toBe('SKIP');

    const resumen = (await app.inject({ method: 'GET', url: `/member-imports/${importId}`, headers: { cookie: gerencia } })).json();
    expect(resumen.branchMap).toMatchObject({ Centro: centro.id, Norte: norte.id });
    expect(resumen.labels.plans).toEqual([{ label: 'MENSUAL', rows: 1, vigentes: 1 }]);
  });

  it('otro gimnasio no ve la importación', async () => {
    expect((await app.inject({ method: 'GET', url: `/member-imports/${importId}`, headers: { cookie: otra } })).statusCode).toBe(404);
  });

  it('no se aplica mientras quede algo dudoso sin decidir', async () => {
    const r = await app.inject({ method: 'POST', url: `/member-imports/${importId}/apply`, headers: { cookie: gerencia }, payload: { reason: 'Corte firmado' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toMatch(/por revisar/);
  });

  it('lo dudoso no se une en bloque', async () => {
    const r = await app.inject({ method: 'POST', url: `/member-imports/${importId}/decide-all`, headers: { cookie: gerencia }, payload: { kind: 'REVIEW', decision: 'MERGE' } });
    expect(r.statusCode).toBe(422);
  });

  it('aplica: crea, completa, suma saldos, guarda códigos y carga la vigencia', async () => {
    const rows = await filas(importId);
    const familia = rows.find((x) => x.rowNumber === 4)!;
    // "Son distintas": la hija se da de alta aparte.
    expect((await app.inject({ method: 'PUT', url: `/member-imports/${importId}/rows/${familia.id}`, headers: { cookie: gerencia }, payload: { decision: 'CREATE' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: `/member-imports/${importId}/maps`, headers: { cookie: gerencia }, payload: { planMap: { MENSUAL: planId } } })).statusCode).toBe(200);
    await aplicar(importId);

    const fin = await filas(importId);
    const por = (n: number) => fin.find((x) => x.rowNumber === n)!;
    const db = getDb();

    // Nuevo: ficha, código anterior, saldo inicial y membresía activa hasta su vigencia.
    nuevoId = por(2).appliedMemberId as string;
    const ficha = await db.member.findUniqueOrThrow({ where: { id: nuevoId } });
    expect(ficha.joinedAt.toISOString().slice(0, 10)).toBe('2021-03-15');
    expect(ficha.homeBranchId).toBe(centro.id);
    const saldo = await db.charge.findFirstOrThrow({ where: { memberId: nuevoId, chargeType: 'OPENING_BALANCE' } });
    expect(saldo.amountCents).toBe(65000n);
    const m = await db.membership.findFirstOrThrow({ where: { memberId: nuevoId } });
    expect(m.status).toBe('ACTIVE');
    // Precio pactado (16-04): el de la mensualidad en su sucursal al importar, como una venta.
    expect(m.agreedPriceCents).toBe(65000n);
    expect(por(2).balanceLoadedCents).toBe('65000');
    // La noche siguiente (DM-01): el job no vuelve a cobrar el periodo importado ni suspende al socio.
    const { generateCycleCharges, markOverdueCharges, markMembershipsPastDue } = await import('../src/modules/billing/billing.jobs.js');
    const { suspendExpiredGrace } = await import('../src/modules/memberships/membership.jobs.js');
    for (const job of [generateCycleCharges, markOverdueCharges, markMembershipsPastDue, suspendExpiredGrace]) await job(orgId);
    const cuotas = await db.charge.findMany({ where: { membershipId: m.id, chargeType: 'MEMBERSHIP_PERIOD' } });
    expect(cuotas).toHaveLength(1);
    expect(cuotas[0]!.amountCents - cuotas[0]!.adjustedCents).toBe(0n);
    expect(cuotas[0]!.status).not.toBe('OVERDUE');
    expect((await db.membership.findUniqueOrThrow({ where: { id: m.id } })).status).toBe('ACTIVE');
    expect(m.currentPeriodEnd.toISOString().slice(0, 10)).toBe(new Date(new Date(`${enUnMes}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10));

    // Existente: se completó el correo y conserva la antigüedad más vieja; no se creó otra ficha.
    expect(por(3).appliedMemberId).toBe(existente.id);
    const ex = await db.member.findUniqueOrThrow({ where: { id: existente.id } });
    expect(ex.email).toBe(`${existente.first.toLowerCase()}@correo.mx`);
    expect(ex.joinedAt.toISOString().slice(0, 10)).toBe('2015-01-01');
    expect(ex.phoneE164).toBe(existente.phone);

    // Familiar: ficha aparte; el celular se queda con quien ya lo tenía y a ella se le anota.
    expect(por(4).appliedMemberId).not.toBe(existente.id);
    expect(por(4).applyNote).toMatch(/celular ya es de otro socio/);
    expect((await db.member.findUniqueOrThrow({ where: { id: por(4).appliedMemberId as string } })).notes).toContain(existente.phone);

    // Repetida: UNA ficha con los dos saldos (debe 100, a favor 50) y la antigüedad más vieja.
    expect(por(6).appliedMemberId).toBe(por(5).appliedMemberId);
    const rep = por(5).appliedMemberId as string;
    repetidoId = rep;
    expect((await db.charge.findMany({ where: { memberId: rep, chargeType: 'OPENING_BALANCE' } })).map((c) => c.amountCents)).toEqual([10000n]);
    expect((await db.payment.findMany({ where: { memberId: rep, method: 'CREDIT_NOTE' } })).map((p) => p.amountCents)).toEqual([5000n]);
    expect((await db.member.findUniqueOrThrow({ where: { id: rep } })).joinedAt.toISOString().slice(0, 10)).toBe('2019-06-01');
    expect(await db.member.count({ where: { organizationId: orgId, nameKey: normalizedNameKey(`${repetido.first} ${repetido.last}`) } })).toBe(1);

    // La inválida no se importó.
    expect(por(7).appliedMemberId).toBeNull();

    // El código del sistema anterior encuentra al socio desde recepción.
    const busca = (await app.inject({ method: 'GET', url: `/members/search?q=${encodeURIComponent(codNuevo)}`, headers: { cookie: recepcion } })).json();
    expect(busca.results.map((x: { id: string }) => x.id)).toContain(nuevoId);

    const resumen = (await app.inject({ method: 'GET', url: `/member-imports/${importId}`, headers: { cookie: gerencia } })).json();
    expect(resumen.status).toBe('APPLIED');
  });

  it('volver a importar el mismo archivo y APLICARLO no duplica a nadie ni vuelve a cargar saldos (18-01)', async () => {
    const r = await subir(gerencia);
    const reId = r.json().id as string;
    const rows = await filas(reId);
    expect(rows.find((x) => x.rowNumber === 2)!.kind).toBe('MATCH');
    expect(rows.find((x) => x.rowNumber === 2)!.matchReason).toMatch(/Mismo código/);
    expect(rows.find((x) => x.rowNumber === 5)!.kind).toBe('MATCH');
    // La revisión ya avisa que esos saldos no se vuelven a cargar.
    for (const n of [2, 5, 6]) expect(rows.find((x) => x.rowNumber === n)!.openingNote).toMatch(/Ya tiene su saldo inicial de .+: no se vuelve a cargar/);
    // Lo que quede dudoso se decide como cualquier importación; aquí se omite.
    for (const f of rows.filter((x) => x.decision === 'PENDING')) {
      expect((await app.inject({ method: 'PUT', url: `/member-imports/${reId}/rows/${f.id}`, headers: { cookie: gerencia }, payload: { decision: 'SKIP' } })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'PUT', url: `/member-imports/${reId}/maps`, headers: { cookie: gerencia }, payload: { planMap: { MENSUAL: planId } } })).statusCode).toBe(200);
    await aplicar(reId);

    const fin = await filas(reId);
    const por = (n: number) => fin.find((x) => x.rowNumber === n)!;
    const db = getDb();
    // Cayó en las mismas fichas…
    expect(por(2).appliedMemberId).toBe(nuevoId);
    expect(por(5).appliedMemberId).toBe(repetidoId);
    expect(por(6).appliedMemberId).toBe(repetidoId);
    // …y ningún saldo se volvió a cargar: uno por registro del sistema anterior.
    expect((await db.charge.findMany({ where: { memberId: nuevoId, chargeType: 'OPENING_BALANCE' } })).map((c) => c.amountCents)).toEqual([65000n]);
    expect((await db.charge.findMany({ where: { memberId: repetidoId, chargeType: 'OPENING_BALANCE' } })).map((c) => c.amountCents)).toEqual([10000n]);
    expect((await db.payment.findMany({ where: { memberId: repetidoId, method: 'CREDIT_NOTE' } })).map((p) => p.amountCents)).toEqual([5000n]);
    expect(por(2).balanceLoadedCents).toBeNull();
    expect(por(2).applyNote).toMatch(/Ya tenía su saldo inicial de \$650\.00 \(importación del .+\): no se volvió a cargar/);
    expect(por(5).applyNote).toMatch(/Ya tenía su saldo inicial de \$100\.00/);
    expect(por(6).applyNote).toMatch(/\$50\.00 a favor/);
    expect(por(2).applyNote).toMatch(/Ya tenía una membresía vigente/);
    expect(await db.membership.count({ where: { memberId: nuevoId } })).toBe(1);
    const resumen = (await app.inject({ method: 'GET', url: `/member-imports/${reId}`, headers: { cookie: gerencia } })).json();
    expect(resumen).toMatchObject({ status: 'APPLIED', balancesLoaded: 0, balancesNotReloaded: 3 });
  });

  it('una aplicada ya no se toca', async () => {
    const r = await app.inject({ method: 'POST', url: `/member-imports/${importId}/cancel`, headers: { cookie: gerencia }, payload: { reason: 'Prueba' } });
    expect(r.statusCode).toBe(409);
  });
});
