import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { LISTA_DEL_AVISO_DE_PRIVACIDAD, modeloDeTexto } from '@gymflow/core';
import {
  ConsentDocumentList, ConsentDocumentReview, MemberConsents, MemberPrivacyRequests, PortalConsents, PrivacyInbox, PrivacyRequest,
  PrivacyRequestReceipt, PrivacyRequestsSummary, diferenciasConElContrato,
} from '@gymflow/core/contracts';
import { makeApp, loginAs, loginPlataforma, orgFixtures, nombreUnico, telefonoUnico, aprobacion, cuentaDePrueba, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { systemContext } from '../src/platform/jobs/types.js';
import { ConsentDocumentRepository, ConsentRepository, efectosDeRetiroInscritos, firmarConsentimiento, retirarBiometricoSinRegistro } from '../src/modules/members/index.js';
import { PaymentMethodRepository } from '../src/modules/payments/index.js';
import { PRIVACY_JOBS } from '../src/modules/privacy/index.js';

/**
 * PRIVACIDAD, bloque 1.10 de la auditoría 8 (21-01 a 21-08, 21-10, 21-11, 21-18):
 * el ciclo ARCO completo, firmar y retirar con un solo servicio y «Revisar y
 * publicar» con la lista de verificación del aviso.
 */
describe('privacidad: ciclo ARCO, firmas y textos (1.10)', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let recepcion: string;
  let owner: string;
  let orgId: string;
  let cen: string;

  const DIA = 86_400_000;
  type Solicitud = { id: string; folio: string; status: string; dueAt: string; deadlineAt: string | null; overdue: boolean; outcome: string | null; effectiveDueAt: string | null; effectedAt: string | null; effectNote: string | null; identityVerifiedAt: string | null; resolution: string | null };

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    owner = await loginAs(app, 'owner@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
    // Textos opcionales vigentes para firmar: se publican por el repositorio, como lo haría el arranque.
    const textos = new ConsentDocumentRepository(orgId);
    for (const tipo of ['MARKETING', 'RECURRING_CHARGE', 'BIOMETRIC', 'HEALTH_DATA']) {
      if (await textos.findPublished(tipo)) continue;
      const doc = await textos.create({ consentType: tipo, version: `p${Date.now()}`, title: `${tipo} de prueba`, bodyText: `Texto de prueba ${tipo} para el bloque de privacidad.` });
      await textos.publish(doc.id, null);
    }
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  async function socio(): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Arco'), lastName: nombreUnico('Ciclo'), phoneE164: telefonoUnico(), homeBranchId: cen, force: true, consents: CONSENTIMIENTOS },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }
  const firmar = async (memberId: string, consentType: string) => {
    const r = await app.inject({ method: 'POST', url: `/members/${memberId}/consents`, headers: { cookie: gerencia }, payload: { consentType, granted: true } });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  const registrar = (memberId: string, payload: Record<string, unknown>, cookie = recepcion) =>
    app.inject({ method: 'POST', url: `/members/${memberId}/privacy-requests`, headers: { cookie }, payload });
  const resolver = (id: string, payload: Record<string, unknown>, cookie = gerencia) =>
    app.inject({ method: 'POST', url: `/privacy/requests/${id}/resolve`, headers: { cookie }, payload });
  const avisos = (memberId: string) => getDb().memberNotice.findMany({ where: { memberId }, orderBy: { createdAt: 'asc' } });
  async function portalDe(memberId: string): Promise<string> {
    const invite = await app.inject({ method: 'POST', url: `/members/${memberId}/portal-invite`, headers: { cookie: gerencia } });
    const enroll = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code } });
    return `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}`;
  }

  // ── Ciclo ARCO ────────────────────────────────────────────────────────────

  it('21-04 · recepción registra la solicitud con la identidad verificada; no la resuelve', async () => {
    const id = await socio();
    const sinIdentidad = await registrar(id, { kind: 'RECTIFICATION', channel: 'FRONT_DESK', note: 'Su apellido está mal' });
    expect(sinIdentidad.statusCode, sinIdentidad.body).toBe(422);
    expect(sinIdentidad.json().issues[0].path).toBe('identityVerified');

    const r = await registrar(id, { kind: 'RECTIFICATION', channel: 'FRONT_DESK', note: 'Su apellido está mal', identityVerified: true, identityNote: 'INE' });
    expect(r.statusCode, r.body).toBe(201);
    const s = r.json() as Solicitud;
    expect(diferenciasConElContrato(PrivacyRequest, s)).toEqual([]);
    expect(s.status).toBe('OPEN');
    expect(s.folio).toMatch(/^ARCO-\d{4}-[0-9A-F]{6}$/);
    expect(s.identityVerifiedAt).toBeTruthy();
    // 20 días hábiles guardados como 28 naturales.
    expect(new Date(s.dueAt).getTime() - Date.now()).toBeGreaterThan(27 * DIA);
    expect(s.deadlineAt).toBe(s.dueAt);

    // Recepción atiende, no decide.
    expect((await resolver(s.id, { outcome: 'GRANTED', resolution: 'Corregido' }, recepcion)).statusCode).toBe(403);
    // La constancia queda también en su portal.
    const [constancia] = await avisos(id);
    expect(constancia?.kind).toBe('PRIVACY_REQUEST_RECEIVED');
    expect(constancia?.body).toContain(s.folio);
    const asiento = await getDb().auditLog.findFirstOrThrow({ where: { action: 'privacy.request.open', resourceId: s.id } });
    expect(asiento.afterState).toMatchObject({ folio: s.folio, kind: 'RECTIFICATION', channel: 'FRONT_DESK', identityVerified: true });
  });

  it('21-18 · por correo nace «falta acreditar identidad»: el plazo no corre ni se puede responder', async () => {
    const id = await socio();
    const r = await registrar(id, { kind: 'ACCESS', channel: 'EMAIL', note: 'Escribió pidiendo sus datos' });
    expect(r.statusCode, r.body).toBe(201);
    const s = r.json() as Solicitud;
    expect(s.status).toBe('IDENTITY_PENDING');
    expect(s.deadlineAt).toBeNull();
    expect(s.overdue).toBe(false);
    expect((await resolver(s.id, { outcome: 'GRANTED', resolution: 'Se le entregan' })).statusCode).toBe(409);

    // Aunque pase un año, lo que no corre no vence.
    await getDb().$executeRaw`UPDATE "privacy_requests" SET "dueAt" = now() - interval '1 day' WHERE "id" = ${s.id}::uuid`;
    const lista = (await app.inject({ method: 'GET', url: `/members/${id}/privacy-requests`, headers: { cookie: gerencia } })).json();
    expect(diferenciasConElContrato(MemberPrivacyRequests, lista)).toEqual([]);
    expect(lista.requests[0].overdue).toBe(false);

    const ok = await app.inject({ method: 'POST', url: `/privacy/requests/${s.id}/identity`, headers: { cookie: recepcion }, payload: { note: 'Vino con su INE' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().status).toBe('OPEN');
    // El plazo cuenta desde que se acreditó, no desde que escribió.
    expect(new Date(ok.json().dueAt).getTime() - Date.now()).toBeGreaterThan(27 * DIA);
    expect((await app.inject({ method: 'POST', url: `/privacy/requests/${s.id}/identity`, headers: { cookie: recepcion }, payload: { note: 'Otra vez' } })).statusCode).toBe(409);
    expect(await getDb().auditLog.count({ where: { action: 'privacy.request.identity', resourceId: s.id } })).toBe(1);
  });

  it('21-02 y 21-03 · «no procede» exige el motivo y el socio recibe la respuesta', async () => {
    const id = await socio();
    const s = (await registrar(id, { kind: 'CANCELLATION', identityVerified: true })).json() as Solicitud;
    expect((await resolver(s.id, { resolution: 'Sin decir si procede' })).statusCode).toBe(422);
    expect((await resolver(s.id, { outcome: 'DENIED' })).statusCode).toBe(422);
    const r = await resolver(s.id, { outcome: 'DENIED', resolution: 'Tiene un adeudo y la ley obliga a conservar lo contable' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: 'CLOSED', outcome: 'DENIED', effectiveDueAt: null, deadlineAt: null });
    expect((await resolver(s.id, { outcome: 'GRANTED', resolution: 'Ahora sí' })).statusCode).toBe(409);

    const respuesta = (await avisos(id)).find((a) => a.kind === 'PRIVACY_REQUEST_RESOLVED');
    expect(respuesta?.title).toBe('Tu solicitud no procede');
    expect(respuesta?.body).toContain('ley obliga a conservar');
    const asiento = await getDb().auditLog.findFirstOrThrow({ where: { action: 'privacy.request.resolve', resourceId: s.id } });
    expect(asiento.afterState).toMatchObject({ outcome: 'DENIED', onTime: true, effected: false });
  });

  it('21-03 · oposición que procede: el permiso se retira en el mismo acto y queda hecha', async () => {
    const id = await socio();
    await firmar(id, 'MARKETING');
    expect((await registrar(id, { kind: 'REVOCATION', identityVerified: true })).statusCode).toBe(422);
    expect((await registrar(id, { kind: 'REVOCATION', identityVerified: true, consentType: 'PRIVACY_NOTICE' })).statusCode).toBe(422);
    const s = (await registrar(id, { kind: 'OPPOSITION', identityVerified: true, consentType: 'MARKETING', note: 'Ya no quiere promociones' })).json() as Solicitud;
    const r = await resolver(s.id, { outcome: 'GRANTED', resolution: 'Se deja de enviarle promociones' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: 'CLOSED', outcome: 'GRANTED' });
    expect(r.json().effectedAt).toBeTruthy();
    const firmas = (await app.inject({ method: 'GET', url: `/members/${id}/consents`, headers: { cookie: gerencia } })).json() as Array<{ consentType: string; revokedAt: string | null }>;
    expect(firmas.find((c) => c.consentType === 'MARKETING')?.revokedAt).toBeTruthy();
    const retiro = await getDb().auditLog.findFirstOrThrow({ where: { action: 'consent.revoke', afterState: { path: ['privacyRequestId'], equals: s.id } } });
    expect(retiro.afterState).toMatchObject({ consentType: 'MARKETING', via: 'arco' });
  });

  it('21-18 · rectificación que procede: corre el segundo plazo hasta «ya quedó hecho»', async () => {
    const id = await socio();
    const s = (await registrar(id, { kind: 'RECTIFICATION', identityVerified: true, note: 'Cambió de correo' })).json() as Solicitud;
    expect((await app.inject({ method: 'POST', url: `/privacy/requests/${s.id}/effect`, headers: { cookie: gerencia }, payload: { note: 'Antes de responder' } })).statusCode).toBe(409);
    const r = (await resolver(s.id, { outcome: 'GRANTED', resolution: 'Se corrige su correo' })).json() as Solicitud;
    expect(r.status).toBe('EFFECT_PENDING');
    // 15 días hábiles guardados como 21 naturales.
    const plazo = new Date(r.effectiveDueAt!).getTime() - Date.now();
    expect(plazo).toBeGreaterThan(20 * DIA);
    expect(plazo).toBeLessThan(22 * DIA);
    expect(r.deadlineAt).toBe(r.effectiveDueAt);

    // Sigue viva en la bandeja y, si se pasa el segundo plazo, sale vencida.
    await getDb().$executeRaw`UPDATE "privacy_requests" SET "effectiveDueAt" = now() - interval '1 day' WHERE "id" = ${s.id}::uuid`;
    const bandeja = (await app.inject({ method: 'GET', url: '/privacy/requests', headers: { cookie: gerencia } })).json();
    expect(diferenciasConElContrato(PrivacyInbox, bandeja)).toEqual([]);
    expect(bandeja.requests.find((x: Solicitud) => x.id === s.id)).toMatchObject({ status: 'EFFECT_PENDING', overdue: true });
    // Lo vencido va primero.
    expect(bandeja.requests[0].overdue).toBe(true);

    expect((await app.inject({ method: 'POST', url: `/privacy/requests/${s.id}/effect`, headers: { cookie: recepcion }, payload: { note: 'Ya quedó' } })).statusCode).toBe(403);
    const hecha = await app.inject({ method: 'POST', url: `/privacy/requests/${s.id}/effect`, headers: { cookie: gerencia }, payload: { note: 'Correo corregido en su ficha' } });
    expect(hecha.statusCode, hecha.body).toBe(200);
    expect(hecha.json()).toMatchObject({ status: 'CLOSED', effectNote: 'Correo corregido en su ficha', overdue: false });
    expect((await app.inject({ method: 'POST', url: `/privacy/requests/${s.id}/effect`, headers: { cookie: gerencia }, payload: { note: 'Otra vez' } })).statusCode).toBe(409);
    const asiento = await getDb().auditLog.findFirstOrThrow({ where: { action: 'privacy.request.effect', resourceId: s.id } });
    expect(asiento.afterState).toMatchObject({ kind: 'RECTIFICATION', onTime: false });
    expect((await avisos(id)).map((a) => a.kind)).toEqual(['PRIVACY_REQUEST_RECEIVED', 'PRIVACY_REQUEST_RESOLVED', 'PRIVACY_REQUEST_DONE']);
  });

  it('21-03 · un acceso que procede se cierra al descargar sus datos; la constancia dice folio y plazos', async () => {
    const id = await socio();
    const s = (await registrar(id, { kind: 'ACCESS', identityVerified: true })).json() as Solicitud;
    await resolver(s.id, { outcome: 'GRANTED', resolution: 'Se le entrega una copia' });
    const constancia = await app.inject({ method: 'GET', url: `/privacy/requests/${s.id}/receipt`, headers: { cookie: recepcion } });
    expect(constancia.statusCode, constancia.body).toBe(200);
    expect(diferenciasConElContrato(PrivacyRequestReceipt, constancia.json())).toEqual([]);
    expect(constancia.json()).toMatchObject({ folio: s.folio, deadlines: { answerBusinessDays: 20, effectBusinessDays: 15 } });

    const descarga = await app.inject({ method: 'GET', url: `/members/${id}/export?reason=${encodeURIComponent('Solicitud ARCO de acceso')}&requestId=${s.id}`, headers: { cookie: gerencia } });
    expect(descarga.statusCode, descarga.body).toBe(200);
    // El canal de la firma en palabras (antes mostraba la clave SELF_SERVICE).
    expect(descarga.json().consentimientos[0].como).toBe('Firmado en recepción');
    const tras = (await app.inject({ method: 'GET', url: `/members/${id}/privacy-requests`, headers: { cookie: gerencia } })).json().requests[0] as Solicitud;
    expect(tras).toMatchObject({ status: 'CLOSED' });
    expect(tras.effectNote).toContain('descargaron');
  });

  it('21-03 · una cancelación que procede solo se cierra con el socio anonimizado, y se cierra sola', async () => {
    const id = await socio();
    const s = (await registrar(id, { kind: 'CANCELLATION', identityVerified: true })).json() as Solicitud;
    expect((await resolver(s.id, { outcome: 'GRANTED', resolution: 'Se dan de baja y se anonimizan sus datos' })).json().status).toBe('EFFECT_PENDING');
    const antes = await app.inject({ method: 'POST', url: `/privacy/requests/${s.id}/effect`, headers: { cookie: gerencia }, payload: { note: 'Ya lo borré' } });
    expect(antes.statusCode).toBe(409);
    expect(antes.json().message).toContain('anonimízalo');

    await app.inject({ method: 'POST', url: `/members/${id}/archive`, headers: { cookie: gerencia }, payload: { reason: 'Pidió la cancelación de sus datos' } });
    const token = await aprobacion(app, gerencia, 'members:anonymize', 'owner@demo.mx', undefined, { resourceId: id });
    const anon = await app.inject({ method: 'POST', url: `/members/${id}/anonymize`, headers: { cookie: gerencia }, payload: { reason: `Solicitud ARCO ${s.folio}`, approvalToken: token } });
    expect(anon.statusCode, anon.body).toBe(204);
    const tras = (await app.inject({ method: 'GET', url: `/members/${id}/privacy-requests`, headers: { cookie: gerencia } })).json().requests[0] as Solicitud;
    expect(tras.status).toBe('CLOSED');
    expect(tras.effectedAt).toBeTruthy();
  });

  it('21-01 · las cifras de la bandeja, sin nombres: las ve la gerencia y la dueña; la bandeja con nombres, solo la gerencia', async () => {
    const r = await app.inject({ method: 'GET', url: '/privacy/requests/summary', headers: { cookie: gerencia } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(PrivacyRequestsSummary, r.json())).toEqual([]);
    const cifras = r.json() as { open: number; identityPending: number; toAnswer: number; toEffect: number };
    expect(cifras.open).toBe(cifras.identityPending + cifras.toAnswer + cifras.toEffect);
    expect(cifras.toAnswer).toBeGreaterThan(0);

    const dueña = await app.inject({ method: 'GET', url: '/privacy/requests/summary', headers: { cookie: owner } });
    expect(dueña.statusCode, dueña.body).toBe(200);
    expect(dueña.json().open).toBe(cifras.open);
    expect((await app.inject({ method: 'GET', url: '/privacy/requests', headers: { cookie: owner } })).statusCode).toBe(403);
    // Recepción es de una sede: no ve las cifras de todo el gimnasio.
    expect((await app.inject({ method: 'GET', url: '/privacy/requests/summary', headers: { cookie: recepcion } })).statusCode).toBe(403);
  });

  it('21-02 · el socio pide desde su teléfono y ve qué pasó con lo que pidió', async () => {
    const id = await socio();
    const portal = await portalDe(id);
    const pedido = await app.inject({ method: 'POST', url: '/portal/privacy-requests', headers: { cookie: portal }, payload: { kind: 'ACCESS', note: 'Quiero una copia con mis notas de salud' } });
    expect(pedido.statusCode, pedido.body).toBe(201);
    // Su sesión acredita quién es: el plazo corre desde ya.
    expect(pedido.json()).toMatchObject({ status: 'OPEN', channel: 'PORTAL', identityNote: 'Sesión de su portal' });
    expect((await app.inject({ method: 'POST', url: '/portal/privacy-requests', headers: { cookie: portal }, payload: { kind: 'REVOCATION', note: 'Retirar' } })).statusCode).toBe(422);
    // El personal no registra «desde su teléfono».
    expect((await registrar(id, { kind: 'ACCESS', channel: 'PORTAL', identityVerified: true })).statusCode).toBe(422);

    await resolver(pedido.json().id, { outcome: 'DENIED', resolution: 'Tus notas de salud se entregan en recepción con tu INE' });
    const mias = await app.inject({ method: 'GET', url: '/portal/privacy-requests', headers: { cookie: portal } });
    expect(mias.statusCode, mias.body).toBe(200);
    expect(diferenciasConElContrato(MemberPrivacyRequests, mias.json())).toEqual([]);
    expect(mias.json().requests[0]).toMatchObject({ status: 'CLOSED', outcome: 'DENIED', resolution: 'Tus notas de salud se entregan en recepción con tu INE' });
    const campana = (await app.inject({ method: 'GET', url: '/portal/notices', headers: { cookie: portal } })).json().notices as Array<{ kind: string }>;
    expect(campana.map((n) => n.kind)).toEqual(expect.arrayContaining(['PRIVACY_REQUEST_RECEIVED', 'PRIVACY_REQUEST_RESOLVED']));
    expect(diferenciasConElContrato(PortalConsents, (await app.inject({ method: 'GET', url: '/portal/consents', headers: { cookie: portal } })).json())).toEqual([]);
  });

  // ── Firmar y retirar: un solo servicio ────────────────────────────────────

  it('21-06 · se firma la versión vigente con el texto del servidor; una versión que ya no es la vigente, 409', async () => {
    const id = await socio();
    const vigente = (await new ConsentDocumentRepository(orgId).findPublished('MARKETING'))!;
    const viejo = await app.inject({ method: 'POST', url: `/members/${id}/consents`, headers: { cookie: gerencia }, payload: { consentType: 'MARKETING', documentVersion: 'la-que-leyo-ayer', granted: true } });
    expect(viejo.statusCode, viejo.body).toBe(409);
    const cid = await firmar(id, 'MARKETING');
    const firmas = await app.inject({ method: 'GET', url: `/members/${id}/consents`, headers: { cookie: gerencia } });
    expect(diferenciasConElContrato(MemberConsents, firmas.json())).toEqual([]);
    expect(firmas.json().find((c: { id: string }) => c.id === cid)).toMatchObject({ documentVersion: vigente.version, hasText: true, channel: 'ASSISTED' });
    // «Leer lo que firmó»: el texto exacto.
    const texto = await app.inject({ method: 'GET', url: `/members/${id}/consents/${cid}`, headers: { cookie: recepcion } });
    expect(texto.statusCode, texto.body).toBe(200);
    expect(texto.json().documentText).toBe(vigente.bodyText);
  });

  it('21-06 · sin texto publicado no se firma, y una versión retirada no se firma en un alta', async () => {
    // El otro gimnasio sembrado no tiene texto de cargo recurrente: ahí no se firma.
    const otro = (await orgFixtures()).other;
    expect(await new ConsentDocumentRepository(otro.id).findPublished('RECURRING_CHARGE')).toBeNull();
    await expect(firmarConsentimiento(systemContext(otro.id), { memberId: (await socio()), consentType: 'RECURRING_CHARGE', channel: 'SELF_SERVICE' })).rejects.toMatchObject({ code: 'CONFLICT' });
    // Una versión retirada: publicar otra de MARKETING la retira; firmarla en un alta ya no pasa.
    const repo = new ConsentDocumentRepository(orgId);
    const retirada = (await repo.findPublished('MARKETING'))!;
    const nueva = await repo.create({ consentType: 'MARKETING', version: `m${Date.now()}`, title: 'Promociones', bodyText: 'Texto nuevo de promociones para la prueba de versiones.' });
    await repo.publish(nueva.id, null);
    const alta = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Vieja'), lastName: nombreUnico('Version'), phoneE164: telefonoUnico(), homeBranchId: cen, force: true, consents: [...CONSENTIMIENTOS, { consentType: 'MARKETING', documentVersion: retirada.version, granted: true }] },
    });
    expect(alta.statusCode, alta.body).toBe(422);
    expect(alta.json().message).toContain('ya se retiró');
    // Salvo que se haya firmado mientras estaba vigente (el alta digital que se aprueba tarde).
    await expect(repo.textoParaFirmar('MARKETING', retirada.version, new Date(Date.now() - 5_000))).resolves.toBe(retirada.bodyText);
    await expect(repo.textoParaFirmar('MARKETING', retirada.version, new Date())).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('21-05 · el mandato se firma con el texto vigente más lo que agrega el servidor (plan, importe y tarjeta)', async () => {
    const id = await socio();
    const vigente = (await new ConsentDocumentRepository(orgId).findPublished('RECURRING_CHARGE'))!;
    const { textoDelMandato } = await import('@gymflow/core');
    const firma = await firmarConsentimiento(systemContext(orgId), {
      memberId: id, consentType: 'RECURRING_CHARGE', channel: 'SELF_SERVICE', ip: '10.0.0.7', userAgent: 'prueba',
      componer: (t) => textoDelMandato(t, { plan: 'Mensual', importe: '$650.00', tarjeta: 'VISA terminación 4242', firmadoEl: '20 de noviembre de 2026' }),
    });
    const fila = await getDb().memberConsent.findUniqueOrThrow({ where: { id: firma.id } });
    expect(fila.documentVersion).toBe(vigente.version);
    expect(fila.documentText).toContain(vigente.bodyText.trimEnd());
    expect(fila.documentText).toContain('Importe de cada cargo: $650.00');
    expect(fila.documentText).toContain('VISA terminación 4242');
    expect(fila.channel).toBe('SELF_SERVICE');
    expect(fila.assistedByUserId).toBeNull();
    expect(await getDb().auditLog.count({ where: { action: 'consent.record', resourceId: firma.id } })).toBe(1);
  });

  it('21-11 · retirar el cargo recurrente desde la ficha apaga las tarjetas, igual que desde el portal', async () => {
    expect(efectosDeRetiroInscritos()).toEqual(['BIOMETRIC', 'RECURRING_CHARGE']);
    const tarjeta = async (memberId: string, consentId: string) => (await new PaymentMethodRepository(orgId).add({
      memberId, provider: 'simulado', providerTokenRef: `tok_${randomUUID()}`, providerCustomerId: null, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2031, consentId, makeDefault: true,
    })).id;

    const enFicha = await socio();
    const firma = await firmar(enFicha, 'RECURRING_CHARGE');
    const t1 = await tarjeta(enFicha, firma);
    const r = await app.inject({ method: 'POST', url: `/members/${enFicha}/consents/${firma}/revoke`, headers: { cookie: gerencia }, payload: { reason: 'Lo pidió el socio' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ consentType: 'RECURRING_CHARGE', effects: { cardsRevoked: 1 } });
    expect((await getDb().paymentMethod.findUniqueOrThrow({ where: { id: t1 } })).status).toBe('REVOKED');

    const enPortal = await socio();
    const t2 = await tarjeta(enPortal, await firmar(enPortal, 'RECURRING_CHARGE'));
    const portal = await portalDe(enPortal);
    expect((await app.inject({ method: 'POST', url: '/portal/consents/RECURRING_CHARGE/revoke', headers: { cookie: portal }, payload: {} })).statusCode).toBe(200);
    expect((await getDb().paymentMethod.findUniqueOrThrow({ where: { id: t2 } })).status).toBe('REVOKED');
    expect((await app.inject({ method: 'POST', url: '/portal/consents/RECURRING_CHARGE/revoke', headers: { cookie: portal }, payload: {} })).statusCode).toBe(409);
    // Los dos caminos dejan el mismo asiento, con su vía.
    const vias = (await getDb().auditLog.findMany({ where: { action: 'consent.revoke', afterState: { path: ['consentType'], equals: 'RECURRING_CHARGE' } }, orderBy: { at: 'desc' }, take: 2 }))
      .map((a) => (a.afterState as { via: string }).via).sort();
    expect(vias).toEqual(['ficha', 'portal']);
  });

  it('lo obligatorio no se retira por separado; salud borra la nota', async () => {
    const id = await socio();
    const firmas = (await app.inject({ method: 'GET', url: `/members/${id}/consents`, headers: { cookie: gerencia } })).json() as Array<{ id: string; consentType: string }>;
    const aviso = firmas.find((c) => c.consentType === 'PRIVACY_NOTICE')!;
    const no = await app.inject({ method: 'POST', url: `/members/${id}/consents/${aviso.id}/revoke`, headers: { cookie: gerencia }, payload: { reason: 'Lo pidió' } });
    expect(no.statusCode, no.body).toBe(422);
    expect(no.json().message).toContain('solo se retira con la baja');

    const salud = await firmar(id, 'HEALTH_DATA');
    const { MemberRepository } = await import('../src/modules/members/index.js');
    await new MemberRepository(orgId).update(id, { healthNotes: 'Lesión de rodilla' });
    expect((await app.inject({ method: 'POST', url: `/members/${id}/consents/${salud}/revoke`, headers: { cookie: gerencia }, payload: { reason: 'Lo pidió el socio' } })).statusCode).toBe(200);
    expect((await getDb().member.findUniqueOrThrow({ where: { id } })).healthNotes).toBeNull();
  });

  it('21-10 · biometría y su permiso van juntos, en los dos sentidos', async () => {
    const enrolar = async (memberId: string) => {
      const r = await app.inject({
        method: 'POST', url: `/members/${memberId}/biometric-enrollments`, headers: { cookie: gerencia },
        payload: { modality: 'FACE', branchId: cen, templateRef: `tpl_${randomUUID()}`, algorithmVendor: 'insightface/buffalo_sc', algorithmVersion: '1', reason: 'Alta del rostro en recepción' },
      });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().id as string;
    };
    const biometrico = async (memberId: string) => (await new ConsentRepository(orgId).listForMember(memberId)).filter((c) => c.consentType === 'BIOMETRIC');

    // Retirar el permiso revoca el rostro.
    const uno = await socio();
    const e1 = await enrolar(uno);
    const [firma] = await biometrico(uno);
    const r = await app.inject({ method: 'POST', url: `/members/${uno}/consents/${firma!.id}/revoke`, headers: { cookie: gerencia }, payload: { reason: 'Ya no quiere entrar con su rostro' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().effects).toMatchObject({ enrollmentsRevoked: 1 });
    expect((await getDb().biometricEnrollment.findUniqueOrThrow({ where: { id: e1 } })).revokedAt).toBeTruthy();

    // Quitar el rostro retira el permiso: lo hace la función que acceso llama al revocar…
    const dos = await socio();
    const e2 = await enrolar(dos);
    expect(await retirarBiometricoSinRegistro(systemContext(orgId), dos, 'Aún tiene rostro')).toBe(0);
    expect((await app.inject({ method: 'POST', url: `/biometric-enrollments/${e2}/revoke`, headers: { cookie: gerencia }, payload: { reason: 'Cambió de opinión' } })).statusCode).toBeLessThan(300);
    // …y, por si quedó alguno de antes, el job nocturno de privacidad.
    const job = PRIVACY_JOBS.find((j) => j.name === 'privacy.retention')!;
    const corrida = await job.handler(orgId);
    expect(corrida.errors).toEqual([]);
    expect((await biometrico(dos)).every((c) => c.revokedAt)).toBe(true);
    const asiento = await getDb().auditLog.findFirst({ where: { action: 'consent.revoke', afterState: { path: ['via'], equals: 'biometria' } }, orderBy: { at: 'desc' } });
    expect(asiento?.afterState).toMatchObject({ consentType: 'BIOMETRIC' });
    // Idempotente: otra pasada no retira nada más.
    expect(await retirarBiometricoSinRegistro(systemContext(orgId), dos, 'Otra vez')).toBe(0);
  });

  // ── Textos: revisar y publicar ────────────────────────────────────────────

  describe('textos de consentimiento (en un gimnasio propio, para no retirar los del entorno)', () => {
    let otra: string;
    let otroId: string;
    const crear = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/consent-documents', headers: { cookie: otra }, payload });
    const publicar = (id: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/consent-documents/${id}/publish`, headers: { cookie: otra }, payload });
    const TODOS = LISTA_DEL_AVISO_DE_PRIVACIDAD.map((p) => p.clave);

    beforeAll(async () => {
      // Un gimnasio recién dado de alta, sin ningún texto: como el que arranca.
      const plataforma = await loginPlataforma(app);
      const sufijo = nombreUnico('Txt');
      const r = await app.inject({ method: 'POST', url: '/platform/organizations', headers: { cookie: plataforma }, payload: {
        legalName: `Textos ${sufijo} S.A.`, tradeName: `Textos ${sufijo}`, template: 'barrio', branch: { code: sufijo.slice(-3).toUpperCase(), name: 'Matriz' },
        owner: { fullName: 'Dora Duena Textos', email: `${sufijo.toLowerCase()}@prueba.mx` }, staff: [], reason: 'Prueba de textos de consentimiento',
      } });
      expect(r.statusCode, r.body).toBe(201);
      otroId = r.json().organizationId;
      await app.inject({ method: 'POST', url: `/platform/organizations/${otroId}/service`, headers: { cookie: plataforma }, payload: { status: 'ACTIVE', reason: 'Prueba' } });
      // Una gerente con la sección Textos de consentimiento liberada (la llave la da el dueño).
      const correo = await cuentaDePrueba(otroId, 'MANAGER', [null]);
      await getDb().user.updateMany({ where: { organizationId: otroId, email: correo }, data: { unlockedSections: ['consentimientos'] } });
      otra = await loginAs(app, correo);
    });

    it('21-08 · el aviso de privacidad no se publica sin lo mínimo ni sin revisarlo punto por punto', async () => {
      const version = `a${Date.now()}`;
      const corto = await crear({ consentType: 'PRIVACY_NOTICE', version, title: 'Aviso', bodyText: 'Aviso de privacidad de cuatro líneas que no dice casi nada.' });
      expect(corto.statusCode, corto.body).toBe(201);
      const id = corto.json().id as string;

      const revision = await app.inject({ method: 'GET', url: `/consent-documents/${id}/review`, headers: { cookie: otra } });
      expect(revision.statusCode, revision.body).toBe(200);
      expect(diferenciasConElContrato(ConsentDocumentReview, revision.json())).toEqual([]);
      expect(revision.json().publishable).toBe(false);
      expect(revision.json().checklist).toHaveLength(7);
      expect(revision.json().checklist.every((c: { found: boolean }) => !c.found)).toBe(true);
      const sinContenido = await publicar(id, { reason: 'Primer aviso', checklist: TODOS });
      expect(sinContenido.statusCode, sinContenido.body).toBe(422);
      expect(sinContenido.json().message).toContain('le falta');

      // 21-07 · el borrador se corrige (antes había que crear otra versión): ahora con el modelo.
      const modelo = modeloDeTexto('PRIVACY_NOTICE', { razonSocial: 'Otro Gimnasio, S.A. de C.V.', nombreComercial: 'Otro Gimnasio', sucursales: ['Matriz'], mesesDeConservacion: 24 })!;
      const conModelo = await app.inject({ method: 'PATCH', url: `/consent-documents/${id}`, headers: { cookie: otra }, payload: { title: modelo.titulo, bodyText: modelo.texto } });
      expect(conModelo.statusCode, conModelo.body).toBe(200);
      const conCorchetes = await publicar(id, { reason: 'Primer aviso', checklist: TODOS });
      expect(conCorchetes.statusCode).toBe(422);
      expect(conCorchetes.json().message).toContain('[DOMICILIO COMPLETO]');

      const completo = modelo.texto.replace(/\[DOMICILIO COMPLETO\]/g, 'Av. Juárez 100, Centro, 06000, Ciudad de México').replace(/\[CORREO DE PRIVACIDAD\]/g, 'privacidad@otro.mx')
        .replace(/\[AGREGA AQUÍ[^\]]*\]/g, '').replace(/\[FECHA\]/g, '20 de noviembre de 2026');
      expect((await app.inject({ method: 'PATCH', url: `/consent-documents/${id}`, headers: { cookie: otra }, payload: { bodyText: completo } })).statusCode).toBe(200);
      const lista = (await app.inject({ method: 'GET', url: `/consent-documents/${id}/review`, headers: { cookie: otra } })).json();
      expect(lista).toMatchObject({ publishable: true, placeholders: [] });

      // Con el texto completo, falta que la gerencia marque cada punto.
      expect((await publicar(id, { reason: 'Primer aviso' })).statusCode).toBe(422);
      const aMedias = await publicar(id, { reason: 'Primer aviso', checklist: TODOS.slice(0, 6) });
      expect(aMedias.statusCode).toBe(422);
      expect(aMedias.json().message).toContain('falta 1');
      const ok = await publicar(id, { reason: 'Primer aviso', checklist: TODOS });
      expect(ok.statusCode, ok.body).toBe(200);
      // D-25 (fase 3, 3.7): el aviso NO queda publicado al pedirlo la gerencia: espera la firma de la dueña
      // (el flujo completo, con su contraseña, está en `direccion-fase3.test.ts`). Aquí firma ella por el servicio.
      expect(ok.json()).toMatchObject({ status: 'DRAFT', awaitingSignature: true });
      {
        const { firmarAviso } = await import('../src/modules/members/aviso-firma.js');
        const duena = await getDb().user.findFirstOrThrow({ where: { organizationId: otroId, roleAssignments: { some: { role: { key: 'OWNER' } } } }, select: { id: true } });
        await firmarAviso({ ...systemContext(otroId), tenant: { ...systemContext(otroId).tenant, actorUserId: duena.id } }, id);
      }
      const asiento = await getDb().auditLog.findFirstOrThrow({ where: { action: 'consent.document.publish', resourceId: id } });
      expect((asiento.afterState as { checklist: string[] }).checklist).toEqual(TODOS);

      // 21-07 · solo se publica un borrador, y lo publicado ni se corrige ni se borra.
      expect((await publicar(id, { reason: 'Otra vez', checklist: TODOS })).statusCode).toBe(409);
      expect((await app.inject({ method: 'PATCH', url: `/consent-documents/${id}`, headers: { cookie: otra }, payload: { title: 'Cambiado' } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'DELETE', url: `/consent-documents/${id}`, headers: { cookie: otra } })).statusCode).toBe(409);
      // El aviso se firma en toda alta: no se retira sin reemplazo.
      expect((await app.inject({ method: 'POST', url: `/consent-documents/${id}/retire`, headers: { cookie: otra }, payload: { reason: 'Ya no' } })).statusCode).toBe(422);
    });

    it('21-07 · borradores que se borran, historial con sus firmas y retirar un opcional sin reemplazo', async () => {
      const borrador = await crear({ consentType: 'HEALTH_DATA', version: `h${Date.now()}`, title: 'Salud', bodyText: 'Texto de datos de salud con un [DATO SIN COMPLETAR] del modelo.' });
      const id = borrador.json().id as string;
      // Un corchete sin completar detiene cualquier texto, no solo el aviso.
      expect((await publicar(id, { reason: 'Con corchete' })).statusCode).toBe(422);
      expect((await app.inject({ method: 'DELETE', url: `/consent-documents/${id}`, headers: { cookie: otra } })).statusCode).toBe(204);
      expect((await app.inject({ method: 'GET', url: `/consent-documents/${id}`, headers: { cookie: otra } })).statusCode).toBe(404);
      expect(await getDb().auditLog.count({ where: { action: 'consent.document.delete', resourceId: id } })).toBe(1);

      const opcional = (await crear({ consentType: 'HEALTH_DATA', version: `i${Date.now()}`, title: 'Salud', bodyText: 'Texto de datos de salud completo para publicar y retirar.' })).json().id as string;
      expect((await publicar(opcional, { reason: 'Se empieza a pedir la nota de salud' })).statusCode).toBe(200);
      const retirar = await app.inject({ method: 'POST', url: `/consent-documents/${opcional}/retire`, headers: { cookie: otra }, payload: { reason: 'Ya no se pide la nota de salud' } });
      expect(retirar.statusCode, retirar.body).toBe(200);
      expect(retirar.json().ok).toBe(true);

      const lista = await app.inject({ method: 'GET', url: '/consent-documents', headers: { cookie: otra } });
      expect(diferenciasConElContrato(ConsentDocumentList, lista.json())).toEqual([]);
      const fila = lista.json().documents.find((d: { id: string }) => d.id === opcional);
      expect(fila).toMatchObject({ status: 'RETIRED', signatures: 0 });
      expect(fila.retiredAt).toBeTruthy();
      // La base también cuida lo retirado y lo publicado: ni se reescribe ni se borra por la puerta de atrás.
      await expect(getDb().consentDocument.update({ where: { id: opcional }, data: { bodyText: 'Reescrito' } })).rejects.toThrow(/RETIRADO|inmutable/i);
      await expect(getDb().consentDocument.delete({ where: { id: opcional } })).rejects.toThrow(/BORRADOR|evidencia/i);
    });
  });
});
