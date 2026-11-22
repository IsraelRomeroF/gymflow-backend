import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { effectiveSections, masDias, onlyEffectiveSections } from '@gymflow/core';
import { makeApp, loginAs, loginPlataforma, correoUnico, PASSWORD } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import {
  estadoDeCobro, estadoDeFactura, hoyDeCobro, mesDeCobro, motivoDeNoEmitir, venceEl, type FacturaDeMarca,
} from '../src/modules/tenants/cobro-reglas.js';
import { emitirElMes } from '../src/modules/tenants/platform-billing.jobs.js';
import { PlatformBillingRepository } from '../src/modules/tenants/platform-billing.repository.js';
import { PlatformBillingService } from '../src/modules/tenants/platform-billing.service.js';

/**
 * COBRO DE PLATAFORMA (auditoría 8, bloque 1.13): estado único, emisión en
 * hora de la Ciudad de México sin cortar el lote, vista previa, pago con
 * importe y referencia, abonos y deshacer; y los asientos de la consola.
 *
 * Las reglas se prueban con fechas fijas (funciones puras); lo que pasa por
 * la API usa el mes en curso y no afirma nada que dependa del día del mes.
 */
describe('cobro de plataforma · reglas con fecha fija', () => {
  const factura = (x: Partial<FacturaDeMarca> = {}): FacturaDeMarca => ({ status: 'PENDING', totalCents: 230000n, paidCents: 0n, dueDate: '2026-11-11', periodStart: '2026-11-01', ...x });

  it('hoy y el mes son los de la Ciudad de México, no los de UTC (23-12, 23-14)', () => {
    // Las 21:00 del 30 de noviembre en México ya son 1 de diciembre en UTC.
    const noche = new Date('2026-12-01T03:00:00.000Z');
    expect(hoyDeCobro(noche)).toBe('2026-11-30');
    expect(mesDeCobro(noche)).toBe('2026-11');
    expect(mesDeCobro(new Date('2026-12-01T06:00:00.000Z'))).toBe('2026-12');
    expect(venceEl('2026-11-30')).toBe('2026-12-10');
  });

  it('una factura tiene UN estado: pendiente, pagada en parte, vencida, pagada o anulada', () => {
    expect(estadoDeFactura(factura(), '2026-11-05')).toBe('PENDIENTE');
    expect(estadoDeFactura(factura({ paidCents: 100000n }), '2026-11-05')).toBe('PAGADA_EN_PARTE');
    // El día del vencimiento todavía está en plazo; al siguiente, vencida (aunque tenga abonos).
    expect(estadoDeFactura(factura(), '2026-11-11')).toBe('PENDIENTE');
    expect(estadoDeFactura(factura({ paidCents: 100000n }), '2026-11-12')).toBe('VENCIDA');
    expect(estadoDeFactura(factura({ status: 'PAID', paidCents: 230000n }), '2026-12-30')).toBe('PAGADA');
    expect(estadoDeFactura(factura({ status: 'VOID' }), '2026-12-30')).toBe('ANULADA');
  });

  it('el estado de cobro mira el mes en curso: con historial y un precio faltante NO está al corriente (23-02)', () => {
    const base = { serviceStatus: 'ACTIVE', liberadaEl: '2026-09-15', sinPrecio: false, hoy: '2026-11-20' };
    const octubrePagada = factura({ status: 'PAID', paidCents: 230000n, periodStart: '2026-10-01', dueDate: '2026-10-11' });
    const noviembre = factura();
    // Pagó octubre y en noviembre se le contrató algo sin precio: antes salía «Al corriente».
    expect(estadoDeCobro({ ...base, facturas: [octubrePagada], sinPrecio: true }).code).toBe('NO_FACTURABLE');
    // En uso, pasado el día 3 y sin la factura del mes.
    expect(estadoDeCobro({ ...base, facturas: [octubrePagada], hoy: '2026-11-04' }).code).toBe('SIN_FACTURA_DEL_MES');
    expect(estadoDeCobro({ ...base, facturas: [octubrePagada], hoy: '2026-11-03' }).code).toBe('AL_CORRIENTE');
    expect(estadoDeCobro({ ...base, facturas: [], hoy: '2026-11-04' }).code).toBe('SIN_FACTURA_DEL_MES');
    // Una anulada no cuenta como la del mes.
    expect(estadoDeCobro({ ...base, facturas: [factura({ status: 'VOID' })] }).code).toBe('SIN_FACTURA_DEL_MES');
    // Vencida gana a todo y dice cuántos días y cuánto falta (lo abonado no se debe).
    const vencida = estadoDeCobro({ ...base, facturas: [factura({ paidCents: 30000n })], sinPrecio: true });
    expect(vencida).toEqual({ code: 'VENCIDA', overdueDays: 9, pendingCents: 200000n });
    expect(estadoDeCobro({ ...base, facturas: [octubrePagada, noviembre], hoy: '2026-11-08' }).code).toBe('POR_VENCER');
    expect(estadoDeCobro({ ...base, facturas: [octubrePagada, factura({ status: 'PAID', paidCents: 230000n })] }).code).toBe('AL_CORRIENTE');
    // A la que no está en uso no se le cobra: ni «al corriente» ni «sin factura».
    expect(estadoDeCobro({ ...base, serviceStatus: 'PENDING', facturas: [] }).code).toBe('SIN_COBRO');
    expect(estadoDeCobro({ ...base, serviceStatus: 'SUSPENDED', facturas: [noviembre] }).code).toBe('VENCIDA');
  });

  it('a quién y de qué mes se emite: una sola regla para la marca suelta y para el lote (23-06)', () => {
    const base = { mes: '2026-11', hoy: '2026-11-20', serviceStatus: 'ACTIVE', liberadaEl: '2026-09-15', yaTieneFactura: false, sinPrecio: [] as string[], totalCents: 230000n };
    expect(motivoDeNoEmitir(base)).toBeNull();
    expect(motivoDeNoEmitir({ ...base, serviceStatus: 'SUSPENDED' })?.reason).toBe('NOT_IN_USE');
    expect(motivoDeNoEmitir({ ...base, serviceStatus: 'PENDING' })?.reason).toBe('NOT_IN_USE');
    expect(motivoDeNoEmitir({ ...base, mes: '2026-12' })?.reason).toBe('FUTURE_MONTH');
    expect(motivoDeNoEmitir({ ...base, mes: '2026-08' })?.reason).toBe('BEFORE_RELEASE');
    expect(motivoDeNoEmitir({ ...base, mes: '2026-09' })).toBeNull();
    expect(motivoDeNoEmitir({ ...base, yaTieneFactura: true })?.reason).toBe('ALREADY_INVOICED');
    expect(motivoDeNoEmitir({ ...base, sinPrecio: ['Clases'] })).toEqual({ reason: 'MISSING_PRICES', texto: 'Sin precio: Clases' });
    expect(motivoDeNoEmitir({ ...base, totalCents: 0n })?.reason).toBe('ZERO_TOTAL');
  });
});

