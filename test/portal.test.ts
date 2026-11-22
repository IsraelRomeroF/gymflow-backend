import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, CONSENTIMIENTOS, sedeDesechable, archivarSede } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

const db = () => getDb();

describe('portal del socio', () => {
  let app: FastifyInstance;
  let owner: string;
  let orgId: string;
  let branchId: string;

  async function nuevoSocio(): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: owner },
      payload: {
        firstName: nombreUnico('Por'), lastName: nombreUnico('Tal'),
        phoneE164: telefonoUnico(), homeBranchId: branchId, consents: CONSENTIMIENTOS,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  async function invitar(memberId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: `/members/${memberId}/portal-invite`, headers: { cookie: owner },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().code as string;
  }

  async function activar(code: string) {
    return app.inject({ method: 'POST', url: '/portal/enroll', payload: { code } });
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    const { demo, demoBranches } = await orgFixtures();
    orgId = demo.id;
    branchId = demoBranches.find((b) => b.code === 'CEN')!.id;
  });

  afterAll(async () => { await app.close(); await closeDb(); });

  // ── Activación ────────────────────────────────────────────────────────────
  it('recepción emite el código y el socio activa su dispositivo', async () => {
    const memberId = await nuevoSocio();
    const code = await invitar(memberId);
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const res = await activar(code);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().memberId).toBe(memberId);
    // Sin QR (ADR-032), activar no entrega ningún secreto: solo la sesión.
    expect(res.json()).not.toHaveProperty('qrSecret');
    expect(res.cookies.find((c) => c.name === 'gf_portal')?.httpOnly).toBe(true);
  });

  it('el código es de UN SOLO uso', async () => {
    const code = await invitar(await nuevoSocio());
    expect((await activar(code)).statusCode).toBe(201);
    expect((await activar(code)).statusCode).toBe(401);
  });

  it('emitir uno nuevo INVALIDA el anterior: dos códigos vivos es uno suelto', async () => {
    const memberId = await nuevoSocio();
    const primero = await invitar(memberId);
    const segundo = await invitar(memberId);

    expect((await activar(primero)).statusCode).toBe(401);
    expect((await activar(segundo)).statusCode).toBe(201);
  });

  it('un código caducado no sirve', async () => {
    const memberId = await nuevoSocio();
    const code = await invitar(memberId);
    // Se retrocede TAMBIÉN la creación: el `CHECK` exige que caduque después
    // de crearse, y tiene razón — una invitación que nace caducada es un
    // error de captura, no un caso de negocio.
    await db().portalInvite.updateMany({
      where: { memberId, usedAt: null },
      data: {
        createdAt: new Date(Date.now() - 7_200_000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    expect((await activar(code)).statusCode).toBe(401);
  });

  /**
   * Mensaje ÚNICO para inválido, caducado y usado: distinguirlos le diría a
   * quien prueba códigos cuáles existen.
   */
  it('el rechazo NO dice por qué falló', async () => {
    const inexistente = await activar('AAAAA-BBBBB');
    const memberId = await nuevoSocio();
    const usado = await invitar(memberId);
    await activar(usado);
    const repetido = await activar(usado);

    expect(inexistente.json().message).toBe(repetido.json().message);
  });

  it('el código NO se guarda en claro: la base solo tiene su hash', async () => {
    const memberId = await nuevoSocio();
    const code = await invitar(memberId);
    const fila = await db().portalInvite.findFirstOrThrow({ where: { memberId, usedAt: null } });
    expect(fila.codeHash).not.toContain(code);
    expect(fila.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('el límite de activaciones por defecto es ESTRICTO', async () => {
    const { loadEnv } = await import('../src/platform/env.js');
    const env = loadEnv({ ...process.env, NODE_ENV: 'test', PORTAL_ENROLL_ATTEMPTS: undefined });
    // La suite lo sube para poder activar decenas de dispositivos; el valor
    // real tiene que seguir siendo bajo.
    expect(env.PORTAL_ENROLL_ATTEMPTS).toBeLessThanOrEqual(10);
  });

  // ── Datos del socio ───────────────────────────────────────────────────────
  it('el socio ve SUS datos, con antigüedad', async () => {
    const memberId = await nuevoSocio();
    const res = await activar(await invitar(memberId));
    const cookie = `gf_portal=${res.cookies.find((c) => c.name === 'gf_portal')!.value}`;

    const me = await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie } });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().memberCode).toBeTruthy();
    expect(typeof me.json().tenureDays).toBe('number');
  });

  it('con membresía que se renueva sola, dice cuánto y cuándo es su próximo pago', async () => {
    const memberId = await nuevoSocio();
    const planes = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie: owner } })).json();
    const plan = planes.find((p: { code: string }) => p.code === 'MEN');
    const mem = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships`, headers: { cookie: owner },
      payload: { reason: 'Fixture de prueba', planId: plan.id, soldAtBranchId: branchId },
    });
    await app.inject({ method: 'POST', url: `/memberships/${mem.json().id}/activate`, headers: { cookie: owner }, payload: { reason: 'Fixture de prueba' } });
    const cookie = `gf_portal=${(await activar(await invitar(memberId))).cookies.find((c) => c.name === 'gf_portal')!.value}`;
    const me = (await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie } })).json();
    expect(me.membershipStatus).toBe('ACTIVE');
    expect(me.nextPayment).toEqual({ amountCents: String(plan.priceCents), date: me.currentPeriodEnd });

    await db().membership.update({ where: { id: mem.json().id }, data: { autoRenew: false } });
    expect((await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie } })).json().nextPayment).toBeNull();
  });

  it('una membresía SUSPENDIDA se le muestra, no se esconde como "sin plan"', async () => {
    const memberId = await nuevoSocio();
    const planes = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie: owner } })).json();
    const plan = planes.find((p: { code: string }) => p.code === 'MEN');
    const mem = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships`, headers: { cookie: owner },
      payload: { reason: 'Fixture de prueba', planId: plan.id, soldAtBranchId: branchId },
    });
    await app.inject({ method: 'POST', url: `/memberships/${mem.json().id}/activate`, headers: { cookie: owner }, payload: { reason: 'Fixture de prueba' } });
    await db().membership.update({ where: { id: mem.json().id }, data: { status: 'SUSPENDED' } });

    const cookie = `gf_portal=${(await activar(await invitar(memberId))).cookies.find((c) => c.name === 'gf_portal')!.value}`;
    const me = (await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie } })).json();
    expect(me.membershipStatus).toBe('SUSPENDED');
    expect(me.planName).toBe(plan.name);
  });

  it('el socio ve con qué entra y dónde, sin nada de la plantilla', async () => {
    const memberId = await nuevoSocio();
    const cookie = `gf_portal=${(await activar(await invitar(memberId))).cookies.find((c) => c.name === 'gf_portal')!.value}`;

    const antes = (await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie } })).json();
    // Sin enrolamiento, la lista está vacía: el portal le dice que entra por recepción.
    expect(antes.accessMethods).toEqual([]);

    const alta = await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`, headers: { cookie: owner },
      payload: {
        modality: 'FACE', branchId, templateRef: 'tpl_portal_prueba',
        algorithmVendor: 'insightface/buffalo_sc', reason: 'Prueba del portal',
      },
    });
    expect(alta.statusCode, alta.body).toBe(201);

    const res = await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie } });
    const despues = res.json();
    expect(despues.accessMethods).toHaveLength(1);
    expect(despues.accessMethods[0]).toMatchObject({ modality: 'FACE', branchName: 'Centro' });
    expect(despues.homeBranchName).toBeTruthy();
    expect(res.body).not.toContain('tpl_portal_prueba');

    // Revocado, deja de aparecer: el socio no debe creer que entra con algo que ya no sirve.
    await app.inject({
      method: 'POST', url: `/biometric-enrollments/${alta.json().id}/revoke`, headers: { cookie: owner },
      payload: { reason: 'Lo pidió el socio' },
    });
    const final = (await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie } })).json();
    expect(final.accessMethods).toEqual([]);
  });

  it('el estado de cuenta lleva CUÁNDO se calculó (principio 10)', async () => {
    const memberId = await nuevoSocio();
    const res = await activar(await invitar(memberId));
    const cookie = `gf_portal=${res.cookies.find((c) => c.name === 'gf_portal')!.value}`;

    const st = await app.inject({ method: 'GET', url: '/portal/statement', headers: { cookie } });
    expect(st.statusCode).toBe(200);
    expect(st.json().computedAt).toBeTruthy();
    expect(new Date(st.json().computedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('sin sesión de socio, el portal responde 401', async () => {
    for (const url of ['/portal/me', '/portal/statement', '/portal/attendance']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });

  /**
   * La sesión del PERSONAL no sirve en el portal y viceversa. Mezclarlas
   * significaría que un error de resolución podría conceder permisos de
   * personal, y un error así no revienta: autoriza (ADR-023).
   */
  it('la sesión del PERSONAL no abre el portal', async () => {
    const res = await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie: owner } });
    expect(res.statusCode).toBe(401);
  });

  it('la sesión del SOCIO no abre el panel del personal', async () => {
    const memberId = await nuevoSocio();
    const r = await activar(await invitar(memberId));
    const cookie = `gf_portal=${r.cookies.find((c) => c.name === 'gf_portal')!.value}`;
    for (const url of ['/members', '/dashboard', '/organization']) {
      expect((await app.inject({ method: 'GET', url, headers: { cookie } })).statusCode, url).toBe(401);
    }
  });

  it('cerrar sesión la revoca de verdad', async () => {
    const memberId = await nuevoSocio();
    const r = await activar(await invitar(memberId));
    const cookie = `gf_portal=${r.cookies.find((c) => c.name === 'gf_portal')!.value}`;

    expect((await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/portal/logout', headers: { cookie } });
    expect((await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie } })).statusCode).toBe(401);
  });

  // ── Padrón ────────────────────────────────────────────────────────────────
  it('el socio activado aparece en el padrón, sin ningún secreto', async () => {
    /**
     * Sucursal PROPIA de la prueba.
     *
     * Antes usaba la del fixture, y la prueba dependía de cuántos socios
     * hubiera acumulado la base de desarrollo: pasaba en CI —base limpia— y
     * fallaba en local, que es la peor combinación posible. El padrón tiene
     * un tope, así que una sede con historial lo desborda.
     */
    const sede = await sedeDesechable((await orgFixtures()).demo.id, 'Padrón de prueba');

    const alta = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: owner },
      payload: {
        firstName: nombreUnico('Por'), lastName: nombreUnico('Tal'),
        phoneE164: telefonoUnico(), homeBranchId: sede.id, consents: CONSENTIMIENTOS,
      },
    });
    const memberId = alta.json().id as string;
    const res = await activar(await invitar(memberId));

    const padron = await app.inject({
      method: 'GET', url: `/access/roster?branchId=${sede.id}`, headers: { cookie: owner },
    });
    const entrada = padron.json().payload.entries
      .find((e: { memberId: string }) => e.memberId === memberId);
    expect(res.statusCode).toBe(201);
    expect(entrada).toBeTruthy();
    expect(Object.keys(entrada)).not.toContain('qrSecret');
    await archivarSede(sede.id);
  });

  it('un socio de OTRA organización no puede recibir invitación desde esta', async () => {
    const { other } = await orgFixtures();
    const ajeno = await db().member.findFirst({ where: { organizationId: other.id, deletedAt: null } });
    if (!ajeno) return;
    const res = await app.inject({
      method: 'POST', url: `/members/${ajeno.id}/portal-invite`, headers: { cookie: owner },
    });
    expect(res.statusCode).toBe(404);
    expect(orgId).toBeTruthy();
  });
});
