import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { MeHome, Pulse, diferenciasConElContrato } from '@gymflow/core/contracts';
import { makeApp, nombreUnico, telefonoUnico, CONSENTIMIENTOS } from './helpers.js';
import { gimnasioPropio, sesionesDe, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { AuditService } from '../src/platform/audit/audit.service.js';
import { systemContext } from '../src/platform/jobs/types.js';
import { BusinessCalendar } from '../src/platform/time/business-calendar.js';
import { ConsentDocumentRepository } from '../src/modules/members/index.js';

/**
 * FASE 3 · BLOQUE 3.12 (auditoría 8): lo que la oleada A dejó sin dueño.
 *
 *  · «Hoy te toca» y la lista de arranque no dicen «falta publicar» cuando el
 *    aviso de privacidad ya se pidió publicar y espera la firma de la dueña.
 *  · Las entradas autorizadas sin rostro (D-06) se resumen en «Para revisar»
 *    por quién autorizó, y la dueña ve la cifra de 7 días en su Inicio.
 *  · Los pases de prueba del mes (D-08) llegan al Inicio de la dueña.
 *
 * Gimnasio propio. Los asientos y los pases se escriben con el día de
 * operación de la sede (no con `CURRENT_DATE` ni con la hora UTC).
 */
describe('fase 3 · pendientes heredados (3.12)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let s: Awaited<ReturnType<typeof sesionesDe>>;
  const db = () => getDb();
  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });

  beforeAll(async () => {
    app = await makeApp(); await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Sede de pendientes', cajas: 1 }] });
    s = await sesionesDe(app, g);
    // El gimnasio propio nace con aviso y reglamento; con Biometría encendida le falta además su texto.
    const textos = new ConsentDocumentRepository(g.organizationId);
    const b = await textos.create({ consentType: 'BIOMETRIC', version: 'v1.0', title: 'Rostro (prueba)', bodyText: 'Texto de prueba BIOMETRIC' });
    await textos.publish(b.id, null);
  });
  const aparte: GimnasioPropio[] = [];
  afterAll(async () => { for (const x of [g, ...aparte]) await x.cerrar(); await app.close(); await closeDb(); });

  it('el aviso de privacidad que espera la firma de la dueña no sale como «falta publicar» (D-25)', async () => {
    // Gimnasio aparte: este caso deja al gimnasio sin aviso publicado y ya no podría dar altas.
    const g = await gimnasioPropio({ sedes: [{ name: 'Sede sin aviso', cajas: 1 }] });
    aparte.push(g);
    const s = await sesionesDe(app, g);
    const biometrico = await new ConsentDocumentRepository(g.organizationId).create({ consentType: 'BIOMETRIC', version: 'v1.0', title: 'Rostro (prueba)', bodyText: 'Texto de prueba BIOMETRIC' });
    await new ConsentDocumentRepository(g.organizationId).publish(biometrico.id, null);
    const org = g.organizationId;
    const textos = () => get(s.gerente, '/me/home').then((r) => {
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(MeHome, r.json())).toEqual([]);
      return (r.json() as MeHome).items.find((i) => i.key === 'texts') ?? null;
    });
    const arranque = async () => {
      const r = await get(s.gerente, '/organization/setup');
      expect(r.statusCode, r.body).toBe(200);
      return (r.json().steps as Array<{ key: string; done: boolean; text: string }>).find((p) => p.key === 'textos')!;
    };
    // Con sus textos publicados no hay asunto.
    expect(await textos()).toBeNull();
    expect((await arranque()).done).toBe(true);

    // El gimnasio se queda sin aviso publicado (como una marca nueva) y con un borrador.
    await db().consentDocument.updateMany({ where: { organizationId: org, consentType: 'PRIVACY_NOTICE', status: 'PUBLISHED' }, data: { status: 'RETIRED' } });
    const borrador = await new ConsentDocumentRepository(org).create({ consentType: 'PRIVACY_NOTICE', version: 'v-pendientes-312', title: 'Aviso nuevo (prueba)', bodyText: 'Texto de prueba del aviso nuevo' });
    expect(await textos()).toMatchObject({ count: 1, detail: ['PRIVACY_NOTICE'], waiting: [] });
    expect((await arranque()).text).toBe('Sin ellos no se puede dar de alta a nadie: el socio firma al inscribirse.');

    // La gerencia pide publicarlo: queda esperando la firma de la dueña.
    const gerente = await db().user.findFirstOrThrow({ where: { organizationId: org, email: g.correos.gerente }, select: { id: true } });
    const solicitud = await db().consentSignatureRequest.create({
      data: { id: uuidv7(), organizationId: org, documentId: borrador.id, status: 'PENDING', reason: 'Aviso nuevo', bodyHash: 'x'.repeat(64), requestedByUserId: gerente.id },
    });
    expect(await textos()).toMatchObject({ count: 1, detail: ['PRIVACY_NOTICE'], waiting: ['PRIVACY_NOTICE'] });
    const paso = await arranque();
    expect(paso.done).toBe(false);
    expect(paso.text).toBe('El Aviso de privacidad ya se pidió publicar y espera la firma de la dueña: no se publica hasta que lo lea y lo firme. Mientras tanto no se puede dar de alta a nadie.');

    // Si la dueña no lo firma, vuelve a ser «falta publicar».
    await db().consentSignatureRequest.update({ where: { id: solicitud.id }, data: { status: 'REJECTED', resolvedAt: new Date() } });
    expect(await textos()).toMatchObject({ detail: ['PRIVACY_NOTICE'], waiting: [] });
  });

  it('las entradas autorizadas sin rostro se resumen por quién autorizó, y los pases de prueba y esa cifra llegan al Inicio de la dueña', async () => {
    const org = g.organizationId;
    const sede = g.sedes[0]!.id;
    const gerente = await db().user.findFirstOrThrow({ where: { organizationId: org, email: g.correos.gerente }, select: { id: true, fullName: true } });
    const recepcion = await db().user.findFirstOrThrow({ where: { organizationId: org, email: g.correos.recepcion }, select: { id: true } });
    const hoy = await new BusinessCalendar(org).today(sede);
    const dia = hoy.toISOString().slice(0, 10);

    const pulso = async () => {
      const r = await get(s.owner, '/reports/pulse?fresh=1');
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(Pulse, r.json())).toEqual([]);
      return r.json() as Pulse;
    };
    const antes = await pulso();
    expect(antes.alerts.entriesWithoutFace7d).toBe(0);
    expect(antes.month.trialPasses).toBe(0);

    // Dos entradas las autorizó la gerencia; una la registró recepción con la firma de la dueña.
    const audit = new AuditService();
    const asentar = (actor: string, autorizo: string, firma: boolean) => audit.record({ ...systemContext(org), tenant: { ...systemContext(org).tenant, actorUserId: actor, actorType: 'USER' } }, {
      action: 'access.entry.authorize_without_face', resourceType: 'access_decision', resourceId: uuidv7(), branchId: sede, reason: 'Olvidó registrar su rostro',
      ...(firma ? { approvedByUserId: autorizo } : {}),
      afterState: { authorizedByUserId: autorizo, registeredByUserId: actor, signature: firma },
    });
    await asentar(gerente.id, gerente.id, false);
    await asentar(gerente.id, gerente.id, false);
    await asentar(recepcion.id, g.ownerId, true);
    // Y una excepción del mostrador, que va en el otro resumen.
    await audit.record({ ...systemContext(org), tenant: { ...systemContext(org).tenant, actorUserId: recepcion.id, actorType: 'USER' } }, {
      action: 'access.manual_entry', resourceType: 'access_decision', resourceId: uuidv7(), branchId: sede, reason: 'Olvidó su credencial', afterState: {},
    });

    const r = await get(s.gerente, `/audit/exceptions?from=${dia}&to=${dia}`);
    expect(r.statusCode, r.body).toBe(200);
    const resumen = r.json() as { summary: Array<{ actorUserId: string; count: number }>; withoutFace: Array<{ date: string; byUserId: string; byName: string | null; branchId: string; count: number }> };
    expect(resumen.withoutFace).toHaveLength(2);
    expect(resumen.withoutFace.find((f) => f.byUserId === gerente.id)).toEqual({ date: dia, byUserId: gerente.id, byName: gerente.fullName, branchId: sede, count: 2 });
    // La que firmó la dueña cuenta para ella, no para quien la registró.
    expect(resumen.withoutFace.find((f) => f.byUserId === g.ownerId)).toMatchObject({ count: 1, date: dia });
    // No gastan el tope de excepciones de nadie: el otro resumen solo trae la del mostrador.
    expect(resumen.summary).toEqual([expect.objectContaining({ actorUserId: recepcion.id, count: 1 })]);
    // El filtro de persona también vale para quien autorizó.
    const deLaDuena = await get(s.gerente, `/audit/exceptions?from=${dia}&to=${dia}&actorUserId=${g.ownerId}`);
    expect((deLaDuena.json() as typeof resumen).withoutFace).toEqual([expect.objectContaining({ byUserId: g.ownerId, count: 1 })]);
    // Una por una no entran a «Para revisar».
    const paraRevisar = await get(s.gerente, `/audit?category=sensibles&from=${dia}&to=${dia}&limit=200`);
    expect(paraRevisar.statusCode, paraRevisar.body).toBe(200);
    expect((paraRevisar.json().entries as Array<{ action: string }>).filter((e) => e.action.startsWith('access.'))).toEqual([]);

    // Un pase de prueba de hoy (el día de la sede), dado a un socio nuevo.
    const alta = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: s.gerente },
      payload: { firstName: nombreUnico('Pen'), lastName: nombreUnico('Diente'), phoneE164: telefonoUnico(), homeBranchId: sede, consents: CONSENTIMIENTOS },
    });
    expect(alta.statusCode, alta.body).toBe(201);
    await db().trialPass.create({ data: { id: uuidv7(), organizationId: org, branchId: sede, memberId: alta.json().id as string, phoneKey: uuidv7(), phoneLast4: '0000', validOn: hoy, grantedByUserId: gerente.id } });

    const despues = await pulso();
    expect(despues.alerts.entriesWithoutFace7d).toBe(3);
    expect(despues.month.trialPasses).toBe(1);
  });
});
