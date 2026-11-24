import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ACCESS_POLICY_VERSION, AVISO_PASE_DE_PRUEBA, auditPhrase, uuidv7 } from '@gymflow/core';
import {
  AccessAttemptPreview, AccessAttemptResult, AccessGrantResult, AccessResolution, FaceRule, FaceRulePending,
  MemberTrialPass, TrialPassGrantResult, diferenciasConElContrato,
} from '@gymflow/core/contracts';
import { makeApp, loginAs, aprobacion, telefonoUnico } from './helpers.js';
import { gimnasioPropio, socioPropio, type GimnasioPropio, type SedePropia } from './gimnasio-propio.js';
import { ponerReloj, relojReal } from './reloj.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * BIOMETRÍA Y ENTRADA (auditoría 8, fase 3, bloque 3.3). Política de acceso 4.0.0.
 *
 *   D-07 · Una entrada por día y sucursal: la segunda se registra, pero no
 *          cuenta otra asistencia ni descuenta otra visita.
 *   D-06 · Un socio sin rostro registrado NUNCA entra, salvo que la gerencia
 *          autorice esa visita. Recepción no lo deja pasar con un motivo.
 *   D-08 · Un pase de prueba gratis por persona, identificada por su celular,
 *          registrado como entrada.
 *
 * Gimnasio propio (dos sedes, Biometría encendida en las dos): nada de esto
 * toca al Gimnasio Demo. Las entradas son del día de operación de hoy: no
 * dependen de la hora en que corra la prueba.
 */