describe('cobro de plataforma · API', () => {
  let app: FastifyInstance;
  let plataforma: string;
  let preciosDeAntes: Array<{ moduleKey: string; monthlyCents: bigint }> = [];
  const sufijo = Date.now().toString(36).toUpperCase().slice(-5);
  const mes = mesDeCobro();
  const hoy = hoyDeCobro();
  const cabeceras = () => ({ cookie: plataforma });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: cabeceras() });
  const post = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, headers: cabeceras(), payload });
  const put = (url: string, payload: object) => app.inject({ method: 'PUT', url, headers: cabeceras(), payload });
  const asientos = (action: string, donde: object = {}) => getDb().platformAuditLog.count({ where: { action, ...donde } });

  /** Una marca propia de la prueba con Caja y Clases contratadas: $1,500 + $300 + $500 = $2,300 al mes. */
  async function marca(nombre: string, liberar = true): Promise<string> {
    const correo = (rol: string) => correoUnico(`${rol}.${nombre.toLowerCase()}`);
    const alta = await post('/platform/organizations', {
      legalName: `${nombre} ${sufijo} S.A.`, tradeName: `${nombre} ${sufijo}`, template: 'cadena', contracted: ['cash', 'classes'],
      branch: { code: 'COB', name: 'Matriz' },
      owner: { fullName: `Ana ${nombre} Prueba`, email: correo('duena') }, manager: { fullName: `Beto ${nombre} Prueba`, email: correo('gerente') },
      reason: 'Prueba del cobro de plataforma',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json().organizationId as string;
    if (liberar) expect((await post(`/platform/organizations/${id}/service`, { status: 'ACTIVE', reason: 'Contrato firmado' })).statusCode).toBe(200);
    return id;
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    plataforma = await loginPlataforma(app);
    // `platform_prices` es global (23-19): se guardan los que había y se devuelven al terminar.
    preciosDeAntes = await getDb().platformPrice.findMany({ select: { moduleKey: true, monthlyCents: true } });
    const r = await put('/platform/prices', { prices: [{ key: 'core', monthlyCents: '150000' }, { key: 'cash', monthlyCents: '30000' }, { key: 'classes', monthlyCents: '50000' }] });
    expect(r.statusCode, r.body).toBe(200);
  });
  afterAll(async () => {
    const antes = new Map(preciosDeAntes.map((p) => [p.moduleKey, p.monthlyCents]));
    for (const k of ['core', 'cash', 'classes']) {
      if (antes.has(k)) await getDb().platformPrice.update({ where: { moduleKey: k }, data: { monthlyCents: antes.get(k)! } });
    }
    await app.close(); await closeDb();
  });

  it('precios en lote: una transacción y UN asiento con el antes y el después (23-09)', async () => {
    const antes = await asientos('platform.catalog.price.update');
    const r = await put('/platform/prices', { prices: [{ key: 'core', monthlyCents: '150100' }, { key: 'cash', monthlyCents: '30000' }, { key: 'classes', monthlyCents: '50100' }] });
    expect(r.statusCode, r.body).toBe(200);
    // Caja no cambió: no cuenta.
    expect(r.json().changed).toBe(2);
    expect(await asientos('platform.catalog.price.update')).toBe(antes + 1);
    const asiento = await getDb().platformAuditLog.findFirstOrThrow({ where: { action: 'platform.catalog.price.update' }, orderBy: [{ at: 'desc' }, { id: 'desc' }] });
    expect(asiento.beforeState).toEqual({ prices: { core: '150000', classes: '50000' } });
    expect((asiento.afterState as { prices: unknown }).prices).toEqual({ core: '150100', classes: '50100' });
    expect(asiento.actorUserId).toBeTruthy();
    // Lo mismo otra vez no cambia nada y no asienta.
    expect((await put('/platform/prices', { prices: [{ key: 'core', monthlyCents: '150100' }] })).json().changed).toBe(0);
    expect(await asientos('platform.catalog.price.update')).toBe(antes + 1);
    // Un concepto que no existe tumba el lote entero: el otro precio no se movió.
    expect((await put('/platform/prices', { prices: [{ key: 'core', monthlyCents: '999900' }, { key: 'no_existe', monthlyCents: '100' }] })).statusCode).toBe(404);
    expect((await get('/platform/prices')).json().prices.find((p: { key: string }) => p.key === 'core').monthlyCents).toBe('150100');
    // El 422 dice qué campo y por qué, en español.
    const mal = await put('/platform/prices', { prices: [{ key: 'core', monthlyCents: '15.50' }] });
    expect(mal.statusCode).toBe(422);
    expect(JSON.stringify(mal.json())).toMatch(/centavos/);
    // De vuelta a los de la prueba (la ruta de un solo precio también asienta).
    expect((await put('/platform/prices/core', { monthlyCents: '150000' })).statusCode).toBe(200);
    expect((await put('/platform/prices/classes', { monthlyCents: '50000' })).statusCode).toBe(200);
    expect(await asientos('platform.catalog.price.update')).toBe(antes + 3);
  });

  it('planes de GymFlow: crear y cambiar dejan asiento con lo de antes y lo de ahora (23-09)', async () => {
    const creado = await post('/platform/plans', { name: `Plan cobro ${sufijo}`, modules: ['cash'], monthlyCents: '180000' });
    expect(creado.statusCode, creado.body).toBe(201);
    const id = creado.json().id as string;
    expect(await asientos('platform.catalog.plan.create', { resourceId: id })).toBe(1);
    expect((await put(`/platform/plans/${id}`, { monthlyCents: '200000', isActive: false })).statusCode).toBe(200);
    const cambio = await getDb().platformAuditLog.findFirstOrThrow({ where: { action: 'platform.catalog.plan.update', resourceId: id } });
    expect(cambio.beforeState).toMatchObject({ monthlyCents: '180000', isActive: true });
    expect(cambio.afterState).toMatchObject({ monthlyCents: '200000', isActive: false });
    expect((await put('/platform/plans/00000000-0000-7000-8000-000000000000', { name: 'No existe' })).statusCode).toBe(404);
  });

  it('reglas de emisión: solo a una marca en uso, nunca de un mes futuro ni anterior a su liberación, una por mes (23-06)', async () => {
    const id = await marca('Reglas', false);
    const emitir = (m?: string) => post(`/platform/organizations/${id}/invoices`, m ? { month: m } : {});
    // Sin liberar no se le factura, y la ficha no dice «al corriente».
    const sinLiberar = await emitir();
    expect(sinLiberar.statusCode).toBe(409);
    expect(sinLiberar.json().reason).toBe('ORG_NOT_IN_USE');
    expect((await get(`/platform/organizations/${id}/billing`)).json().status.code).toBe('SIN_COBRO');
    expect((await post(`/platform/organizations/${id}/service`, { status: 'ACTIVE', reason: 'Contrato firmado' })).statusCode).toBe(200);

    const futuro = await emitir(masDias(`${mes}-28`, 10).slice(0, 7));
    expect(futuro.statusCode).toBe(409);
    expect(futuro.json().reason).toBe('MONTH_NOT_BILLABLE');
    const antesDeLiberar = await emitir(masDias(`${mes}-01`, -1).slice(0, 7));
    expect(antesDeLiberar.statusCode).toBe(409);
    expect(antesDeLiberar.json().reason).toBe('MONTH_NOT_BILLABLE');
    expect((await emitir('2026-13')).statusCode).toBe(422);

    const resumen = (await get(`/platform/organizations/${id}/billing`)).json();
    expect(resumen.month).toBe(mes);
    expect(resumen.billableMonths).toEqual([{ month: mes, invoiced: false }]);
    expect(resumen.monthly.totalCents).toBe('230000');

    // Sin mes: el mes en curso en la Ciudad de México; vence 10 días después de hoy allá.
    const ok = await emitir();
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ periodStart: `${mes}-01`, dueDate: masDias(hoy, 10), totalCents: '230000', paidCents: '0', balanceCents: '230000', state: 'PENDIENTE', issuedOn: hoy });
    const otra = await emitir();
    expect(otra.statusCode).toBe(409);
    expect(otra.json().reason).toBe('MONTH_ALREADY_INVOICED');
    const ficha = (await get(`/platform/organizations/${id}/billing`)).json();
    expect(ficha.status).toEqual({ code: 'POR_VENCER', overdueDays: 0, pendingCents: '230000' });
    expect(ficha.billableMonths).toEqual([{ month: mes, invoiced: true }]);
    // La lista de Marcas dice lo mismo que la ficha: es la misma función.
    const enLista = (await get('/platform/organizations')).json().organizations.find((o: { id: string }) => o.id === id);
    expect(enLista.billing).toEqual({ status: 'POR_VENCER', pendingCents: '230000', overdueDays: 0 });

    // Suspendida: tampoco se le emite (se anula la viva para probarlo con el mes libre).
    expect((await post(`/platform/invoices/${ok.json().id}/void`, { reason: 'Prueba de reglas' })).json().state).toBe('ANULADA');
    expect((await post(`/platform/organizations/${id}/service`, { status: 'SUSPENDED', reason: 'Falta de pago' })).statusCode).toBe(200);
    expect((await emitir()).json().reason).toBe('ORG_NOT_IN_USE');
  });

  it('vista previa: lo que se ve antes de emitir es lo que se emite (23-05)', async () => {
    const id = await marca('Previa');
    const sola = await get(`/platform/invoices/issue-month/preview?organizationId=${id}`);
    expect(sola.statusCode, sola.body).toBe(200);
    expect(sola.json()).toMatchObject({ month: mes, dueDate: masDias(hoy, 10), totalCents: '230000', skipped: [] });
    expect(sola.json().toIssue).toHaveLength(1);
    expect(sola.json().toIssue[0]).toMatchObject({ organizationId: id, totalCents: '230000' });
    expect((await get('/platform/invoices/issue-month/preview?month=2026-00')).statusCode).toBe(422);

    const lote = (await get('/platform/invoices/issue-month/preview')).json();
    const anunciadas = lote.toIssue.map((x: { organizationId: string }) => x.organizationId).sort();
    expect(anunciadas).toContain(id);
    // Cada saltada dice por qué, con su clave.
    for (const s of lote.skipped) { expect(s.reason.length).toBeGreaterThan(5); expect(s.code).toMatch(/^[A-Z_]+$/); }

    const antes = await asientos('platform.invoices.issue_month');
    const emitido = await post('/platform/invoices/issue-month', { month: mes });
    expect(emitido.statusCode, emitido.body).toBe(200);
    const r = emitido.json() as { month: string; issued: Array<{ organizationId: string; totalCents: string; folio: string }>; skipped: Array<{ organizationId: string; code: string }>; failed: unknown[] };
    expect(r.issued.map((x) => x.organizationId).sort()).toEqual(anunciadas);
    expect(r.failed).toEqual([]);
    expect(r.issued.find((x) => x.organizationId === id)!.totalCents).toBe('230000');
    // El lote deja UN asiento en la cadena de plataforma, con quién lo emitió.
    expect(await asientos('platform.invoices.issue_month')).toBe(antes + 1);
    const asiento = await getDb().platformAuditLog.findFirstOrThrow({ where: { action: 'platform.invoices.issue_month' }, orderBy: [{ at: 'desc' }, { id: 'desc' }] });
    expect(asiento.afterState).toMatchObject({ month: mes, issued: r.issued.length, failed: 0 });
    expect(asiento.actorUserId).toBeTruthy();

    // Otra vez: nada nuevo, y la vista previa ya lo decía.
    const despues = (await get(`/platform/invoices/issue-month/preview?organizationId=${id}`)).json();
    expect(despues.toIssue).toEqual([]);
    expect(despues.skipped[0]).toMatchObject({ code: 'ALREADY_INVOICED', reason: 'Ya tiene factura de ese mes' });
    const segunda = (await post('/platform/invoices/issue-month', { month: mes })).json() as typeof r;
    expect(segunda.issued).toEqual([]);
    expect(await asientos('platform.invoices.issue_month')).toBe(antes + 1);
    // Limpieza: lo que emitió esta prueba a OTRAS marcas se anula (las facturas no se borran).
    for (const x of r.issued.filter((y) => y.organizationId !== id)) {
      const f = await getDb().platformInvoice.findFirstOrThrow({ where: { folio: x.folio }, select: { id: true } });
      expect((await post(`/platform/invoices/${f.id}/void`, { reason: 'Emitida por la prueba del cobro' })).statusCode).toBe(200);
    }
  });

  it('pago con importe y referencia, abonos y deshacer (23-07, 23-08, 23-15, 23-16)', async () => {
    const id = await marca('Abonos');
    const f = (await post(`/platform/organizations/${id}/invoices`)).json() as { id: string; folio: string };
    const pagar = (payload: object) => post(`/platform/invoices/${f.id}/pay`, payload);

    // La referencia es obligatoria en transferencia y tarjeta: el 422 dice en qué campo.
    const sinRef = await pagar({ paymentMethod: 'SPEI_TRANSFER', amountCents: '100000' });
    expect(sinRef.statusCode).toBe(422);
    expect(sinRef.json().issues).toEqual([expect.objectContaining({ path: 'paymentRef', message: expect.stringMatching(/clave de rastreo/) })]);
    expect((await pagar({ paymentMethod: 'CARD' })).statusCode).toBe(422);
    // Ni más de lo que debe, ni en cero, ni con fecha de mañana.
    const deMas = await pagar({ paymentMethod: 'CASH', amountCents: '230001' });
    expect(deMas.statusCode).toBe(409);
    expect(deMas.json().reason).toBe('AMOUNT_OVER_BALANCE');
    expect(deMas.json().message).toMatch(/\$2,300\.00/);
    expect((await pagar({ paymentMethod: 'CASH', amountCents: '0' })).statusCode).toBe(422);
    expect((await pagar({ paymentMethod: 'CASH', paidOn: masDias(hoy, 1) })).statusCode).toBe(422);
    expect((await pagar({ paymentMethod: 'CASH', paidOn: '2026-02-31' })).statusCode).toBe(422);

    // Primer abono: la factura sigue debiendo y lo dice.
    const ayer = masDias(hoy, -1);
    const abono = await pagar({ paymentMethod: 'SPEI_TRANSFER', amountCents: '100000', paymentRef: 'SPEI 0001234', paidOn: ayer });
    expect(abono.statusCode, abono.body).toBe(200);
    expect(abono.json()).toMatchObject({ status: 'PENDING', state: 'PAGADA_EN_PARTE', paidCents: '100000', balanceCents: '130000', paidOn: ayer });
    expect(abono.json().payments).toEqual([expect.objectContaining({ amountCents: '100000', paymentMethod: 'SPEI_TRANSFER', paymentRef: 'SPEI 0001234', paidOn: ayer, undone: false, canUndo: true })]);
    expect((await get(`/platform/organizations/${id}/billing`)).json().status).toMatchObject({ code: 'POR_VENCER', pendingCents: '130000' });

    // Sin importe se paga lo que falta; en efectivo no hace falta referencia.
    const resto = await pagar({ paymentMethod: 'CASH' });
    expect(resto.statusCode, resto.body).toBe(200);
    expect(resto.json()).toMatchObject({ status: 'PAID', state: 'PAGADA', paidCents: '230000', balanceCents: '0', paidOn: hoy, paymentMethod: 'CASH' });
    expect(resto.json().payments).toHaveLength(2);
    expect((await get(`/platform/organizations/${id}/billing`)).json().status).toMatchObject({ code: 'AL_CORRIENTE', pendingCents: '0' });
    const yaPagada = await pagar({ paymentMethod: 'CASH' });
    expect(yaPagada.statusCode).toBe(409);
    expect(yaPagada.json().reason).toBe('ALREADY_PAID');
    const anularPagada = await post(`/platform/invoices/${f.id}/void`, { reason: 'No debe dejar' });
    expect(anularPagada.statusCode).toBe(409);
    expect(anularPagada.json().reason).toBe('ALREADY_PAID');

    // Deshacer el segundo pago: con motivo; la factura vuelve a deber ese importe.
    const [primero, segundo] = resto.json().payments as Array<{ id: string }>;
    const deshacer = (pagoId: string, payload: object) => post(`/platform/invoices/${f.id}/payments/${pagoId}/undo`, payload);
    const sinMotivo = await deshacer(segundo!.id, { reason: ' ' });
    expect(sinMotivo.statusCode).toBe(422);
    expect(sinMotivo.json().issues[0]).toMatchObject({ path: 'reason', message: expect.stringMatching(/motivo/) });
    const deshecho = await deshacer(segundo!.id, { reason: 'El pago era de otra marca' });
    expect(deshecho.statusCode, deshecho.body).toBe(200);
    expect(deshecho.json()).toMatchObject({ status: 'PENDING', state: 'PAGADA_EN_PARTE', paidCents: '100000', balanceCents: '130000', paidOn: ayer, paymentMethod: 'SPEI_TRANSFER', paymentRef: 'SPEI 0001234' });
    expect(deshecho.json().payments[1]).toMatchObject({ undone: true, undoReason: 'El pago era de otra marca', canUndo: false });
    const otraVez = await deshacer(segundo!.id, { reason: 'Otra vez' });
    expect(otraVez.statusCode).toBe(409);
    expect(otraVez.json().reason).toBe('ALREADY_REVERSED');
    expect((await deshacer('00000000-0000-7000-8000-000000000000', { reason: 'No existe' })).statusCode).toBe(404);

    // Con un pago vivo no se anula; pasado el plazo ya no se deshace.
    const conPagos = await post(`/platform/invoices/${f.id}/void`, { reason: 'No debe dejar' });
    expect(conPagos.statusCode).toBe(409);
    expect(conPagos.json().reason).toBe('INVOICE_HAS_PAYMENTS');
    const usuario = (await get('/platform/me')).json().userId as string;
    const servicio = new PlatformBillingService();
    await expect(servicio.deshacerPago(f.id, primero!.id, usuario, 'Tarde', new Date(Date.now() + 8 * 86_400_000))).rejects.toMatchObject({ reason: 'UNDO_WINDOW_CLOSED' });
    const limpio = await deshacer(primero!.id, { reason: 'Se capturó otro importe' });
    expect(limpio.json()).toMatchObject({ state: 'PENDIENTE', paidCents: '0', balanceCents: '230000', paidOn: null, paymentMethod: null, paymentRef: null });
    // El comprobante trae todos los pagos, también los deshechos.
    const detalle = (await get(`/platform/invoices/${f.id}`)).json();
    expect(detalle.payments.map((p: { undone: boolean }) => p.undone)).toEqual([true, true]);
    expect(detalle.organization.tradeName).toBe(`Abonos ${sufijo}`);
    expect((await post(`/platform/invoices/${f.id}/void`, { reason: 'Se emitió por error' })).json()).toMatchObject({ status: 'VOID', state: 'ANULADA' });

    // Todo quedó en la bitácora de la marca, con su importe, y en la cadena de plataforma.
    const db = getDb();
    const suyos = await db.auditLog.findMany({ where: { organizationId: id, action: { startsWith: 'platform.invoice.' } }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { action: true, afterState: true, reason: true } });
    expect(suyos.map((a) => a.action)).toEqual(['platform.invoice.issue', 'platform.invoice.pay', 'platform.invoice.pay', 'platform.invoice.payment.undo', 'platform.invoice.payment.undo', 'platform.invoice.void']);
    expect(suyos[1]!.afterState).toMatchObject({ amountCents: '100000', balanceCents: '130000', paid: false, paymentRef: 'SPEI 0001234' });
    expect(suyos[3]).toMatchObject({ reason: 'El pago era de otra marca', afterState: { amountCents: '130000' } });
    expect(await asientos('platform.invoice.payment.undo', { organizationId: id })).toBe(2);
    const cadena = (await get(`/platform/audit?organizationId=${id}&limit=20`)).json().entries as Array<{ action: string; phrase: string }>;
    expect(cadena.find((e) => e.action === 'platform.invoice.payment.undo')!.phrase).toMatch(/deshizo un pago de una factura de \$/);
  });

  it('el pago acepta la forma anterior (`paidAt`) y Cobranza trae cada factura con su estado', async () => {
    const id = await marca('Cobranza');
    const f = (await post(`/platform/organizations/${id}/invoices`)).json() as { id: string };
    const r = await post(`/platform/invoices/${f.id}/pay`, { paymentMethod: 'SPEI_TRANSFER', paymentRef: 'RASTREO-9', paidAt: `${masDias(hoy, -2)}T12:00:00.000Z` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().paidOn).toBe(masDias(hoy, -2));
    const cobranza = (await get(`/platform/billing?month=${mes}`)).json();
    expect(cobranza.month).toBe(mes);
    expect(cobranza.withoutInvoiceThisMonth).toBeGreaterThanOrEqual(0);
    expect(cobranza.withoutInvoiceThisMonth).toBeLessThanOrEqual(cobranza.monthlyIncome.organizations);
    const suya = cobranza.invoices.find((x: { id: string }) => x.id === f.id);
    expect(suya).toMatchObject({ state: 'PAGADA', tradeName: `Cobranza ${sufijo}`, balanceCents: '0', overdueDays: 0 });
    expect((await get('/platform/billing?month=2026-13')).statusCode).toBe(422);
  });

  it('el job emite con el día de la Ciudad de México y una marca que falla no corta el lote (23-12)', { timeout: 120_000 }, async () => {
    const [a, b] = [await marca('LoteA'), await marca('LoteB')];
    const db = getDb();
    const de = (org: string) => db.platformInvoice.findFirst({ where: { organizationId: org, periodStart: new Date('2027-04-01T00:00:00.000Z'), status: { not: 'VOID' } } });

    // Las 21:00 del 31 de marzo en México: en UTC ya es 1 de abril. No se emite abril un día antes.
    const vispera = await emitirElMes(new Date('2027-04-01T03:00:00.000Z'));
    expect(vispera).toMatchObject({ processed: 0, skipped: 1, errors: [] });
    expect(await de(a)).toBeNull();

    // Ya es 1 de abril allá. La emisión de la marca A falla: B recibe la suya y el error dice de quién fue.
    const original = PlatformBillingRepository.prototype.issue;
    const espia = vi.spyOn(PlatformBillingRepository.prototype, 'issue').mockImplementation(function (this: PlatformBillingRepository, input) {
      if (input.organizationId === a) return Promise.reject(new Error('fallo provocado por la prueba'));
      return original.call(this, input);
    });
    const antes = await asientos('platform.invoices.issue_month');
    let dia1;
    try { dia1 = await emitirElMes(new Date('2027-04-01T07:00:00.000Z')); } finally { espia.mockRestore(); }
    expect(dia1.errors.filter((e) => e.entityId === a)).toEqual([{ entityId: a, error: `LoteA ${sufijo}: fallo provocado por la prueba` }]);
    expect(dia1.processed).toBeGreaterThanOrEqual(1);
    expect(await de(a)).toBeNull();
    const deB = await de(b);
    expect(deB).toMatchObject({ status: 'PENDING', totalCents: 230000n });
    // Emitida el 1 de abril de México: vence el 11.
    expect(deB!.dueDate.toISOString().slice(0, 10)).toBe('2027-04-11');
    const asiento = await db.platformAuditLog.findFirstOrThrow({ where: { action: 'platform.invoices.issue_month' }, orderBy: [{ at: 'desc' }, { id: 'desc' }] });
    expect(await asientos('platform.invoices.issue_month')).toBe(antes + 1);
    expect(asiento.afterState).toMatchObject({ month: '2027-04', failed: 1 });
    expect(asiento.actorUserId).toBeNull();

    // El día 2 lo alcanza: A recibe la suya y a nadie se le repite.
    const dia2 = await emitirElMes(new Date('2027-04-02T18:00:00.000Z'));
    expect(dia2.errors.filter((e) => e.entityId === a)).toEqual([]);
    expect(await de(a)).toMatchObject({ status: 'PENDING' });
    expect((await db.platformInvoice.count({ where: { organizationId: b, periodStart: new Date('2027-04-01T00:00:00.000Z') } }))).toBe(1);
    const dia3 = await emitirElMes(new Date('2027-04-03T18:00:00.000Z'));
    expect(dia3.processed).toBe(0);
    // Pasado el día de gracia ya no emite.
    expect(await emitirElMes(new Date('2027-04-04T18:00:00.000Z'))).toMatchObject({ processed: 0, skipped: 1 });

    // Limpieza: las facturas de abril de 2027 que dejó la prueba, en cualquier marca, se anulan.
    const servicio = new PlatformBillingService();
    for (const f of await db.platformInvoice.findMany({ where: { periodStart: new Date('2027-04-01T00:00:00.000Z'), status: 'PENDING' }, select: { id: true } })) {
      await servicio.anular(f.id, (await get('/platform/me')).json().userId, 'Emitida por la prueba del job');
    }
  });

  it('la consola deja rastro: entrar, reconfirmar, cambiar contraseña, cerrar las otras y salir (24-19)', async () => {
    const cookie = await loginPlataforma(app);
    const yo = (await app.inject({ method: 'GET', url: '/platform/me', headers: { cookie } })).json() as { userId: string; session: { secondsLeft: number; endsAt: string; startedAt: string } };
    // La sesión dice cuánto le queda (tope de 8 h): la consola avisa antes de que se cierre.
    expect(yo.session.secondsLeft).toBeGreaterThan(8 * 3600 - 120);
    expect(yo.session.secondsLeft).toBeLessThanOrEqual(8 * 3600);
    // Ocho horas desde que entró (el alta de la sesión y su vencimiento se sellan con un milisegundo de diferencia).
    expect(Math.abs(new Date(yo.session.endsAt).getTime() - new Date(yo.session.startedAt).getTime() - 8 * 3600_000)).toBeLessThan(1000);

    const mios = (action: string) => asientos(action, { actorUserId: yo.userId });
    expect(await mios('platform.console.login')).toBe(1);
    expect(await mios('platform.console.reauth')).toBe(1);
    // Una reconfirmación fallida no asienta «reconfirmó».
    expect((await app.inject({ method: 'POST', url: '/platform/reauth', headers: { cookie }, payload: { password: 'no-es-la-buena' } })).statusCode).not.toBe(200);
    expect(await mios('platform.console.reauth')).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/platform/sessions/close-others', headers: { cookie }, payload: {} })).statusCode).toBe(200);
    expect(await mios('platform.console.sessions_close_others')).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/platform/password', headers: { cookie }, payload: { current: PASSWORD, next: 'Una contraseña larga y nueva 2026' } })).statusCode).toBe(200);
    expect(await mios('platform.console.password_change')).toBe(1);

    // «Lo que hizo la plataforma» lo lee de la cadena, con quién y con frase; y se verifica.
    const cadena = (await app.inject({ method: 'GET', url: `/platform/audit?actorUserId=${yo.userId}&limit=20`, headers: { cookie } })).json().entries as Array<{ action: string; phrase: string; actor: string | null }>;
    expect(cadena.map((e) => e.action)).toEqual(['platform.console.password_change', 'platform.console.sessions_close_others', 'platform.console.reauth', 'platform.console.login']);
    expect(cadena.at(-1)).toMatchObject({ phrase: 'entró a la consola de GymFlow', actor: 'Soporte de pruebas' });
    const seguridad = (await app.inject({ method: 'GET', url: '/platform/security', headers: { cookie } })).json();
    expect(seguridad.activity).toBeUndefined();
    const verificada = (await app.inject({ method: 'GET', url: '/platform/audit/verify', headers: { cookie } })).json();
    expect(verificada).toMatchObject({ ok: true, links: { broken: 0, unmirrored: 0 } });

    const salir = await app.inject({ method: 'POST', url: '/platform/logout', headers: { cookie } });
    expect(salir.statusCode).toBe(200);
    expect(await mios('platform.console.logout')).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/platform/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('salir borra la cookie con el mismo dominio con que se puso', async () => {
    const conDominio = await makeApp({ SESSION_COOKIE_DOMAIN: 'gymflow.test' });
    await conDominio.ready();
    try {
      const cookie = await loginPlataforma(conDominio);
      const salir = await conDominio.inject({ method: 'POST', url: '/platform/logout', headers: { cookie } });
      const borrada = salir.cookies.find((c) => c.name === 'gf_session')!;
      expect(borrada).toMatchObject({ value: '', domain: 'gymflow.test', path: '/' });
    } finally { await conDominio.close(); }
  });

  it('«Qué ve» del dueño guarda solo las secciones que tienen efecto para un Dueño', async () => {
    const id = await marca('Llave');
    const dueno = await getDb().user.findFirstOrThrow({ where: { organizationId: id, roleAssignments: { some: { role: { key: 'OWNER' } } } }, select: { id: true } });
    const pedido = ['bitacora', 'tablero', 'retencion', 'productos', 'importar', 'consentimientos', '-caja', '-pos'];
    const r = await put(`/platform/organizations/${id}/users/${dueno.id}/sections`, { sections: pedido, reason: 'Prueba de la llave del dueño' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().sections).toEqual(onlyEffectiveSections(pedido, 'OWNER'));
    expect(r.json().sections).toEqual(['bitacora', 'tablero', '-caja']);
    for (const k of r.json().sections as string[]) expect(effectiveSections('OWNER')).toContain(k.replace(/^-/, ''));
    expect((await put(`/platform/organizations/${id}/users/${dueno.id}/sections`, { sections: null, reason: 'Fin de la prueba' })).json().sections).toBeNull();
  });

  it('el personal que cierra sus otras sesiones lo deja en la bitácora de su gimnasio (24-14)', async () => {
    const [una, otra] = [await loginAs(app, 'gerencia@demo.mx'), await loginAs(app, 'gerencia@demo.mx')];
    const antes = await getDb().auditLog.count({ where: { action: 'session.revoke_others' } });
    const r = await app.inject({ method: 'POST', url: '/auth/logout-others', headers: { cookie: otra }, payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().closed).toBeGreaterThanOrEqual(1);
    expect(await getDb().auditLog.count({ where: { action: 'session.revoke_others' } })).toBe(antes + 1);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: una } })).statusCode).toBe(401);
  });
});
