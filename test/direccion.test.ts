import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, nombreUnico, telefonoUnico } from './helpers.js';
import { gimnasioPropio, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { ModuleStateRepository } from '../src/platform/modules/module-state.repository.js';
import { forgetModules } from '../src/platform/modules/module-state.js';

/**
 * FASE 2 · BLOQUE 2.7 · DIRECCIÓN.
 *
 * Planes: el impacto de un cambio por sucursal de venta (16-04) y la visita
 * suelta sin inscripción, gracia ni duración (16-08, 16-11). Mi gimnasio: los
 * datos de la marca en consulta (D-27), «Falta configurar» (19-08) y lo
 * contratado (19-09). Sucursales: no se cierra con lugares reservados.
 * Importar: el resumen de dinero (18-04), cargar sin motivo (18-07), sin
 * apellidos no entra «—» (18-10) y dos sucursales sin columna de sucursal ya
 * no comparten sus códigos (pendiente de la fase 1).
 *
 * Todo en un gimnasio propio: nadie más ve sus planes, sedes ni socios.
 */
describe('dirección (2.7)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente = '';
  let owner = '';
  let recepcion = '';
  let ajeno = '';

  const db = () => getDb();
  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const enDias = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const codigo = () => `P${randomUUID().slice(0, 8).toUpperCase()}`;

  async function vender(memberId: string, planId: string, branchId: string) {
    const r = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: gerente },
      payload: { planId, branchId, saleKey: `venta-${randomUUID()}`, payment: { method: 'SPEI_TRANSFER', externalRef: `DIR${randomUUID().slice(0, 10)}` } },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().membership.id as string;
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Casa Centro', cajas: 1 }, { name: 'Casa Norte', cajas: 1 }] });
    [gerente, owner, recepcion, ajeno] = await Promise.all([
      loginAs(app, g.correos.gerente), loginAs(app, g.correos.owner), loginAs(app, g.correos.recepcion), loginAs(app, 'gerencia@demo.mx'),
    ]);
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  // ── Planes ────────────────────────────────────────────────────────────────

  it('el impacto de un plan cuenta por sucursal de venta, con y sin precio pactado (16-04)', async () => {
    const [centro, norte] = g.sedes as [GimnasioPropio['sedes'][number], GimnasioPropio['sedes'][number]];
    const [a, b, c] = await Promise.all([socioPropio(g, centro), socioPropio(g, centro), socioPropio(g, norte)]);
    await vender(a, g.planMensual, centro.id);
    const sinPacto = await vender(b, g.planMensual, centro.id);
    await vender(c, g.planMensual, norte.id);
    // Así quedaron los cambios de plan anteriores a la fase 1: sin precio pactado.
    await db().membership.update({ where: { id: sinPacto }, data: { agreedPriceCents: null } });
    // Norte tiene precio propio y deja de venderlo: quien ya lo compró ahí sigue contando.
    await db().planBranchAvailability.update({ where: { planId_branchId: { planId: g.planMensual, branchId: norte.id } }, data: { isAvailable: false, priceOverrideCents: 66_000n } });

    const r = await get(gerente, `/plans/${g.planMensual}/impact`);
    expect(r.statusCode, r.body).toBe(200);
    const i = r.json();
    expect(i).toMatchObject({ planId: g.planMensual, isActive: true, priceCents: '60000', liveMemberships: 3, withAgreedPrice: 2, withoutAgreedPrice: 1, livePacks: 0 });
    const enCentro = i.branches.find((x: { branchId: string }) => x.branchId === centro.id);
    const enNorte = i.branches.find((x: { branchId: string }) => x.branchId === norte.id);
    expect(enCentro).toMatchObject({ isAvailable: true, listPriceCents: '60000', hasOwnPrice: false, liveMemberships: 2, withAgreedPrice: 1, withoutAgreedPrice: 1 });
    expect(enNorte).toMatchObject({ isAvailable: false, listPriceCents: '66000', hasOwnPrice: true, liveMemberships: 1, withAgreedPrice: 1, withoutAgreedPrice: 0 });

    // Es de quien arma el catálogo: recepción y la dueña no, y otro gimnasio no lo encuentra.
    expect((await get(recepcion, `/plans/${g.planMensual}/impact`)).statusCode).toBe(403);
    expect((await get(owner, `/plans/${g.planMensual}/impact`)).statusCode).toBe(403);
    expect((await get(ajeno, `/plans/${g.planMensual}/impact`)).statusCode).toBe(404);
  });

  it('el impacto cuenta los paquetes de visitas vivos (16-05)', async () => {
    const centro = g.sedes[0]!;
    const alta = await app.inject({
      method: 'POST', url: '/plans', headers: { cookie: gerente },
      payload: { code: codigo(), name: 'Paquete 10', billingModel: 'VISIT_PACK', durationUnit: 'VISIT', durationValue: 10, visitsIncluded: 10, priceCents: '90000', reason: 'Plan de la prueba 2.7' },
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const planId = alta.json().id as string;
    const socio = await socioPropio(g, centro);
    await db().visitPack.create({
      data: { id: randomUUID(), organizationId: g.organizationId, memberId: socio, planId, soldAtBranchId: centro.id, visitsPurchased: 10, purchasedOn: new Date(`${hoy()}T00:00:00.000Z`), status: 'ACTIVE' },
    });
    const i = (await get(gerente, `/plans/${planId}/impact`)).json();
    expect(i).toMatchObject({ liveMemberships: 0, livePacks: 1 });
    expect(i.branches.find((x: { branchId: string }) => x.branchId === centro.id).livePacks).toBe(1);
  });

  it('la visita suelta se guarda sin inscripción, gracia ni duración, las mande quien las mande (16-08, 16-11)', async () => {
    const alta = await app.inject({
      method: 'POST', url: '/plans', headers: { cookie: gerente },
      payload: {
        code: codigo(), name: 'Visita suelta', billingModel: 'DAY_PASS', durationUnit: 'DAY', durationValue: 7,
        priceCents: '15000', signupFeeCents: '30000', defaultGraceDays: 5, allowFreeze: true, autoRenewDefault: true, reason: 'Plan de la prueba 2.7',
      },
    });
    expect(alta.statusCode, alta.body).toBe(201);
    expect(alta.json()).toMatchObject({ signupFeeCents: '0', defaultGraceDays: 0, durationUnit: 'DAY', durationValue: 1, allowFreeze: false, autoRenewDefault: false });

    // Editarla tampoco se las devuelve; el precio sí cambia.
    const cambio = await app.inject({
      method: 'PATCH', url: `/plans/${alta.json().id}`, headers: { cookie: gerente },
      payload: { priceCents: '18000', signupFeeCents: '20000', defaultGraceDays: 3, reason: 'Ajuste de precio de la prueba' },
    });
    expect(cambio.statusCode, cambio.body).toBe(200);
    expect(cambio.json()).toMatchObject({ priceCents: '18000', signupFeeCents: '0', defaultGraceDays: 0 });

    // Una mensualidad que pasa a visita suelta queda igual de limpia.
    const mensual = await app.inject({
      method: 'POST', url: '/plans', headers: { cookie: gerente },
      payload: { code: codigo(), name: 'Mensual con inscripción', billingModel: 'RECURRING', durationUnit: 'MONTH', durationValue: 1, priceCents: '50000', signupFeeCents: '30000', reason: 'Plan de la prueba 2.7' },
    });
    expect(mensual.json()).toMatchObject({ signupFeeCents: '30000', defaultGraceDays: 5 });
    const aVisita = await app.inject({
      method: 'PATCH', url: `/plans/${mensual.json().id}`, headers: { cookie: gerente },
      payload: { billingModel: 'DAY_PASS', durationUnit: 'DAY', reason: 'Ahora es visita suelta' },
    });
    expect(aVisita.statusCode, aVisita.body).toBe(200);
    expect(aVisita.json()).toMatchObject({ billingModel: 'DAY_PASS', signupFeeCents: '0', defaultGraceDays: 0, durationValue: 1 });
  });

  // ── Mi gimnasio ───────────────────────────────────────────────────────────

  it('los datos del gimnasio se consultan y no se cambian desde el panel (D-27)', async () => {
    const r = await get(gerente, '/organization/profile');
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json();
    expect(p.tradeName).toMatch(/^Propio /);
    expect(p.legalName).toMatch(/S\.A\.$/);
    expect(p).toMatchObject({ timezone: 'America/Mexico_City', defaultCurrency: 'MXN', billingEmail: null, branches: { open: 2, closed: 0 } });
    // Sin plan de la plataforma: contrato a la medida, todo lo contratado va como incluido.
    expect(p.plan.name).toBeNull();
    expect(p.plan.included).toContain('Caja');
    expect(p.plan.addOns).toEqual([]);
    expect(p.rules).toMatchObject({ managerAttendsFrontDesk: false, monthsAfterArchive: null });

    expect((await get(owner, '/organization/profile')).statusCode).toBe(200);
    expect((await get(recepcion, '/organization/profile')).statusCode).toBe(403);
    // No hay con qué escribirlos.
    for (const method of ['PUT', 'PATCH', 'POST'] as const) {
      expect((await app.inject({ method, url: '/organization/profile', headers: { cookie: gerente }, payload: { tradeName: 'Otro' } })).statusCode).toBe(404);
    }
  });

  it('con un plan de la plataforma, Mi gimnasio dice qué trae y qué se agregó aparte (19-09)', async () => {
    // Uno fijo y fuera de catálogo: el rol de la API no borra planes de la plataforma, así que se reutiliza.
    const planId = '0193aaaa-2707-7000-8000-000000002707';
    await db().platformPlan.upsert({ where: { id: planId }, update: {}, create: { id: planId, name: 'Plan prueba 2.7', modules: ['cash', 'pos'], isActive: false } });
    await db().organization.update({ where: { id: g.organizationId }, data: { platformPlanId: planId } });
    const contratos = new ModuleStateRepository(g.organizationId);
    await contratos.setEntitlement('turnstile', false, null, 'Prueba 2.7');
    forgetModules(g.organizationId);
    try {
      const p = (await get(gerente, '/organization/profile')).json();
      expect(p.plan.name).toMatch(/^Plan prueba/);
      expect(p.plan.included.sort()).toEqual(['Caja', 'Punto de venta']);
      expect(p.plan.addOns).toContain('Clases');
      expect(p.plan.notContracted).toHaveLength(1);

      const m = (await get(gerente, '/organization/modules')).json();
      expect(m.plan).toMatchObject({ name: p.plan.name, included: 2 });
      expect(m.plan.addOns).toBe(p.plan.addOns.length);
      // Recepción ve qué está encendido, no lo contratado.
      expect((await get(recepcion, '/organization/modules')).json().plan).toBeUndefined();
    } finally {
      await contratos.setEntitlement('turnstile', true, null, 'Prueba 2.7');
      await db().organization.update({ where: { id: g.organizationId }, data: { platformPlanId: null } });
      forgetModules(g.organizationId);
    }
  });

  it('Módulos distingue «encendido» de «falta configurar» (19-08)', async () => {
    type M = { key: string; enabled: boolean; setup?: { text: string; action: string; href: string } | null };
    const modulos = async (cookie: string) => (await get(cookie, '/organization/modules')).json().modules as M[];
    const de = (ms: M[], key: string) => ms.find((m) => m.key === key)!;

    const antes = await modulos(gerente);
    // Punto de venta encendido y sin un solo producto; Caja ya tiene sus cajas.
    expect(de(antes, 'pos')).toMatchObject({ enabled: true, setup: { action: 'Dar de alta productos', href: '/productos' } });
    expect(de(antes, 'cash').setup).toBeNull();
    expect(de(antes, 'classes').setup).toMatchObject({ href: '/clases' });
    expect(de(antes, 'intake').setup).toMatchObject({ href: '/sucursales' });
    // Prospectos y retención se llenan con la operación: nunca «falta configurar».
    expect(de(antes, 'prospects').setup).toBeNull();
    // La dueña lo ve; recepción no recibe el detalle.
    expect(de(await modulos(owner), 'pos').setup).toMatchObject({ href: '/productos' });
    expect(de(await modulos(recepcion), 'pos').setup).toBeUndefined();

    // Con el primer producto y el primer enlace del alta, dejan de faltar.
    const producto = await app.inject({ method: 'POST', url: '/products', headers: { cookie: gerente }, payload: { name: 'Agua 600 ml', sku: codigo(), priceCents: '1500' } });
    expect(producto.statusCode, producto.body).toBe(201);
    const enlace = await app.inject({ method: 'PATCH', url: `/branches/${g.sedes[0]!.id}`, headers: { cookie: gerente }, payload: { publicSlug: `propio-${randomUUID().slice(0, 8)}` } });
    expect(enlace.statusCode, enlace.body).toBe(200);
    const despues = await modulos(gerente);
    expect(de(despues, 'pos').setup).toBeNull();
    expect(de(despues, 'intake').setup).toBeNull();

    // Apagado no «falta configurar»: está apagado.
    const apagar = await app.inject({ method: 'PUT', url: '/organization/modules/classes', headers: { cookie: gerente }, payload: { enabled: false, reason: 'No damos clases' } });
    expect(apagar.statusCode, apagar.body).toBe(200);
    expect(de(apagar.json().modules as M[], 'classes').setup).toBeNull();
    await app.inject({ method: 'PUT', url: '/organization/modules/classes', headers: { cookie: gerente }, payload: { enabled: true } });
  });

  it('una sede con lugares reservados en clases próximas no se cierra', async () => {
    const otro = await gimnasioPropio({ sedes: [{ name: 'Sede con clases', cajas: 0 }] });
    try {
      const cookie = await loginAs(app, otro.correos.gerente);
      const sede = otro.sedes[0]!;
      // Recepción está asignada a la sede: se le da de baja para llegar a la regla de las reservas.
      await db().user.updateMany({ where: { organizationId: otro.organizationId, email: otro.correos.recepcion }, data: { isActive: false } });
      const tipo = await app.inject({ method: 'POST', url: '/classes/types', headers: { cookie }, payload: { name: 'Yoga de cierre', dropInPriceCents: '0' } });
      expect(tipo.statusCode, tipo.body).toBe(201);
      const inicio = new Date(Date.now() + 3 * 86_400_000);
      const sesion = await db().classSchedule.create({
        data: {
          id: randomUUID(), organizationId: otro.organizationId, branchId: sede.id, classTypeId: tipo.json().id,
          startsAt: inicio, endsAt: new Date(inicio.getTime() + 3_600_000), capacity: 10, bookedCount: 1, status: 'SCHEDULED', occurrenceKey: randomUUID(), businessDate: new Date(`${inicio.toISOString().slice(0, 10)}T00:00:00.000Z`),
        } as never,
      });
      const socio = await socioPropio(otro, sede);
      await db().classBooking.create({ data: { id: randomUUID(), organizationId: otro.organizationId, classScheduleId: sesion.id, memberId: socio, branchId: sede.id, status: 'BOOKED' } as never });

      const resumen = (await get(cookie, `/branches/${sede.id}/closing-summary`)).json();
      expect(resumen.classBlockers).toEqual(['1 lugar reservado en clases próximas']);
      const cerrar = () => app.inject({ method: 'PATCH', url: `/branches/${sede.id}`, headers: { cookie }, payload: { isActive: false, reason: 'Se termina el contrato del local' } });
      const no = await cerrar();
      expect(no.statusCode).toBe(409);
      expect(no.json().detail).toBe('BRANCH_HAS_BOOKINGS');
      expect(no.json().message).toContain('1 lugar reservado en clases próximas');
      expect((await db().branch.findUniqueOrThrow({ where: { id: sede.id } })).isActive).toBe(true);

      // Cancelada la reserva, se cierra.
      await db().classBooking.updateMany({ where: { classScheduleId: sesion.id }, data: { status: 'CANCELED', canceledAt: new Date() } as never });
      expect((await get(cookie, `/branches/${sede.id}/closing-summary`)).json().classBlockers).toEqual([]);
      const si = await cerrar();
      expect(si.statusCode, si.body).toBe(200);
      expect(si.json().isActive).toBe(false);
    } finally {
      await otro.cerrar();
    }
  });

  // ── Importar ──────────────────────────────────────────────────────────────

  describe('importar', () => {
    type Campos = Record<string, string>;
    const subir = (cookie: string, branchId: string, fields: Campos[], extra: Record<string, unknown> = {}) => app.inject({
      method: 'POST', url: '/member-imports', headers: { cookie },
      payload: { fileName: 'padron.csv', branchId, cutoffDate: hoy(), rows: fields.map((f, i) => ({ rowNumber: i + 2, raw: {}, fields: f })), ...extra },
    });
    const filas = async (id: string) => (await get(gerente, `/member-imports/${id}/rows?limit=200`)).json().rows as Array<Record<string, any>>;
    const detalle = async (id: string) => (await get(gerente, `/member-imports/${id}`)).json();
    const aplicar = async (id: string) => {
      for (let i = 0; i < 10; i++) {
        const r = await app.inject({ method: 'POST', url: `/member-imports/${id}/apply`, headers: { cookie: gerente }, payload: { reason: 'Corte firmado por la dueña' } });
        expect(r.statusCode, r.body).toBe(200);
        if (r.json().done) return;
      }
      throw new Error('la importación no terminó');
    };
    const persona = () => ({ nombre: nombreUnico('Imp'), apellido: nombreUnico('Dir') });

    it('cargar el archivo no pide motivo y la bitácora dice qué archivo fue (18-07)', async () => {
      const p = persona();
      const r = await subir(gerente, g.sedes[0]!.id, [{ firstName: p.nombre, lastName: p.apellido }]);
      expect(r.statusCode, r.body).toBe(201);
      const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'members.import.stage', resourceId: r.json().id } });
      expect(asiento.reason).toBe('Cargó padron.csv para revisarlo');
      // Aplicar y descartar siguen pidiéndolo.
      expect((await app.inject({ method: 'POST', url: `/member-imports/${r.json().id}/cancel`, headers: { cookie: gerente }, payload: {} })).statusCode).toBe(422);
      expect((await app.inject({ method: 'POST', url: `/member-imports/${r.json().id}/cancel`, headers: { cookie: gerente }, payload: { reason: 'Era una prueba' } })).statusCode).toBe(200);
    });

    it('el resumen de dinero dice cuánto adeudo, cuánto a favor y cuántas vigencias entran (18-04)', async () => {
      const [a, b, c, d, e] = [persona(), persona(), persona(), persona(), persona()];
      const r = await subir(gerente, g.sedes[0]!.id, [
        { firstName: a.nombre, lastName: a.apellido, balance: '$650.00', periodEnd: enDias(20), plan: 'MENSUAL' },
        { firstName: b.nombre, lastName: b.apellido, balance: '350', periodEnd: enDias(-40), plan: 'MENSUAL' },
        { firstName: c.nombre, lastName: c.apellido, balance: '-120.50', periodEnd: enDias(10), plan: 'ANUAL VIEJO' },
        { firstName: d.nombre, lastName: d.apellido, balance: 'mil pesos' },
        { firstName: e.nombre, lastName: e.apellido, balance: '999' },
      ]);
      expect(r.statusCode, r.body).toBe(201);
      const id = r.json().id as string;
      const dudosa = (await filas(id)).find((f) => f.firstName === d.nombre)!;
      const omitida = (await filas(id)).find((f) => f.firstName === e.nombre)!;
      // La omitida no cuenta: su dinero no entra.
      await app.inject({ method: 'PUT', url: `/member-imports/${id}/rows/${omitida.id}`, headers: { cookie: gerente }, payload: { decision: 'SKIP' } });

      let m = (await detalle(id)).money;
      expect(m).toMatchObject({ debtCents: '100000', debtRows: 2, creditCents: '12050', creditRows: 1, expired: 1, unreadBalances: 1, loadedDebtCents: '0', loadedCreditCents: '0' });
      // Ningún plan del archivo tiene todavía plan de GymFlow: las dos vigencias vivas no se cargarían.
      expect(m).toMatchObject({ memberships: 0, membershipsNotLoaded: 2 });

      await app.inject({ method: 'PUT', url: `/member-imports/${id}/maps`, headers: { cookie: gerente }, payload: { planMap: { MENSUAL: g.planMensual, 'ANUAL VIEJO': null } } });
      m = (await detalle(id)).money;
      expect(m).toMatchObject({ memberships: 1, membershipsNotLoaded: 1 });

      // El saldo ilegible se corrige: deja de estar «sin leer» y entra a la suma.
      await app.inject({ method: 'PUT', url: `/member-imports/${id}/rows/${dudosa.id}`, headers: { cookie: gerente }, payload: { data: 'FIXED', fix: { balanceCents: '100000' } } });
      m = (await detalle(id)).money;
      expect(m).toMatchObject({ debtCents: '200000', debtRows: 3, unreadBalances: 0 });

      await aplicar(id);
      const fin = await detalle(id);
      expect(fin.status).toBe('APPLIED');
      expect(fin.reason).toBe('Corte firmado por la dueña');
      expect(fin.money).toMatchObject({ loadedDebtCents: '200000', loadedCreditCents: '12050' });
    });

    it('una fila sin apellidos entra sin apellidos, nunca con «—» (18-10)', async () => {
      const solo = nombreUnico('Mononimo');
      const r = await subir(gerente, g.sedes[0]!.id, [{ fullName: solo }]);
      const id = r.json().id as string;
      await aplicar(id);
      const fila = (await filas(id))[0]!;
      const socio = await db().member.findUniqueOrThrow({ where: { id: fila.appliedMemberId } });
      expect(socio.firstName).toBe(solo);
      expect(socio.lastName).toBe('');
      expect(fila.applyNote).toContain('Entró sin apellidos');
    });

    it('dos sucursales que migran sin columna de sucursal no comparten sus códigos', async () => {
      const [centro, norte] = g.sedes as [GimnasioPropio['sedes'][number], GimnasioPropio['sedes'][number]];
      const cod = `C${Math.floor(Math.random() * 1e7)}`;
      const deCentro = persona();
      const deNorte = { ...persona(), telefono: telefonoUnico() };

      // Centro migra primero: su 027 es de una persona.
      const uno = (await subir(gerente, centro.id, [{ legacyCode: cod, firstName: deCentro.nombre, lastName: deCentro.apellido }])).json().id as string;
      await aplicar(uno);
      const socioCentro = (await filas(uno))[0]!.appliedMemberId as string;
      expect((await db().memberLegacyCode.findFirstOrThrow({ where: { memberId: socioCentro } })).source).toBe('CASA CENTRO');

      // Norte migra después, con su propio 027: otra persona. No se une sola.
      const dos = (await subir(gerente, norte.id, [{ legacyCode: cod, firstName: deNorte.nombre, lastName: deNorte.apellido, phone: deNorte.telefono }])).json().id as string;
      const fila = (await filas(dos))[0]!;
      expect(fila).toMatchObject({ kind: 'REVIEW', decision: 'PENDING', matchMemberId: socioCentro });
      expect(fila.matchReason).toContain('puede ser el mismo número de otra sucursal');
      expect((await detalle(dos)).blockers).toHaveLength(1);
      // La gerencia dice que son distintas: nace su ficha, con su código en SU sucursal.
      await app.inject({ method: 'PUT', url: `/member-imports/${dos}/rows/${fila.id}`, headers: { cookie: gerente }, payload: { decision: 'CREATE' } });
      await aplicar(dos);
      const socioNorte = (await filas(dos))[0]!.appliedMemberId as string;
      expect(socioNorte).not.toBe(socioCentro);
      expect((await db().memberLegacyCode.findFirstOrThrow({ where: { memberId: socioNorte } })).source).toBe('CASA NORTE');

      // Reimportar cada archivo cae en SU ficha, sin preguntar.
      const otraVezNorte = (await filas((await subir(gerente, norte.id, [{ legacyCode: cod, firstName: deNorte.nombre, lastName: deNorte.apellido }])).json().id))[0]!;
      expect(otraVezNorte).toMatchObject({ kind: 'MATCH', decision: 'MERGE', matchMemberId: socioNorte });
      const otraVezCentro = (await filas((await subir(gerente, centro.id, [{ legacyCode: cod, firstName: deCentro.nombre, lastName: deCentro.apellido }])).json().id))[0]!;
      expect(otraVezCentro).toMatchObject({ kind: 'MATCH', decision: 'MERGE', matchMemberId: socioCentro });
    });

    it('un código guardado antes sin sucursal (GENERAL) se sigue reconociendo si el nombre coincide', async () => {
      const centro = g.sedes[0]!;
      const cod = `G${Math.floor(Math.random() * 1e7)}`;
      const p = persona();
      const socio = await socioPropio(g, centro);
      await db().member.update({ where: { id: socio }, data: { firstName: p.nombre, lastName: p.apellido } });
      await db().memberLegacyCode.create({ data: { id: randomUUID(), organizationId: g.organizationId, memberId: socio, code: cod, source: 'GENERAL' } });
      const fila = (await filas((await subir(gerente, centro.id, [{ legacyCode: cod, firstName: p.nombre, lastName: p.apellido }])).json().id))[0]!;
      expect(fila).toMatchObject({ kind: 'MATCH', decision: 'MERGE', matchMemberId: socio });
    });
  });
});
