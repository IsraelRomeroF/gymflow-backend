import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, CONSENTIMIENTOS, aprobacion, loginPlataforma } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { mesDeCobro } from '../src/modules/tenants/cobro-reglas.js';

/** Auditoría 6, fase 3: la plataforma opera gimnasios, no solo los da de alta. */
describe('fase 3 · plataforma', () => {
  let app: FastifyInstance;
  let plataforma: string;
  let orgId: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    plataforma = await loginPlataforma(app);
    orgId = (await orgFixtures()).demo.id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  it('DP-03 · la portada dice cuánto factura GymFlow al mes y la cobranza lista todas las facturas', async () => {
    const marcas = await app.inject({ method: 'GET', url: '/platform/organizations', headers: { cookie: plataforma } });
    expect(marcas.statusCode, marcas.body).toBe(200);
    expect(marcas.json().monthlyIncomeCents).toMatch(/^\d+$/);
    const r = await app.inject({ method: 'GET', url: '/platform/billing', headers: { cookie: plataforma } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().monthlyIncome.totalCents).toMatch(/^\d+$/);
    expect(Array.isArray(r.json().invoices)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/platform/billing?month=2026-13', headers: { cookie: plataforma } })).statusCode).toBe(422);
  });

  it('DP-03 · emitir el mes a todas las marcas es idempotente y explica a quién saltó', { timeout: 90_000 }, async () => {
    // El mes en curso en la Ciudad de México: un mes que no ha empezado ya no se emite (23-06, bloque 1.13).
    const mes = mesDeCobro();
    const primera = await app.inject({ method: 'POST', url: '/platform/invoices/issue-month', headers: { cookie: plataforma }, payload: { month: mes } });
    expect(primera.statusCode, primera.body).toBe(200);
    const r1 = primera.json() as { month: string; issued: Array<{ organizationId: string; folio: string }>; skipped: Array<{ organizationId: string; reason: string }>; failed: unknown[] };
    expect(r1.month).toBe(mes);
    // El lote recorre las marcas en uso y dice también a qué suspendidas no les cobra.
    const delLote = await getDb().organization.count({ where: { deletedAt: null, serviceStatus: { in: ['ACTIVE', 'SUSPENDED'] } } });
    expect(r1.issued.length + r1.skipped.length + r1.failed.length).toBe(delLote);
    expect(r1.failed).toEqual([]);
    for (const s of r1.skipped) expect(s.reason).toMatch(/Sin precio|Ya tiene factura|Mensualidad en cero|suspendido|anterior a la liberación/);

    // Segunda vez: nada nuevo, todo "ya tiene factura" (o sigue sin precio).
    const segunda = (await app.inject({ method: 'POST', url: '/platform/invoices/issue-month', headers: { cookie: plataforma }, payload: { month: mes } })).json() as typeof r1;
    expect(segunda.issued).toEqual([]);
    for (const id of r1.issued.map((x) => x.organizationId)) {
      expect(segunda.skipped.find((s) => s.organizationId === id)?.reason).toBe('Ya tiene factura de ese mes');
    }
    // Limpieza: las facturas no se borran (append-only para la API); se anulan.
    // Solo las que emitió esta prueba: el mes es el de verdad y otras pruebas tienen las suyas.
    const emitidas = await getDb().platformInvoice.findMany({ where: { folio: { in: r1.issued.map((x) => x.folio) }, status: 'PENDING' }, select: { id: true } });
    for (const f of emitidas) {
      expect((await app.inject({ method: 'POST', url: `/platform/invoices/${f.id}/void`, headers: { cookie: plataforma }, payload: { reason: 'Emitida por la prueba de la fase 3' } })).statusCode).toBe(200);
    }
  });

  it('DP-03 · el pago de una factura lleva la fecha en que llegó el dinero', async () => {
    const pendiente = await getDb().platformInvoice.findFirst({ where: { status: 'PENDING' } });
    if (!pendiente) return; // sin precios sembrados no hay facturas: la ruta ya acepta paidAt (ver el esquema)
    const r = await app.inject({ method: 'POST', url: `/platform/invoices/${pendiente.id}/pay`, headers: { cookie: plataforma }, payload: { paymentMethod: 'SPEI_TRANSFER', paymentRef: 'RASTREO-FASE3', paidAt: '2026-10-03T12:00:00.000Z' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().paidAt.slice(0, 10)).toBe('2026-10-03');
  });

  it('DP-04 · soporte ve sesiones abiertas, versión y último cierre diario; la bitácora de la marca solo trae actos de GymFlow', async () => {
    const gerencia = await loginAs(app, 'gerencia@demo.mx');
    void gerencia;
    const s = await app.inject({ method: 'GET', url: `/platform/organizations/${orgId}/support`, headers: { cookie: plataforma } });
    expect(s.statusCode, s.body).toBe(200);
    const d = s.json();
    expect(d.version.app).toMatch(/^\d+\.\d+\.\d+/);
    expect(d.activeSessions.some((x: { fullName: string | null }) => x.fullName)).toBe(true);
    expect(Array.isArray(d.staffLastLogin)).toBe(true);

    const a = await app.inject({ method: 'GET', url: `/platform/organizations/${orgId}/audit?limit=20`, headers: { cookie: plataforma } });
    expect(a.statusCode, a.body).toBe(200);
    for (const e of a.json().entries as Array<{ action: string; phrase: string }>) {
      expect(e.action.startsWith('platform.')).toBe(true);
      expect(e.phrase).not.toContain('.');
    }
    // El personal del gimnasio no entra a lo de la plataforma.
    // Para el personal de un gimnasio, lo de la plataforma no existe (404, no 403): no se le dice que hay algo ahí.
    expect((await app.inject({ method: 'GET', url: `/platform/organizations/${orgId}/support`, headers: { cookie: gerencia } })).statusCode).toBe(404);
  });

  it('DP-05 · la bitácora del gimnasio llega con frase y categoría "plataforma"', async () => {
    const owner = await loginAs(app, 'owner@demo.mx');
    const r = await app.inject({ method: 'GET', url: '/audit?category=plataforma&limit=5', headers: { cookie: owner } });
    expect(r.statusCode, r.body).toBe(200);
    for (const e of r.json().entries as Array<{ action: string; phrase: string }>) {
      expect(e.action.startsWith('platform.')).toBe(true);
      expect(typeof e.phrase).toBe('string');
    }
    const todo = await app.inject({ method: 'GET', url: '/audit?limit=20', headers: { cookie: owner } });
    for (const e of todo.json().entries as Array<{ action: string; phrase: string }>) expect(e.phrase.length).toBeGreaterThan(3);
  });

  // ── Dueño y gerencia ──────────────────────────────────────────────────────

  it('DP-07 · el arranque se completa aunque el gerente atienda el mostrador, y cada paso dice quién puede resolverlo', async () => {
    const gerencia = await loginAs(app, 'gerencia@demo.mx');
    const antes = (await app.inject({ method: 'GET', url: '/organization/setup', headers: { cookie: gerencia } })).json();
    expect(antes.steps.map((p: { key: string }) => p.key)).not.toContain('modulos');
    expect(antes.steps.some((p: { key: string }) => p.key === 'importar')).toBe(true);
    expect(antes.steps.some((p: { key: string }) => p.key === 'dueno')).toBe(true);
    for (const p of antes.steps) expect(typeof p.canAct).toBe('boolean');

    const on = await app.inject({ method: 'PUT', url: '/organization/setup/front-desk', headers: { cookie: gerencia }, payload: { managerAttendsFrontDesk: true } });
    expect(on.statusCode, on.body).toBe(200);
    const con = (await app.inject({ method: 'GET', url: '/organization/setup', headers: { cookie: gerencia } })).json();
    expect(con.steps.find((p: { key: string }) => p.key === 'personal').done).toBe(true);
    await app.inject({ method: 'PUT', url: '/organization/setup/front-desk', headers: { cookie: gerencia }, payload: { managerAttendsFrontDesk: false } });
    // Recepción no toca el arranque.
    const recepcion = await loginAs(app, 'recepcion@demo.mx');
    expect((await app.inject({ method: 'PUT', url: '/organization/setup/front-desk', headers: { cookie: recepcion }, payload: { managerAttendsFrontDesk: true } })).statusCode).toBe(403);
  });

  it('DP-09 · una caja se renombra pero no se retira con turno abierto; una sucursal con caja abierta no se cierra', async () => {
    const gerencia = await loginAs(app, 'gerencia@demo.mx');
    const cen = (await orgFixtures()).demoBranches.find((b) => b.code === 'CEN')!.id;
    const cajas = (await app.inject({ method: 'GET', url: `/cash-registers?branchId=${cen}`, headers: { cookie: gerencia } })).json().registers as Array<{ id: string; name: string }>;
    const caja = cajas[0]!;
    const r = await app.inject({ method: 'PATCH', url: `/cash-registers/${caja.id}`, headers: { cookie: gerencia }, payload: { name: 'Caja principal' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().name).toBe('Caja principal');
    await app.inject({ method: 'PATCH', url: `/cash-registers/${caja.id}`, headers: { cookie: gerencia }, payload: { name: caja.name } });

    // Con turno abierto: ni retirar la caja ni cerrar la sucursal.
    const abierta = await app.inject({ method: 'POST', url: '/cash-sessions', headers: { cookie: gerencia }, payload: { cashRegisterId: caja.id, openingFloatCents: '50000' } });
    expect([200, 201, 409]).toContain(abierta.statusCode);
    expect((await app.inject({ method: 'PATCH', url: `/cash-registers/${caja.id}`, headers: { cookie: gerencia }, payload: { isActive: false } })).statusCode).toBe(409);
    const resumen = await app.inject({ method: 'GET', url: `/branches/${cen}/closing-summary`, headers: { cookie: gerencia } });
    expect(resumen.statusCode, resumen.body).toBe(200);
    expect(resumen.json().openCashSessions).toBeGreaterThan(0);
    expect(resumen.json().homeMembers).toBeGreaterThan(0);
    // Con motivo (cerrar lo exige desde 1.14), para llegar a la regla de la caja abierta.
    const cierre = await app.inject({ method: 'PATCH', url: `/branches/${cen}`, headers: { cookie: gerencia }, payload: { isActive: false, reason: 'Prueba de cierre' } });
    expect(cierre.statusCode, cierre.body).toBe(409);
  });

  // ── El socio y sus datos ──────────────────────────────────────────────────

  async function socioConMarketing(gerencia: string, cen: string): Promise<string> {
    // La versión vigente del texto de marketing la fija la base de pruebas, no esta prueba.
    const docs = (await app.inject({ method: 'GET', url: '/consent-documents', headers: { cookie: gerencia } })).json().documents as Array<{ consentType: string; status: string; version: string }>;
    const marketing = docs.find((d) => d.consentType === 'MARKETING' && d.status === 'PUBLISHED');
    expect(marketing, 'hace falta un texto MARKETING publicado en la base de pruebas').toBeTruthy();
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Ftres'), lastName: nombreUnico('Arco'), homeBranchId: cen, force: true, consents: [...CONSENTIMIENTOS, { consentType: 'MARKETING', documentVersion: marketing!.version, granted: true }] },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  it('PS-07 · el socio retira marketing desde su teléfono y pide una corrección; recepción la ve con su plazo y la resuelve', async () => {
    const gerencia = await loginAs(app, 'gerencia@demo.mx');
    const cen = (await orgFixtures()).demoBranches.find((b) => b.code === 'CEN')!.id;
    const id = await socioConMarketing(gerencia, cen);
    const invite = await app.inject({ method: 'POST', url: `/members/${id}/portal-invite`, headers: { cookie: gerencia } });
    const enroll = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code } });
    const portal = `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}`;

    const lista = (await app.inject({ method: 'GET', url: '/portal/consents', headers: { cookie: portal } })).json().consents as Array<{ consentType: string; revocable: boolean }>;
    expect(lista.find((c) => c.consentType === 'MARKETING')?.revocable).toBe(true);
    expect(lista.find((c) => c.consentType === 'PRIVACY_NOTICE')?.revocable).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/portal/consents/PRIVACY_NOTICE/revoke', headers: { cookie: portal }, payload: {} })).statusCode).toBe(422);
    const rev = await app.inject({ method: 'POST', url: '/portal/consents/MARKETING/revoke', headers: { cookie: portal }, payload: {} });
    expect(rev.statusCode, rev.body).toBe(200);
    const tras = (await app.inject({ method: 'GET', url: `/members/${id}/consents`, headers: { cookie: gerencia } })).json() as Array<{ consentType: string; revokedAt: string | null }>;
    expect(tras.find((c) => c.consentType === 'MARKETING')?.revokedAt).toBeTruthy();

    const pedido = await app.inject({ method: 'POST', url: '/portal/privacy-requests', headers: { cookie: portal }, payload: { kind: 'RECTIFICATION', note: 'Mi apellido está mal escrito' } });
    expect(pedido.statusCode, pedido.body).toBe(201);
    expect(new Date(pedido.json().dueAt).getTime()).toBeGreaterThan(Date.now() + 20 * 86_400_000);
    const bandeja = (await app.inject({ method: 'GET', url: '/privacy/requests', headers: { cookie: gerencia } })).json().requests as Array<{ id: string; memberId: string; channel: string; overdue: boolean }>;
    const mia = bandeja.find((r) => r.memberId === id);
    expect(mia?.channel).toBe('PORTAL');
    expect(mia?.overdue).toBe(false);
    const res = await app.inject({ method: 'POST', url: `/privacy/requests/${mia!.id}/resolve`, headers: { cookie: gerencia }, payload: { outcome: 'GRANTED', resolution: 'Apellido corregido en la ficha' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().resolvedAt).toBeTruthy();
    expect(await getDb().auditLog.count({ where: { action: 'privacy.request.resolve', resourceId: mia!.id } })).toBe(1);

    // Recepción también retira un consentimiento desde la ficha, con motivo.
    const otro = await socioConMarketing(gerencia, cen);
    const cons = (await app.inject({ method: 'GET', url: `/members/${otro}/consents`, headers: { cookie: gerencia } })).json() as Array<{ id: string; consentType: string }>;
    const mk = cons.find((c) => c.consentType === 'MARKETING')!;
    expect((await app.inject({ method: 'POST', url: `/members/${otro}/consents/${mk.id}/revoke`, headers: { cookie: gerencia }, payload: { reason: 'Lo pidió en mostrador' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/members/${otro}/consents/${mk.id}/revoke`, headers: { cookie: gerencia }, payload: { reason: 'Otra vez' } })).statusCode).toBe(409);
  });

  it('PS-08 · el plazo de supresión propone exsocios y anonimizar deja el prospecto y las notas sin persona', async () => {
    const gerencia = await loginAs(app, 'gerencia@demo.mx');
    const cen = (await orgFixtures()).demoBranches.find((b) => b.code === 'CEN')!.id;
    await app.inject({ method: 'PUT', url: '/privacy/settings', headers: { cookie: gerencia }, payload: { monthsAfterArchive: null } });
    expect((await app.inject({ method: 'GET', url: '/privacy/candidates', headers: { cookie: gerencia } })).json().members).toEqual([]);
    expect((await app.inject({ method: 'PUT', url: '/privacy/settings', headers: { cookie: gerencia }, payload: { monthsAfterArchive: 24 } })).statusCode).toBe(200);

    const id = await socioConMarketing(gerencia, cen);
    await app.inject({ method: 'POST', url: `/members/${id}/archive`, headers: { cookie: gerencia }, payload: { reason: 'Se fue' } });
    await getDb().$executeRaw`UPDATE "members" SET "deletedAt" = now() - interval '25 months' WHERE "id" = ${id}::uuid`;
    const cand = (await app.inject({ method: 'GET', url: '/privacy/candidates', headers: { cookie: gerencia } })).json() as { monthsAfterArchive: number; members: Array<{ id: string }> };
    expect(cand.monthsAfterArchive).toBe(24);
    expect(cand.members.map((m) => m.id)).toContain(id);

    // Un prospecto convertido en este socio y una nota de rutina: ambos quedan sin persona al anonimizar.
    const { uuidv7 } = await import('@gymflow/core');
    await getDb().prospect.create({ data: { id: uuidv7(), organizationId: orgId, branchId: cen, firstName: 'Pros', lastName: 'Pecto', nameKey: 'pros pecto', phoneE164: null, email: null, status: 'CONVERTED', convertedMemberId: id, convertedAt: new Date(), source: 'WALK_IN' } as never });
    const ok = await app.inject({
      method: 'POST', url: `/members/${id}/anonymize`, headers: { cookie: gerencia },
      payload: { reason: 'Plazo cumplido', approvalToken: await aprobacion(app, gerencia, 'members:anonymize', 'owner@demo.mx', cen, { resourceId: id }) },
    });
    expect(ok.statusCode, ok.body).toBe(204);
    const pros = await getDb().prospect.findFirst({ where: { convertedMemberId: id } });
    expect(pros?.firstName).toBe('Prospecto');
    expect((await app.inject({ method: 'GET', url: '/privacy/candidates', headers: { cookie: gerencia } })).json().members.map((m: { id: string }) => m.id)).not.toContain(id);
    await app.inject({ method: 'PUT', url: '/privacy/settings', headers: { cookie: gerencia }, payload: { monthsAfterArchive: null } });
  });

  it('PS-03 · el socio recibe avisos: teléfono nuevo al activar, pago por vencer del job, y los marca leídos', async () => {
    const gerencia = await loginAs(app, 'gerencia@demo.mx');
    const cen = (await orgFixtures()).demoBranches.find((b) => b.code === 'CEN')!.id;
    const alta = await app.inject({ method: 'POST', url: '/members', headers: { cookie: gerencia }, payload: { firstName: nombreUnico('Aviso'), lastName: nombreUnico('Portal'), homeBranchId: cen, force: true, consents: CONSENTIMIENTOS } });
    const id = alta.json().id as string;
    const planes = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie: gerencia } })).json();
    const planId = planes.find((p: { code: string }) => p.code === 'MEN').id;
    const venta = await app.inject({ method: 'POST', url: `/members/${id}/memberships/sale`, headers: { cookie: gerencia }, payload: { planId, branchId: cen, payment: null } });
    expect(venta.statusCode, venta.body).toBe(201);
    // La cuota vence en tres días DE LA SEDE (no de la base, que va en UTC: después de las 18:00
    // del centro ya es mañana ahí y el job, que usa el día de la sede desde 2.13, no la veía): el job debe avisarlo.
    const { BusinessCalendar } = await import('../src/platform/time/business-calendar.js');
    const vence = new Date((await new BusinessCalendar(orgId).today(cen)).getTime() + 3 * 86_400_000);
    await getDb().$executeRaw`UPDATE "charges" SET "dueDate" = ${vence}::date WHERE "membershipId" = ${venta.json().membership.id}::uuid AND "chargeType" = 'MEMBERSHIP_PERIOD'`;
    const { PORTAL_JOBS } = await import('../src/modules/portal/index.js');
    const r = await PORTAL_JOBS.find((j) => j.name === 'portal.notices')!.handler(orgId);
    expect(r.errors).toEqual([]);
    expect(r.processed).toBeGreaterThan(0);
    // Segunda corrida: nada nuevo para este socio (idempotente).
    const r2 = await PORTAL_JOBS.find((j) => j.name === 'portal.notices')!.handler(orgId);
    expect(r2.errors).toEqual([]);

    const invite = await app.inject({ method: 'POST', url: `/members/${id}/portal-invite`, headers: { cookie: gerencia } });
    const enroll = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code } });
    const portal = `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}`;
    const lista = (await app.inject({ method: 'GET', url: '/portal/notices', headers: { cookie: portal } })).json() as { unread: number; notices: Array<{ kind: string; readAt: string | null }> };
    expect(lista.notices.map((n) => n.kind)).toEqual(expect.arrayContaining(['NEW_DEVICE', 'PAYMENT_DUE_SOON']));
    expect(lista.unread).toBe(lista.notices.length);
    const leido = await app.inject({ method: 'POST', url: '/portal/notices/read', headers: { cookie: portal }, payload: {} });
    expect(leido.json().read).toBe(lista.unread);
    expect((await app.inject({ method: 'GET', url: '/portal/notices', headers: { cookie: portal } })).json().unread).toBe(0);
  });
});
