import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MemberHistory, MemberPosSales, PaymentReceipt, diferenciasConElContrato } from '@gymflow/core/contracts';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, asignarAlCoach, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { parteDeLaHistoria } from '../src/modules/members/history.routes.js';

/**
 * BLOQUE 2.2 · LA FICHA DEL SOCIO (auditoría 8).
 *
 * Lo que la ficha lee de nuevo: las compras de la tienda ligadas al socio
 * (8-01), su historia en una línea de tiempo (3-11) y quién cobró en el
 * comprobante (3-05). Cada respuesta cumple su contrato del núcleo.
 */
const db = () => getDb();
const sello = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4);

describe('la ficha del socio (2.2)', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let recepcion: string;
  let coach: string;
  let otroGimnasio: string;
  let orgId: string;
  let cen: string;
  let sesion: string;
  let agua: string;

  const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });

  async function nuevoSocio(): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Ficha'), lastName: nombreUnico('Historia'), phoneE164: telefonoUnico(), homeBranchId: cen, consents: CONSENTIMIENTOS },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  async function vender(memberId: string | null, quantity = 1) {
    const res = await app.inject({
      method: 'POST', url: '/pos/sales', headers: { cookie: recepcion },
      payload: { idempotencyKey: crypto.randomUUID(), branchId: cen, method: 'CASH', cashSessionId: sesion, lines: [{ productId: agua, quantity }], ...(memberId ? { memberId } : {}) },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; totalCents: string; folio: string };
  }

  async function cobrar(memberId: string, amountCents: string) {
    const cargo = await app.inject({
      method: 'POST', url: `/members/${memberId}/charges`, headers: { cookie: gerencia },
      payload: { chargeType: 'MANUAL_ADJUSTMENT', concept: 'Cargo de la ficha', subtotalCents: amountCents, reason: 'Prueba de la ficha' },
    });
    expect(cargo.statusCode, cargo.body).toBe(201);
    const pago = await app.inject({
      method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: recepcion },
      payload: { idempotencyKey: crypto.randomUUID(), method: 'SPEI_TRANSFER', amountCents, branchId: cen, externalRef: `RASTREO-${sello()}` },
    });
    expect(pago.statusCode, pago.body).toBe(201);
    return pago.json().payment as { id: string };
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    coach = await loginAs(app, 'coach@demo.mx');
    otroGimnasio = await loginAs(app, 'gerencia@otro.mx');
    const { demo, demoBranches } = await orgFixtures();
    orgId = demo.id;
    cen = demoBranches.find((b) => b.code === 'CEN')!.id;
    agua = (await db().product.findFirstOrThrow({ where: { organizationId: orgId, sku: 'AGUA600' } })).id;

    const caja = await app.inject({
      method: 'POST', url: '/cash-registers', headers: { cookie: gerencia },
      payload: { branchId: cen, code: `F${sello()}`.slice(0, 8), name: `Caja de la ficha ${sello()}` },
    });
    expect(caja.statusCode, caja.body).toBe(201);
    const turno = await app.inject({
      method: 'POST', url: '/cash-sessions', headers: { cookie: gerencia },
      payload: { cashRegisterId: caja.json().id, openingFloatCents: '0' },
    });
    expect(turno.statusCode, turno.body).toBe(201);
    sesion = turno.json().id as string;
    await app.inject({
      method: 'POST', url: '/inventory/movements', headers: { cookie: gerencia },
      payload: { branchId: cen, productId: agua, movementType: 'PURCHASE', quantityDelta: 200, reason: 'Reposición para las pruebas de la ficha' },
    });
  });

  afterAll(async () => {
    // El turno de esta prueba no se queda abierto: otras pruebas de la sede exigen una sola caja abierta.
    const turno = await get(`/cash-sessions/${sesion}`, gerencia);
    const esperado = turno.statusCode === 200 ? String(turno.json().expectedCashCents ?? '0') : '0';
    await app.inject({ method: 'POST', url: `/cash-sessions/${sesion}/close`, headers: { cookie: gerencia }, payload: { countedCashCents: esperado, varianceReason: 'Cierre de la prueba de la ficha' } });
    await app.close(); await closeDb();
  });

  // ── Compras de la tienda (8-01) ───────────────────────────────────────────
  it('las compras ligadas al socio se leen en su ficha, con producto, quién cobró y total; las de otros no (8-01)', async () => {
    const socio = await nuevoSocio();
    const otro = await nuevoSocio();
    const v1 = await vender(socio, 2);
    await vender(otro, 1);
    await vender(null, 1);

    const res = await get(`/members/${socio}/pos-sales`, recepcion);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(diferenciasConElContrato(MemberPosSales, r)).toEqual([]);
    expect(r.total).toBe(1);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: v1.id, status: 'COMPLETED', totalCents: v1.totalCents, folio: v1.folio, method: 'CASH' });
    expect(r.items[0].soldByName).toBeTruthy();
    expect(r.items[0].lines).toHaveLength(1);
    expect(r.items[0].lines[0]).toMatchObject({ productId: agua, quantity: 2 });
    expect(r.items[0].lines[0].name).toBeTruthy();
    expect(r.spentCents).toBe(v1.totalCents);
  });

  it('las compras van por páginas sin repetir, y una anulada se ve como anulada y no suma a lo gastado', async () => {
    const socio = await nuevoSocio();
    const ventas: Array<{ id: string; totalCents: string; folio: string }> = [];
    for (let i = 0; i < 5; i++) ventas.push(await vender(socio, 1));
    const anula = await app.inject({ method: 'POST', url: `/pos/sales/${ventas[0]!.id}/void`, headers: { cookie: gerencia }, payload: { reason: 'Prueba de la ficha: venta equivocada' } });
    expect(anula.statusCode, anula.body).toBe(200);

    const vistos: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    for (;;) {
      const res = await get(`/members/${socio}/pos-sales?limit=2${cursor ? `&cursor=${cursor}` : ''}`, gerencia);
      expect(res.statusCode, res.body).toBe(200);
      const p = res.json();
      expect(diferenciasConElContrato(MemberPosSales, p)).toEqual([]);
      expect(p.total).toBe(5);
      expect(p.hasMore).toBe(p.nextCursor !== null);
      vistos.push(...p.items.map((x: { id: string }) => x.id));
      paginas += 1;
      // Lo gastado no depende de la página: cuatro ventas vivas.
      expect(BigInt(p.spentCents)).toBe(BigInt(ventas[1]!.totalCents) * 4n);
      const anulada = p.items.find((x: { id: string }) => x.id === ventas[0]!.id);
      if (anulada) expect(anulada).toMatchObject({ status: 'VOIDED', voidReason: 'Prueba de la ficha: venta equivocada' });
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
      if (paginas > 10) throw new Error('la lista no termina');
    }
    expect(paginas).toBe(3);
    expect(new Set(vistos).size).toBe(5);
    expect([...vistos].sort()).toEqual(ventas.map((v) => v.id).sort());

    const malo = await get(`/members/${socio}/pos-sales?cursor=inventado`, gerencia);
    expect(malo.statusCode).toBe(422);
  });

  it('las compras son dinero del socio: el coach no las recibe, y un socio de otro gimnasio no existe', async () => {
    const socio = await nuevoSocio();
    await asignarAlCoach(socio);
    await vender(socio, 1);
    expect((await get(`/members/${socio}/pos-sales`, coach)).statusCode).toBe(403);
    expect((await get(`/members/${socio}/pos-sales`, otroGimnasio)).statusCode).toBe(404);
  });

  // ── Historia (3-11) ───────────────────────────────────────────────────────
  it('la historia junta dinero, contacto con su nota, tienda y datos en una línea de tiempo, lo más reciente primero (3-11)', async () => {
    const socio = await nuevoSocio();
    await cobrar(socio, '65000');
    await vender(socio, 1);
    const contacto = await app.inject({
      method: 'POST', url: `/members/${socio}/follow-ups`, headers: { cookie: gerencia },
      payload: { channel: 'CALL', outcome: 'COMING_BACK', note: 'Regresa el lunes con su hermano', nextStepOn: '2027-01-11' },
    });
    expect(contacto.statusCode, contacto.body).toBe(201);
    await db().memberNotice.create({ data: { id: crypto.randomUUID(), organizationId: orgId, memberId: socio, kind: 'PAYMENT_DUE_SOON', title: 'Tu pago vence pronto', body: 'Vence el viernes.', dedupeKey: `ficha-${sello()}` } });

    const res = await get(`/members/${socio}/history`, gerencia);
    expect(res.statusCode, res.body).toBe(200);
    const h = res.json();
    expect(diferenciasConElContrato(MemberHistory, h)).toEqual([]);
    expect(h.kinds).toEqual(['DINERO', 'MEMBRESIA', 'PUERTA', 'CONTACTO', 'FIRMAS', 'DATOS']);
    const items = h.items as Array<{ id: string; at: string; kind: string; source: string; action: string | null; phrase: string; detail: string | null; amountCents: string | null; actorName: string }>;
    // Lo más reciente primero.
    expect(items.map((x) => x.at)).toEqual([...items.map((x) => x.at)].sort().reverse());
    // Sin renglones repetidos.
    expect(new Set(items.map((x) => x.id)).size).toBe(items.length);

    const cobro = items.find((x) => x.action === 'payments.record');
    expect(cobro, 'el cobro').toMatchObject({ kind: 'DINERO', source: 'AUDIT', amountCents: '65000' });
    expect(cobro!.phrase).toContain('registró un cobro de $650.00');
    expect(cobro!.actorName).toBeTruthy();
    expect(items.find((x) => x.action === 'pos.sale.create'), 'la compra de la tienda').toMatchObject({ kind: 'DINERO' });
    expect(items.find((x) => x.action === 'member.create'), 'el alta').toMatchObject({ kind: 'DATOS' });

    // El contacto sale UNA vez, con su nota (el asiento de la bitácora no la guarda).
    const contactos = items.filter((x) => x.action === 'member.follow_up');
    expect(contactos).toHaveLength(1);
    expect(contactos[0]).toMatchObject({ kind: 'CONTACTO', source: 'CONTACT', phrase: 'Llamada · Va a regresar' });
    expect(contactos[0]!.detail).toContain('Regresa el lunes con su hermano');
    expect(contactos[0]!.detail).toContain('2027-01-11');

    expect(items.find((x) => x.source === 'NOTICE')).toMatchObject({ kind: 'CONTACTO', phrase: 'Aviso en su portal: Tu pago vence pronto', detail: 'Vence el viernes.' });
  });

  it('la historia se filtra por parte y va por páginas sin repetir ni perder lo que no está en la bitácora', async () => {
    const socio = await nuevoSocio();
    for (let i = 0; i < 4; i++) await cobrar(socio, '10000');
    for (let i = 0; i < 3; i++) {
      const c = await app.inject({ method: 'POST', url: `/members/${socio}/follow-ups`, headers: { cookie: gerencia }, payload: { channel: 'WHATSAPP', outcome: 'ANSWERED', note: `Nota ${i}` } });
      expect(c.statusCode, c.body).toBe(201);
    }

    const dinero = (await get(`/members/${socio}/history?kind=DINERO`, gerencia)).json();
    expect(dinero.items.length).toBeGreaterThanOrEqual(4);
    expect(dinero.items.every((x: { kind: string }) => x.kind === 'DINERO')).toBe(true);
    const contacto = (await get(`/members/${socio}/history?kind=CONTACTO`, gerencia)).json();
    expect(contacto.items.filter((x: { source: string }) => x.source === 'CONTACT')).toHaveLength(3);
    expect(contacto.items.every((x: { kind: string }) => x.kind === 'CONTACTO')).toBe(true);

    // Por páginas de 3 asientos: todo lo de la historia completa sale una sola vez.
    const completa = (await get(`/members/${socio}/history?limit=100`, gerencia)).json();
    expect(completa.hasMore).toBe(false);
    const vistos: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    for (;;) {
      const p: { items: Array<{ id: string }>; nextCursor: string | null } = (await get(`/members/${socio}/history?limit=3${cursor ? `&cursor=${cursor}` : ''}`, gerencia)).json();
      vistos.push(...p.items.map((x) => x.id));
      paginas += 1;
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
      if (paginas > 60) throw new Error('la historia no termina');
    }
    expect(paginas).toBeGreaterThan(2);
    expect(new Set(vistos).size).toBe(vistos.length);
    expect([...vistos].sort()).toEqual(completa.items.map((x: { id: string }) => x.id).sort());

    expect((await get(`/members/${socio}/history?cursor=inventado`, gerencia)).statusCode).toBe(422);
  });

  it('la historia dice sus entradas por día, no una por paso', async () => {
    const socio = await nuevoSocio();
    const dia = new Date('2026-03-04T00:00:00Z');
    const paso = (at: string, outcome: 'GRANTED' | 'DENIED', denialReason: string | null = null) => db().accessDecision.create({
      data: { id: crypto.randomUUID(), organizationId: orgId, branchId: cen, memberId: socio, outcome, denialReason, credentialKind: 'FACE', policyVersion: 'prueba', at: new Date(at), businessDate: dia },
    });
    await paso('2026-03-04T13:05:00Z', 'GRANTED');
    await paso('2026-03-04T19:40:00Z', 'GRANTED');
    await paso('2026-03-04T12:59:00Z', 'DENIED', 'NO_ACTIVE_MEMBERSHIP');

    const h = (await get(`/members/${socio}/history?kind=PUERTA`, gerencia)).json();
    const visitas = (h.items as Array<{ source: string; phrase: string; detail: string | null; at: string }>).filter((x) => x.source === 'VISIT');
    expect(visitas).toHaveLength(2);
    const entro = visitas.find((x) => x.phrase.startsWith('Entró'))!;
    expect(entro.phrase).toBe('Entró con su rostro');
    expect(entro.detail).toBe('2 pasos por la puerta ese día');
    // De una entrada se dice la primera del día.
    expect(entro.at).toBe('2026-03-04T13:05:00.000Z');
    expect(visitas.find((x) => x.phrase === 'No pasó')?.detail).toBeTruthy();
  });

  it('cada quien recibe de la historia solo lo que ya ve: el coach, sin dinero, contacto, firmas ni puerta', async () => {
    const socio = await nuevoSocio();
    await asignarAlCoach(socio);
    await cobrar(socio, '65000');
    await app.inject({ method: 'POST', url: `/members/${socio}/follow-ups`, headers: { cookie: gerencia }, payload: { channel: 'CALL', outcome: 'ANSWERED', note: 'Nota que el coach no lee' } });

    const res = await get(`/members/${socio}/history`, coach);
    expect(res.statusCode, res.body).toBe(200);
    const h = res.json();
    expect(diferenciasConElContrato(MemberHistory, h)).toEqual([]);
    expect(h.kinds).not.toContain('DINERO');
    expect(h.kinds).not.toContain('CONTACTO');
    expect(h.items.some((x: { kind: string }) => !h.kinds.includes(x.kind))).toBe(false);
    expect(JSON.stringify(h)).not.toContain('650');
    expect(JSON.stringify(h)).not.toContain('Nota que el coach no lee');
    // Pedir una parte que no ve: lista vacía, no un error.
    const dinero = await get(`/members/${socio}/history?kind=DINERO`, coach);
    expect(dinero.statusCode).toBe(200);
    expect(dinero.json().items).toEqual([]);

    // Recepción sí ve el dinero y el contacto.
    const rec = (await get(`/members/${socio}/history`, recepcion)).json();
    expect(rec.kinds).toContain('DINERO');
    expect(rec.items.some((x: { action: string | null }) => x.action === 'payments.record')).toBe(true);

    // Un socio que no es suyo no existe para el coach, y uno de otro gimnasio no existe para nadie.
    const ajeno = await nuevoSocio();
    expect((await get(`/members/${ajeno}/history`, coach)).statusCode).toBe(404);
    expect((await get(`/members/${socio}/history`, otroGimnasio)).statusCode).toBe(404);
  });

  it('qué asientos cuentan la historia y de qué parte son', () => {
    expect(parteDeLaHistoria('payments.record')).toBe('DINERO');
    expect(parteDeLaHistoria('membership.sale')).toBe('DINERO');
    expect(parteDeLaHistoria('pos.sale.create')).toBe('DINERO');
    expect(parteDeLaHistoria('membership.freeze')).toBe('MEMBRESIA');
    expect(parteDeLaHistoria('access.manual_grant')).toBe('PUERTA');
    expect(parteDeLaHistoria('portal.invite.issue')).toBe('CONTACTO');
    expect(parteDeLaHistoria('consent.record')).toBe('FIRMAS');
    expect(parteDeLaHistoria('privacy.request.open')).toBe('FIRMAS');
    expect(parteDeLaHistoria('member.export.self')).toBe('FIRMAS');
    expect(parteDeLaHistoria('member.update')).toBe('DATOS');
    expect(parteDeLaHistoria('training.routine.assign')).toBe('DATOS');
    // No son historia del socio: quién leyó su nota de salud, las firmas, y el contacto (viene de su tabla, con la nota).
    expect(parteDeLaHistoria('health.read')).toBeNull();
    expect(parteDeLaHistoria('approval.local.issue')).toBeNull();
    expect(parteDeLaHistoria('member.follow_up')).toBeNull();
  });

  // ── Comprobante (3-05) ────────────────────────────────────────────────────
  it('el comprobante dice quién cobró y cumple su contrato (3-05)', async () => {
    const socio = await nuevoSocio();
    const pago = await cobrar(socio, '65000');
    const res = await get(`/payments/${pago.id}/receipt`, recepcion);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(diferenciasConElContrato(PaymentReceipt, r)).toEqual([]);
    const yo = await db().user.findFirstOrThrow({ where: { organizationId: orgId, email: 'recepcion@demo.mx' } });
    expect(r.collectedByName).toBe(yo.fullName);
  });
});
