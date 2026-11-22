import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { MEMBER_IDLE_DAYS } from '../src/modules/portal/portal.repository.js';
import { STAFF_MAX_SESSION_HOURS } from '../src/modules/identity/session.repository.js';

/**
 * SEC-11: cuánto vive una sesión y qué la termina.
 */
describe('ciclo de vida de las sesiones', () => {
  let app: FastifyInstance;
  let owner: string;
  let branchId: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    branchId = (await orgFixtures()).demoBranches[0]!.id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  async function socioConPortal() {
    const alta = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: owner },
      payload: { firstName: nombreUnico('Sesion'), lastName: nombreUnico('Portal'), homeBranchId: branchId, consents: CONSENTIMIENTOS, force: true },
    });
    const id = alta.json().id as string;
    const invite = await app.inject({ method: 'POST', url: `/members/${id}/portal-invite`, headers: { cookie: owner } });
    const enroll = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code } });
    return { id, portal: `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}` };
  }
  const me = (portal: string) => app.inject({ method: 'GET', url: '/portal/me', headers: { cookie: portal } });

  it('dar de baja al socio cierra su portal en el acto y no borra sus notas', async () => {
    const { id, portal } = await socioConPortal();
    await getDb().member.update({ where: { id }, data: { notes: 'Prefiere horario matutino' } });
    expect((await me(portal)).statusCode).toBe(200);

    const baja = await app.inject({ method: 'POST', url: `/members/${id}/archive`, headers: { cookie: owner }, payload: { reason: 'Se mudó de ciudad' } });
    expect(baja.statusCode, baja.body).toBeLessThan(300);
    expect((await me(portal)).statusCode).toBe(401);
    const socio = await getDb().member.findUniqueOrThrow({ where: { id } });
    expect(socio.notes).toBe('Prefiere horario matutino');
    const sesiones = await getDb().memberSession.findMany({ where: { memberId: id } });
    expect(sesiones.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it(`el portal sin usar ${MEMBER_IDLE_DAYS} días pide un código nuevo`, async () => {
    const { id, portal } = await socioConPortal();
    await getDb().memberSession.updateMany({
      where: { memberId: id }, data: { lastSeenAt: new Date(Date.now() - (MEMBER_IDLE_DAYS + 1) * 86_400_000) },
    });
    expect((await me(portal)).statusCode).toBe(401);
  });

  it(`la sesión del personal no pasa de ${STAFF_MAX_SESSION_HOURS} h aunque se use sin parar`, async () => {
    const cookie = await loginAs(app, 'recepcion@demo.mx');
    const token = cookie.split('=')[1]!;
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(200);
    const { hashToken } = await import('../src/platform/crypto.js');
    await getDb().session.updateMany({
      where: { tokenHash: hashToken(token) },
      data: { createdAt: new Date(Date.now() - (STAFF_MAX_SESSION_HOURS + 1) * 3_600_000), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
});
