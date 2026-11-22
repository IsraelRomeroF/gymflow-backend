import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auditNeedsReview, hoyEn, uuidv7 } from '@gymflow/core';
import { makeApp, loginAs, loginPlataforma, orgFixtures, cuentaDePrueba, sedeDesechable, archivarSede } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { enUnaTransaccion } from '../src/platform/db/unit-of-work.js';
import { buildTenant, type RequestContext } from '../src/platform/context.js';
import { systemContext } from '../src/platform/jobs/types.js';
import { AuditService } from '../src/platform/audit/audit.service.js';
import { AuditRepository } from '../src/platform/audit/audit.repository.js';
import { PlatformAuditService } from '../src/platform/audit/platform-audit.service.js';
import { PlatformAuditRepository, verifyPlatformChain } from '../src/platform/audit/platform-audit.repository.js';
import { verifyPlatformChainJob } from '../src/platform/audit/audit.jobs.js';

/**
 * Auditoría 8, fase 1, bloque 1.11 · Bitácora: frases con socio e importe
 * desde el núcleo (20-07, 20-10), «Para revisar» redefinido (20-06), filtro
 * Persona con el permiso de la bitácora (20-12), vista por socio, CSV legible
 * (20-09) y la cadena de plataforma (24-19, 23-09).
 */
