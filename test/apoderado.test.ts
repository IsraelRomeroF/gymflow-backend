import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ApprovalApprovers, ApprovalHistory, ApprovalInbox, ApprovalProxyAppointment, ApprovalProxyState, ApprovalRequestState, diferenciasConElContrato } from '@gymflow/core/contracts';
import {
  APPROVAL_PROXY_MAX_DAYS, approvalProxyActive, approvalProxyLastDay, auditCategoryOf, auditNeedsReview, auditPhrase, isoDate, businessDateIn, monthlyCloseResourceId,
} from '@gymflow/core';
import { makeApp, PASSWORD, loginAs, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { APPROVAL_JOBS } from '../src/modules/approvals/index.js';
import { finDelDia } from '../src/modules/approvals/approval-proxy.service.js';
import { abrirTurno, gimnasioPropio, sesionesDe, type GimnasioPropio } from './gimnasio-propio.js';

/**
 * BLOQUE 3.1 (auditoría 8, fase 3) · D-02, opción (b): APODERADO TEMPORAL.
 * El dueño (uno solo) nombra a una persona con fecha de fin; esa persona firma
 * lo de los demás, nunca lo suyo, con la autoridad del dueño; la bitácora dice
 * «firmó como apoderado»; no autoriza lo que otra persona rechazó; el
 * nombramiento caduca solo, se revoca, y nombrar y revocar quedan asentados.
 *
 * En un gimnasio propio. Nada depende de la hora real: el paso del tiempo se
 * hace moviendo las fechas de las filas, y los días se piden relativos al
 * «hoy» del gimnasio.
 */
describe('firmas · D-02: apoderado temporal (bloque 3.1)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let s: { owner: string; gerente: string; gerente2: string; recepcion: string };
  let ids: { gerente: string; gerente2: string; recepcion: string };
  let duena: string;
  let turno: string;
  const db = () => getDb();
  const ZONA = 'America/Mexico_City';
  const sede = () => g.sedes[0]!;
  let mes = 0;
  /** Una operación distinta cada vez: el cierre de un mes es un registro que no necesita existir (20-01). */
  const otroMes = () => monthlyCloseResourceId(`2032-${String((mes++ % 12) + 1).padStart(2, '0')}`);
  const hoy = () => isoDate(businessDateIn(ZONA));
  const enDias = (n: number) => { const d = new Date(`${hoy()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  beforeAll(async () => {
    app = await makeApp(); await app.ready();
    g = await gimnasioPropio({ zona: ZONA, sedes: [{ name: 'Sede del apoderado', cajas: 1 }] });
    s = await sesionesDe(app, g);
    const cuenta = async (correo: string) => (await db().user.findFirstOrThrow({ where: { organizationId: g.organizationId, email: correo }, select: { id: true } })).id;
    ids = { gerente: await cuenta(g.correos.gerente), gerente2: await cuenta(g.correos.gerente2), recepcion: await cuenta(g.correos.recepcion) };
    duena = (await db().user.findUniqueOrThrow({ where: { id: g.ownerId }, select: { fullName: true } })).fullName;
    turno = await abrirTurno(app, s.gerente, sede().cajas[0]!);
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  const post = (url: string, payload: Record<string, unknown>, cookie: string) => app.inject({ method: 'POST', url, headers: { cookie }, payload });
  const estadoDelApoderado = async (cookie: string) => {
    const r = await app.inject({ method: 'GET', url: '/approvals/proxy', headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(ApprovalProxyState, r.json())).toEqual([]);
    return r.json() as ApprovalProxyState;
  };
  const nombrar = (proxyUserId: string, extra: Record<string, unknown> = {}, cookie = s.owner) =>
    post('/approvals/proxy', { proxyUserId, endsOn: enDias(3), password: PASSWORD, ...extra }, cookie);
  const revocar = (cookie = s.owner) => post('/approvals/proxy/revoke', {}, cookie);
  /** Deja el gimnasio sin apoderado, pase lo que pase en el caso anterior. */
  const limpio = async () => { await revocar(); };
  const cierre = (resourceId: string, extra: Record<string, unknown> = {}, cookie = s.gerente) =>
    post('/approvals/requests', { permission: 'reports:month:close', resourceType: 'MonthlyClose', resourceId, summary: 'Cerrar el mes', ...extra }, cookie);
  const accion = (id: string, cual: 'approve' | 'reject' | 'ask', payload: Record<string, unknown>, cookie: string) => post(`/approvals/requests/${id}/${cual}`, payload, cookie);
  const estado = async (id: string, cookie = s.gerente) => {
    const r = await app.inject({ method: 'GET', url: `/approvals/requests/${id}`, headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(ApprovalRequestState, r.json())).toEqual([]);
    return r.json() as ApprovalRequestState;
  };
  const quienes = async (resourceId: string, cookie = s.gerente) => {
    const r = await app.inject({ method: 'GET', url: `/approvals/approvers?permission=reports:month:close&resourceId=${resourceId}`, headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(ApprovalApprovers, r.json())).toEqual([]);
    return (r.json() as ApprovalApprovers).approvers;
  };
  const bandeja = async (cookie: string) => {
    const r = await app.inject({ method: 'GET', url: '/approvals/inbox', headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(ApprovalInbox, r.json())).toEqual([]);
    return (r.json() as ApprovalInbox).requests;
  };
  const permisos = async (cookie: string) => ((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json().permissions as string[]);
  const asientos = (action: string, resourceId?: string) => db().auditLog.findMany({ where: { organizationId: g.organizationId, action, ...(resourceId ? { resourceId } : {}) }, orderBy: { id: 'asc' } });
  /** Pasa el tiempo para una operación: sus solicitudes se piden y se deciden `minutos` antes. */
  const envejecer = async (resourceId: string, minutos: number) => {
    for (const f of await db().approvalRequest.findMany({ where: { organizationId: g.organizationId, resourceId } })) {
      await db().approvalRequest.update({ where: { id: f.id }, data: {
        createdAt: new Date(f.createdAt.getTime() - minutos * 60_000),
        ...(f.decidedAt ? { decidedAt: new Date(f.decidedAt.getTime() - minutos * 60_000) } : {}),
      } });
    }
  };

  it('las reglas viven en el núcleo: 30 días como mucho, y vale mientras esté abierto y su fecha no haya pasado', () => {
    expect(APPROVAL_PROXY_MAX_DAYS).toBe(30);
    expect(approvalProxyLastDay('2026-11-24')).toBe('2026-12-23');
    const ahora = new Date('2026-11-24T18:00:00.000Z');
    expect(approvalProxyActive({ endsAt: new Date('2026-11-25T06:00:00.000Z'), endedAt: null }, ahora)).toBe(true);
    expect(approvalProxyActive({ endsAt: new Date('2026-11-24T18:00:00.000Z'), endedAt: null }, ahora)).toBe(false);
    expect(approvalProxyActive({ endsAt: new Date('2026-11-25T06:00:00.000Z'), endedAt: new Date('2026-11-24T17:00:00.000Z') }, ahora)).toBe(false);
    // El último día vale completo, en la zona del gimnasio: termina a su medianoche.
    expect(finDelDia('America/Mexico_City', '2026-11-24').toISOString()).toBe('2026-11-25T06:00:00.000Z');
    expect(finDelDia('America/Tijuana', '2026-07-01').toISOString()).toBe('2026-07-02T07:00:00.000Z');
  });

  it('sin apoderado todo sigue como antes: solo el dueño firma, y solo él ve a quién puede nombrar', async () => {
    const d = await estadoDelApoderado(s.owner);
    expect(d).toMatchObject({ canManage: true, mine: false, current: null, history: [], today: hoy(), lastDay: approvalProxyLastDay(hoy()), maxDays: 30 });
    expect(d.candidates.map((c) => c.userId).sort()).toEqual([ids.gerente, ids.gerente2, ids.recepcion].sort());
    expect(d.candidates.find((c) => c.userId === ids.recepcion)).toMatchObject({ roleLabel: 'Recepción', cannotSignYet: false });
    for (const cookie of [s.gerente, s.recepcion]) {
      expect(await estadoDelApoderado(cookie)).toMatchObject({ canManage: false, mine: false, current: null, candidates: [], history: [] });
    }
    const op = otroMes();
    expect(await quienes(op)).toMatchObject([{ userId: g.ownerId, proxyOf: null }]);
    expect(await permisos(s.gerente2)).not.toContain('approvals:proxy');
    // Quien no es apoderado sigue sin poder firmar lo de otro.
    const pedida = (await cierre(op)).json().id as string;
    expect((await accion(pedida, 'approve', { password: PASSWORD }, s.gerente2)).statusCode).toBe(403);
    expect(await bandeja(s.gerente2)).toEqual([]);
  });

  it('solo el dueño nombra, con su contraseña y con una fecha de fin dentro de 30 días; el nombramiento queda en la bitácora', async () => {
    await limpio();
    // Nadie más nombra, ni con la contraseña correcta.
    expect((await nombrar(ids.recepcion, {}, s.gerente)).statusCode).toBe(403);
    expect((await nombrar(ids.gerente, {}, s.recepcion)).statusCode).toBe(403);
    // Sin la contraseña del dueño no hay nombramiento, y el fallo se asienta.
    const mala = await nombrar(ids.gerente2, { password: 'no-es-la-contraseña' });
    expect(mala.statusCode, mala.body).toBe(401);
    expect((await estadoDelApoderado(s.owner)).current).toBeNull();
    expect((await asientos('approval.remote.fail', ids.gerente2)).at(-1)!.afterState).toMatchObject({ context: 'proxy.grant', failedCount: 1 });
    // La persona: otra, activa y de este gimnasio.
    const aSiMisma = await nombrar(g.ownerId);
    expect(aSiMisma.statusCode, aSiMisma.body).toBe(422);
    expect(aSiMisma.json().reason).toBe('APPROVAL_PROXY_INVALID_PERSON');
    const ajena = await db().user.findFirstOrThrow({ where: { organizationId: { not: g.organizationId }, isActive: true, NOT: { organizationId: null } }, select: { id: true } });
    expect((await nombrar(ajena.id)).json().reason).toBe('APPROVAL_PROXY_INVALID_PERSON');
    // La fecha: ni ayer, ni más allá del último día.
    for (const endsOn of [enDias(-1), enDias(APPROVAL_PROXY_MAX_DAYS)]) {
      const r = await nombrar(ids.gerente2, { endsOn });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().reason).toBe('APPROVAL_PROXY_INVALID_END');
    }
    expect((await nombrar(ids.gerente2, { endsOn: '2026-02-30x' })).statusCode).toBe(422);

    const bien = await nombrar(ids.gerente2, { endsOn: enDias(APPROVAL_PROXY_MAX_DAYS - 1), note: 'Salgo de viaje' });
    expect(bien.statusCode, bien.body).toBe(201);
    expect(diferenciasConElContrato(ApprovalProxyAppointment, bien.json())).toEqual([]);
    expect(bien.json()).toMatchObject({
      proxyUserId: ids.gerente2, grantedByUserId: g.ownerId, grantedByName: duena, note: 'Salgo de viaje', active: true, endedAt: null, endReason: null, signedCount: 0, rejectedCount: 0,
      endsAt: finDelDia(ZONA, enDias(APPROVAL_PROXY_MAX_DAYS - 1)).toISOString(),
    });

    const [asiento] = await asientos('approval.proxy.grant', ids.gerente2);
    expect(asiento).toMatchObject({ actorUserId: g.ownerId, resourceType: 'User', reason: 'Salgo de viaje' });
    expect(asiento!.afterState).toMatchObject({ proxyId: bien.json().id, endsOn: enDias(APPROVAL_PROXY_MAX_DAYS - 1) });
    expect(auditNeedsReview({ action: 'approval.proxy.grant', afterState: asiento!.afterState })).toBe(true);
    expect(auditCategoryOf('approval.proxy.grant')).toBe('personal');
    expect(auditPhrase({ action: 'approval.proxy.grant', afterState: { endsOn: '2026-12-05' } }, { person: 'Ana Ruiz' })).toBe('nombró apoderado temporal a Ana Ruiz, hasta el 5 de diciembre de 2026');

    // Lo ven quien lo dio y quien lo tiene; a los demás no les toca.
    expect((await estadoDelApoderado(s.owner)).current).toMatchObject({ id: bien.json().id, active: true });
    expect(await estadoDelApoderado(s.gerente2)).toMatchObject({ canManage: false, mine: true, current: { id: bien.json().id }, candidates: [] });
    expect((await estadoDelApoderado(s.recepcion)).current).toBeNull();
  });

  it('el apoderado ve Autorizaciones, pero no recibe la firma del dueño: no nombra, ni firma lo que es solo del dueño', async () => {
    await limpio();
    expect((await nombrar(ids.gerente2)).statusCode).toBe(201);
    const p = await permisos(s.gerente2);
    expect(p).toContain('approvals:proxy');
    expect(p).not.toContain('approvals:grant');
    // Ningún puesto trae ese permiso: lo da el nombramiento, y solo a esa persona.
    expect(await permisos(s.gerente)).not.toContain('approvals:proxy');
    expect(await permisos(s.owner)).not.toContain('approvals:proxy');
    // Un apoderado no nombra a otro ni se quita el nombramiento por su cuenta.
    expect((await nombrar(ids.recepcion, {}, s.gerente2)).statusCode).toBe(403);
    expect((await revocar(s.gerente2)).statusCode).toBe(403);
    // Lo que es solo del dueño (firmar el aviso de privacidad) sigue cerrado para él.
    expect((await post('/consent-documents/018f0000-0000-7000-8000-00000000a002/sign', { password: PASSWORD }, s.gerente2)).statusCode).toBe(403);
  });

  it('firma lo que piden los demás con la autoridad del dueño, y queda «firmó como apoderado de …»', async () => {
    await limpio();
    const nombramiento = (await nombrar(ids.gerente2)).json().id as string;
    const op = otroMes();
    // Quien pide ve a los dos: al dueño y a su apoderado, con de quién lo es.
    const pueden = await quienes(op);
    expect(pueden.find((a) => a.userId === g.ownerId)).toMatchObject({ proxyOf: null });
    expect(pueden.find((a) => a.userId === ids.gerente2)).toMatchObject({ proxyOf: duena });
    expect(pueden).toHaveLength(2);

    const pedida = (await cierre(op)).json().id as string;
    expect((await bandeja(s.gerente2)).map((r) => r.id)).toContain(pedida);
    // Con SU contraseña; una equivocada cuenta en su escalera, como la de cualquiera que firma.
    expect((await accion(pedida, 'approve', { password: 'no-es-la-contraseña' }, s.gerente2)).statusCode).toBe(401);
    const si = await accion(pedida, 'approve', { password: PASSWORD }, s.gerente2);
    expect(si.statusCode, si.body).toBe(200);

    const e = await estado(pedida);
    expect(e).toMatchObject({ status: 'APPROVED', approverProxyOf: duena, delivery: 'ready' });
    expect(e.approvalToken).toBeTruthy();
    const fila = await db().approvalRequest.findUniqueOrThrow({ where: { id: pedida } });
    expect(fila).toMatchObject({ approverUserId: ids.gerente2, proxyId: nombramiento });
    expect(await db().approvalGrant.findUniqueOrThrow({ where: { id: fila.grantId! } })).toMatchObject({ approverUserId: ids.gerente2, proxyId: nombramiento });

    const [asiento] = await asientos('approval.remote.approve', pedida);
    expect(asiento).toMatchObject({ actorUserId: ids.gerente2 });
    expect(asiento!.afterState).toMatchObject({ asProxy: true, proxyId: nombramiento, proxyOfUserId: g.ownerId, proxyOfName: duena });
    expect(auditPhrase({ action: 'approval.remote.approve', afterState: asiento!.afterState })).toBe(`autorizó desde su teléfono · firmó como apoderado de ${duena} · Cerrar el mes`);

    // «Resueltas hoy» lo dice para el dueño y para el apoderado; lo que firmó el dueño no lleva nada.
    const otra = (await cierre(otroMes())).json().id as string;
    expect((await accion(otra, 'approve', { password: PASSWORD }, s.owner)).statusCode).toBe(200);
    for (const cookie of [s.owner, s.gerente2]) {
      const r = await app.inject({ method: 'GET', url: '/approvals/history', headers: { cookie } });
      expect(diferenciasConElContrato(ApprovalHistory, r.json())).toEqual([]);
      const h = r.json() as ApprovalHistory;
      expect(h.scope).toBe('all');
      expect(h.requests.find((x) => x.id === pedida)).toMatchObject({ status: 'APPROVED', approverProxyOf: duena });
      expect(h.requests.find((x) => x.id === otra)).toMatchObject({ status: 'APPROVED', approverProxyOf: null });
    }
    expect((await estadoDelApoderado(s.owner)).current).toMatchObject({ signedCount: 1, rejectedCount: 0 });
  });

  it('la firma del apoderado sirve para la operación, y también firma en el mostrador con su contraseña', async () => {
    await limpio();
    const nombramiento = (await nombrar(ids.gerente2)).json().id as string;
    // A distancia: el retiro que pide la gerente lo autoriza el apoderado y el retiro se registra.
    const pedida = (await post('/approvals/requests', {
      permission: 'cash:withdraw', branchId: sede().id, resourceType: 'CashSession', resourceId: turno, amountCents: '20000', summary: 'Retiro a caja fuerte',
    }, s.gerente)).json().id as string;
    expect((await accion(pedida, 'approve', { password: PASSWORD }, s.gerente2)).statusCode).toBe(200);
    const token = (await estado(pedida)).approvalToken!;
    const retiro = await post(`/cash-sessions/${turno}/movements`, { movementType: 'WITHDRAWAL', amountCents: '20000', reason: 'Corte de la tarde', approvalToken: token }, s.gerente);
    expect(retiro.statusCode, retiro.body).toBeLessThan(300);
    // El asiento de la OPERACIÓN también lo dice (3.16): «· se autorizó como apoderado de …».
    const delRetiro = (await db().auditLog.findMany({ where: { organizationId: g.organizationId, approvedByUserId: ids.gerente2, NOT: { action: { startsWith: 'approval.' } } }, orderBy: { id: 'asc' } })).at(-1)!;
    expect(delRetiro.action).toMatch(/^cash\./);
    expect(delRetiro.afterState).toMatchObject({ approvedAsProxy: true, approvedProxyId: nombramiento, approvedProxyOfUserId: g.ownerId, approvedProxyOfName: duena });
    expect(auditPhrase({ action: delRetiro.action, afterState: delRetiro.afterState })).toMatch(new RegExp(` · se autorizó como apoderado de ${duena}$`));
    // Lo que firma la dueña por su puesto no lleva la nota.
    const firmaDeLaDuena = await aprobacion(app, s.gerente, 'cash:withdraw', g.correos.owner, sede().id, { resourceId: turno, amountCents: '10000' });
    expect((await post(`/cash-sessions/${turno}/movements`, { movementType: 'WITHDRAWAL', amountCents: '10000', reason: 'Otro retiro', approvalToken: firmaDeLaDuena }, s.gerente)).statusCode).toBeLessThan(300);
    const delSegundo = (await db().auditLog.findMany({ where: { organizationId: g.organizationId, approvedByUserId: g.ownerId, action: delRetiro.action }, orderBy: { id: 'asc' } })).at(-1)!;
    expect((delSegundo.afterState as Record<string, unknown>).approvedAsProxy).toBeUndefined();
    expect(auditPhrase({ action: delSegundo.action, afterState: delSegundo.afterState })).not.toMatch(/apoderado/);

    // En el mostrador: recepción pide y el apoderado teclea SU contraseña.
    const op = otroMes();
    const aqui = await post('/approvals', { approverUserId: ids.gerente2, password: PASSWORD, permission: 'reports:month:close', resourceType: 'MonthlyClose', resourceId: op }, s.gerente);
    expect(aqui.statusCode, aqui.body).toBe(200);
    expect(aqui.json()).toMatchObject({ approverProxyOf: duena });
    expect(aqui.json().approvalToken).toBeTruthy();
    const local = (await asientos('approval.local.issue')).at(-1)!;
    expect(local).toMatchObject({ actorUserId: ids.gerente, approvedByUserId: ids.gerente2 });
    expect(local.afterState).toMatchObject({ asProxy: true, proxyId: nombramiento, proxyOfName: duena });
    expect(auditPhrase({ action: 'approval.local.issue', afterState: local.afterState })).toBe(`obtuvo una firma en el mostrador · firmó como apoderado de ${duena}`);
  });

  it('nunca lo suyo: ni a distancia ni en el mostrador, y lo que pide el apoderado solo lo puede firmar el dueño', async () => {
    await limpio();
    expect((await nombrar(ids.gerente2)).statusCode).toBe(201);
    const op = otroMes();
    // Para lo que pide el apoderado, «pueden autorizar» es solo el dueño.
    expect((await quienes(op, s.gerente2)).map((a) => a.userId)).toEqual([g.ownerId]);
    const suya = (await cierre(op, {}, s.gerente2)).json().id as string;
    expect((await bandeja(s.gerente2)).map((r) => r.id)).not.toContain(suya);
    const propia = await accion(suya, 'approve', { password: PASSWORD }, s.gerente2);
    expect(propia.statusCode).toBe(403);
    expect((await estado(suya, s.gerente2)).status).toBe('PENDING');
    const aqui = await post('/approvals', { approverUserId: ids.gerente2, password: PASSWORD, permission: 'reports:month:close', resourceType: 'MonthlyClose', resourceId: otroMes() }, s.gerente2);
    expect(aqui.statusCode).toBe(403);
    // El dueño sí.
    expect((await accion(suya, 'approve', { password: PASSWORD }, s.owner)).statusCode).toBe(200);
    expect((await estado(suya, s.gerente2)).approverProxyOf).toBeNull();
  });

  it('no autoriza lo que el dueño rechazó mientras ese «no» siga vigente: ni la ve, ni a distancia, ni en el mostrador', async () => {
    await limpio();
    expect((await nombrar(ids.gerente2)).statusCode).toBe(201);
    const op = otroMes();
    const primera = (await cierre(op)).json().id as string;
    expect((await accion(primera, 'reject', { reason: 'Ese mes lo reviso yo' }, s.owner)).statusCode).toBe(200);

    // Al volver a pedirla (con su respuesta), solo el dueño puede autorizarla.
    expect((await quienes(op)).map((a) => a.userId)).toEqual([g.ownerId]);
    const segunda = (await cierre(op, { reply: 'Ya está todo cuadrado' })).json().id as string;
    expect((await bandeja(s.gerente2)).map((r) => r.id)).not.toContain(segunda);
    expect((await bandeja(s.owner)).map((r) => r.id)).toContain(segunda);

    // Aunque la pida por su id: no pasa, no cuenta como firma, y queda en «Para revisar».
    const intento = await accion(segunda, 'approve', { password: PASSWORD }, s.gerente2);
    expect(intento.statusCode, intento.body).toBe(403);
    expect(intento.json()).toMatchObject({ reason: 'APPROVAL_PROXY_BLOCKED_BY_REJECTION' });
    expect(intento.json().message).toContain(duena);
    const [bloqueo] = await asientos('approval.proxy.blocked', segunda);
    expect(bloqueo).toMatchObject({ actorUserId: ids.gerente2 });
    expect(auditNeedsReview({ action: 'approval.proxy.blocked', afterState: bloqueo!.afterState })).toBe(true);
    expect(auditPhrase({ action: 'approval.proxy.blocked', afterState: bloqueo!.afterState })).toBe('intentó autorizar como apoderado una operación que otra persona ya había rechazado');
    expect((await estado(segunda)).status).toBe('PENDING');
    // Tampoco la rechaza ni pregunta: para él esa solicitud no existe.
    expect((await accion(segunda, 'reject', { reason: 'No me toca' }, s.gerente2)).statusCode).toBe(404);
    expect((await accion(segunda, 'ask', { question: '¿Para qué es?' }, s.gerente2)).statusCode).toBe(404);

    // En el mostrador, pasados los 30 minutos de D-03, el dueño ya podría; su apoderado sigue sin poder.
    await envejecer(op, 31);
    const aqui = await post('/approvals', { approverUserId: ids.gerente2, password: PASSWORD, permission: 'reports:month:close', resourceType: 'MonthlyClose', resourceId: op }, s.gerente);
    expect(aqui.statusCode, aqui.body).toBe(403);
    expect(aqui.json().reason).toBe('APPROVAL_PROXY_BLOCKED_BY_REJECTION');
    expect((await asientos('approval.local.fail')).at(-1)!.afterState).toMatchObject({ cause: 'SIN_AUTORIDAD', signerUserId: ids.gerente2 });

    // El «sí» del dueño deja sin efecto su «no»: lo siguiente de ese registro vuelve a poder firmarlo el apoderado.
    expect((await accion(segunda, 'approve', { password: PASSWORD }, s.owner)).statusCode).toBe(200);
    expect((await quienes(op)).map((a) => a.userId).sort()).toEqual([g.ownerId, ids.gerente2].sort());

    // Pasadas las 24 horas del «no», también.
    const op2 = otroMes();
    const r2 = (await cierre(op2)).json().id as string;
    expect((await accion(r2, 'reject', { reason: 'Hoy no' }, s.owner)).statusCode).toBe(200);
    expect((await quienes(op2)).map((a) => a.userId)).toEqual([g.ownerId]);
    await envejecer(op2, 24 * 60 + 1);
    expect((await quienes(op2)).map((a) => a.userId).sort()).toEqual([g.ownerId, ids.gerente2].sort());
  });

  it('su propio «no» sí puede cambiarlo, y queda dicho que rechazó como apoderado', async () => {
    await limpio();
    const nombramiento = (await nombrar(ids.gerente2)).json().id as string;
    const op = otroMes();
    const primera = (await cierre(op)).json().id as string;
    expect((await accion(primera, 'reject', { reason: 'Falta el corte de ayer' }, s.gerente2)).statusCode).toBe(200);
    expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: primera } })).toMatchObject({ status: 'REJECTED', approverUserId: ids.gerente2, proxyId: nombramiento });
    const [no] = await asientos('approval.remote.reject', primera);
    expect(auditPhrase({ action: 'approval.remote.reject', afterState: no!.afterState })).toBe(`rechazó desde su teléfono · firmó como apoderado de ${duena} · Cerrar el mes`);
    const segunda = (await cierre(op, { reply: 'Ya hice el corte' })).json().id as string;
    expect((await bandeja(s.gerente2)).map((r) => r.id)).toContain(segunda);
    expect((await accion(segunda, 'approve', { password: PASSWORD }, s.gerente2)).statusCode).toBe(200);
    expect((await estadoDelApoderado(s.owner)).current).toMatchObject({ signedCount: 1, rejectedCount: 1 });
  });

  it('recepción de una sede, nombrada apoderada, firma con la autoridad del dueño y no con la de su puesto', async () => {
    await limpio();
    expect((await nombrar(ids.recepcion)).statusCode).toBe(201);
    // El cierre de mes es de todo el gimnasio: recepción no lo alcanza por su puesto; como apoderada del dueño, sí.
    const pedida = (await cierre(otroMes())).json().id as string;
    const cookie = await loginAs(app, g.correos.recepcion);
    expect((await bandeja(cookie)).map((r) => r.id)).toContain(pedida);
    expect((await accion(pedida, 'approve', { password: PASSWORD }, cookie)).statusCode).toBe(200);
    expect((await estado(pedida)).approverProxyOf).toBe(duena);
  });

  it('nombrar a otra persona termina el nombramiento anterior: nunca hay dos, y la base tampoco lo deja', async () => {
    await limpio();
    const primero = (await nombrar(ids.gerente2)).json().id as string;
    const segundo = await nombrar(ids.recepcion);
    expect(segundo.statusCode, segundo.body).toBe(201);
    const d = await estadoDelApoderado(s.owner);
    expect(d.current).toMatchObject({ id: segundo.json().id, proxyUserId: ids.recepcion });
    expect(d.history.find((n) => n.id === primero)).toMatchObject({ active: false, endReason: 'REPLACED' });
    expect((await asientos('approval.proxy.replace', ids.gerente2)).at(-1)).toMatchObject({ actorUserId: g.ownerId });
    expect(await db().approvalProxy.count({ where: { organizationId: g.organizationId, endedAt: null } })).toBe(1);
    // El anterior deja de firmar en ese instante.
    const pedida = (await cierre(otroMes())).json().id as string;
    expect((await accion(pedida, 'approve', { password: PASSWORD }, s.gerente2)).statusCode).toBe(403);
    expect(await permisos(s.gerente2)).not.toContain('approvals:proxy');
    // La base: un segundo nombramiento abierto en el mismo gimnasio no entra.
    await expect(db().approvalProxy.create({
      data: { id: '018f0000-0000-7000-8000-00000000a001', organizationId: g.organizationId, grantedByUserId: g.ownerId, proxyUserId: ids.gerente, endsAt: new Date(Date.now() + 86_400_000) },
    })).rejects.toThrow(/Unique constraint|approval_proxies_uno_abierto_key/);
  });

  it('revocar lo apaga al instante: no firma más, y una firma suya que nadie había usado deja de valer', async () => {
    await limpio();
    const nombramiento = (await nombrar(ids.gerente2)).json().id as string;
    const pedida = (await post('/approvals/requests', {
      permission: 'cash:withdraw', branchId: sede().id, resourceType: 'CashSession', resourceId: turno, amountCents: '10000', summary: 'Retiro a caja fuerte',
    }, s.gerente)).json().id as string;
    expect((await accion(pedida, 'approve', { password: PASSWORD }, s.gerente2)).statusCode).toBe(200);
    const token = (await estado(pedida)).approvalToken!;

    const fuera = await post('/approvals/proxy/revoke', { reason: 'Ya regresé' }, s.owner);
    expect(fuera.statusCode, fuera.body).toBe(200);
    const [asiento] = await asientos('approval.proxy.revoke', ids.gerente2).then((a) => a.slice(-1));
    expect(asiento).toMatchObject({ actorUserId: g.ownerId, reason: 'Ya regresé' });
    expect(asiento!.afterState).toMatchObject({ proxyId: nombramiento, signedCount: 1 });
    expect(auditNeedsReview({ action: 'approval.proxy.revoke', afterState: asiento!.afterState })).toBe(true);
    expect(auditPhrase({ action: 'approval.proxy.revoke', afterState: asiento!.afterState }, { person: 'Ana Ruiz' })).toBe('revocó el nombramiento de apoderado de Ana Ruiz');

    const d = await estadoDelApoderado(s.owner);
    expect(d.current).toBeNull();
    expect(d.history.find((n) => n.id === nombramiento)).toMatchObject({ active: false, endReason: 'REVOKED', signedCount: 1 });
    expect(await permisos(s.gerente2)).not.toContain('approvals:proxy');
    expect(await bandeja(s.gerente2)).toEqual([]);
    // La firma que dio antes de la revocación y nadie usó ya no sirve: la autoridad se revisa al consumirla.
    const retiro = await post(`/cash-sessions/${turno}/movements`, { movementType: 'WITHDRAWAL', amountCents: '10000', reason: 'Corte', approvalToken: token }, s.gerente);
    expect(retiro.statusCode, retiro.body).toBe(403);
    // No hay nada más que revocar.
    const otra = await revocar();
    expect(otra.statusCode).toBe(409);
    expect(otra.json().reason).toBe('APPROVAL_PROXY_NONE');
  });

  it('caduca solo al pasar su fecha: deja de firmar sin que nadie haga nada, y el sistema lo asienta', async () => {
    await limpio();
    const nombramiento = (await nombrar(ids.gerente2, { endsOn: hoy() })).json().id as string;
    const pedida = (await cierre(otroMes())).json().id as string;
    expect((await bandeja(s.gerente2)).map((r) => r.id)).toContain(pedida);
    // Pasa su fecha (se mueve la fila al pasado: se nombró hace dos días y venció hace un minuto).
    await db().approvalProxy.update({ where: { id: nombramiento }, data: { createdAt: new Date(Date.now() - 2 * 86_400_000), endsAt: new Date(Date.now() - 60_000) } });
    expect(await permisos(s.gerente2)).not.toContain('approvals:proxy');
    expect(await bandeja(s.gerente2)).toEqual([]);
    expect((await accion(pedida, 'approve', { password: PASSWORD }, s.gerente2)).statusCode).toBe(403);
    expect((await quienes(otroMes())).map((a) => a.userId)).toEqual([g.ownerId]);

    // El job de cada 15 minutos lo cierra y lo asienta como acto del sistema, una sola vez.
    const job = APPROVAL_JOBS.find((j) => j.name === 'approvals.expire-forgotten')!;
    await job.handler(g.organizationId);
    await job.handler(g.organizationId);
    const vencidos = await asientos('approval.proxy.expire', ids.gerente2);
    expect(vencidos.filter((a) => (a.afterState as { proxyId?: string }).proxyId === nombramiento)).toHaveLength(1);
    expect(vencidos.at(-1)).toMatchObject({ actorType: 'SYSTEM', actorUserId: null });
    const d = await estadoDelApoderado(s.owner);
    expect(d.current).toBeNull();
    expect(d.history.some((n) => n.active)).toBe(false);
    // Dejó de valer a su hora, no a la hora en que el job lo cerró.
    const fila = await db().approvalProxy.findUniqueOrThrow({ where: { id: nombramiento } });
    expect(fila).toMatchObject({ endReason: 'EXPIRED', endedByUserId: null });
    expect(fila.endedAt!.getTime()).toBe(fila.endsAt.getTime());
    // Y se puede nombrar de nuevo.
    expect((await nombrar(ids.gerente2)).statusCode).toBe(201);
  });

  it('si quien nombró deja de estar activo, su apoderado deja de firmar', async () => {
    await limpio();
    expect((await nombrar(ids.gerente2)).statusCode).toBe(201);
    const op = otroMes();
    expect((await quienes(op)).map((a) => a.userId)).toContain(ids.gerente2);
    await db().user.update({ where: { id: g.ownerId }, data: { isActive: false } });
    try {
      expect((await quienes(op)).map((a) => a.userId)).toEqual([]);
    } finally {
      await db().user.update({ where: { id: g.ownerId }, data: { isActive: true } });
    }
  });

  it('lo firmado antes de que existiera el apoderado se lee igual: sin nombramiento, firmó el dueño', async () => {
    await limpio();
    const pedida = (await cierre(otroMes())).json().id as string;
    expect((await accion(pedida, 'approve', { password: PASSWORD }, s.owner)).statusCode).toBe(200);
    expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: pedida } })).toMatchObject({ proxyId: null });
    expect((await estado(pedida)).approverProxyOf).toBeNull();
    const [asiento] = await asientos('approval.remote.approve', pedida);
    expect(asiento!.afterState).not.toHaveProperty('asProxy');
    expect(auditPhrase({ action: 'approval.remote.approve', afterState: asiento!.afterState })).toBe('autorizó desde su teléfono · Cerrar el mes');
  });
});
