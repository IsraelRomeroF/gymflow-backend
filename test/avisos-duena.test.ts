import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { OWNER_ALERT_KINDS, UNLIMITED_LIMITS, hoyEn, normalizedNameKey, semanaDelResumen, uuidv7 } from '@gymflow/core';
import { OwnerAlerts, diferenciasConElContrato } from '@gymflow/core/contracts';

/**
 * El teléfono de mentira: `web-push` no manda nada, solo apunta lo que habría
 * salido. Todo lo demás es de verdad: las suscripciones, lo que cada quien
 * apagó y `PushService`.
 */
const { enviados } = vi.hoisted(() => ({ enviados: [] as Array<{ endpoint: string; payload: { title: string; body: string; url: string; tag?: string; kind?: string } }> }));
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => undefined,
    sendNotification: async (sub: { endpoint: string }, payload: string) => { enviados.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); return {}; },
  },
}));
process.env.VAPID_PUBLIC_KEY = 'llave-publica-de-prueba';
process.env.VAPID_PRIVATE_KEY = 'llave-privada-de-prueba';

import { makeApp, loginAs, nombreUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { AuditService } from '../src/platform/audit/audit.service.js';
import type { RequestContext } from '../src/platform/context.js';
import { systemContext } from '../src/platform/jobs/types.js';
import { armarPlanes, ORDEN_FRECUENTE } from '../src/platform/jobs/plan.js';
import { BACKEND_MODULES } from '../src/modules.js';
import { AnomalyScanService } from '../src/modules/alerts/anomaly-scan.service.js';
import { WeeklySummaryService } from '../src/modules/alerts/weekly-summary.service.js';
import { PushService } from '../src/modules/identity/index.js';

const DIA = 86_400_000;
const ZONA = 'America/Mexico_City';

/**
 * FASE 4 · BLOQUE 4.2 · D-05 (c) «ALERTAS AL MOMENTO + RESUMEN DEL LUNES 7:00;
 * CADA AVISO SE PUEDE APAGAR».
 *
 *  · La primera corrida en un gimnasio NO suena: lo pendiente queda anotado en
 *    el panel y lo anterior no se avisa nunca.
 *  · Cada aviso sale una vez, aunque el job corra cien.
 *  · Lo que suena no lleva el nombre de nadie.
 *  · Apagar un tipo calla el teléfono, no el panel.
 *  · Solo la dueña: ni la gerencia ni recepción ven ni ajustan nada.
 *  · El resumen: uno por lunes, desde el primer lunes después del arranque.
 *
 * Gimnasio propio. Nada depende de la hora real: los instantes se le pasan al
 * servicio y «hoy» es el día del gimnasio.
 */
describe('avisos a la dueña · D-05', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let owner: string; let gerente: string; let recepcion: string;
  let idRecepcion: string; let idGerente: string; let nombreRecepcion: string;
  let sede: string;
  let socioId: string; let nombreSocio: string;
  const scan = new AnomalyScanService();
  const resumen = new WeeklySummaryService();
  const audit = new AuditService();

  const FONDO = 100_000n;
  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (cookie: string, url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, headers: { cookie }, payload });
  const put = (cookie: string, url: string, payload: Record<string, unknown>) => app.inject({ method: 'PUT', url, headers: { cookie }, payload });
  const corteCon = async (diferencia: bigint, caja = g.sedes[0]!.cajas[0]!) => {
    const t = await post(recepcion, '/cash-sessions', { cashRegisterId: caja, openingFloatCents: FONDO.toString() });
    expect(t.statusCode, t.body).toBe(201);
    const r = await post(recepcion, `/cash-sessions/${(t.json() as { id: string }).id}/close`, {
      countedCashCents: (FONDO + diferencia).toString(), ...(diferencia === 0n ? {} : { varianceReason: 'Diferencia de la prueba de avisos' }),
    });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { id: string }).id;
  };
  /** Un turno que se quedó abierto desde un día de operación viejo. */
  const cajaOlvidada = async (caja: string) => {
    const id = uuidv7();
    await getDb().cashSession.create({
      data: { id, organizationId: g.organizationId, branchId: sede, cashRegisterId: caja, openedByUserId: idRecepcion, businessDate: new Date('2026-01-05T00:00:00.000Z'), openingFloatCents: FONDO, openedAt: new Date('2026-01-05T15:00:00.000Z') },
    });
    return id;
  };
  const como = (userId: string): RequestContext => {
    const base = systemContext(g.organizationId);
    return { ...base, tenant: { ...base.tenant, actorType: 'USER', actorUserId: userId, limits: UNLIMITED_LIMITS } } as RequestContext;
  };
  const avisos = (where: Record<string, unknown> = {}) => getDb().ownerAlert.findMany({ where: { organizationId: g.organizationId, ...where }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const delTelefono = () => enviados.filter((e) => e.endpoint === ENDPOINT);
  let ENDPOINT: string;

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio({ sedes: [{ name: 'Sede de los avisos', cajas: 3 }] });
    sede = g.sedes[0]!.id;
    owner = await loginAs(app, g.correos.owner);
    gerente = await loginAs(app, g.correos.gerente);
    recepcion = await loginAs(app, g.correos.recepcion);
    const cuentas = await getDb().user.findMany({ where: { email: { in: [g.correos.recepcion, g.correos.gerente] } }, select: { id: true, email: true, fullName: true } });
    idRecepcion = cuentas.find((c) => c.email === g.correos.recepcion)!.id;
    nombreRecepcion = cuentas.find((c) => c.email === g.correos.recepcion)!.fullName;
    idGerente = cuentas.find((c) => c.email === g.correos.gerente)!.id;
    // El teléfono de la dueña, con los avisos activados.
    ENDPOINT = `https://push.example/${uuidv7()}`;
    const alta = await post(owner, '/me/push-subscriptions', { endpoint: ENDPOINT, keys: { p256dh: 'p256dh-de-prueba-0123456789', auth: 'auth-de-prueba' } });
    expect(alta.statusCode, alta.body).toBe(201);
    // Un socio, para comprobar que su nombre no sale en ningún aviso.
    nombreSocio = nombreUnico('Zeferino');
    socioId = uuidv7();
    await getDb().member.create({
      data: {
        id: socioId, organizationId: g.organizationId, memberCode: `AVI-${socioId.slice(-10)}`, firstName: nombreSocio, lastName: 'Del Aviso',
        nameKey: normalizedNameKey(`${nombreSocio} del aviso`), homeBranchId: sede, joinedAt: new Date(`${hoyEn(ZONA)}T00:00:00.000Z`),
      },
    });
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  it('los dos jobs tienen su lugar en el corredor de 15 minutos, al final y en ese orden', () => {
    const planes = armarPlanes(BACKEND_MODULES);
    const nombres = planes.frecuente.map((j) => j.name);
    expect(nombres.slice(-2)).toEqual(['audit.anomaly-scan', 'alerts.weekly-summary']);
    expect(ORDEN_FRECUENTE.indexOf('audit.anomaly-scan')).toBeGreaterThan(ORDEN_FRECUENTE.indexOf('approvals.expire-forgotten'));
    expect(planes.frecuente.find((j) => j.name === 'audit.anomaly-scan')!.module).toBe('core');
  });

  it('LA PRIMERA CORRIDA NO SUENA: anota en el panel lo que ya estaba pendiente y no avisa de lo anterior', async () => {
    // Lo que ya había antes de que existieran los avisos: un corte por revisar, un cambio de precio y una caja olvidada.
    await corteCon(-7_500n);
    await audit.record(como(idGerente), {
      action: 'catalog.plan.price_change', resourceType: 'plan', resourceId: g.planMensual, reason: 'Ajuste anterior a los avisos',
      beforeState: { priceCents: '60000' }, afterState: { priceCents: '65000', touched: 0 },
    });
    const olvidada = await cajaOlvidada(g.sedes[0]!.cajas[1]!);

    const antes = delTelefono().length;
    const primera = await scan.pasada(g.organizationId);
    expect(primera).toMatchObject({ primera: true, nuevos: 1, alTelefono: 0, errores: [] });
    expect(delTelefono().length).toBe(antes);

    const filas = await avisos();
    expect(filas.map((f) => [f.kind, f.dedupeKey, f.silent, f.pushDevices, f.pushedAt])).toEqual([['CASH_UNCLOSED', `cash-unclosed:${olvidada}`, true, 0, null]]);

    // Otra corrida: ni suena lo que quedó anotado ni resucita lo anterior.
    const segunda = await scan.pasada(g.organizationId);
    expect(segunda).toMatchObject({ primera: false, nuevos: 0, alTelefono: 0, yaAvisados: 1, errores: [] });
    expect(delTelefono().length).toBe(antes);
    expect(await avisos()).toHaveLength(1);
  });

  it('un corte con más de $20 de diferencia suena una vez, sin nombres; uno de $20 justos, no', async () => {
    const corte = await corteCon(-5_000n);
    await corteCon(-2_000n);
    const antes = delTelefono().length;
    const r = await scan.pasada(g.organizationId);
    expect(r).toMatchObject({ primera: false, nuevos: 1, alTelefono: 1, errores: [] });

    const [aviso] = await avisos({ dedupeKey: `cash-variance:${corte}` });
    expect(aviso).toMatchObject({ kind: 'CASH_VARIANCE', title: 'Corte con faltante', silent: false, pushDevices: 1, branchId: sede, url: '/avisos' });
    expect(aviso!.body).toBe('El corte de Caja 1 (Sede de los avisos) cerró con un faltante de $50.00. Queda por revisar.');
    expect(aviso!.pushedAt).not.toBeNull();
    // El detalle (solo dentro del panel) sí dice quién abrió el turno.
    expect((aviso!.detail as { lines: Array<{ label: string; value: string }> }).lines).toEqual(expect.arrayContaining([
      { label: 'Faltó', value: '$50.00' }, { label: 'Abrió el turno (responsable)', value: nombreRecepcion },
    ]));

    const sonaron = delTelefono().slice(antes);
    expect(sonaron).toHaveLength(1);
    expect(sonaron[0]!.payload).toMatchObject({ title: 'Corte con faltante', body: aviso!.body, url: '/avisos', tag: `duena-${aviso!.id}` });
    // Lo que viaja al teléfono no lleva el tipo interno ni el nombre de nadie.
    expect(sonaron[0]!.payload.kind).toBeUndefined();
    expect(sonaron[0]!.payload.body).not.toContain(nombreRecepcion);

    // El job vuelve a correr: no se manda dos veces.
    for (let i = 0; i < 3; i++) expect(await scan.pasada(g.organizationId)).toMatchObject({ nuevos: 0, alTelefono: 0 });
    expect(delTelefono().length).toBe(antes + 1);
    expect(await avisos({ kind: 'CASH_VARIANCE' })).toHaveLength(1);
  });

  it('dos corridas a la vez no mandan dos veces el mismo aviso', async () => {
    await corteCon(4_000n);
    const antes = delTelefono().length;
    const [a, b] = await Promise.all([scan.pasada(g.organizationId), scan.pasada(g.organizationId)]);
    expect(a.nuevos + b.nuevos).toBe(1);
    expect(delTelefono().length).toBe(antes + 1);
    expect(delTelefono().at(-1)!.payload.title).toBe('Corte con sobrante');
  });

  it('una caja que amanece sin cortar suena una vez por turno olvidado', async () => {
    const olvidada = await cajaOlvidada(g.sedes[0]!.cajas[2]!);
    const antes = delTelefono().length;
    expect(await scan.pasada(g.organizationId)).toMatchObject({ nuevos: 1, alTelefono: 1 });
    expect(await scan.pasada(g.organizationId)).toMatchObject({ nuevos: 0 });
    const [aviso] = await avisos({ dedupeKey: `cash-unclosed:${olvidada}` });
    expect(aviso!.body).toBe('Caja 3 (Sede de los avisos) sigue abierta desde el 5 de enero: nadie hizo el corte.');
    expect(delTelefono().slice(antes).map((e) => e.payload.title)).toEqual(['Caja sin cortar']);
  });

  it('el tope de pases: suena cuando alguien lo rebasa, una vez por persona, día y sede', async () => {
    // El tope de recepción es de 10 «déjalo pasar» por día.
    const dejarPasar = () => audit.record(como(idRecepcion), { action: 'access.manual_grant', resourceType: 'access_decision', resourceId: uuidv7(), branchId: sede, reason: 'Olvidó su credencial' });
    for (let i = 0; i < 10; i++) await dejarPasar();
    expect(await scan.pasada(g.organizationId)).toMatchObject({ nuevos: 0 });
    await dejarPasar();
    const antes = delTelefono().length;
    expect(await scan.pasada(g.organizationId)).toMatchObject({ nuevos: 1, alTelefono: 1 });
    await dejarPasar();
    expect(await scan.pasada(g.organizationId)).toMatchObject({ nuevos: 0 });
    const sonaron = delTelefono().slice(antes);
    expect(sonaron).toHaveLength(1);
    expect(sonaron[0]!.payload.body).toBe('Alguien del mostrador de Sede de los avisos dejó pasar por excepción 11 veces hoy; su tope es 10.');
    const [aviso] = await avisos({ kind: 'ENTRY_EXCEPTIONS_OVER_LIMIT' });
    expect((aviso!.detail as { lines: Array<{ label: string; value: string }> }).lines).toContainEqual({ label: 'Quién', value: nombreRecepcion });
  });

  it('la cuarta insistencia, el cambio de precio y la deuda dada por perdida, desde la bitácora', async () => {
    const insistir = () => audit.record(como(idRecepcion), {
      action: 'approval.remote.over_limit', resourceType: 'ApprovalRequest', resourceId: null, branchId: sede,
      afterState: { permission: 'payments:refund', summary: `Reembolso de $300 a ${nombreSocio} Del Aviso`, amountCents: '30000', attempt: 4 },
    });
    await insistir(); await insistir();
    await audit.record(como(idGerente), {
      action: 'catalog.plan.price_change', resourceType: 'plan', resourceId: g.planMensual, reason: 'Sube la renta del local',
      beforeState: { priceCents: '60000' }, afterState: { priceCents: '70000', touched: 12 },
    });
    await audit.record(systemContext(g.organizationId), {
      action: 'billing.debt.lost.summary', resourceType: 'Organization', resourceId: g.organizationId,
      afterState: { amountCents: '250000', charges: 4, members: 3, lostOn: hoyEn(ZONA), lostDebtDays: 90, firstRun: false }, reason: 'Deuda de membresías que cumplieron 90 días suspendidas',
    });
    const antes = delTelefono().length;
    const r = await scan.pasada(g.organizationId);
    expect(r).toMatchObject({ nuevos: 3, alTelefono: 3, errores: [] });
    const sonaron = delTelefono().slice(antes).map((e) => e.payload);
    expect(sonaron.map((p) => p.title).sort()).toEqual(['Cambió un precio', 'Deuda dada por perdida', 'Insistencia con una firma']);
    expect(sonaron.find((p) => p.title === 'Cambió un precio')!.body).toBe('Cambió el precio del plan Mensual. Quién y cuánto, en el panel.');
    expect(sonaron.find((p) => p.title === 'Deuda dada por perdida')!.body).toContain('$2,500.00 de 3 socios');
    // Dos insistencias de la misma persona el mismo día: un solo aviso. Y el resumen de la operación, con el nombre del socio, no se guarda.
    expect(await avisos({ kind: 'SIGNATURE_INSISTENCE' })).toHaveLength(1);
    const precio = (await avisos({ kind: 'PLAN_PRICE_CHANGE' }))[0]!;
    expect((precio.detail as { lines: Array<{ label: string; value: string }> }).lines).toEqual(expect.arrayContaining([
      { label: 'Antes', value: '$600.00' }, { label: 'Ahora', value: '$700.00' }, { label: 'Motivo', value: 'Sube la renta del local' }, { label: 'Membresías que cambian de precio', value: '12' },
    ]));
    expect(await scan.pasada(g.organizationId)).toMatchObject({ nuevos: 0 });
  });

  it('una solicitud de privacidad suena a 5 días de vencer; a 10 días o sin identidad acreditada, no', async () => {
    const ahora = new Date();
    const solicitud = (dias: number, identidad: boolean) => getDb().privacyRequest.create({
      data: {
        id: uuidv7(), organizationId: g.organizationId, memberId: socioId, kind: 'ACCESS', channel: 'FRONT_DESK',
        dueAt: new Date(ahora.getTime() + dias * DIA), ...(identidad ? { identityVerifiedAt: ahora } : {}),
      },
    });
    const urgente = await solicitud(3, true);
    await solicitud(10, true);
    await solicitud(1, false);
    const antes = delTelefono().length;
    expect(await scan.pasada(g.organizationId, ahora)).toMatchObject({ nuevos: 1, alTelefono: 1 });
    const [aviso] = await avisos({ dedupeKey: `privacy-due:${urgente.id}:answer` });
    expect(aviso!.body).toBe('A una solicitud de un socio sobre sus datos le quedan 3 días del plazo de ley.');
    expect(JSON.stringify(aviso!.detail)).not.toContain(nombreSocio);
    expect(delTelefono().slice(antes)).toHaveLength(1);
    // Al día siguiente sigue pendiente: no vuelve a sonar.
    expect(await scan.pasada(g.organizationId, new Date(ahora.getTime() + DIA))).toMatchObject({ nuevos: 0 });
  });

  it('el aviso de privacidad que espera su firma le suena a la dueña', async () => {
    const doc = await getDb().consentDocument.create({
      data: { id: uuidv7(), organizationId: g.organizationId, consentType: 'PRIVACY_NOTICE', version: '9.9-avisos', title: 'Aviso de prueba', bodyText: 'Texto del aviso de prueba', status: 'DRAFT' },
    });
    const pedida = await getDb().consentSignatureRequest.create({
      data: { id: uuidv7(), organizationId: g.organizationId, documentId: doc.id, reason: 'Cambió el encargado de los datos', bodyHash: 'hash-de-prueba', requestedByUserId: idGerente },
    });
    const antes = delTelefono().length;
    expect(await scan.pasada(g.organizationId)).toMatchObject({ nuevos: 1, alTelefono: 1 });
    const [aviso] = await avisos({ dedupeKey: `notice-signature:${pedida.id}` });
    expect(aviso).toMatchObject({ title: 'El aviso de privacidad espera tu firma', url: '/consentimientos' });
    expect(aviso!.body).toContain('la versión 9.9-avisos');
    expect(delTelefono().slice(antes)).toHaveLength(1);
  });

  it('ningún aviso guardado ni mandado lleva el nombre del socio', async () => {
    const todo = JSON.stringify(await avisos()) + JSON.stringify(delTelefono());
    expect(todo).not.toContain(nombreSocio);
  });

  describe('solo la dueña', () => {
    it('la dueña ve sus avisos, lo que puede apagar y lo que llega siempre; la respuesta cumple el contrato', async () => {
      const r = await get(owner, '/owner-alerts');
      expect(r.statusCode, r.body).toBe(200);
      const v = r.json() as OwnerAlerts;
      expect(diferenciasConElContrato(OwnerAlerts, v)).toEqual([]);
      expect(v).toMatchObject({ visible: true, pushConfigured: true, devices: 1 });
      expect(v.alerts.length).toBeGreaterThanOrEqual(8);
      expect(v.unseen).toBe(v.alerts.filter((a) => !a.seen).length);
      expect(v.preferences.map((p) => p.kind)).toEqual([...OWNER_ALERT_KINDS]);
      expect(v.preferences.every((p) => p.enabled)).toBe(true);
      expect(v.always.map((a) => a.label)).toEqual(['Solicitudes de firma', 'Tu cuenta con GymFlow']);
      // El más reciente primero, y el que nació en la primera corrida dice que no sonó.
      expect([...v.alerts].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).map((a) => a.id)).toEqual(v.alerts.map((a) => a.id));
      expect(new Date(v.nextSummaryAt!).getTime()).toBeGreaterThan(Date.now());
    });

    it('la gerencia y recepción no ven nada ni ajustan nada (aunque tengan todo liberado)', async () => {
      for (const cookie of [gerente, recepcion]) {
        const r = await get(cookie, '/owner-alerts');
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json()).toEqual({ visible: false, pushConfigured: false, devices: 0, unseen: 0, alerts: [], summaries: [], nextSummaryAt: null, preferences: [], always: [] });
        expect((await post(cookie, '/owner-alerts/seen')).json()).toEqual({ seen: 0 });
        const p = await put(cookie, '/owner-alerts/preferences', { kind: 'CASH_VARIANCE', enabled: false });
        expect(p.statusCode, p.body).toBe(403);
      }
      expect(await getDb().pushPreference.count({ where: { organizationId: g.organizationId } })).toBe(0);
      expect(await getDb().ownerAlert.count({ where: { organizationId: g.organizationId, seenAt: { not: null } } })).toBe(0);
    });

    it('un aviso al teléfono de la gerencia no existe: solo suena el de quien tiene el puesto Dueño', async () => {
      const suyo = `https://push.example/${uuidv7()}`;
      expect((await post(gerente, '/me/push-subscriptions', { endpoint: suyo, keys: { p256dh: 'p256dh-de-prueba-0123456789', auth: 'auth-de-prueba' } })).statusCode).toBe(201);
      await corteCon(-3_300n);
      expect(await scan.pasada(g.organizationId)).toMatchObject({ nuevos: 1, alTelefono: 1 });
      expect(enviados.filter((e) => e.endpoint === suyo)).toEqual([]);
    });

    it('sin sesión no responde', async () => {
      expect((await app.inject({ method: 'GET', url: '/owner-alerts' })).statusCode).toBe(401);
    });
  });

  describe('cada aviso se puede apagar', () => {
    it('apagado, el aviso deja de sonar y sigue saliendo en el panel; encendido, vuelve a sonar', async () => {
      const apagar = await put(owner, '/owner-alerts/preferences', { kind: 'CASH_VARIANCE', enabled: false });
      expect(apagar.statusCode, apagar.body).toBe(200);
      expect(apagar.json()).toEqual({ kind: 'CASH_VARIANCE', enabled: false });
      expect(((await get(owner, '/owner-alerts')).json() as OwnerAlerts).preferences.filter((p) => !p.enabled).map((p) => p.kind)).toEqual(['CASH_VARIANCE']);

      const callado = await corteCon(-6_000n);
      const antes = delTelefono().length;
      expect(await scan.pasada(g.organizationId)).toMatchObject({ nuevos: 1, alTelefono: 0 });
      expect(delTelefono().length).toBe(antes);
      const [aviso] = await avisos({ dedupeKey: `cash-variance:${callado}` });
      expect(aviso).toMatchObject({ pushDevices: 0, silent: false });
      expect(((await get(owner, '/owner-alerts')).json() as OwnerAlerts).alerts.find((a) => a.id === aviso!.id)).toMatchObject({ pushDevices: 0, seen: false });

      // Los demás tipos siguen sonando.
      await cajaOlvidada(g.sedes[0]!.cajas[0]!);
      expect(await scan.pasada(g.organizationId)).toMatchObject({ nuevos: 1, alTelefono: 1 });

      expect((await put(owner, '/owner-alerts/preferences', { kind: 'CASH_VARIANCE', enabled: true })).statusCode).toBe(200);
      await getDb().cashSession.updateMany({ where: { organizationId: g.organizationId, status: 'OPEN' }, data: { status: 'CLOSED', closedAt: new Date(), closedByUserId: idRecepcion, countedCashCents: FONDO, expectedCashCents: FONDO, varianceCents: 0n } });
      await corteCon(-4_400n);
      expect(await scan.pasada(g.organizationId)).toMatchObject({ nuevos: 1, alTelefono: 1 });
    });

    it('apagar y encender queda en la bitácora, y repetir el mismo toque no asienta nada', async () => {
      const cuenta = () => getDb().auditLog.count({ where: { organizationId: g.organizationId, action: { in: ['settings.owner_alert.off', 'settings.owner_alert.on'] } } });
      const antes = await cuenta();
      expect(antes).toBe(2);
      await put(owner, '/owner-alerts/preferences', { kind: 'DEBT_LOST', enabled: false });
      await put(owner, '/owner-alerts/preferences', { kind: 'DEBT_LOST', enabled: false });
      expect(await cuenta()).toBe(antes + 1);
      const ultimo = await getDb().auditLog.findFirst({ where: { organizationId: g.organizationId, action: 'settings.owner_alert.off' }, orderBy: { chainSeq: 'desc' } });
      expect(ultimo!.afterState).toMatchObject({ kind: 'DEBT_LOST', label: 'Deuda dada por perdida', enabled: false });
      await put(owner, '/owner-alerts/preferences', { kind: 'DEBT_LOST', enabled: true });
    });

    it('un tipo que no existe se rechaza', async () => {
      expect((await put(owner, '/owner-alerts/preferences', { kind: 'GYMFLOW_ACCOUNT', enabled: false })).statusCode).toBe(422);
      expect((await put(owner, '/owner-alerts/preferences', { kind: 'CASH_VARIANCE' })).statusCode).toBe(422);
    });

    it('lo que otros módulos ya mandaban respeta lo apagado; una solicitud de firma (sin tipo) llega siempre', async () => {
      const push = new PushService();
      const ownerIds = [g.ownerId];
      const mandar = (kind?: 'EXMEMBERS_LIST' | 'PASSWORD_FAILS') => push.sendToUsers(g.organizationId, ownerIds, { title: 'Prueba', body: 'Prueba', url: '/panel', ...(kind ? { kind } : {}) });
      expect(await mandar('EXMEMBERS_LIST')).toBe(1);
      await put(owner, '/owner-alerts/preferences', { kind: 'EXMEMBERS_LIST', enabled: false });
      expect(await mandar('EXMEMBERS_LIST')).toBe(0);
      expect(await mandar('PASSWORD_FAILS')).toBe(1);
      expect(await mandar()).toBe(1);
      await put(owner, '/owner-alerts/preferences', { kind: 'EXMEMBERS_LIST', enabled: true });
      expect(await mandar('EXMEMBERS_LIST')).toBe(1);
    });
  });

  describe('vistos', () => {
    it('al abrir sus avisos dejan de contar como nuevos', async () => {
      const antes = (await get(owner, '/owner-alerts')).json() as OwnerAlerts;
      expect(antes.unseen).toBeGreaterThan(0);
      const r = await post(owner, '/owner-alerts/seen');
      expect(r.statusCode, r.body).toBe(200);
      expect((r.json() as { seen: number }).seen).toBe(antes.unseen);
      const despues = (await get(owner, '/owner-alerts')).json() as OwnerAlerts;
      expect(despues.unseen).toBe(0);
      expect(despues.alerts.every((a) => a.seen)).toBe(true);
      expect((await post(owner, '/owner-alerts/seen')).json()).toEqual({ seen: 0 });
    });
  });

  describe('el resumen del lunes a las 7:00', () => {
    /** El primer lunes a las 7:00 (hora del gimnasio) cuya semana resumida incluye el día de hoy. */
    const lunesQueResumeHoy = () => {
      const hoy = hoyEn(ZONA);
      for (let d = 1; d <= 9; d++) {
        const s = semanaDelResumen(ZONA, new Date(Date.now() + d * DIA));
        if (s.from <= hoy && hoy < s.to) return s;
      }
      throw new Error('No se encontró el lunes que resume esta semana');
    };

    it('antes de ese lunes a las 7:00 no manda nada: el resumen de una semana anterior al arranque no sale', async () => {
      const s = lunesQueResumeHoy();
      const antes = delTelefono().length;
      expect(await resumen.pasada(g.organizationId, new Date(s.dueAt.getTime() - 60_000))).toMatchObject({ estado: 'before-start', equipos: 0 });
      expect(await resumen.pasada(g.organizationId)).toMatchObject({ estado: 'before-start' });
      expect(delTelefono().length).toBe(antes);
      expect(await avisos({ kind: 'WEEKLY_SUMMARY' })).toEqual([]);
    });

    it('el lunes a las 7:00 sale uno, con la semana en cifras y sin nombres; repetir la corrida no manda otro', async () => {
      const s = lunesQueResumeHoy();
      // Dos descuentos de recepción y una venta fechada hacia atrás, esta semana.
      for (let i = 0; i < 2; i++) await audit.record(como(idRecepcion), { action: 'billing.discount.apply', resourceType: 'charge', resourceId: uuidv7(), branchId: sede, reason: 'Promoción de la prueba', afterState: { memberId: socioId } });
      await audit.record(como(idRecepcion), { action: 'membership.sale', resourceType: 'membership', resourceId: uuidv7(), branchId: sede, afterState: { backdated: true, memberId: socioId } });

      const antes = delTelefono().length;
      const r = await resumen.pasada(g.organizationId, s.dueAt);
      expect(r).toEqual({ estado: 'sent', monday: s.monday, equipos: 1 });
      const [fila] = await avisos({ kind: 'WEEKLY_SUMMARY' });
      expect(fila).toMatchObject({ dedupeKey: `weekly:${s.monday}`, url: '/avisos', pushDevices: 1, silent: false });
      expect(fila!.occurredAt.toISOString()).toBe(s.dueAt.toISOString());

      const d = fila!.detail as { from: string; to: string; figures: Record<string, Record<string, unknown>>; people: Array<Record<string, unknown>> };
      expect(d.from).toBe(s.from);
      // Los cortes de esta prueba: −75, −50, −20, +40, −33, −60 y −44 pesos; quedan por revisar los seis de más de $20.
      expect(d.figures.cash).toEqual({ variances: 7, shortCents: '28200', overCents: '4000', pendingReview: 6 });
      expect(d.figures.members).toEqual({ joined: 1, left: 0 });
      expect(d.figures.entries).toEqual({ total: 0, previous: 0 });
      expect(d.figures.money).toMatchObject({ collectedCents: '0', discounts: 2, backdatedSales: 1, lostDebtCents: '250000', refunds: { count: 0, cents: '0' } });
      expect(d.figures.exceptions).toEqual({ manualEntries: 12, overLimit: 1, withoutFace: 0, sharedPhoneChanges: 0 });
      expect(d.figures.awaiting).toEqual({ approvals: 0, privacyNotice: 1, exMembersList: 0 });
      expect(d.figures.audit).toMatchObject({ intact: true });
      expect(d.people).toEqual([{ name: nombreRecepcion, discounts: 2, refunds: 0, usual: 0 }]);

      const sonaron = delTelefono().slice(antes);
      expect(sonaron).toHaveLength(1);
      expect(sonaron[0]!.payload.title.startsWith('Tu semana (')).toBe(true);
      expect(sonaron[0]!.payload.body).toContain('0 entradas · 1 alta y 0 bajas · cobrado $0.00');
      expect(sonaron[0]!.payload.body).toContain('7 cortes con diferencia');
      expect(sonaron[0]!.payload.body).toContain('1 cosa espera tu firma');
      expect(sonaron[0]!.payload.body).not.toContain(nombreRecepcion);
      expect(sonaron[0]!.payload.body).not.toContain(nombreSocio);

      // Quince minutos después, y el jueves: ya está mandado.
      expect(await resumen.pasada(g.organizationId, new Date(s.dueAt.getTime() + 15 * 60_000))).toMatchObject({ estado: 'already', equipos: 0 });
      expect(await resumen.pasada(g.organizationId, new Date(s.dueAt.getTime() + 3 * DIA))).toMatchObject({ estado: 'already' });
      expect(delTelefono().length).toBe(antes + 1);
      expect(await avisos({ kind: 'WEEKLY_SUMMARY' })).toHaveLength(1);
    });

    it('el lunes siguiente sale el suyo, y el panel los trae con sus cifras', async () => {
      const s = lunesQueResumeHoy();
      const siguiente = new Date(s.dueAt.getTime() + 7 * DIA + 3_600_000);
      expect(await resumen.pasada(g.organizationId, siguiente)).toMatchObject({ estado: 'sent', monday: semanaDelResumen(ZONA, siguiente).monday });
      const v = (await get(owner, '/owner-alerts')).json() as OwnerAlerts;
      expect(diferenciasConElContrato(OwnerAlerts, v)).toEqual([]);
      expect(v.summaries).toHaveLength(2);
      expect(v.summaries.map((x) => x.from)).toEqual([s.to, s.from]);
      expect(v.summaries[1]!.figures.cash.variances).toBe(7);
      // Los resúmenes no se mezclan con la lista de avisos.
      expect(v.alerts.some((a) => a.kind === 'WEEKLY_SUMMARY')).toBe(false);
    });

    it('con el resumen apagado se guarda en el panel y el teléfono no suena', async () => {
      const s = lunesQueResumeHoy();
      await put(owner, '/owner-alerts/preferences', { kind: 'WEEKLY_SUMMARY', enabled: false });
      const antes = delTelefono().length;
      expect(await resumen.pasada(g.organizationId, new Date(s.dueAt.getTime() + 14 * DIA + 3_600_000))).toMatchObject({ estado: 'sent', equipos: 0 });
      expect(delTelefono().length).toBe(antes);
      expect(await avisos({ kind: 'WEEKLY_SUMMARY' })).toHaveLength(3);
    });

    it('en un gimnasio donde el escaneo nunca ha corrido, el resumen no hace nada ni le quita su primera corrida', async () => {
      const otro = await gimnasioPropio();
      try {
        expect(await resumen.pasada(otro.organizationId)).toMatchObject({ estado: 'first-run', equipos: 0 });
        expect(await getDb().ownerAlertStart.count({ where: { organizationId: otro.organizationId } })).toBe(0);
        expect(await getDb().ownerAlert.count({ where: { organizationId: otro.organizationId } })).toBe(0);
        // El arranque lo fija el escaneo, y esa sí es su primera corrida (la que no suena).
        expect(await scan.pasada(otro.organizationId)).toMatchObject({ primera: true, nuevos: 0, alTelefono: 0 });
        expect(await getDb().ownerAlertStart.count({ where: { organizationId: otro.organizationId } })).toBe(1);
      } finally { await otro.cerrar(); }
    });
  });
});
