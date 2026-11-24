import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { masDias } from '@gymflow/core';
import { makeApp, loginAs, loginPlataforma, correoUnico } from './helpers.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { ponerPrecios, preciosActuales } from './precios-de-prueba.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { PlatformAuditService } from '../src/platform/audit/platform-audit.service.js';
import { moduleViewOf, forgetModules } from '../src/platform/modules/module-state.js';
import { hoyDeCobro, mesDeCobro } from '../src/modules/tenants/cobro-reglas.js';
import {
  DIAS_DE_PRORROGA, DIAS_PARA_SUSPENDER, atrasoAvisado, decidirSuspension, primeraVigencia, suspenderiaEl, valorEn, type FacturaEnCobranza,
} from '../src/modules/tenants/cobranza-reglas.js';
import { PlatformCollectionsService } from '../src/modules/tenants/cobranza.service.js';
import { PlatformBillingRepository } from '../src/modules/tenants/platform-billing.repository.js';
import { PlatformBillingService } from '../src/modules/tenants/platform-billing.service.js';
import { PlatformPricingService } from '../src/modules/tenants/platform-pricing.service.js';
import { Vigencias } from '../src/modules/tenants/vigencias.js';
import type { CambioAnunciado } from '../src/modules/tenants/platform-price-change.repository.js';

/**
 * ESCALERA DE COBRANZA Y CAMBIOS CON UN MES DE AVISO (auditoría 8, fase 3,
 * bloque 3.11; D-37 y D-38). D-37 es la decisión que APAGA un gimnasio
 * entero: aquí se prueba el conteo de días, que nadie se suspende sin aviso
 * previo, que suspender no borra ni cobra nada y que todo queda en la cadena.
 *
 * El reloj de prueba es el `ahora` que reciben los servicios: las reglas se
 * prueban con fechas fijas y lo que pasa por la base corre «en el día N» sin
 * depender de la hora real. La corrida se acota a las marcas de la prueba
 * (`soloMarcas`): no toca a las de los demás archivos.
 */
describe('cobranza de plataforma · reglas con fecha fija (D-37)', () => {
  const factura = (x: Partial<FacturaEnCobranza> = {}): FacturaEnCobranza => ({ id: 'f1', folio: 'GF-2026-000001', dueDate: '2026-11-11', saldoCents: 230000n, avisoEntregadoEl: '2026-11-12', ...x });
  const decidir = (hoy: string, f: FacturaEnCobranza[] = [factura()], extra: { serviceStatus?: string; prorrogaHasta?: string | null } = {}) =>
    decidirSuspension({ serviceStatus: extra.serviceStatus ?? 'ACTIVE', facturas: f, hoy, prorrogaHasta: extra.prorrogaHasta ?? null });

  it('el camino normal: el aviso llega el primer día de atraso y a los 15 días se suspende, ni uno antes', () => {
    // Vence el 11; el 12 es el día 1 de atraso y el día en que llega el aviso.
    expect(atrasoAvisado(factura(), '2026-11-11')).toBe(0);
    expect(atrasoAvisado(factura(), '2026-11-12')).toBe(1);
    expect(atrasoAvisado(factura(), '2026-11-25')).toBe(14);
    expect(suspenderiaEl(factura())).toBe('2026-11-26');
    expect(decidir('2026-11-11')).toMatchObject({ suspender: false, por: 'SIN_ADEUDO_VENCIDO' });
    expect(decidir('2026-11-25')).toMatchObject({ suspender: false, por: 'EN_PLAZO', overdueDays: 14, noticedDays: 14, suspendsOn: '2026-11-26' });
    expect(decidir('2026-11-26')).toMatchObject({ suspender: true, por: 'SUSPENDER', overdueDays: DIAS_PARA_SUSPENDER, noticedDays: DIAS_PARA_SUSPENDER });
    expect(decidir('2026-12-20')).toMatchObject({ suspender: true });
  });

  it('sin constancia de que el aviso llegó, NO se suspende por muchos días que lleve vencida', () => {
    const sinAviso = factura({ avisoEntregadoEl: null });
    expect(atrasoAvisado(sinAviso, '2027-03-01')).toBe(0);
    expect(suspenderiaEl(sinAviso)).toBeNull();
    expect(decidir('2027-03-01', [sinAviso])).toMatchObject({ suspender: false, por: 'AVISO_SIN_ENTREGAR', overdueDays: 110, noticedDays: 0, suspendsOn: null });
  });

  it('un aviso que llega tarde cuenta desde que llega: los 15 días son desde el aviso, no desde el vencimiento', () => {
    // Vencida desde el 12 de noviembre; el aviso le llega hasta el 20 de diciembre (día 39 de atraso).
    const tarde = factura({ avisoEntregadoEl: '2026-12-20' });
    expect(decidir('2026-12-20', [tarde])).toMatchObject({ suspender: false, por: 'EN_PLAZO', overdueDays: 39, noticedDays: 1, suspendsOn: '2027-01-03' });
    expect(decidir('2027-01-02', [tarde])).toMatchObject({ suspender: false, noticedDays: 14 });
    expect(decidir('2027-01-03', [tarde])).toMatchObject({ suspender: true, noticedDays: 15 });
    // Un aviso fechado antes del vencimiento no adelanta nada: se cuenta desde el primer día de atraso.
    expect(suspenderiaEl(factura({ avisoEntregadoEl: '2026-11-01' }))).toBe('2026-11-26');
  });

  it('la prórroga detiene la suspensión hasta ese día, incluido; al día siguiente ya suspende', () => {
    expect(decidir('2026-11-26', undefined, { prorrogaHasta: '2026-11-30' })).toMatchObject({ suspender: false, por: 'PRORROGA', suspendsOn: '2026-12-01' });
    expect(decidir('2026-11-30', undefined, { prorrogaHasta: '2026-11-30' })).toMatchObject({ suspender: false, por: 'PRORROGA' });
    expect(decidir('2026-12-01', undefined, { prorrogaHasta: '2026-11-30' })).toMatchObject({ suspender: true });
    // Una prórroga más corta que el plazo no adelanta nada.
    expect(decidir('2026-11-20', undefined, { prorrogaHasta: '2026-11-21' })).toMatchObject({ suspender: false, por: 'EN_PLAZO', suspendsOn: '2026-11-26' });
  });

  it('no se suspende a quien no está en uso, a quien ya pagó, ni por una factura que vence hoy; con dos facturas manda la que antes suspende', () => {
    expect(decidir('2026-12-30', undefined, { serviceStatus: 'SUSPENDED' })).toMatchObject({ suspender: false, por: 'NO_EN_USO' });
    expect(decidir('2026-12-30', undefined, { serviceStatus: 'PENDING' })).toMatchObject({ suspender: false, por: 'NO_EN_USO' });
    expect(decidir('2026-12-30', [factura({ saldoCents: 0n })])).toMatchObject({ suspender: false, por: 'SIN_ADEUDO_VENCIDO' });
    const octubre = factura({ id: 'f0', folio: 'GF-2026-000000', dueDate: '2026-10-11', avisoEntregadoEl: null });
    // Octubre es más vieja pero su aviso no ha llegado: manda noviembre, que sí tiene fecha.
    expect(decidir('2026-11-26', [octubre, factura()])).toMatchObject({ suspender: true, factura: { id: 'f1' }, overdueDays: 46, noticedDays: 15 });
    expect(decidir('2026-11-20', [octubre, factura()])).toMatchObject({ suspender: false, por: 'EN_PLAZO', factura: { id: 'f1' } });
  });
});

