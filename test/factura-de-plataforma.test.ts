import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, loginPlataforma, correoUnico } from './helpers.js';
import { gimnasioPropio } from './gimnasio-propio.js';
import { liberadaElDiaUno, ponerPrecios, preciosActuales } from './precios-de-prueba.js';
import { MODULES } from '@gymflow/core';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { forgetModules } from '../src/platform/modules/module-state.js';
import { ModuleStateRepository } from '../src/platform/modules/module-state.repository.js';
import { PlatformAuditService } from '../src/platform/audit/platform-audit.service.js';
import { hoyDeCobro, mesDeCobro, estadoDeCobro, motivoDeNoEmitir } from '../src/modules/tenants/cobro-reglas.js';
import { avisoDeCambioDePrecio } from '../src/modules/tenants/cobranza-reglas.js';
import {
  IVA_BPS, SIN_IVA, ajusteDe, aplicaEn, desglosar, descuentoDe, diasACobrar, diasDelMes, estadoDeAjuste, impuestoEn, prorratear, redondear, seEnciman, textoDeAjuste, textoDeDias, ultimoMesDe,
  type Ajuste, type CambioDeIva,
} from '../src/modules/tenants/factura-reglas.js';
import { emisor } from '../src/modules/tenants/emisor.js';
import { BillingAdjustmentService } from '../src/modules/tenants/ajustes-de-factura.service.js';
import { PlatformInvoiceRulesRepository } from '../src/modules/tenants/factura.repository.js';
import { PlatformCollectionsService } from '../src/modules/tenants/cobranza.service.js';
import { PlatformBillingService } from '../src/modules/tenants/platform-billing.service.js';
import { PlatformPricingService } from '../src/modules/tenants/platform-pricing.service.js';
import { TenantService } from '../src/modules/tenants/tenant.service.js';

/**
 * LA FACTURA DE GYMFLOW A LOS GIMNASIOS (auditoría 8, fase 4, bloque 4.9;
 * decisión D-39): cobro por días, descuentos por meses e IVA. Aquí se prueba
 * CUÁNTO se cobra: cada regla con su caso límite, que una factura emitida no
 * cambia un centavo, y que la cobranza de D-37 (avisos, abonos, suspensión a
 * los 15 días, reanudar al pagar) sigue igual con importes con IVA o con
 * descuento.
 *
 * El reloj de prueba es el `ahora` que reciben los servicios, con fechas
 * FIJAS de 2027: nada depende del día en que corre. Las marcas son propias y
 * su liberación se fecha en la base. El IVA es global: cada prueba que lo
 * enciende lo deja apagado al terminar.
 */
