import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import {
  IntakeList, InventoryMovementList, MemberStatement, PortalChargesPage, PortalMe, PortalPaymentsPage, PortalStatement,
  ProspectList, StatementChargesPage, StatementPaymentsPage, diferenciasConElContrato,
} from '@gymflow/core/contracts';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, aprobacion, cuentaDePrueba, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { comoSeSaldo } from '../src/modules/billing/statement.serializers.js';

/**
 * BLOQUE 1.6 · ESTADO DE CUENTA Y LISTAS POR PÁGINAS (auditoría 8).
 *
 * Una lista nunca esconde filas sin decirlo: el estado de cuenta, los
 * interesados, las altas digitales y el libro de inventario viajan por
 * páginas con su total y su cursor (3-04, 4-15, 10-01, 9-14, 8-02). El estado
 * de cuenta dice además quién cobró, qué cubrió cada pago y cómo quedó
 * saldado cada cargo (3-05, 3-06). Y cada respuesta cumple su contrato del
 * núcleo, sin campos de más ni de menos.
 */
const db = () => getDb();
type Fila = { id: string };

describe('estado de cuenta y listas por páginas (1.6)', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let recepcion: string;
  let duena: string;
  let orgId: string;
  let cen: string;
  let nor: string;

  const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });

  async function nuevoSocio(sede = cen): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Cuenta'), lastName: nombreUnico('Paginas'), phoneE164: telefonoUnico(), homeBranchId: sede, consents: CONSENTIMIENTOS },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  async function cargo(memberId: string, subtotalCents: string, dueDate: string, concept = 'Cargo de prueba') {
    const res = await app.inject({
      method: 'POST', url: `/members/${memberId}/charges`, headers: { cookie: gerencia },
      payload: { chargeType: 'MANUAL_ADJUSTMENT', concept, subtotalCents, reason: 'Prueba del estado de cuenta', dueDate },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string };
  }

  /** Por transferencia: no necesita caja abierta y deja referencia. */
  async function pagar(memberId: string, amountCents: string, chargeId?: string) {
    const res = await app.inject({
      method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: gerencia },
      payload: {
        idempotencyKey: crypto.randomUUID(), method: 'SPEI_TRANSFER', amountCents, branchId: cen,
        externalRef: `RASTREO-${nombreUnico('').slice(0, 8)}`, ...(chargeId ? { targetChargeIds: [chargeId] } : {}),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().payment as { id: string; amountCents: string; externalRef: string };
  }

  /** Recorre una lista con «Cargar más» hasta el final y devuelve todo lo que salió. */
  async function recorrer<T extends Fila>(url: string, cookie: string, limit: number): Promise<{ filas: T[]; paginas: number; total: number }> {
    const filas: T[] = [];
    let cursor: string | null = null;
    let total = -1;
    let paginas = 0;
    for (;;) {
      const sep = url.includes('?') ? '&' : '?';
      const res = await get(`${url}${sep}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`, cookie);
      expect(res.statusCode, res.body).toBe(200);
      const p = res.json() as { items: T[]; total: number; nextCursor: string | null; hasMore: boolean };
      filas.push(...p.items);
      paginas += 1;
      total = p.total;
      expect(p.hasMore).toBe(p.nextCursor !== null);
      expect(p.items.length).toBeLessThanOrEqual(limit);
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
      if (paginas > 500) throw new Error('la lista no termina');
    }
    return { filas, paginas, total };
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    recepcion = await loginAs(app, 'recepcion@demo.mx');
    duena = await loginAs(app, 'owner@demo.mx');
    const { demo, demoBranches } = await orgFixtures();
    orgId = demo.id;
    cen = demoBranches.find((b) => b.code === 'CEN')!.id;
    nor = demoBranches.find((b) => b.code === 'NOR')!.id;
  });

  afterAll(async () => { await app.close(); await closeDb(); });

  // ── Estado de cuenta ──────────────────────────────────────────────────────
  it('el estado de cuenta dice cuántos cargos hay y los entrega todos por páginas, sin repetir ni saltarse ninguno (3-04, 4-15)', async () => {
    const socio = await nuevoSocio();
    // Siete cargos, dos con el mismo vencimiento: el id desempata.
    const dias = ['2026-01-10', '2026-02-10', '2026-03-10', '2026-03-10', '2026-04-10', '2026-05-10', '2026-06-10'];
    const ids: string[] = [];
    for (const d of dias) ids.push((await cargo(socio, '10000', d)).id);
    // Todos pagados menos el más reciente: así la primera página no arrastra deuda vieja.
    for (const id of ids.slice(0, 6)) await pagar(socio, '10000', id);

    const primera = await get(`/members/${socio}/statement?limit=3`, gerencia);
    expect(primera.statusCode, primera.body).toBe(200);
    const st = primera.json();
    expect(diferenciasConElContrato(MemberStatement, st)).toEqual([]);
    expect(st.charges).toHaveLength(3);
    expect(st.charges.map((c: { dueDate: string }) => c.dueDate)).toEqual(['2026-06-10', '2026-05-10', '2026-04-10']);
    expect(st.pages.charges).toMatchObject({ total: 7, hasMore: true });
    expect(st.pages.payments).toMatchObject({ total: 6, hasMore: true });
    expect(st.payments).toHaveLength(3);
    expect(st.outstandingCents).toBe('10000');

    // «Cargar más» desde el cursor de la primera página.
    const segunda = await get(`/members/${socio}/statement/charges?limit=3&cursor=${st.pages.charges.nextCursor}`, gerencia);
    expect(segunda.statusCode, segunda.body).toBe(200);
    expect(diferenciasConElContrato(StatementChargesPage, segunda.json())).toEqual([]);
    expect(segunda.json().items).toHaveLength(3);

    const todos = await recorrer<Fila & { dueDate: string }>(`/members/${socio}/statement/charges`, gerencia, 3);
    expect(todos.total).toBe(7);
    expect(todos.paginas).toBe(3);
    expect(new Set(todos.filas.map((c) => c.id)).size).toBe(7);
    expect([...todos.filas.map((c) => c.id)].sort()).toEqual([...ids].sort());
    // Del vencimiento más reciente al más viejo.
    const fechas = todos.filas.map((c) => c.dueDate);
    expect(fechas).toEqual([...fechas].sort().reverse());

    const pagos = await recorrer<Fila>(`/members/${socio}/statement/payments`, gerencia, 4);
    expect(pagos.total).toBe(6);
    expect(new Set(pagos.filas.map((p) => p.id)).size).toBe(6);
  });

  it('lo que debe viene SIEMPRE en la primera respuesta, aunque sea más viejo que la primera página', async () => {
    const socio = await nuevoSocio();
    const viejo = await cargo(socio, '25000', '2025-01-15', 'Adeudo viejo');
    for (const d of ['2026-03-01', '2026-04-01', '2026-05-01']) await pagar(socio, '10000', (await cargo(socio, '10000', d)).id);

    const st = (await get(`/members/${socio}/statement?limit=2`, gerencia)).json();
    expect(st.pages.charges).toMatchObject({ total: 4, hasMore: true });
    // Dos de la página y, además, el adeudo de 2025.
    expect(st.charges.map((c: Fila) => c.id)).toContain(viejo.id);
    expect(st.charges).toHaveLength(3);
    const abiertos = st.charges.filter((c: { status: string }) => ['OPEN', 'PARTIALLY_PAID', 'OVERDUE'].includes(c.status));
    const suma = abiertos.reduce((a: bigint, c: { balanceCents: string }) => a + BigInt(c.balanceCents), 0n);
    expect(suma.toString()).toBe(st.outstandingCents);
  });

  it('cada pago dice quién lo cobró, su referencia y qué cargos cubrió; la reversa, lo que dejó de cubrir (3-05)', async () => {
    const socio = await nuevoSocio();
    const c = await cargo(socio, '65000', '2026-11-01', 'Mensualidad de prueba');
    const pago = await pagar(socio, '65000', c.id);

    let st = (await get(`/members/${socio}/statement`, gerencia)).json();
    expect(diferenciasConElContrato(MemberStatement, st)).toEqual([]);
    const visto = st.payments.find((p: Fila) => p.id === pago.id);
    expect(visto.collectedByName).toBeTruthy();
    expect(visto.collectedByUserId).toBeTruthy();
    expect(visto.externalRef).toBe(pago.externalRef);
    expect(visto.covers).toEqual([{ chargeId: c.id, concept: 'Mensualidad de prueba', amountCents: '65000' }]);

    const rev = await app.inject({
      method: 'POST', url: `/payments/${pago.id}/reverse`, headers: { cookie: gerencia },
      payload: { reason: 'Transferencia rechazada por el banco', approvalToken: await aprobacion(app, gerencia, 'payments:reverse', undefined, undefined, { resourceId: pago.id, amountCents: pago.amountCents }) },
    });
    expect(rev.statusCode, rev.body).toBe(201);
    st = (await get(`/members/${socio}/statement`, gerencia)).json();
    expect(diferenciasConElContrato(MemberStatement, st)).toEqual([]);
    const contra = st.payments.find((p: { reversesPaymentId: string | null }) => p.reversesPaymentId === pago.id);
    expect(contra.covers).toEqual([{ chargeId: c.id, concept: 'Mensualidad de prueba', amountCents: '-65000' }]);
    expect(contra.reversalReason).toBe('Transferencia rechazada por el banco');
    expect(diferenciasConElContrato(StatementPaymentsPage, (await get(`/members/${socio}/statement/payments`, gerencia)).json())).toEqual([]);
  });

  it('un cargo condonado dice «condonado», con el ajuste y quién lo autorizó; uno pagado, «pagado» (3-06)', async () => {
    const socio = await nuevoSocio();
    const perdonado = await cargo(socio, '30000', '2026-10-01', 'Cuota perdonada');
    const pagadoC = await cargo(socio, '20000', '2026-10-02', 'Cuota pagada');
    const anulado = await cargo(socio, '15000', '2026-10-03', 'Cargo por error');
    await pagar(socio, '20000', pagadoC.id);
    const condonar = await app.inject({
      method: 'POST', url: `/charges/${perdonado.id}/adjustments`, headers: { cookie: gerencia },
      payload: {
        adjustmentType: 'WAIVER', amountCents: '30000', reasonCode: 'RETENCION', reason: 'Estuvo hospitalizado',
        approvalToken: await aprobacion(app, gerencia, 'billing:waiver:apply', undefined, undefined, { resourceId: perdonado.id, amountCents: '30000' }),
      },
    });
    expect(condonar.statusCode, condonar.body).toBe(201);
    const anular = await app.inject({
      method: 'POST', url: `/charges/${anulado.id}/void`, headers: { cookie: gerencia },
      payload: { reason: 'Se capturó dos veces', approvalToken: await aprobacion(app, gerencia, 'billing:charge:void', undefined, undefined, { resourceId: anulado.id }) },
    });
    expect(anular.statusCode, anular.body).toBe(200);

    const st = (await get(`/members/${socio}/statement`, gerencia)).json();
    expect(diferenciasConElContrato(MemberStatement, st)).toEqual([]);
    const de = (id: string) => st.charges.find((c: Fila) => c.id === id);
    // La base lo deja PAID: es `settledBy` quien dice que no hubo dinero.
    expect(de(perdonado.id)).toMatchObject({ status: 'PAID', settledBy: 'WAIVER' });
    expect(de(perdonado.id).adjustments).toHaveLength(1);
    expect(de(perdonado.id).adjustments[0]).toMatchObject({ adjustmentType: 'WAIVER', amountCents: '30000', reason: 'Estuvo hospitalizado' });
    expect(de(perdonado.id).adjustments[0].approvedByName).toBeTruthy();
    expect(de(pagadoC.id)).toMatchObject({ status: 'PAID', settledBy: 'PAYMENT', adjustments: [] });
    expect(de(anulado.id)).toMatchObject({ status: 'VOID', settledBy: null });
  });

  it('cómo quedó saldado, caso por caso', () => {
    const c = (status: string, allocatedCents: bigint, adjustedCents: bigint, discountCents = 0n) => ({ status, allocatedCents, adjustedCents, discountCents }) as Parameters<typeof comoSeSaldo>[0];
    expect(comoSeSaldo(c('PAID', 100n, 0n), [])).toBe('PAYMENT');
    expect(comoSeSaldo(c('PAID', 60n, 40n), [{ adjustmentType: 'DISCOUNT' }])).toBe('MIXED');
    expect(comoSeSaldo(c('PAID', 0n, 100n), [{ adjustmentType: 'WAIVER' }])).toBe('WAIVER');
    expect(comoSeSaldo(c('PAID', 0n, 100n), [{ adjustmentType: 'DISCOUNT' }])).toBe('DISCOUNT');
    expect(comoSeSaldo(c('PAID', 0n, 100n), [{ adjustmentType: 'CORRECTION' }])).toBe('CORRECTION');
    expect(comoSeSaldo(c('PAID', 0n, 0n, 100n), [])).toBe('DISCOUNT');
    expect(comoSeSaldo(c('WRITTEN_OFF', 0n, 0n), [])).toBe('WAIVER');
    expect(comoSeSaldo(c('VOID', 0n, 0n), [])).toBeNull();
    expect(comoSeSaldo(c('PARTIALLY_PAID', 50n, 0n), [])).toBeNull();
    expect(comoSeSaldo(c('OVERDUE', 0n, 0n), [])).toBeNull();
  });

  it('un cursor inventado o un límite fuera de rango responden 422, nunca una página a medias', async () => {
    const socio = await nuevoSocio();
    for (const url of [
      `/members/${socio}/statement/charges?cursor=no-es-un-cursor`,
      `/members/${socio}/statement/payments?cursor=${Buffer.from(JSON.stringify(['ayer', socio])).toString('base64url')}`,
      `/members/${socio}/statement?limit=0`,
      `/members/${socio}/statement/charges?limit=201`,
      '/prospects?cursor=xx',
      '/intakes?cursor=xx',
      `/inventory/movements?branchId=${cen}&cursor=xx`,
    ]) {
      const res = await get(url, gerencia);
      expect(res.statusCode, `${url} → ${res.body}`).toBe(422);
    }
    // Y las páginas de un socio que no existe en este gimnasio, 404.
    expect((await get(`/members/${uuidv7()}/statement/charges`, gerencia)).statusCode).toBe(404);
  });

  // ── Interesados ───────────────────────────────────────────────────────────
  it('los interesados viajan por páginas, con buscador y con los contadores de las dos pestañas (10-01)', async () => {
    const apellido = nombreUnico('Interes');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST', url: '/prospects', headers: { cookie: recepcion },
        payload: { branchId: cen, firstName: nombreUnico('Ximena'), lastName: apellido, phoneE164: telefonoUnico(), source: 'Instagram' },
      });
      expect(r.statusCode, r.body).toBe(201);
      ids.push(r.json().id);
    }
    const base = `/prospects?q=${apellido.toLowerCase()}`;
    const primera = (await get(`${base}&limit=2`, recepcion)).json();
    expect(diferenciasConElContrato(ProspectList, primera)).toEqual([]);
    expect(primera).toMatchObject({ total: 5, hasMore: true, counts: { open: 5, closed: 0 } });
    expect(primera.items).toHaveLength(2);

    const todos = await recorrer<Fila>(base, recepcion, 2);
    expect(todos.paginas).toBe(3);
    expect([...todos.filas.map((p) => p.id)].sort()).toEqual([...ids].sort());

    // Uno se pierde: sale de «En seguimiento» y entra a «Cerrados», y los contadores lo dicen.
    // Cerrar tiene su ruta y pide motivo (bloque 2.4, 10-09); antes era `PATCH { status: 'LOST' }`.
    expect((await app.inject({ method: 'POST', url: `/prospects/${ids[0]}/close`, headers: { cookie: recepcion }, payload: { reasonCode: 'PRECIO' } })).statusCode).toBe(200);
    const abiertos = (await get(`${base}&open=true`, recepcion)).json();
    const cerrados = (await get(`${base}&open=false`, recepcion)).json();
    expect(abiertos).toMatchObject({ total: 4, counts: { open: 4, closed: 1 } });
    expect(cerrados).toMatchObject({ total: 1, counts: { open: 4, closed: 1 } });
    expect(cerrados.items[0].id).toBe(ids[0]);
    expect((await get(`${base}&status=LOST`, recepcion)).json().total).toBe(1);

    // El buscador también encuentra por teléfono, y lo que no existe no devuelve todo.
    const tel = (primera.items[0].phoneE164 as string).slice(-8);
    expect((await get(`/prospects?q=${tel}`, recepcion)).json().items.map((p: Fila) => p.id)).toContain(primera.items[0].id);
    expect((await get('/prospects?q=zzzzqqqqxxxx', recepcion)).json()).toMatchObject({ items: [], total: 0, hasMore: false, nextCursor: null });
    expect((await get('/prospects?q=%2B%2B', recepcion)).json().total).toBe(0);
  });

  it('la lista completa de interesados se recorre hasta el final: los que pasan de 50 ya no desaparecen', async () => {
    const enBase = await db().prospect.count({ where: { organizationId: orgId } });
    const todos = await recorrer<Fila>('/prospects', gerencia, 7);
    expect(todos.total).toBe(enBase);
    expect(new Set(todos.filas.map((p) => p.id)).size).toBe(enBase);
  });

  // ── Altas digitales ───────────────────────────────────────────────────────
  it('las altas viajan por páginas, dicen quién revisó y no pintan «[eliminado] [eliminado]» (9-14)', async () => {
    const quien = await db().user.findFirstOrThrow({ where: { organizationId: orgId, email: 'gerencia@demo.mx' } });
    const base = { organizationId: orgId, branchId: cen, acceptedConsents: [], nameKey: 'alta paginas' };
    const rechazada = await db().memberIntake.create({ data: {
      ...base, id: uuidv7(), status: 'REJECTED', firstName: 'Alta', lastName: nombreUnico('Rechazada'),
      rejectionReason: 'Datos incompletos', reviewedAt: new Date(), reviewedByUserId: quien.id,
    } });
    const borrada = await db().memberIntake.create({ data: {
      ...base, id: uuidv7(), status: 'REJECTED', firstName: '[eliminado]', lastName: '[eliminado]', nameKey: '',
      rejectionReason: 'Caducó sin revisar', reviewedAt: new Date(),
    } });

    const historial = await recorrer<Fila & { fullName: string; scrubbed: boolean; reviewedByName: string | null; reviewedAt: string | null }>('/intakes?status=REJECTED', gerencia, 40);
    expect(historial.total).toBe(await db().memberIntake.count({ where: { organizationId: orgId, status: 'REJECTED' } }));
    expect(new Set(historial.filas.map((a) => a.id)).size).toBe(historial.total);
    const r = historial.filas.find((a) => a.id === rechazada.id)!;
    expect(r).toMatchObject({ scrubbed: false, reviewedByName: quien.fullName });
    expect(r.reviewedAt).toBeTruthy();
    const b = historial.filas.find((a) => a.id === borrada.id)!;
    expect(b).toMatchObject({ scrubbed: true, fullName: 'Datos borrados', reviewedByName: null });
    expect(historial.filas.some((a) => a.fullName.includes('[eliminado]'))).toBe(false);

    // La bandeja: en orden de llegada, con el total de pendientes aparte.
    const bandeja = (await get('/intakes?limit=5', gerencia)).json();
    expect(diferenciasConElContrato(IntakeList, bandeja)).toEqual([]);
    expect(bandeja.pending).toBe(bandeja.total);
    const llegadas = bandeja.items.map((a: { submittedAt: string }) => a.submittedAt);
    expect(llegadas).toEqual([...llegadas].sort());
    const toda = await recorrer<Fila>('/intakes?status=SUBMITTED', gerencia, 25);
    expect(new Set(toda.filas.map((a) => a.id)).size).toBe(bandeja.pending);
    expect(diferenciasConElContrato(IntakeList, (await get('/intakes?status=REJECTED&limit=3', gerencia)).json())).toEqual([]);
  });

  // ── Libro de inventario ───────────────────────────────────────────────────
  it('el libro de inventario se puede leer: qué se movió, por qué y quién lo registró (8-02)', async () => {
    const producto = await app.inject({
      method: 'POST', url: '/products', headers: { cookie: gerencia },
      payload: { sku: `LIB-${nombreUnico('').slice(0, 8)}`, name: 'Agua del libro', priceCents: '2500', tracksInventory: true },
    });
    expect(producto.statusCode, producto.body).toBe(201);
    const productId = producto.json().id as string;
    const mover = (movementType: string, quantityDelta: number, reason: string) => app.inject({
      method: 'POST', url: '/inventory/movements', headers: { cookie: gerencia },
      payload: { branchId: cen, productId, movementType, quantityDelta, reason },
    });
    expect((await mover('PURCHASE', 24, 'Pedido del proveedor')).statusCode).toBe(201);
    expect((await mover('SHRINKAGE', -3, 'Se rompieron al descargar')).statusCode).toBe(201);
    expect((await mover('ADJUSTMENT', -1, 'Conteo del sábado')).statusCode).toBe(201);

    const res = await get(`/inventory/movements?branchId=${cen}&productId=${productId}`, gerencia);
    expect(res.statusCode, res.body).toBe(200);
    const libro = res.json();
    expect(diferenciasConElContrato(InventoryMovementList, libro)).toEqual([]);
    expect(libro).toMatchObject({ total: 3, hasMore: false, nextCursor: null });
    // Del más reciente al más viejo.
    expect(libro.items.map((m: { movementType: string }) => m.movementType)).toEqual(['ADJUSTMENT', 'SHRINKAGE', 'PURCHASE']);
    expect(libro.items[1]).toMatchObject({ quantityDelta: -3, reason: 'Se rompieron al descargar', productName: 'Agua del libro' });
    expect(libro.items[1].createdByName).toBeTruthy();

    const mermas = (await get(`/inventory/movements?branchId=${cen}&productId=${productId}&movementType=SHRINKAGE`, gerencia)).json();
    expect(mermas.total).toBe(1);
    const porPaginas = await recorrer<Fila>(`/inventory/movements?branchId=${cen}&productId=${productId}`, gerencia, 2);
    expect(porPaginas.paginas).toBe(2);
    expect(new Set(porPaginas.filas.map((m) => m.id)).size).toBe(3);

    // La dueña lo consulta; recepción vende, pero no lee el libro.
    expect((await get(`/inventory/movements?branchId=${cen}`, duena)).statusCode).toBe(200);
    expect((await get(`/inventory/movements?branchId=${cen}`, recepcion)).statusCode).toBe(403);
    // Sin sede no hay libro que leer.
    expect((await get('/inventory/movements', gerencia)).statusCode).toBe(422);
  });

  // ── Portal ────────────────────────────────────────────────────────────────
  async function portalDe(memberId: string): Promise<string> {
    const inv = await app.inject({ method: 'POST', url: `/members/${memberId}/portal-invite`, headers: { cookie: gerencia } });
    expect(inv.statusCode, inv.body).toBe(201);
    const act = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: inv.json().code } });
    expect(act.statusCode, act.body).toBe(201);
    return `gf_portal=${act.cookies.find((c) => c.name === 'gf_portal')!.value}`;
  }

  it('`/portal/me` trae la zona horaria: la de su sede de casa o, si no tiene, la del gimnasio', async () => {
    const socio = await nuevoSocio();
    const cookie = await portalDe(socio);
    const me = (await get('/portal/me', cookie)).json();
    expect(diferenciasConElContrato(PortalMe, me)).toEqual([]);
    const sede = await db().branch.findUniqueOrThrow({ where: { id: cen } });
    const org = await db().organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(me.timezone).toBe(sede.timezone ?? org.timezone);

    // Con una sede en otra zona, el socio de esa sede ve SU hora.
    const norte = await db().branch.findUniqueOrThrow({ where: { id: nor } });
    await db().branch.update({ where: { id: nor }, data: { timezone: 'America/Tijuana' } });
    try {
      const delNorte = await portalDe(await nuevoSocio(nor));
      expect((await get('/portal/me', delNorte)).json().timezone).toBe('America/Tijuana');
    } finally {
      await db().branch.update({ where: { id: nor }, data: { timezone: norte.timezone } });
    }
  });

  it('el estado de cuenta del socio va por páginas, dice «condonado» y nunca esconde lo que debe', async () => {
    const socio = await nuevoSocio();
    const viejo = await cargo(socio, '40000', '2025-02-01', 'Adeudo de 2025');
    const perdonado = await cargo(socio, '30000', '2026-09-01', 'Cuota perdonada');
    for (const d of ['2026-06-01', '2026-07-01', '2026-08-01']) await pagar(socio, '10000', (await cargo(socio, '10000', d)).id);
    const condonar = await app.inject({
      method: 'POST', url: `/charges/${perdonado.id}/adjustments`, headers: { cookie: gerencia },
      payload: {
        adjustmentType: 'WAIVER', amountCents: '30000', reasonCode: 'RETENCION', reason: 'Cortesía de la gerencia',
        approvalToken: await aprobacion(app, gerencia, 'billing:waiver:apply', undefined, undefined, { resourceId: perdonado.id, amountCents: '30000' }),
      },
    });
    expect(condonar.statusCode, condonar.body).toBe(201);
    const cookie = await portalDe(socio);

    const st = (await get('/portal/statement?limit=2', cookie)).json();
    expect(diferenciasConElContrato(PortalStatement, st)).toEqual([]);
    expect(st.pages.charges).toMatchObject({ total: 5, hasMore: true });
    expect(st.pages.payments).toMatchObject({ total: 3, hasMore: true });
    // Dos de la página más el adeudo viejo.
    expect(st.charges.map((c: Fila) => c.id)).toContain(viejo.id);
    expect(st.charges.find((c: Fila) => c.id === perdonado.id)).toMatchObject({ settledBy: 'WAIVER', balanceCents: '0' });

    const cargos = await recorrer<Fila>('/portal/statement/charges', cookie, 2);
    expect(cargos.total).toBe(5);
    expect(new Set(cargos.filas.map((c) => c.id)).size).toBe(5);
    const pagos = await recorrer<Fila>('/portal/statement/payments', cookie, 2);
    expect(new Set(pagos.filas.map((p) => p.id)).size).toBe(3);
    expect(diferenciasConElContrato(PortalChargesPage, (await get('/portal/statement/charges?limit=2', cookie)).json())).toEqual([]);
    expect(diferenciasConElContrato(PortalPaymentsPage, (await get('/portal/statement/payments?limit=2', cookie)).json())).toEqual([]);
    expect((await get('/portal/statement/charges?cursor=xx', cookie)).statusCode).toBe(422);
    // Sin `limit` siguen siendo los 24 de siempre.
    expect((await get('/portal/statement', cookie)).json().charges).toHaveLength(5);
  });

  it('el 401 del portal dice por qué terminó la sesión (`reason`), como el del personal', async () => {
    const motivo = async (cookie?: string) => {
      const res = await app.inject({ method: 'GET', url: '/portal/me', ...(cookie ? { headers: { cookie } } : {}) });
      expect(res.statusCode, res.body).toBe(401);
      expect(res.json().message).toBeTruthy();
      return res.json().reason as string;
    };
    const idDe = async (cookie: string) => {
      const { hashToken } = await import('../src/platform/crypto.js');
      return (await db().memberSession.findFirstOrThrow({ where: { tokenHash: hashToken(cookie.replace('gf_portal=', '')) } })).id;
    };

    expect(await motivo()).toBe('NO_SESSION');
    expect(await motivo('gf_portal=una-cookie-que-nadie-emitio')).toBe('NO_SESSION');

    // Salió en este teléfono.
    const socio = await nuevoSocio();
    const uno = await portalDe(socio);
    await app.inject({ method: 'POST', url: '/portal/logout', headers: { cookie: uno }, payload: {} });
    expect(await motivo(uno)).toBe('SESSION_LOGGED_OUT');

    // Recepción lo cerró en todos sus teléfonos.
    const dos = await portalDe(socio);
    expect((await app.inject({ method: 'POST', url: `/members/${socio}/portal-sessions/revoke`, headers: { cookie: gerencia } })).statusCode).toBe(200);
    expect(await motivo(dos)).toBe('SESSION_CLOSED_EVERYWHERE');

    // Llegó a su fecha tope.
    const tres = await portalDe(socio);
    await db().memberSession.update({ where: { id: await idDe(tres) }, data: { createdAt: new Date(Date.now() - 31 * 86_400_000), expiresAt: new Date(Date.now() - 60_000) } });
    expect(await motivo(tres)).toBe('SESSION_EXPIRED');

    // Pasó una semana sin abrirlo.
    const cuatro = await portalDe(socio);
    await db().memberSession.update({ where: { id: await idDe(cuatro) }, data: { lastSeenAt: new Date(Date.now() - 8 * 86_400_000) } });
    expect(await motivo(cuatro)).toBe('SESSION_IDLE');

    // El socio se dio de baja.
    const otro = await nuevoSocio();
    const cinco = await portalDe(otro);
    await db().member.update({ where: { id: otro }, data: { deletedAt: new Date() } });
    expect(await motivo(cinco)).toBe('ACCOUNT_DEACTIVATED');
  });

  // ── Lo que no vio no lo puede borrar ──────────────────────────────────────
  it('quien recibe el contacto oculto (null por permiso) no lo borra al guardar la ficha (1.1 §7-6)', async () => {
    // Una gerencia acotada a Centro edita a un socio de Norte: el contacto le llega en null.
    const acotada = await loginAs(app, await cuentaDePrueba(orgId, 'MANAGER', [cen]));
    const socio = await nuevoSocio(nor);
    const antes = await db().member.findUniqueOrThrow({ where: { id: socio } });
    expect(antes.phoneE164).toBeTruthy();

    const ficha = (await get(`/members/${socio}`, acotada)).json();
    // Si esta cuenta sí viera el contacto, el caso no aplica: la regla la fija `vista()`.
    expect(ficha.phoneE164).toBeNull();

    // El formulario devuelve lo que recibió: nombre nuevo y contacto en null.
    const guardar = await app.inject({
      method: 'PATCH', url: `/members/${socio}`, headers: { cookie: acotada },
      payload: { firstName: 'Corregido', phoneE164: null, email: null, emergencyContactName: null, emergencyContactPhone: null },
    });
    expect(guardar.statusCode, guardar.body).toBe(200);
    const despues = await db().member.findUniqueOrThrow({ where: { id: socio } });
    expect(despues.firstName).toBe('Corregido');
    expect(despues.phoneE164).toBe(antes.phoneE164);

    // Y no escribe a ciegas encima de un dato que no puede ver.
    const pisar = await app.inject({ method: 'PATCH', url: `/members/${socio}`, headers: { cookie: acotada }, payload: { phoneE164: telefonoUnico() } });
    expect(pisar.statusCode, pisar.body).toBe(403);
    expect((await db().member.findUniqueOrThrow({ where: { id: socio } })).phoneE164).toBe(antes.phoneE164);

    // Quien sí lo ve lo sigue pudiendo borrar a propósito.
    await db().member.update({ where: { id: socio }, data: { email: 'borrar@ejemplo.mx' } });
    const borrar = await app.inject({ method: 'PATCH', url: `/members/${socio}`, headers: { cookie: gerencia }, payload: { email: null } });
    expect(borrar.statusCode, borrar.body).toBe(200);
    expect((await db().member.findUniqueOrThrow({ where: { id: socio } })).email).toBeNull();
  });
});
