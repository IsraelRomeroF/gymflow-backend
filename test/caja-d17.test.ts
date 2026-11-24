import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { CashAlertsService } from '../src/modules/cash/index.js';

/**
 * FASE 4 · BLOQUE 4.3 · D-17 (b) «EL CAJÓN ENTRE TURNOS».
 *
 *  · El descuadre es de quien ABRIÓ el turno, lo corte quien lo corte.
 *  · Una diferencia MAYOR a $20 (falte o sobre) nace «por revisar»; la gerencia
 *    la revisa y la cierra con su nota. Justo $20 no se revisa.
 *  · Cada turno declara su propio fondo: no se hereda el del corte anterior.
 *  · La API dice cuánto le queda al puesto en el turno (antes de pedir la firma).
 *  · «Retiro del dueño» desde el cajón: el retiro y su anotación, juntos.
 *  · Cajas que amanecieron sin cortar y descuadres por revisar, como dato.
 *
 * Gimnasio propio, dos sedes. Cada caso abre su turno con $1,000 de fondo y lo
 * corta: una regla de dinero por prueba.
 */
describe('caja · D-17', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let owner: string; let gerente: string; let recepcion: string;
  let sede: string; let otraSede: string;
  let idRecepcion: string; let idGerente: string;

  const FONDO = 100_000n;
  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (cookie: string, url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, headers: { cookie }, payload });
  const abrir = async (caja: string, quien = recepcion, fondo = FONDO) => {
    const t = await post(quien, '/cash-sessions', { cashRegisterId: caja, openingFloatCents: fondo.toString() });
    expect(t.statusCode, t.body).toBe(201);
    return t.json() as { id: string; businessDate: string; openingFloatCents: string };
  };
  /** Corta contando `contado`; con diferencia, el motivo va en el mismo envío. */
  const cortar = (turno: string, contado: bigint, quien = recepcion) =>
    post(quien, `/cash-sessions/${turno}/close`, { countedCashCents: contado.toString(), ...(contado === FONDO ? {} : { varianceReason: 'Diferencia de la prueba del corte' }) });
  /** Abre, corta con esa diferencia (contado − esperado) y devuelve el corte. */
  const corteCon = async (diferencia: bigint, abre = recepcion, corta = abre) => {
    const turno = await abrir(g.sedes[0]!.cajas[0]!, abre);
    const r = await cortar(turno.id, FONDO + diferencia, corta);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as Record<string, unknown> & { id: string };
  };
  const revisar = (cookie: string, turno: string, note = 'Se habló con quien abrió: cambio mal dado') => post(cookie, `/cash-sessions/${turno}/variance/review`, { note });
  const firma = (cookie: string, turno: string, amountCents: string) => aprobacion(app, cookie, 'cash:withdraw', g.correos.owner, sede, { resourceId: turno, amountCents });
  const retirosDelDueno = () => getDb().operatingExpense.count({ where: { organizationId: g.organizationId, category: 'OWNER_DRAW' } });

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio({ sedes: [{ name: 'Sede del corte', cajas: 2 }, { name: 'Otra sede del corte', cajas: 1 }] });
    sede = g.sedes[0]!.id; otraSede = g.sedes[1]!.id;
    owner = await loginAs(app, g.correos.owner);
    gerente = await loginAs(app, g.correos.gerente);
    recepcion = await loginAs(app, g.correos.recepcion);
    const cuentas = await getDb().user.findMany({ where: { email: { in: [g.correos.recepcion, g.correos.gerente] } }, select: { id: true, email: true } });
    idRecepcion = cuentas.find((c) => c.email === g.correos.recepcion)!.id;
    idGerente = cuentas.find((c) => c.email === g.correos.gerente)!.id;
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  it('un faltante de $20 justos no queda por revisar; con un peso más, sí', async () => {
    const justo = await corteCon(-2_000n);
    expect(justo).toMatchObject({ varianceCents: '-2000', varianceKind: 'SHORT', varianceStatus: null });
    const unPesoMas = await corteCon(-2_100n);
    expect(unPesoMas).toMatchObject({ varianceCents: '-2100', varianceKind: 'SHORT', varianceStatus: 'PENDING', varianceReviewedByUserId: null, varianceReviewNote: null });
  });

  it('un sobrante de $20 justos no queda por revisar; con un peso más, sí', async () => {
    expect(await corteCon(2_000n)).toMatchObject({ varianceCents: '2000', varianceKind: 'OVER', varianceStatus: null });
    expect(await corteCon(2_100n)).toMatchObject({ varianceCents: '2100', varianceKind: 'OVER', varianceStatus: 'PENDING' });
  });

  it('un corte que cuadra no tiene nada que revisar, y la diferencia chica sigue exigiendo su motivo', async () => {
    expect(await corteCon(0n)).toMatchObject({ varianceCents: '0', varianceKind: 'EXACT', varianceStatus: null });
    const turno = await abrir(g.sedes[0]!.cajas[0]!);
    const sinMotivo = await post(recepcion, `/cash-sessions/${turno.id}/close`, { countedCashCents: (FONDO - 500n).toString() });
    expect(sinMotivo.statusCode, sinMotivo.body).toBe(422);
    expect((await cortar(turno.id, FONDO - 500n)).json()).toMatchObject({ varianceCents: '-500', varianceStatus: null });
  });

  it('el faltante es de quien abrió el turno aunque lo corte la gerencia, y queda con su nombre', async () => {
    const corte = await corteCon(-5_000n, recepcion, gerente);
    expect(corte).toMatchObject({
      openedByUserId: idRecepcion, closedByUserId: idGerente, responsibleUserId: idRecepcion, varianceStatus: 'PENDING',
    });
    expect(corte.responsibleName).toBe(corte.openedByName);
    expect(corte.responsibleName).not.toBe(corte.closedByName);
    // La hoja del corte lo dice igual, y la bitácora guarda de quién es.
    const hoja = (await get(owner, `/cash-sessions/${corte.id}`)).json();
    expect(hoja.session).toMatchObject({ responsibleUserId: idRecepcion, closedByUserId: idGerente });
    const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'cash.session.close', resourceId: corte.id } });
    expect(asiento.afterState).toMatchObject({ responsibleUserId: idRecepcion, closedByOther: true, varianceStatus: 'PENDING', varianceCents: '-5000' });
  });

  it('la gerencia revisa y cierra con su nota, una sola vez; recepción y la dueña no revisan', async () => {
    const corte = await corteCon(-7_500n);
    expect((await revisar(recepcion, corte.id)).statusCode).toBe(403);
    expect((await revisar(owner, corte.id)).statusCode).toBe(403);
    expect((await revisar(gerente, corte.id, '  ')).statusCode).toBe(422);

    const r = await revisar(gerente, corte.id, 'Faltó cambio de un billete de $100; se habló con recepción');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      varianceStatus: 'REVIEWED', varianceReviewedByUserId: idGerente, varianceReviewNote: 'Faltó cambio de un billete de $100; se habló con recepción',
      // Revisar no cambia de quién es ni cuánto fue.
      responsibleUserId: idRecepcion, varianceCents: '-7500',
    });
    expect(r.json().varianceReviewedByName).toBeTruthy();
    expect(r.json().varianceReviewedAt).toBeTruthy();

    const otraVez = await revisar(gerente, corte.id);
    expect(otraVez.statusCode, otraVez.body).toBe(409);
    expect(otraVez.json().reason).toBe('VARIANCE_NOT_PENDING');
    const asientos = await getDb().auditLog.findMany({ where: { organizationId: g.organizationId, action: 'cash.variance.review', resourceId: corte.id } });
    expect(asientos).toHaveLength(1);
    expect(asientos[0]!.afterState).toMatchObject({ varianceStatus: 'REVIEWED', varianceCents: '-7500', amountCents: '7500', responsibleUserId: idRecepcion, ownShift: false });
  });

  it('un corte dentro de la tolerancia, o un turno abierto, no se pueden «revisar»', async () => {
    const chico = await corteCon(-2_000n);
    const r = await revisar(gerente, chico.id);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().reason).toBe('VARIANCE_NOT_PENDING');
    const abierto = await abrir(g.sedes[0]!.cajas[0]!);
    expect((await revisar(gerente, abierto.id)).statusCode).toBe(409);
    expect((await cortar(abierto.id, FONDO)).statusCode).toBe(200);
  });

  it('cada turno declara su propio fondo: no se hereda lo que dejó el corte anterior', async () => {
    const caja = g.sedes[0]!.cajas[1]!;
    const primero = await abrir(caja, recepcion, 150_000n);
    expect((await post(recepcion, `/cash-sessions/${primero.id}/close`, { countedCashCents: '150000' })).statusCode).toBe(200);
    // Sin fondo no abre: nadie lo pone por él.
    const sinFondo = await post(recepcion, '/cash-sessions', { cashRegisterId: caja });
    expect(sinFondo.statusCode, sinFondo.body).toBe(422);
    // Y abre con lo que declara, no con los $1,500 que se contaron en el corte anterior.
    const segundo = await abrir(caja, recepcion, 30_000n);
    expect(segundo.openingFloatCents).toBe('30000');
    const cierre = await post(recepcion, `/cash-sessions/${segundo.id}/close`, { countedCashCents: '30000' });
    expect(cierre.json()).toMatchObject({ expectedCashCents: '30000', varianceCents: '0' });
  });

  it('la API dice cuánto le queda al puesto en el turno: lo que queda justo pasa con firma, un peso más no', async () => {
    const turno = await abrir(g.sedes[0]!.cajas[0]!, recepcion, 1_000_000n);
    const antes = (await get(recepcion, `/cash-sessions/${turno.id}/allowance`)).json();
    expect(antes).toMatchObject({
      withdrawal: { role: 'CON_TOPE', limitCents: '500000', usedCents: '0', remainingCents: '500000' },
      petty: { limitCents: '50000', floatInRemainingCents: '50000', expenseRemainingCents: '50000' },
    });
    const mover = (movementType: string, amountCents: string, approvalToken?: string) =>
      post(recepcion, `/cash-sessions/${turno.id}/movements`, { movementType, amountCents, reason: 'Movimiento de la prueba del tope', ...(approvalToken ? { approvalToken } : {}) });
    expect((await mover('WITHDRAWAL', '300000', await firma(recepcion, turno.id, '300000'))).statusCode).toBe(201);
    expect((await mover('EXPENSE', '12000')).statusCode).toBe(201);

    const despues = (await get(recepcion, `/cash-sessions/${turno.id}/allowance`)).json();
    expect(despues.withdrawal).toMatchObject({ usedCents: '300000', remainingCents: '200000' });
    expect(despues.petty).toMatchObject({ floatInRemainingCents: '50000', expenseRemainingCents: '38000' });
    // Lo que la API dijo que queda es exactamente lo que pasa.
    expect((await mover('WITHDRAWAL', '200100', await firma(recepcion, turno.id, '200100'))).statusCode).toBe(403);
    expect((await mover('WITHDRAWAL', '200000', await firma(recepcion, turno.id, '200000'))).statusCode).toBe(201);
    expect((await get(recepcion, `/cash-sessions/${turno.id}/allowance`)).json().withdrawal.remainingCents).toBe('0');

    // La gerencia no tiene tope por turno; y nada de esto enseña el efectivo del cajón.
    const deGerencia = (await get(gerente, `/cash-sessions/${turno.id}/allowance`)).json();
    expect(deGerencia.withdrawal).toMatchObject({ role: 'SIN_TOPE', limitCents: null, usedCents: '0', remainingCents: null });
    expect(JSON.stringify(despues)).not.toContain('expected');
    // La dueña no mueve el cajón: no tiene a quién preguntarle esto.
    expect((await get(owner, `/cash-sessions/${turno.id}/allowance`)).statusCode).toBe(403);
    expect((await post(recepcion, `/cash-sessions/${turno.id}/close`, { countedCashCents: '488000' })).json()).toMatchObject({ varianceCents: '0' });
  });

  it('«Retiro del dueño» desde el cajón: sin firma no se anota nada; con firma salen juntos el retiro y su anotación', async () => {
    const turno = await abrir(g.sedes[0]!.cajas[0]!, recepcion, 1_000_000n);
    const habia = await retirosDelDueno();
    const pedir = (amountCents: string, approvalToken?: string) =>
      post(recepcion, `/cash-sessions/${turno.id}/owner-draw`, { amountCents, reason: 'Retiro del dueño de la quincena', ...(approvalToken ? { approvalToken } : {}) });

    const sinFirma = await pedir('150000');
    expect(sinFirma.statusCode, sinFirma.body).toBe(428);
    expect(await retirosDelDueno()).toBe(habia);

    const hecho = await pedir('150000', await firma(recepcion, turno.id, '150000'));
    expect(hecho.statusCode, hecho.body).toBe(201);
    const r = hecho.json();
    expect(r.movement).toMatchObject({ movementType: 'WITHDRAWAL', amountCents: '-150000', ownerDraw: true, approvedByUserId: g.ownerId });
    expect(r.month).toBe(turno.businessDate.slice(0, 7));
    const gasto = await getDb().operatingExpense.findUniqueOrThrow({ where: { id: r.expenseId } });
    expect(gasto).toMatchObject({ category: 'OWNER_DRAW', amountCents: 150_000n, branchId: sede, voidedAt: null, createdByUserId: idRecepcion });
    const fila = await getDb().cashMovement.findUniqueOrThrow({ where: { id: r.movement.id } });
    expect(fila.expenseId).toBe(r.expenseId);
    // Es un retiro del cajón: cuenta en el tope de recepción y el corte lo espera fuera.
    expect((await get(recepcion, `/cash-sessions/${turno.id}/allowance`)).json().withdrawal.remainingCents).toBe('350000');

    // Uno que pasa del tope del puesto, o de lo que hay en el cajón, no deja anotación suelta.
    const deMas = await pedir('350100', await firma(recepcion, turno.id, '350100'));
    expect(deMas.statusCode, deMas.body).toBe(403);
    expect(deMas.json().reason).toBe('CASH_LIMIT_FORBIDDEN');
    const sinEfectivo = await post(gerente, `/cash-sessions/${turno.id}/owner-draw`, { amountCents: '900000', reason: 'Retiro del dueño de más', approvalToken: await firma(gerente, turno.id, '900000') });
    expect(sinEfectivo.statusCode, sinEfectivo.body).toBe(422);
    expect(await retirosDelDueno()).toBe(habia + 1);

    const hoja = (await get(gerente, `/cash-sessions/${turno.id}`)).json();
    expect(hoja.movements).toHaveLength(1);
    expect(hoja.movements[0]).toMatchObject({ ownerDraw: true, amountCents: '-150000' });
    expect((await post(recepcion, `/cash-sessions/${turno.id}/close`, { countedCashCents: '850000' })).json()).toMatchObject({ varianceCents: '0', varianceStatus: null });
  });

  it('con el mes cerrado el retiro del dueño no se registra (409 MONTH_CLOSED), pero un descuadre sí se puede revisar', async () => {
    const pendiente = await corteCon(-3_000n);
    const turno = await abrir(g.sedes[0]!.cajas[0]!, recepcion, 500_000n);
    const mes = new Date(`${turno.businessDate.slice(0, 7)}-01T00:00:00.000Z`);
    const habia = await retirosDelDueno();
    const cierre = await getDb().monthlyClose.create({ data: { id: crypto.randomUUID(), organizationId: g.organizationId, month: mes, totals: {}, byBranch: {}, closedByUserId: g.ownerId } });
    try {
      const r = await post(recepcion, `/cash-sessions/${turno.id}/owner-draw`, { amountCents: '100000', reason: 'Retiro del dueño en mes cerrado', approvalToken: await firma(recepcion, turno.id, '100000') });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().reason).toBe('MONTH_CLOSED');
      expect(await retirosDelDueno()).toBe(habia);
      expect((await get(gerente, `/cash-sessions/${turno.id}`)).json().movements).toHaveLength(0);
      // Revisar no cambia ninguna cifra del mes: se puede aunque ya esté cerrado.
      expect((await revisar(gerente, pendiente.id)).statusCode).toBe(200);
    } finally {
      await getDb().$executeRaw`DELETE FROM "monthly_closes" WHERE "id" = ${cierre.id}::uuid`;
    }
    expect((await cortar(turno.id, 500_000n)).statusCode).toBe(200);
  });

  it('cajas sin cortar y descuadres por revisar: el dato para la dueña, la gerencia y los avisos', async () => {
    const db = getDb();
    // Punto de partida conocido: lo que dejaron los casos de arriba se da por revisado.
    for (const s of await db.cashSession.findMany({ where: { organizationId: g.organizationId, varianceStatus: 'PENDING' }, select: { id: true } })) {
      expect((await revisar(gerente, s.id)).statusCode).toBe(200);
    }
    const falta = await corteCon(-4_000n);
    const sobra = await corteCon(2_500n);
    const deHoy = await abrir(g.sedes[0]!.cajas[0]!);
    const vieja = await abrir(g.sedes[1]!.cajas[0]!, gerente);
    // Amaneció sin cortar: su día de negocio es anterior al de hoy de su sede (no depende de la hora).
    await db.cashSession.update({ where: { id: vieja.id }, data: { businessDate: new Date('2024-03-10T00:00:00.000Z') } });

    const todo = (await get(owner, '/cash/alerts')).json();
    expect(todo.staleCount).toBe(1);
    expect([...todo.open].map((a: { id: string }) => a.id).sort()).toEqual([deHoy.id, vieja.id].sort());
    expect(todo.open.find((a: { id: string }) => a.id === vieja.id)).toMatchObject({ stale: true, branchId: otraSede, branchName: 'Otra sede del corte', businessDate: '2024-03-10' });
    expect(todo.open.find((a: { id: string }) => a.id === deHoy.id)).toMatchObject({ stale: false, branchId: sede, openedByUserId: idRecepcion });
    expect(todo.pendingVariances).toMatchObject({ count: 2, shortageCents: '4000', overageCents: '2500' });

    // Recepción ve lo de su sede y nada de la otra.
    const deRecepcion = (await get(recepcion, '/cash/alerts')).json();
    expect(deRecepcion.open.map((a: { id: string }) => a.id)).toEqual([deHoy.id]);
    expect(deRecepcion.staleCount).toBe(0);
    expect((await get(recepcion, `/cash/alerts?branchId=${otraSede}`)).statusCode).toBe(403);

    // El mismo dato, como lo pedirá el aviso al teléfono (bloque 4.2): todo el gimnasio.
    const avisos = new CashAlertsService();
    expect((await avisos.unclosed(g.organizationId, null)).map((a) => a.id)).toEqual([vieja.id]);
    expect(await avisos.pendingVariances(g.organizationId, null)).toMatchObject({ count: 2, shortageCents: 4_000n, overageCents: 2_500n });
    expect(await avisos.pendingVariances(g.organizationId, [otraSede])).toMatchObject({ count: 0 });

    // La vista «Cortes»: por revisar, todo lo que no cuadró, y de quién.
    const porRevisar = (await get(owner, '/cash-sessions?variance=PENDING')).json().sessions.map((s: { id: string }) => s.id).sort();
    expect(porRevisar).toEqual([falta.id, sobra.id].sort());
    const noCuadraron = (await get(owner, '/cash-sessions?variance=ANY&limit=300')).json().sessions as Array<{ varianceCents: string; status: string }>;
    expect(noCuadraron.length).toBeGreaterThan(2);
    expect(noCuadraron.every((s) => s.varianceCents !== '0' && s.status !== 'OPEN')).toBe(true);
    const deLaGerencia = (await get(owner, `/cash-sessions?openedByUserId=${idGerente}`)).json().sessions.map((s: { id: string }) => s.id);
    expect(deLaGerencia).toEqual([vieja.id]);
    const deMarzo = (await get(owner, '/cash-sessions?from=2024-03-01&to=2024-03-31')).json().sessions.map((s: { id: string }) => s.id);
    expect(deMarzo).toEqual([vieja.id]);

    await db.cashSession.update({ where: { id: vieja.id }, data: { businessDate: new Date(`${deHoy.businessDate}T00:00:00.000Z`) } });
    expect((await cortar(deHoy.id, FONDO)).statusCode).toBe(200);
    expect((await cortar(vieja.id, FONDO, gerente)).statusCode).toBe(200);
  });

  it('«Hoy te toca» le dice a la gerencia cuántos descuadres tiene por revisar y cuánto falta; a recepción y a la dueña, no', async () => {
    for (const s of await getDb().cashSession.findMany({ where: { organizationId: g.organizationId, varianceStatus: 'PENDING' }, select: { id: true } })) {
      expect((await revisar(gerente, s.id)).statusCode).toBe(200);
    }
    const renglon = async (cookie: string) => {
      const r = await get(cookie, '/me/home');
      expect(r.statusCode, r.body).toBe(200);
      return (r.json().items as Array<{ key: string }>).find((i) => i.key === 'variances');
    };
    expect(await renglon(gerente)).toBeUndefined();
    const falta = await corteCon(-4_000n);
    await corteCon(2_500n);
    expect(await renglon(gerente)).toMatchObject({ count: 2, tone: 'warn', amountCents: '4000' });
    expect(await renglon(recepcion)).toBeUndefined();
    expect(await renglon(owner)).toBeUndefined();
    expect((await revisar(gerente, falta.id)).statusCode).toBe(200);
    expect(await renglon(gerente)).toMatchObject({ count: 1, amountCents: '0' });
  });
});
