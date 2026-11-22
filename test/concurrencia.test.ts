import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, PASSWORD, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { abrirTurno, cargoPropio, gimnasioPropio, sesionesDe, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';

/**
 * DOS A LA VEZ (bloque 1.17b; 28-19: «sin prueba de concurrencia»).
 *
 * `dinero-concurrencia.test.ts` (1.3) prueba la carga: treinta operaciones de
 * dinero repartidas en dos cajas. Aquí se prueba el choque de DOS personas
 * sobre LA MISMA cosa, que es donde un sistema de mostrador se equivoca sin
 * avisar: dos turnos para una caja, dos cortes del mismo turno, el mismo
 * cobro dos veces, un cobro que entra mientras se corta, una firma usada dos
 * veces, dos firmas para la misma solicitud, dos cierres del mismo mes.
 *
 * En cada caso se afirma lo que queda en la base, no solo lo que se
 * respondió: una sola fila, un solo asiento, el dinero cuadrado.
 *
 * Corre en un gimnasio propio (`gimnasio-propio.ts`): no toca el de pruebas.
 */
describe('dos a la vez: cajas, cortes, cobros, firmas y cierres', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let s: Awaited<ReturnType<typeof sesionesDe>>;
  let sede: GimnasioPropio['sedes'][number];
  const db = () => getDb();
  const asientos = (action: string, resourceId: string) => db().auditLog.count({ where: { organizationId: g.organizationId, action, resourceId } });
  const codigos = (rs: Array<{ statusCode: number }>) => rs.map((r) => r.statusCode).sort();
  const llave = () => `conc-${randomUUID()}`;
  const cobrar = (cookie: string, memberId: string, centavos: string, cashSessionId: string, idempotencyKey = llave()) => app.inject({
    method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie },
    payload: { method: 'CASH', amountCents: centavos, idempotencyKey, branchId: sede.id, cashSessionId },
  });

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Sede de dos a la vez', cajas: 4 }] });
    sede = g.sedes[0]!;
    s = await sesionesDe(app, g);
  }, 60_000);

  afterAll(async () => {
    await g.cerrar();
    await app.close();
    await closeDb();
  });

  it('dos personas abren turno en la MISMA caja a la vez: una abre, la otra recibe 409 y queda un solo turno', async () => {
    const caja = sede.cajas[0]!;
    const abrir = (cookie: string) => app.inject({ method: 'POST', url: '/cash-sessions', headers: { cookie }, payload: { cashRegisterId: caja, openingFloatCents: '50000' } });
    const rs = await Promise.all([abrir(s.gerente), abrir(s.gerente2)]);
    expect(codigos(rs), rs.map((r) => r.body).join(' | ')).toEqual([201, 409]);
    expect(await db().cashSession.count({ where: { cashRegisterId: caja, status: 'OPEN' } })).toBe(1);
  });

  it('dos cortes del MISMO turno a la vez: uno corta, el otro recibe 409; un solo asiento y un solo cierre', async () => {
    const turno = await abrirTurno(app, s.gerente, sede.cajas[1]!);
    const cortar = (cookie: string) => app.inject({ method: 'POST', url: `/cash-sessions/${turno}/close`, headers: { cookie }, payload: { countedCashCents: '50000' } });
    const rs = await Promise.all([cortar(s.gerente), cortar(s.gerente2)]);
    // El que llega tarde recibe una negativa de negocio (409 o 422), nunca un segundo corte.
    expect(rs.filter((r) => r.statusCode === 200), rs.map((r) => `${r.statusCode} ${r.body.slice(0, 160)}`).join(' | ')).toHaveLength(1);
    expect([409, 422]).toContain(rs.find((r) => r.statusCode !== 200)!.statusCode);
    const fila = await db().cashSession.findUniqueOrThrow({ where: { id: turno } });
    expect(fila).toMatchObject({ status: 'CLOSED', expectedCashCents: 50_000n, countedCashCents: 50_000n, varianceCents: 0n });
    expect(await asientos('cash.session.close', turno)).toBe(1);
  });

  it('el mismo cobro enviado cinco veces a la vez (misma llave) deja UN pago, un folio y el cargo pagado una vez', async () => {
    const turno = (await db().cashSession.findFirstOrThrow({ where: { cashRegisterId: sede.cajas[0]!, status: 'OPEN' } })).id;
    const socio = await socioPropio(g);
    const cargo = await cargoPropio(g, socio, 10_000n);
    const k = llave();
    const rs = await Promise.all(Array.from({ length: 5 }, () => cobrar(s.gerente, socio, '10000', turno, k)));
    // Todas responden el mismo cobro (201 la primera, 200 o 201 las repeticiones): ninguna falla.
    expect(rs.filter((r) => r.statusCode >= 300).map((r) => `${r.statusCode} ${r.body}`)).toEqual([]);
    const ids = rs.map((r) => r.json().payment.id as string);
    expect(ids.every((x) => typeof x === 'string' && x.length === 36)).toBe(true);
    expect(new Set(ids).size).toBe(1);
    const pagos = await db().payment.findMany({ where: { organizationId: g.organizationId, memberId: socio } });
    expect(pagos).toHaveLength(1);
    expect(pagos[0]).toMatchObject({ amountCents: 10_000n, status: 'SUCCEEDED' });
    const aplicado = await db().paymentAllocation.aggregate({ where: { chargeId: cargo }, _sum: { amountCents: true } });
    expect(aplicado._sum.amountCents).toBe(10_000n);
    expect((await db().charge.findUniqueOrThrow({ where: { id: cargo } })).status).toBe('PAID');
  });

  it('dos cajas cobran a la vez el mismo cargo completo: se paga UNA vez; el otro cobro queda a favor del socio, no desaparece ni se aplica doble', async () => {
    const turnoA = (await db().cashSession.findFirstOrThrow({ where: { cashRegisterId: sede.cajas[0]!, status: 'OPEN' } })).id;
    const turnoB = await abrirTurno(app, s.gerente2, sede.cajas[2]!);
    const socio = await socioPropio(g);
    const cargo = await cargoPropio(g, socio, 10_000n);
    const rs = await Promise.all([cobrar(s.gerente, socio, '10000', turnoA), cobrar(s.gerente2, socio, '10000', turnoB)]);
    const bien = rs.filter((r) => r.statusCode === 201);
    // Ninguna revienta: o entra, o se le dice que ya no hay qué cobrar.
    expect(rs.filter((r) => r.statusCode >= 500).map((r) => r.body)).toEqual([]);
    expect(bien.length).toBeGreaterThanOrEqual(1);

    const aplicado = await db().paymentAllocation.aggregate({ where: { chargeId: cargo }, _sum: { amountCents: true } });
    expect(aplicado._sum.amountCents, 'lo aplicado al cargo es exactamente su importe').toBe(10_000n);
    expect((await db().charge.findUniqueOrThrow({ where: { id: cargo } })).status).toBe('PAID');
    const pagos = await db().payment.findMany({ where: { organizationId: g.organizationId, memberId: socio, status: 'SUCCEEDED' } });
    expect(pagos).toHaveLength(bien.length);
    const cobrado = pagos.reduce((a, p) => a + p.amountCents, 0n);
    const sinAplicar = pagos.reduce((a, p) => a + p.unappliedCents, 0n);
    // Todo peso recibido está en el cargo o a favor del socio.
    expect(cobrado).toBe(10_000n + sinAplicar);
    const cuenta = (await app.inject({ method: 'GET', url: `/members/${socio}/statement`, headers: { cookie: s.gerente } })).json();
    expect(cuenta.outstandingCents).toBe('0');
    expect(cuenta.creditCents).toBe(sinAplicar.toString());
  });

  it('cobros en efectivo que entran mientras se corta el turno: el corte cuenta todo cobro que se aceptó en ese turno', async () => {
    const turno = await abrirTurno(app, s.gerente, sede.cajas[3]!, '50000');
    const socios = await Promise.all(Array.from({ length: 6 }, () => socioPropio(g)));
    for (const m of socios) await cargoPropio(g, m, 10_000n);
    // El conteo que teclea quien corta: el fondo. Lo que importa aquí es el ESPERADO que calcula el servidor.
    const corte = app.inject({ method: 'POST', url: `/cash-sessions/${turno}/close`, headers: { cookie: s.gerente }, payload: { countedCashCents: '50000', varianceReason: 'Corte con cobros entrando' } });
    const cobros = socios.map((m) => cobrar(s.gerente2, m, '10000', turno));
    const [rCorte, ...rCobros] = await Promise.all([corte, ...cobros]);
    expect(rCobros.filter((r) => r.statusCode >= 500).map((r) => r.body)).toEqual([]);
    expect([200, 409, 422], rCorte.body).toContain(rCorte.statusCode);

    const fila = await db().cashSession.findUniqueOrThrow({ where: { id: turno } });
    const aceptados = await db().payment.aggregate({ where: { organizationId: g.organizationId, cashSessionId: turno, method: 'CASH', status: 'SUCCEEDED' }, _sum: { amountCents: true }, _count: true });
    expect(aceptados._count).toBe(rCobros.filter((r) => r.statusCode === 201).length);
    if (fila.status === 'CLOSED') {
      // Ningún cobro quedó en un turno ya cortado sin entrar a su esperado.
      expect(fila.expectedCashCents, `aceptados ${aceptados._count} cobros`).toBe(50_000n + (aceptados._sum.amountCents ?? 0n));
      // Y con el turno cortado ya no entra ninguno más.
      const tarde = await cobrar(s.gerente2, socios[0]!, '100', turno);
      expect(tarde.statusCode, tarde.body).toBeGreaterThanOrEqual(400);
      expect(tarde.statusCode).toBeLessThan(500);
    }
  });

  it('la misma firma usada en dos condonaciones a la vez: solo una pasa (un solo uso también en carrera)', async () => {
    // Un cargo admite varias condonaciones parciales: si la segunda pasara, sería por la firma, no por el cargo.
    const socio = await socioPropio(g);
    const cargo = await cargoPropio(g, socio, 10_000n);
    const token = await aprobacion(app, s.gerente, 'billing:waiver:apply', g.correos.owner, sede.id, { resourceId: cargo, amountCents: '1000' });
    const condonar = () => app.inject({
      method: 'POST', url: `/charges/${cargo}/adjustments`, headers: { cookie: s.gerente },
      payload: { adjustmentType: 'WAIVER', amountCents: '1000', reasonCode: 'RETENCION', reason: 'Acuerdo con el socio', approvalToken: token },
    });
    const rs = await Promise.all([condonar(), condonar(), condonar()]);
    expect(rs.filter((r) => r.statusCode >= 500).map((r) => r.body)).toEqual([]);
    expect(rs.filter((r) => r.statusCode < 300), rs.map((r) => `${r.statusCode} ${r.body.slice(0, 200)}`).join(' | ')).toHaveLength(1);
    expect(await db().chargeAdjustment.count({ where: { chargeId: cargo } })).toBe(1);
    const cuenta = (await app.inject({ method: 'GET', url: `/members/${socio}/statement`, headers: { cookie: s.gerente } })).json();
    expect(cuenta.outstandingCents).toBe('9000');
    // Sin firma nueva, la siguiente no pasa.
    expect((await condonar()).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('revertir el mismo cobro dos veces a la vez: una sola reversa y el cargo se reabre una vez', async () => {
    const turno = (await db().cashSession.findFirstOrThrow({ where: { cashRegisterId: sede.cajas[0]!, status: 'OPEN' } })).id;
    const socio = await socioPropio(g);
    const cargo = await cargoPropio(g, socio, 10_000n);
    const pago = await cobrar(s.gerente, socio, '10000', turno);
    expect(pago.statusCode, pago.body).toBe(201);
    const paymentId = pago.json().payment.id as string;
    const tokens = [
      await aprobacion(app, s.gerente, 'payments:reverse', g.correos.owner, sede.id, { resourceId: paymentId, amountCents: '10000' }),
      await aprobacion(app, s.gerente, 'payments:reverse', g.correos.owner, sede.id, { resourceId: paymentId, amountCents: '10000' }),
    ];
    const rs = await Promise.all(tokens.map((approvalToken) => app.inject({
      method: 'POST', url: `/payments/${paymentId}/reverse`, headers: { cookie: s.gerente },
      payload: { reason: 'Se cobró al socio equivocado', approvalToken, cashSessionId: turno },
    })));
    expect(rs.filter((r) => r.statusCode >= 500).map((r) => r.body)).toEqual([]);
    expect(rs.filter((r) => r.statusCode < 300), rs.map((r) => `${r.statusCode} ${r.body.slice(0, 200)}`).join(' | ')).toHaveLength(1);
    expect(await asientos('payment.reverse', paymentId)).toBeLessThanOrEqual(1);
    const cuenta = (await app.inject({ method: 'GET', url: `/members/${socio}/statement`, headers: { cookie: s.gerente } })).json();
    expect(cuenta.outstandingCents).toBe('10000');
    expect(cuenta.creditCents).toBe('0');
    expect((await db().charge.findUniqueOrThrow({ where: { id: cargo } })).status).not.toBe('PAID');
  });

  it('dos firmas a la vez para la misma solicitud a distancia: queda UNA firma, un asiento y una sola entrega', async () => {
    const socio = await socioPropio(g);
    const pedida = await app.inject({
      method: 'POST', url: '/approvals/requests', headers: { cookie: s.gerente },
      payload: { permission: 'members:anonymize', branchId: sede.id, resourceType: 'Member', resourceId: socio, summary: 'Anonimizar a un socio de prueba' },
    });
    expect(pedida.statusCode, pedida.body).toBeLessThan(300);
    const id = pedida.json().id as string;
    const firmar = () => app.inject({ method: 'POST', url: `/approvals/requests/${id}/approve`, headers: { cookie: s.owner }, payload: { password: PASSWORD } });
    const rs = await Promise.all([firmar(), firmar()]);
    expect(rs.filter((r) => r.statusCode >= 500).map((r) => r.body)).toEqual([]);
    expect(rs.filter((r) => r.statusCode === 200), rs.map((r) => `${r.statusCode} ${r.body}`).join(' | ')).toHaveLength(1);
    expect((await db().approvalRequest.findUniqueOrThrow({ where: { id } })).status).toBe('APPROVED');
    expect(await asientos('approval.remote.approve', id)).toBe(1);
  });

  /**
   * DEFECTO (1.17b, anotado en pendientes): `RemoteApprovalService.approve` crea la firma
   * (`crearFirma`) ANTES de ganar la decisión (`decide`). Si dos aprobaciones llegan a la
   * vez, la que pierde responde 409 pero ya dejó su firma en `approval_grants`: una firma
   * vigente, sin usar, de una operación que nadie pidió dos veces. Su token no se entrega
   * a nadie (no se puede usar), pero la fila queda viva hasta que vence.
   * Esta prueba afirma lo correcto y hoy falla; cuando se arregle, vitest avisa.
   */
  it('dos firmas a la vez para la misma solicitud no dejan una firma huérfana (corregido en el cierre de la oleada C)', async () => {
    const socio = await socioPropio(g);
    const pedida = await app.inject({
      method: 'POST', url: '/approvals/requests', headers: { cookie: s.gerente },
      payload: { permission: 'members:anonymize', branchId: sede.id, resourceType: 'Member', resourceId: socio, summary: 'Anonimizar a un socio de prueba' },
    });
    const id = pedida.json().id as string;
    const firmar = () => app.inject({ method: 'POST', url: `/approvals/requests/${id}/approve`, headers: { cookie: s.owner }, payload: { password: PASSWORD } });
    // Hasta cinco intentos: la carrera no se da siempre (si una termina antes de que la otra lea, la segunda ve «ya no está pendiente»).
    const rs = await Promise.all([firmar(), firmar(), firmar(), firmar(), firmar()]);
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await db().approvalGrant.count({ where: { organizationId: g.organizationId, resourceId: socio, permission: 'members:anonymize' } })).toBe(1);
  });

  it('dos cierres del mismo mes a la vez: una foto, un asiento; el otro recibe 409', async () => {
    const mes = '2024-05';
    const cerrar = async (cookie: string) => {
      const token = await aprobacion(app, cookie, 'reports:month:close', g.correos.owner);
      return () => app.inject({ method: 'POST', url: '/reports/monthly-close', headers: { cookie }, payload: { month: mes, reason: 'Cierre contable', approvalToken: token } });
    };
    const [a, b] = [await cerrar(s.gerente), await cerrar(s.gerente2)];
    const rs = await Promise.all([a(), b()]);
    expect(rs.filter((r) => r.statusCode >= 500).map((r) => r.body)).toEqual([]);
    expect(codigos(rs), rs.map((r) => `${r.statusCode} ${r.body}`).join(' | ')).toEqual([201, 409]);
    expect(await db().monthlyClose.count({ where: { organizationId: g.organizationId, month: new Date(`${mes}-01T00:00:00.000Z`) } })).toBe(1);
    expect(await db().auditLog.count({ where: { organizationId: g.organizationId, action: 'report.month.close' } })).toBe(1);
  });

  it('la misma venta enviada dos veces a la vez (doble clic, misma llave): una membresía, una cuota, un cobro', async () => {
    const turno = (await db().cashSession.findFirstOrThrow({ where: { cashRegisterId: sede.cajas[0]!, status: 'OPEN' } })).id;
    const socio = await socioPropio(g);
    const saleKey = llave();
    const vender = () => app.inject({
      method: 'POST', url: `/members/${socio}/memberships/sale`, headers: { cookie: s.gerente },
      payload: { planId: g.planMensual, branchId: sede.id, saleKey, payment: { method: 'CASH', cashSessionId: turno } },
    });
    const rs = await Promise.all([vender(), vender()]);
    expect(rs.filter((r) => r.statusCode >= 500).map((r) => r.body)).toEqual([]);
    expect(rs.filter((r) => r.statusCode < 300).length, rs.map((r) => `${r.statusCode} ${r.body.slice(0, 200)}`).join(' | ')).toBeGreaterThanOrEqual(1);
    expect(await db().membership.count({ where: { organizationId: g.organizationId, memberId: socio } })).toBe(1);
    expect(await db().charge.count({ where: { organizationId: g.organizationId, memberId: socio, chargeType: 'MEMBERSHIP_PERIOD' } })).toBe(1);
    expect(await db().payment.count({ where: { organizationId: g.organizationId, memberId: socio, status: 'SUCCEEDED' } })).toBe(1);
  });
});