describe('cambios con un mes de aviso · reglas con fecha fija (D-38)', () => {
  it('un cambio anunciado hoy aplica desde la primera factura con al menos un mes de aviso', () => {
    expect(primeraVigencia('2026-11-23')).toBe('2027-01-01');
    expect(primeraVigencia('2026-12-01')).toBe('2027-01-01');
    expect(primeraVigencia('2026-12-02')).toBe('2027-02-01');
    expect(primeraVigencia('2026-12-31')).toBe('2027-02-01');
    expect(primeraVigencia('2027-01-31')).toBe('2027-03-01');
  });

  it('lo que vale algo cada día: hoy lo de hoy, desde la fecha avisada lo nuevo, y un mes pasado lo que valía', () => {
    const enero = { effectiveFrom: '2027-01-01', before: 100, after: 120 };
    // Anunciado y sin aplicar: hasta diciembre vale 100; la factura de enero ya sale con 120 aunque el job no lo haya aplicado.
    expect(valorEn(100, [{ ...enero, applied: false }], '2026-12-01')).toBe(100);
    expect(valorEn(100, [{ ...enero, applied: false }], '2027-01-01')).toBe(120);
    // Ya aplicado (el catálogo dice 120): facturar tarde diciembre usa lo que valía.
    expect(valorEn(120, [{ ...enero, applied: true }], '2026-12-01')).toBe(100);
    expect(valorEn(120, [{ ...enero, applied: true }], '2027-02-01')).toBe(120);
    // Dos cambios seguidos, el primero aplicado y el segundo anunciado.
    const marzo = { effectiveFrom: '2027-03-01', before: 120, after: 150, applied: false };
    expect([['2026-12-01', 100], ['2027-02-01', 120], ['2027-03-01', 150]].map(([dia]) => valorEn(120, [{ ...enero, applied: true }, marzo], dia as string))).toEqual([100, 120, 150]);
    expect(valorEn(100, [], '2030-01-01')).toBe(100);
  });

  it('los precios sueltos de un día salen del catálogo de hoy y de sus cambios', () => {
    const cambio = (x: Partial<CambioAnunciado>): CambioAnunciado => ({
      id: 'c', kind: 'PRICE', moduleKey: 'classes', planId: null, before: { monthlyCents: '50000', modules: [] }, after: { monthlyCents: '60000', modules: [] },
      effectiveFrom: new Date('2027-01-01T00:00:00.000Z'), announcedOn: new Date('2026-11-23T00:00:00.000Z'), createdAt: new Date(), createdByUserId: null,
      appliedAt: null, canceledAt: null, canceledByUserId: null, cancelReason: null, ...x,
    });
    const v = new Vigencias(new Map([['core', 150000n], ['classes', 50000n]]), [cambio({})]);
    expect(Object.fromEntries(v.preciosEn('2026-12-01'))).toEqual({ core: 150000n, classes: 50000n });
    expect(Object.fromEntries(v.preciosEn('2027-01-01'))).toEqual({ core: 150000n, classes: 60000n });
    // El plan de una marca: su versión guardada manda sobre el catálogo, y un cambio de ese plan le aplica desde su fecha.
    const marca = { platformPlanId: 'p1', platformPlanSnapshot: { planId: 'p1', name: 'Pro', monthlyCents: '180000', modules: ['cash'], since: '2026-10-01' } };
    const catalogo = new Map([['p1', { id: 'p1', name: 'Pro', description: null, modules: ['cash', 'pos'], monthlyCents: 999999n, isActive: true, sortOrder: 0, createdAt: new Date(), updatedAt: new Date() }]]);
    const conPlan = v.con([cambio({ id: 'c2', kind: 'PLAN', moduleKey: null, planId: 'p1', before: { monthlyCents: '180000', modules: ['cash'] }, after: { monthlyCents: '200000', modules: ['cash', 'classes'] } })]);
    expect(conPlan.planEn(marca, catalogo, '2026-12-01')).toMatchObject({ monthlyCents: 180000n, modules: ['cash'] });
    expect(conPlan.planEn(marca, catalogo, '2027-01-01')).toMatchObject({ monthlyCents: 200000n, modules: ['cash', 'classes'] });
    expect(conPlan.planEn({ platformPlanId: null, platformPlanSnapshot: null }, catalogo, '2027-01-01')).toBeNull();
  });
});

