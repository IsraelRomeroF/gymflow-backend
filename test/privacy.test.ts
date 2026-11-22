import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, aprobacion, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { PRIVACY_JOBS, RETENCION } from '../src/modules/privacy/index.js';

/**
 * LFPDPPP (SEC-08): datos sensibles cifrados, lecturas auditadas, derechos
 * ARCO de acceso y cancelación, y retención.
 */
describe('privacidad', () => {
  let app: FastifyInstance;
  let gerente: string;
  let recepcion: string;
  let orgId: string;
  let branchId: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerente = await loginAs(app, 'gerente@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    branchId = f.demoBranches[0]!.id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  async function socio(healthNotes?: string) {
    if (healthNotes) {
      // La nota de salud solo entra por el alta digital con su consentimiento:
      // aquí se usa el repositorio, que es donde se decide cifrarla.
      const { MemberRepository } = await import('../src/modules/members/index.js');
      const u = await getDb().user.findFirstOrThrow({ where: { email: 'gerente@demo.mx' } });
      const m = await new MemberRepository(orgId).create({
        firstName: nombreUnico('Priv'), lastName: nombreUnico('Salud'), homeBranchId: branchId, createdByUserId: u.id, healthNotes,
      }, 'CEN');
      return m.id;
    }
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerente },
      payload: {
        firstName: nombreUnico('Priv'), lastName: nombreUnico('Acidad'), homeBranchId: branchId, force: true,
        phoneE164: `+5255${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        consents: CONSENTIMIENTOS,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  it('la nota de salud se guarda cifrada y quien la lee queda en la bitácora', async () => {
    const id = await socio('Asma leve; trae inhalador');
    const fila = await getDb().member.findUniqueOrThrow({ where: { id } });
    expect(fila.healthNotes).toMatch(/^enc:v1:/);
    expect(fila.healthNotes).not.toContain('Asma');

    const r = await app.inject({ method: 'GET', url: `/members/${id}/health`, headers: { cookie: gerente } });
    expect(r.json().healthNotes).toBe('Asma leve; trae inhalador');
    const lectura = await getDb().auditLog.findFirst({ where: { organizationId: orgId, action: 'health.read', resourceId: id } });
    expect(lectura).not.toBeNull();
  });

  it('ACCESO: la gerencia exporta todo con motivo; recepción no puede', async () => {
    const id = await socio();
    expect((await app.inject({ method: 'GET', url: `/members/${id}/export?reason=Solicitud%20ARCO`, headers: { cookie: recepcion } })).statusCode).toBe(403);
    const r = await app.inject({ method: 'GET', url: `/members/${id}/export?reason=Solicitud%20ARCO%20por%20escrito`, headers: { cookie: gerente } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-disposition']).toContain('attachment');
    const d = r.json();
    expect(d.socio.id).toBe(id);
    expect(d.consentimientos.length).toBeGreaterThan(0);
    // Legible (PS-01): palabras, no claves internas.
    expect(d.consentimientos[0].documento).toBe('Aviso de privacidad');
    expect(d.consentimientos[0].aceptado).toBe('Sí');
    for (const k of ['membresias', 'cargos', 'pagos', 'asistencias', 'biometria']) expect(Array.isArray(d[k]), k).toBe(true);
    expect(await getDb().auditLog.count({ where: { action: 'member.export', resourceId: id } })).toBe(1);
  });

  it('ACCESO: el socio descarga sus datos desde el portal', async () => {
    const id = await socio();
    const invite = await app.inject({ method: 'POST', url: `/members/${id}/portal-invite`, headers: { cookie: gerente } });
    const enroll = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code } });
    const portal = `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}`;
    const r = await app.inject({ method: 'GET', url: '/portal/me/export', headers: { cookie: portal } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().socio.id).toBe(id);
  });

  it('CANCELACIÓN: exige baja previa y dos firmas; borra a la persona y conserva lo contable', async () => {
    const id = await socio('Lesión de hombro');
    await getDb().charge.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberId: id, branchId, chargeType: 'MANUAL_ADJUSTMENT', status: 'OPEN',
        concept: 'Cargo que debe sobrevivir', subtotalCents: 1000n, amountCents: 1000n, dueDate: new Date(), issuedAt: new Date(),
      },
    });

    const antes = await app.inject({
      method: 'POST', url: `/members/${id}/anonymize`, headers: { cookie: gerente },
      payload: { reason: 'Solicitud ARCO', approvalToken: await aprobacion(app, gerente, 'members:anonymize', 'owner@demo.mx', branchId, { resourceId: id }) },
    });
    expect(antes.statusCode).toBe(409); // sigue siendo socio

    await app.inject({ method: 'POST', url: `/members/${id}/archive`, headers: { cookie: gerente }, payload: { reason: 'Pidió su baja' } });
    const sinFirma = await app.inject({ method: 'POST', url: `/members/${id}/anonymize`, headers: { cookie: gerente }, payload: { reason: 'Solicitud ARCO' } });
    expect(sinFirma.statusCode).toBe(428);

    const ok = await app.inject({
      method: 'POST', url: `/members/${id}/anonymize`, headers: { cookie: gerente },
      payload: { reason: 'Solicitud ARCO', approvalToken: await aprobacion(app, gerente, 'members:anonymize', 'owner@demo.mx', branchId, { resourceId: id }) },
    });
    expect(ok.statusCode, ok.body).toBe(204);

    const m = await getDb().member.findUniqueOrThrow({ where: { id } });
    expect(`${m.firstName} ${m.lastName}`).toBe('Socio anonimizado');
    expect([m.phoneE164, m.email, m.healthNotes, m.birthDate]).toEqual([null, null, null, null]);
    expect(m.anonymizedAt).not.toBeNull();
    expect(await getDb().charge.count({ where: { memberId: id } })).toBe(1);
    const asiento = await getDb().auditLog.findFirstOrThrow({ where: { action: 'member.anonymize', resourceId: id } });
    expect(JSON.stringify(asiento.afterState)).not.toContain('Priv');
  });

  it('RETENCIÓN: una alta revisada hace meses pierde sus datos; una reciente no', async () => {
    const mk = async (dias: number) => (await getDb().memberIntake.create({
      data: {
        id: uuidv7(), organizationId: orgId, branchId, status: 'REJECTED', rejectionReason: 'Datos incompletos', firstName: 'Olvidable', lastName: nombreUnico('Alta'),
        nameKey: 'x', phoneE164: '+525511112222', ip: '203.0.113.5', acceptedConsents: [] as never,
        submittedAt: new Date(Date.now() - (dias + 1) * 86_400_000), reviewedAt: new Date(Date.now() - dias * 86_400_000),
      },
    })).id;
    const vieja = await mk(RETENCION.altaRevisadaDias + 5);
    const nueva = await mk(3);

    const job = PRIVACY_JOBS.find((j) => j.name === 'privacy.retention')!;
    const r = await job.handler(orgId);
    expect(r.errors).toEqual([]);

    const v = await getDb().memberIntake.findUniqueOrThrow({ where: { id: vieja } });
    expect([v.firstName, v.phoneE164, v.ip]).toEqual(['[eliminado]', null, null]);
    const n = await getDb().memberIntake.findUniqueOrThrow({ where: { id: nueva } });
    expect(n.firstName).toBe('Olvidable');
  });

  it('un webhook VÁLIDO no se puede borrar ni con permiso de borrar', async () => {
    const id = uuidv7();
    await getDb().webhookEvent.create({
      data: { id, provider: 'sandbox', providerEventId: `evt_${id}`, eventType: 'x', rawPayload: {}, signatureStatus: 'VALID', status: 'RECEIVED' },
    });
    await expect(getDb().webhookEvent.delete({ where: { id } })).rejects.toThrow();
  });
});