describe('factura de plataforma · reglas con fecha fija (D-39)', () => {
  it('cobro por días: del día en que empezó, incluido, al último del mes; con los días reales de ese mes', () => {
    expect([diasDelMes('2027-02'), diasDelMes('2028-02'), diasDelMes('2027-04'), diasDelMes('2027-03')]).toEqual([28, 29, 30, 31]);
    // El día 1 es el mes completo: no hay nada que prorratear.
    expect(diasACobrar('2027-03', '2027-03-01')).toEqual({ dias: 31, de: 31 });
    // El día 15 de un mes de 31: del 15 al 31, diecisiete días.
    expect(diasACobrar('2027-03', '2027-03-15')).toEqual({ dias: 17, de: 31 });
    // El último día: un día.
    expect(diasACobrar('2027-03', '2027-03-31')).toEqual({ dias: 1, de: 31 });
    expect(diasACobrar('2027-02', '2027-02-28')).toEqual({ dias: 1, de: 28 });
    expect(diasACobrar('2028-02', '2028-02-29')).toEqual({ dias: 1, de: 29 });
    expect(diasACobrar('2028-02', '2028-02-02')).toEqual({ dias: 28, de: 29 });
    // Empezó antes de ese mes, o no se sabe cuándo: el mes completo. Empieza después: nada.
    expect(diasACobrar('2027-03', '2027-02-28')).toEqual({ dias: 31, de: 31 });
    expect(diasACobrar('2027-03', null)).toEqual({ dias: 31, de: 31 });
    expect(diasACobrar('2027-03', '2027-04-01')).toEqual({ dias: 0, de: 31 });
    expect(textoDeDias('2027-03', 17, 31)).toBe('17 de 31 días (del 15 al 31 de marzo)');
    expect(textoDeDias('2027-02', 1, 28)).toBe('1 de 28 días (el 28 de febrero)');
  });

  it('el importe por días se redondea al centavo más cercano y el medio centavo sube', () => {
    expect(redondear(1n, 2n)).toBe(1n);
    expect(redondear(49n, 100n)).toBe(0n);
    expect(redondear(50n, 100n)).toBe(1n);
    // $1,500.00 × 16/30 = $800.00 exactos; $500.00 × 16/30 = $266.666… → $266.67.
    expect(prorratear(150000n, 16, 30)).toBe(80000n);
    expect(prorratear(50000n, 16, 30)).toBe(26667n);
    // $300.00 × 1/31 = $9.677… → $9.68; $1,500.00 × 17/31 = $822.580… → $822.58.
    expect(prorratear(30000n, 1, 31)).toBe(968n);
    expect(prorratear(150000n, 17, 31)).toBe(82258n);
    // Medio centavo exacto ($0.15 × 1/30 = 0.5 centavos): sube.
    expect(prorratear(15n, 1, 30)).toBe(1n);
    expect(prorratear(45n, 1, 30)).toBe(2n);
    // El mes completo no se toca; cero días, cero.
    expect(prorratear(150000n, 31, 31)).toBe(150000n);
    expect(prorratear(150000n, 0, 31)).toBe(0n);
  });

  const ajuste = (x: Partial<Ajuste> = {}): Ajuste => ({ id: 'a1', kind: 'PERCENT', percentBps: 2000, amountCents: null, fromMonth: '2027-01-01', months: 3, reason: 'Promoción de arranque', canceled: false, ...x });

  it('un descuento vale SOLO para las facturas de sus meses y caduca solo', () => {
    const a = ajuste();
    expect(ultimoMesDe(a)).toBe('2027-03-01');
    expect(['2026-12', '2027-01', '2027-02', '2027-03', '2027-04'].map((m) => aplicaEn(a, m))).toEqual([false, true, true, true, false]);
    expect(aplicaEn(ajuste({ canceled: true }), '2027-02')).toBe(false);
    expect(ultimoMesDe(ajuste({ fromMonth: '2027-11-01', months: 3 }))).toBe('2028-01-01');
    expect(ultimoMesDe(ajuste({ months: 1 }))).toBe('2027-01-01');
    expect(ajusteDe([ajuste({ id: 'viejo', fromMonth: '2026-06-01', months: 2 }), a], '2027-02')?.id).toBe('a1');
    expect(ajusteDe([a], '2027-04')).toBeNull();
    expect(['2026-12', '2027-01', '2027-03', '2027-04'].map((m) => estadoDeAjuste(a, m))).toEqual(['SCHEDULED', 'ACTIVE', 'ACTIVE', 'ENDED']);
    expect(estadoDeAjuste(ajuste({ canceled: true }), '2027-01')).toBe('CANCELED');
    // Dos ajustes vivos no comparten ningún mes.
    expect(seEnciman(a, { fromMonth: '2027-03-01', months: 1 })).toBe(true);
    expect(seEnciman(a, { fromMonth: '2027-04-01', months: 6 })).toBe(false);
    expect(seEnciman(a, { fromMonth: '2026-10-01', months: 3 })).toBe(false);
    expect(seEnciman(a, { fromMonth: '2026-10-01', months: 4 })).toBe(true);
  });

  it('cuánto descuenta: porcentaje, importe (sin pasar de lo que se cobra) y precio especial (nunca sube)', () => {
    // 20 % de $2,300.00 = $460.00.
    expect(descuentoDe(ajuste(), 230000n, 230000n)).toBe(46000n);
    // 12.5 % de $333.33 = $41.666… → $41.67.
    expect(descuentoDe(ajuste({ percentBps: 1250 }), 33333n, 33333n)).toBe(4167n);
    expect(descuentoDe(ajuste({ percentBps: 10000 }), 230000n, 230000n)).toBe(230000n);
    // Importe fijo: $500.00; si el mes cuesta menos, descuenta lo que haya y no deja la factura en negativo.
    const importe = ajuste({ kind: 'AMOUNT', percentBps: null, amountCents: 50000n });
    expect(descuentoDe(importe, 230000n, 230000n)).toBe(50000n);
    expect(descuentoDe(importe, 30000n, 230000n)).toBe(30000n);
    expect(descuentoDe(importe, 0n, 230000n)).toBe(0n);
    // Precio especial: la mensualidad de $2,300.00 cuesta $1,800.00 → descuenta $500.00.
    const especial = ajuste({ kind: 'SPECIAL_PRICE', percentBps: null, amountCents: 180000n });
    expect(descuentoDe(especial, 230000n, 230000n)).toBe(50000n);
    // En un mes cobrado por días ($1,226.67 de $2,300.00), la misma proporción: paga $960.00, descuenta $266.67.
    expect(descuentoDe(especial, 122667n, 230000n)).toBe(26667n);
    // Un precio especial igual o mayor que la lista no descuenta nada: nunca sube lo que se cobra.
    expect(descuentoDe(ajuste({ kind: 'SPECIAL_PRICE', percentBps: null, amountCents: 230000n }), 230000n, 230000n)).toBe(0n);
    expect(descuentoDe(ajuste({ kind: 'SPECIAL_PRICE', percentBps: null, amountCents: 999999n }), 230000n, 230000n)).toBe(0n);
    expect(textoDeAjuste(ajuste())).toBe('Descuento de 20 % · Promoción de arranque');
    expect(textoDeAjuste(ajuste({ percentBps: 1250 }))).toBe('Descuento de 12.5 % · Promoción de arranque');
    expect(textoDeAjuste(importe)).toBe('Descuento · Promoción de arranque');
    expect(textoDeAjuste(especial)).toBe('Precio especial de $1,800.00 al mes · Promoción de arranque');
  });

  it('IVA: apagado por omisión; aparte suma 16 % al subtotal; incluido solo lo desglosa sin mover el total', () => {
    expect(IVA_BPS).toBe(1600);
    // Sin IVA: subtotal = total.
    expect(desglosar(230000n, SIN_IVA)).toEqual({ subtotalCents: 230000n, taxCents: 0n, taxRateBps: 0, taxIncluded: false, totalCents: 230000n });
    // Aparte: $1,000.00 + $160.00 = $1,160.00. El total SUBE 16 %.
    expect(desglosar(100000n, { rateBps: 1600, included: false })).toEqual({ subtotalCents: 100000n, taxCents: 16000n, taxRateBps: 1600, taxIncluded: false, totalCents: 116000n });
    // Redondeo del IVA al centavo: $123.45 × 16 % = $19.752 → $19.75; $536.67 × 16 % = $85.8672 → $85.87.
    expect(desglosar(12345n, { rateBps: 1600, included: false }).taxCents).toBe(1975n);
    expect(desglosar(53667n, { rateBps: 1600, included: false })).toMatchObject({ taxCents: 8587n, totalCents: 62254n });
    // Incluido: el total sigue en $1,000.00; subtotal $862.07 e IVA $137.93.
    expect(desglosar(100000n, { rateBps: 1600, included: true })).toEqual({ subtotalCents: 86207n, taxCents: 13793n, taxRateBps: 1600, taxIncluded: true, totalCents: 100000n });
    expect(desglosar(0n, { rateBps: 1600, included: false })).toMatchObject({ taxCents: 0n, totalCents: 0n });

    const cambio = (x: Partial<CambioDeIva>): CambioDeIva => ({ id: 'i1', rateBps: 1600, included: false, effectiveFrom: '2027-03-01', canceled: false, ...x });
    expect(impuestoEn([], '2027-03')).toEqual(SIN_IVA);
    // Empieza con la factura de marzo: la de febrero no lo lleva.
    expect(impuestoEn([cambio({})], '2027-02')).toEqual(SIN_IVA);
    expect(impuestoEn([cambio({})], '2027-03')).toEqual({ rateBps: 1600, included: false });
    expect(impuestoEn([cambio({})], '2027-12-15')).toEqual({ rateBps: 1600, included: false });
    expect(impuestoEn([cambio({ canceled: true })], '2027-03')).toEqual(SIN_IVA);
    // Uno posterior manda desde su fecha: quitarlo es anunciar tasa 0.
    const quitado = [cambio({}), cambio({ id: 'i2', rateBps: 0, effectiveFrom: '2027-06-01' })];
    expect(impuestoEn(quitado, '2027-05')).toEqual({ rateBps: 1600, included: false });
    expect(impuestoEn(quitado, '2027-06')).toEqual(SIN_IVA);
    // El aviso al dueño lo dice.
    expect(avisoDeCambioDePrecio({ effectiveFrom: '2027-07-01', antesCents: 180000n, despuesCents: 208800n, iva: { rateBps: 1600, included: false } }).body)
      .toBe('A partir de la factura de julio de 2027, tu mensualidad de GymFlow sube de $1,800.00 a $2,088.00. Desde esa factura se suma el IVA (16 %), que va desglosado. Hasta entonces pagas lo mismo que hoy.');
  });

  it('un mes que el descuento deja en $0.00 no se factura, y a la marca no «le falta» la factura', () => {
    const base = { mes: '2027-03', hoy: '2027-03-10', serviceStatus: 'ACTIVE', liberadaEl: '2027-01-10', yaTieneFactura: false, sinPrecio: [] };
    expect(motivoDeNoEmitir({ ...base, totalCents: 0n, porDescuento: true })).toEqual({ reason: 'ZERO_TOTAL', texto: 'Con su descuento, ese mes queda en cero' });
    expect(motivoDeNoEmitir({ ...base, totalCents: 0n })).toEqual({ reason: 'ZERO_TOTAL', texto: 'Mensualidad en cero' });
    const estado = (mesEnCero: boolean) => estadoDeCobro({ facturas: [], serviceStatus: 'ACTIVE', sinPrecio: false, liberadaEl: '2027-01-10', hoy: '2027-03-10', mesEnCero }).code;
    expect(estado(false)).toBe('SIN_FACTURA_DEL_MES');
    expect(estado(true)).toBe('AL_CORRIENTE');
  });

  it('GymFlow como emisor sale de la configuración del servidor: sin razón social no hay emisor', () => {
    expect(emisor({})).toBeNull();
    expect(emisor({ GYMFLOW_ISSUER_LEGAL_NAME: '  ', GYMFLOW_ISSUER_RFC: 'XAXX010101000' })).toBeNull();
    expect(emisor({ GYMFLOW_ISSUER_LEGAL_NAME: ' Emisor de Prueba S.A. de C.V. ', GYMFLOW_ISSUER_RFC: 'xaxx010101000', GYMFLOW_ISSUER_PAYMENT: 'Banco de Prueba · CLABE 000000000000000000' }))
      .toEqual({ legalName: 'Emisor de Prueba S.A. de C.V.', rfc: 'XAXX010101000', address: null, payment: 'Banco de Prueba · CLABE 000000000000000000', contact: null });
  });
});

