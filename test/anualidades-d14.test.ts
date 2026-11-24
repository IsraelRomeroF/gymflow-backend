import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { DIAS_DE_AVISO_DE_PREPAGO, uuidv7 } from '@gymflow/core';
import { makeApp } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, sesionesDe, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { apagarRenovacionDePrepagos, prepagosQueSeRenuevan, MEMBERSHIP_JOBS } from '../src/modules/memberships/index.js';
import { OutboundRepository } from '../src/modules/outbound/outbound.repository.js';
import { BusinessCalendar } from '../src/platform/time/business-calendar.js';

/**
 * FASE 3 · BLOQUE 3.5 · D-14 «EL PLAN PAGADO POR ADELANTADO VENCE Y SE VUELVE
 * A VENDER».
 *
 * Por omisión una anualidad no se renueva; en la venta se puede elegir lo
 * contrario; se avisa 15 días antes; y las anualidades vivas que nacieron «se
 * renueva sola» pasan a «no se renueva» salvo las elegidas, con su lista
 * antes de aplicarlo. Gimnasio propio: «Anual» a $6,500 por 12 meses.
 */
describe('membresías · D-14', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente: string; let recepcion: string;
  let sede: string; let anual: string;
  const DIA = 86_400_000;

  const pedir = (cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const vender = (memberId: string, extra: Record<string, unknown> = {}) => pedir(gerente, 'POST', `/members/${memberId}/memberships/sale`, {
    planId: anual, branchId: sede, saleKey: `d14-${randomUUID()}`, payment: { method: 'SPEI_TRANSFER', externalRef: `ANUAL-${randomUUID().slice(0, 8)}` }, ...extra,
  });
  const hoy = () => new BusinessCalendar(g.organizationId).today(sede);
  /** Una anualidad como las de antes de la fase 0: activa y «se renueva sola» sin que nadie lo eligiera. Termina en `enDias`. */
  async function anualidadVieja(enDias: number, opts: { planId?: string; autoRenew?: boolean } = {}): Promise<{ id: string; memberId: string }> {
    const memberId = await socioPropio(g);
    await getDb().member.update({ where: { id: memberId }, data: { phoneE164: `+5255${Math.floor(10_000_000 + Math.random() * 89_999_999)}` } });
    const fin = new Date((await hoy()).getTime() + enDias * DIA);
    const inicio = new Date(fin.getTime() - 365 * DIA);
    const id = uuidv7();
    await getDb().membership.create({
      data: {
        id, organizationId: g.organizationId, memberId, planId: opts.planId ?? anual, soldAtBranchId: sede, status: 'ACTIVE',
        startDate: inicio, currentPeriodStart: inicio, currentPeriodEnd: fin, billingAnchorDay: inicio.getUTCDate(), autoRenew: opts.autoRenew ?? true,
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
      },
    });
    return { id, memberId };
  }

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio();
    ({ gerente, recepcion } = await sesionesDe(app, g));
    sede = g.sedes[0]!.id;
    anual = uuidv7();
    await getDb().plan.create({
      data: { id: anual, organizationId: g.organizationId, code: 'ANUAL', name: 'Anual', billingModel: 'PREPAID_PERIOD', durationUnit: 'MONTH', durationValue: 12, priceCents: 650_000n },
    });
    await getDb().planBranchAvailability.create({ data: { planId: anual, branchId: sede, organizationId: g.organizationId } });
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  it('una anualidad nueva nace «no se renueva»; en la venta se puede elegir lo contrario', async () => {
    const porOmision = await vender(await socioPropio(g));
    expect(porOmision.statusCode, porOmision.body).toBe(201);
    expect((await getDb().membership.findUniqueOrThrow({ where: { id: porOmision.json().membership.id } })).autoRenew).toBe(false);
    const elegida = await vender(await socioPropio(g), { autoRenew: true });
    expect(elegida.statusCode, elegida.body).toBe(201);
    expect((await getDb().membership.findUniqueOrThrow({ where: { id: elegida.json().membership.id } })).autoRenew).toBe(true);
  });

  it('las anualidades vivas: primero la lista (sin tocar nada), después pasan a «no se renueva» salvo las elegidas; repetirlo no cambia nada', async () => {
    const vieja1 = await anualidadVieja(120);
    const vieja2 = await anualidadVieja(200);
    const elegida = (await vender(await socioPropio(g), { autoRenew: true })).json().membership.id as string;
    // Una mensual que se renueva sola no es asunto de D-14.
    const mensual = await anualidadVieja(10, { planId: g.planMensual });

    // 1. La lista: solo lee.
    const lista = await prepagosQueSeRenuevan(g.organizationId, { conservar: new Set([vieja2.id]), elegidasDesde: new Date('2026-11-19T00:00:00.000Z') });
    const de = (id: string) => lista.find((f) => f.id === id);
    expect(de(vieja1.id)).toMatchObject({ seConserva: false, planName: 'Anual', priceCents: 650_000n, status: 'ACTIVE' });
    expect(de(vieja2.id)).toMatchObject({ seConserva: true });
    expect(de(elegida)).toMatchObject({ seConserva: true });
    expect(de(mensual.id)).toBeUndefined();
    expect((await getDb().membership.findUniqueOrThrow({ where: { id: vieja1.id } })).autoRenew).toBe(true);

    // 2. Aplicar.
    const r = await apagarRenovacionDePrepagos(g.organizationId, { conservar: new Set([vieja2.id]), elegidasDesde: new Date('2026-11-19T00:00:00.000Z'), reason: 'D-14: lo decidió la dueña' });
    expect(r.cambiadas.map((f) => f.id)).toContain(vieja1.id);
    expect(r.cambiadas.map((f) => f.id)).not.toContain(vieja2.id);
    expect(r.cambiadas.map((f) => f.id)).not.toContain(elegida);
    const estado = async (id: string) => getDb().membership.findUniqueOrThrow({ where: { id } });
    expect(await estado(vieja1.id)).toMatchObject({ autoRenew: false, status: 'ACTIVE' });
    expect((await estado(vieja2.id)).autoRenew).toBe(true);
    expect((await estado(elegida)).autoRenew).toBe(true);
    expect((await estado(mensual.id)).autoRenew).toBe(true);
    // No tocó periodos ni emitió cargos; dejó un asiento por cada una.
    expect(await getDb().charge.count({ where: { membershipId: vieja1.id } })).toBe(0);
    expect(await getDb().auditLog.count({ where: { organizationId: g.organizationId, action: 'membership.auto_renew.set', resourceId: vieja1.id } })).toBe(1);

    // 3. Otra vez: nada que cambiar.
    const otra = await apagarRenovacionDePrepagos(g.organizationId, { conservar: new Set([vieja2.id]), elegidasDesde: new Date('2026-11-19T00:00:00.000Z'), reason: 'D-14: lo decidió la dueña' });
    expect(otra.cambiadas).toHaveLength(0);
    expect(await getDb().auditLog.count({ where: { organizationId: g.organizationId, action: 'membership.auto_renew.set', resourceId: vieja1.id } })).toBe(1);
  });

  it('la anualidad que no se renueva VENCE al terminar: no se emite otra cuota ni queda debiendo', async () => {
    const vencida = await anualidadVieja(0, { autoRenew: false });
    const job = MEMBERSHIP_JOBS.find((j) => j.name === 'membership.expire')!;
    const res = await job.handler(g.organizationId);
    expect(res.errors, JSON.stringify(res.errors)).toHaveLength(0);
    expect((await getDb().membership.findUniqueOrThrow({ where: { id: vencida.id } })).status).toBe('EXPIRED');
    expect(await getDb().charge.count({ where: { membershipId: vencida.id } })).toBe(0);
    expect((await pedir(gerente, 'GET', `/members/${vencida.memberId}/statement`)).json().outstandingCents).toBe('0');
  });

  it('se le avisa 15 días antes: a los 15 días entra en la lista de mensajes; a los 16, todavía no; la mensual sigue con 3', async () => {
    expect(DIAS_DE_AVISO_DE_PREPAGO).toBe(15);
    const a15 = await anualidadVieja(15, { autoRenew: false });
    const a16 = await anualidadVieja(16, { autoRenew: false });
    const mensual15 = await anualidadVieja(15, { planId: g.planMensual, autoRenew: false });
    const mensual3 = await anualidadVieja(3, { planId: g.planMensual, autoRenew: false });
    const porTerminar = (await new OutboundRepository(g.organizationId).porTerminar(await hoy(), null)).map((m) => m.id);
    expect(porTerminar).toContain(a15.id);
    expect(porTerminar).not.toContain(a16.id);
    expect(porTerminar).not.toContain(mensual15.id);
    expect(porTerminar).toContain(mensual3.id);
  });

  it('en una membresía que ya existe la gerencia cambia si se renueva sola, con motivo; recepción no', async () => {
    const m = await anualidadVieja(90, { autoRenew: false });
    const url = `/memberships/${m.id}/auto-renew`;
    expect((await pedir(recepcion, 'PUT', url, { autoRenew: true, reason: 'Lo pidió el socio' })).statusCode).toBe(403);
    expect((await pedir(gerente, 'PUT', url, { autoRenew: true })).statusCode).toBe(422);
    const si = await pedir(gerente, 'PUT', url, { autoRenew: true, reason: 'El socio pidió que se le renueve sola' });
    expect(si.statusCode, si.body).toBe(200);
    expect(si.json().autoRenew).toBe(true);
    const no = await pedir(gerente, 'PUT', url, { autoRenew: false, reason: 'Cambió de opinión' });
    expect(no.json().autoRenew).toBe(false);
    expect(await getDb().auditLog.count({ where: { organizationId: g.organizationId, action: 'membership.auto_renew.set', resourceId: m.id } })).toBe(2);
    // Otro gimnasio no la toca.
    const { loginAs } = await import('./helpers.js');
    expect((await pedir(await loginAs(app, 'gerente@demo.mx'), 'PUT', url, { autoRenew: true, reason: 'Intento ajeno' })).statusCode).toBe(404);
  });
});
