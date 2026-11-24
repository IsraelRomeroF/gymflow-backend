import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, CONSENTIMIENTOS, asignarAlCoach } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { ConsentDocumentRepository } from '../src/modules/members/index.js';
import { etiqueta } from '../src/modules/privacy/etiquetas.js';

/**
 * TEXTOS VERDADEROS (auditoría 8, fase 0, bloque 0.5).
 *
 * - El texto biométrico viejo decía que la plantilla vivía «solo en el equipo
 *   de la sucursal» (6-03, 21-09). El corregido se publica como versión nueva
 *   y quien firmó el anterior queda «debe volver a firmar»: lo ve la ficha, la
 *   pantalla Biometría y el portal, y recepción le toma la firma nueva. No
 *   bloquea la entrada (eso es D-06, fase 3).
 * - La descarga ARCO dice dónde vive cada plantilla: la de la cámara, cifrada
 *   en el servidor del gimnasio; la de un lector, en el equipo de la sucursal.
 * - Quitar una rutina o una reserva acepta un motivo opcional que queda en la
 *   bitácora; el aviso de quitar una reserva tarde sabe que la clase suelta
 *   se sigue debiendo (11-02).
 */
describe('textos verdaderos (0.5)', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let recepcion: string;
  let orgId: string;
  let cen: string;

  async function socio(): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Texto'), lastName: nombreUnico('Verdadero'), phoneE164: telefonoUnico(), homeBranchId: cen, force: true, consents: CONSENTIMIENTOS },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  async function enrolar(memberId: string, templateRef = `tpl_${randomUUID()}`): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`, headers: { cookie: gerencia },
      payload: { modality: 'FACE', branchId: cen, templateRef, algorithmVendor: 'insightface/buffalo_sc', algorithmVersion: '1', reason: 'Alta del rostro en recepción' },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  /** Publica una versión NUEVA del texto biométrico, como lo haría la gerencia en Textos de consentimiento. */
  async function publicarBiometrico(): Promise<string> {
    const textos = new ConsentDocumentRepository(orgId);
    const version = `prueba-${randomUUID().slice(0, 8)}`;
    const doc = await textos.create({ consentType: 'BIOMETRIC', version, title: 'Consentimiento biométrico de prueba', bodyText: `Texto biométrico de prueba ${version}: plantilla cifrada en el servidor del gimnasio.` });
    await textos.publish(doc.id, null);
    return version;
  }

  type Firma = { id: string; consentType: string; documentVersion: string; revokedAt: string | null; needsResign: boolean; currentVersion: string | null };
  const firmas = async (memberId: string, cookie = gerencia) =>
    (await app.inject({ method: 'GET', url: `/members/${memberId}/consents`, headers: { cookie } })).json() as Firma[];

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    cen = f.demoBranches.find((b) => b.code === 'CEN')!.id;
    // Hace falta un texto biométrico publicado para enrolar.
    if (!await new ConsentDocumentRepository(orgId).findPublished('BIOMETRIC')) await publicarBiometrico();
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('quien firmó el texto biométrico anterior queda «debe volver a firmar»; recepción le toma la firma nueva y la anterior se conserva', async () => {
    const memberId = await socio();
    await enrolar(memberId);
    const antes = (await firmas(memberId)).find((c) => c.consentType === 'BIOMETRIC')!;
    expect(antes.needsResign).toBe(false);
    expect(antes.currentVersion).toBeNull();

    const nueva = await publicarBiometrico();

    const tras = await firmas(memberId);
    const vieja = tras.find((c) => c.id === antes.id)!;
    expect(vieja.needsResign).toBe(true);
    expect(vieja.currentVersion).toBe(nueva);
    // Solo la biométrica: el aviso y el reglamento no se marcan.
    expect(tras.filter((c) => c.needsResign)).toHaveLength(1);

    // La pantalla Biometría lo lista, para la gerencia y para la dueña (que no ve fichas).
    for (const cookie of [gerencia, await loginAs(app, 'owner@demo.mx')]) {
      const lista = await app.inject({ method: 'GET', url: '/members/biometric-renewals', headers: { cookie } });
      expect(lista.statusCode, lista.body).toBe(200);
      expect(lista.json().currentVersion).toBe(nueva);
      const fila = (lista.json().members as Array<{ memberId: string; signedVersion: string; branchIds: string[] }>).find((m) => m.memberId === memberId);
      expect(fila?.signedVersion).toBe(antes.documentVersion);
      expect(fila?.branchIds).toEqual([cen]);
    }

    // El coach no registra rostros: no toma la firma, ni de su propio socio.
    await asignarAlCoach(memberId);
    const coach = await loginAs(app, 'coach@demo.mx');
    expect((await app.inject({ method: 'POST', url: `/members/${memberId}/consents/renew-biometric`, headers: { cookie: coach }, payload: {} })).statusCode).toBe(403);

    // Si lo que leyó no es la versión vigente, no se firma otra en su lugar.
    const otraVersion = await app.inject({ method: 'POST', url: `/members/${memberId}/consents/renew-biometric`, headers: { cookie: recepcion }, payload: { documentVersion: 'inventada' } });
    expect(otraVersion.statusCode).toBe(409);
    expect(otraVersion.json().message).toMatch(/cambió mientras lo leía/);

    // Recepción la toma, contra el texto que pone el servidor.
    const r = await app.inject({ method: 'POST', url: `/members/${memberId}/consents/renew-biometric`, headers: { cookie: recepcion }, payload: { documentVersion: nueva } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ consentType: 'BIOMETRIC', documentVersion: nueva, granted: true, channel: 'ASSISTED', previousVersion: antes.documentVersion });
    const fila = await getDb().memberConsent.findUniqueOrThrow({ where: { id: r.json().id } });
    const vigente = await new ConsentDocumentRepository(orgId).findPublished('BIOMETRIC');
    expect(fila.documentText).toBe(vigente!.bodyText);

    // La anterior NO se retira: es la evidencia de lo que aceptó entonces.
    const despues = await firmas(memberId);
    expect(despues.find((c) => c.id === antes.id)!.revokedAt).toBeNull();
    expect(despues.some((c) => c.needsResign)).toBe(false);

    // Queda en la bitácora, ligada a la firma que renueva.
    const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'consent.record', resourceId: r.json().id } });
    expect(asiento.afterState).toMatchObject({ consentType: 'BIOMETRIC', version: nueva, renews: antes.id, previousVersion: antes.documentVersion });

    // Ya no hay nada que firmar.
    const otra = await app.inject({ method: 'POST', url: `/members/${memberId}/consents/renew-biometric`, headers: { cookie: recepcion }, payload: {} });
    expect(otra.statusCode).toBe(409);
    expect(otra.json().message).toMatch(/nada que volver a firmar/i);
  });

  it('sin rostro vivo no hay nada que volver a firmar, y el dado de baja sale de la lista', async () => {
    const sinRostro = await socio();
    const enrollmentId = await enrolar(sinRostro);
    const conRostro = await socio();
    await enrolar(conRostro);
    await publicarBiometrico();

    const revocado = await app.inject({ method: 'POST', url: `/biometric-enrollments/${enrollmentId}/revoke`, headers: { cookie: gerencia }, payload: { reason: 'El socio retiró su consentimiento' } });
    expect(revocado.statusCode, revocado.body).toBe(200);
    expect((await firmas(sinRostro)).some((c) => c.needsResign)).toBe(false);
    expect((await app.inject({ method: 'POST', url: `/members/${sinRostro}/consents/renew-biometric`, headers: { cookie: recepcion }, payload: {} })).statusCode).toBe(409);

    const lista = async () => ((await app.inject({ method: 'GET', url: '/members/biometric-renewals', headers: { cookie: gerencia } })).json().members as Array<{ memberId: string }>).map((m) => m.memberId);
    expect(await lista()).toContain(conRostro);
    expect(await lista()).not.toContain(sinRostro);
    const baja = await app.inject({ method: 'POST', url: `/members/${conRostro}/archive`, headers: { cookie: gerencia }, payload: { reason: 'Se mudó de ciudad' } });
    expect(baja.statusCode, baja.body).toBe(200);
    expect(await lista()).not.toContain(conRostro);
  });

  it('el portal le dice al socio que su firma biométrica es de un texto anterior', async () => {
    const memberId = await socio();
    await enrolar(memberId);
    const nueva = await publicarBiometrico();
    const invite = await app.inject({ method: 'POST', url: `/members/${memberId}/portal-invite`, headers: { cookie: gerencia } });
    const enroll = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code } });
    const portal = `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}`;
    const lista = (await app.inject({ method: 'GET', url: '/portal/consents', headers: { cookie: portal } })).json().consents as Array<{ consentType: string; needsResign: boolean; currentVersion: string | null; revocable: boolean }>;
    const bio = lista.find((c) => c.consentType === 'BIOMETRIC')!;
    // Fase 3, bloque 3.10 (D-32): el socio ya puede retirar su rostro desde el teléfono; antes era `revocable: false`.
    expect(bio).toMatchObject({ needsResign: true, currentVersion: nueva, revocable: true });
    expect(lista.filter((c) => c.consentType !== 'BIOMETRIC').every((c) => !c.needsResign)).toBe(true);
  });

  it('la descarga ARCO dice dónde vive cada plantilla: la de la cámara, cifrada en el servidor del gimnasio', async () => {
    const memberId = await socio();
    await enrolar(memberId, `servidor:${randomUUID()}`);
    const res = await app.inject({ method: 'GET', url: `/members/${memberId}/export?reason=${encodeURIComponent('Lo pidió en recepción')}`, headers: { cookie: gerencia } });
    expect(res.statusCode, res.body).toBe(200);
    const datos = res.json() as { nota: string; biometria: Array<{ nota: string }> };
    expect(datos.nota).not.toMatch(/nunca salen del equipo/);
    expect(datos.biometria).toHaveLength(1);
    expect(datos.biometria[0]!.nota).toMatch(/cámara de recepción/);
    expect(datos.biometria[0]!.nota).toMatch(/cifrada en el servidor del gimnasio/);
    expect(datos.biometria[0]!.nota).not.toMatch(/solo en el equipo/);

    // La de un lector de sucursal sí vive en ese equipo.
    const otro = await socio();
    await enrolar(otro, `lector-${randomUUID()}`);
    const lector = (await app.inject({ method: 'GET', url: `/members/${otro}/export?reason=${encodeURIComponent('Lo pidió en recepción')}`, headers: { cookie: gerencia } })).json() as { biometria: Array<{ nota: string }> };
    expect(lector.biometria[0]!.nota).toMatch(/lector de esa sucursal/);

    // El pago único con tarjeta no es «domiciliado» (A5-N3); la nota de crédito es saldo a favor.
    expect(etiqueta.metodo('CARD_ON_FILE')).toBe('Tarjeta en línea');
    expect(etiqueta.metodo('CREDIT_NOTE')).toBe('Saldo a favor (nota de crédito)');
  });

  it('quitar una rutina acepta un motivo opcional y queda en la bitácora', async () => {
    const memberId = await socio();
    const catalogo = (await app.inject({ method: 'GET', url: '/exercises', headers: { cookie: gerencia } })).json().exercises as Array<{ id: string; muscleGroup: string; custom: boolean }>;
    const pecho = catalogo.find((e) => e.muscleGroup === 'CHEST' && !e.custom)!;
    const rutina = await app.inject({
      method: 'POST', url: '/routines', headers: { cookie: gerencia },
      payload: { name: `Rutina ${randomUUID().slice(0, 6)}`, goal: 'GENERAL', level: 'PRINCIPIANTE', days: [{ name: 'Día uno', items: [{ exerciseId: pecho.id, sets: 3, reps: '10', restSeconds: 60 }] }] },
    });
    expect(rutina.statusCode, rutina.body).toBe(201);
    const asignar = () => app.inject({ method: 'POST', url: `/members/${memberId}/routine`, headers: { cookie: gerencia }, payload: { routineId: rutina.json().id } });

    expect((await asignar()).statusCode).toBe(201);
    const conMotivo = await app.inject({ method: 'POST', url: `/members/${memberId}/routine/end`, headers: { cookie: gerencia }, payload: { reason: '  Se lesionó la rodilla  ' } });
    expect(conMotivo.statusCode, conMotivo.body).toBe(200);
    const asientos = () => getDb().auditLog.findMany({ where: { organizationId: orgId, action: 'training.routine.end', resourceId: memberId }, orderBy: { at: 'asc' } });
    expect((await asientos()).map((a) => a.reason)).toEqual(['Se lesionó la rodilla']);

    // Sin motivo (y sin cuerpo) sigue funcionando como antes.
    expect((await asignar()).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/members/${memberId}/routine/end`, headers: { cookie: gerencia } })).statusCode).toBe(200);
    expect((await asientos()).map((a) => a.reason)).toEqual(['Se lesionó la rodilla', null]);

    // Un motivo de más de 300 caracteres no entra.
    expect((await asignar()).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/members/${memberId}/routine/end`, headers: { cookie: gerencia }, payload: { reason: 'x'.repeat(301) } })).statusCode).toBe(422);
  });

  it('quitar una reserva queda en la bitácora con su motivo; tarde, el cargo de la clase suelta se queda y la respuesta lo dice', async () => {
    const db = getDb();
    const tipo = await app.inject({ method: 'POST', url: '/classes/types', headers: { cookie: gerencia }, payload: { name: nombreUnico('Funcional'), defaultCapacity: 10, dropInPriceCents: '12000' } });
    expect(tipo.statusCode, tipo.body).toBe(201);
    const clase = async (enHoras: number) => {
      const startsAt = new Date(Date.now() + enHoras * 3_600_000);
      const { uuidv7 } = await import('@gymflow/core');
      return (await db.classSchedule.create({
        data: {
          id: uuidv7(), organizationId: orgId, branchId: cen, classTypeId: tipo.json().id, occurrenceKey: `test:${uuidv7()}`,
          startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), businessDate: new Date(startsAt.toISOString().slice(0, 10)), capacity: 10,
        },
      })).id;
    };
    // Sin membresía, la clase es suelta: lleva cargo.
    // `pagando`: con menos de una hora la clase suelta solo se aparta pagándola (D-16, bloque 3.5).
    const reservar = async (claseId: string, pagando = false) => {
      const r = await app.inject({ method: 'POST', url: `/classes/schedules/${claseId}/bookings`, headers: { cookie: gerencia }, payload: {
        memberId: await socio(), ...(pagando ? { payment: { method: 'SPEI_TRANSFER', externalRef: `CLASE-${Date.now()}` } } : {}),
      } });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().chargeId).toBeTruthy();
      return r.json() as { id: string; chargeId: string };
    };

    // En plazo, con motivo: se anula el cargo y el motivo queda.
    const temprano = await reservar(await clase(48));
    const q1 = await app.inject({ method: 'POST', url: `/classes/bookings/${temprano.id}/cancel`, headers: { cookie: gerencia }, payload: { reason: 'Se equivocó de horario' } });
    expect(q1.statusCode, q1.body).toBe(200);
    expect(q1.json()).toMatchObject({ chargeVoided: true, lateChargeKept: false });
    const a1 = await db.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'class.booking.cancel', resourceId: temprano.id } });
    expect(a1.reason).toBe('Se equivocó de horario');

    // Dentro de las 2 h previas, sin motivo: el cargo (ya pagado al apartar) NO se anula y la respuesta lo dice.
    const tarde = await reservar(await clase(1), true);
    const q2 = await app.inject({ method: 'POST', url: `/classes/bookings/${tarde.id}/cancel`, headers: { cookie: gerencia }, payload: {} });
    expect(q2.statusCode, q2.body).toBe(200);
    expect(q2.json()).toMatchObject({ late: true, chargeVoided: false, lateChargeKept: true });
    expect((await db.charge.findUniqueOrThrow({ where: { id: tarde.chargeId } })).status).not.toBe('VOID');
    const a2 = await db.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'class.booking.cancel', resourceId: tarde.id } });
    expect(a2.reason).toBeNull();
  });
});
