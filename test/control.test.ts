import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, CONSENTIMIENTOS, PASSWORD, aprobacion, correoUnico, loginPlataforma, asignarAlCoach } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * BLOQUE 9 · control para la dueña: cada autorización con su sucursal, el
 * coach sin datos de dinero y la invitación al portal con alcance de sede.
 */
describe('control: alcance por sucursal y datos de dinero', () => {
  let app: FastifyInstance;
  let owner: string;
  let gerente: string;
  let recepcion: string;
  let coach: string;
  let orgId: string;
  let centro: string;
  let ajena: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    [owner, gerente, recepcion, coach] = await Promise.all(
      ['gerencia@demo.mx', 'gerente@demo.mx', 'recepcion@demo.mx', 'coach@demo.mx'].map((e) => loginAs(app, e)),
    ) as [string, string, string, string];
    const f = await orgFixtures();
    orgId = f.demo.id;
    const db = getDb();
    const sedes = (await db.roleAssignment.findMany({
      where: { user: { email: { in: ['recepcion@demo.mx', 'gerente@demo.mx'] } }, revokedAt: null }, select: { branchId: true },
    })).map((a) => a.branchId);
    centro = (await db.roleAssignment.findFirstOrThrow({ where: { user: { email: 'recepcion@demo.mx' }, revokedAt: null } })).branchId!;
    ajena = f.demoBranches.find((b) => !sedes.includes(b.id))!.id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  async function socioEn(homeBranchId: string) {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: owner },
      payload: { firstName: nombreUnico('Ctl'), lastName: nombreUnico('Sede'), homeBranchId, force: true, consents: CONSENTIMIENTOS },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  it('recepción no crea planes: el catálogo es de la gerencia (SEC2-04, ADR-039)', async () => {
    const base = await getDb().plan.findFirstOrThrow({ where: { organizationId: orgId, billingModel: 'RECURRING' } });
    const r = await app.inject({
      method: 'POST', url: '/plans', headers: { cookie: recepcion },
      payload: {
        code: `G${Date.now() % 1e6}`, name: 'Plan de recepción', billingModel: 'RECURRING',
        durationUnit: base.durationUnit, durationValue: base.durationValue, priceCents: '50000', reason: 'Promoción de su sede',
      },
    });
    expect(r.statusCode, r.body).toBe(403);
  });

  it('el coach no cambia el precio de la clase suelta; la dueña sí, con motivo (SEC2-03)', async () => {
    const tipo = await app.inject({ method: 'POST', url: '/classes/types', headers: { cookie: owner }, payload: { name: nombreUnico('Precio'), dropInPriceCents: '10000' } });
    expect(tipo.statusCode, tipo.body).toBe(201);
    const id = tipo.json().id;
    expect((await app.inject({ method: 'PATCH', url: `/classes/types/${id}`, headers: { cookie: coach }, payload: { dropInPriceCents: '1' } })).statusCode).toBe(403);
    // El nombre y el cupo sí son suyos.
    expect((await app.inject({ method: 'PATCH', url: `/classes/types/${id}`, headers: { cookie: coach }, payload: { defaultCapacity: 15 } })).statusCode).toBe(200);
    // Crear una clase con precio también es fijar un precio.
    expect((await app.inject({ method: 'POST', url: '/classes/types', headers: { cookie: coach }, payload: { name: nombreUnico('Coach'), dropInPriceCents: '1' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/classes/types/${id}`, headers: { cookie: owner }, payload: { dropInPriceCents: '12000' } })).statusCode).toBe(422);
    const ok = await app.inject({ method: 'PATCH', url: `/classes/types/${id}`, headers: { cookie: owner }, payload: { dropInPriceCents: '12000', reason: 'Ajuste anual' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await getDb().auditLog.count({ where: { action: 'class.type.price', resourceId: id } })).toBe(1);
  });

  it('el coach no ve saldos, deudores ni teléfonos (SEC2-06)', async () => {
    expect((await app.inject({ method: 'GET', url: '/members?withDebt=true', headers: { cookie: coach } })).statusCode).toBe(403);
    // Ve solo a sus socios asignados (2026-10-09): y de ellos, nada de dinero ni contacto.
    const id = await socioEn(centro);
    await asignarAlCoach(id);
    const lista = (await app.inject({ method: 'GET', url: '/members?status=ACTIVE&limit=20', headers: { cookie: coach } })).json();
    expect(lista.members.length).toBeGreaterThan(0);
    for (const m of lista.members) {
      expect(m.balanceCents).toBeNull();
      expect(m.phoneE164).toBeNull();
      expect(m.email).toBeNull();
    }
    // Recepción sí ve el saldo de los socios de su sede.
    expect((await app.inject({ method: 'GET', url: `/members/${id}`, headers: { cookie: recepcion } })).json().balanceCents).toBe('0');
    expect((await app.inject({ method: 'GET', url: `/members/${id}`, headers: { cookie: coach } })).json().balanceCents).toBeNull();
  });

  it('recepción no invita al portal a un socio de otra sede, y el portal no exporta la salud (SEC2-01)', async () => {
    const otro = await socioEn(ajena);
    expect((await app.inject({ method: 'POST', url: `/members/${otro}/portal-invite`, headers: { cookie: recepcion } })).statusCode).toBe(403);

    const { MemberRepository } = await import('../src/modules/members/index.js');
    const u = await getDb().user.findFirstOrThrow({ where: { email: 'gerencia@demo.mx' } });
    const conSalud = await new MemberRepository(orgId).create({
      firstName: nombreUnico('Ctl'), lastName: nombreUnico('Salud'), homeBranchId: centro, createdByUserId: u.id, healthNotes: 'Asma controlada',
    }, 'CEN');
    const invite = await app.inject({ method: 'POST', url: `/members/${conSalud.id}/portal-invite`, headers: { cookie: recepcion } });
    expect(invite.statusCode, invite.body).toBe(201);
    const enroll = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code } });
    const portal = `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}`;
    const datos = (await app.inject({ method: 'GET', url: '/portal/me/export', headers: { cookie: portal } })).json();
    expect(JSON.stringify(datos)).not.toContain('Asma');
    expect(datos.notaSalud).toBeTruthy();
  });

  // ── Dos firmas: atadas a la operación y con topes ─────────────────────────

  async function socioArchivado() {
    const id = await socioEn(centro);
    await app.inject({ method: 'POST', url: `/members/${id}/archive`, headers: { cookie: owner }, payload: { reason: 'Pidió su baja' } });
    return id;
  }

  it('una firma vale para ESA operación; solo el dueño firma (SEC2-05, 2026-10-05)', async () => {
    const a = await socioArchivado();
    const b = await socioArchivado();
    // Firmada para A, usada en B: no sirve.
    const token = await aprobacion(app, gerente, 'members:anonymize', 'owner@demo.mx', centro, { resourceId: a });
    const otra = await app.inject({ method: 'POST', url: `/members/${b}/anonymize`, headers: { cookie: gerente }, payload: { reason: 'Solicitud ARCO', approvalToken: token } });
    expect(otra.statusCode, otra.body).toBe(422);
    // Sin decir para qué, tampoco.
    const suelta = await aprobacion(app, gerente, 'members:anonymize', 'owner@demo.mx', centro);
    expect((await app.inject({ method: 'POST', url: `/members/${a}/anonymize`, headers: { cookie: gerente }, payload: { reason: 'Solicitud ARCO', approvalToken: suelta } })).statusCode).toBe(422);
    // Firmada para A y usada en A: pasa. La bitácora dirá quién la firmó
    // (lo comprueba la prueba de la pantalla de bitácora, más abajo).
    const buena = await aprobacion(app, gerente, 'members:anonymize', 'owner@demo.mx', centro, { resourceId: a });
    const hecha = await app.inject({ method: 'POST', url: `/members/${a}/anonymize`, headers: { cookie: gerente }, payload: { reason: 'Solicitud ARCO', approvalToken: buena } });
    expect(hecha.statusCode, hecha.body).toBe(204);
    // Recepción no firma nada.
    const r = await app.inject({
      method: 'POST', url: '/approvals', headers: { cookie: gerente },
      payload: { email: 'recepcion@demo.mx', password: PASSWORD, permission: 'cash:withdraw', branchId: centro, resourceId: uuidv7(), amountCents: '600000' },
    });
    expect(r.statusCode, r.body).toBe(403);
    // El diálogo sabe de antemano quién puede firmar: el dueño, y nadie más (2026-10-05).
    const quienes = (await app.inject({ method: 'GET', url: `/approvals/approvers?permission=cash:withdraw&branchId=${centro}&amountCents=600000`, headers: { cookie: gerente } })).json();
    const duena = await getDb().user.findFirstOrThrow({ where: { email: 'owner@demo.mx' } });
    expect(quienes.approvers.map((x: { fullName: string }) => x.fullName)).toEqual([duena.fullName]);
  });

  it('una firma consumida en una operación que se deshace NO queda gastada (EST-02)', async () => {
    const { ApprovalService } = await import('../src/modules/approvals/index.js');
    const { enUnaTransaccion } = await import('../src/platform/db/unit-of-work.js');
    const { buildTenant } = await import('../src/platform/context.js');
    const quienPide = await getDb().user.findFirstOrThrow({ where: { email: 'gerente@demo.mx' } });
    const ctx = {
      requestId: uuidv7(), tenant: buildTenant({
        organizationId: orgId, actorUserId: quienPide.id, sessionId: uuidv7(), grants: [], limits: null, branchScopeHint: null, requestId: uuidv7(),
      }),
    } as never;
    const recurso = uuidv7();
    const token = await aprobacion(app, gerente, 'members:anonymize', 'owner@demo.mx', centro, { resourceId: recurso });
    const firmas = new ApprovalService();
    const consumir = () => firmas.verify(ctx, token, 'members:anonymize', { resourceId: recurso, branchId: centro });

    // La operación consume la firma y luego falla: se deshace todo, la firma también.
    await expect(enUnaTransaccion(async () => {
      expect(await consumir()).toBeTruthy();
      throw new Error('la operación falló después de consumir la firma');
    })).rejects.toThrow('la operación falló');
    // Sigue valiendo para repetir la MISMA operación…
    expect(await enUnaTransaccion(consumir)).toBeTruthy();
    // …y una vez que la operación sí se confirma, es de un solo uso.
    await expect(consumir()).rejects.toThrow(/ya se usó/);
  });

  it('a quien le restablecieron la contraseña no firma: la cambia y espera 24 h (SEC2-08)', async () => {
    const db = getDb();
    // Una corrida cortada a medias dejaba al firmante de la vez anterior activo
    // (se desactivaba solo al final): se apaga antes de crear el de hoy, y el de
    // hoy se apaga en `finally`, pase lo que pase.
    await db.user.updateMany({ where: { organizationId: orgId, fullName: 'Firmante Nuevo', isActive: true }, data: { isActive: false } });
    // Un segundo dueño (socio del gimnasio): es quien firma. A un dueño lo da
    // de alta la plataforma, no la gerencia.
    const plataforma = await loginPlataforma(app);
    const correo = correoUnico('firma');
    const crear = await app.inject({
      method: 'POST', url: `/platform/organizations/${orgId}/users`, headers: { cookie: plataforma },
      payload: { fullName: 'Firmante Nuevo', email: correo, roleKey: 'OWNER', branchIds: null, reason: 'Alta de socio del gimnasio' },
    });
    expect(crear.statusCode, crear.body).toBe(201);
    const user = { id: crear.json().userId as string, email: correo };
    try {
      const temporaryPassword = crear.json().password as string;
      const cookie = await (async () => {
        const l = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: temporaryPassword } });
        return `gf_session=${l.cookies.find((c) => c.name === 'gf_session')!.value}`;
      })();
      expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json().mustChangePassword).toBe(true);
      const firmar = (password: string) => app.inject({
        method: 'POST', url: '/approvals', headers: { cookie: recepcion },
        payload: { email: user.email, password, permission: 'cash:withdraw', branchId: centro, resourceId: uuidv7(), amountCents: '100' },
      });
      expect((await firmar(temporaryPassword)).json().detail).toMatch(/temporal/);
      expect((await app.inject({ method: 'POST', url: '/auth/password', headers: { cookie }, payload: { current: temporaryPassword, next: 'Otra-Clave-Segura-2026' } })).statusCode).toBe(200);
      expect((await firmar('Otra-Clave-Segura-2026')).json().detail).toMatch(/24 horas/);
      await db.user.update({ where: { id: user.id }, data: { passwordResetAt: new Date(Date.now() - 25 * 3_600_000) } });
      expect((await firmar('Otra-Clave-Segura-2026')).statusCode).toBe(200);
    } finally {
      await db.user.update({ where: { id: user.id }, data: { isActive: false } });
    }
  });
});

describe('bitácora en la misma transacción (OPT2-14)', () => {
  it('si la bitácora no se puede escribir, la anulación no ocurre', async () => {
    const { vi } = await import('vitest');
    const { AuditService } = await import('../src/platform/audit/audit.service.js');
    const { BillingService } = await import('../src/modules/billing/index.js');
    const { buildTenant } = await import('../src/platform/context.js');
    const f = await orgFixtures();
    const db = getDb();
    const owner = await db.user.findFirstOrThrow({ where: { email: 'gerencia@demo.mx' } });
    const socio = await db.member.findFirstOrThrow({ where: { organizationId: f.demo.id, status: 'ACTIVE' } });
    const cargo = await db.charge.create({
      data: {
        id: uuidv7(), organizationId: f.demo.id, memberId: socio.id, branchId: f.demoBranches[0]!.id, chargeType: 'MANUAL_ADJUSTMENT', status: 'OPEN',
        concept: 'Cargo de la prueba de bitácora', subtotalCents: 1000n, amountCents: 1000n, dueDate: new Date(), issuedAt: new Date(),
      },
    });
    const ctx = {
      requestId: uuidv7(), tenant: buildTenant({
        organizationId: f.demo.id, actorUserId: owner.id, sessionId: uuidv7(), grants: [], limits: null, branchScopeHint: null, requestId: uuidv7(),
      }),
    } as never;
    const espia = vi.spyOn(AuditService.prototype, 'record').mockRejectedValueOnce(new Error('la bitácora no responde'));
    await expect(new BillingService().voidCharge(ctx, { chargeId: cargo.id, reason: 'Error de captura' })).rejects.toThrow('la bitácora no responde');
    espia.mockRestore();
    expect((await db.charge.findUniqueOrThrow({ where: { id: cargo.id } })).status).toBe('OPEN');
    await new BillingService().voidCharge(ctx, { chargeId: cargo.id, reason: 'Error de captura' });
    expect((await db.charge.findUniqueOrThrow({ where: { id: cargo.id } })).status).toBe('VOID');
    expect(await db.auditLog.count({ where: { action: 'billing.charge.void', resourceId: cargo.id } })).toBe(1);
    await closeDb();
  });
});

describe('pantalla de bitácora (UXB-01)', () => {
  it('dice quién, a quién y quién autorizó; filtra por tipo y por persona, y pagina', async () => {
    const app = await makeApp();
    await app.ready();
    const owner = await loginAs(app, 'gerencia@demo.mx');
    const coach = await loginAs(app, 'coach@demo.mx');
    expect((await app.inject({ method: 'GET', url: '/audit', headers: { cookie: coach } })).statusCode).toBe(403);

    const r = (await app.inject({ method: 'GET', url: '/audit?category=sensibles&limit=5', headers: { cookie: owner } })).json();
    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.entries.every((e: { sensitive: boolean }) => e.sensitive)).toBe(true);
    // La anonimización de la prueba de firmas, arriba: firmada por otra persona.
    const anon = (await app.inject({ method: 'GET', url: '/audit?category=sensibles&limit=200', headers: { cookie: owner } })).json()
      .entries.find((e: { action: string; approverName: string | null }) => e.action === 'member.anonymize' && e.approverName);
    expect(anon?.actorName).toBeTruthy();

    const yo = await getDb().user.findFirstOrThrow({ where: { email: 'gerencia@demo.mx' } });
    const mias = (await app.inject({ method: 'GET', url: `/audit?actorUserId=${yo.id}&limit=3`, headers: { cookie: owner } })).json();
    expect(mias.entries.every((e: { actorUserId: string }) => e.actorUserId === yo.id)).toBe(true);
    const sig = (await app.inject({ method: 'GET', url: `/audit?actorUserId=${yo.id}&limit=3&cursor=${mias.nextCursor}`, headers: { cookie: owner } })).json();
    expect(sig.entries.some((e: { id: string }) => mias.entries.some((m: { id: string }) => m.id === e.id))).toBe(false);

    const socio = (await app.inject({ method: 'GET', url: '/audit?category=socios&limit=50', headers: { cookie: owner } })).json()
      .entries.find((e: { resourceType: string; member: unknown }) => e.resourceType === 'Member' && e.member);
    expect(socio.member.name).toBeTruthy();
    await app.close();
    await closeDb();
  });
});

describe('rendimiento (OPT2-01/02)', () => {
  it('Planes trae disponibilidad y socios vivos en una petición; el monitor pide solo lo nuevo', async () => {
    const app = await makeApp();
    await app.ready();
    const owner = await loginAs(app, 'gerencia@demo.mx');
    const planes = (await app.inject({ method: 'GET', url: '/plans?includeInactive=true&include=details', headers: { cookie: owner } })).json();
    expect(planes.length).toBeGreaterThan(0);
    for (const p of planes) {
      expect(Array.isArray(p.availability)).toBe(true);
      expect(typeof p.liveMemberships).toBe('number');
    }
    const uno = planes[0];
    const detalle = (await app.inject({ method: 'GET', url: `/plans/${uno.id}`, headers: { cookie: owner } })).json();
    expect(detalle.liveMemberships).toBe(uno.liveMemberships);

    const branch = (await orgFixtures()).demoBranches[0]!.id;
    const todo = (await app.inject({ method: 'GET', url: `/access/monitor?branchId=${branch}&limit=5`, headers: { cookie: owner } })).json().decisions;
    if (todo.length > 0) {
      expect(todo.some((d: { memberName: string | null }) => d.memberName)).toBe(true);
      const nuevo = (await app.inject({ method: 'GET', url: `/access/monitor?branchId=${branch}&limit=5&since=${encodeURIComponent(todo[0].at)}`, headers: { cookie: owner } })).json().decisions;
      expect(nuevo.every((d: { at: string }) => d.at > todo[0].at)).toBe(true);
    }
    await app.close();
    await closeDb();
  });
});

describe('autorización a distancia', () => {
  it('la gerente pide la firma, la dueña la aprueba desde su teléfono y la operación pasa con ella', async () => {
    const app = await makeApp();
    await app.ready();
    // `owner` es el dueño de verdad: quien firma desde su teléfono (2026-10-05).
    const [owner, gerente, recepcion, gerencia] = await Promise.all(['owner@demo.mx', 'gerente@demo.mx', 'recepcion@demo.mx', 'gerencia@demo.mx'].map((e) => loginAs(app, e)));
    const centro = (await getDb().roleAssignment.findFirstOrThrow({ where: { user: { email: 'recepcion@demo.mx' }, revokedAt: null } })).branchId!;
    const socio = async () => {
      const r = await app.inject({
        method: 'POST', url: '/members', headers: { cookie: gerencia },
        payload: { firstName: nombreUnico('Remota'), lastName: nombreUnico('Firma'), homeBranchId: centro, force: true, consents: CONSENTIMIENTOS },
      });
      await app.inject({ method: 'POST', url: `/members/${r.json().id}/archive`, headers: { cookie: gerencia }, payload: { reason: 'Pidió su baja' } });
      return r.json().id as string;
    };
    const pedir = (id: string) => app.inject({
      method: 'POST', url: '/approvals/requests', headers: { cookie: gerente },
      payload: { permission: 'members:anonymize', branchId: centro, resourceType: 'Member', resourceId: id, summary: 'Anonimizar a un socio que pidió ARCO' },
    });

    const id = await socio();
    const sol = await pedir(id);
    expect(sol.statusCode, sol.body).toBe(201);
    const solicitud = sol.json().id as string;

    // Le aparece a la dueña; no a recepción, que no puede firmarla.
    expect((await app.inject({ method: 'GET', url: '/approvals/inbox', headers: { cookie: owner } })).json().requests.some((r: { id: string }) => r.id === solicitud)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/approvals/inbox', headers: { cookie: recepcion } })).json().requests.some((r: { id: string }) => r.id === solicitud)).toBe(false);
    // Nadie aprueba lo suyo, ni con una contraseña equivocada.
    expect((await app.inject({ method: 'POST', url: `/approvals/requests/${solicitud}/approve`, headers: { cookie: gerente }, payload: { password: PASSWORD } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/approvals/requests/${solicitud}/approve`, headers: { cookie: owner }, payload: { password: 'mala' } })).statusCode).toBe(401);
    // Solo quien la pidió ve su estado.
    expect((await app.inject({ method: 'GET', url: `/approvals/requests/${solicitud}`, headers: { cookie: owner } })).statusCode).toBe(404);

    const ok = await app.inject({ method: 'POST', url: `/approvals/requests/${solicitud}/approve`, headers: { cookie: owner }, payload: { password: PASSWORD } });
    expect(ok.statusCode, ok.body).toBe(200);
    const estado = (await app.inject({ method: 'GET', url: `/approvals/requests/${solicitud}`, headers: { cookie: gerente } })).json();
    expect(estado.status).toBe('APPROVED');
    expect(estado.approverName).toBeTruthy();
    expect(estado.approvalToken).toBeTruthy();
    // La firma se vuelve a entregar mientras no se use (29-03): si se perdió la
    // respuesta que la traía, la siguiente consulta la trae otra vez.
    expect((await app.inject({ method: 'GET', url: `/approvals/requests/${solicitud}`, headers: { cookie: gerente } })).json().approvalToken).toBe(estado.approvalToken);

    // La firma vale para ESA operación: con otro socio no sirve; con el suyo, sí.
    const otro = await socio();
    expect((await app.inject({ method: 'POST', url: `/members/${otro}/anonymize`, headers: { cookie: gerente }, payload: { reason: 'Solicitud ARCO', approvalToken: estado.approvalToken } })).statusCode).toBe(422);
    // Ya gastada, no se vuelve a entregar y el token deja de guardarse.
    expect((await app.inject({ method: 'GET', url: `/approvals/requests/${solicitud}`, headers: { cookie: gerente } })).json().approvalToken).toBeNull();
    expect((await getDb().approvalRequest.findUniqueOrThrow({ where: { id: solicitud } })).deliveryToken).toBeNull();
    const sol2 = (await pedir(id)).json().id;
    await app.inject({ method: 'POST', url: `/approvals/requests/${sol2}/approve`, headers: { cookie: owner }, payload: { password: PASSWORD } });
    const token2 = (await app.inject({ method: 'GET', url: `/approvals/requests/${sol2}`, headers: { cookie: gerente } })).json().approvalToken;
    const hecha = await app.inject({ method: 'POST', url: `/members/${id}/anonymize`, headers: { cookie: gerente }, payload: { reason: 'Solicitud ARCO', approvalToken: token2 } });
    expect(hecha.statusCode, hecha.body).toBe(204);
    expect(await getDb().auditLog.count({ where: { action: 'approval.remote.approve', resourceId: sol2 } })).toBe(1);

    // Rechazada, con motivo; vencida, ya no se puede aprobar.
    const sol3 = (await pedir(otro)).json().id;
    expect((await app.inject({ method: 'POST', url: `/approvals/requests/${sol3}/reject`, headers: { cookie: owner }, payload: { reason: 'Primero confirma su identificación' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/approvals/requests/${sol3}`, headers: { cookie: gerente } })).json()).toMatchObject({ status: 'REJECTED', rejectReason: 'Primero confirma su identificación' });
    const sol4 = (await pedir(otro)).json().id;
    await getDb().approvalRequest.update({ where: { id: sol4 }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await app.inject({ method: 'POST', url: `/approvals/requests/${sol4}/approve`, headers: { cookie: owner }, payload: { password: PASSWORD } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: `/approvals/requests/${sol4}`, headers: { cookie: gerente } })).json().status).toBe('EXPIRED');
    await app.close();
    await closeDb();
  });
});

describe('la dueña consulta lo administrativo y no opera (ADR-039)', () => {
  it('ve tablero, movimientos, pulso, bitácora, personal, cortes y planes; no ve expedientes ni clases; cualquier cambio le responde 403', async () => {
    const app = await makeApp();
    await app.ready();
    const duena = await loginAs(app, 'owner@demo.mx');
    const f = await orgFixtures();
    const db = getDb();
    const socio = await db.member.findFirstOrThrow({ where: { organizationId: f.demo.id, status: 'ACTIVE', deletedAt: null } });
    const sesion = await db.classSchedule.findFirst({ where: { organizationId: f.demo.id } });
    // Dinero y personal: sí.
    for (const url of ['/dashboard?days=1', '/reports/daily?from=2026-09-01&to=2026-09-30', '/reports/pulse', '/audit?limit=5', '/plans', '/cash-sessions', '/users', '/organization/modules']) {
      const r = await app.inject({ method: 'GET', url, headers: { cookie: duena } });
      expect(r.statusCode, `${url}: ${r.body.slice(0, 120)}`).toBe(200);
    }
    // Expedientes, altas y clases: operación, no administración.
    for (const url of ['/members?limit=5', `/members/${socio.id}`, `/members/${socio.id}/statement`, '/intakes', ...(sesion ? [`/classes/schedules/${sesion.id}/bookings`] : [])]) {
      const r = await app.inject({ method: 'GET', url, headers: { cookie: duena } });
      expect(r.statusCode, `${url}: ${r.body.slice(0, 120)}`).toBe(403);
    }
    const intentos: Array<[string, string, object]> = [
      ['POST', '/members', { firstName: 'No', lastName: 'Debe', homeBranchId: f.demoBranches[0]!.id, force: true }],
      ['PATCH', `/members/${socio.id}`, { firstName: 'Cambio' }],
      ['POST', `/members/${socio.id}/payments`, { method: 'CASH', amountCents: '100', branchId: f.demoBranches[0]!.id }],
      ['POST', '/plans', { code: 'X', name: 'X', reason: 'x' }],
      ['POST', '/users', { email: 'x@demo.mx', fullName: 'Equis Ye', roleKey: 'COACH', branchIds: [], reason: 'xxx' }],
      ['POST', '/expenses', { category: 'RENT', description: 'Renta', amountCents: '100', month: '2026-09', branchId: null }],
      ['POST', '/classes/types', { name: 'Nueva' }],
    ];
    for (const [method, url, payload] of intentos) {
      const r = await app.inject({ method: method as 'POST', url, headers: { cookie: duena }, payload });
      expect(r.statusCode, `${method} ${url}: ${r.body.slice(0, 120)}`).toBe(403);
    }
    // Y es quien firma: su bandeja de autorizaciones responde (2026-10-05).
    expect((await app.inject({ method: 'GET', url: '/approvals/inbox', headers: { cookie: duena } })).statusCode).toBe(200);
    await app.close();
    await closeDb();
  });
});

describe('el pulso de la dueña (UXD-01, UXD-02)', () => {
  it('compara hoy HASTA ESTA HORA con ayer a la misma hora, y solo ve sus sedes', async () => {
    const { sedeDesechable, archivarSede } = await import('./helpers.js');
    const app = await makeApp();
    await app.ready();
    const duena = await loginAs(app, 'owner@demo.mx');
    const recepcion = await loginAs(app, 'recepcion@demo.mx');
    const f = await orgFixtures();
    const db = getDb();
    const sede = await sedeDesechable(f.demo.id, 'Sede del pulso');
    const yo = await db.user.findFirstOrThrow({ where: { email: 'gerencia@demo.mx' } });
    const socio = await db.member.create({
      data: { id: uuidv7(), organizationId: f.demo.id, memberCode: `PUL-${Date.now() % 1e6}`, firstName: nombreUnico('Pulso'), lastName: nombreUnico('Dia'), nameKey: nombreUnico('k'), homeBranchId: sede.id, joinedAt: new Date() },
    });
    const pago = (cents: bigint, at: Date) => db.payment.create({
      data: {
        id: uuidv7(), organizationId: f.demo.id, memberId: socio.id, branchId: sede.id, method: 'SPEI_TRANSFER', status: 'SUCCEEDED',
        amountCents: cents, unappliedCents: 0n, receivedAt: at, businessDate: new Date(at.toISOString().slice(0, 10)), createdByUserId: yo.id, externalRef: 'SPEI-PULSO',
      },
    });
    const ahora = Date.now();
    // "Ayer, después de esta hora" tiene que seguir siendo ayer: en la última
    // hora del día (CDMX) una hora después ya es hoy, y la prueba fallaba a
    // las 23:00. Se usa lo que quepa antes de la medianoche de ayer.
    const partes = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ahora));
    const minutosLocales = Number(partes.find((x) => x.type === 'hour')!.value) * 60 + Number(partes.find((x) => x.type === 'minute')!.value);
    const despues = Math.max(60_000, Math.min(3_600_000, (1440 - minutosLocales - 2) * 60_000));
    await pago(10_000n, new Date(ahora - 60_000));                   // hoy, hace un minuto
    await pago(7_000n, new Date(ahora - 86_400_000 - 60_000));        // ayer, ANTES de esta hora
    await pago(99_000n, new Date(ahora - 86_400_000 + despues));      // ayer, DESPUÉS de esta hora: no cuenta
    const p = (await app.inject({ method: 'GET', url: `/reports/pulse?branchId=${sede.id}`, headers: { cookie: duena } })).json();
    // Cerca de la medianoche local, "hace un minuto" puede caer en ayer: por eso
    // se aceptan esos casos. Lo que NUNCA debe contar es el pago de ayer
    // posterior a esta hora (99,000).
    expect(p.today.collectedCents).toMatch(/^(10000|0)$/);
    expect(['7000', '17000', '0']).toContain(p.today.yesterdaySameTimeCents);
    expect(p.today.yesterdaySameTimeCents).not.toBe('106000');
    expect(p.today.byHour).toHaveLength(24);
    expect(p.month).toHaveProperty('lastMonthSameDayProfitCents');
    expect(p.alerts).toHaveProperty('shortCounts');
    // Monitoreo de personal (ADR-039): su equipo con puesto y actividad, sin la dueña y sin un solo socio.
    const todo = (await app.inject({ method: 'GET', url: '/reports/pulse?fresh=1', headers: { cookie: duena } })).json();
    expect(todo.staff.length).toBeGreaterThan(0);
    expect(todo.staff.map((e: { roleKey: string }) => e.roleKey)).not.toContain('OWNER');
    const recep = todo.staff.find((e: { fullName: string }) => e.fullName === 'Recepción Centro');
    expect(recep).toMatchObject({ roleName: 'Recepción' });
    expect(typeof recep.paymentsToday).toBe('number');
    expect(recep).toHaveProperty('lastActionAt');
    expect((await app.inject({ method: 'GET', url: '/reports/pulse', headers: { cookie: recepcion } })).statusCode).toBe(403);
    await archivarSede(sede.id);
    await app.close();
    await closeDb();
  });
});
