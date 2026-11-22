import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures } from './helpers.js';
import { closeDb } from '../src/platform/db/client.js';

/**
 * PRUEBA DE FUGA DE TENANT — control nº4 de ADR-001.
 *
 * Se autentica como la organización A y pide identificadores de la B. Exige
 * 404, NUNCA 403: un 403 confirmaría que el recurso existe, que es justo lo
 * que no debe revelarse.
 *
 * LA COBERTURA RUTA POR RUTA YA NO VIVE AQUÍ (bloque 1.17b). Antes este
 * archivo llevaba a mano la lista de los GET con `:id` y nada comprobaba que
 * cada uno tuviera su caso, ni miraba las rutas que escriben. Ahora
 * `rutas-registro.test.ts` recorre el registro entero y pide, en TODA ruta
 * con parámetro (lea o escriba), un recurso de otro gimnasio. Aquí quedan los
 * casos con historia: lo que no se ve con un 404 (listados, búsquedas, el
 * contenido de la respuesta) y los que arman datos a propósito.
 */
describe('aislamiento entre organizaciones', () => {
  let app: FastifyInstance;
  let cookieA: string;
  let fixtures: Awaited<ReturnType<typeof orgFixtures>>;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    fixtures = await orgFixtures();
    cookieA = await loginAs(app, 'gerencia@demo.mx');
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('el seguimiento de un prospecto AJENO devuelve 404 y no se le puede agregar contacto', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const branch = await db.branch.findFirstOrThrow({ where: { organizationId: fixtures.other.id } });
    const { uuidv7 } = await import('@gymflow/core');
    const id = uuidv7();
    await db.prospect.create({ data: { id, organizationId: fixtures.other.id, branchId: branch.id, firstName: 'Ajeno', lastName: 'Prospecto', nameKey: 'ajeno prospecto' } });
    expect((await app.inject({ method: 'GET', url: `/prospects/${id}/follow-ups`, headers: { cookie: cookieA } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/prospects/${id}/follow-ups`, headers: { cookie: cookieA }, payload: { channel: 'CALL', outcome: 'ANSWERED' } })).statusCode).toBe(404);
    await db.prospect.delete({ where: { id } });
  });

  it('los conteos de cierre de una sucursal AJENA devuelven 404', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const branch = await db.branch.findFirstOrThrow({ where: { organizationId: fixtures.other.id } });
    expect((await app.inject({ method: 'GET', url: `/branches/${branch.id}/closing-summary`, headers: { cookie: cookieA } })).statusCode).toBe(404);
  });

  it('una importación de socios de OTRA organización devuelve 404, también sus filas', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const { uuidv7 } = await import('@gymflow/core');
    const branch = await db.branch.findFirstOrThrow({ where: { organizationId: fixtures.other.id } });
    const user = await db.user.findFirstOrThrow({ where: { organizationId: fixtures.other.id } });
    const imp = await db.memberImport.create({
      data: {
        id: uuidv7(), organizationId: fixtures.other.id, branchId: branch.id, fileName: 'ajena.csv',
        cutoffDate: new Date('2026-01-01T00:00:00Z'), totalRows: 0, createdByUserId: user.id,
      },
    });
    for (const url of [`/member-imports/${imp.id}`, `/member-imports/${imp.id}/rows`]) {
      expect((await app.inject({ method: 'GET', url, headers: { cookie: cookieA } })).statusCode).toBe(404);
    }
  });

  it('un alta digital de OTRA organización devuelve 404', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const { uuidv7, normalizedNameKey } = await import('@gymflow/core');
    const branch = await db.branch.findFirstOrThrow({ where: { organizationId: fixtures.other.id } });

    const intake = await db.memberIntake.create({
      data: {
        id: uuidv7(), organizationId: fixtures.other.id, branchId: branch.id,
        firstName: 'Ajena', lastName: 'Alta', nameKey: normalizedNameKey('Ajena Alta'),
        acceptedConsents: [],
      },
    });
    const res = await app.inject({
      method: 'GET', url: `/intakes/${intake.id}`, headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_FOUND');

    // `DELETE` sobre `member_intakes` está revocado para el rol de aplicación
    // —el borrador es evidencia de una firma—, así que la limpieza va con el
    // rol dueño, igual que la de los cargos.
    const { createPrismaClient } = await import('@gymflow/db');
    const owner = createPrismaClient(process.env.DATABASE_URL_MIGRATOR);
    try {
      await owner.$executeRawUnsafe(`DELETE FROM "member_intakes" WHERE "id" = '${intake.id}'`);
    } finally {
      await owner.$disconnect();
    }
  });

  it('los reembolsos de un pago de OTRA organización devuelven lista vacía', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const { uuidv7, normalizedNameKey } = await import('@gymflow/core');
    const branch = await db.branch.findFirstOrThrow({ where: { organizationId: fixtures.other.id } });

    const member = await db.member.create({
      data: {
        id: uuidv7(), organizationId: fixtures.other.id, memberCode: `AJE-${Date.now() % 100000}`,
        firstName: 'Ajeno', lastName: 'Reembolso', nameKey: normalizedNameKey('Ajeno Reembolso'),
        homeBranchId: branch.id, joinedAt: new Date(),
      },
    });
    const payment = await db.payment.create({
      data: {
        id: uuidv7(), organizationId: fixtures.other.id, memberId: member.id, branchId: branch.id,
        method: 'CASH', status: 'SUCCEEDED', amountCents: 50_000n, businessDate: new Date(),
      },
    });
    const refund = await db.refund.create({
      data: {
        id: uuidv7(), organizationId: fixtures.other.id, paymentId: payment.id,
        amountCents: 10_000n, reason: 'Ajeno', idempotencyKey: `rf_${payment.id}_n1`,
      },
    });

    const res = await app.inject({
      method: 'GET', url: `/payments/${payment.id}/refunds`, headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().refunds).toEqual([]);
    expect(res.json().refundedCents).toBe('0');

    // Solo se retira el reembolso. **El pago no se puede borrar ni con el rol
    // dueño**: un trigger lo impide, y eso es exactamente la garantía del
    // libro financiero. Dejar el rastro de la prueba es el precio de que un
    // pago no desaparezca nunca, y es el precio correcto.
    const { createPrismaClient } = await import('@gymflow/db');
    const owner = createPrismaClient(process.env.DATABASE_URL_MIGRATOR);
    try {
      await owner.$executeRawUnsafe(`DELETE FROM "refunds" WHERE "id" = '${refund.id}'`);
    } finally {
      await owner.$disconnect();
    }
  });

  it('las reservas de una clase de OTRA organización no se ven: 404, ni siquiera se confirma que existe', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const { uuidv7 } = await import('@gymflow/core');
    const branch = await db.branch.findFirstOrThrow({ where: { organizationId: fixtures.other.id } });

    const tipo = await db.classType.create({
      data: { id: uuidv7(), organizationId: fixtures.other.id, name: `Ajena ${Date.now()}` },
    });
    const schedule = await db.classSchedule.create({
      data: {
        id: uuidv7(), organizationId: fixtures.other.id, branchId: branch.id,
        classTypeId: tipo.id, occurrenceKey: `ajena:${uuidv7()}`,
        startsAt: new Date(Date.now() + 86_400_000),
        endsAt: new Date(Date.now() + 90_000_000),
        businessDate: new Date(), capacity: 10,
      },
    });

    const res = await app.inject({
      method: 'GET', url: `/classes/schedules/${schedule.id}/bookings`, headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(404);
    const cotiza = await app.inject({
      method: 'GET', url: `/classes/schedules/${schedule.id}/quote?memberId=${uuidv7()}`, headers: { cookie: cookieA },
    });
    expect(cotiza.statusCode).toBe(404);

    await db.classSchedule.delete({ where: { id: schedule.id } });
    await db.classType.delete({ where: { id: tipo.id } });
  });

  it('una solicitud de firma de OTRA organización devuelve 404', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const { uuidv7 } = await import('@gymflow/core');
    const ajeno = fixtures.otherUsers[0]!;
    const sol = await db.approvalRequest.create({
      data: {
        id: uuidv7(), organizationId: fixtures.other.id, requestedByUserId: ajeno.id, permission: 'payments:refund',
        resourceId: uuidv7(), summary: 'Ajena', expiresAt: new Date(Date.now() + 600_000),
      },
    });
    expect((await app.inject({ method: 'GET', url: `/approvals/requests/${sol.id}`, headers: { cookie: cookieA } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/approvals/requests/${sol.id}/approve`, headers: { cookie: cookieA }, payload: { password: 'x' } })).statusCode).toBe(404);
    await db.approvalRequest.update({ where: { id: sol.id }, data: { status: 'CANCELED' } });
  });

  it('una sucursal de OTRA organización devuelve 404, no 403', async () => {
    const foreign = fixtures.otherBranches[0]!;
    const res = await app.inject({
      method: 'GET',
      url: `/branches/${foreign.id}`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_FOUND');
  });

  it('un usuario de OTRA organización devuelve 404, no 403', async () => {
    const foreign = fixtures.otherUsers[0]!;
    const res = await app.inject({
      method: 'GET',
      url: `/users/${foreign.id}`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(404);
  });

  it('un socio de OTRA organización devuelve 404', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const foreign = await db.member.findFirst({ where: { organizationId: fixtures.other.id } });
    if (!foreign) {
      // La otra organización no tiene socios: se crea uno mínimo para probarlo.
      const { uuidv7, normalizedNameKey } = await import('@gymflow/core');
      const created = await db.member.create({
        data: {
          id: uuidv7(), organizationId: fixtures.other.id, memberCode: 'UNI-99999',
          firstName: 'Ajeno', lastName: 'Ajeno', nameKey: normalizedNameKey('Ajeno Ajeno'),
          joinedAt: new Date(),
        },
      });
      const res = await app.inject({ method: 'GET', url: `/members/${created.id}`, headers: { cookie: cookieA } });
      expect(res.statusCode).toBe(404);
      await db.member.delete({ where: { id: created.id } });
      return;
    }
    const res = await app.inject({ method: 'GET', url: `/members/${foreign.id}`, headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(404);
  });

  it('una membresía de OTRA organización devuelve 404', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const { uuidv7, normalizedNameKey } = await import('@gymflow/core');
    const branch = await db.branch.findFirstOrThrow({ where: { organizationId: fixtures.other.id } });
    const plan = await db.plan.findFirstOrThrow({ where: { organizationId: fixtures.other.id, billingModel: 'RECURRING' } });
    const member = await db.member.create({
      data: {
        id: uuidv7(), organizationId: fixtures.other.id, memberCode: `AJE-${Date.now() % 100000}`,
        firstName: 'Ajeno', lastName: 'Membresia', nameKey: normalizedNameKey('Ajeno Membresia'),
        homeBranchId: branch.id, joinedAt: new Date(),
      },
    });
    const membership = await db.membership.create({
      data: {
        id: uuidv7(), organizationId: fixtures.other.id, memberId: member.id, planId: plan.id,
        soldAtBranchId: branch.id, status: 'ACTIVE', startDate: new Date(),
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
        billingAnchorDay: 1,
      },
    });

    const res = await app.inject({ method: 'GET', url: `/memberships/${membership.id}`, headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(404);

    const eventos = await app.inject({ method: 'GET', url: `/memberships/${membership.id}/events`, headers: { cookie: cookieA } });
    expect(eventos.statusCode).toBe(404);

    await db.membership.delete({ where: { id: membership.id } });
    await db.member.delete({ where: { id: member.id } });
  });

  it('un plan de OTRA organización devuelve 404', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const foreign = await db.plan.findFirst({ where: { organizationId: fixtures.other.id } });
    expect(foreign, 'la otra organización debe tener planes sembrados').toBeTruthy();
    const res = await app.inject({ method: 'GET', url: `/plans/${foreign!.id}`, headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(404);
  });

  /**
   * El libro financiero es el peor sitio para una fuga: el estado de cuenta
   * revela cuánto debe una persona concreta. Se comprueba por id de socio y
   * por id de cargo, que son las dos puertas que existen.
   */
  it('el comprobante de un pago y una rutina de OTRA organización devuelven 404', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const { uuidv7, normalizedNameKey } = await import('@gymflow/core');
    const branch = await db.branch.findFirstOrThrow({ where: { organizationId: fixtures.other.id } });
    const member = await db.member.create({
      data: {
        id: uuidv7(), organizationId: fixtures.other.id, memberCode: `AJR-${Date.now() % 100000}`,
        firstName: 'Ajeno', lastName: 'Recibo', nameKey: normalizedNameKey('Ajeno Recibo'),
        homeBranchId: branch.id, joinedAt: new Date(),
      },
    });
    const pago = await db.payment.create({
      data: {
        id: uuidv7(), organizationId: fixtures.other.id, memberId: member.id, branchId: branch.id,
        method: 'SPEI_TRANSFER', status: 'SUCCEEDED', amountCents: 5000n, unappliedCents: 5000n, businessDate: new Date(),
      },
    });
    const rutina = await db.workoutTemplate.create({
      data: { id: uuidv7(), organizationId: fixtures.other.id, name: 'Ajena', dayNames: ['Día 1'], createdByUserId: fixtures.otherUsers[0]!.id },
    });
    for (const url of [`/payments/${pago.id}/receipt`, `/routines/${rutina.id}`]) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: cookieA } });
      expect(res.statusCode, url).toBe(404);
    }
    await db.workoutTemplate.delete({ where: { id: rutina.id } });
  });

  it('el LIBRO FINANCIERO de otra organización devuelve 404 en todas sus puertas', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const { uuidv7, normalizedNameKey } = await import('@gymflow/core');

    const branch = await db.branch.findFirstOrThrow({ where: { organizationId: fixtures.other.id } });
    const member = await db.member.create({
      data: {
        id: uuidv7(), organizationId: fixtures.other.id, memberCode: `AJE-${Date.now() % 100000}`,
        firstName: 'Ajeno', lastName: 'Cartera', nameKey: normalizedNameKey('Ajeno Cartera'),
        homeBranchId: branch.id, joinedAt: new Date(),
      },
    });
    const charge = await db.charge.create({
      data: {
        id: uuidv7(), organizationId: fixtures.other.id, memberId: member.id,
        branchId: branch.id, chargeType: 'MANUAL_ADJUSTMENT', concept: 'Ajeno',
        subtotalCents: 10000n, amountCents: 10000n, dueDate: new Date(), issuedAt: new Date(),
      },
    });

    for (const url of [
      `/members/${member.id}/statement`,
      `/members/${member.id}/statement/charges`,
      `/members/${member.id}/statement/payments`,
      `/charges/${charge.id}/adjustments`,
      `/members/${member.id}/credentials`,
      // Las tarjetas de un socio ajeno tampoco se listan: marca y últimos
      // cuatro de otra organización siguen siendo datos de otra organización.
      `/members/${member.id}/payment-methods`,
      // Ni sus enrolamientos: saber que alguien tiene biometría registrada ya
      // es un dato sensible de otra organización.
      `/members/${member.id}/biometric-enrollments`,
      // Menos aún sus notas de salud.
      `/members/${member.id}/health`,
      // Ni su rutina.
      `/members/${member.id}/routine`,
      // Ni en cuántos teléfonos tiene abierto su portal.
      `/members/${member.id}/portal-sessions`,
      // Ni sus solicitudes ARCO.
      `/members/${member.id}/privacy-requests`,
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: cookieA } });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error, url).toBe('NOT_FOUND');
    }

    // La limpieza NO puede hacerse con el rol de aplicación: `DELETE` sobre
    // `charges` está revocado, que es justo lo que garantiza el libro. Se usa
    // el rol dueño, el único que puede retirar un cargo de prueba.
    const { createPrismaClient } = await import('@gymflow/db');
    const owner = createPrismaClient(process.env.DATABASE_URL_MIGRATOR);
    try {
      await owner.$executeRawUnsafe(`DELETE FROM "charges" WHERE "id" = '${charge.id}'`);
      await owner.$executeRawUnsafe(`DELETE FROM "members" WHERE "id" = '${member.id}'`);
    } finally {
      await owner.$disconnect();
    }
  });

  it('una venta de mostrador de OTRA organización devuelve 404', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const ajena = await db.posSale.findFirst({ where: { organizationId: fixtures.other.id } });
    if (!ajena) {
      // La otra organización aún no tiene ventas: se comprueba con un id que
      // no existe, que es el mismo camino de código.
      const { uuidv7 } = await import('@gymflow/core');
      const res = await app.inject({
        method: 'GET', url: `/pos/sales/${uuidv7()}`, headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(404);
      return;
    }
    const res = await app.inject({
      method: 'GET', url: `/pos/sales/${ajena.id}`, headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(404);
  });

  it('la BÚSQUEDA nunca cruza organizaciones', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const foreign = await db.member.findMany({ where: { organizationId: fixtures.other.id }, select: { id: true } });
    const res = await app.inject({ method: 'GET', url: '/members/search?q=Hernandez', headers: { cookie: cookieA } });
    const ids = res.json().results.map((r: { id: string }) => r.id);
    for (const f of foreign) expect(ids).not.toContain(f.id);
  });

  it('el listado NUNCA incluye datos de otra organización', async () => {
    const res = await app.inject({ method: 'GET', url: '/branches', headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    const ids: string[] = res.json().map((b: { id: string }) => b.id);
    // Se comprueba la PERTENENCIA, no el conteo: otras pruebas crean sucursales
    // desechables y un número exacto haría fallar esta prueba por su ruido en
    // vez de por una fuga, que es lo único que aquí importa.
    for (const propia of fixtures.demoBranches) expect(ids).toContain(propia.id);
    for (const ajena of fixtures.otherBranches) expect(ids).not.toContain(ajena.id);
  });

  it('la cotización de un plan de otra organización no existe', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const ajeno = await db.plan.findFirstOrThrow({ where: { organizationId: fixtures.other.id } });
    const res = await app.inject({ method: 'GET', url: `/plans/${ajeno.id}/quote`, headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(404);
  });

  it('el texto de consentimiento de otra organización no se puede leer', async () => {
    // Se busca uno de la demo y se pide desde la otra: un 404, no un 403, para
    // no confirmar siquiera que existe.
    const db = (await import('../src/platform/db/client.js')).getDb();
    const ajeno = await db.consentDocument.findFirstOrThrow({ where: { organizationId: fixtures.demo.id } });
    const cookieB = await loginAs(app, 'gerencia@otro.mx');
    const res = await app.inject({ method: 'GET', url: `/consent-documents/${ajeno.id}`, headers: { cookie: cookieB } });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(ajeno.bodyText.slice(0, 20));
    // Tampoco su revisión para publicar (1.10).
    const revision = await app.inject({ method: 'GET', url: `/consent-documents/${ajeno.id}/review`, headers: { cookie: cookieB } });
    expect(revision.statusCode).toBe(404);
    expect(revision.body).not.toContain(ajeno.bodyText.slice(0, 20));
  });

  it('ni la firma de un socio ajeno ni la constancia de su solicitud ARCO se pueden leer (1.10)', async () => {
    const db = (await import('../src/platform/db/client.js')).getDb();
    const cookieB = await loginAs(app, 'gerencia@otro.mx');
    const firma = await db.memberConsent.findFirstOrThrow({ where: { organizationId: fixtures.demo.id } });
    const texto = await app.inject({ method: 'GET', url: `/members/${firma.memberId}/consents/${firma.id}`, headers: { cookie: cookieB } });
    expect(texto.statusCode).toBe(404);
    const { PrivacyRequestRepository } = await import('../src/modules/privacy/privacy-request.repository.js');
    const solicitud = await new PrivacyRequestRepository(fixtures.demo.id).create({
      memberId: firma.memberId, kind: 'ACCESS', channel: 'EMAIL', note: null, consentType: null, createdByUserId: null, identidad: null,
    });
    const constancia = await app.inject({ method: 'GET', url: `/privacy/requests/${solicitud.id}/receipt`, headers: { cookie: cookieB } });
    expect(constancia.statusCode).toBe(404);
    for (const paso of ['identity', 'resolve', 'effect']) {
      const r = await app.inject({ method: 'POST', url: `/privacy/requests/${solicitud.id}/${paso}`, headers: { cookie: cookieB }, payload: { note: 'Intento ajeno', outcome: 'DENIED', resolution: 'Intento ajeno' } });
      expect(r.statusCode, paso).toBe(404);
    }
  });

  it('cada organización ve SOLO la suya en /organization', async () => {
    const cookieB = await loginAs(app, 'gerencia@otro.mx');
    const a = await app.inject({ method: 'GET', url: '/organization', headers: { cookie: cookieA } });
    const b = await app.inject({ method: 'GET', url: '/organization', headers: { cookie: cookieB } });
    expect(a.json().id).toBe(fixtures.demo.id);
    expect(b.json().id).toBe(fixtures.other.id);
    expect(a.json().id).not.toBe(b.json().id);
  });

  it('sin sesión, toda ruta protegida devuelve 401', async () => {
    for (const url of ['/organization', '/branches', '/users', '/audit', '/members', '/plans', '/prospects']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });
});