describe('factura de plataforma · en la base, con el reloj de prueba', () => {
  let app: FastifyInstance;
  let plataforma: string;
  let usuario: string;
  let preciosDeAntes: Record<string, bigint> = {};
  const emisorDeAntes: Record<string, string | undefined> = {};
  const EMISOR = {
    GYMFLOW_ISSUER_LEGAL_NAME: 'Emisor de Prueba S.A. de C.V.', GYMFLOW_ISSUER_RFC: 'XAXX010101000', GYMFLOW_ISSUER_ADDRESS: 'Calle Inventada 1, Ciudad de Prueba',
    GYMFLOW_ISSUER_PAYMENT: 'Banco de Prueba · CLABE 000000000000000000', GYMFLOW_ISSUER_CONTACT: 'cobranza@ejemplo.test',
  };
  const sufijo = Date.now().toString(36).toUpperCase().slice(-5);
  /** El mediodía de la Ciudad de México de ese día: el «ahora» de lo que pasa ese día. */
  const el = (dia: string) => new Date(`${dia}T18:00:00.000Z`);
  const cobro = new PlatformBillingService();
  const cobranza = new PlatformCollectionsService();
  const precios = new PlatformPricingService();
  const ajustes = new BillingAdjustmentService();
  const reglas = new PlatformInvoiceRulesRepository();
  const marcas = new TenantService();
  const cabeceras = () => ({ cookie: plataforma });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: cabeceras() });
  const post = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, headers: cabeceras(), payload });
  const put = (url: string, payload: object) => app.inject({ method: 'PUT', url, headers: cabeceras(), payload });
  const db = () => getDb();
  const actor = () => ({ userId: usuario });
  const fila = async (id: string) => JSON.stringify(await db().platformInvoice.findUniqueOrThrow({ where: { id } }), (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  const avisosDe = (id: string) => db().platformNotice.findMany({ where: { organizationId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const asientosDe = (id: string, prefijo: string) => db().auditLog.findMany({ where: { organizationId: id, action: { startsWith: prefijo } }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { action: true, afterState: true, reason: true } });
  const enCadena = (id: string, action: string) => db().platformAuditLog.count({ where: { organizationId: id, action } });
  const servicio = (id: string) => db().organization.findUniqueOrThrow({ where: { id }, select: { serviceStatus: true, suspendedAutomatically: true } });
  const renglones = (f: { lines: Array<{ key: string; monthlyCents: string; kind?: string }> }) => f.lines.map((l) => [l.key.replace(/^ajuste:.*/, 'ajuste'), l.monthlyCents, l.kind ?? 'CHARGE']);
  const emitir = (id: string, mes: string, dia: string) => cobro.emitir(id, usuario, { month: mes }, el(dia));
  const previa = async (id: string, mes: string, dia: string) => (await cobro.vistaPrevia({ month: mes, organizationId: id }, el(dia)));
  /** Apaga TODO cambio de IVA vivo y cierra los avisos que dejó (el IVA es global: ninguna prueba lo deja encendido). */
  async function apagarIva(): Promise<void> {
    const vivos = await db().platformTaxChange.findMany({ where: { canceledAt: null }, select: { id: true, effectiveFrom: true } });
    if (vivos.length === 0) return;
    await db().platformTaxChange.updateMany({ where: { id: { in: vivos.map((v) => v.id) } }, data: { canceledAt: new Date(), cancelReason: 'Limpieza de una prueba' } });
    for (const fecha of new Set(vivos.map((v) => v.effectiveFrom.toISOString().slice(0, 10)))) {
      const abiertos = await db().platformNotice.findMany({ where: { kind: 'PRICE_CHANGE', closedAt: null, dedupeKey: { contains: `:${fecha}` } }, select: { id: true } });
      await db().platformNotice.updateMany({ where: { id: { in: abiertos.map((a) => a.id) } }, data: { closedAt: new Date(), closeReason: 'CANCELED' } });
    }
  }

  /**
   * Una marca propia en uso, con Caja contratada: $1,500 + $300 = $1,800 al mes.
   * `liberada` fecha su liberación (mediodía de la Ciudad de México de ese día).
   */
  async function marca(nombre: string, liberada: string, contratado: string[] = ['cash']): Promise<{ id: string; ownerId: string; duena: string; gerente: string }> {
    const duena = correoUnico(`duena.${nombre.toLowerCase()}`); const gerente = correoUnico(`gerente.${nombre.toLowerCase()}`);
    const alta = await post('/platform/organizations', {
      legalName: `${nombre} ${sufijo} S.A. de C.V.`, tradeName: `${nombre} ${sufijo}`, template: 'cadena', contracted: contratado, releaseNow: true,
      branch: { code: 'FAC', name: 'Matriz' },
      owner: { fullName: `Ana ${nombre} Prueba`, email: duena, phone: '5512345678' }, staff: [{ fullName: `Beto ${nombre} Prueba`, email: gerente, role: 'MANAGER' }],
      reason: 'Prueba de la factura de plataforma',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json().organizationId as string;
    await db().organization.update({ where: { id }, data: { activatedAt: el(liberada), rfc: 'XAXX010101000' } });
    const owner = await db().user.findFirstOrThrow({ where: { organizationId: id, roleAssignments: { some: { role: { key: 'OWNER' } } } }, select: { id: true } });
    return { id, ownerId: owner.id, duena, gerente };
  }
  /** Contrata un módulo y fecha la contratación (la ruta la fecha con el día real). */
  async function contratarEl(id: string, clave: string, dia: string): Promise<void> {
    await marcas.contratar(id, clave, true, usuario, 'Lo pidió el gimnasio');
    await reglas.marcarContratadoDesde(id, clave, dia);
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    plataforma = await loginPlataforma(app);
    usuario = (await get('/platform/me')).json().userId as string;
    preciosDeAntes = await preciosActuales();
    await ponerPrecios({ core: 150000n, cash: 30000n, classes: 50000n });
    for (const [k, v] of Object.entries(EMISOR)) { emisorDeAntes[k] = process.env[k]; process.env[k] = v; }
    await apagarIva();
  });
  afterAll(async () => {
    await apagarIva();
    for (const k of Object.keys(EMISOR)) { if (emisorDeAntes[k] === undefined) delete process.env[k]; else process.env[k] = emisorDeAntes[k]; }
    const devolver = Object.fromEntries(['core', 'cash', 'classes'].filter((k) => k in preciosDeAntes).map((k) => [k, preciosDeAntes[k]!]));
    await ponerPrecios(devolver);
    await app.close(); await closeDb();
  });

  it('el primer mes se cobra por días desde el día en que se liberó; el día 1 es el mes completo y el último día, un día', async () => {
    // Liberada el 15 de marzo (31 días): del 15 al 31, diecisiete días.
    const medio = await marca('Medio', '2027-03-15');
    const v = await previa(medio.id, '2027-03', '2027-03-20');
    expect(v.skipped).toEqual([]);
    // $1,500.00 × 17/31 = $822.58 · $300.00 × 17/31 = $164.52 → $987.10.
    expect(renglones(v.toIssue[0]!)).toEqual([['core', '82258', 'PRORATED'], ['cash', '16452', 'PRORATED']]);
    expect(v.toIssue[0]).toMatchObject({ subtotalCents: '98710', taxCents: '0', totalCents: '98710', discountCents: '0' });
    const f = await emitir(medio.id, '2027-03', '2027-03-20');
    // Lo que se ve antes de emitir es lo que se emite.
    expect(f).toMatchObject({ totalCents: '98710', subtotalCents: '98710', taxCents: '0', taxRateBps: 0, itemized: true, balanceCents: '98710', periodStart: '2027-03-01' });
    expect(f.lines[0]).toMatchObject({ key: 'core', name: 'Lo básico (software) · 17 de 31 días (del 15 al 31 de marzo)', monthlyCents: '82258', kind: 'PRORATED', listCents: '150000', days: 17, ofDays: 31 });
    // El asiento de la emisión dice que fue por días.
    const asiento = (await asientosDe(medio.id, 'platform.invoice.issue')).at(-1)!;
    expect(asiento.afterState).toMatchObject({ folio: f.folio, totalCents: '98710', subtotalCents: '98710', taxCents: '0' });
    expect((asiento.afterState as { byDays: string[] }).byDays).toHaveLength(2);
    // El segundo mes ya es completo, y la mensualidad que se enseña nunca va por días.
    expect(renglones(await emitir(medio.id, '2027-04', '2027-04-01'))).toEqual([['core', '150000', 'CHARGE'], ['cash', '30000', 'CHARGE']]);
    expect((await cobro.resumen(medio.id, el('2027-03-20'))).monthly).toMatchObject({ totalCents: '180000', subtotalCents: '180000', listCents: '180000', discountCents: '0', discount: null });

    // Liberada el día 1: el mes completo, sin renglones por días.
    const uno = await marca('DiaUno', '2027-03-01');
    const completa = await emitir(uno.id, '2027-03', '2027-03-01');
    expect(completa.totalCents).toBe('180000');
    expect(renglones(completa)).toEqual([['core', '150000', 'CHARGE'], ['cash', '30000', 'CHARGE']]);

    // Liberada el último día: un día de 31. $1,500.00/31 = $48.39 · $300.00/31 = $9.68.
    const ultimo = await marca('Ultimo', '2027-03-31');
    const unDia = await emitir(ultimo.id, '2027-03', '2027-03-31');
    expect(renglones(unDia)).toEqual([['core', '4839', 'PRORATED'], ['cash', '968', 'PRORATED']]);
    expect(unDia.totalCents).toBe('5807');
    expect(unDia.lines[1]!.name).toBe('Caja · 1 de 31 días (el 31 de marzo)');
    // Febrero de 28 días, liberada el 28: un día de 28.
    const febrero = await marca('Febrero', '2027-02-28');
    expect((await emitir(febrero.id, '2027-02', '2027-02-28')).totalCents).toBe((prorratear(150000n, 1, 28) + prorratear(30000n, 1, 28)).toString());
  });

  it('un módulo contratado a medio mes se cobra por días: en la factura de ese mes si todavía no existe, o en la siguiente si ya estaba emitida; una sola vez', async () => {
    // (a) La factura de marzo YA estaba emitida cuando se contrató Clases el día 15.
    const a = await marca('ModuloA', '2027-01-10');
    const marzo = await emitir(a.id, '2027-03', '2027-03-01');
    expect(marzo.totalCents).toBe('180000');
    const antes = await fila(marzo.id);
    await contratarEl(a.id, 'classes', '2027-03-15');
    // La factura de marzo no cambia; la de abril trae Clases completo MÁS sus 17 días de marzo ($500.00 × 17/31 = $274.19).
    expect(await fila(marzo.id)).toBe(antes);
    const abril = await emitir(a.id, '2027-04', '2027-04-01');
    expect(renglones(abril)).toEqual([['core', '150000', 'CHARGE'], ['cash', '30000', 'CHARGE'], ['classes', '50000', 'CHARGE'], ['dias:classes:2027-03', '27419', 'CATCH_UP']]);
    expect(abril.totalCents).toBe('257419');
    expect(abril.lines[3]).toMatchObject({ name: 'Clases · 17 de 31 días (del 15 al 31 de marzo)', listCents: '50000', days: 17, ofDays: 31 });
    // Esos días se cobran una sola vez: mayo ya no los trae.
    expect(renglones(await emitir(a.id, '2027-05', '2027-05-01'))).toEqual([['core', '150000', 'CHARGE'], ['cash', '30000', 'CHARGE'], ['classes', '50000', 'CHARGE']]);

    // (b) La factura de marzo se emite DESPUÉS de contratar: trae Clases por días ella misma, y abril no recoge nada.
    const b = await marca('ModuloB', '2027-01-10');
    await contratarEl(b.id, 'classes', '2027-03-15');
    const marzoB = await emitir(b.id, '2027-03', '2027-03-16');
    expect(renglones(marzoB)).toEqual([['core', '150000', 'CHARGE'], ['cash', '30000', 'CHARGE'], ['classes', '27419', 'PRORATED']]);
    expect(renglones(await emitir(b.id, '2027-04', '2027-04-01'))).toEqual([['core', '150000', 'CHARGE'], ['cash', '30000', 'CHARGE'], ['classes', '50000', 'CHARGE']]);

    // (c) Contratado el día 1, con la factura de ese mes ya emitida: en la siguiente, el mes completo. El último día: un día.
    const c = await marca('ModuloC', '2027-01-10');
    await emitir(c.id, '2027-03', '2027-03-01');
    await contratarEl(c.id, 'classes', '2027-03-01');
    expect((await emitir(c.id, '2027-04', '2027-04-01')).lines.at(-1)).toMatchObject({ key: 'dias:classes:2027-03', monthlyCents: '50000', days: 31, ofDays: 31 });
    const d = await marca('ModuloD', '2027-01-10');
    await emitir(d.id, '2027-03', '2027-03-01');
    await contratarEl(d.id, 'classes', '2027-03-31');
    expect((await emitir(d.id, '2027-04', '2027-04-01')).lines.at(-1)).toMatchObject({ key: 'dias:classes:2027-03', monthlyCents: '1613', days: 1, ofDays: 31 });

    // (d) Si el mes en que se contrató nunca se facturó, no hay días que recoger (cuando se emita, los traerá él).
    const e = await marca('ModuloE', '2027-01-10');
    await contratarEl(e.id, 'classes', '2027-03-15');
    expect(renglones(await emitir(e.id, '2027-04', '2027-04-01'))).toEqual([['core', '150000', 'CHARGE'], ['cash', '30000', 'CHARGE'], ['classes', '50000', 'CHARGE']]);

    // (e) La ruta fecha la contratación con el día de hoy; retirar el módulo la borra; volver a «contratar» lo que ya tenía no la mueve.
    const contratado = async (clave: string) => (await db().organizationEntitlement.findUnique({ where: { organizationId_moduleKey: { organizationId: e.id, moduleKey: clave } }, select: { granted: true, contractedOn: true } }));
    expect((await put(`/platform/organizations/${e.id}/entitlements/pos`, { granted: true, reason: 'Lo pidió el gimnasio' })).statusCode).toBe(200);
    expect((await contratado('pos'))?.contractedOn?.toISOString().slice(0, 10)).toBe(hoyDeCobro());
    expect((await put(`/platform/organizations/${e.id}/entitlements/pos`, { granted: false, reason: 'Ya no lo quiere' })).statusCode).toBe(200);
    expect(await contratado('pos')).toEqual({ granted: false, contractedOn: null });
    await put(`/platform/organizations/${e.id}/entitlements/cash`, { granted: true, reason: 'Confirmación' });
    expect((await contratado('cash'))?.contractedOn ?? null).toBeNull();
  });

  it('descuento por meses y con motivo: sale como renglón en las facturas de esos meses, caduca solo y queda en la bitácora de la marca y en la cadena', async () => {
    const { id } = await marca('Descuento', '2027-01-10');
    const marzo = await emitir(id, '2027-03', '2027-03-01');
    const antes = await fila(marzo.id);
    // El 20 de marzo se le da 20 % en las facturas de abril y mayo.
    const dado = await ajustes.crear(id, { kind: 'PERCENT', percentBps: 2000, fromMonth: '2027-04-01', months: 2, reason: 'Promoción de arranque' }, usuario, el('2027-03-20'));
    expect(dado.adjustment).toMatchObject({ kind: 'PERCENT', percentBps: 2000, fromMonth: '2027-04-01', lastMonth: '2027-05-01', months: 2, status: 'SCHEDULED', label: 'Descuento de 20 % · Promoción de arranque' });
    expect(dado.alreadyInvoiced).toEqual([]);
    // Uno encima, no; en un mes que ya pasó, tampoco.
    await expect(ajustes.crear(id, { kind: 'AMOUNT', amountCents: 10000n, fromMonth: '2027-05-01', months: 1, reason: 'Otro' }, usuario, el('2027-03-20'))).rejects.toMatchObject({ reason: 'BILLING_ADJUSTMENT_OVERLAP' });
    await expect(ajustes.crear(id, { kind: 'AMOUNT', amountCents: 10000n, fromMonth: '2027-02-01', months: 1, reason: 'Otro' }, usuario, el('2027-03-20'))).rejects.toThrow(/ya pasó/);

    // La factura ya emitida no cambió ni un centavo.
    expect(await fila(marzo.id)).toBe(antes);
    // Abril: $1,800.00 − 20 % ($360.00) = $1,440.00, con el renglón del descuento y su motivo.
    const abril = await emitir(id, '2027-04', '2027-04-01');
    expect(renglones(abril)).toEqual([['core', '150000', 'CHARGE'], ['cash', '30000', 'CHARGE'], ['ajuste', '-36000', 'DISCOUNT']]);
    expect(abril.lines[2]!.name).toBe('Descuento de 20 % · Promoción de arranque');
    expect(abril).toMatchObject({ subtotalCents: '144000', discountCents: '36000', taxCents: '0', totalCents: '144000', balanceCents: '144000' });
    // La ficha lo enseña en la mensualidad de abril, con hasta cuándo dura.
    const enAbril = await cobro.resumen(id, el('2027-04-10'));
    expect(enAbril.monthly).toMatchObject({ listCents: '180000', discountCents: '36000', totalCents: '144000', discount: { label: 'Descuento de 20 % · Promoción de arranque', lastMonth: '2027-05-01' } });
    expect((await ajustes.lista(id, el('2027-04-10'))).adjustments[0]).toMatchObject({ status: 'ACTIVE' });
    expect((await emitir(id, '2027-05', '2027-05-01')).totalCents).toBe('144000');
    // Junio: caducó solo. Nadie tuvo que apagarlo.
    const junio = await emitir(id, '2027-06', '2027-06-01');
    expect(junio).toMatchObject({ totalCents: '180000', discountCents: '0' });
    expect(renglones(junio)).toEqual([['core', '150000', 'CHARGE'], ['cash', '30000', 'CHARGE']]);
    expect((await ajustes.lista(id, el('2027-06-01'))).adjustments[0]).toMatchObject({ status: 'ENDED' });
    await expect(ajustes.cancelar(dado.adjustment.id, 'Ya no', usuario, el('2027-06-01'))).rejects.toMatchObject({ reason: 'BILLING_ADJUSTMENT_CLOSED' });

    // Queda en la bitácora de la marca (con su motivo) y en la cadena de plataforma; la factura dice con qué descuento salió.
    const suyos = await asientosDe(id, 'platform.billing.adjustment.');
    expect(suyos).toHaveLength(1);
    expect(suyos[0]).toMatchObject({ action: 'platform.billing.adjustment.create', reason: 'Promoción de arranque', afterState: { kind: 'PERCENT', percentBps: 2000, fromMonth: '2027-04-01', lastMonth: '2027-05-01', months: 2, byPlatformUserId: usuario } });
    expect(await enCadena(id, 'platform.billing.adjustment.create')).toBe(1);
    const emision = (await asientosDe(id, 'platform.invoice.issue')).find((x) => (x.afterState as { folio: string }).folio === abril.folio)!;
    expect(emision.afterState).toMatchObject({ discountCents: '36000', discount: 'Descuento de 20 % · Promoción de arranque', subtotalCents: '144000' });
    expect((await new PlatformAuditService().verifyChain()).ok).toBe(true);
    const frases = (await get(`/platform/organizations/${id}/audit?limit=30`)).json().entries as Array<{ action: string; phrase: string }>;
    expect(frases.find((x) => x.action === 'platform.billing.adjustment.create')!.phrase).toMatch(/dio un descuento o un precio especial/);
  });

  it('precio especial, importe fijo y descuento del 100 %; cancelar un descuento no toca la factura ya emitida', async () => {
    // Precio especial de $1,200.00 en vez de $1,800.00, en un primer mes cobrado por días (17 de 31).
    const especial = await marca('Especial', '2027-03-15');
    await ajustes.crear(especial.id, { kind: 'SPECIAL_PRICE', amountCents: 120000n, fromMonth: '2027-03-01', months: 2, reason: 'Convenio con la cadena' }, usuario, el('2027-03-15'));
    const marzo = await emitir(especial.id, '2027-03', '2027-03-15');
    // Por días: $987.10 de lista; al precio especial, la misma proporción: $987.10 × 1200/1800 = $658.07 → descuenta $329.03.
    expect(renglones(marzo)).toEqual([['core', '82258', 'PRORATED'], ['cash', '16452', 'PRORATED'], ['ajuste', '-32903', 'DISCOUNT']]);
    expect(marzo.totalCents).toBe('65807');
    expect(marzo.lines[2]!.name).toBe('Precio especial de $1,200.00 al mes · Convenio con la cadena');
    // El mes completo: exactamente el precio especial.
    expect((await emitir(especial.id, '2027-04', '2027-04-01')).totalCents).toBe('120000');
    expect((await emitir(especial.id, '2027-05', '2027-05-01')).totalCents).toBe('180000');

    // Importe fijo de $250.00 por un mes; se cancela antes de la segunda factura.
    const fijo = await marca('Fijo', '2027-01-10');
    const dado = await ajustes.crear(fijo.id, { kind: 'AMOUNT', amountCents: 25000n, fromMonth: '2027-03-01', months: 3, reason: 'Compensación por una falla' }, usuario, el('2027-03-01'));
    const conDescuento = await emitir(fijo.id, '2027-03', '2027-03-01');
    expect(conDescuento).toMatchObject({ totalCents: '155000', discountCents: '25000' });
    const antes = await fila(conDescuento.id);
    const cancelado = await ajustes.cancelar(dado.adjustment.id, 'Se acordó otra cosa', usuario, el('2027-03-10'));
    expect(cancelado).toMatchObject({ status: 'CANCELED', cancelReason: 'Se acordó otra cosa' });
    // La de marzo, ya emitida con el descuento, queda idéntica; la de abril sale sin él.
    expect(await fila(conDescuento.id)).toBe(antes);
    expect((await emitir(fijo.id, '2027-04', '2027-04-01'))).toMatchObject({ totalCents: '180000', discountCents: '0' });
    expect((await asientosDe(fijo.id, 'platform.billing.adjustment.')).map((x) => x.action)).toEqual(['platform.billing.adjustment.create', 'platform.billing.adjustment.cancel']);
    expect(await enCadena(fijo.id, 'platform.billing.adjustment.cancel')).toBe(1);
    await expect(ajustes.cancelar(dado.adjustment.id, 'Otra vez', usuario, el('2027-03-11'))).rejects.toMatchObject({ reason: 'BILLING_ADJUSTMENT_CLOSED' });

    // 100 %: ese mes queda en cero, no se factura y a la marca no «le falta» la factura.
    const gratis = await marca('Gratis', '2027-01-10');
    await ajustes.crear(gratis.id, { kind: 'PERCENT', percentBps: 10000, fromMonth: '2027-03-01', months: 1, reason: 'Mes de cortesía' }, usuario, el('2027-03-01'));
    expect((await previa(gratis.id, '2027-03', '2027-03-10')).skipped[0]).toMatchObject({ code: 'ZERO_TOTAL', reason: 'Con su descuento, ese mes queda en cero' });
    await expect(emitir(gratis.id, '2027-03', '2027-03-10')).rejects.toMatchObject({ reason: 'MONTH_NOT_BILLABLE' });
    expect((await cobro.resumen(gratis.id, el('2027-03-10'))).status.code).toBe('AL_CORRIENTE');
    expect((await cobro.resumen(gratis.id, el('2027-04-10'))).status.code).toBe('SIN_FACTURA_DEL_MES');
  });

  it('la consola da y cancela un descuento por la API: valida lo que falta, no deja encimar y dice qué meses ya tenían factura', async () => {
    const { id } = await marca('Api', '2027-01-10');
    const mes = `${mesDeCobro()}-01`;
    const dar = (cuerpo: object) => post(`/platform/organizations/${id}/billing-adjustments`, cuerpo);
    expect((await dar({ kind: 'PERCENT', fromMonth: mes, months: 2, reason: 'Promoción' })).statusCode).toBe(422);
    expect((await dar({ kind: 'AMOUNT', fromMonth: mes, months: 2, reason: 'Promoción' })).statusCode).toBe(422);
    expect((await dar({ kind: 'PERCENT', percentBps: 2000, fromMonth: mes, months: 2 })).statusCode).toBe(422);
    expect((await dar({ kind: 'PERCENT', percentBps: 2000, fromMonth: mes, months: 25, reason: 'Promoción' })).statusCode).toBe(422);
    expect((await dar({ kind: 'PERCENT', percentBps: 10001, fromMonth: mes, months: 2, reason: 'Promoción' })).statusCode).toBe(422);
    expect((await dar({ kind: 'PERCENT', percentBps: 2000, fromMonth: '2020-01-01', months: 2, reason: 'Promoción' })).statusCode).toBe(422);
    expect((await dar({ kind: 'PERCENT', percentBps: 2000, fromMonth: `${mesDeCobro()}-15`, months: 2, reason: 'Promoción' })).statusCode).toBe(422);
    const ok = await dar({ kind: 'PERCENT', percentBps: 1500, fromMonth: mes, months: 2, reason: 'Promoción de apertura' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ adjustment: { kind: 'PERCENT', percentBps: 1500, fromMonth: mes, months: 2, status: 'ACTIVE', label: 'Descuento de 15 % · Promoción de apertura' }, alreadyInvoiced: [] });
    const encima = await dar({ kind: 'AMOUNT', amountCents: '10000', fromMonth: mes, months: 1, reason: 'Otro' });
    expect(encima.statusCode).toBe(409);
    expect(encima.json().reason).toBe('BILLING_ADJUSTMENT_OVERLAP');
    const lista = await get(`/platform/organizations/${id}/billing-adjustments`);
    expect(lista.json()).toMatchObject({ month: mesDeCobro(), adjustments: [{ id: ok.json().adjustment.id, status: 'ACTIVE' }] });
    // La ficha: la mensualidad de hoy con su renglón de descuento ($1,800.00 − 15 % = $1,530.00).
    const ficha = (await get(`/platform/organizations/${id}/billing`)).json();
    expect(ficha.monthly).toMatchObject({ listCents: '180000', discountCents: '27000', totalCents: '153000', taxCents: '0' });
    expect(ficha.fiscal).toEqual({ receiver: { legalName: `Api ${sufijo} S.A. de C.V.`, rfc: 'XAXX010101000', tradeName: `Api ${sufijo}` }, issuer: { legalName: EMISOR.GYMFLOW_ISSUER_LEGAL_NAME, rfc: EMISOR.GYMFLOW_ISSUER_RFC, address: EMISOR.GYMFLOW_ISSUER_ADDRESS, payment: EMISOR.GYMFLOW_ISSUER_PAYMENT, contact: EMISOR.GYMFLOW_ISSUER_CONTACT } });
    const cancelar = await post(`/platform/billing-adjustments/${ok.json().adjustment.id}/cancel`, { reason: 'Se capturó mal' });
    expect(cancelar.statusCode, cancelar.body).toBe(200);
    expect(cancelar.json()).toMatchObject({ status: 'CANCELED', cancelReason: 'Se capturó mal' });
    expect((await post(`/platform/billing-adjustments/${ok.json().adjustment.id}/cancel`, { reason: 'Otra vez' })).statusCode).toBe(409);
    expect((await post(`/platform/billing-adjustments/${ok.json().adjustment.id}/cancel`, {})).statusCode).toBe(422);
    expect((await get('/platform/organizations/00000000-0000-7000-8000-000000000000/billing-adjustments')).statusCode).toBe(404);
    // Sin sesión de plataforma, nada.
    expect((await app.inject({ method: 'GET', url: `/platform/organizations/${id}/billing-adjustments` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/platform/tax' })).statusCode).toBe(401);
    // El IVA está APAGADO mientras nadie lo anuncie.
    expect((await get('/platform/tax')).json()).toMatchObject({ current: { rateBps: 0, included: false }, pending: null, currentMonth: mes, issuer: { legalName: EMISOR.GYMFLOW_ISSUER_LEGAL_NAME } });
  });

  it('IVA aparte: nace apagado, se anuncia con un mes, la factura muestra subtotal, IVA y total, y lo ya emitido no cambia', { timeout: 180_000 }, async () => {
    await apagarIva();
    const { id, ownerId } = await marca('Iva', '2027-01-10');
    // Mayo, sin IVA: $1,800.00 y nada más. También una factura «anterior a D-39», como las que ya existen (sin desglose).
    const mayo = await emitir(id, '2027-05', '2027-05-01');
    expect(mayo).toMatchObject({ totalCents: '180000', subtotalCents: '180000', taxCents: '0', taxRateBps: 0, taxIncluded: false, itemized: true });
    const vieja = await emitir(id, '2027-04', '2027-05-01');
    await db().platformInvoice.update({ where: { id: vieja.id }, data: { subtotalCents: null, receiver: null as never, issuer: null as never } });
    expect(await cobro.factura(vieja.id, el('2027-05-01'))).toMatchObject({ itemized: false, totalCents: '180000', subtotalCents: '180000', taxCents: '0', receiver: null, issuer: null });
    const antes = [await fila(mayo.id), await fila(vieja.id)];

    // El 10 de mayo se anuncia el IVA aparte. Le sube el total a los gimnasios: con un mes de aviso, desde la factura de julio.
    const vista = await precios.vistaPreviaDeIva({ rateBps: 1600, included: false }, undefined, el('2027-05-10'));
    expect(vista).toMatchObject({ minEffectiveFrom: '2027-07-01', effectiveFrom: '2027-07-01', immediate: false });
    expect(vista.affected.find((x) => x.organizationId === id)).toMatchObject({ beforeCents: '180000', afterCents: '208800' });
    await expect(precios.anunciarIva({ rateBps: 1600, included: false }, actor(), { effectiveFrom: '2027-06-01' }, el('2027-05-10'))).rejects.toMatchObject({ reason: 'PRICE_CHANGE_TOO_SOON' });
    await expect(precios.anunciarIva({ rateBps: 9000, included: false }, actor(), {}, el('2027-05-10'))).rejects.toThrow(/tasa/);
    const enCadenaAntes = await db().platformAuditLog.count({ where: { action: 'platform.tax.schedule' } });
    const anunciado = await precios.anunciarIva({ rateBps: 1600, included: false }, actor(), {}, el('2027-05-10'));
    expect(anunciado.change).toMatchObject({ rateBps: 1600, included: false, effectiveFrom: '2027-07-01', announcedOn: '2027-05-10', status: 'PENDING' });
    expect(anunciado.affected).toBeGreaterThanOrEqual(1);
    expect(await db().platformAuditLog.count({ where: { action: 'platform.tax.schedule' } })).toBe(enCadenaAntes + 1);
    await expect(precios.anunciarIva({ rateBps: 800, included: false }, actor(), {}, el('2027-05-11'))).rejects.toMatchObject({ reason: 'TAX_CHANGE_PENDING' });
    // El dueño recibe su aviso con las dos cifras y dice que es el IVA.
    const aviso = (await avisosDe(id)).find((x) => x.kind === 'PRICE_CHANGE')!;
    expect(aviso.body).toBe('A partir de la factura de julio de 2027, tu mensualidad de GymFlow sube de $1,800.00 a $2,088.00. Desde esa factura se suma el IVA (16 %), que va desglosado. Hasta entonces pagas lo mismo que hoy.');
    // Hasta julio paga lo mismo: la ficha enseña hoy $1,800.00 y lo anunciado.
    const ficha = await cobro.resumen(id, el('2027-05-10'));
    expect(ficha.monthly).toMatchObject({ totalCents: '180000', taxCents: '0' });
    expect(ficha.upcoming).toMatchObject({ effectiveFrom: '2027-07-01', totalCents: '208800', taxRateBps: 1600, taxIncluded: false });
    const junio = await emitir(id, '2027-06', '2027-06-01');
    expect(junio).toMatchObject({ totalCents: '180000', taxCents: '0' });

    // Julio: subtotal $1,800.00 + IVA $288.00 = total $2,088.00. El total SUBE 16 % sobre lo que pagaba.
    expect(await precios.cerrarAvisosDeIva(el('2027-07-01'))).toBeGreaterThanOrEqual(1);
    const julio = await emitir(id, '2027-07', '2027-07-01');
    expect(julio).toMatchObject({ subtotalCents: '180000', taxCents: '28800', taxRateBps: 1600, taxIncluded: false, totalCents: '208800', balanceCents: '208800', dueDate: '2027-07-11' });
    expect(renglones(julio)).toEqual([['core', '150000', 'CHARGE'], ['cash', '30000', 'CHARGE']]);
    // Lleva los datos fiscales del gimnasio y los de GymFlow, congelados al emitir.
    expect(julio.receiver).toEqual({ legalName: `Iva ${sufijo} S.A. de C.V.`, rfc: 'XAXX010101000', tradeName: `Iva ${sufijo}` });
    expect(julio.issuer).toMatchObject({ legalName: EMISOR.GYMFLOW_ISSUER_LEGAL_NAME, rfc: 'XAXX010101000', payment: EMISOR.GYMFLOW_ISSUER_PAYMENT });
    await db().organization.update({ where: { id }, data: { legalName: `Iva ${sufijo} Renombrada S.A.` } });
    expect((await cobro.factura(julio.id, el('2027-07-02')))!.receiver).toMatchObject({ legalName: `Iva ${sufijo} S.A. de C.V.` });
    // LO YA EMITIDO NO CAMBIÓ NI UN CENTAVO: ni la de mayo ni la anterior a D-39.
    expect([await fila(mayo.id), await fila(vieja.id)]).toEqual(antes);
    expect(await precios.iva(el('2027-07-01'))).toMatchObject({ current: { rateBps: 1600, included: false }, pending: null });
    // Ya empezó: no se «cancela»; para quitarlo se anuncia otro cambio.
    await expect(precios.cancelarIva(anunciado.change.id, 'Me arrepentí', actor(), el('2027-07-02'))).rejects.toMatchObject({ reason: 'TAX_CHANGE_CLOSED' });

    // LA COBRANZA DE D-37 SIGUE IGUAL, AHORA SOBRE EL TOTAL CON IVA.
    for (const f of [mayo, vieja, junio]) await cobro.pagar(f.id, usuario, { paymentMethod: 'CASH' }, el('2027-07-01'));
    const emitida = (await avisosDe(id)).find((x) => x.kind === 'INVOICE_ISSUED' && x.invoiceId === julio.id)!;
    expect(emitida.body).toContain('$2,088.00');
    // Vence el 11; el 12 nace el aviso de vencida por el total con IVA; se le manda y corren 15 días.
    expect(await cobranza.correr(el('2027-07-12'), { soloMarcas: [id] })).toMatchObject({ noticesOverdue: 1, suspended: [] });
    const vencida = (await avisosDe(id)).find((x) => x.kind === 'INVOICE_OVERDUE')!;
    expect(vencida.body).toContain('debe $2,088.00');
    expect(await cobranza.marcarVistos(id, ownerId, el('2027-07-12'))).toBeGreaterThanOrEqual(1);
    // Un abono de $1,000.00 a media espera: debe $1,088.00 y sigue contando.
    const abono = await cobro.pagar(julio.id, usuario, { amountCents: 100000n, paymentMethod: 'SPEI_TRANSFER', paymentRef: 'SPEI 1' }, el('2027-07-20'));
    expect(abono).toMatchObject({ status: 'PENDING', paidCents: '100000', balanceCents: '108800', totalCents: '208800', taxCents: '28800' });
    await expect(cobro.pagar(julio.id, usuario, { amountCents: 108801n, paymentMethod: 'CASH' }, el('2027-07-20'))).rejects.toMatchObject({ reason: 'AMOUNT_OVER_BALANCE' });
    expect((await cobranza.correr(el('2027-07-25'), { soloMarcas: [id] })).suspended).toEqual([]);
    expect((await servicio(id)).serviceStatus).toBe('ACTIVE');
    const dia15 = await cobranza.correr(el('2027-07-26'), { soloMarcas: [id] });
    expect(dia15.suspended).toEqual([{ organizationId: id, tradeName: `Iva ${sufijo}`, folio: julio.folio, noticedDays: 15 }]);
    expect(await servicio(id)).toMatchObject({ serviceStatus: 'SUSPENDED', suspendedAutomatically: true });
    expect((await asientosDe(id, 'platform.service.auto_suspend')).at(-1)!.afterState).toMatchObject({ folio: julio.folio, amountCents: '108800', noticedDays: 15 });
    // Paga lo que falta y se reanuda en el mismo paso.
    const pago = await cobro.pagar(julio.id, usuario, { paymentMethod: 'SPEI_TRANSFER', paymentRef: 'SPEI 2', resume: true }, el('2027-07-27'));
    expect(pago).toMatchObject({ status: 'PAID', state: 'PAGADA', paidCents: '208800', balanceCents: '0', service: { status: 'ACTIVE', resumed: true } });
    expect(await servicio(id)).toMatchObject({ serviceStatus: 'ACTIVE', suspendedAutomatically: false });

    // Un IVA anunciado que todavía no empieza sí se cancela, y deja de estar pendiente.
    const quitar = await precios.anunciarIva({ rateBps: 0, included: false }, actor(), {}, el('2027-08-10'));
    expect(quitar.change).toMatchObject({ rateBps: 0, effectiveFrom: '2027-10-01', status: 'PENDING' });
    expect((await avisosDe(id)).filter((x) => x.kind === 'PRICE_CHANGE').at(-1)!.body).toMatch(/baja de \$2,088\.00 a \$1,800\.00\. Desde esa factura ya no se suma el IVA\./);
    expect(await precios.cancelarIva(quitar.change.id, 'Se queda el IVA', actor(), el('2027-08-11'))).toMatchObject({ status: 'CANCELED', cancelReason: 'Se queda el IVA' });
    expect((await precios.iva(el('2027-08-11'))).pending).toBeNull();
    expect((await emitir(id, '2027-10', '2027-10-01')).totalCents).toBe('208800');
    await apagarIva();
  });

  it('IVA con descuento y por días: primero los días, luego el descuento y al final el IVA; e «IVA incluido» desglosa sin subir el total', { timeout: 120_000 }, async () => {
    await apagarIva();
    // «Los precios ya incluyen el IVA»: no le mueve el total a nadie, así que puede empezar con la factura de este mes.
    const { id } = await marca('Incluido', '2027-01-10');
    const vista = await precios.vistaPreviaDeIva({ rateBps: 1600, included: true }, undefined, el('2027-02-05'));
    expect(vista).toMatchObject({ effectiveFrom: '2027-02-01', immediate: true, affected: [] });
    const incluido = await precios.anunciarIva({ rateBps: 1600, included: true }, actor(), {}, el('2027-02-05'));
    expect(incluido).toMatchObject({ change: { effectiveFrom: '2027-02-01', included: true, status: 'ACTIVE' }, affected: 0 });
    // $1,800.00 de total, como antes; de ahí, subtotal $1,551.72 e IVA $248.28.
    const febrero = await emitir(id, '2027-02', '2027-02-05');
    expect(febrero).toMatchObject({ totalCents: '180000', subtotalCents: '155172', taxCents: '24828', taxRateBps: 1600, taxIncluded: true });
    expect((await avisosDe(id)).filter((x) => x.kind === 'PRICE_CHANGE')).toEqual([]);
    await apagarIva();

    // IVA aparte desde marzo (fechado directo: aquí se prueba la cuenta, no el anuncio).
    await reglas.anunciarIva({ rateBps: 1600, included: false, effectiveFrom: '2027-03-01', announcedOn: '2027-01-15', byUserId: usuario });
    const todo = await marca('Todo', '2027-03-15', ['cash', 'classes']);
    await ajustes.crear(todo.id, { kind: 'PERCENT', percentBps: 1000, fromMonth: '2027-03-01', months: 1, reason: 'Bienvenida' }, usuario, el('2027-03-15'));
    const marzo = await emitir(todo.id, '2027-03', '2027-03-15');
    // Por días (17/31): $822.58 + $164.52 + $274.19 = $1,261.29 · menos 10 % ($126.13) = $1,135.16 · IVA 16 % = $181.63 → $1,316.79.
    expect(renglones(marzo)).toEqual([['core', '82258', 'PRORATED'], ['cash', '16452', 'PRORATED'], ['classes', '27419', 'PRORATED'], ['ajuste', '-12613', 'DISCOUNT']]);
    expect(marzo).toMatchObject({ subtotalCents: '113516', discountCents: '12613', taxCents: '18163', totalCents: '131679', balanceCents: '131679' });
    // Abril: completo, sin descuento (duró un mes) y con IVA: $2,300.00 + $368.00 = $2,668.00.
    expect(await emitir(todo.id, '2027-04', '2027-04-01')).toMatchObject({ subtotalCents: '230000', taxCents: '36800', totalCents: '266800', discountCents: '0' });
    await apagarIva();
    // Apagado otra vez: la siguiente factura sale sin IVA, y las dos emitidas con IVA siguen como se emitieron.
    expect(await emitir(todo.id, '2027-05', '2027-05-01')).toMatchObject({ subtotalCents: '230000', taxCents: '0', totalCents: '230000' });
    expect((await cobro.factura(marzo.id, el('2027-05-01')))).toMatchObject({ totalCents: '131679', taxCents: '18163' });
  });

  it('la dueña ve en su cuenta la mensualidad con su descuento, el desglose y los datos fiscales; la gerencia no ve nada', async () => {
    await apagarIva();
    // Un gimnasio propio (sus cuentas tienen contraseña conocida), con lo básico y Caja: $1,800.00 al mes.
    const gym = await gimnasioPropio();
    const id = gym.organizationId; const duena = gym.correos.owner; const gerente = gym.correos.gerente;
    for (const m of MODULES.filter((x) => x.kind === 'optional' && x.key !== 'cash')) await new ModuleStateRepository(id).setEntitlement(m.key, false, null, 'Prueba de la factura de plataforma');
    forgetModules(id);
    const razon = `Cuenta ${sufijo} S.A. de C.V.`;
    await db().organization.update({ where: { id }, data: { legalName: razon, rfc: 'XAXX010101000' } });
    const dado = await post(`/platform/organizations/${id}/billing-adjustments`, { kind: 'AMOUNT', amountCents: '30000', fromMonth: `${mesDeCobro()}-01`, months: 3, reason: 'Convenio de apertura' });
    expect(dado.statusCode, dado.body).toBe(201);
    // Liberada «el día 1 de este mes»: la factura del mes en curso sale completa, sea el día que sea.
    await liberadaElDiaUno(id);
    const emitida = await post(`/platform/organizations/${id}/invoices`, { month: mesDeCobro() });
    expect(emitida.statusCode, emitida.body).toBe(201);
    expect(emitida.json()).toMatchObject({ totalCents: '150000', subtotalCents: '150000', discountCents: '30000', taxCents: '0', itemized: true });
    const cuenta = (await app.inject({ method: 'GET', url: '/gymflow-account', headers: { cookie: await loginAs(app, duena) } })).json();
    expect(cuenta.visible).toBe(true);
    expect(cuenta.monthly).toMatchObject({ subtotalCents: '150000', taxCents: '0', taxRateBps: 0, taxIncluded: false, totalCents: '150000', discount: { label: 'Descuento · Convenio de apertura' } });
    expect(cuenta.monthly.lines.map((l: { kind?: string; monthlyCents: string }) => [l.kind ?? 'CHARGE', l.monthlyCents])).toEqual([['CHARGE', '150000'], ['CHARGE', '30000'], ['DISCOUNT', '-30000']]);
    expect(cuenta.invoices[0]).toMatchObject({ folio: emitida.json().folio, totalCents: '150000', subtotalCents: '150000', taxCents: '0', itemized: true, balanceCents: '150000' });
    expect(cuenta.invoices[0].lines).toHaveLength(3);
    expect(cuenta.fiscal).toEqual({
      receiver: { legalName: razon, rfc: 'XAXX010101000' },
      issuer: { legalName: EMISOR.GYMFLOW_ISSUER_LEGAL_NAME, rfc: EMISOR.GYMFLOW_ISSUER_RFC, address: EMISOR.GYMFLOW_ISSUER_ADDRESS, payment: EMISOR.GYMFLOW_ISSUER_PAYMENT, contact: EMISOR.GYMFLOW_ISSUER_CONTACT },
    });
    const ajena = (await app.inject({ method: 'GET', url: '/gymflow-account', headers: { cookie: await loginAs(app, gerente) } })).json();
    expect(ajena).toMatchObject({ visible: false, invoices: [], monthly: { lines: [], totalCents: '0', discount: null }, fiscal: { receiver: { legalName: '', rfc: null }, issuer: null } });
    // El comprobante de la consola trae receptor y emisor.
    const comprobante = (await get(`/platform/invoices/${emitida.json().id}`)).json();
    expect(comprobante.receiver).toMatchObject({ legalName: razon, rfc: 'XAXX010101000' });
    expect(comprobante.issuer).toMatchObject({ legalName: EMISOR.GYMFLOW_ISSUER_LEGAL_NAME });
    // Por la API, el IVA se ve antes de anunciarse y pide un mes de aviso cuando le sube el total a alguien.
    const previaIva = await post('/platform/tax/preview', { rateBps: 1600 });
    expect(previaIva.statusCode, previaIva.body).toBe(200);
    expect(previaIva.json()).toMatchObject({ immediate: false });
    expect(previaIva.json().affected.find((x: { organizationId: string }) => x.organizationId === id)).toMatchObject({ beforeCents: '150000', afterCents: '174000' });
    expect((await put('/platform/tax', { rateBps: 1600, effectiveFrom: `${mesDeCobro()}-01` })).json().reason).toBe('PRICE_CHANGE_TOO_SOON');
    expect((await put('/platform/tax', { rateBps: 99999 })).statusCode).toBe(422);
    const anuncio = await put('/platform/tax', { rateBps: 1600 });
    expect(anuncio.statusCode, anuncio.body).toBe(200);
    expect(anuncio.json().change).toMatchObject({ rateBps: 1600, included: false, status: 'PENDING', effectiveFrom: previaIva.json().minEffectiveFrom });
    expect((await get('/platform/tax')).json().pending).toMatchObject({ id: anuncio.json().change.id });
    // Hoy sigue pagando lo mismo; la cuenta de la dueña ya dice lo anunciado.
    const despues = (await app.inject({ method: 'GET', url: '/gymflow-account', headers: { cookie: await loginAs(app, duena) } })).json();
    expect(despues.monthly.totalCents).toBe('150000');
    expect(despues.upcoming).toMatchObject({ effectiveFrom: anuncio.json().change.effectiveFrom });
    expect(despues.notices.some((n: { kind: string; body: string }) => n.kind === 'PRICE_CHANGE' && /se suma el IVA \(16 %\)/.test(n.body))).toBe(true);
    const cancelar = await post(`/platform/tax/${anuncio.json().change.id}/cancel`, { reason: 'Falta confirmarlo con el contador' });
    expect(cancelar.statusCode, cancelar.body).toBe(200);
    expect(cancelar.json()).toMatchObject({ status: 'CANCELED' });
    expect((await post(`/platform/tax/${anuncio.json().change.id}/cancel`, { reason: 'Otra vez' })).statusCode).toBe(409);
    expect((await get('/platform/tax')).json()).toMatchObject({ current: { rateBps: 0 }, pending: null });
    expect((await app.inject({ method: 'GET', url: '/gymflow-account', headers: { cookie: await loginAs(app, duena) } })).json().upcoming).toBeNull();
    await gym.cerrar();
  });
});
