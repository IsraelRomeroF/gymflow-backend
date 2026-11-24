import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ApprovalApprovers, ApprovalHistory, ApprovalInbox, ApprovalRequest, ApprovalRequestState, diferenciasConElContrato } from '@gymflow/core/contracts';
import {
  APPROVAL_REASK_LIMIT, APPROVAL_REJECT_LOCK_MS, APPROVAL_REQUEST_TTL_MS, approvalRejectLockUntil, auditCategoryOf, auditNeedsReview, auditPhrase, monthlyCloseResourceId,
} from '@gymflow/core';
import { makeApp, PASSWORD } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { abrirTurno, gimnasioPropio, sesionesDe, type GimnasioPropio } from './gimnasio-propio.js';

/**
 * BLOQUE 3.2 (auditoría 8, fase 3) · D-03, opción (b): EL «NO» QUEDA PEGADO A
 * LA OPERACIÓN. Al volver a pedir lo rechazado hay que contestar ese «no» y
 * quien firma ve las dos cosas; la misma operación se pide como mucho 3 veces
 * por hora; durante 30 minutos nadie la firma en el mostrador; y quien firma
 * puede preguntar en vez de rechazar. En un gimnasio propio. Nada depende de
 * la hora real: el paso del tiempo se hace moviendo las fechas de las filas.
 */