describe('cobranza de plataforma · en la base, con el reloj de prueba', () => {
  let app: FastifyInstance;
  let plataforma: string;
  let usuario: string;
  let preciosDeAntes: Record<string, bigint> = {};
  const sufijo = Date.now().toString(36).toUpperCase().slice(-5);
  const hoy = hoyDeCobro();
  const mes = mesDeCobro();
  /** El mediodía de la Ciudad de México del día `hoy + n`: el «ahora» de una corrida en ese día. */
  const elDia = (n: number) => new Date(`${masDias(hoy, n)}T18:00:00.000Z`);
  const cobranza = new PlatformCollectionsService();
  const cobro = new PlatformBillingService();
  const precios = new PlatformPricingService();
  const cabeceras = () => ({ cookie: plataforma });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: cabeceras() });
  const post = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, headers: cabeceras(), payload });
  const put = (url: string, payload: object) => app.inject({ method: 'PUT', url, headers: cabeceras(), payload });
  const db = () => getDb();
  const servicio = (id: string) => db().organization.findUniqueOrThrow({ where: { id }, select: { serviceStatus: true, suspendedAutomatically: true, suspendedReason: true, suspendedAt: true, autoSuspendHoldUntil: true } });
  const avisosDe = (id: string) => db().platformNotice.findMany({ where: { organizationId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const asientosDe = (id: string, prefijo: string) => db().auditLog.findMany({ where: { organizationId: id, action: { startsWith: prefijo } }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { action: true, afterState: true, reason: true, actorType: true } });
  const enCadena = (id: string, action: string) => db().platformAuditLog.count({ where: { organizationId: id, action } });
  const correr = (n: number, ids: string[]) => cobranza.correr(elDia(n), { soloMarcas: ids });

  /** Una marca propia, liberada, con Caja y Clases: $1,500 + $300 + $500 = $2,300 al mes. Devuelve también a su dueño. */
  async function marca(nombre: string, extra: object = {}): Promise<{ id: string; ownerId: string }> {
    const correo = (rol: string) => correoUnico(`${rol}.${nombre.toLowerCase()}`);
    const alta = await post('/platform/organizations', {
      legalName: `${nombre} ${sufijo} S.A.`, tradeName: `${nombre} ${sufijo}`, template: 'cadena', contracted: ['cash', 'classes'], releaseNow: true,
      branch: { code: 'CBZ', name: 'Matriz' },
      owner: { fullName: `Ana ${nombre} Prueba`, email: correo('duena'), phone: '5512345678' }, staff: [{ fullName: `Beto ${nombre} Prueba`, email: correo('gerente'), role: 'MANAGER' }],
      reason: 'Prueba de la cobranza de plataforma', ...extra,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json().organizationId as string;
    const owner = await db().user.findFirstOrThrow({ where: { organizationId: id, roleAssignments: { some: { role: { key: 'OWNER' } } } }, select: { id: true } });
    return { id, ownerId: owner.id };
  }
  const emitir = async (id: string) => {
    const r = await post(`/platform/organizations/${id}/invoices`, { month: mes });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; folio: string; dueDate: string; totalCents: string };
  };
  /** Lo que suspender NO debe mover: las facturas y los pagos de la marca, y cuánto hay de todo lo suyo. */
  async function foto(id: string) {
    const d = db();
    const [facturas, pagos, socios, cuentas, sedes, cargos, cobros, asignaciones, modulos] = await Promise.all([
      d.platformInvoice.findMany({ where: { organizationId: id }, orderBy: { folio: 'asc' } }),
      d.platformPayment.findMany({ where: { organizationId: id }, orderBy: { id: 'asc' } }),
      d.member.count({ where: { organizationId: id } }),
      d.user.findMany({ where: { organizationId: id }, select: { id: true, isActive: true, deletedAt: true }, orderBy: { id: 'asc' } }),
      d.branch.findMany({ where: { organizationId: id }, select: { id: true, isActive: true, deletedAt: true } }),
      d.charge.count({ where: { organizationId: id } }),
      d.payment.count({ where: { organizationId: id } }),
      d.roleAssignment.count({ where: { organizationId: id, revokedAt: null } }),
      d.organizationEntitlement.findMany({ where: { organizationId: id }, select: { moduleKey: true, granted: true }, orderBy: { moduleKey: 'asc' } }),
    ]);
    return JSON.stringify({ facturas, pagos, socios, cuentas, sedes, cargos, cobros, asignaciones, modulos }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    plataforma = await loginPlataforma(app);
    usuario = (await get('/platform/me')).json().userId as string;
    preciosDeAntes = await preciosActuales();
    await ponerPrecios({ core: 150000n, cash: 30000n, classes: 50000n });
  });
  afterAll(async () => {
    const devolver = Object.fromEntries(['core', 'cash', 'classes'].filter((k) => k in preciosDeAntes).map((k) => [k, preciosDeAntes[k]!]));
    await ponerPrecios(devolver);
    await app.close(); await closeDb();
  });

  it('el conteo de días: aviso al emitir, aviso al vencer, y suspensión sola el día 15 de atraso avisado; suspender no borra ni cobra nada y todo queda en la cadena', async () => {
    const { id, ownerId } = await marca('Conteo');
    const f = await emitir(id);
    expect(f.dueDate).toBe(masDias(hoy, 10));

    // 1. Al emitir nace el aviso de «emitida», asentado en la bitácora de la marca.
    let avisos = await avisosDe(id);
    expect(avisos.map((a) => a.kind)).toEqual(['INVOICE_ISSUED']);
    expect(avisos[0]!.body).toContain(f.folio);
    expect(avisos[0]!.body).toContain('$2,300.00');
    // Sin llaves de notificación en las pruebas no llega a ningún teléfono: no hay constancia de entrega.
    expect(avisos[0]).toMatchObject({ deliveredOn: null, pushDevices: 0, invoiceId: f.id });

    // 2. El día del vencimiento todavía está en plazo: ni aviso de vencida ni nada.
    expect(await correr(10, [id])).toMatchObject({ noticesIssued: 0, noticesOverdue: 0, suspended: [] });
    // 3. El primer día de atraso nace el aviso de «vencida». Nadie se suspende en la corrida que crea su aviso.
    const dia11 = await correr(11, [id]);
    expect(dia11).toMatchObject({ day: masDias(hoy, 11), noticesOverdue: 1, suspended: [] });
    expect(dia11.withoutDelivery).toEqual([{ organizationId: id, tradeName: `Conteo ${sufijo}`, folio: f.folio, overdueDays: 1 }]);
    // Repetir la corrida el mismo día no duplica el aviso.
    expect(await correr(11, [id])).toMatchObject({ noticesOverdue: 0, suspended: [] });
    avisos = await avisosDe(id);
    expect(avisos.map((a) => a.kind)).toEqual(['INVOICE_ISSUED', 'INVOICE_OVERDUE']);
    expect(avisos[1]!.body).toMatch(/se suspende a los 15 días de atraso/);

    // 4. Ese mismo día el dueño lo ve en su panel: desde ahí cuentan los 15 días.
    expect(await cobranza.marcarVistos(id, ownerId, elDia(11))).toBe(2);
    expect(await cobranza.marcarVistos(id, ownerId, elDia(12))).toBe(0);
    expect((await avisosDe(id))[1]!.deliveredOn?.toISOString().slice(0, 10)).toBe(masDias(hoy, 11));
    const dia24 = await cobranza.deMarca(id, elDia(24));
    expect(dia24.collections).toMatchObject({ state: 'EN_PLAZO', folio: f.folio, overdueDays: 14, noticedDays: 14, suspendsOn: masDias(hoy, 25), suspendsAfterDays: 15 });

    // 5. El día 14 de atraso NO se suspende; el 15, sí, sin que nadie lo confirme.
    const antes = await foto(id);
    expect(await correr(24, [id])).toMatchObject({ suspended: [] });
    expect((await servicio(id)).serviceStatus).toBe('ACTIVE');
    const dia25 = await correr(25, [id]);
    expect(dia25.suspended).toEqual([{ organizationId: id, tradeName: `Conteo ${sufijo}`, folio: f.folio, noticedDays: 15 }]);
    const suspendida = await servicio(id);
    expect(suspendida).toMatchObject({ serviceStatus: 'SUSPENDED', suspendedAutomatically: true });
    expect(suspendida.suspendedReason).toMatch(new RegExp(`^Falta de pago: la factura ${f.folio} lleva 15 días vencida`));
    // Repetir la corrida no vuelve a suspender ni a asentar.
    expect((await correr(25, [id])).suspended).toEqual([]);

    // 6. SUSPENDER NO BORRA NI COBRA NADA: las facturas, los pagos, las cuentas, los socios, los cargos y lo contratado están idénticos.
    expect(await foto(id)).toBe(antes);
    const factura = (await cobro.factura(f.id, elDia(25)))!;
    expect(factura).toMatchObject({ status: 'PENDING', state: 'VENCIDA', totalCents: '230000', paidCents: '0', balanceCents: '230000', dueDate: f.dueDate });
    expect(factura.lines).toHaveLength(3);

    // 7. Todo quedó en la bitácora de la marca, como acto del sistema, y en la cadena de plataforma.
    const suyos = await asientosDe(id, 'platform.');
    const acciones = suyos.map((a) => a.action);
    expect(acciones.filter((a) => a === 'platform.notice.send')).toHaveLength(3);
    expect(acciones.filter((a) => a === 'platform.notice.deliver')).toHaveLength(2);
    expect(acciones.filter((a) => a === 'platform.service.auto_suspend')).toHaveLength(1);
    const asiento = suyos.find((a) => a.action === 'platform.service.auto_suspend')!;
    expect(asiento.actorType).toBe('SYSTEM');
    expect(asiento.reason).toMatch(/Falta de pago/);
    expect(asiento.afterState).toMatchObject({
      serviceStatus: 'SUSPENDED', previous: 'ACTIVE', automatic: true, folio: f.folio, amountCents: '230000',
      dueDate: f.dueDate, overdueDays: 15, noticedDays: 15, noticeDeliveredOn: masDias(hoy, 11), afterDays: 15,
    });
    expect(await enCadena(id, 'platform.service.auto_suspend')).toBe(1);
    expect(await enCadena(id, 'platform.notice.send')).toBe(3);
    expect(await enCadena(id, 'platform.notice.deliver')).toBe(2);
    const corridas = await db().platformAuditLog.findMany({ where: { action: 'platform.collections.run' }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 5, select: { afterState: true } });
    expect(corridas.some((c) => (c.afterState as { suspended?: string[] }).suspended?.includes(`Conteo ${sufijo}`))).toBe(true);
    expect((await new PlatformAuditService().verifyChain()).ok).toBe(true);
    // La consola lo lee en «Lo que GymFlow hizo aquí» con su frase.
    const frases = (await get(`/platform/organizations/${id}/audit?limit=30`)).json().entries as Array<{ action: string; phrase: string }>;
    expect(frases.find((e) => e.action === 'platform.service.auto_suspend')!.phrase).toMatch(/suspendió el servicio por falta de pago/);
    // Y el dueño recibe el aviso de que quedó suspendido, que dice que no se borró nada.
    const ultimo = (await avisosDe(id)).at(-1)!;
    expect(ultimo.kind).toBe('SERVICE_SUSPENDED');
    expect(ultimo.body).toMatch(/No se borró nada/);
    const detalle = (await get(`/platform/organizations/${id}`)).json();
    expect(detalle).toMatchObject({ serviceStatus: 'SUSPENDED', suspendedAutomatically: true, autoSuspendHoldUntil: null });
  });

  it('al registrar el pago se ofrece reanudar en el mismo paso: sin pedirlo no se reanuda; pidiéndolo, queda en uso y asentado', async () => {
    const { id, ownerId } = await marca('Reanudar');
    const f = await emitir(id);
    await correr(11, [id]);
    await cobranza.marcarVistos(id, ownerId, elDia(11));
    expect((await correr(25, [id])).suspended).toHaveLength(1);

    // Un abono SIN pedir reanudar: la respuesta dice que se puede, pero no lo hace sola.
    const abono = await post(`/platform/invoices/${f.id}/pay`, { amountCents: '100000', paymentMethod: 'SPEI_TRANSFER', paymentRef: 'SPEI 100' });
    expect(abono.statusCode, abono.body).toBe(200);
    expect(abono.json().service).toEqual({ status: 'SUSPENDED', suspendedAutomatically: true, canResume: true, resumed: false, holdUntil: null });
    expect((await servicio(id)).serviceStatus).toBe('SUSPENDED');
    expect((await get(`/platform/invoices/${f.id}`)).json().organization).toMatchObject({ serviceStatus: 'SUSPENDED', suspendedAutomatically: true });

    // El resto, pidiendo reanudar: en el mismo paso queda en uso.
    const pago = await post(`/platform/invoices/${f.id}/pay`, { paymentMethod: 'SPEI_TRANSFER', paymentRef: 'SPEI 130', resume: true });
    expect(pago.statusCode, pago.body).toBe(200);
    expect(pago.json()).toMatchObject({ status: 'PAID', state: 'PAGADA', service: { status: 'ACTIVE', suspendedAutomatically: false, canResume: false, resumed: true, holdUntil: null } });
    expect(await servicio(id)).toMatchObject({ serviceStatus: 'ACTIVE', suspendedAutomatically: false, suspendedReason: null, suspendedAt: null });
    const reanudo = (await asientosDe(id, 'platform.service.')).at(-1)!;
    expect(reanudo).toMatchObject({ action: 'platform.service.resume', reason: `Pago recibido: ${f.folio}`, afterState: { serviceStatus: 'ACTIVE', previous: 'SUSPENDED', byPlatformUserId: usuario } });
    // Pagada la factura, sus avisos ya no hacen falta; el de «suspendido» se cierra al reanudar.
    const avisos = await avisosDe(id);
    expect(avisos.every((a) => a.closedAt !== null)).toBe(true);
    expect(avisos.find((a) => a.kind === 'SERVICE_SUSPENDED')!.closeReason).toBe('PAID');
    // Pedir reanudar al pagar a una marca que está en uso no hace nada raro.
    const otra = await marca('EnUso');
    const g = await emitir(otra.id);
    expect((await post(`/platform/invoices/${g.id}/pay`, { paymentMethod: 'CASH', resume: true })).json().service).toMatchObject({ status: 'ACTIVE', canResume: false, resumed: false });
    // Con todo pagado, las corridas siguientes no la tocan.
    expect(await correr(60, [id, otra.id])).toMatchObject({ noticesOverdue: 0, suspended: [] });
  });

  it('reanudar a quien todavía debe algo vencido le da 15 días de prórroga: el cierre de mañana no la vuelve a suspender', async () => {
    const { id, ownerId } = await marca('Prorroga');
    const f = await emitir(id);
    await correr(11, [id]);
    await cobranza.marcarVistos(id, ownerId, elDia(11));
    expect((await correr(25, [id])).suspended).toHaveLength(1);
    // El día 26 abona una parte y se reanuda en el mismo paso (el reloj de prueba va por el servicio).
    const pago = await cobro.pagar(f.id, usuario, { amountCents: 100000n, paymentMethod: 'CASH', resume: true }, elDia(26));
    expect(pago.service).toEqual({ status: 'ACTIVE', suspendedAutomatically: false, canResume: false, resumed: true, holdUntil: masDias(hoy, 26 + DIAS_DE_PRORROGA) });
    expect((await asientosDe(id, 'platform.collections.hold')).at(-1)!.afterState).toMatchObject({ holdUntil: masDias(hoy, 41), onResume: true, folios: [f.folio] });
    // Sigue debiendo y su aviso lleva semanas entregado, pero está en prórroga.
    const dia27 = await correr(27, [id]);
    expect(dia27.suspended).toEqual([]);
    expect(dia27.onHold).toEqual([{ organizationId: id, tradeName: `Prorroga ${sufijo}`, until: masDias(hoy, 41) }]);
    expect((await cobranza.deMarca(id, elDia(27))).collections).toMatchObject({ state: 'PRORROGA', holdUntil: masDias(hoy, 41), suspendsOn: masDias(hoy, 42) });
    expect((await correr(41, [id])).suspended).toEqual([]);
    // Pasada la prórroga sin pagar, se suspende otra vez.
    expect((await correr(42, [id])).suspended).toHaveLength(1);
    expect((await asientosDe(id, 'platform.service.auto_suspend'))).toHaveLength(2);

    // La prórroga a mano, desde la consola: con motivo, con tope, y se puede quitar.
    const hold = (until: string | null, reason = 'Habló el dueño: paga el viernes') => put(`/platform/organizations/${id}/collections-hold`, { until, reason });
    expect((await hold(masDias(hoy, -1))).statusCode).toBe(422);
    expect((await hold(masDias(hoy, 61))).statusCode).toBe(422);
    expect((await put(`/platform/organizations/${id}/collections-hold`, { until: masDias(hoy, 5) })).statusCode).toBe(422);
    const dada = await hold(masDias(hoy, 5));
    expect(dada.statusCode, dada.body).toBe(200);
    expect(dada.json()).toEqual({ holdUntil: masDias(hoy, 5) });
    expect((await get(`/platform/organizations/${id}`)).json().autoSuspendHoldUntil).toBe(masDias(hoy, 5));
    expect((await hold(null)).json()).toEqual({ holdUntil: null });
    expect((await asientosDe(id, 'platform.collections.hold')).at(-1)).toMatchObject({ reason: 'Habló el dueño: paga el viernes', afterState: { holdUntil: null, byPlatformUserId: usuario } });
  });

  it('un pago deshecho devuelve la factura a vencida con un aviso NUEVO: los 15 días vuelven a contar desde que ese aviso llegue', async () => {
    const { id, ownerId } = await marca('Deshecho');
    const f = await emitir(id);
    await correr(11, [id]);
    await cobranza.marcarVistos(id, ownerId, elDia(11));
    // El día 20 se registra el pago completo: los avisos se cierran.
    const pago = await cobro.pagar(f.id, usuario, { paymentMethod: 'CASH' }, elDia(20));
    expect((await avisosDe(id)).every((a) => a.closeReason === 'PAID')).toBe(true);
    // El día 24 se deshace (era de otra marca): la factura vuelve a deber y ya lleva 14 días vencida.
    await cobro.deshacerPago(f.id, pago.payments[0]!.id, usuario, 'El pago era de otra marca');
    const dia30 = await correr(30, [id]);
    // No se suspende aunque lleve 20 días vencida: el aviso anterior se cerró con el pago; nace uno nuevo, sin entregar.
    expect(dia30).toMatchObject({ noticesOverdue: 1, suspended: [] });
    expect(dia30.withoutDelivery).toHaveLength(1);
    const avisos = await avisosDe(id);
    expect(avisos.filter((a) => a.kind === 'INVOICE_OVERDUE').map((a) => [a.dedupeKey.endsWith(':1'), a.closedAt !== null])).toEqual([[true, true], [false, false]]);
    // Llega el día 30: se suspende el 44, no antes.
    await cobranza.marcarVistos(id, ownerId, elDia(30));
    expect((await correr(43, [id])).suspended).toEqual([]);
    expect((await correr(44, [id])).suspended).toHaveLength(1);
  });

  describe('una marca que YA tenía una factura vencida cuando esto se estrena', () => {
    let gym: GimnasioPropio;
    let facturaId: string;
    let folio: string;

    beforeAll(async () => {
      gym = await gimnasioPropio();
      // La factura ya existía: emitida hace 50 días, vencida hace 40, y de ella nunca se avisó (no había avisos).
      const f = await new PlatformBillingRepository().issue({
        organizationId: gym.organizationId, periodStart: `${masDias(hoy, -50).slice(0, 7)}-01`, periodEnd: `${masDias(hoy, -50).slice(0, 7)}-28`,
        lines: [{ key: 'core', name: 'Lo básico (software)', monthlyCents: '150000' }], totalCents: 150000n, dueDate: masDias(hoy, -40), note: null, byUserId: null,
      });
      facturaId = f.id; folio = f.folio;
    });
    afterAll(async () => { await gym.cerrar(); });

    it('la PRIMERA corrida no la suspende: le crea el aviso de vencida, y sin constancia de que le llegó no pasa nada más', async () => {
      const primera = await correr(0, [gym.organizationId]);
      expect(primera).toMatchObject({ noticesIssued: 0, noticesOverdue: 1, suspended: [] });
      expect(primera.withoutDelivery).toEqual([expect.objectContaining({ organizationId: gym.organizationId, folio, overdueDays: 40 })]);
      expect((await servicio(gym.organizationId)).serviceStatus).toBe('ACTIVE');
      // Ni mañana, ni en dos meses: mientras el aviso no tenga constancia de entrega, el sistema no la apaga.
      for (const n of [1, 15, 60]) expect((await correr(n, [gym.organizationId])).suspended).toEqual([]);
      expect((await servicio(gym.organizationId)).serviceStatus).toBe('ACTIVE');
      expect((await avisosDe(gym.organizationId)).map((a) => a.kind)).toEqual(['INVOICE_OVERDUE']);
    });

    it('la consola la muestra en «Avisos por mandar» con el celular del dueño; al marcarlo como mandado empiezan sus 15 días', async () => {
      const tablero = (await get('/platform/collections')).json();
      expect(tablero.suspendsAfterDays).toBe(15);
      const enRiesgo = tablero.atRisk.find((x: { organizationId: string }) => x.organizationId === gym.organizationId);
      expect(enRiesgo).toMatchObject({ state: 'AVISO_SIN_ENTREGAR', folio, overdueDays: 40, noticedDays: 0, suspendsOn: null });
      const porMandar = tablero.toSend.find((x: { organizationId: string }) => x.organizationId === gym.organizationId);
      expect(porMandar).toMatchObject({ kind: 'INVOICE_OVERDUE', invoiceId: facturaId, deliveredOn: null });
      expect(porMandar.owners).toEqual([expect.objectContaining({ id: gym.ownerId })]);

      const mandado = await post(`/platform/notices/${porMandar.id}/sent`);
      expect(mandado.statusCode, mandado.body).toBe(200);
      expect(mandado.json()).toMatchObject({ deliveredOn: hoy, pushDevices: 0, seenAt: null });
      expect(mandado.json().sentAt).toBeTruthy();
      // Marcarlo otra vez no mueve la fecha ni asienta de nuevo.
      await post(`/platform/notices/${porMandar.id}/sent`);
      expect(await asientosDe(gym.organizationId, 'platform.notice.deliver')).toHaveLength(1);
      expect((await asientosDe(gym.organizationId, 'platform.notice.deliver'))[0]!.afterState).toMatchObject({ via: 'PERSON', firstDelivery: true, byPlatformUserId: usuario });
      expect((await get('/platform/collections')).json().toSend.some((x: { id: string }) => x.id === porMandar.id)).toBe(false);
      expect((await post('/platform/notices/00000000-0000-7000-8000-000000000000/sent')).statusCode).toBe(404);

      // Lleva 40 días vencida, pero su conteo empieza HOY: 14 días más en uso, y el 15 se suspende.
      expect((await correr(0, [gym.organizationId])).suspended).toEqual([]);
      expect((await cobranza.deMarca(gym.organizationId, elDia(0))).collections).toMatchObject({ state: 'EN_PLAZO', overdueDays: 40, noticedDays: 1, suspendsOn: masDias(hoy, 14) });
      expect((await correr(13, [gym.organizationId])).suspended).toEqual([]);
    });

    it('el dueño la ve en su panel (solo consulta, solo él): lo que debe, cuándo se suspende y sus avisos', async () => {
      const dueno = await loginAs(app, gym.correos.owner);
      const cuenta = await app.inject({ method: 'GET', url: '/gymflow-account', headers: { cookie: dueno } });
      expect(cuenta.statusCode, cuenta.body).toBe(200);
      expect(cuenta.json()).toMatchObject({
        visible: true, serviceStatus: 'ACTIVE', status: { code: 'VENCIDA', overdueDays: 40, pendingCents: '150000' }, suspendsOn: masDias(hoy, 14), suspendsAfterDays: 15,
        invoices: [{ id: facturaId, folio, state: 'VENCIDA', balanceCents: '150000', overdueDays: 40 }],
        notices: [{ kind: 'INVOICE_OVERDUE', seen: false }],
      });
      // Al tenerlos a la vista queda constancia, con quién; la fecha de entrega que ya había no se mueve.
      const visto = await app.inject({ method: 'POST', url: '/gymflow-account/seen', headers: { cookie: dueno } });
      expect(visto.json()).toEqual({ seen: 1 });
      expect((await app.inject({ method: 'POST', url: '/gymflow-account/seen', headers: { cookie: dueno } })).json()).toEqual({ seen: 0 });
      const aviso = (await avisosDe(gym.organizationId))[0]!;
      expect(aviso.seenByUserId).toBe(gym.ownerId);
      expect(aviso.deliveredOn?.toISOString().slice(0, 10)).toBe(hoy);
      // La gerencia y recepción no ven la cuenta ni dejan constancia.
      for (const correo of [gym.correos.gerente, gym.correos.recepcion]) {
        const cookie = await loginAs(app, correo);
        expect((await app.inject({ method: 'GET', url: '/gymflow-account', headers: { cookie } })).json()).toMatchObject({ visible: false, invoices: [], notices: [], status: { pendingCents: '0' } });
        expect((await app.inject({ method: 'POST', url: '/gymflow-account/seen', headers: { cookie } })).json()).toEqual({ seen: 0 });
      }
      expect((await app.inject({ method: 'GET', url: '/gymflow-account' })).statusCode).toBe(401);
    });

    it('el día 15 desde que se le avisó se suspende; a la suspendida no se le vuelve a tocar y su factura sigue igual', async () => {
      const dia14 = await correr(14, [gym.organizationId]);
      expect(dia14.suspended).toEqual([expect.objectContaining({ organizationId: gym.organizationId, folio, noticedDays: 15 })]);
      expect((await asientosDe(gym.organizationId, 'platform.service.auto_suspend'))[0]!.afterState).toMatchObject({ overdueDays: 54, noticedDays: 15, noticeDeliveredOn: hoy });
      expect(await db().platformInvoice.findUniqueOrThrow({ where: { id: facturaId }, select: { status: true, totalCents: true, paidCents: true } })).toEqual({ status: 'PENDING', totalCents: 150000n, paidCents: 0n });
      expect(await correr(30, [gym.organizationId])).toMatchObject({ noticesOverdue: 0, suspended: [] });
      // Para que `cerrar()` y los demás archivos encuentren el gimnasio como estaba.
      await post(`/platform/organizations/${gym.organizationId}/service`, { status: 'ACTIVE', reason: 'Fin de la prueba' });
      forgetModules(gym.organizationId);
    });
  });

  it('D-38 · cambiar el precio o los módulos de un plan que una marca tiene se ANUNCIA: la marca conserva su versión hasta la fecha y ese día le aplica', async () => {
    const creado = await post('/platform/plans', { name: `Plan aviso ${sufijo}`, modules: ['cash'], monthlyCents: '180000' });
    expect(creado.statusCode, creado.body).toBe(201);
    const planId = creado.json().id as string;
    const { id } = await marca('ConPlan', { template: undefined, contracted: undefined, planId });
    const billing = async () => (await get(`/platform/organizations/${id}/billing`)).json();
    const desde = primeraVigencia(hoy);
    expect((await billing()).monthly).toMatchObject({ totalCents: '180000', lines: [{ key: `plan:${planId}`, monthlyCents: '180000' }] });
    // La marca guarda SU versión del plan.
    const version = async () => (await db().organization.findUniqueOrThrow({ where: { id }, select: { platformPlanSnapshot: true } })).platformPlanSnapshot;
    expect(await version()).toEqual({ planId, name: `Plan aviso ${sufijo}`, monthlyCents: '180000', modules: ['cash'], since: hoy });

    // Antes de guardar, la consola puede ver a quién le cambia y desde cuándo.
    const previa = await post(`/platform/plans/${planId}/change-preview`, { monthlyCents: '200000', modules: ['cash', 'classes'] });
    expect(previa.statusCode, previa.body).toBe(200);
    expect(previa.json()).toMatchObject({ minEffectiveFrom: desde, effectiveFrom: desde, immediate: false, organizations: 1 });
    expect(previa.json().affected).toEqual([{ organizationId: id, tradeName: `ConPlan ${sufijo}`, beforeCents: '180000', afterCents: '200000' }]);

    // Con menos de un mes de aviso no pasa; con la fecha bien, queda anunciado y el nombre (que no mueve dinero) cambia ya.
    const pronto = await put(`/platform/plans/${planId}`, { monthlyCents: '200000', effectiveFrom: `${mes}-01` });
    expect(pronto.statusCode).toBe(422);
    expect(pronto.json().reason).toBe('PRICE_CHANGE_TOO_SOON');

    // Un primer anuncio, que se cancela a tiempo: todo sigue como estaba y, a quien ya había recibido el aviso, se le avisa que ya no aplica.
    const primero = await put(`/platform/plans/${planId}`, { monthlyCents: '250000' });
    expect(primero.statusCode, primero.body).toBe(200);
    const avisoUno = (await avisosDe(id)).filter((a) => a.kind === 'PRICE_CHANGE').at(-1)!;
    expect(avisoUno.body).toMatch(/sube de \$1,800\.00 a \$2,500\.00/);
    await post(`/platform/notices/${avisoUno.id}/sent`);
    const cancelado = await post(`/platform/price-changes/${primero.json().scheduled.id}/cancel`, { reason: 'Se decidió no subirlo tanto' });
    expect(cancelado.json()).toMatchObject({ status: 'CANCELED', cancelReason: 'Se decidió no subirlo tanto' });
    expect((await billing()).upcoming).toBeNull();
    const trasCancelar = await avisosDe(id);
    expect(trasCancelar.find((a) => a.id === avisoUno.id)!.closeReason).toBe('CANCELED');
    expect(trasCancelar.at(-1)).toMatchObject({ kind: 'PRICE_CHANGE_CANCELED' });
    expect(trasCancelar.at(-1)!.body).toMatch(/ya no aplica: tu mensualidad de GymFlow sigue en \$1,800\.00/);

    const anunciosAntes = await db().platformAuditLog.count({ where: { action: 'platform.catalog.change.schedule' } });
    const cambio = await put(`/platform/plans/${planId}`, { name: `Plan aviso ${sufijo} B`, monthlyCents: '200000', modules: ['cash', 'classes'] });
    expect(cambio.statusCode, cambio.body).toBe(200);
    expect(cambio.json()).toMatchObject({
      name: `Plan aviso ${sufijo} B`, monthlyCents: '180000', modules: ['cash'], affected: 1,
      scheduled: { kind: 'PLAN', planId, beforeCents: '180000', afterCents: '200000', beforeModules: ['cash'], afterModules: ['cash', 'classes'], effectiveFrom: desde, announcedOn: hoy, status: 'PENDING' },
    });
    const cambioId = cambio.json().scheduled.id as string;
    expect(await db().platformAuditLog.count({ where: { action: 'platform.catalog.change.schedule' } })).toBe(anunciosAntes + 1);
    // Otro cambio encima del anunciado se rechaza.
    const encima = await put(`/platform/plans/${planId}`, { monthlyCents: '210000' });
    expect(encima.statusCode).toBe(409);
    expect(encima.json().reason).toBe('PRICE_CHANGE_PENDING');

    // HOY la marca paga lo mismo, su ficha muestra su versión, y la factura de este mes sale con lo que tenía.
    const hoyCobro = await billing();
    expect(hoyCobro.monthly.totalCents).toBe('180000');
    expect(hoyCobro.upcoming).toMatchObject({ effectiveFrom: desde, totalCents: '200000' });
    expect((await get(`/platform/organizations/${id}`)).json().plan).toMatchObject({ monthlyCents: '180000', modules: ['cash'] });
    expect((await emitir(id)).totalCents).toBe('180000');
    expect((await moduleViewOf(id)).contracted('classes')).toBe(false);
    // Y recibe su aviso con las dos cifras y la fecha.
    const aviso = (await avisosDe(id)).filter((a) => a.kind === 'PRICE_CHANGE').at(-1)!;
    expect(aviso.closedAt).toBeNull();
    expect(aviso.body).toMatch(/sube de \$1,800\.00 a \$2,000\.00/);
    expect((await get('/platform/price-changes')).json().changes.find((c: { id: string }) => c.id === cambioId)).toMatchObject({ status: 'PENDING', concept: `Plan aviso ${sufijo} B` });

    // La factura del mes avisado ya saldría con lo nuevo aunque el job no lo hubiera aplicado; un día antes, todavía no.
    expect((await cobro.mensualidad(id, { dia: desde })).totalCents).toBe(200000n);
    expect((await cobro.mensualidad(id, { dia: masDias(desde, -1) })).totalCents).toBe(180000n);
    // Antes de la fecha, la corrida no aplica nada.
    expect((await precios.aplicarVencidos(new Date(`${masDias(desde, -1)}T18:00:00.000Z`), { soloCambios: [cambioId] })).applied).toBe(0);
    expect((await get('/platform/plans')).json().plans.find((p: { id: string }) => p.id === planId)).toMatchObject({ monthlyCents: '180000', modules: ['cash'] });

    // Llega la fecha: aplica a todas las marcas del plan, en la corrida y una sola vez.
    const elDiaAvisado = new Date(`${desde}T18:00:00.000Z`);
    expect(await precios.aplicarVencidos(elDiaAvisado, { soloCambios: [cambioId] })).toMatchObject({ applied: 1, organizations: 1, errors: [] });
    expect((await precios.aplicarVencidos(elDiaAvisado, { soloCambios: [cambioId] })).applied).toBe(0);
    expect((await get('/platform/plans')).json().plans.find((p: { id: string }) => p.id === planId)).toMatchObject({ monthlyCents: '200000', modules: ['cash', 'classes'] });
    expect(await version()).toEqual({ planId, name: `Plan aviso ${sufijo} B`, monthlyCents: '200000', modules: ['cash', 'classes'], since: desde });
    forgetModules(id);
    expect((await moduleViewOf(id)).contracted('classes')).toBe(true);
    expect((await cobro.resumen(id, elDiaAvisado)).monthly.totalCents).toBe('200000');
    // Facturar tarde un mes anterior a la fecha usa lo que la marca tenía entonces.
    expect((await cobro.mensualidad(id, { dia: `${mes}-01` })).totalCents).toBe(180000n);
    // Queda en la bitácora de la marca, en la cadena de plataforma, y su aviso se cierra.
    expect((await asientosDe(id, 'platform.plan.version'))[0]!.afterState).toMatchObject({ monthlyCents: '200000', modules: ['cash', 'classes'], effectiveFrom: desde });
    expect(await db().platformAuditLog.count({ where: { action: 'platform.catalog.change.apply', resourceId: cambioId } })).toBe(1);
    expect((await avisosDe(id)).find((a) => a.id === aviso.id)!.closeReason).toBe('APPLIED');
    // Un cambio ya aplicado no se cancela.
    expect((await post(`/platform/price-changes/${cambioId}/cancel`, { reason: 'Tarde' })).json().reason).toBe('PRICE_CHANGE_CLOSED');

    expect((await new PlatformAuditService().verifyChain()).ok).toBe(true);
  });
});
