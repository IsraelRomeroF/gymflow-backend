import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ApprovalApprovers, ApprovalHistory, ApprovalInbox, ApprovalRequestState, diferenciasConElContrato } from '@gymflow/core/contracts';
import { approvalExpiryCause, auditPhrase, uuidv7 } from '@gymflow/core';
import { makeApp, PASSWORD } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { ApprovalReachRepository } from '../src/modules/approvals/approval.repository.js';
import { abrirTurno, gimnasioPropio, sesionesDe, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';

/**
 * BLOQUE 2.10 (auditoría 8, fase 2): la firma a distancia dice la verdad.
 * Quien firma ya está elegido en el mostrador (20-14), el mostrador sabe si
 * quien firma tiene cómo enterarse y qué pasó cuando venció (29-05), y lo
 * resuelto no desaparece: queda en «Resueltas hoy» y en la bitácora con lo
 * que se pidió (20-05). En un gimnasio propio: mueve la escalera de fallos
 * de su dueña y sus sesiones, que en el de todos son de otros archivos.
 */
describe('firma a distancia · bloque 2.10', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let s: { owner: string; gerente: string; gerente2: string; recepcion: string };
  let turno: string;
  const db = () => getDb();
  const sede = () => g.sedes[0]!;

  beforeAll(async () => {
    app = await makeApp(); await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Sede de la firma', cajas: 1 }] });
    s = await sesionesDe(app, g);
    turno = await abrirTurno(app, s.gerente, sede().cajas[0]!);
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  const retiro = (importe: string, extra: Record<string, unknown> = {}) => app.inject({
    method: 'POST', url: '/approvals/requests', headers: { cookie: s.gerente },
    payload: { permission: 'cash:withdraw', branchId: sede().id, resourceType: 'CashSession', resourceId: turno, amountCents: importe, summary: 'Retiro a caja fuerte', ...extra },
  });
  const estado = (id: string, cookie = s.gerente) => app.inject({ method: 'GET', url: `/approvals/requests/${id}`, headers: { cookie } });
  const firmantes = async () => {
    const r = await app.inject({ method: 'GET', url: `/approvals/approvers?permission=cash:withdraw&branchId=${sede().id}&amountCents=15000`, headers: { cookie: s.gerente } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(ApprovalApprovers, r.json())).toEqual([]);
    return r.json() as ApprovalApprovers;
  };
  const firmaAqui = (payload: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/approvals', headers: { cookie: s.gerente },
    payload: { permission: 'cash:withdraw', branchId: sede().id, resourceType: 'CashSession', resourceId: turno, amountCents: '15000', ...payload },
  });
  const historial = async (cookie: string) => {
    const r = await app.inject({ method: 'GET', url: '/approvals/history', headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(ApprovalHistory, r.json())).toEqual([]);
    return r.json() as ApprovalHistory;
  };

  it('«Pueden autorizar» dice cómo se va a enterar cada quien: panel abierto, avisos en su teléfono o ninguna (29-05)', async () => {
    // La dueña acaba de entrar: tiene el panel abierto.
    const antes = await firmantes();
    expect(antes.approvers).toHaveLength(1);
    expect(antes.approvers[0]).toMatchObject({ userId: g.ownerId, reach: 'panel', pausedUntil: null });

    // Sin actividad en el panel desde hace una hora y sin avisos: solo la verá si abre el panel.
    await db().session.updateMany({ where: { userId: g.ownerId }, data: { lastSeenAt: new Date(Date.now() - 60 * 60_000) } });
    expect((await firmantes()).approvers[0]!.reach).toBe('none');

    // Con el aviso vivo en su teléfono, eso manda; una suscripción muerta o un servidor sin llaves no cuentan.
    const sub = uuidv7();
    await db().pushSubscription.create({ data: { id: sub, organizationId: g.organizationId, userId: g.ownerId, endpoint: `https://push.invalid/${sub}`, p256dh: 'x', auth: 'y' } });
    const alcance = new ApprovalReachRepository(g.organizationId);
    expect((await alcance.reachOf([g.ownerId], true)).get(g.ownerId)).toBe('push');
    expect((await alcance.reachOf([g.ownerId], false)).get(g.ownerId)).toBe('none');
    await db().pushSubscription.updateMany({ where: { id: sub }, data: { failedAt: new Date() } });
    expect((await alcance.reachOf([g.ownerId], true)).get(g.ownerId)).toBe('none');

    await db().session.updateMany({ where: { userId: g.ownerId }, data: { lastSeenAt: new Date() } });
    expect((await firmantes()).approvers[0]!.reach).toBe('panel');
  });

  it('en el mostrador la dueña firma sin teclear su correo: basta elegirla y su contraseña (20-14)', async () => {
    const bien = await firmaAqui({ approverUserId: g.ownerId, password: PASSWORD });
    expect(bien.statusCode, bien.body).toBe(200);
    expect(bien.json().approvalToken).toBeTruthy();
    // Con su correo sigue valiendo, como siempre.
    expect((await firmaAqui({ email: g.correos.owner, password: PASSWORD })).statusCode).toBe(200);

    // Ni las dos formas a la vez ni ninguna.
    expect((await firmaAqui({ approverUserId: g.ownerId, email: g.correos.owner, password: PASSWORD })).statusCode).toBe(422);
    expect((await firmaAqui({ password: PASSWORD })).statusCode).toBe(422);

    // Elegir a alguien no le da la firma: otro gerente sigue sin poder, alguien de otro gimnasio no existe, y nadie se firma solo.
    const otroGerente = await db().user.findFirstOrThrow({ where: { email: g.correos.gerente2 } });
    expect((await firmaAqui({ approverUserId: otroGerente.id, password: PASSWORD })).statusCode).toBe(403);
    const ajeno = await db().user.findFirstOrThrow({ where: { email: 'owner@demo.mx' } });
    expect((await firmaAqui({ approverUserId: ajeno.id, password: PASSWORD })).statusCode).toBe(401);
    const yo = await db().user.findFirstOrThrow({ where: { email: g.correos.gerente } });
    expect((await firmaAqui({ approverUserId: yo.id, password: PASSWORD })).statusCode).toBe(403);

    // La contraseña equivocada cuenta en la escalera de SUS firmas y queda asentada con a quién se eligió.
    const mal = await firmaAqui({ approverUserId: g.ownerId, password: 'no-es-su-contraseña-2026' });
    expect(mal.statusCode, mal.body).toBe(401);
    const fallo = await db().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'approval.local.fail' }, orderBy: { at: 'desc' } });
    expect(fallo.afterState).toMatchObject({ cause: 'CONTRASENA', signerUserId: g.ownerId, email: `elegido:${g.ownerId}` });
    expect((await db().approvalSignerLock.findUniqueOrThrow({ where: { userId: g.ownerId } })).failedCount).toBe(1);
  });

  it('la solicitud guarda si quien firma la tuvo a la vista: el contador del marco no cuenta, la bandeja abierta sí (29-05)', async () => {
    const pedida = await retiro('15000', { reason: 'Depósito al banco' });
    expect(pedida.statusCode, pedida.body).toBe(201);
    const id = pedida.json().id as string;
    expect(pedida.json()).toMatchObject({ notifiedCount: 0, seenAt: null });

    // El marco del panel pregunta cuántas hay (sin `seen`): eso no es haberla visto.
    const marco = await app.inject({ method: 'GET', url: '/approvals/inbox', headers: { cookie: s.owner } });
    expect(diferenciasConElContrato(ApprovalInbox, marco.json())).toEqual([]);
    expect((marco.json() as ApprovalInbox).requests.find((r) => r.id === id)?.seenAt).toBeNull();
    expect((await estado(id)).json().seenAt).toBeNull();

    // La bandeja abierta sí, y solo la primera vez queda la hora.
    const bandeja = await app.inject({ method: 'GET', url: '/approvals/inbox?seen=1', headers: { cookie: s.owner } });
    const vista = (bandeja.json() as ApprovalInbox).requests.find((r) => r.id === id)?.seenAt;
    expect(vista).toBeTruthy();
    await app.inject({ method: 'GET', url: '/approvals/inbox?seen=1', headers: { cookie: s.owner } });
    const st = await estado(id);
    expect(diferenciasConElContrato(ApprovalRequestState, st.json())).toEqual([]);
    expect(st.json().seenAt).toBe(vista);
    // Quien no puede firmarla no la «ve» por abrir su bandeja.
    expect((await app.inject({ method: 'GET', url: '/approvals/inbox?seen=maybe', headers: { cookie: s.owner } })).statusCode).toBe(422);

    // El motivo de quien pide queda en el asiento, y la frase dice qué se pidió (20-05).
    const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'approval.remote.request', resourceId: id } });
    expect(asiento.reason).toBe('Depósito al banco');
    expect(auditPhrase({ action: asiento.action, afterState: asiento.afterState })).toBe('pidió una autorización al teléfono de $150.00 · Retiro a caja fuerte');

    // Vence: el mostrador lee que la tuvo a la vista y no contestó, no «nadie la contestó».
    await db().approvalRequest.updateMany({ where: { id }, data: { expiresAt: new Date(Date.now() - 5000) } });
    const vencida = (await estado(id)).json();
    expect(vencida.status).toBe('EXPIRED');
    expect(approvalExpiryCause(vencida)).toBe('seen');
  });

  it('una que nadie vio vence como «no la vio», y si salió el aviso al teléfono, como «le llegó» (29-05)', async () => {
    const id = (await retiro('12000')).json().id as string;
    await db().approvalRequest.updateMany({ where: { id }, data: { expiresAt: new Date(Date.now() - 5000) } });
    expect(approvalExpiryCause((await estado(id)).json())).toBe('unseen');

    const { ApprovalRequestRepository } = await import('../src/modules/approvals/approval.repository.js');
    const otra = (await retiro('13000')).json().id as string;
    const repo = new ApprovalRequestRepository(g.organizationId);
    await repo.markNotified(otra, 0);
    expect((await estado(otra)).json().notifiedCount).toBe(0);
    await repo.markNotified(otra, 2);
    const fila = await db().approvalRequest.findUniqueOrThrow({ where: { id: otra } });
    expect(fila.notifiedCount).toBe(2);
    expect(fila.deliveredAt).toBeInstanceOf(Date);
    await db().approvalRequest.updateMany({ where: { id: otra }, data: { expiresAt: new Date(Date.now() - 5000) } });
    expect(approvalExpiryCause((await estado(otra)).json())).toBe('notified');
  });

  it('«Resueltas hoy»: la dueña ve todo con su desenlace; quien pide, solo lo suyo; recepción, nada ajeno (20-05)', async () => {
    const socio = await socioPropio(g);
    const aprobada = (await retiro('20000', { reason: 'Corte de la tarde' })).json().id as string;
    const rechazada = (await retiro('21000')).json().id as string;
    const cancelada = (await retiro('22000')).json().id as string;
    const vencida = (await retiro('23000')).json().id as string;
    const pendiente = (await retiro('24000')).json().id as string;
    // Una de otro gerente, sobre un socio: la dueña la ve; el primer gerente no.
    const deOtro = (await app.inject({
      method: 'POST', url: '/approvals/requests', headers: { cookie: s.gerente2 },
      payload: { permission: 'members:anonymize', branchId: sede().id, resourceType: 'Member', resourceId: socio, summary: 'Anonimizar a un socio' },
    })).json().id as string;

    expect((await app.inject({ method: 'POST', url: `/approvals/requests/${aprobada}/approve`, headers: { cookie: s.owner }, payload: { password: PASSWORD } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/approvals/requests/${rechazada}/reject`, headers: { cookie: s.owner }, payload: { reason: 'Ese efectivo lo cuento yo mañana' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/approvals/requests/${cancelada}/cancel`, headers: { cookie: s.gerente }, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/approvals/requests/${deOtro}/reject`, headers: { cookie: s.owner }, payload: { reason: 'Falta su solicitud firmada' } })).statusCode).toBe(200);
    // Vence sin que nadie la vuelva a leer: el historial la cierra y la muestra.
    await db().approvalRequest.updateMany({ where: { id: vencida }, data: { expiresAt: new Date(Date.now() - 5000) } });

    const duena = await historial(s.owner);
    expect(duena.scope).toBe('all');
    expect(duena.windowHours).toBe(24);
    const de = (h: ApprovalHistory, id: string) => h.requests.find((r) => r.id === id);
    expect(de(duena, aprobada)).toMatchObject({ status: 'APPROVED', delivery: 'ready', mine: false, reason: 'Corte de la tarde', amountCents: '20000', context: expect.stringMatching(/^Turno de /) });
    expect(de(duena, aprobada)!.approverName).toBeTruthy();
    expect(de(duena, rechazada)).toMatchObject({ status: 'REJECTED', rejectReason: 'Ese efectivo lo cuento yo mañana', delivery: null });
    expect(de(duena, cancelada)).toMatchObject({ status: 'CANCELED' });
    expect(de(duena, vencida)).toMatchObject({ status: 'EXPIRED', seenAt: null, notifiedCount: 0 });
    expect(de(duena, deOtro)).toMatchObject({ status: 'REJECTED', context: expect.stringMatching(/^Socio /) });
    // Lo pendiente no es «resuelto», y la lista va de la más reciente a la más vieja.
    expect(de(duena, pendiente)).toBeUndefined();
    const creadas = duena.requests.map((r) => r.createdAt);
    expect(creadas).toEqual([...creadas].sort().reverse());
    expect(await db().auditLog.count({ where: { organizationId: g.organizationId, action: 'approval.remote.expire', resourceId: vencida } })).toBe(1);

    // La firma usada se lee como «la operación se registró».
    const token = (await estado(aprobada)).json().approvalToken as string;
    const mov = await app.inject({
      method: 'POST', url: `/cash-sessions/${turno}/movements`, headers: { cookie: s.gerente },
      payload: { movementType: 'WITHDRAWAL', amountCents: '20000', reason: 'Corte de la tarde', approvalToken: token },
    });
    expect(mov.statusCode, mov.body).toBeLessThan(300);
    expect(de(await historial(s.owner), aprobada)!.delivery).toBe('used');

    // Quien pide ve lo suyo, con el «no» y su motivo, y nada de lo que pidió otra persona.
    const gerente = await historial(s.gerente);
    expect(gerente.scope).toBe('mine');
    expect(gerente.requests.every((r) => r.mine)).toBe(true);
    expect(de(gerente, rechazada)).toMatchObject({ status: 'REJECTED', rejectReason: 'Ese efectivo lo cuento yo mañana' });
    expect(de(gerente, deOtro)).toBeUndefined();
    expect((await historial(s.recepcion)).requests).toEqual([]);

    // Lo de ayer ya no está en «Resueltas hoy».
    await db().approvalRequest.updateMany({ where: { id: rechazada }, data: { decidedAt: new Date(Date.now() - 25 * 3_600_000) } });
    expect(de(await historial(s.owner), rechazada)).toBeUndefined();

    await app.inject({ method: 'POST', url: `/approvals/requests/${pendiente}/cancel`, headers: { cookie: s.gerente }, payload: {} });
  });

  it('otro gimnasio no ve nada de este en su historial ni puede leer sus solicitudes', async () => {
    const { loginAs } = await import('./helpers.js');
    const ajena = await loginAs(app, 'owner@demo.mx');
    const mia = (await retiro('9000')).json().id as string;
    expect((await historial(ajena)).requests.some((r) => r.id === mia)).toBe(false);
    expect((await estado(mia, ajena)).statusCode).toBe(404);
    await app.inject({ method: 'POST', url: `/approvals/requests/${mia}/cancel`, headers: { cookie: s.gerente }, payload: {} });
  });
});