describe('firmas · D-03: el «no» pegado a la operación (bloque 3.2)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let s: { owner: string; gerente: string; gerente2: string; recepcion: string };
  let turno: string;
  const db = () => getDb();
  const sede = () => g.sedes[0]!;
  /** Una operación distinta cada vez: el cierre de un mes es un registro que no necesita existir (20-01). */
  let mes = 0;
  const otroMes = () => monthlyCloseResourceId(`2031-${String((mes++ % 12) + 1).padStart(2, '0')}`);

  beforeAll(async () => {
    app = await makeApp(); await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Sede del no', cajas: 1 }] });
    s = await sesionesDe(app, g);
    turno = await abrirTurno(app, s.gerente, sede().cajas[0]!);
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  const pedir = (payload: Record<string, unknown>, cookie = s.gerente) => app.inject({ method: 'POST', url: '/approvals/requests', headers: { cookie }, payload });
  const retiro = (extra: Record<string, unknown> = {}, cookie = s.gerente) => pedir({
    permission: 'cash:withdraw', branchId: sede().id, resourceType: 'CashSession', resourceId: turno, amountCents: '15000', summary: 'Retiro a caja fuerte', ...extra,
  }, cookie);
  const cierre = (resourceId: string, extra: Record<string, unknown> = {}, cookie = s.gerente) => pedir({
    permission: 'reports:month:close', resourceType: 'MonthlyClose', resourceId, summary: 'Cerrar el mes', ...extra,
  }, cookie);
  const estado = async (id: string, cookie = s.gerente) => {
    const r = await app.inject({ method: 'GET', url: `/approvals/requests/${id}`, headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(ApprovalRequestState, r.json())).toEqual([]);
    return r.json() as ApprovalRequestState;
  };
  const accion = (id: string, cual: 'approve' | 'reject' | 'cancel' | 'ask' | 'answer', payload: Record<string, unknown>, cookie: string) =>
    app.inject({ method: 'POST', url: `/approvals/requests/${id}/${cual}`, headers: { cookie }, payload });
  const rechazar = async (id: string, reason = 'Ese efectivo lo cuento yo mañana') => {
    const r = await accion(id, 'reject', { reason }, s.owner);
    expect(r.statusCode, r.body).toBe(200);
  };
  const aprobar = async (id: string) => {
    const r = await accion(id, 'approve', { password: PASSWORD }, s.owner);
    expect(r.statusCode, r.body).toBe(200);
  };
  const operacion = async (permission: string, resourceId: string, cookie = s.gerente) => {
    const r = await app.inject({ method: 'GET', url: `/approvals/approvers?permission=${permission}&resourceId=${resourceId}`, headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(ApprovalApprovers, r.json())).toEqual([]);
    return (r.json() as ApprovalApprovers).operation!;
  };
  const bandeja = async () => {
    const r = await app.inject({ method: 'GET', url: '/approvals/inbox', headers: { cookie: s.owner } });
    expect(diferenciasConElContrato(ApprovalInbox, r.json())).toEqual([]);
    return (r.json() as ApprovalInbox).requests;
  };
  const firmaAqui = (payload: Record<string, unknown>, cookie = s.gerente) => app.inject({ method: 'POST', url: '/approvals', headers: { cookie }, payload: { approverUserId: g.ownerId, password: PASSWORD, ...payload } });
  /** Pasa el tiempo para una operación: sus solicitudes se piden y se deciden `minutos` antes. */
  const envejecer = async (resourceId: string, minutos: number) => {
    for (const f of await db().approvalRequest.findMany({ where: { organizationId: g.organizationId, resourceId } })) {
      await db().approvalRequest.update({ where: { id: f.id }, data: {
        createdAt: new Date(f.createdAt.getTime() - minutos * 60_000),
        ...(f.decidedAt ? { decidedAt: new Date(f.decidedAt.getTime() - minutos * 60_000) } : {}),
      } });
    }
  };

  it('las reglas viven en el núcleo: 3 por hora y 30 minutos sin firma en el mostrador', () => {
    expect(APPROVAL_REASK_LIMIT).toEqual({ max: 3, perMs: 3_600_000 });
    expect(APPROVAL_REJECT_LOCK_MS).toBe(30 * 60_000);
    const ahora = new Date('2026-06-10T18:00:00.000Z');
    expect(approvalRejectLockUntil(new Date('2026-06-10T17:31:00.000Z'), ahora)?.toISOString()).toBe('2026-06-10T18:01:00.000Z');
    expect(approvalRejectLockUntil(new Date('2026-06-10T17:30:00.000Z'), ahora)).toBeNull();
  });

  it('una operación que nadie ha rechazado se pide como siempre: sin respuesta, y la solicitud dice que es la 1.ª vez', async () => {
    const op = otroMes();
    expect(await operacion('reports:month:close', op)).toEqual({ previousRejection: null, localLockedUntil: null, requestsUsed: 0, requestsMax: 3, nextRequestAt: null });
    const r = await cierre(op);
    expect(r.statusCode, r.body).toBe(201);
    expect(diferenciasConElContrato(ApprovalRequest, r.json())).toEqual([]);
    expect(r.json()).toMatchObject({ previousRejection: null, reply: null, attempt: 1, question: null });
    // Sin decir de qué registro se trata, «Pueden autorizar» no dice nada de la operación.
    const sin = await app.inject({ method: 'GET', url: '/approvals/approvers?permission=reports:month:close', headers: { cookie: s.gerente } });
    expect(sin.json().operation).toBeNull();
  });

  it('tras un «no», volver a pedir exige una respuesta; quien pide ve el rechazo y su motivo, y quien firma ve el rechazo y la respuesta', async () => {
    const primera = (await retiro({ reason: 'Depósito al banco' })).json().id as string;
    await rechazar(primera);

    // Quien pide lo ve ANTES de volver a pedir: quién, cuándo y por qué.
    const antes = await operacion('cash:withdraw', turno);
    expect(antes.previousRejection).toMatchObject({ requestId: primera, reason: 'Ese efectivo lo cuento yo mañana' });
    expect(antes.previousRejection!.byName).toBeTruthy();
    expect(antes.localLockedUntil).toBeTruthy();
    expect(antes.requestsUsed).toBe(1);

    // Sin respuesta no se vuelve a pedir, la pida quien la pida y con el importe que sea: el «no» es de la operación.
    const sinRespuesta = await retiro();
    expect(sinRespuesta.statusCode, sinRespuesta.body).toBe(409);
    expect(sinRespuesta.json()).toMatchObject({ reason: 'APPROVAL_REPLY_REQUIRED', detail: 'Su motivo: «Ese efectivo lo cuento yo mañana»' });
    expect(sinRespuesta.json().message).toMatch(/ya la rechazó a las \d{2}:\d{2}: para volver a pedirla, escríbele una respuesta/);
    expect((await retiro({ amountCents: '9000' }, s.gerente2)).json().reason).toBe('APPROVAL_REPLY_REQUIRED');
    // Dos letras no son una respuesta.
    expect((await retiro({ reply: 'ok' })).statusCode).toBe(422);
    expect(await db().approvalRequest.count({ where: { organizationId: g.organizationId, resourceId: turno } })).toBe(1);

    const segunda = await retiro({ reply: 'Ya hablé con usted: es para el depósito de hoy' });
    expect(segunda.statusCode, segunda.body).toBe(201);
    expect(diferenciasConElContrato(ApprovalRequest, segunda.json())).toEqual([]);
    expect(segunda.json()).toMatchObject({
      status: 'PENDING', reply: 'Ya hablé con usted: es para el depósito de hoy', attempt: 2,
      previousRejection: { requestId: primera, reason: 'Ese efectivo lo cuento yo mañana' },
    });
    const id = segunda.json().id as string;
    expect((await db().approvalRequest.findUniqueOrThrow({ where: { id } })).previousRequestId).toBe(primera);

    // La tarjeta de quien firma: «2.ª vez · la rechazaste a las… · responde: …».
    const tarjeta = (await bandeja()).find((r) => r.id === id)!;
    expect(tarjeta).toMatchObject({ attempt: 2, reply: 'Ya hablé con usted: es para el depósito de hoy', previousRejection: { requestId: primera, reason: 'Ese efectivo lo cuento yo mañana' } });
    expect(tarjeta.previousRejection!.at).toBe(antes.previousRejection!.at);
    // Y quien la pidió lo sigue viendo en su diálogo.
    expect(await estado(id)).toMatchObject({ attempt: 2, previousRejection: { requestId: primera } });

    // El asiento de la segunda dice a qué «no» responde y con qué.
    const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'approval.remote.request', resourceId: id } });
    expect(asiento.afterState).toMatchObject({ previousRequestId: primera, reply: 'Ya hablé con usted: es para el depósito de hoy', attempt: 2 });

    // Un «sí» posterior deja sin efecto el «no»: la siguiente operación de ese turno ya no pide respuesta.
    await aprobar(id);
    const despues = await operacion('cash:withdraw', turno);
    expect(despues).toMatchObject({ previousRejection: null, localLockedUntil: null });
    const tercera = await retiro({ amountCents: '8000' });
    expect(tercera.statusCode, tercera.body).toBe(201);
    expect(tercera.json()).toMatchObject({ previousRejection: null, reply: null });
    await accion(tercera.json().id as string, 'cancel', {}, s.gerente);

    // «Resueltas hoy» conserva la historia: la aprobada dice a qué «no» respondía.
    const h = await app.inject({ method: 'GET', url: '/approvals/history', headers: { cookie: s.owner } });
    expect(diferenciasConElContrato(ApprovalHistory, h.json())).toEqual([]);
    expect((h.json() as ApprovalHistory).requests.find((r) => r.id === id)).toMatchObject({ status: 'APPROVED', reply: 'Ya hablé con usted: es para el depósito de hoy', previousRejection: { requestId: primera } });
  });

  it('el «no» se recuerda 24 horas: pasado ese tiempo, la operación se pide sin respuesta', async () => {
    const op = otroMes();
    await rechazar((await cierre(op)).json().id as string, 'Todavía falta el corte del domingo');
    expect((await cierre(op)).statusCode).toBe(409);
    await envejecer(op, 23 * 60);
    expect((await cierre(op)).json().reason).toBe('APPROVAL_REPLY_REQUIRED');
    await envejecer(op, 61);
    expect((await operacion('reports:month:close', op)).previousRejection).toBeNull();
    const r = await cierre(op);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ previousRejection: null, attempt: 1 });
  });

  it('la misma operación se pide 3 veces por hora: la 4.ª es un 429 que dice con quién hablar y a qué hora se puede otra vez', async () => {
    const op = otroMes();
    for (let i = 1; i <= 3; i++) {
      const r = await cierre(op);
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().attempt).toBe(i);
      // «Volver a pedir» cancela la anterior: las canceladas y las vencidas también cuentan.
      expect((await accion(r.json().id as string, 'cancel', {}, s.gerente)).statusCode).toBe(200);
    }
    const tope = await operacion('reports:month:close', op);
    expect(tope).toMatchObject({ requestsUsed: 3, requestsMax: 3 });
    expect(tope.nextRequestAt).toBeTruthy();

    const cuarta = await cierre(op);
    expect(cuarta.statusCode, cuarta.body).toBe(429);
    expect(cuarta.json()).toMatchObject({ error: 'RATE_LIMITED', reason: 'RATE_LIMITED' });
    expect(cuarta.json().message).toMatch(/^Ya se pidió 3 veces en una hora: habla con .+\. Se puede volver a pedir a las \d{2}:\d{2}\.$/);
    expect(cuarta.json().retryAfterSeconds).toBeGreaterThan(3500);
    expect(cuarta.json().retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(Number(cuarta.headers['retry-after'])).toBe(cuarta.json().retryAfterSeconds);
    // 3.12: la cuarta no crea solicitud, pero que se insistió queda en la bitácora y entra a «Para revisar».
    const insistencias = () => getDb().auditLog.findMany({
      where: { organizationId: g.organizationId, action: 'approval.remote.over_limit', afterState: { path: ['resourceId'], equals: op } }, orderBy: { chainSeq: 'asc' },
    });
    const asentada = await insistencias();
    expect(asentada).toHaveLength(1);
    expect(asentada[0]!.afterState).toMatchObject({ permission: 'reports:month:close', attempt: 4, resourceId: op });
    expect(auditNeedsReview({ action: 'approval.remote.over_limit' })).toBe(true);
    // Otra persona tampoco: el tope es de la operación, no de quien pide. Y otra operación no se entera.
    expect((await cierre(op, {}, s.gerente2)).statusCode).toBe(429);
    expect(await insistencias(), 'cada insistencia deja su asiento, con quién fue').toHaveLength(2);
    expect((await cierre(otroMes())).statusCode).toBe(201);
    expect(await db().approvalRequest.count({ where: { organizationId: g.organizationId, resourceId: op } })).toBe(3);

    // Pasada la hora desde la primera, vuelve a haber lugar.
    await envejecer(op, 61);
    const quinta = await cierre(op);
    expect(quinta.statusCode, quinta.body).toBe(201);
    expect(quinta.json().attempt).toBe(1);
  });

  it('lo que se autorizó no cuenta para el tope: cuatro retiros autorizados del mismo turno en una hora siguen pasando', async () => {
    const op = otroMes();
    for (let i = 0; i < 4; i++) {
      const r = await cierre(op);
      expect(r.statusCode, r.body).toBe(201);
      await aprobar(r.json().id as string);
    }
    expect(await operacion('reports:month:close', op)).toMatchObject({ requestsUsed: 0, nextRequestAt: null });
  });

  it('lo rechazado hace menos de 30 minutos no se firma en el mostrador ni con la contraseña correcta: solo quien firma, desde su sesión', async () => {
    const op = otroMes();
    const firmar = (extra: Record<string, unknown> = {}) => firmaAqui({ permission: 'reports:month:close', resourceType: 'MonthlyClose', resourceId: op, ...extra });
    // Antes del «no», la firma presencial es la de siempre.
    expect((await firmar()).statusCode).toBe(200);
    // Esa firma es de hace dos horas: es anterior al «no» que viene, también cuando la prueba haga pasar el tiempo.
    await db().approvalGrant.updateMany({ where: { organizationId: g.organizationId, resourceId: op }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });

    const rechazada = (await cierre(op)).json().id as string;
    await rechazar(rechazada, 'Falta revisar los gastos de la última semana');
    const fallosAntes = (await db().approvalSignerLock.findUnique({ where: { userId: g.ownerId } }))?.failedCount ?? 0;

    const negada = await firmar();
    expect(negada.statusCode, negada.body).toBe(409);
    expect(negada.json()).toMatchObject({ reason: 'APPROVAL_REJECTED_RECENTLY', detail: 'Pídesela a su teléfono con tu respuesta a ese «no».' });
    expect(negada.json().message).toMatch(/la rechazó hace \d+ min: hasta las \d{2}:\d{2} no se firma aquí, solo desde su teléfono$/);
    // Con una contraseña equivocada la respuesta es la misma y no cuenta en la escalera: aquí no se compara ninguna.
    expect((await firmar({ password: 'no-es-su-contraseña-2026' })).json().reason).toBe('APPROVAL_REJECTED_RECENTLY');
    expect((await firmar({ approverUserId: undefined, email: g.correos.owner })).statusCode).toBe(409);
    expect((await db().approvalSignerLock.findUnique({ where: { userId: g.ownerId } }))?.failedCount ?? 0).toBe(fallosAntes);
    expect(await db().approvalGrant.count({ where: { organizationId: g.organizationId, resourceId: op } })).toBe(1);

    // Cada intento queda en la bitácora y entra a «Para revisar».
    const asientos = await db().auditLog.findMany({ where: { organizationId: g.organizationId, action: 'approval.local.after_reject' }, orderBy: { at: 'asc' } });
    expect(asientos).toHaveLength(3);
    expect(asientos[0]!.afterState).toMatchObject({ permission: 'reports:month:close', resourceId: op, rejectedRequestId: rechazada, rejectedByUserId: g.ownerId, email: `elegido:${g.ownerId}` });
    expect(auditNeedsReview({ action: 'approval.local.after_reject', afterState: asientos[0]!.afterState })).toBe(true);
    expect(auditCategoryOf('approval.local.after_reject')).toBe('personal');
    expect(auditPhrase({ action: 'approval.local.after_reject', afterState: asientos[0]!.afterState })).toBe('intentó firmar en el mostrador una operación rechazada hace menos de 30 minutos');

    // Otra operación se firma en el mostrador sin problema: el candado es de ESA operación.
    expect((await firmaAqui({ permission: 'reports:month:close', resourceType: 'MonthlyClose', resourceId: otroMes() })).statusCode).toBe(200);

    // A los 29 minutos sigue cerrada; a los 31 ya se firma aquí.
    await envejecer(op, 29);
    expect((await firmar()).statusCode).toBe(409);
    await envejecer(op, 2);
    expect((await operacion('reports:month:close', op)).localLockedUntil).toBeNull();
    const firmada = await firmar();
    expect(firmada.statusCode, firmada.body).toBe(200);
    // Y esa firma, dada en persona, deja sin efecto el «no»: ya no se pide respuesta.
    expect((await operacion('reports:month:close', op)).previousRejection).toBeNull();
    expect((await cierre(op)).statusCode).toBe(201);
  });

  it('dentro de los 30 minutos quien firma sí puede autorizarla desde su sesión, y con eso el mostrador se abre', async () => {
    const op = otroMes();
    await rechazar((await cierre(op)).json().id as string, 'Primero cuadra la caja 2');
    const firmar = () => firmaAqui({ permission: 'reports:month:close', resourceType: 'MonthlyClose', resourceId: op });
    expect((await firmar()).statusCode).toBe(409);
    const otra = await cierre(op, { reply: 'Ya cuadró: sobraban 20 pesos de un cambio' });
    expect(otra.statusCode, otra.body).toBe(201);
    await aprobar(otra.json().id as string);
    expect((await estado(otra.json().id as string)).approvalToken).toBeTruthy();
    expect((await firmar()).statusCode).toBe(200);
  });

  it('«Preguntar» en vez de rechazar: la solicitud sigue pendiente con el reloj completo, quien pidió contesta y quien firma decide', async () => {
    const op = otroMes();
    const id = (await cierre(op, { reason: 'Cierre de fin de mes' })).json().id as string;
    await db().approvalRequest.update({ where: { id }, data: { expiresAt: new Date(Date.now() + 30_000) } });
    expect((await estado(id)).secondsLeft).toBeLessThanOrEqual(30);

    // Solo pregunta quien puede firmarla: ni quien la pidió, ni otro gerente, ni recepción.
    expect((await accion(id, 'ask', { question: '¿Ya contaste el cajón?' }, s.gerente)).statusCode).toBe(403);
    expect((await accion(id, 'ask', { question: '¿Ya contaste el cajón?' }, s.gerente2)).statusCode).toBe(404);
    expect((await accion(id, 'ask', { question: '¿Ya contaste el cajón?' }, s.recepcion)).statusCode).toBe(404);
    expect((await accion(id, 'ask', { question: '¿?' }, s.owner)).statusCode).toBe(422);
    // Sin pregunta no hay nada que contestar.
    expect((await accion(id, 'answer', { answer: 'Sí, ya está contado' }, s.gerente)).statusCode).toBe(409);

    const pregunta = await accion(id, 'ask', { question: '¿Ya contaste el cajón?' }, s.owner);
    expect(pregunta.statusCode, pregunta.body).toBe(200);
    const preguntada = await estado(id);
    expect(preguntada).toMatchObject({ status: 'PENDING', rejectReason: null, question: { text: '¿Ya contaste el cajón?', answer: null, answeredAt: null } });
    expect(preguntada.question!.byName).toBeTruthy();
    // No se rechazó nada: la operación no carga ningún «no», y preguntar es haberla visto.
    expect((await operacion('reports:month:close', op)).previousRejection).toBeNull();
    expect(preguntada.seenAt).toBeTruthy();
    // Su reloj vuelve a los diez minutos.
    expect(preguntada.secondsLeft).toBeGreaterThan(APPROVAL_REQUEST_TTL_MS / 1000 - 30);
    // Una pregunta a la vez.
    expect((await accion(id, 'ask', { question: '¿Y la caja 2?' }, s.owner)).statusCode).toBe(409);

    // Contesta solo quien la pidió.
    expect((await accion(id, 'answer', { answer: 'Sí, ya está contado' }, s.gerente2)).statusCode).toBe(404);
    expect((await accion(id, 'answer', { answer: 'Sí, ya está contado' }, s.owner)).statusCode).toBe(404);
    await db().approvalRequest.update({ where: { id }, data: { expiresAt: new Date(Date.now() + 30_000) } });
    const contesta = await accion(id, 'answer', { answer: 'Sí, ya está contado: cuadra con el corte' }, s.gerente);
    expect(contesta.statusCode, contesta.body).toBe(200);
    expect((await accion(id, 'answer', { answer: 'Otra vez' }, s.gerente)).statusCode).toBe(409);

    // La tarjeta de quien firma trae la respuesta, y el reloj volvió a empezar para que alcance a leerla.
    const tarjeta = (await bandeja()).find((r) => r.id === id)!;
    expect(tarjeta.question).toMatchObject({ text: '¿Ya contaste el cajón?', answer: 'Sí, ya está contado: cuadra con el corte' });
    expect(tarjeta.question!.answeredAt).toBeTruthy();
    expect(tarjeta.secondsLeft).toBeGreaterThan(APPROVAL_REQUEST_TTL_MS / 1000 - 30);

    // Ya contestada, puede volver a preguntar; y al final decide como siempre.
    expect((await accion(id, 'ask', { question: '¿Y la caja 2?' }, s.owner)).statusCode).toBe(200);
    expect((await estado(id)).question).toMatchObject({ text: '¿Y la caja 2?', answer: null });
    await aprobar(id);
    expect(await estado(id)).toMatchObject({ status: 'APPROVED', delivery: 'ready' });
    // Decidida, ya no se pregunta ni se contesta.
    expect((await accion(id, 'ask', { question: '¿Sigue en pie?' }, s.owner)).statusCode).toBe(409);
    expect((await accion(id, 'answer', { answer: 'Sí, sigue' }, s.gerente)).statusCode).toBe(409);

    // La bitácora guarda la pregunta y la respuesta con lo que se pidió.
    const asientos = await db().auditLog.findMany({ where: { organizationId: g.organizationId, resourceId: id, action: { in: ['approval.remote.ask', 'approval.remote.answer'] } }, orderBy: { at: 'asc' } });
    expect(asientos.map((a) => a.action)).toEqual(['approval.remote.ask', 'approval.remote.answer', 'approval.remote.ask']);
    expect(asientos[0]!.afterState).toMatchObject({ question: '¿Ya contaste el cajón?' });
    expect(asientos[1]!.afterState).toMatchObject({ question: '¿Ya contaste el cajón?', answer: 'Sí, ya está contado: cuadra con el corte' });
    expect(auditPhrase({ action: 'approval.remote.ask', afterState: asientos[0]!.afterState })).toBe('preguntó antes de autorizar una solicitud · Cerrar el mes');
    expect(auditPhrase({ action: 'approval.remote.answer', afterState: asientos[1]!.afterState })).toBe('contestó lo que le preguntaron sobre una solicitud · Cerrar el mes');
  });

  it('una pregunta sin contestar no detiene el reloj para siempre: la solicitud vence y no deja ningún «no»', async () => {
    const op = otroMes();
    const id = (await cierre(op)).json().id as string;
    expect((await accion(id, 'ask', { question: 'Llámame antes' }, s.owner)).statusCode).toBe(200);
    await db().approvalRequest.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 5000) } });
    expect(await estado(id)).toMatchObject({ status: 'EXPIRED', question: { text: 'Llámame antes', answer: null } });
    expect((await accion(id, 'answer', { answer: 'Ya le marqué' }, s.gerente)).statusCode).toBe(409);
    expect((await operacion('reports:month:close', op)).previousRejection).toBeNull();
    expect((await cierre(op)).statusCode).toBe(201);
  });

  it('las solicitudes de antes de D-03 (sin respuesta ni pregunta) se leen igual que siempre', async () => {
    const op = otroMes();
    const id = (await cierre(op)).json().id as string;
    const fila = await db().approvalRequest.findUniqueOrThrow({ where: { id } });
    expect(fila).toMatchObject({ previousRequestId: null, reply: null, question: null, questionAt: null, questionByUserId: null, answer: null, answeredAt: null });
    expect(await estado(id)).toMatchObject({ previousRejection: null, reply: null, question: null, attempt: 1 });
  });
});
