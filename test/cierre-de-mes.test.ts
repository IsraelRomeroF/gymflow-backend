import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { diferenciasConElContrato, MonthlyClose, MonthlyCloseList, MonthlyClosePreview } from '@gymflow/core/contracts';
import { makeApp, loginAs, orgFixtures, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { AuditService } from '../src/platform/audit/audit.service.js';
import { mesTerminadoEnTodasLasSedes } from '../src/modules/finance/monthly-close.service.js';
import { masVieja } from '../src/modules/analytics/pulse.service.js';

/** Auditoría 8, bloque 1.9: el cierre de mes dice qué va a pasar, quién cerró y quién firmó, y no deja un mes cerrado sin rastro. */
describe('1.9 · cierre de mes', () => {
  let app: FastifyInstance; let gerencia: string; let owner: string; let recepcion: string; let orgId: string;
  const borrar = (mes: string) => getDb().$executeRaw`DELETE FROM "monthly_closes" WHERE "organizationId" = ${orgId}::uuid AND "month" = ${new Date(`${mes}-01T00:00:00.000Z`)}`;
  const filas = (mes: string) => getDb().monthlyClose.findMany({ where: { organizationId: orgId, month: new Date(`${mes}-01T00:00:00.000Z`) } });
  const previa = (cookie: string, mes: string) => app.inject({ method: 'GET', url: `/reports/monthly-close/preview?month=${mes}`, headers: { cookie } });
  const cerrar = (mes: string, approvalToken?: string) => app.inject({ method: 'POST', url: '/reports/monthly-close', headers: { cookie: gerencia }, payload: { month: mes, reason: 'Cierre contable', note: 'Para el contador', ...(approvalToken ? { approvalToken } : {}) } });

  beforeAll(async () => {
    app = await makeApp(); await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx'); owner = await loginAs(app, 'owner@demo.mx'); recepcion = await loginAs(app, 'recepcion@demo.mx');
    orgId = (await orgFixtures()).demo.id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  it('la vista previa dice qué va a pasar con el contrato del núcleo, y lo que impide cerrar', async () => {
    const mes = '2024-05';
    await borrar(mes);
    const abierta = await previa(gerencia, mes);
    expect(abierta.statusCode, abierta.body).toBe(200);
    expect(diferenciasConElContrato(MonthlyClosePreview, abierta.json())).toEqual([]);
    const p = abierta.json() as MonthlyClosePreview;
    expect(p).toMatchObject({ month: mes, closable: true, blockers: [], closed: null });
    expect(p.totals.profitCents).toMatch(/^-?\d+$/);
    // Hoy en el gimnasio y en cada sucursal abierta, según el servidor.
    expect(p.businessDates.organization).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const sedes = await getDb().branch.count({ where: { organizationId: orgId, isActive: true } });
    expect(p.businessDates.byBranch).toHaveLength(sedes);
    // Un mes de 2024 no tiene renta ni nómina registradas: se avisa, no se impide.
    expect(p.fixedExpensesCount).toBe(0);
    expect(p.warnings.map((w) => w.code)).toContain('NO_FIXED_EXPENSES');

    // El mes en curso todavía no termina.
    const enCurso = await previa(owner, p.businessDates.organization.slice(0, 7));
    expect(diferenciasConElContrato(MonthlyClosePreview, enCurso.json())).toEqual([]);
    expect(enCurso.json()).toMatchObject({ closable: false, blockers: [{ code: 'MONTH_NOT_ENDED', message: 'Solo se cierra un mes que ya terminó' }] });

    expect((await previa(gerencia, '2024-13')).statusCode).toBe(422);
    expect((await previa(gerencia, 'mayo')).statusCode).toBe(422);
    // Son las cifras del negocio: recepción no las ve.
    expect((await previa(recepcion, mes)).statusCode).toBe(403);
  });

  it('al cerrar, la foto trae utilidad y gastos, y la lista dice quién cerró y quién firmó', async () => {
    const mes = '2024-05';
    await borrar(mes);
    const antes = (await previa(gerencia, mes)).json() as MonthlyClosePreview;
    const token = await aprobacion(app, gerencia, 'reports:month:close', 'owner@demo.mx');
    const res = await cerrar(mes, token);
    expect(res.statusCode, res.body).toBe(201);
    expect(diferenciasConElContrato(MonthlyClose, res.json())).toEqual([]);
    const c = res.json() as MonthlyClose;
    // Se congela lo que la vista previa mostró.
    expect(c.totals).toEqual(antes.totals);
    expect(c.byBranch).toEqual(antes.byBranch);
    expect(c.note).toBe('Para el contador');

    const db = getDb();
    const gerente = await db.user.findFirstOrThrow({ where: { email: 'gerencia@demo.mx' } });
    const duena = await db.user.findFirstOrThrow({ where: { email: 'owner@demo.mx' } });
    expect(c).toMatchObject({ closedByUserId: gerente.id, closedByName: gerente.fullName, approvedByUserId: duena.id, approvedByName: duena.fullName });
    // La fila guarda la firma, y su asiento de bitácora dice lo mismo.
    expect((await filas(mes))[0]).toMatchObject({ closedByUserId: gerente.id, approvedByUserId: duena.id });
    const asiento = await db.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'report.month.close', resourceId: c.id } });
    expect(asiento.approvedByUserId).toBe(duena.id);

    const lista = await app.inject({ method: 'GET', url: '/reports/monthly-closes', headers: { cookie: owner } });
    expect(lista.statusCode, lista.body).toBe(200);
    expect(diferenciasConElContrato(MonthlyCloseList, lista.json())).toEqual([]);
    const l = lista.json() as MonthlyCloseList;
    expect(l.closes.find((x) => x.month === mes)).toEqual(c);
    // Del más reciente al más viejo.
    expect(l.closes.map((x) => x.month)).toEqual([...l.closes.map((x) => x.month)].sort().reverse());

    // Ya cerrado: la vista previa lo dice y trae la foto que hay.
    const despues = (await previa(owner, mes)).json() as MonthlyClosePreview;
    expect(diferenciasConElContrato(MonthlyClosePreview, despues)).toEqual([]);
    expect(despues.closable).toBe(false);
    expect(despues.blockers.map((b) => b.code)).toEqual(['ALREADY_CLOSED']);
    expect(despues.closed).toEqual(c);
    // Y cerrarlo otra vez no gasta la firma: responde antes de pedirla.
    expect((await cerrar(mes)).statusCode).toBe(409);
  });

  it('los meses por cerrar son los terminados sin foto, del más viejo al más reciente', async () => {
    // «El gimnasio de pruebas cobra todos los meses» era verdad solo si antes habían corrido
    // otros archivos que cobran con fecha atrasada: en una base recién sembrada el primer
    // cobro es de hoy y el mes pasado no está por cerrar (1.17b: sin depender del orden).
    // Se garantiza UN cobro de hace dos meses; es un pago y no se puede borrar, así que
    // se crea solo si la base no tiene ninguno tan viejo.
    {
      const db = getDb();
      const ahora = new Date();
      const haceDosMeses = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() - 2, 15));
      const viejo = await db.payment.findFirst({ where: { organizationId: orgId, status: 'SUCCEEDED', businessDate: { lte: haceDosMeses } }, select: { id: true } });
      if (!viejo) {
        const { uuidv7 } = await import('@gymflow/core');
        const socio = await db.member.findFirstOrThrow({ where: { organizationId: orgId }, select: { id: true, homeBranchId: true } });
        await db.payment.create({ data: { id: uuidv7(), organizationId: orgId, memberId: socio.id, branchId: socio.homeBranchId, method: 'SPEI_TRANSFER', status: 'SUCCEEDED', amountCents: 100n, unappliedCents: 100n, businessDate: haceDosMeses } });
      }
    }
    const lista = (await app.inject({ method: 'GET', url: '/reports/monthly-closes', headers: { cookie: gerencia } })).json() as MonthlyCloseList;
    const hoy = ((await previa(gerencia, '2024-05')).json() as MonthlyClosePreview).businessDates.organization;
    const cerrados = new Set(lista.closes.map((c) => c.month));
    expect(lista.pending).toEqual([...lista.pending].sort());
    for (const m of lista.pending) {
      expect(m < hoy.slice(0, 7), m).toBe(true);
      expect(cerrados.has(m), m).toBe(false);
    }
    // El gimnasio de pruebas cobra todos los meses: el mes pasado está por cerrar o ya cerrado.
    const d = new Date(`${hoy.slice(0, 7)}-01T00:00:00.000Z`); d.setUTCMonth(d.getUTCMonth() - 1);
    const pasado = d.toISOString().slice(0, 7);
    expect(lista.pending.includes(pasado) || cerrados.has(pasado)).toBe(true);
    // Cada mes por cerrar se puede cerrar de verdad (misma regla en la lista y en la vista previa).
    if (lista.pending.length > 0) expect(((await previa(gerencia, lista.pending[0]!)).json() as MonthlyClosePreview).closable).toBe(true);
  });

  it('si el asiento de bitácora falla, el mes NO queda cerrado (13-19)', async () => {
    const mes = '2024-06';
    await borrar(mes);
    const token = await aprobacion(app, gerencia, 'reports:month:close', 'owner@demo.mx');
    const original = AuditService.prototype.record;
    const espia = vi.spyOn(AuditService.prototype, 'record').mockImplementation(async function (this: AuditService, ctx, input) {
      if (input.action === 'report.month.close') throw new Error('la bitácora no respondió');
      return original.call(this, ctx, input);
    });
    try {
      const res = await cerrar(mes, token);
      expect(res.statusCode).toBe(500);
    } finally { espia.mockRestore(); }
    expect(await filas(mes)).toHaveLength(0);
    // Con la bitácora de vuelta, el mes se cierra y deja su asiento.
    const otra = await aprobacion(app, gerencia, 'reports:month:close', 'owner@demo.mx');
    const ok = await cerrar(mes, otra);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await getDb().auditLog.count({ where: { organizationId: orgId, action: 'report.month.close', resourceId: ok.json().id } })).toBe(1);
  });
});

