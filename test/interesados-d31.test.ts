import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PROSPECT_AUTO_CLOSE_CODE, PROSPECT_AUTO_CLOSE_DAYS, PROSPECT_AUTO_CLOSE_NOTICE_DAYS, uuidv7 } from '@gymflow/core';
import { ProspectAutoClose, ProspectList, PublicPlan } from '@gymflow/core/contracts';
import { makeApp, nombreUnico, telefonoUnico } from './helpers.js';
import { gimnasioPropio, sesionesDe, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { ProspectAutoCloseService } from '../src/modules/prospects/auto-close.service.js';
import { PROSPECT_JOBS } from '../src/modules/prospects/index.js';
import { BACKEND_MODULES } from '../src/modules.js';
import { armarPlanes, runsFor } from '../src/platform/jobs/plan.js';

/**
 * INTERESADOS EN LA FASE 4 (auditoría 8, bloque 4.7; decisión D-31).
 *
 *  · Se anota el plan que preguntó, y tiene que ser uno que su sucursal vende.
 *  · El QR (la página pública de la sucursal) enseña los planes de ESA
 *    sucursal con su precio de lista, y nada más del plan.
 *  · Un interesado abierto con 60 días sin contacto ni fecha pendiente se
 *    cierra solo, con el «hoy» de su sede; se puede reabrir y no se vuelve a
 *    cerrar esa noche.
 *  · La primera corrida en un gimnasio con interesados viejos no cierra a
 *    nadie: fija la fecha una semana adelante y dice cuántos serían.
 *
 * Cada caso usa un gimnasio propio. El «ahora» de cada pasada se le da al
 * servicio (`pasada(org, at)`) y las fechas de los interesados se siembran
 * relativas a él: no depende del día ni de la hora en que corre.
 */
describe('interesados (D-31): plan de interés, precios en el QR y cierre solo', () => {
  let app: FastifyInstance;
  const gimnasios: GimnasioPropio[] = [];
  const DIA = 86_400_000;
  const servicio = new ProspectAutoCloseService();
  const dia = (d: Date) => d.toISOString().slice(0, 10);
  const enZona = (zona: string, d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: zona }).format(d);

  beforeAll(async () => { app = await makeApp(); await app.ready(); });
  afterAll(async () => {
    for (const g of gimnasios) await g.cerrar();
    await app.close();
    await closeDb();
  });

  async function gimnasio(sedes?: Parameters<typeof gimnasioPropio>[0]) {
    const g = await gimnasioPropio(sedes);
    gimnasios.push(g);
    return { g, s: await sesionesDe(app, g) };
  }
  const pedir = (cookie: string | null, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, ...(cookie ? { headers: { cookie } } : {}), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

  /** Un interesado sembrado en la base con las fechas que el caso necesita. */
  async function interesado(g: GimnasioPropio, d: {
    sede?: number; creado: Date; contactado?: Date | null; proximoPaso?: string | null; status?: 'NEW' | 'CONTACTED' | 'VISITED' | 'TRIAL' | 'LOST' | 'CONVERTED';
  }): Promise<string> {
    const id = uuidv7();
    const nombre = nombreUnico('Inte');
    const apellido = nombreUnico('Viejo');
    const paso = d.proximoPaso ? new Date(`${d.proximoPaso}T00:00:00.000Z`) : null;
    await getDb().prospect.create({
      data: {
        id, organizationId: g.organizationId, branchId: g.sedes[d.sede ?? 0]!.id, firstName: nombre, lastName: apellido,
        nameKey: `${nombre} ${apellido}`.toLowerCase(), phoneE164: telefonoUnico(), status: d.status ?? (d.contactado ? 'CONTACTED' : 'NEW'),
        createdAt: d.creado, lastContactAt: d.contactado ?? null, nextStepOn: paso,
        dueOn: paso ?? (d.contactado ? new Date(`${dia(d.contactado)}T00:00:00.000Z`) : null),
      },
    });
    return id;
  }
  const estado = async (id: string) => getDb().prospect.findUniqueOrThrow({
    where: { id }, select: { status: true, lostReasonCode: true, lostReason: true, closedAt: true, closedByUserId: true, reopenedAt: true, dueOn: true, nextStepOn: true },
  });
  const asientos = (orgId: string, action: string) => getDb().auditLog.findMany({ where: { organizationId: orgId, action }, select: { resourceId: true, actorType: true, actorUserId: true, afterState: true, reason: true } });

  // ── Plan de interés ───────────────────────────────────────────────────────

  it('se anota el plan que preguntó, la fila lo dice por su nombre, y se puede quitar', async () => {
    const { g, s } = await gimnasio();
    const sede = g.sedes[0]!.id;
    const alta = await pedir(s.recepcion, 'POST', '/prospects', {
      branchId: sede, firstName: nombreUnico('Pre'), lastName: nombreUnico('Gunta'), phoneE164: telefonoUnico(), interestPlanId: g.planMensual,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json().id as string;

    const lista = await pedir(s.recepcion, 'GET', '/prospects?view=uncontacted');
    expect(lista.statusCode, lista.body).toBe(200);
    expect(ProspectList.safeParse(lista.json()).success).toBe(true);
    const fila = lista.json().items.find((x: { id: string }) => x.id === id);
    expect(fila).toMatchObject({ interestPlanId: g.planMensual, interestPlanName: 'Mensual', autoClosed: false, autoCloseSoon: false });
    // Recién registrado: se cerraría solo dentro de 60 días (el día de su sede; un día de margen por la zona).
    const faltan = (new Date(`${fila.autoCloseOn}T00:00:00.000Z`).getTime() - Date.now()) / DIA;
    expect(faltan).toBeGreaterThan(PROSPECT_AUTO_CLOSE_DAYS - 2);
    expect(faltan).toBeLessThan(PROSPECT_AUTO_CLOSE_DAYS + 1);

    const asiento = (await asientos(g.organizationId, 'prospect.create')).find((a) => a.resourceId === id);
    expect(asiento?.afterState).toMatchObject({ interestPlanId: g.planMensual });

    expect((await pedir(s.recepcion, 'PATCH', `/prospects/${id}`, { interestPlanId: null })).statusCode).toBe(200);
    const sinPlan = (await pedir(s.recepcion, 'GET', '/prospects?view=uncontacted')).json().items.find((x: { id: string }) => x.id === id);
    expect(sinPlan).toMatchObject({ interestPlanId: null, interestPlanName: null });
  });

  it('solo se anota un plan que esa sucursal vende hoy: ni el de otra sede, ni uno archivado, ni el de otro gimnasio', async () => {
    const { g, s } = await gimnasio({ sedes: [{ name: 'Centro' }, { name: 'Norte' }] });
    const otro = await gimnasio();
    const db = getDb();
    const soloNorte = uuidv7();
    const archivado = uuidv7();
    await db.plan.create({ data: { id: soloNorte, organizationId: g.organizationId, code: 'NORTE', name: 'Solo Norte', billingModel: 'RECURRING', durationUnit: 'MONTH', durationValue: 1, priceCents: 45_000n } });
    await db.planBranchAvailability.create({ data: { planId: soloNorte, branchId: g.sedes[1]!.id, organizationId: g.organizationId } });
    await db.plan.create({ data: { id: archivado, organizationId: g.organizationId, code: 'VIEJO', name: 'Ya no se vende', billingModel: 'RECURRING', durationUnit: 'MONTH', durationValue: 1, priceCents: 30_000n, isActive: false } });
    await db.planBranchAvailability.create({ data: { planId: archivado, branchId: g.sedes[0]!.id, organizationId: g.organizationId } });

    const datos = () => ({ branchId: g.sedes[0]!.id, firstName: nombreUnico('Otro'), lastName: nombreUnico('Plan'), phoneE164: telefonoUnico() });
    for (const planId of [soloNorte, archivado, otro.g.planMensual]) {
      const r = await pedir(s.gerente, 'POST', '/prospects', { ...datos(), interestPlanId: planId });
      expect(r.statusCode, `${planId}: ${r.body}`).toBe(422);
    }
    // En Norte sí se vende: la gerencia lo anota ahí.
    const enNorte = await pedir(s.gerente, 'POST', '/prospects', { ...datos(), branchId: g.sedes[1]!.id, interestPlanId: soloNorte });
    expect(enNorte.statusCode, enNorte.body).toBe(201);
    // Corregirlo a un plan que su sede no vende tampoco pasa.
    const enCentro = await pedir(s.gerente, 'POST', '/prospects', datos());
    expect((await pedir(s.gerente, 'PATCH', `/prospects/${enCentro.json().id}`, { interestPlanId: soloNorte })).statusCode).toBe(422);
    expect((await pedir(s.gerente, 'PATCH', `/prospects/${enCentro.json().id}`, { interestPlanId: g.planMensual })).statusCode).toBe(200);
  });

  // ── Precios en el QR ──────────────────────────────────────────────────────

  it('la página pública de la sucursal enseña sus planes con el precio de lista de ESA sucursal, y nada más del plan', async () => {
    const { g } = await gimnasio({ sedes: [{ name: 'Centro' }, { name: 'Norte' }] });
    const db = getDb();
    const [centro, norte] = [g.sedes[0]!.id, g.sedes[1]!.id];
    const anual = uuidv7();
    const soloNorte = uuidv7();
    const archivado = uuidv7();
    const noDisponible = uuidv7();
    const plan = (id: string, code: string, name: string, extra: Record<string, unknown> = {}) => db.plan.create({
      data: { id, organizationId: g.organizationId, code, name, billingModel: 'PREPAID_PERIOD', durationUnit: 'MONTH', durationValue: 12, priceCents: 600_000n, ...extra } as never,
    });
    await plan(anual, 'ANUAL', 'Anual', { signupFeeCents: 20_000n, description: 'Doce meses' });
    await plan(soloNorte, 'NORTE', 'Solo Norte');
    await plan(archivado, 'VIEJO', 'Ya no se vende', { isActive: false });
    await plan(noDisponible, 'APAGADO', 'Apagado en Centro');
    await db.planBranchAvailability.createMany({ data: [
      { planId: anual, branchId: centro, organizationId: g.organizationId },
      // En Norte el anual tiene precio propio.
      { planId: anual, branchId: norte, organizationId: g.organizationId, priceOverrideCents: 540_000n },
      { planId: soloNorte, branchId: norte, organizationId: g.organizationId },
      { planId: archivado, branchId: centro, organizationId: g.organizationId },
      { planId: noDisponible, branchId: centro, organizationId: g.organizationId, isAvailable: false },
    ] });

    // Sin sesión: es lo que ve quien escanea el cartel.
    const enCentro = await pedir(null, 'GET', `/intake/${centro}/form`);
    expect(enCentro.statusCode, enCentro.body).toBe(200);
    const planesCentro = enCentro.json().plans as PublicPlan[];
    expect(planesCentro.map((p) => p.name).sort()).toEqual(['Anual', 'Mensual']);
    expect(planesCentro.find((p) => p.name === 'Anual')).toMatchObject({ priceCents: '600000', signupFeeCents: '20000', description: 'Doce meses', durationUnit: 'MONTH', durationValue: 12 });
    expect(planesCentro.find((p) => p.name === 'Mensual')).toMatchObject({ priceCents: '60000', signupFeeCents: '0' });

    const planesNorte = (await pedir(null, 'GET', `/intake/${norte}/form`)).json().plans as PublicPlan[];
    expect(planesNorte.map((p) => p.name).sort()).toEqual(['Anual', 'Mensual', 'Solo Norte']);
    expect(planesNorte.find((p) => p.name === 'Anual')!.priceCents).toBe('540000');

    // Lo público es exactamente esto: ni días de gracia, ni reglas de congelación, ni impuestos, ni código interno.
    for (const p of [...planesCentro, ...planesNorte]) {
      expect(PublicPlan.safeParse(p).success).toBe(true);
      expect(Object.keys(p).sort()).toEqual(['billingModel', 'description', 'durationUnit', 'durationValue', 'id', 'name', 'priceCents', 'signupFeeCents', 'visitsIncluded']);
    }
  });

  it('el precio del QR es el de lista: una membresía vendida con otro precio acordado no lo cambia', async () => {
    const { g } = await gimnasio();
    const db = getDb();
    const socio = await socioPropio(g);
    await db.membership.create({
      data: {
        id: uuidv7(), organizationId: g.organizationId, memberId: socio, planId: g.planMensual, soldAtBranchId: g.sedes[0]!.id, status: 'ACTIVE',
        startDate: new Date(), currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * DIA), billingAnchorDay: 1, agreedPriceCents: 39_900n,
      } as never,
    });
    const planes = (await pedir(null, 'GET', `/intake/${g.sedes[0]!.id}/form`)).json().plans as PublicPlan[];
    expect(planes.map((p) => p.priceCents)).toEqual(['60000']);
  });

  // ── Cierre solo ───────────────────────────────────────────────────────────

  it('el job tiene su lugar en el cierre diario, es del módulo Prospectos y se salta con el módulo apagado', () => {
    const job = armarPlanes(BACKEND_MODULES).diario.find((j) => j.name === 'prospects.auto-close');
    expect(job, 'prospects.auto-close está en ORDEN_DIARIO').toBeTruthy();
    expect(job!.module).toBe('prospects');
    expect(runsFor(job!, new Set(['core', 'prospects'] as never))).toBe(true);
    expect(runsFor(job!, new Set(['core'] as never))).toBe(false);
    expect(PROSPECT_JOBS.map((j) => j.name)).toEqual(['prospects.auto-close']);
  });

  it('LA PRIMERA CORRIDA en un gimnasio con interesados viejos no cierra a nadie: fija la fecha una semana adelante y dice cuántos serían', async () => {
    const { g, s } = await gimnasio();
    const ahora = new Date();
    const viejos = [
      await interesado(g, { creado: new Date(ahora.getTime() - 200 * DIA) }),
      await interesado(g, { creado: new Date(ahora.getTime() - 120 * DIA), contactado: new Date(ahora.getTime() - 90 * DIA) }),
      await interesado(g, { creado: new Date(ahora.getTime() - 75 * DIA), contactado: new Date(ahora.getTime() - 70 * DIA), status: 'TRIAL' }),
    ];
    const reciente = await interesado(g, { creado: new Date(ahora.getTime() - 10 * DIA) });

    // Antes de que el cierre de la noche corra: la vista previa ya dice cuántos, sin fecha.
    const antes = await pedir(s.recepcion, 'GET', '/prospects/auto-close');
    expect(antes.statusCode, antes.body).toBe(200);
    expect(ProspectAutoClose.safeParse(antes.json()).success).toBe(true);
    expect(antes.json()).toEqual({ days: 60, noticeDays: 7, startsOn: null, active: false, due: 3, soon: 0 });

    const primera = await servicio.pasada(g.organizationId, ahora);
    const hoy = enZona('America/Mexico_City', ahora);
    const arranque = dia(new Date(new Date(`${hoy}T00:00:00.000Z`).getTime() + PROSPECT_AUTO_CLOSE_NOTICE_DAYS * DIA));
    expect(primera).toMatchObject({ arranco: true, cerrados: 0, enEspera: 3, startsOn: arranque });
    for (const id of [...viejos, reciente]) expect((await estado(id)).status).not.toBe('LOST');

    // Queda dicho en la bitácora, a nombre del sistema, con la cuenta.
    const inicio = await asientos(g.organizationId, 'prospect.auto_close.start');
    expect(inicio).toHaveLength(1);
    expect(inicio[0]).toMatchObject({ actorType: 'SYSTEM', actorUserId: null, afterState: { startsOn: arranque, days: 60, wouldClose: 3 } });

    // Mientras llega la fecha, ni otra corrida del mismo día ni las de la semana cierran a nadie, y la fecha no se mueve.
    for (const en of [0, 1, PROSPECT_AUTO_CLOSE_NOTICE_DAYS - 1]) {
      const r = await servicio.pasada(g.organizationId, new Date(ahora.getTime() + en * DIA));
      expect(r, `a los ${en} días`).toMatchObject({ arranco: false, cerrados: 0, startsOn: arranque });
    }
    expect(await asientos(g.organizationId, 'prospect.auto_close.start')).toHaveLength(1);
    expect(await asientos(g.organizationId, 'prospect.auto_close')).toHaveLength(0);

    // El panel lo dice: desde cuándo y cuántos. Y cada fila dice que se cierra sola.
    const previa = (await pedir(s.recepcion, 'GET', '/prospects/auto-close')).json();
    expect(previa).toEqual({ days: 60, noticeDays: 7, startsOn: arranque, active: false, due: 3, soon: 0 });
    const filas = (await pedir(s.recepcion, 'GET', '/prospects?open=true')).json().items as Array<{ id: string; autoCloseSoon: boolean }>;
    expect(filas.filter((f) => f.autoCloseSoon).map((f) => f.id).sort()).toEqual([...viejos].sort());

    // En la semana de aviso recepción contacta a uno: ese ya no se cierra.
    const rescatado = viejos[0]!;
    const contacto = await pedir(s.recepcion, 'POST', `/prospects/${rescatado}/follow-ups`, { channel: 'CALL', outcome: 'ANSWERED' });
    expect(contacto.statusCode, contacto.body).toBe(201);

    // Llega la fecha: se cierran los otros dos, y solo ellos.
    const llegada = await servicio.pasada(g.organizationId, new Date(ahora.getTime() + PROSPECT_AUTO_CLOSE_NOTICE_DAYS * DIA));
    expect(llegada).toMatchObject({ arranco: false, cerrados: 2, truncated: false, errores: [] });
    expect((await estado(rescatado)).status).toBe('CONTACTED');
    expect((await estado(reciente)).status).toBe('NEW');
    for (const id of viejos.slice(1)) {
      expect(await estado(id)).toMatchObject({ status: 'LOST', lostReasonCode: PROSPECT_AUTO_CLOSE_CODE, lostReason: '60 días sin contacto', closedByUserId: null, dueOn: null, nextStepOn: null });
    }
    const cierres = await asientos(g.organizationId, 'prospect.auto_close');
    expect(cierres.map((c) => c.resourceId).sort()).toEqual(viejos.slice(1).sort());
    for (const c of cierres) expect(c).toMatchObject({ actorType: 'SYSTEM', actorUserId: null, reason: '60 días sin contacto', afterState: { status: 'LOST', reasonCode: PROSPECT_AUTO_CLOSE_CODE } });

    // En «Cerrados» se ve que se cerró solo, no que alguien lo cerró.
    const cerrados = (await pedir(s.recepcion, 'GET', '/prospects?view=closed')).json().items as Array<{ id: string; autoClosed: boolean; autoCloseOn: string | null }>;
    expect(cerrados.filter((c) => c.autoClosed).map((c) => c.id).sort()).toEqual(viejos.slice(1).sort());
    expect(cerrados.every((c) => c.autoCloseOn === null)).toBe(true);

    // Correrlo otra vez ese día no hace nada.
    expect(await servicio.pasada(g.organizationId, new Date(ahora.getTime() + PROSPECT_AUTO_CLOSE_NOTICE_DAYS * DIA))).toMatchObject({ cerrados: 0, enEspera: 0 });
  });

  it('en un gimnasio sin interesados viejos empieza ese mismo día, y cierra a cada uno al cumplir 60 días: ni al 59 ni con fecha pendiente', async () => {
    const { g } = await gimnasio();
    // Mediodía de la Ciudad de México de un día fijo: el día de la sede no depende de la hora en que corre la prueba.
    const ahora = new Date('2026-09-10T18:00:00.000Z');
    expect(await servicio.pasada(g.organizationId, ahora)).toMatchObject({ arranco: true, startsOn: '2026-09-10', cerrados: 0, enEspera: 0 });

    const a59 = await interesado(g, { creado: new Date(ahora.getTime() - 100 * DIA), contactado: new Date(ahora.getTime() - 59 * DIA) });
    const a60 = await interesado(g, { creado: new Date(ahora.getTime() - 100 * DIA), contactado: new Date(ahora.getTime() - 60 * DIA) });
    const sinContacto60 = await interesado(g, { creado: new Date(ahora.getTime() - 60 * DIA) });
    // «Llámame en octubre»: su último contacto es viejo, pero tiene fecha pendiente.
    const conFecha = await interesado(g, { creado: new Date(ahora.getTime() - 150 * DIA), contactado: new Date(ahora.getTime() - 90 * DIA), proximoPaso: '2026-10-05' });
    // Un próximo paso que nadie atendió hace 61 días: ya no lo protege.
    const fechaVieja = await interesado(g, { creado: new Date(ahora.getTime() - 150 * DIA), contactado: new Date(ahora.getTime() - 90 * DIA), proximoPaso: '2026-07-11' });
    // Los ya cerrados (por una persona o inscritos) no se tocan.
    const perdido = await interesado(g, { creado: new Date(ahora.getTime() - 150 * DIA), status: 'LOST' });
    const inscrito = await interesado(g, { creado: new Date(ahora.getTime() - 150 * DIA), status: 'CONVERTED' });

    expect(await servicio.vistaPrevia(g.organizationId, null, ahora)).toEqual({ days: 60, noticeDays: 7, startsOn: '2026-09-10', active: true, due: 3, soon: 1 });
    const r = await servicio.pasada(g.organizationId, ahora);
    expect(r).toMatchObject({ arranco: false, cerrados: 3, enEspera: 0 });
    expect((await estado(a59)).status).toBe('CONTACTED');
    expect((await estado(conFecha)).status).toBe('CONTACTED');
    for (const id of [a60, sinContacto60, fechaVieja]) expect((await estado(id)).lostReasonCode).toBe(PROSPECT_AUTO_CLOSE_CODE);
    expect((await estado(perdido)).lostReasonCode).toBeNull();
    expect((await estado(inscrito)).status).toBe('CONVERTED');

    // Al día siguiente le toca al de 59.
    expect(await servicio.pasada(g.organizationId, new Date(ahora.getTime() + DIA))).toMatchObject({ cerrados: 1 });
    expect((await estado(a59)).status).toBe('LOST');
  });

  it('se decide con el «hoy» de la SEDE: a las 00:30 de la Ciudad de México, en Tijuana todavía es el día 59', async () => {
    const { g } = await gimnasio({ sedes: [{ name: 'Centro' }, { name: 'Frontera', zona: 'America/Tijuana' }] });
    // 2026-09-10 06:30 UTC = 00:30 del 10 en la Ciudad de México y 23:30 del 9 en Tijuana.
    const ahora = new Date('2026-09-10T06:30:00.000Z');
    expect(await servicio.pasada(g.organizationId, new Date(ahora.getTime() - DIA))).toMatchObject({ arranco: true, cerrados: 0 });
    // Los dos tuvieron su último contacto el mediodía del 12 de julio, hora de su sede: 60 días después es el 10 de septiembre.
    const centro = await interesado(g, { sede: 0, creado: new Date('2026-06-01T18:00:00.000Z'), contactado: new Date('2026-07-12T18:00:00.000Z') });
    const frontera = await interesado(g, { sede: 1, creado: new Date('2026-06-01T18:00:00.000Z'), contactado: new Date('2026-07-12T19:00:00.000Z') });

    expect(await servicio.pasada(g.organizationId, ahora)).toMatchObject({ cerrados: 1 });
    expect((await estado(centro)).status).toBe('LOST');
    expect((await estado(frontera)).status).toBe('CONTACTED');
    // Dos horas después ya es el 10 en Tijuana.
    expect(await servicio.pasada(g.organizationId, new Date('2026-09-10T08:30:00.000Z'))).toMatchObject({ cerrados: 1 });
    expect((await estado(frontera)).status).toBe('LOST');
  });

  it('el que se cerró solo se reabre, y no se vuelve a cerrar esa noche: el plazo cuenta desde la reapertura', async () => {
    const { g, s } = await gimnasio();
    const ahora = new Date();
    expect(await servicio.pasada(g.organizationId, new Date(ahora.getTime() - 30 * DIA))).toMatchObject({ arranco: true });
    const nunca = await interesado(g, { creado: new Date(ahora.getTime() - 90 * DIA) });
    const contactado = await interesado(g, { creado: new Date(ahora.getTime() - 120 * DIA), contactado: new Date(ahora.getTime() - 80 * DIA), status: 'VISITED' });
    await getDb().followUp.create({ data: { id: uuidv7(), organizationId: g.organizationId, branchId: g.sedes[0]!.id, prospectId: contactado, channel: 'VISIT', outcome: 'INTERESTED', createdByUserId: g.ownerId, createdAt: new Date(ahora.getTime() - 80 * DIA) } as never });

    // El job de verdad, como lo llama el cierre de la noche.
    const corrida = await PROSPECT_JOBS[0]!.handler(g.organizationId);
    expect(corrida).toMatchObject({ job: 'prospects.auto-close', processed: 2, errors: [] });

    for (const id of [nunca, contactado]) {
      const r = await pedir(s.recepcion, 'POST', `/prospects/${id}/reopen`);
      expect(r.statusCode, r.body).toBe(200);
    }
    // Vuelve con la etapa de sus contactos (2.4) y con el motivo del cierre fuera de la fila.
    expect(await estado(nunca)).toMatchObject({ status: 'NEW', lostReasonCode: null, closedAt: null });
    expect(await estado(contactado)).toMatchObject({ status: 'VISITED', lostReasonCode: null });
    expect((await estado(nunca)).reopenedAt).not.toBeNull();

    expect(await PROSPECT_JOBS[0]!.handler(g.organizationId)).toMatchObject({ processed: 0 });
    expect((await estado(nunca)).status).toBe('NEW');
    expect((await estado(contactado)).status).toBe('VISITED');
    // Si tampoco ahora lo contacta nadie, se cierra otra vez a los 60 días de reabierto.
    expect(await servicio.pasada(g.organizationId, new Date(ahora.getTime() + 59 * DIA))).toMatchObject({ cerrados: 0 });
    expect(await servicio.pasada(g.organizationId, new Date(ahora.getTime() + 61 * DIA))).toMatchObject({ cerrados: 2 });
  });

  it('cada quien ve la cuenta de SUS sedes: recepción de Centro no cuenta a los de Norte', async () => {
    const { g, s } = await gimnasio({ sedes: [{ name: 'Centro' }, { name: 'Norte' }] });
    const ahora = new Date();
    await interesado(g, { sede: 0, creado: new Date(ahora.getTime() - 100 * DIA) });
    await interesado(g, { sede: 1, creado: new Date(ahora.getTime() - 100 * DIA) });
    await interesado(g, { sede: 1, creado: new Date(ahora.getTime() - 56 * DIA) });
    expect((await pedir(s.recepcion, 'GET', '/prospects/auto-close')).json()).toMatchObject({ due: 1, soon: 0 });
    expect((await pedir(s.gerente, 'GET', '/prospects/auto-close')).json()).toMatchObject({ due: 2, soon: 1 });
    expect((await pedir(null, 'GET', '/prospects/auto-close')).statusCode).toBe(401);
  });

  it('cerrar a mano sigue pidiendo un motivo de la lista corta, y el código del cierre solo no se acepta', async () => {
    const { g, s } = await gimnasio();
    const id = await interesado(g, { creado: new Date() });
    expect((await pedir(s.recepcion, 'POST', `/prospects/${id}/close`, {})).statusCode).toBe(422);
    expect((await pedir(s.recepcion, 'POST', `/prospects/${id}/close`, { reasonCode: PROSPECT_AUTO_CLOSE_CODE })).statusCode).toBe(422);
    expect((await pedir(s.recepcion, 'POST', `/prospects/${id}/close`, { reasonCode: 'OTRO' })).statusCode).toBe(422);
    const r = await pedir(s.recepcion, 'POST', `/prospects/${id}/close`, { reasonCode: 'PRECIO' });
    expect(r.statusCode, r.body).toBe(200);
    expect(await estado(id)).toMatchObject({ status: 'LOST', lostReasonCode: 'PRECIO' });
    const fila = (await pedir(s.recepcion, 'GET', '/prospects?view=closed')).json().items.find((x: { id: string }) => x.id === id);
    expect(fila).toMatchObject({ autoClosed: false, lostReason: 'Precio' });
  });
});
