import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { monthlyCloseResourceId, uuidv7 } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, CONSENTIMIENTOS, PASSWORD, aprobacion, cuentaDePrueba } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * BLOQUE 0.9 (auditoría 8): la segunda firma con contexto y con rastro.
 * El cierre de mes se pide al teléfono (20-01), la solicitud siempre dice de
 * qué se trata (29-01), la firma se entrega mientras no se use (29-03), el
 * servidor lleva la cuenta (29-06), firmar, fallar, cancelar y vencer se
 * asientan (20-02, 29-04) y los fallos al firmar tienen su propia escalera,
 * aparte del inicio de sesión (24-11).
 */
describe('firmas · bloque 0.9', () => {
  let app: FastifyInstance;
  let owner: string; let gerente: string; let gerencia: string;
  let orgId: string; let centro: string;
  const db = () => getDb();

  beforeAll(async () => {
    app = await makeApp(); await app.ready();
    [owner, gerente, gerencia] = await Promise.all(['owner@demo.mx', 'gerente@demo.mx', 'gerencia@demo.mx'].map((e) => loginAs(app, e))) as [string, string, string];
    orgId = (await orgFixtures()).demo.id;
    centro = (await db().roleAssignment.findFirstOrThrow({ where: { user: { email: 'recepcion@demo.mx' }, revokedAt: null } })).branchId!;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  /** Un socio dado de baja: lo único que se anonimiza (ARCO). */
  const socio = async () => {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Firma'), lastName: nombreUnico('Contexto'), homeBranchId: centro, force: true, consents: CONSENTIMIENTOS },
    });
    expect(r.statusCode, r.body).toBe(201);
    await app.inject({ method: 'POST', url: `/members/${r.json().id}/archive`, headers: { cookie: gerencia }, payload: { reason: 'Pidió su baja' } });
    return r.json().id as string;
  };
  const pedir = (cookie: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/approvals/requests', headers: { cookie }, payload });
  const estado = (cookie: string, id: string) => app.inject({ method: 'GET', url: `/approvals/requests/${id}`, headers: { cookie } });
  const aprobar = (cookie: string, id: string, password = PASSWORD) => app.inject({ method: 'POST', url: `/approvals/requests/${id}/approve`, headers: { cookie }, payload: { password } });
  const asientos = (action: string, resourceId: string) => db().auditLog.findMany({ where: { organizationId: orgId, action, resourceId }, orderBy: { at: 'asc' } });
  const ctxDe = async (email: string) => {
    const { buildTenant } = await import('../src/platform/context.js');
    const u = await db().user.findFirstOrThrow({ where: { email } });
    return { requestId: uuidv7(), tenant: buildTenant({ organizationId: orgId, actorUserId: u.id, sessionId: uuidv7(), grants: [], limits: null, branchScopeHint: null, requestId: uuidv7() }) } as never;
  };

  it('el cierre de mes se pide al teléfono, la dueña ve qué mes es y la firma solo cierra ESE mes (20-01)', async () => {
    const mes = '2023-11'; const otroMes = '2023-10';
    for (const m of [mes, otroMes]) await db().$executeRaw`DELETE FROM "monthly_closes" WHERE "organizationId" = ${orgId}::uuid AND "month" = ${new Date(`${m}-01T00:00:00.000Z`)}`;

    // Sin el mes no hay de qué se trata: a distancia no se acepta.
    expect((await pedir(gerencia, { permission: 'reports:month:close', resourceType: 'MonthlyClose', resourceId: uuidv7(), summary: 'Cierre del mes' })).statusCode).toBe(422);
    const sol = await pedir(gerencia, { permission: 'reports:month:close', resourceType: 'MonthlyClose', resourceId: monthlyCloseResourceId(mes), summary: 'El cierre de noviembre' });
    expect(sol.statusCode, sol.body).toBe(201);
    const id = sol.json().id as string;
    const bandeja = (await app.inject({ method: 'GET', url: '/approvals/inbox', headers: { cookie: owner } })).json().requests as Array<{ id: string; context: string | null }>;
    expect(bandeja.find((r) => r.id === id)?.context).toBe('Cierre de noviembre de 2023');
    expect((await aprobar(owner, id)).statusCode).toBe(200);
    const token = (await estado(gerencia, id)).json().approvalToken as string;
    expect(token).toBeTruthy();

    // Una firma del mostrador para noviembre no cierra octubre.
    const deNoviembre = await aprobacion(app, gerencia, 'reports:month:close', 'owner@demo.mx', undefined, { resourceId: monthlyCloseResourceId(mes) });
    const cruzada = await app.inject({ method: 'POST', url: '/reports/monthly-close', headers: { cookie: gerencia }, payload: { month: otroMes, reason: 'Cierre contable', approvalToken: deNoviembre } });
    expect(cruzada.statusCode, cruzada.body).toBe(422);

    // La que llegó al teléfono cierra noviembre, con la dueña como firmante.
    const cierre = await app.inject({ method: 'POST', url: '/reports/monthly-close', headers: { cookie: gerencia }, payload: { month: mes, reason: 'Cierre contable', approvalToken: token } });
    expect(cierre.statusCode, cierre.body).toBe(201);
    const duena = await db().user.findFirstOrThrow({ where: { email: 'owner@demo.mx' } });
    const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'report.month.close', resourceId: cierre.json().id } });
    expect(asiento.approvedByUserId).toBe(duena.id);
  });

  it('la solicitud siempre dice de qué se trata: el servidor deduce el tipo y la bandeja lo lee de la base (29-01)', async () => {
    const id = await socio();
    // El panel viejo no manda el tipo: se deduce del permiso y queda el aviso en la bitácora.
    const sol = await pedir(gerente, { permission: 'members:anonymize', branchId: centro, resourceId: id, summary: 'Anonimizar a un socio' });
    expect(sol.statusCode, sol.body).toBe(201);
    expect(sol.json().resourceType).toBe('Member');
    const [pedida] = await asientos('approval.remote.request', sol.json().id);
    expect(pedida?.afterState).toMatchObject({ resourceType: 'Member', resourceId: id, resourceTypeInferred: true });
    const m = await db().member.findUniqueOrThrow({ where: { id } });
    const bandeja = (await app.inject({ method: 'GET', url: '/approvals/inbox', headers: { cookie: owner } })).json().requests as Array<{ id: string; context: string | null }>;
    expect(bandeja.find((r) => r.id === sol.json().id)?.context).toBe(`Socio ${m.firstName} ${m.lastName} (${m.memberCode})`);
    await app.inject({ method: 'POST', url: `/approvals/requests/${sol.json().id}/cancel`, headers: { cookie: gerente }, payload: {} });

    // Un tipo que no es el de la operación, un registro que no existe o una operación sin firma: no.
    expect((await pedir(gerente, { permission: 'members:anonymize', branchId: centro, resourceType: 'CashSession', resourceId: id, summary: 'Anonimizar' })).statusCode).toBe(422);
    expect((await pedir(gerente, { permission: 'members:anonymize', branchId: centro, resourceId: uuidv7(), summary: 'Anonimizar' })).statusCode).toBe(422);
    expect((await pedir(gerente, { permission: 'members:read', resourceId: id, summary: 'Ver un socio' })).statusCode).toBe(422);

    // La condonación es de una membresía o de un cargo: se averigua por el id.
    const membresia = await db().membership.findFirst({ where: { organizationId: orgId } });
    const cargo = await db().charge.findFirst({ where: { organizationId: orgId } });
    for (const [rid, tipo] of [[membresia?.id, 'Membership'], [cargo?.id, 'Charge']] as const) {
      if (!rid) continue;
      const r = await pedir(gerente, { permission: 'billing:waiver:apply', resourceId: rid, amountCents: '15000', summary: 'Condonar' });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().resourceType).toBe(tipo);
      await app.inject({ method: 'POST', url: `/approvals/requests/${r.json().id}/cancel`, headers: { cookie: gerente }, payload: {} });
    }
  });

  it('la firma aprobada se entrega mientras no se use y la cuenta la lleva el servidor (29-03, 29-06)', async () => {
    const { RemoteApprovalService } = await import('../src/modules/approvals/remote-approval.service.js');
    const remotas = new RemoteApprovalService();
    const ctxGerente = await ctxDe('gerente@demo.mx');
    const id = await socio();
    const sol = (await pedir(gerente, { permission: 'members:anonymize', branchId: centro, resourceType: 'Member', resourceId: id, summary: 'Anonimizar' })).json().id as string;

    const pendiente = await remotas.status(ctxGerente, sol);
    expect(pendiente.status).toBe('PENDING');
    expect(pendiente.secondsLeft).toBeGreaterThan(590);
    expect(pendiente.secondsLeft).toBeLessThanOrEqual(600);

    expect((await aprobar(owner, sol)).statusCode).toBe(200);
    // Se perdió la respuesta que traía la firma: la siguiente consulta la vuelve a traer.
    const primera = await remotas.status(ctxGerente, sol);
    const segunda = await remotas.status(ctxGerente, sol);
    expect(primera).toMatchObject({ status: 'APPROVED', delivery: 'ready', secondsLeft: 0 });
    expect(segunda.approvalToken).toBe(primera.approvalToken);
    expect((await estado(gerente, sol)).json().approvalToken).toBe(primera.approvalToken);

    // Usada en su operación: ya no se entrega, se sabe que se usó y el token deja de guardarse.
    const hecha = await app.inject({ method: 'POST', url: `/members/${id}/anonymize`, headers: { cookie: gerente }, payload: { reason: 'Solicitud ARCO', approvalToken: primera.approvalToken } });
    expect(hecha.statusCode, hecha.body).toBe(204);
    expect(await remotas.status(ctxGerente, sol)).toMatchObject({ status: 'APPROVED', delivery: 'used', approvalToken: null });
    expect((await db().approvalRequest.findUniqueOrThrow({ where: { id: sol } })).deliveryToken).toBeNull();

    // Aprobada y nunca recogida en sus cinco minutos: venció sin usarse.
    const otro = await socio();
    const sol2 = (await pedir(gerente, { permission: 'members:anonymize', branchId: centro, resourceType: 'Member', resourceId: otro, summary: 'Anonimizar' })).json().id as string;
    expect((await aprobar(owner, sol2)).statusCode).toBe(200);
    const fila = await db().approvalRequest.findUniqueOrThrow({ where: { id: sol2 } });
    await db().approvalGrant.update({ where: { id: fila.grantId! }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await remotas.status(ctxGerente, sol2)).toMatchObject({ status: 'APPROVED', delivery: 'expired', approvalToken: null });
  });

  it('cancelar, vencer y rechazar dejan asiento, cada uno una sola vez (29-04)', async () => {
    const id = await socio();
    const pedirUna = async () => (await pedir(gerente, { permission: 'members:anonymize', branchId: centro, resourceType: 'Member', resourceId: id, summary: 'Anonimizar' })).json().id as string;

    const cancelada = await pedirUna();
    expect((await app.inject({ method: 'POST', url: `/approvals/requests/${cancelada}/cancel`, headers: { cookie: gerente }, payload: {} })).statusCode).toBe(200);
    const gerenteId = (await db().user.findFirstOrThrow({ where: { email: 'gerente@demo.mx' } })).id;
    expect((await asientos('approval.remote.cancel', cancelada)).map((a) => a.actorUserId)).toEqual([gerenteId]);

    // Vencida y leída dos veces por quien la pidió: un solo asiento, del sistema.
    const leida = await pedirUna();
    await db().approvalRequest.update({ where: { id: leida }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await estado(gerente, leida)).json().status).toBe('EXPIRED');
    expect((await estado(gerente, leida)).json().status).toBe('EXPIRED');
    const vencidas = await asientos('approval.remote.expire', leida);
    expect(vencidas.map((a) => [a.actorType, a.actorUserId])).toEqual([['SYSTEM', null]]);

    // Vencida y olvidada: la cierra la bandeja de quien firma.
    const olvidada = await pedirUna();
    await db().approvalRequest.update({ where: { id: olvidada }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await app.inject({ method: 'GET', url: '/approvals/inbox', headers: { cookie: owner } });
    expect((await db().approvalRequest.findUniqueOrThrow({ where: { id: olvidada } })).status).toBe('EXPIRED');
    expect(await asientos('approval.remote.expire', olvidada)).toHaveLength(1);

    // El «no autorizó» dice cuánto.
    const membresia = await db().membership.findFirst({ where: { organizationId: orgId } });
    if (membresia) {
      const r = (await pedir(gerente, { permission: 'billing:waiver:apply', resourceType: 'Membership', resourceId: membresia.id, amountCents: '15000', summary: 'Condonar' })).json().id as string;
      expect((await app.inject({ method: 'POST', url: `/approvals/requests/${r}/reject`, headers: { cookie: owner }, payload: { reason: 'Primero cobra lo de este mes' } })).statusCode).toBe(200);
      const [rechazo] = await asientos('approval.remote.reject', r);
      expect(rechazo?.afterState).toMatchObject({ amountCents: '15000', resourceType: 'Membership' });
    }
  });

  it('la firma en el mostrador deja rastro: quién la pidió, quién firmó y los intentos que fallaron (20-02)', async () => {
    const id = await socio();
    const duena = await db().user.findFirstOrThrow({ where: { email: 'owner@demo.mx' } });
    const gerenteId = (await db().user.findFirstOrThrow({ where: { email: 'gerente@demo.mx' } })).id;
    await aprobacion(app, gerente, 'members:anonymize', 'owner@demo.mx', centro, { resourceId: id });
    const [firmada] = await asientos('approval.local.issue', id);
    expect(firmada).toMatchObject({ actorUserId: gerenteId, approvedByUserId: duena.id, resourceType: 'Member', branchId: centro });
    expect(firmada?.afterState).toMatchObject({ permission: 'members:anonymize', resourceTypeInferred: true });

    // Un correo que no es de nadie de este gimnasio: 401 como siempre, y queda quién lo intentó.
    const mal = await app.inject({
      method: 'POST', url: '/approvals', headers: { cookie: gerente },
      payload: { email: 'nadie-firma@demo.mx', password: 'una-que-no', permission: 'members:anonymize', branchId: centro, resourceId: id },
    });
    expect(mal.statusCode).toBe(401);
    const fallos = await asientos('approval.local.fail', id);
    expect(fallos.at(-1)).toMatchObject({ actorUserId: gerenteId });
    expect(fallos.at(-1)?.afterState).toMatchObject({ cause: 'DESCONOCIDO', email: 'nadie-firma@demo.mx', signerUserId: null });
  });

  it('cinco fallos al firmar pausan SUS firmas 10 minutos, sin tocar su inicio de sesión (24-11, D24-04)', async () => {
    const email = await cuentaDePrueba(orgId, 'OWNER', [null]);
    const firmante = await db().user.findFirstOrThrow({ where: { email } });
    try {
      const firmar = (password: string) => app.inject({
        method: 'POST', url: '/approvals', headers: { cookie: gerente },
        payload: { email, password, permission: 'cash:withdraw', branchId: centro, resourceId: uuidv7(), amountCents: '100' },
      });
      const fallosDe = async () => (await db().auditLog.findMany({
        where: { organizationId: orgId, action: 'approval.local.fail' }, orderBy: { at: 'asc' },
      })).filter((a) => (a.afterState as { signerUserId?: string } | null)?.signerUserId === firmante.id);

      for (let i = 1; i <= 4; i++) expect((await firmar('no-es-la-suya')).statusCode, `fallo ${i}`).toBe(401);
      expect((await fallosDe()).map((a) => (a.afterState as { failedCount?: number }).failedCount)).toEqual([1, 2, 3, 4]);
      // Al 3.º se le avisa (su teléfono, si tiene avisos): queda marcado en el asiento.
      expect((await fallosDe())[2]?.afterState).toMatchObject({ step: 'warn', cause: 'CONTRASENA' });

      const quinto = await firmar('no-es-la-suya');
      expect(quinto.statusCode).toBe(401);
      expect(quinto.json().detail).toMatch(/pausa hasta las \d{2}:\d{2}/);
      const pausa = await db().auditLog.findMany({ where: { organizationId: orgId, action: 'approval.pause', resourceId: firmante.id } });
      expect(pausa.map((a) => a.actorType)).toEqual(['SYSTEM']);

      // En pausa, ni con la contraseña buena: 429, y el intento queda.
      const enPausa = await firmar(PASSWORD);
      expect(enPausa.statusCode, enPausa.body).toBe(429);
      expect(enPausa.json().message).toMatch(/en pausa hasta las/);
      expect((await fallosDe()).at(-1)?.afterState).toMatchObject({ cause: 'EN_PAUSA' });
      // El diálogo lo sabe antes de teclear.
      const quienes = (await app.inject({ method: 'GET', url: `/approvals/approvers?permission=cash:withdraw&branchId=${centro}&amountCents=100`, headers: { cookie: gerente } })).json();
      expect(quienes.approvers.find((a: { userId: string }) => a.userId === firmante.id)?.pausedUntil).toBeTruthy();
      expect(quienes).toMatchObject({ requestTtlSeconds: 600, grantTtlSeconds: 300 });

      // Su entrada no se toca: ni fallos ni bloqueo en su cuenta, y entra.
      const cuenta = await db().user.findUniqueOrThrow({ where: { id: firmante.id } });
      expect(cuenta.failedLogins).toBe(0);
      expect(cuenta.lockedUntil).toBeNull();
      const sesion = await loginAs(app, email);

      // Desde su propio teléfono tampoco firma mientras dure la pausa.
      const id = await socio();
      const sol = (await pedir(gerente, { permission: 'members:anonymize', branchId: centro, resourceType: 'Member', resourceId: id, summary: 'Anonimizar' })).json().id as string;
      expect((await aprobar(sesion, sol)).statusCode).toBe(429);
      await app.inject({ method: 'POST', url: `/approvals/requests/${sol}/cancel`, headers: { cookie: gerente }, payload: {} });

      // Pasada la pausa firma de nuevo, y un bloqueo de su INICIO DE SESIÓN no le impide firmar: van aparte.
      await db().approvalSignerLock.update({ where: { userId: firmante.id }, data: { pausedUntil: new Date(Date.now() - 1000) } });
      await db().user.update({ where: { id: firmante.id }, data: { lockedUntil: new Date(Date.now() + 600_000) } });
      const despues = await firmar(PASSWORD);
      expect(despues.statusCode, despues.body).toBe(200);
      expect((await db().approvalSignerLock.findUniqueOrThrow({ where: { userId: firmante.id } })).failedCount).toBe(0);
    } finally {
      // Que no quede como segunda dueña para el resto de las pruebas.
      await db().user.update({ where: { id: firmante.id }, data: { isActive: false, lockedUntil: null } });
    }
  });
});