describe('1.9 · el mes termina cuando termina en todas las sedes', () => {
  const nombres = new Map([['b-centro', 'Centro'], ['b-frontera', 'Frontera']]);
  it('con Frontera un día atrás, dice dónde falta y qué día es allá', () => {
    const r = mesTerminadoEnTodasLasSedes('2026-10', { organization: '2026-11-01', byBranch: [{ branchId: 'b-centro', date: '2026-11-01' }, { branchId: 'b-frontera', date: '2026-10-31' }], nombres });
    expect(r).toEqual({ ok: false, message: 'Octubre todavía no termina en Frontera: allá es 31 de octubre. Se podrá cerrar en cuanto cambie el día.' });
  });
  it('cuando ya cambió el día en todas, se puede; antes de terminar en el gimnasio, no', () => {
    expect(mesTerminadoEnTodasLasSedes('2026-10', { organization: '2026-11-01', byBranch: [{ branchId: 'b-centro', date: '2026-11-01' }, { branchId: 'b-frontera', date: '2026-11-01' }], nombres })).toEqual({ ok: true });
    expect(mesTerminadoEnTodasLasSedes('2026-10', { organization: '2026-10-31', byBranch: [{ branchId: 'b-centro', date: '2026-10-31' }], nombres })).toEqual({ ok: false, message: 'Solo se cierra un mes que ya terminó' });
    // Sin sucursales abiertas cuenta la fecha del gimnasio.
    expect(mesTerminadoEnTodasLasSedes('2026-10', { organization: '2026-11-02', byBranch: [], nombres })).toEqual({ ok: true });
  });
});

describe('1.9 · la firma pendiente más vieja (1.1 §7, defecto 5)', () => {
  it('compara fechas, no su texto', () => {
    const jueves = new Date('2026-10-01T15:00:00.000Z'); // «Thu Oct 01…»
    const viernes = new Date('2026-11-06T15:00:00.000Z'); // «Fri Nov 06…»: como texto va antes
    expect([jueves, viernes].sort()[0]).toBe(viernes);
    expect(masVieja([viernes, jueves])).toBe(jueves);
    expect(masVieja([jueves, viernes])).toBe(jueves);
    expect(masVieja([])).toBeNull();
  });
});
