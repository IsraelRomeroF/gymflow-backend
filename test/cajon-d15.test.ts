import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';

/**
 * FASE 3 · BLOQUE 3.5 · D-15 «EL EFECTIVO DEL CAJÓN» (y el choque 5).
 *
 *  · Fondo y gastos: con motivo y sin firma hasta $500 por turno y por tipo.
 *  · Retiros y depósitos: siempre con la firma de la dueña; recepción, hasta
 *    $5,000 por turno (acumulado), y arriba ni con firma.
 *  · Los topes son del gimnasio y los cambia la gerencia con la firma de la dueña.
 * Gimnasio propio, una sede con tres cajas: cada caso abre su turno.
 */
describe('caja · D-15', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente: string; let recepcion: string;
  let sede: string;

  const post = (cookie: string, url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, headers: { cookie }, payload });
  const abrir = async (caja: number, quien = recepcion) => {
    const t = await post(quien, '/cash-sessions', { cashRegisterId: g.sedes[0]!.cajas[caja], openingFloatCents: '2000000' });
    expect(t.statusCode, t.body).toBe(201);
    return t.json().id as string;
  };
  const cerrar = async (turno: string) => {
    const t = await getDb().cashSession.findUniqueOrThrow({ where: { id: turno } });
    await getDb().cashSession.update({ where: { id: turno }, data: { status: 'CLOSED', closedAt: new Date(), closedByUserId: t.openedByUserId, countedCashCents: 0n, expectedCashCents: 0n, varianceCents: 0n } });
  };
  const mover = (cookie: string, turno: string, movementType: string, amountCents: string, approvalToken?: string) =>
    post(cookie, `/cash-sessions/${turno}/movements`, { movementType, amountCents, reason: 'Movimiento de la prueba del cajón', ...(approvalToken ? { approvalToken } : {}), ...(movementType === 'CORRECTION' ? { sign: -1 } : {}) });
  const firma = (cookie: string, turno: string, amountCents: string) => aprobacion(app, cookie, 'cash:withdraw', g.correos.owner, sede, { resourceId: turno, amountCents });

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio({ sedes: [{ name: 'Sede del cajón', cajas: 3 }] });
    sede = g.sedes[0]!.id;
    gerente = await loginAs(app, g.correos.gerente);
    recepcion = await loginAs(app, g.correos.recepcion);
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  it('recepción anota un gasto de $500 justos sin firma; un peso más en el mismo turno pide firma, y con ella pasa', async () => {
    const turno = await abrir(0);
    const justo = await mover(recepcion, turno, 'EXPENSE', '50000');
    expect(justo.statusCode, justo.body).toBe(201);
    expect(justo.json()).toMatchObject({ movementType: 'EXPENSE', amountCents: '-50000', approvedByUserId: null });

    const unPeso = await mover(recepcion, turno, 'EXPENSE', '100');
    expect(unPeso.statusCode, unPeso.body).toBe(428);
    const firmado = await mover(recepcion, turno, 'EXPENSE', '100', await firma(recepcion, turno, '100'));
    expect(firmado.statusCode, firmado.body).toBe(201);
    expect(firmado.json().approvedByUserId).toBe(g.ownerId);
    // Lo firmado no gasta el tope chico, pero el tope ya estaba gastado: sigue pidiendo firma.
    expect((await mover(recepcion, turno, 'EXPENSE', '100')).statusCode).toBe(428);
    await cerrar(turno);
  });

  it('un solo gasto de $501 pide firma; el fondo tiene su propio tope de $500 en el mismo turno', async () => {
    const turno = await abrir(0);
    expect((await mover(recepcion, turno, 'EXPENSE', '50100')).statusCode).toBe(428);
    expect((await mover(recepcion, turno, 'EXPENSE', '40000')).statusCode).toBe(201);
    // El gasto no gasta el tope del fondo.
    const fondo = await mover(recepcion, turno, 'FLOAT_IN', '50000');
    expect(fondo.statusCode, fondo.body).toBe(201);
    expect(fondo.json().amountCents).toBe('50000');
    expect((await mover(recepcion, turno, 'FLOAT_IN', '100')).statusCode).toBe(428);
    // Y al gasto le quedaban $100: pasan; $101 no.
    expect((await mover(recepcion, turno, 'EXPENSE', '10100')).statusCode).toBe(428);
    expect((await mover(recepcion, turno, 'EXPENSE', '10000')).statusCode).toBe(201);
    await cerrar(turno);
  });

  it('sin motivo no se anota nada del cajón', async () => {
    const turno = await abrir(0);
    const r = await post(recepcion, `/cash-sessions/${turno}/movements`, { movementType: 'EXPENSE', amountCents: '6000', reason: '' });
    expect(r.statusCode).toBe(422);
    await cerrar(turno);
  });

  it('recepción retira o deposita siempre con firma, y hasta $5,000 por turno: justo $5,000 sí, un peso más ni con firma', async () => {
    const turno = await abrir(0);
    const sinFirma = await mover(recepcion, turno, 'WITHDRAWAL', '10000');
    expect(sinFirma.statusCode, sinFirma.body).toBe(428);
    const retiro = await mover(recepcion, turno, 'WITHDRAWAL', '300000', await firma(recepcion, turno, '300000'));
    expect(retiro.statusCode, retiro.body).toBe(201);
    expect(retiro.json()).toMatchObject({ movementType: 'WITHDRAWAL', amountCents: '-300000', approvedByUserId: g.ownerId });
    // Lleva $3,000. Un depósito de $2,001 pasaría de $5,000: se niega aunque traiga firma (y la firma no se gasta).
    const deMas = await mover(recepcion, turno, 'DEPOSIT', '200100', await firma(recepcion, turno, '200100'));
    expect(deMas.statusCode, deMas.body).toBe(403);
    expect(deMas.json().reason).toBe('CASH_LIMIT_FORBIDDEN');
    const justo = await mover(recepcion, turno, 'DEPOSIT', '200000', await firma(recepcion, turno, '200000'));
    expect(justo.statusCode, justo.body).toBe(201);
    // Ya gastó su tope: ni un peso más, con o sin firma.
    expect((await mover(recepcion, turno, 'WITHDRAWAL', '100')).statusCode).toBe(403);
    expect((await mover(recepcion, turno, 'WITHDRAWAL', '100', await firma(recepcion, turno, '100'))).statusCode).toBe(403);
    // Los gastos chicos no cuentan para ese tope.
    expect((await mover(recepcion, turno, 'EXPENSE', '6000')).statusCode).toBe(201);
    await cerrar(turno);
  });

  it('la gerencia no tiene tope por turno, pero su retiro también lleva la firma de la dueña', async () => {
    const turno = await abrir(1, gerente);
    expect((await mover(gerente, turno, 'WITHDRAWAL', '600000')).statusCode).toBe(428);
    const r = await mover(gerente, turno, 'WITHDRAWAL', '600000', await firma(gerente, turno, '600000'));
    expect(r.statusCode, r.body).toBe(201);
    // Y su gasto chico pasa sin firma hasta $500, igual que el de recepción.
    expect((await mover(gerente, turno, 'EXPENSE', '50000')).statusCode).toBe(201);
    expect((await mover(gerente, turno, 'EXPENSE', '100')).statusCode).toBe(428);
    await cerrar(turno);
  });

  it('la corrección del cajón es de la gerencia y con firma; recepción no la hace', async () => {
    const turno = await abrir(0);
    expect((await mover(recepcion, turno, 'CORRECTION', '1000', await firma(recepcion, turno, '1000'))).statusCode).toBe(403);
    expect((await mover(gerente, turno, 'CORRECTION', '1000')).statusCode).toBe(428);
    expect((await mover(gerente, turno, 'CORRECTION', '1000', await firma(gerente, turno, '1000'))).statusCode).toBe(201);
    await cerrar(turno);
  });

  it('los topes son del gimnasio: de fábrica $500 y $5,000; los cambia la gerencia solo con la firma de la dueña, y mandan desde ese momento', async () => {
    const ver = async (cookie: string) => (await app.inject({ method: 'GET', url: '/cash/limits', headers: { cookie } })).json();
    expect(await ver(recepcion)).toMatchObject({ pettyLimitCents: '50000', withdrawalShiftLimitCents: '500000', isDefault: true });

    const cambio = { pettyLimitCents: '80000', withdrawalShiftLimitCents: '300000', reason: 'La dueña sube el gasto chico y baja el retiro' };
    const put = (cookie: string, payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/cash/limits', headers: { cookie }, payload });
    expect((await put(recepcion, cambio)).statusCode).toBe(403);
    expect((await put(gerente, cambio)).statusCode).toBe(428);
    expect((await put(gerente, { ...cambio, pettyLimitCents: '1000100', approvalToken: 'x'.repeat(24) })).statusCode).toBe(422);
    const token = await aprobacion(app, gerente, 'cash:limits:set', g.correos.owner, undefined, { resourceId: g.organizationId });
    const hecho = await put(gerente, { ...cambio, approvalToken: token });
    expect(hecho.statusCode, hecho.body).toBe(200);
    expect(hecho.json()).toMatchObject({ pettyLimitCents: '80000', withdrawalShiftLimitCents: '300000', isDefault: false });
    const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'cash.limits.update' } });
    expect(asiento.approvedByUserId).toBe(g.ownerId);
    expect(asiento.beforeState).toMatchObject({ pettyLimitCents: '50000' });

    const turno = await abrir(2);
    expect((await mover(recepcion, turno, 'EXPENSE', '80000')).statusCode).toBe(201);
    expect((await mover(recepcion, turno, 'EXPENSE', '100')).statusCode).toBe(428);
    expect((await mover(recepcion, turno, 'WITHDRAWAL', '300000', await firma(recepcion, turno, '300000'))).statusCode).toBe(201);
    expect((await mover(recepcion, turno, 'WITHDRAWAL', '100', await firma(recepcion, turno, '100'))).statusCode).toBe(403);
    await cerrar(turno);
  });
});