describe('bitácora (1.11)', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let orgId: string;
  let sede: { id: string; name: string };
  let ctx: RequestContext;
  let actor: { id: string; fullName: string };
  const audit = new AuditService();

  type Asiento = {
    id: string; action: string; phrase: string; sensitive: boolean; reviewReason: string | null; amountCents: string | null; category: string | null;
    member: { name: string; memberId: string; memberCode: string | null } | null; personName: string | null; actorName: string | null; resourceId: string | null;
  };
  const leer = async (consulta: string, cookie = gerencia): Promise<Asiento[]> => {
    const r = await app.inject({ method: 'GET', url: `/audit?${consulta}`, headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().entries as Asiento[];
  };
  const comoUsuario = (userId: string, branchId: string | null = null): RequestContext => ({
    requestId: uuidv7(),
    tenant: buildTenant({ organizationId: orgId, actorUserId: userId, sessionId: uuidv7(), grants: [], limits: null, branchScopeHint: branchId, requestId: uuidv7() }),
  });

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    const f = await orgFixtures();
    orgId = f.demo.id;
    sede = { id: f.demoBranches[0]!.id, name: f.demoBranches[0]!.name };
    const u = await getDb().user.findFirstOrThrow({ where: { email: 'gerencia@demo.mx' }, select: { id: true, fullName: true } });
    actor = u;
    ctx = comoUsuario(u.id);
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  it('20-07 · la frase dice a quién y cuánto: el socio sale de su pago, de su membresía o del estado del asiento', async () => {
    const db = getDb();
    const pago = await db.payment.findFirstOrThrow({ where: { organizationId: orgId }, select: { id: true, memberId: true } });
    const socio = await db.member.findUniqueOrThrow({ where: { id: pago.memberId }, select: { id: true, firstName: true, lastName: true, memberCode: true } });
    const nombre = `${socio.firstName} ${socio.lastName}`.trim();
    const invitacion = uuidv7();
    const venta = uuidv7();
    await audit.record(ctx, { action: 'payments.record', resourceType: 'payment', resourceId: pago.id, branchId: sede.id, afterState: { amountCents: '65000', method: 'CASH' } });
    await audit.record(ctx, { action: 'portal.invite.issue', resourceType: 'portal_invite', resourceId: invitacion, branchId: sede.id, afterState: { memberId: socio.id } });
    await audit.record(ctx, { action: 'pos.sale.create', resourceType: 'pos_sale', resourceId: venta, branchId: sede.id, afterState: { totalCents: '8500', folio: 'P-1', lines: 2 } });
    await audit.record(ctx, { action: 'member.update', resourceType: 'Member', resourceId: socio.id, branchId: sede.id, afterState: { phone: 'cambió' } });

    const cobro = (await leer(`resourceId=${pago.id}&limit=5`)).find((e) => e.action === 'payments.record')!;
    expect(cobro.phrase).toBe(`registró un cobro de $650.00 a ${nombre}`);
    expect(cobro.member).toEqual({ name: nombre, memberId: socio.id, memberCode: socio.memberCode });
    expect(cobro.amountCents).toBe('65000');
    expect(cobro.category).toBe('dinero');
    expect(cobro.actorName).toBe(actor.fullName);

    const [invito] = await leer(`resourceId=${invitacion}&limit=5`);
    expect(invito!.phrase).toBe(`invitó a ${nombre} al portal`);
    expect(invito!.member?.memberId).toBe(socio.id);

    const [vendio] = await leer(`resourceId=${venta}&limit=5`);
    expect(vendio!.phrase).toBe('registró una venta de mostrador de $85.00');
    expect(vendio!.member).toBeNull();
    expect(vendio!.sensitive).toBe(false);

    const edito = (await leer(`resourceId=${socio.id}&limit=20`)).find((e) => e.action === 'member.update')!;
    expect(edito.phrase).toBe(`editó los datos de ${nombre}`);
  });

  it('20-07 · lo que se hace sobre alguien del personal dice sobre quién', async () => {
    const otra = await getDb().user.findFirstOrThrow({ where: { organizationId: orgId, email: 'coach@demo.mx' }, select: { id: true, fullName: true } });
    await audit.record(ctx, { action: 'staff.role', resourceType: 'User', resourceId: otra.id, reason: 'Cambio de puesto de la prueba', afterState: { role: 'COACH' } });
    const e = (await leer(`resourceId=${otra.id}&limit=20`)).find((x) => x.action === 'staff.role')!;
    expect(e.phrase).toBe(`cambió el puesto de ${otra.fullName}`);
    expect(e.personName).toBe(otra.fullName);
    expect(e.sensitive).toBe(true);
  });

  it('20-06 · «Para revisar»: el corte solo con diferencia, el descuento solo si pidió firma, la venta solo con fecha anterior', async () => {
    const id = () => uuidv7();
    const cuadrado = id(); const conFaltante = id(); const descuentoSolo = id(); const descuentoFirmado = id(); const ventaHoy = id(); const ventaAtras = id();
    const cierre = (resourceId: string, varianceCents: string) => audit.record(ctx, {
      action: 'cash.session.close', resourceType: 'cash_session', resourceId, branchId: sede.id, reason: varianceCents === '0' ? null : 'Faltó un billete',
      afterState: { expectedCashCents: '100000', countedCashCents: '100000', varianceCents },
    });
    await cierre(cuadrado, '0');
    await cierre(conFaltante, '-5000');
    const descuento = (resourceId: string, approvedByUserId: string | null) => audit.record(ctx, {
      action: 'billing.discount.apply', resourceType: 'charge', resourceId, branchId: sede.id, reason: 'Promoción de la prueba', approvedByUserId,
      beforeState: { adjustedCents: '0' }, afterState: { adjustedCents: '-6500', reasonCode: 'PROMO' },
    });
    await descuento(descuentoSolo, null);
    await descuento(descuentoFirmado, actor.id);
    await audit.record(ctx, { action: 'membership.sale', resourceType: 'Membership', resourceId: ventaHoy, branchId: sede.id, afterState: { totalCents: '65000', paid: true } });
    await audit.record(ctx, { action: 'membership.sale', resourceType: 'Membership', resourceId: ventaAtras, branchId: sede.id, afterState: { totalCents: '65000', paid: true, backdated: true } });

    const enRevisar = async (resourceId: string) => (await leer(`category=sensibles&resourceId=${resourceId}&limit=5`)).length;
    expect(await enRevisar(cuadrado)).toBe(0);
    expect(await enRevisar(conFaltante)).toBe(1);
    expect(await enRevisar(descuentoSolo)).toBe(0);
    expect(await enRevisar(descuentoFirmado)).toBe(1);
    expect(await enRevisar(ventaHoy)).toBe(0);
    expect(await enRevisar(ventaAtras)).toBe(1);

    const [faltante] = await leer(`resourceId=${conFaltante}&limit=5`);
    expect(faltante).toMatchObject({ phrase: 'hizo el corte de caja con un faltante de $50.00', sensitive: true, reviewReason: 'El corte tuvo diferencia' });
    const [sinDiferencia] = await leer(`resourceId=${cuadrado}&limit=5`);
    expect(sinDiferencia).toMatchObject({ phrase: 'hizo el corte de caja, sin diferencia', sensitive: false, reviewReason: null });
    const [firmado] = await leer(`resourceId=${descuentoFirmado}&limit=5`);
    expect(firmado).toMatchObject({ phrase: 'aplicó un descuento de $65.00', sensitive: true, reviewReason: 'El descuento pasó del tope y pidió firma', amountCents: '6500' });
  });

  it('20-06 · la consulta de «Para revisar» y la regla del núcleo dicen lo mismo sobre toda la bitácora del gimnasio', async () => {
    const repo = new AuditRepository();
    const todo = await repo.list(orgId, { limit: 100_000 });
    const revisar = await repo.list(orgId, { review: true, limit: 100_000 });
    expect(todo.length).toBeGreaterThan(20);
    const segunElNucleo = todo.filter((e) => auditNeedsReview(e)).map((e) => e.id);
    expect(revisar.map((e) => e.id)).toEqual(segunElNucleo);
    // Y la lista ya no trae cortes cuadrados ni entradas por excepción sueltas.
    expect(revisar.some((e) => e.action.startsWith('access.manual_'))).toBe(false);
    expect(revisar.filter((e) => e.action === 'cash.session.close').every((e) => (e.afterState as { varianceCents?: string }).varianceCents !== '0')).toBe(true);
  });

  it('20-06 · las entradas por excepción se resumen por persona, día y sede, con el tope del puesto', async () => {
    const db = getDb();
    const correo = await cuentaDePrueba(orgId, 'RECEPTION', [sede.id]);
    const recepcion = await db.user.findFirstOrThrow({ where: { email: correo }, select: { id: true, fullName: true } });
    const comoRecepcion = comoUsuario(recepcion.id, sede.id);
    const dejarPasar = (n: number) => Promise.all(Array.from({ length: n }, () => Promise.resolve())).then(async () => {
      for (let i = 0; i < n; i++) {
        await audit.record(comoRecepcion, { action: 'access.manual_entry', resourceType: 'access_decision', resourceId: uuidv7(), branchId: sede.id, reason: 'Sin biometría todavía', afterState: { outcome: 'GRANTED' } });
      }
    });
    const zona = (await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { timezone: true } })).timezone;
    const zonaSede = (await db.branch.findUniqueOrThrow({ where: { id: sede.id }, select: { timezone: true } })).timezone ?? zona;
    const hoy = hoyEn(zonaSede);
    const resumen = async () => {
      const r = await app.inject({ method: 'GET', url: `/audit/exceptions?from=${hoy}&to=${hoy}&actorUserId=${recepcion.id}`, headers: { cookie: gerencia } });
      expect(r.statusCode, r.body).toBe(200);
      return r.json().summary as Array<{ date: string; actorUserId: string; actorName: string; branchId: string; count: number; limit: number | null; overLimit: boolean }>;
    };

    await dejarPasar(3);
    const tres = await resumen();
    expect(tres).toHaveLength(1);
    // Recepción tiene tope de 10 por turno (roles del núcleo).
    expect(tres[0]).toMatchObject({ date: hoy, actorUserId: recepcion.id, actorName: recepcion.fullName, branchId: sede.id, count: 3, limit: 10, overLimit: false });

    await dejarPasar(8);
    expect((await resumen())[0]).toMatchObject({ count: 11, limit: 10, overLimit: true });

    // Ninguna de las once aparece suelta en «Para revisar», y todas siguen en Acceso.
    expect((await leer(`category=sensibles&actorUserId=${recepcion.id}&limit=50`)).length).toBe(0);
    const enAcceso = await leer(`category=acceso&actorUserId=${recepcion.id}&limit=50`);
    expect(enAcceso).toHaveLength(11);
    expect(enAcceso.every((e) => !e.sensitive)).toBe(true);

    const coach = await loginAs(app, 'coach@demo.mx');
    expect((await app.inject({ method: 'GET', url: '/audit/exceptions', headers: { cookie: coach } })).statusCode).toBe(403);
  });

  it('20-12 · el filtro Persona sale de la bitácora (quién ha escrito), con su permiso y no con el de Personal', async () => {
    const r = await app.inject({ method: 'GET', url: '/audit/actors', headers: { cookie: gerencia } });
    expect(r.statusCode, r.body).toBe(200);
    const actores = r.json().actors as Array<{ id: string; fullName: string; entries: number }>;
    expect(actores.find((a) => a.id === actor.id)).toMatchObject({ fullName: actor.fullName });
    expect(actores.every((a) => a.entries > 0 && a.fullName.length > 0)).toBe(true);
    expect([...actores].map((a) => a.fullName)).toEqual([...actores].map((a) => a.fullName).sort((a, b) => a.localeCompare(b, 'es')));
    // Con periodo: solo quien escribió en él.
    const viejo = (await app.inject({ method: 'GET', url: '/audit/actors?from=2001-01-01&to=2001-01-31', headers: { cookie: gerencia } })).json().actors;
    expect(viejo).toEqual([]);
    const coach = await loginAs(app, 'coach@demo.mx');
    expect((await app.inject({ method: 'GET', url: '/audit/actors', headers: { cookie: coach } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/audit/actors?from=ayer', headers: { cookie: gerencia } })).statusCode).toBe(422);
  });

  it('vista por socio · «todo lo de este socio» junta lo asentado sobre él, sobre sus pagos y lo que lo nombra en el estado', async () => {
    const db = getDb();
    const pago = await db.payment.findFirstOrThrow({ where: { organizationId: orgId }, select: { id: true, memberId: true } });
    const otroPago = await db.payment.findFirstOrThrow({ where: { organizationId: orgId, memberId: { not: pago.memberId } }, select: { id: true, memberId: true } });
    const marca = `Motivo de la vista por socio ${uuidv7()}`;
    await audit.record(ctx, { action: 'payments.reverse', resourceType: 'payment', resourceId: pago.id, branchId: sede.id, reason: marca, afterState: { amountCents: '-10000' } });
    await audit.record(ctx, { action: 'access.manual_entry', resourceType: 'access_decision', resourceId: uuidv7(), branchId: sede.id, reason: marca, afterState: { memberId: pago.memberId, outcome: 'GRANTED' } });
    await audit.record(ctx, { action: 'member.update', resourceType: 'Member', resourceId: pago.memberId, branchId: sede.id, reason: marca, afterState: { email: 'cambió' } });
    await audit.record(ctx, { action: 'payments.reverse', resourceType: 'payment', resourceId: otroPago.id, branchId: sede.id, reason: marca, afterState: { amountCents: '-20000' } });

    const r = await app.inject({ method: 'GET', url: `/audit?memberId=${pago.memberId}&limit=200`, headers: { cookie: gerencia } });
    expect(r.statusCode, r.body).toBe(200);
    const suyos = (r.json().entries as Array<Asiento & { reason: string | null }>);
    const deLaPrueba = suyos.filter((e) => e.reason === marca);
    expect(deLaPrueba.map((e) => e.action).sort()).toEqual(['access.manual_entry', 'member.update', 'payments.reverse']);
    // Nada de otro socio se cuela.
    expect(suyos.every((e) => e.member === null || e.member.memberId === pago.memberId)).toBe(true);
    expect(suyos.some((e) => e.resourceId === otroPago.id)).toBe(false);
    // Se combina con las categorías.
    const dinero = (await leer(`memberId=${pago.memberId}&category=dinero&limit=200`));
    expect(dinero.every((e) => e.category === 'dinero')).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/audit?memberId=no-es-un-id', headers: { cookie: gerencia } })).statusCode).toBe(422);
  });

  it('20-09 · el CSV se lee sin ingeniería: sucursal por nombre, hora en la zona de la sucursal, socio, importe y fórmulas neutralizadas', async () => {
    const db = getDb();
    const tijuana = await sedeDesechable(orgId, 'Sede Frontera de la prueba');
    await db.branch.update({ where: { id: tijuana.id }, data: { timezone: 'America/Tijuana' } });
    try {
      const pago = await db.payment.findFirstOrThrow({ where: { organizationId: orgId }, select: { id: true, memberId: true } });
      const socio = await db.member.findUniqueOrThrow({ where: { id: pago.memberId }, select: { firstName: true, lastName: true, memberCode: true } });
      const motivo = `=HYPERLINK("http://x") ${uuidv7()}`;
      const { id } = await audit.record(ctx, { action: 'payments.reverse', resourceType: 'payment', resourceId: pago.id, branchId: tijuana.id, reason: motivo, afterState: { amountCents: '-12345' } });
      const asiento = await db.auditLog.findUniqueOrThrow({ where: { id }, select: { at: true } });

      const r = await app.inject({ method: 'GET', url: `/audit/export.csv?reason=Para%20el%20contador&category=dinero&branchId=${tijuana.id}`, headers: { cookie: gerencia } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.headers['content-type']).toContain('text/csv');
      const lineas = (r.body.charCodeAt(0) === 0xfeff ? r.body.slice(1) : r.body).split('\r\n');
      const celdas = (l: string) => [...l.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((m) => m[1]!.replace(/""/g, '"'));
      const cabecera = celdas(lineas[0]!);
      expect(cabecera).toEqual(['Fecha', 'Hora', 'Quién', 'Qué hizo', 'Socio', 'No. de socio', 'Importe', 'Para revisar', 'Autorizó', 'Sucursal', 'Motivo', 'Motivo (clave)',
        'Categoría', 'Clave de la acción', 'Recurso', 'Id del recurso', 'Zona horaria', 'Fecha y hora (UTC)']);
      const fila = lineas.slice(1).map(celdas).find((c) => c[cabecera.indexOf('Fecha y hora (UTC)')] === asiento.at.toISOString())!;
      const col = (n: string) => fila[cabecera.indexOf(n)]!;
      const local = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/Tijuana', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).formatToParts(asiento.at).map((x) => [x.type, x.value]));
      expect(col('Fecha')).toBe(`${local.day}/${local.month}/${local.year}`);
      expect(col('Hora')).toBe(`${local.hour}:${local.minute}:${local.second}`);
      expect(col('Zona horaria')).toBe('America/Tijuana');
      expect(col('Sucursal')).toBe('Sede Frontera de la prueba');
      expect(col('Sucursal')).not.toMatch(/^[0-9a-f-]{36}$/);
      const nombre = `${socio.firstName} ${socio.lastName}`.trim();
      expect(col('Qué hizo')).toBe(`revirtió un pago de $123.45 de ${nombre}`);
      expect(col('Socio')).toBe(nombre);
      expect(col('No. de socio')).toBe(socio.memberCode ?? '');
      expect(col('Importe')).toBe('$123.45');
      expect(col('Para revisar')).toBe('Sí');
      expect(col('Categoría')).toBe('Dinero');
      expect(col('Quién')).toBe(actor.fullName);
      // Una celda que empieza con «=» no llega a Excel como fórmula.
      expect(col('Motivo')).toBe(`'${motivo}`);
      // La exportación queda asentada.
      const exportacion = (await leer(`actorUserId=${actor.id}&limit=5`)).find((e) => e.action === 'audit.export');
      expect(exportacion?.phrase).toBe('exportó la bitácora');
    } finally {
      await archivarSede(tijuana.id);
    }
  });

  it('20-09 · el día del filtro es el del gimnasio: lo de hoy entra en «hoy» y no en «ayer»', async () => {
    const zona = (await getDb().organization.findUniqueOrThrow({ where: { id: orgId }, select: { timezone: true } })).timezone;
    const recurso = uuidv7();
    await audit.record(ctx, { action: 'cash.withdraw', resourceType: 'cash_movement', resourceId: recurso, reason: 'Retiro de la prueba del día', afterState: { amountCents: '-1000' } });
    const hoy = hoyEn(zona);
    const ayer = hoyEn(zona, new Date(Date.now() - 86_400_000));
    expect((await leer(`resourceId=${recurso}&from=${hoy}&to=${hoy}`)).length).toBe(1);
    expect((await leer(`resourceId=${recurso}&from=${ayer}&to=${ayer}`)).length).toBe(0);
  });
});

describe('cadena de plataforma (1.11 · 24-19, 23-09)', () => {
  let app: FastifyInstance;
  let plataforma: string;
  let cuenta: { id: string; fullName: string };
  let orgId: string;
  let tradeName: string;
  const audit = new AuditService();
  const cadena = new PlatformAuditService();

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    plataforma = await loginPlataforma(app);
    const me = (await app.inject({ method: 'GET', url: '/platform/me', headers: { cookie: plataforma } })).json() as { userId: string; fullName: string };
    cuenta = { id: me.userId, fullName: me.fullName };
    const f = await orgFixtures();
    orgId = f.demo.id;
    tradeName = f.demo.tradeName;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  it('lo que GymFlow hace sobre una marca deja su espejo, enlazado con el asiento de la marca', async () => {
    const motivo = `Corrección de la prueba ${uuidv7()}`;
    const deLaMarca = await audit.record(systemContext(orgId), {
      action: 'platform.organization.update', resourceType: 'Organization', resourceId: orgId, reason: motivo, afterState: { billingEmail: 'cobro@demo.mx', byPlatformUserId: cuenta.id },
    });
    const espejo = await getDb().platformAuditLog.findUniqueOrThrow({ where: { organizationAuditId: deLaMarca.id } });
    expect(espejo).toMatchObject({
      action: 'platform.organization.update', organizationId: orgId, actorUserId: cuenta.id, reason: motivo,
      organizationAuditHash: deLaMarca.hash, resourceType: 'Organization', resourceId: orgId,
    });
    expect(espejo.hash).toMatch(/^[0-9a-f]{64}$/);

    const r = await app.inject({ method: 'GET', url: `/platform/audit?organizationId=${orgId}&limit=20`, headers: { cookie: plataforma } });
    expect(r.statusCode, r.body).toBe(200);
    const visto = (r.json().entries as Array<Record<string, unknown>>).find((e) => e.organizationAuditId === deLaMarca.id)!;
    expect(visto).toMatchObject({ phrase: 'GymFlow editó los datos de la marca', actor: cuenta.fullName, tradeName, reason: motivo, organizationId: orgId });
  });

  it('lo que solo pasa en la consola se asienta en la cadena, con quién y desde dónde', async () => {
    const { id } = await cadena.record({ userId: cuenta.id, sessionId: uuidv7(), ip: '10.0.0.7', userAgent: 'prueba', requestId: 'req-1' }, {
      action: 'platform.console.reauth', resourceType: 'User', resourceId: cuenta.id,
    });
    const fila = await getDb().platformAuditLog.findUniqueOrThrow({ where: { id } });
    expect(fila).toMatchObject({ actorUserId: cuenta.id, organizationId: null, organizationAuditId: null, ip: '10.0.0.7' });
    const r = await app.inject({ method: 'GET', url: `/platform/audit?actorUserId=${cuenta.id}&limit=5`, headers: { cookie: plataforma } });
    const visto = (r.json().entries as Array<Record<string, unknown>>).find((e) => e.id === id)!;
    expect(visto).toMatchObject({ phrase: 'reconfirmó su contraseña en la consola', actor: cuenta.fullName, tradeName: null });
    // Solo acciones de plataforma.
    expect(() => cadena.record({ userId: cuenta.id }, { action: 'member.update', resourceType: 'Member' })).toThrow(/platform/);
  });

  it('la lista pagina y solo la ve la plataforma', async () => {
    for (let i = 0; i < 3; i++) await cadena.record({ userId: cuenta.id }, { action: 'platform.console.login', resourceType: 'User', resourceId: cuenta.id });
    const uno = (await app.inject({ method: 'GET', url: `/platform/audit?actorUserId=${cuenta.id}&limit=2`, headers: { cookie: plataforma } })).json();
    expect(uno.entries).toHaveLength(2);
    expect(uno.nextCursor).toBeTruthy();
    const dos = (await app.inject({ method: 'GET', url: `/platform/audit?actorUserId=${cuenta.id}&limit=2&cursor=${uno.nextCursor}`, headers: { cookie: plataforma } })).json();
    expect(dos.entries.some((e: { id: string }) => uno.entries.some((x: { id: string }) => x.id === e.id))).toBe(false);

    const gerencia = await loginAs(app, 'gerencia@demo.mx');
    for (const url of ['/platform/audit', '/platform/audit/verify']) {
      // Para quien no es de la plataforma, la consola no existe (404) o no está autenticado (401).
      expect([401, 403, 404]).toContain((await app.inject({ method: 'GET', url, headers: { cookie: gerencia } })).statusCode);
      expect([401, 404]).toContain((await app.inject({ method: 'GET', url })).statusCode);
    }
  });

  it('el espejo y el asiento de la marca se confirman juntos: si la operación se deshace, no queda ninguno', async () => {
    const motivo = `Se deshace ${uuidv7()}`;
    await expect(enUnaTransaccion(async () => {
      await audit.record(systemContext(orgId), { action: 'platform.service.suspend', resourceType: 'Organization', resourceId: orgId, reason: motivo, afterState: { byPlatformUserId: cuenta.id } });
      throw new Error('la operación falló después de asentar');
    })).rejects.toThrow('la operación falló');
    expect(await getDb().auditLog.count({ where: { reason: motivo } })).toBe(0);
    expect(await getDb().platformAuditLog.count({ where: { reason: motivo } })).toBe(0);
  });

  it('importar lo anterior a la cadena es idempotente y deja todo enlazado; la cadena verifica', { timeout: 120_000 }, async () => {
    const antes = await cadena.verify();
    const { imported } = await cadena.importPrevious();
    expect(imported).toBe(antes.links.previous + antes.links.unmirrored);
    expect((await cadena.importPrevious()).imported).toBe(0);

    const r = await app.inject({ method: 'GET', url: '/platform/audit/verify', headers: { cookie: plataforma } });
    expect(r.statusCode, r.body).toBe(200);
    const v = r.json() as { ok: boolean; entries: number; reason: string | null; links: { linked: number; broken: number; unmirrored: number; previous: number } };
    expect(v).toMatchObject({ ok: true, reason: null, links: { broken: 0, unmirrored: 0, previous: 0 } });
    expect(v.entries).toBeGreaterThan(3);
    // Todo asiento `platform.*` de todas las marcas tiene su espejo.
    const enMarcas = await getDb().auditLog.count({ where: { action: { startsWith: 'platform.' } } });
    expect(v.links.linked).toBe(enMarcas);
    // Lo importado conserva cuándo pasó.
    const importado = await getDb().platformAuditLog.findFirst({ where: { organizationAuditId: { not: null } }, orderBy: { occurredAt: 'asc' } });
    const original = await getDb().auditLog.findUniqueOrThrow({ where: { id: importado!.organizationAuditId! } });
    expect(importado!.occurredAt.toISOString()).toBe(original.at.toISOString());
    expect(importado!.organizationAuditHash).toBe(original.hash);

    // El job de plataforma dice lo mismo.
    const job = await verifyPlatformChainJob();
    expect(job).toMatchObject({ job: 'audit.verify-platform-chain', errors: [], skipped: 0 });
    expect(job.processed).toBe(v.entries);
  });

  it('una fila alterada o un eslabón fuera de lugar se detecta, y la base no deja editar ni borrar', async () => {
    const tramo = await new PlatformAuditRepository().chainPage(null, 50);
    expect(tramo.length).toBeGreaterThan(2);
    expect(verifyPlatformChain(tramo, null).ok).toBe(true);
    const alterado = tramo.map((l, i) => (i === 1 ? { ...l, content: { ...l.content, reason: 'otro motivo' } } : l));
    expect(verifyPlatformChain(alterado, null)).toMatchObject({ ok: false, checked: 1, brokenAtId: tramo[1]!.content.id });
    const sinUno = [tramo[0]!, ...tramo.slice(2)];
    expect(verifyPlatformChain(sinUno, null)).toMatchObject({ ok: false, checked: 1 });

    const db = getDb();
    const id = tramo[0]!.content.id;
    await expect(db.$executeRaw`UPDATE platform_audit_logs SET reason = 'editado' WHERE id = ${id}::uuid`).rejects.toThrow();
    await expect(db.$executeRaw`DELETE FROM platform_audit_logs WHERE id = ${id}::uuid`).rejects.toThrow();
    expect((await cadena.verifyChain()).ok).toBe(true);
  });
});