describe('biometría y entrada (3.3)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let centro: SedePropia;
  let norte: SedePropia;
  let gerente: string;
  let recepcion: string;
  let duena: string;
  let gerenteId: string;
  let recepcionId: string;

  const db = () => getDb();
  const MOTIVO = 'La estación está apagada';

  /**
   * Dos pasos del mismo socio en menos de 8 s son «doble paso». Entre una
   * entrada y la siguiente el reloj del proceso se adelanta 10 s (el de la
   * base sigue siendo el real): son dos visitas a la puerta, no un doble clic.
   */
  let adelanto = 0;
  const despues = () => { relojReal(); adelanto += 10_000; ponerReloj(new Date(Date.now() + adelanto).toISOString()); };

  async function socio(sede: SedePropia = centro, conCelular = true): Promise<string> {
    const id = await socioPropio(g, sede);
    if (conCelular) await db().member.update({ where: { id }, data: { phoneE164: telefonoUnico() } });
    return id;
  }
  /** Membresía mensual activa, directa en la base: aquí se prueba la puerta, no la venta. */
  async function conPlan(sede: SedePropia = centro, estado: 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' = 'ACTIVE'): Promise<string> {
    const memberId = await socio(sede);
    const hoy = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    await db().plan.update({ where: { id: g.planMensual }, data: { branchAccessScope: 'ALL_BRANCHES' } });
    await db().membership.create({
      data: {
        id: uuidv7(), organizationId: g.organizationId, memberId, planId: g.planMensual, soldAtBranchId: sede.id, status: estado,
        startDate: new Date(hoy.getTime() - 5 * 86_400_000), currentPeriodStart: new Date(hoy.getTime() - 5 * 86_400_000),
        currentPeriodEnd: new Date(hoy.getTime() + 25 * 86_400_000), billingAnchorDay: 1,
      },
    });
    return memberId;
  }
  async function conPaquete(visitas: number): Promise<{ memberId: string; packId: string }> {
    const memberId = await socio();
    const packId = uuidv7();
    const hoy = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    await db().visitPack.create({ data: { id: packId, organizationId: g.organizationId, memberId, visitsPurchased: visitas, purchasedOn: new Date(hoy.getTime() - 86_400_000), status: 'ACTIVE' } });
    await db().visitLedgerEntry.create({ data: { id: uuidv7(), organizationId: g.organizationId, visitPackId: packId, entryType: 'PURCHASE', delta: visitas, businessDate: new Date(hoy.getTime() - 86_400_000) } });
    return { memberId, packId };
  }
  const saldo = async (packId: string) => (await db().visitLedgerEntry.aggregate({ where: { visitPackId: packId }, _sum: { delta: true } }))._sum.delta ?? 0;
  const asistencias = (memberId: string, branchId?: string) => db().attendanceEvent.count({ where: { memberId, ...(branchId ? { branchId } : {}) } });
  const decisiones = (memberId: string) => db().accessDecision.findMany({ where: { memberId }, orderBy: { at: 'asc' } });
  const asientos = (action: string, resourceId: string) => db().auditLog.findMany({ where: { organizationId: g.organizationId, action, resourceId } });

  const intentar = (memberId: string, extra: Record<string, unknown> = {}, cookie = recepcion, sede: SedePropia = centro) => app.inject({
    method: 'POST', url: '/access/attempts', headers: { cookie },
    payload: { branchId: sede.id, memberId, credentialKind: 'MANUAL', ...extra },
  });
  const previa = (memberId: string, sede: SedePropia = centro, cookie = gerente) => app.inject({
    method: 'POST', url: '/access/attempts/preview', headers: { cookie }, payload: { branchId: sede.id, memberId },
  });
  const conceder = (decisionId: string, cookie: string, extra: Record<string, unknown> = {}) => app.inject({
    method: 'POST', url: `/access/decisions/${decisionId}/grant`, headers: { cookie }, payload: { reason: 'No quiere registrar su rostro', ...extra },
  });
  const regla = (enabled: boolean, cookie = gerente) => app.inject({
    method: 'PUT', url: '/access/face-rule', headers: { cookie }, payload: { enabled, reason: enabled ? 'Ya se registran rostros en recepción' : 'Se apaga para la prueba' },
  });
  const enrolar = async (memberId: string, sede: SedePropia = centro) => {
    const r = await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`, headers: { cookie: gerente },
      payload: { modality: 'FACE', branchId: sede.id, templateRef: `tpl_${uuidv7()}`, algorithmVendor: 'insightface/buffalo_sc', algorithmVersion: '0.7.3', reason: 'Alta del rostro para la prueba' },
    });
    expect(r.statusCode, r.body).toBe(201);
  };

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Centro', cajas: 1 }, { name: 'Norte', cajas: 1 }] });
    [centro, norte] = g.sedes as [SedePropia, SedePropia];
    gerente = await loginAs(app, g.correos.gerente);
    recepcion = await loginAs(app, g.correos.recepcion);
    duena = await loginAs(app, g.correos.owner);
    gerenteId = (await db().user.findFirstOrThrow({ where: { email: g.correos.gerente } })).id;
    recepcionId = (await db().user.findFirstOrThrow({ where: { email: g.correos.recepcion } })).id;
    // Para registrar un rostro hace falta el texto biométrico publicado.
    const { ConsentDocumentRepository } = await import('../src/modules/members/index.js');
    const textos = new ConsentDocumentRepository(g.organizationId);
    const bio = await textos.create({ consentType: 'BIOMETRIC', version: 'bio-1', title: 'Biométrico de prueba', bodyText: 'Texto biométrico de prueba' });
    await textos.publish(bio.id, null);
  }, 120_000);

  afterAll(async () => {
    relojReal();
    await g.cerrar();
    await app.close();
    await closeDb();
  });

  // ══ D-07 ══════════════════════════════════════════════════════════════════
  describe('D-07 · una entrada por día y sucursal', () => {
    it('con plan: la segunda entrada del día pasa y se registra, pero no cuenta otra asistencia', async () => {
      const m = await conPlan();
      const primera = await intentar(m, { reason: MOTIVO });
      expect(primera.statusCode, primera.body).toBe(201);
      expect(diferenciasConElContrato(AccessAttemptResult, primera.json())).toEqual([]);
      expect(primera.json()).toMatchObject({ outcome: 'GRANTED', reentry: false, policyVersion: ACCESS_POLICY_VERSION });
      expect(primera.json().attendanceId).toBeTruthy();
      expect(ACCESS_POLICY_VERSION).toBe('4.0.0');

      despues();
      const vista = await previa(m);
      expect(diferenciasConElContrato(AccessAttemptPreview, vista.json())).toEqual([]);
      expect(vista.json()).toMatchObject({ outcome: 'GRANTED', reentry: true, wouldConsumeVisit: false });

      const segunda = await intentar(m, { reason: MOTIVO });
      expect(segunda.json()).toMatchObject({ outcome: 'GRANTED', reentry: true, consumedVisit: false, attendanceId: null });
      despues();
      const tercera = await intentar(m, { reason: MOTIVO });
      expect(tercera.json()).toMatchObject({ outcome: 'GRANTED', reentry: true, attendanceId: null });

      expect(await asistencias(m)).toBe(1);
      const filas = await decisiones(m);
      expect(filas.map((d) => [d.outcome, d.reentry])).toEqual([['GRANTED', false], ['GRANTED', true], ['GRANTED', true]]);
    });

    it('con paquete: la primera descuenta una visita, la segunda del día no; en otra sucursal sí es otra entrada', async () => {
      const { memberId, packId } = await conPaquete(3);
      const primera = await intentar(memberId, { reason: MOTIVO });
      expect(primera.json()).toMatchObject({ outcome: 'GRANTED', consumedVisit: true, reentry: false });
      expect(await saldo(packId)).toBe(2);

      despues();
      const segunda = await intentar(memberId, { reason: MOTIVO });
      expect(segunda.json()).toMatchObject({ outcome: 'GRANTED', consumedVisit: false, reentry: true });
      expect(await saldo(packId)).toBe(2);
      expect(await asistencias(memberId)).toBe(1);

      // «Por día y SUCURSAL»: en la otra sede es su primera entrada de hoy ahí.
      despues();
      const enNorte = await intentar(memberId, { reason: MOTIVO }, gerente, norte);
      expect(enNorte.json()).toMatchObject({ outcome: 'GRANTED', consumedVisit: true, reentry: false });
      expect(await saldo(packId)).toBe(1);
      expect(await asistencias(memberId, norte.id)).toBe(1);
    });

    it('la última visita del paquete paga el día: vuelve a entrar con el paquete agotado', async () => {
      const { memberId, packId } = await conPaquete(1);
      expect((await intentar(memberId, { reason: MOTIVO })).json()).toMatchObject({ outcome: 'GRANTED', consumedVisit: true });
      expect(await saldo(packId)).toBe(0);
      expect((await db().visitPack.findUniqueOrThrow({ where: { id: packId } })).status).toBe('EXHAUSTED');

      despues();
      const otraVez = await intentar(memberId, { reason: MOTIVO });
      expect(otraVez.json()).toMatchObject({ outcome: 'GRANTED', consumedVisit: false, reentry: true });
      expect(await saldo(packId)).toBe(0);
      // En la otra sucursal no entró hoy: ahí el paquete agotado no abre.
      despues();
      expect((await intentar(memberId, { reason: MOTIVO }, gerente, norte)).json()).toMatchObject({ outcome: 'DENIED', reason: 'NO_VISITS_LEFT' });
    });

    it('la reentrada no abre lo que hoy dejó de abrir, y el paso concedido después tampoco cuenta dos veces', async () => {
      const m = await conPlan();
      expect((await intentar(m, { reason: MOTIVO })).json().outcome).toBe('GRANTED');
      await db().membership.updateMany({ where: { memberId: m }, data: { status: 'SUSPENDED' } });
      despues();
      const rechazo = await intentar(m, { reason: MOTIVO });
      expect(rechazo.json()).toMatchObject({ outcome: 'DENIED', reason: 'MEMBERSHIP_SUSPENDED', reentry: false });

      const paso = await conceder(rechazo.json().decisionId, recepcion, { reason: 'Paga hoy al salir' });
      expect(paso.statusCode, paso.body).toBe(201);
      expect(diferenciasConElContrato(AccessGrantResult, paso.json())).toEqual([]);
      expect(paso.json()).toMatchObject({ outcome: 'GRANTED', reentry: true, attendanceId: null });
      expect(await asistencias(m)).toBe(1);
    });

    it('dos pasos al mismo tiempo dejan UNA asistencia', async () => {
      const m = await conPlan();
      const [a, b] = await Promise.all([intentar(m, { reason: MOTIVO }), intentar(m, { reason: MOTIVO })]);
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      expect(await asistencias(m)).toBe(1);
      expect([a.json().attendanceId, b.json().attendanceId].filter(Boolean)).toHaveLength(1);
    });

    it('el monitor dice cuál fue reentrada', async () => {
      const m = await conPlan();
      await intentar(m, { reason: MOTIVO });
      despues();
      await intentar(m, { reason: MOTIVO });
      const lista = await app.inject({ method: 'GET', url: `/access/decisions?memberId=${m}&branchId=${centro.id}`, headers: { cookie: gerente } });
      expect(lista.statusCode, lista.body).toBe(200);
      expect((lista.json().decisions as Array<{ reentry: boolean }>).map((d) => d.reentry).sort()).toEqual([false, true]);
    });
  });

  // ══ D-06 ══════════════════════════════════════════════════════════════════
  describe('D-06 · sin rostro no se entra, salvo que la gerencia autorice esa visita', () => {
    it('la regla nace apagada y sin ella todo sigue como antes: entra por el mostrador con motivo', async () => {
      const estado = await app.inject({ method: 'GET', url: '/access/face-rule', headers: { cookie: gerente } });
      expect(estado.statusCode, estado.body).toBe(200);
      expect(diferenciasConElContrato(FaceRule, estado.json())).toEqual([]);
      expect(estado.json().enabled).toBe(false);

      const m = await conPlan();
      const vista = await previa(m);
      expect(vista.json()).toMatchObject({ outcome: 'GRANTED', policy: { requiresReason: true, hasBiometric: false, faceRequired: false } });
      expect((await intentar(m)).statusCode).toBe(422);
      expect((await intentar(m, { reason: 'Aún no tiene su rostro registrado' })).json().outcome).toBe('GRANTED');
    });

    it('la enciende la gerencia, con motivo; recepción y la dueña no', async () => {
      expect((await regla(true, recepcion)).statusCode).toBe(403);
      expect((await regla(true, duena)).statusCode).toBe(403);
      const sinMotivo = await app.inject({ method: 'PUT', url: '/access/face-rule', headers: { cookie: gerente }, payload: { enabled: true } });
      expect(sinMotivo.statusCode).toBe(422);

      const sinRostro = await conPlan();
      const conRostro = await conPlan();
      await enrolar(conRostro);

      const r = await regla(true);
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(FaceRule, r.json())).toEqual([]);
      expect(r.json().enabled).toBe(true);
      expect(r.json().changedByName).toBeTruthy();
      const enCentro = (r.json().branches as Array<{ branchId: string; canEnter: number; withoutFace: number }>).find((b) => b.branchId === centro.id)!;
      expect(enCentro.canEnter).toBeGreaterThanOrEqual(2);
      expect(enCentro.withoutFace).toBe(enCentro.canEnter - 1);

      const cambio = await asientos('access.face_rule.change', g.organizationId);
      expect(cambio).toHaveLength(1);
      expect(cambio[0]!.reason).toBe('Ya se registran rostros en recepción');
      expect(cambio[0]!.afterState).toMatchObject({ requireFaceToEnter: true, membersWithoutFace: enCentro.withoutFace });
      expect(auditPhrase({ action: 'access.face_rule.change', afterState: cambio[0]!.afterState })).toBe('cambió la regla de entrar solo con rostro');

      // A quién le falta: está el que no tiene rostro y no el que sí.
      const faltan = await app.inject({ method: 'GET', url: `/access/face-rule/pending?branchId=${centro.id}&limit=200`, headers: { cookie: recepcion } });
      expect(faltan.statusCode, faltan.body).toBe(200);
      expect(diferenciasConElContrato(FaceRulePending, faltan.json())).toEqual([]);
      const ids = (faltan.json().members as Array<{ memberId: string }>).map((x) => x.memberId);
      expect(ids).toContain(sinRostro);
      expect(ids).not.toContain(conRostro);
      expect(faltan.json().total).toBe(enCentro.withoutFace);
    });

    it('con su plan al corriente y sin rostro NO entra: ni con motivo, ni dejándolo pasar recepción', async () => {
      const m = await conPlan();
      const vista = await previa(m, centro, recepcion);
      expect(vista.json()).toMatchObject({ outcome: 'DENIED', reason: 'BIOMETRIC_REQUIRED', overridable: false, policy: { hasBiometric: false, faceRequired: true } });

      const intento = await intentar(m, { reason: 'Aún no tiene su rostro registrado' });
      expect(intento.statusCode, intento.body).toBe(201);
      expect(intento.json()).toMatchObject({ outcome: 'DENIED', reason: 'BIOMETRIC_REQUIRED', overridable: false, attendanceId: null });
      expect(await asistencias(m)).toBe(0);

      // Queda pendiente en la puerta: ahí lo ve la gerencia.
      const pendientes = await app.inject({ method: 'GET', url: `/access/pending?branchId=${centro.id}&limit=100`, headers: { cookie: gerente } });
      expect((pendientes.json().pending as Array<{ memberId: string; reason: string }>).find((p) => p.memberId === m)?.reason).toBe('BIOMETRIC_REQUIRED');

      // Recepción no lo levanta.
      const deRecepcion = await conceder(intento.json().decisionId, recepcion);
      expect(deRecepcion.statusCode, deRecepcion.body).toBe(409);
      expect(deRecepcion.json().reason).toBe('FACE_AUTHORIZATION_REQUIRED');
      expect(await asistencias(m)).toBe(0);
      const sinResolver = await app.inject({ method: 'GET', url: `/access/decisions/${intento.json().decisionId}/resolution`, headers: { cookie: recepcion } });
      expect(diferenciasConElContrato(AccessResolution, sinResolver.json())).toEqual([]);
      expect(sinResolver.json().resolved).toBe(false);
    });

    it('la gerencia autoriza ESA visita: entra, y queda quién autorizó y por qué', async () => {
      const m = await conPlan();
      const intento = await intentar(m);
      expect(intento.json().reason).toBe('BIOMETRIC_REQUIRED');

      // Autorizar pide motivo.
      expect((await app.inject({ method: 'POST', url: `/access/decisions/${intento.json().decisionId}/grant`, headers: { cookie: gerente }, payload: {} })).statusCode).toBe(422);

      const paso = await conceder(intento.json().decisionId, gerente);
      expect(paso.statusCode, paso.body).toBe(201);
      expect(diferenciasConElContrato(AccessGrantResult, paso.json())).toEqual([]);
      expect(paso.json()).toMatchObject({ outcome: 'GRANTED', reason: null, reentry: false, overriddenFrom: intento.json().decisionId });
      expect(paso.json().attendanceId).toBeTruthy();
      expect(paso.json().authorizedByName).toBeTruthy();
      expect(await asistencias(m)).toBe(1);

      const decision = await db().accessDecision.findUniqueOrThrow({ where: { id: paso.json().decisionId } });
      expect(decision).toMatchObject({ outcome: 'GRANTED', overriddenByUserId: gerenteId, overrideReason: 'No quiere registrar su rostro', resolvesDecisionId: intento.json().decisionId, credentialKind: 'MANUAL' });

      const [asiento] = await asientos('access.entry.authorize_without_face', paso.json().decisionId);
      expect(asiento).toBeTruthy();
      expect(asiento!.actorUserId).toBe(gerenteId);
      expect(asiento!.reason).toBe('No quiere registrar su rostro');
      expect(asiento!.afterState).toMatchObject({ memberId: m, authorizedByUserId: gerenteId, registeredByUserId: gerenteId, signature: false, reasonCode: 'NO_QUIERE_BIOMETRIA' });

      // Ya no está pendiente, quien esperaba se entera y no se autoriza dos veces.
      const resuelto = await app.inject({ method: 'GET', url: `/access/decisions/${intento.json().decisionId}/resolution`, headers: { cookie: recepcion } });
      expect(resuelto.json()).toMatchObject({ resolved: true });
      expect(resuelto.json().byName).toBeTruthy();
      const otra = await conceder(intento.json().decisionId, gerente);
      expect(otra.statusCode).toBe(409);
      expect(otra.json().reason).toBe('ALREADY_RESOLVED');
      expect(await asistencias(m)).toBe(1);
    });

    it('la autorización es por visita: ese mismo día vuelve a entrar sin pedirla, pero en otra sucursal o en otra visita se pide de nuevo', async () => {
      const m = await conPlan();
      const intento = await intentar(m);
      expect((await conceder(intento.json().decisionId, gerente)).json().outcome).toBe('GRANTED');

      // Reentrada del mismo día en la misma sede: su visita ya está autorizada.
      despues();
      const vista = await previa(m, centro, recepcion);
      expect(vista.json()).toMatchObject({ outcome: 'GRANTED', reentry: true, policy: { requiresReason: false, faceRequired: true } });
      const reentrada = await intentar(m);
      expect(reentrada.json()).toMatchObject({ outcome: 'GRANTED', reentry: true, attendanceId: null });
      const fila = await db().accessDecision.findUniqueOrThrow({ where: { id: reentrada.json().decisionId } });
      expect(fila.overrideReason).toMatch(/Reentrada del día/);
      expect(fila.overriddenByUserId).toBe(recepcionId);

      // En la otra sucursal no hay visita autorizada: ni siquiera la gerencia la registra sin autorizarla.
      despues();
      const enNorte = await intentar(m, { reason: 'Aún no tiene su rostro registrado' }, gerente, norte);
      expect(enNorte.json()).toMatchObject({ outcome: 'DENIED', reason: 'BIOMETRIC_REQUIRED' });
      expect(await asistencias(m)).toBe(1);
    });

    it('si la gerencia no está, vale la firma de la dueña: recepción registra y queda que firmó ella', async () => {
      const m = await conPlan();
      const intento = await intentar(m);
      // Una firma para OTRO socio no sirve.
      const ajeno = await conPlan();
      const firmaAjena = await aprobacion(app, recepcion, 'access:entry:authorize', g.correos.owner, centro.id, { resourceId: ajeno });
      const conFirmaAjena = await conceder(intento.json().decisionId, recepcion, { approvalToken: firmaAjena });
      expect(conFirmaAjena.statusCode, conFirmaAjena.body).toBe(422);
      expect(await asistencias(m)).toBe(0);

      const firma = await aprobacion(app, recepcion, 'access:entry:authorize', g.correos.owner, centro.id, { resourceId: m });
      const paso = await conceder(intento.json().decisionId, recepcion, { approvalToken: firma, reason: 'Registra su rostro en su próxima visita' });
      expect(paso.statusCode, paso.body).toBe(201);
      expect(paso.json().outcome).toBe('GRANTED');
      expect(await asistencias(m)).toBe(1);

      const decision = await db().accessDecision.findUniqueOrThrow({ where: { id: paso.json().decisionId } });
      expect(decision.overriddenByUserId).toBe(g.ownerId);
      const [asiento] = await asientos('access.entry.authorize_without_face', paso.json().decisionId);
      expect(asiento!.actorUserId).toBe(recepcionId);
      expect(asiento!.approvedByUserId).toBe(g.ownerId);
      expect(asiento!.afterState).toMatchObject({ authorizedByUserId: g.ownerId, registeredByUserId: recepcionId, signature: true, reasonCode: 'LO_REGISTRA_DESPUES' });

      // La firma es de un solo uso.
      const otro = await conPlan();
      const otroIntento = await intentar(otro);
      expect((await conceder(otroIntento.json().decisionId, recepcion, { approvalToken: firma })).statusCode).toBe(422);
    });

    it('con paquete: el rechazo no descuenta nada y la entrada autorizada descuenta UNA visita', async () => {
      const { memberId, packId } = await conPaquete(4);
      const intento = await intentar(memberId);
      expect(intento.json()).toMatchObject({ outcome: 'DENIED', reason: 'BIOMETRIC_REQUIRED', consumedVisit: false });
      expect(await saldo(packId)).toBe(4);
      const paso = await conceder(intento.json().decisionId, gerente);
      expect(paso.json()).toMatchObject({ outcome: 'GRANTED', consumedVisit: true });
      expect(await saldo(packId)).toBe(3);
      despues();
      expect((await intentar(memberId)).json()).toMatchObject({ outcome: 'GRANTED', reentry: true, consumedVisit: false });
      expect(await saldo(packId)).toBe(3);
    });

    it('quien ya registró su rostro entra por el mostrador como siempre: con motivo y sin la gerencia', async () => {
      const m = await conPlan();
      await enrolar(m);
      expect((await previa(m, centro, recepcion)).json()).toMatchObject({ outcome: 'GRANTED', policy: { requiresReason: true, hasBiometric: true, faceRequired: true } });
      expect((await intentar(m)).statusCode).toBe(422);
      const r = await intentar(m, { reason: 'La cámara no lo reconoció' });
      expect(r.json()).toMatchObject({ outcome: 'GRANTED', reentry: false });
      expect(await asientos('access.manual_entry', r.json().decisionId)).toHaveLength(1);
    });

    it('si registró su rostro mientras esperaba, la autorización ya no hace falta y entra como excepción normal', async () => {
      const m = await conPlan();
      const intento = await intentar(m);
      expect(intento.json().reason).toBe('BIOMETRIC_REQUIRED');
      await enrolar(m);
      const paso = await conceder(intento.json().decisionId, recepcion, { reason: 'La cámara no lo reconoció' });
      expect(paso.statusCode, paso.body).toBe(201);
      expect(paso.json()).toMatchObject({ outcome: 'GRANTED', authorizedByName: null });
      expect(await asientos('access.entry.authorize_without_face', paso.json().decisionId)).toHaveLength(0);
      expect(await asientos('access.manual_entry', paso.json().decisionId)).toHaveLength(1);
    });

    it('no hay puerta de atrás: al que debe y no tiene rostro, recepción ni lo deja pasar ni le cobra-y-abre', async () => {
      const m = await conPlan(centro, 'PAST_DUE');
      await db().charge.create({
        data: {
          id: uuidv7(), organizationId: g.organizationId, memberId: m, branchId: centro.id, chargeType: 'MANUAL_ADJUSTMENT', status: 'OPEN',
          concept: 'Cuota vencida', subtotalCents: 60_000n, taxCents: 0n, discountCents: 0n, amountCents: 60_000n, dueDate: new Date(Date.now() - 3 * 86_400_000), issuedAt: new Date(),
        },
      });
      // Primero se le dice que debe (el plan va antes que el rostro).
      const rechazo = await intentar(m);
      expect(rechazo.json()).toMatchObject({ outcome: 'DENIED', reason: 'MEMBERSHIP_PAST_DUE', overridable: true });

      const dejar = await conceder(rechazo.json().decisionId, recepcion, { reason: 'Paga hoy al salir' });
      expect(dejar.statusCode, dejar.body).toBe(409);
      expect(dejar.json().reason).toBe('FACE_AUTHORIZATION_REQUIRED');

      const cobrar = await app.inject({
        method: 'POST', url: `/access/decisions/${rechazo.json().decisionId}/collect`, headers: { cookie: recepcion },
        payload: { method: 'SPEI_TRANSFER', externalRef: 'SPEI-3-3-PRUEBA', amountCents: '60000' },
      });
      expect(cobrar.statusCode, cobrar.body).toBe(409);
      expect(cobrar.json().reason).toBe('FACE_AUTHORIZATION_REQUIRED');
      expect(await db().payment.count({ where: { memberId: m } })).toBe(0);
      expect(await asistencias(m)).toBe(0);

      // La gerencia sí puede dejarlo pasar, y queda que pasó sin rostro.
      const deGerencia = await conceder(rechazo.json().decisionId, gerente, { reason: 'Paga hoy al salir' });
      expect(deGerencia.statusCode, deGerencia.body).toBe(201);
      const [asiento] = await asientos('access.manual_grant', deGerencia.json().decisionId);
      expect(asiento!.afterState).toMatchObject({ withoutFace: true, authorizedByUserId: gerenteId, signature: false });
      expect(await asistencias(m)).toBe(1);
    });

    it('autorizada y todo, la puerta sigue decidiendo: si mientras tanto se suspendió, no entra y nada queda resuelto', async () => {
      const m = await conPlan();
      const intento = await intentar(m);
      await db().membership.updateMany({ where: { memberId: m }, data: { status: 'SUSPENDED' } });
      const paso = await conceder(intento.json().decisionId, gerente);
      expect(paso.statusCode, paso.body).toBe(201);
      expect(paso.json()).toMatchObject({ outcome: 'DENIED', reason: 'MEMBERSHIP_SUSPENDED', attendanceId: null });
      expect(await asistencias(m)).toBe(0);
      const r = await app.inject({ method: 'GET', url: `/access/decisions/${intento.json().decisionId}/resolution`, headers: { cookie: gerente } });
      expect(r.json().resolved).toBe(false);
    });

    it('apagada otra vez, vuelve a ser como antes', async () => {
      const m = await conPlan();
      expect((await intentar(m)).json().reason).toBe('BIOMETRIC_REQUIRED');
      expect((await regla(false)).json().enabled).toBe(false);
      despues();
      expect((await intentar(m, { reason: 'Aún no tiene su rostro registrado' })).json()).toMatchObject({ outcome: 'GRANTED' });
      expect(await asientos('access.face_rule.change', g.organizationId)).toHaveLength(2);
    });
  });

  // ══ D-08 ══════════════════════════════════════════════════════════════════
  describe('D-08 · pase de prueba gratis, uno por persona (por celular), registrado como entrada', () => {
    const darPase = (memberId: string, sede: SedePropia = centro, cookie = recepcion) => app.inject({
      method: 'POST', url: `/members/${memberId}/trial-pass`, headers: { cookie }, payload: { branchId: sede.id },
    });
    const pase = (memberId: string, cookie = recepcion) => app.inject({ method: 'GET', url: `/members/${memberId}/trial-pass`, headers: { cookie } });

    it('se le da a quien viene por primera vez, entra hoy en esa sucursal y queda su entrada', async () => {
      const m = await socio();
      const antes = await pase(m);
      expect(antes.statusCode, antes.body).toBe(200);
      expect(diferenciasConElContrato(MemberTrialPass, antes.json())).toEqual([]);
      expect(antes.json()).toMatchObject({ eligible: true, pass: null, blockedBy: null });
      expect((await previa(m)).json().reason).toBe('NO_MEMBERSHIP');

      const dado = await darPase(m);
      expect(dado.statusCode, dado.body).toBe(201);
      expect(diferenciasConElContrato(TrialPassGrantResult, dado.json())).toEqual([]);
      expect(dado.json()).toMatchObject({ created: true, pass: { memberId: m, branchId: centro.id, branchName: 'Centro', validToday: true } });
      expect(dado.json().pass.grantedByName).toBeTruthy();

      // No movió dinero: ni cargo ni pago.
      expect(await db().charge.count({ where: { memberId: m } })).toBe(0);
      expect(await db().payment.count({ where: { memberId: m } })).toBe(0);
      const [asiento] = await asientos('access.trial_pass.grant', dado.json().pass.id);
      expect(asiento!.actorUserId).toBe(recepcionId);
      expect(auditPhrase({ action: 'access.trial_pass.grant', afterState: asiento!.afterState }, { member: 'Ana López' })).toBe('dio un pase de prueba a Ana López');

      // La puerta lo reconoce, solo en su sucursal.
      expect((await previa(m)).json()).toMatchObject({ outcome: 'GRANTED', warning: AVISO_PASE_DE_PRUEBA, wouldConsumeVisit: false });
      expect((await previa(m, norte)).json()).toMatchObject({ outcome: 'DENIED', reason: 'NO_MEMBERSHIP' });
      const entrada = await intentar(m, { reason: 'Viene a probar' });
      expect(entrada.json()).toMatchObject({ outcome: 'GRANTED', warning: AVISO_PASE_DE_PRUEBA, reentry: false });
      expect(entrada.json().attendanceId).toBeTruthy();
      expect(await asistencias(m)).toBe(1);
    });

    it('es UNO: pedirlo otra vez hoy devuelve el mismo; en otra sucursal o con otra ficha del mismo celular, no', async () => {
      const m = await socio();
      const primero = await darPase(m);
      expect(primero.statusCode).toBe(201);
      const repetido = await darPase(m);
      expect(repetido.statusCode, repetido.body).toBe(200);
      expect(repetido.json()).toMatchObject({ created: false, pass: { id: primero.json().pass.id } });
      expect(await db().trialPass.count({ where: { memberId: m } })).toBe(1);

      const enNorte = await darPase(m, norte, gerente);
      expect(enNorte.statusCode, enNorte.body).toBe(409);
      expect(enNorte.json().reason).toBe('TRIAL_PASS_ALREADY_USED');

      // Otra ficha con el MISMO celular (el «vengo a probar» de cada semana).
      const celular = (await db().member.findUniqueOrThrow({ where: { id: m } })).phoneE164!;
      const otraFicha = await socio(centro, false);
      await db().member.update({ where: { id: otraFicha }, data: { phoneE164: celular } });
      const conElMismo = await darPase(otraFicha);
      expect(conElMismo.statusCode, conElMismo.body).toBe(409);
      expect(conElMismo.json().reason).toBe('TRIAL_PASS_ALREADY_USED');
      expect(conElMismo.json().message).toContain(celular.slice(-4));
      const estado = await pase(otraFicha);
      expect(estado.json()).toMatchObject({ eligible: false, blockedBy: 'TRIAL_PASS_ALREADY_USED', pass: null });

      // Cambiar de número en la ficha no estrena otro.
      await db().member.update({ where: { id: m }, data: { phoneE164: telefonoUnico() } });
      const trasCambiar = await pase(m);
      expect(trasCambiar.json()).toMatchObject({ eligible: false, blockedBy: 'TRIAL_PASS_ALREADY_USED' });
      expect(trasCambiar.json().pass.id).toBe(primero.json().pass.id);
    });

    it('el celular no se guarda: queda su huella y sus últimos cuatro dígitos', async () => {
      const m = await socio();
      const celular = (await db().member.findUniqueOrThrow({ where: { id: m } })).phoneE164!;
      const dado = await darPase(m);
      expect(dado.json().pass.phoneLast4).toBe(celular.slice(-4));
      const fila = await db().trialPass.findUniqueOrThrow({ where: { id: dado.json().pass.id } });
      expect(fila.phoneKey).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(fila)).not.toContain(celular.replace('+52', ''));
    });

    it('sin celular no hay pase; y no es para quien ya tiene o tuvo plan', async () => {
      const sinCelular = await socio(centro, false);
      const r = await darPase(sinCelular);
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().reason).toBe('TRIAL_PASS_NEEDS_PHONE');
      expect((await pase(sinCelular)).json()).toMatchObject({ eligible: false, blockedBy: 'TRIAL_PASS_NEEDS_PHONE' });

      const yaSocio = await conPlan();
      const r2 = await darPase(yaSocio);
      expect(r2.statusCode, r2.body).toBe(409);
      expect(r2.json().reason).toBe('TRIAL_PASS_NOT_FIRST_TIME');

      const { memberId: conVisitas } = await conPaquete(2);
      expect((await darPase(conVisitas)).json().reason).toBe('TRIAL_PASS_NOT_FIRST_TIME');
    });

    it('dos mostradores a la vez con el mismo celular dejan UN pase', async () => {
      const a = await socio();
      const b = await socio(centro, false);
      const celular = (await db().member.findUniqueOrThrow({ where: { id: a } })).phoneE164!;
      await db().member.update({ where: { id: b }, data: { phoneE164: celular } });
      const [ra, rb] = await Promise.all([darPase(a), darPase(b, centro, gerente)]);
      expect([ra.statusCode, rb.statusCode].sort()).toEqual([201, 409]);
      expect(await db().trialPass.count({ where: { memberId: { in: [a, b] } } })).toBe(1);
    });

    it('lo da quien vende en el mostrador; la dueña no opera', async () => {
      const m = await socio();
      expect((await darPase(m, centro, duena)).statusCode).toBe(403);
      expect((await darPase(m, norte, recepcion)).statusCode).toBe(403); // recepción es de Centro
      expect(await db().trialPass.count({ where: { memberId: m } })).toBe(0);
    });

    it('con la regla del rostro encendida, el pase de prueba entra sin autorización: no es socio', async () => {
      expect((await regla(true)).json().enabled).toBe(true);
      try {
        const m = await socio();
        expect((await darPase(m)).statusCode).toBe(201);
        const vista = await previa(m, centro, recepcion);
        expect(vista.json()).toMatchObject({ outcome: 'GRANTED', warning: AVISO_PASE_DE_PRUEBA, policy: { requiresReason: false, faceRequired: true } });
        const entrada = await intentar(m);
        expect(entrada.json()).toMatchObject({ outcome: 'GRANTED', reentry: false });
        expect(await asistencias(m)).toBe(1);
        const fila = await db().accessDecision.findUniqueOrThrow({ where: { id: entrada.json().decisionId } });
        expect(fila.overrideReason).toBe(AVISO_PASE_DE_PRUEBA);
      } finally {
        await regla(false);
      }
    });
  });
});
