import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PLAZOS_DEL_SOCIO, sumarDias, sumarMeses, uuidv7 } from '@gymflow/core';
import { MemberStanding, MemberTerms, RetentionAlerts, WinbackList, diferenciasConElContrato } from '@gymflow/core/contracts';
import { makeApp, loginAs, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, socioPropio, cargoPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { expirePendingSales, expireSuspended } from '../src/modules/memberships/membership.jobs.js';
import { markLostDebt, DeudaPerdidaRepository } from '../src/modules/billing/deuda-perdida.js';
import { BusinessCalendar } from '../src/platform/time/business-calendar.js';

const MS_DIA = 86_400_000;

/**
 * FASE 4 · BLOQUE 4.4 · D-18 «LOS PLAZOS DEL SOCIO Y LA DEUDA QUE SE DA POR PERDIDA».
 *
 *  · Una sola definición de cada plazo (núcleo) y un ajuste por gimnasio: los
 *    de retención los cambia la gerencia con motivo; los de la deuda, solo con
 *    la firma de la dueña.
 *  · La venta sin cobrar se cancela a los 7 días; la suspendida termina a los
 *    90 y su deuda se da por perdida: sale de «Por cobrar», no se borra y se
 *    puede cobrar.
 *  · Baja = el acto de la ficha, la cancelación, o la membresía terminada hace
 *    30 días sin renovar. «Recuperar»: a quien se perdió o se dio de baja se
 *    le busca 6 meses.
 *
 * Gimnasio propio. Ninguna fecha sale del reloj: todo se cuenta desde el
 * «hoy» de la sede que usa la API (de noche también).
 */
describe('plazos del socio · D-18', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente: string; let gerente2: string; let recepcion: string; let duena: string;
  let org: string; let sede: string;
  /** El día del gimnasio, a medianoche UTC (como lo usan los jobs). */
  let hoy: Date;
  let hoyIso: string;

  const db = () => getDb();
  const hace = (dias: number) => new Date(hoy.getTime() - dias * MS_DIA);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const put = (cookie: string, url: string, payload: Record<string, unknown>) => app.inject({ method: 'PUT', url, headers: { cookie }, payload });

  /** Una membresía directo en la base, en el estado pedido, con su evento si ya terminó. */
  async function membresia(memberId: string, status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CANCELED' | 'EXPIRED', o: {
    /** Hace cuántos días empezó el periodo (por omisión 10). */
    periodoHaceDias?: number;
    /** SUSPENDED: hace cuántos días venció su gracia. */
    graciaHaceDias?: number;
    /** PENDING: hace cuántos días se vendió. */
    vendidaHaceDias?: number;
    /** CANCELED / EXPIRED: hace cuántos días terminó, y de qué estado venía. */
    terminoHaceDias?: number; venia?: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
    motivo?: string;
  } = {}): Promise<string> {
    const id = uuidv7();
    const inicio = hace(o.periodoHaceDias ?? (o.graciaHaceDias !== undefined ? o.graciaHaceDias + 35 : 10));
    const fin = new Date(inicio.getTime() + 30 * MS_DIA);
    const termino = o.terminoHaceDias !== undefined ? hace(o.terminoHaceDias) : null;
    await db().membership.create({
      data: {
        id, organizationId: org, memberId, planId: g.planMensual, soldAtBranchId: sede, status,
        startDate: inicio, currentPeriodStart: inicio, currentPeriodEnd: fin, billingAnchorDay: 1,
        ...(o.graciaHaceDias !== undefined ? { graceUntil: hace(o.graciaHaceDias) } : {}),
        ...(status === 'CANCELED' ? { canceledAt: termino ?? hoy, endedAt: termino ?? hoy, cancellationReason: o.motivo ?? 'Se mudó de ciudad' } : {}),
        ...(status === 'EXPIRED' ? { endedAt: termino ?? hoy } : {}),
        // Una hora antes de la medianoche de ese día: «hace N días» contado desde el hoy de la sede, no desde el reloj.
        ...(o.vendidaHaceDias !== undefined ? { createdAt: new Date(hace(o.vendidaHaceDias).getTime() - 3_600_000) } : {}),
      },
    });
    if (status === 'CANCELED' || status === 'EXPIRED') {
      await db().membershipEvent.create({
        data: {
          id: uuidv7(), organizationId: org, membershipId: id, eventType: status, fromStatus: o.venia ?? 'ACTIVE', toStatus: status,
          at: termino ?? hoy, businessDate: termino ?? hoy,
        },
      });
    }
    return id;
  }

  /** La cuota sin pagar de una membresía: $600, vencida hace `dias`. */
  async function cuota(memberId: string, membershipId: string, vencidaHaceDias: number, status: 'OPEN' | 'OVERDUE' = 'OVERDUE'): Promise<string> {
    const id = uuidv7();
    const vence = hace(vencidaHaceDias);
    await db().charge.create({
      data: {
        id, organizationId: org, memberId, membershipId, branchId: sede, chargeType: 'MEMBERSHIP_PERIOD', status,
        concept: 'Mensualidad de prueba', subtotalCents: 60_000n, taxCents: 0n, discountCents: 0n, amountCents: 60_000n,
        periodStart: vence, periodEnd: new Date(vence.getTime() + 30 * MS_DIA), dueDate: vence, issuedAt: vence,
      },
    });
    return id;
  }

  /** Una entrada ya registrada ese día de operación (la decisión y su asistencia), sin pasar por la puerta. */
  async function visita(memberId: string, haceDias: number, branchId: string): Promise<void> {
    const decision = uuidv7();
    const businessDate = hace(haceDias);
    const at = new Date(businessDate.getTime() + 18 * 3_600_000);
    await db().accessDecision.create({
      data: { id: decision, organizationId: org, branchId, memberId, outcome: 'GRANTED', credentialKind: 'MANUAL', policyVersion: 'prueba-4.4', businessDate, at },
    });
    await db().attendanceEvent.create({ data: { id: uuidv7(), organizationId: org, branchId, memberId, accessDecisionId: decision, businessDate, at } });
  }

  const cartera = async () => (await get(gerente, '/portfolio')).json() as { totalOutstandingCents: string; overdueCents: string; lostCents: string; lostMembers: number; membersWithDebt: number };
  const cargo = (id: string) => db().charge.findUniqueOrThrow({ where: { id } });
  const estadoDe = async (id: string) => (await db().membership.findUniqueOrThrow({ where: { id } })).status;
  const ponerPlazos = (datos: Record<string, number | null>) => db().memberTermSettings.upsert({
    where: { organizationId: org }, create: { organizationId: org, ...datos }, update: datos,
  });
  /** «De fábrica» es todo en nulo: así lo guarda la API cuando un plazo vuelve a su valor de GymFlow. */
  const deFabrica = () => ponerPlazos({ dormantDays: null, churnDays: null, lostDays: null, winbackMonths: null, unpaidSaleDays: null, lostDebtDays: null });

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio({ sedes: [{ name: 'Sede de los plazos', cajas: 1 }, { name: 'Otra sede', cajas: 1 }] });
    org = g.organizationId;
    sede = g.sedes[0]!.id;
    gerente = await loginAs(app, g.correos.gerente);
    recepcion = await loginAs(app, g.correos.recepcion);
    duena = await loginAs(app, g.correos.owner);
    // Un gerente SIN la llave de Retención ni la del Tablero.
    await db().user.updateMany({ where: { organizationId: org, email: g.correos.gerente2 }, data: { unlockedSections: ['personal'] } });
    gerente2 = await loginAs(app, g.correos.gerente2);
    hoy = await new BusinessCalendar(org).today(null);
    hoyIso = iso(hoy);
  }, 120_000);

  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  // ── Los plazos y quién los ajusta ─────────────────────────────────────────

  describe('una sola definición, ajustable por gimnasio', () => {
    it('sin ajuste rigen los de fábrica (21 · 30 · 60 · 6 meses · 7 · 90) y los lee cualquiera que atienda', async () => {
      for (const cookie of [recepcion, gerente, duena]) {
        const r = await get(cookie, '/member-terms');
        expect(r.statusCode, r.body).toBe(200);
        expect(diferenciasConElContrato(MemberTerms, r.json())).toEqual([]);
        expect(r.json()).toMatchObject({
          terms: { dormantDays: 21, churnDays: 30, lostDays: 60, winbackMonths: 6, unpaidSaleDays: 7, lostDebtDays: 90 },
          defaults: PLAZOS_DEL_SOCIO, customized: [], updatedAt: null, updatedByName: null,
        });
      }
    });

    it('los de retención: la gerencia con motivo; ni recepción, ni la dueña, ni un gerente sin la llave de Retención', async () => {
      const cambio = { dormantDays: 28, lostDays: 75, reason: 'Aquí la gente viene cada dos semanas' };
      expect((await put(recepcion, '/member-terms/retention', cambio)).statusCode).toBe(403);
      expect((await put(duena, '/member-terms/retention', cambio)).statusCode).toBe(403);
      expect((await put(gerente2, '/member-terms/retention', cambio)).statusCode).toBe(403);
      // Sin motivo, sin nada que cambiar, o con un plazo de la deuda colado: no pasa.
      expect((await put(gerente, '/member-terms/retention', { dormantDays: 28 })).statusCode).toBe(422);
      expect((await put(gerente, '/member-terms/retention', { reason: 'Nada que cambiar' })).statusCode).toBe(422);
      expect((await put(gerente, '/member-terms/retention', { ...cambio, lostDebtDays: 30 })).statusCode).toBe(422);
      // Fuera de límites, y «perdido» antes de «dejó de venir».
      const corto = await put(gerente, '/member-terms/retention', { dormantDays: 6, reason: 'Muy corto' });
      expect(corto.statusCode).toBe(422);
      expect(corto.json().message).toContain('va de 7 a 60 días');
      const cruzado = await put(gerente, '/member-terms/retention', { lostDays: 21, reason: 'Se cruza' });
      expect(cruzado.statusCode).toBe(422);
      expect(cruzado.json().message).toContain('más días que «Dejó de venir»');

      const hecho = await put(gerente, '/member-terms/retention', cambio);
      expect(hecho.statusCode, hecho.body).toBe(200);
      expect(hecho.json()).toMatchObject({ terms: { dormantDays: 28, lostDays: 75, churnDays: 30, winbackMonths: 6, unpaidSaleDays: 7, lostDebtDays: 90 } });
      expect([...hecho.json().customized].sort()).toEqual(['dormantDays', 'lostDays']);
      expect(hecho.json().updatedByName).toBeTruthy();

      const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'settings.retention_terms.update' } });
      expect(asiento.beforeState).toEqual({ dormantDays: 21, lostDays: 60 });
      expect(asiento.afterState).toEqual({ dormantDays: 28, lostDays: 75 });
      expect(asiento.reason).toBe(cambio.reason);
      expect(asiento.approvedByUserId).toBeNull();

      // Guardar lo mismo no deja otro asiento; volver al de fábrica lo quita de «ajustados».
      expect((await put(gerente, '/member-terms/retention', cambio)).statusCode).toBe(200);
      expect(await db().auditLog.count({ where: { organizationId: org, action: 'settings.retention_terms.update' } })).toBe(1);
      const vuelta = await put(gerente, '/member-terms/retention', { dormantDays: 21, lostDays: 60, reason: 'Volvemos a los de GymFlow' });
      expect(vuelta.json()).toMatchObject({ terms: PLAZOS_DEL_SOCIO, customized: [] });
    });

    it('los de la deuda: la gerencia SOLO con la firma de la dueña; sin firma 428, recepción 403', async () => {
      const cambio = { lostDebtDays: 120, unpaidSaleDays: 10, reason: 'La dueña quiere esperar cuatro meses' };
      expect((await put(recepcion, '/member-terms/debt', cambio)).statusCode).toBe(403);
      expect((await put(duena, '/member-terms/debt', cambio)).statusCode).toBe(403);
      expect((await put(gerente2, '/member-terms/debt', cambio)).statusCode).toBe(403);
      expect((await put(gerente, '/member-terms/debt', cambio)).statusCode).toBe(428);
      // Un plazo de retención no entra por esta puerta.
      expect((await put(gerente, '/member-terms/debt', { ...cambio, dormantDays: 30 })).statusCode).toBe(422);
      expect((await get(gerente, '/member-terms')).json().terms).toMatchObject({ lostDebtDays: 90, unpaidSaleDays: 7 });

      const token = await aprobacion(app, gerente, 'billing:debt-terms:set', g.correos.owner, undefined, { resourceId: org });
      // Fuera de límites no pasa ni firmado (y no gasta la firma: la valida después).
      const fuera = await put(gerente, '/member-terms/debt', { lostDebtDays: 29, reason: 'Muy pronto', approvalToken: 'x'.repeat(24) });
      expect([401, 403, 422, 428]).toContain(fuera.statusCode);
      const hecho = await put(gerente, '/member-terms/debt', { ...cambio, approvalToken: token });
      expect(hecho.statusCode, hecho.body).toBe(200);
      expect(hecho.json()).toMatchObject({ terms: { lostDebtDays: 120, unpaidSaleDays: 10, dormantDays: 21 } });
      const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'billing.debt_terms.update' } });
      expect(asiento.approvedByUserId).toBe(g.ownerId);
      expect(asiento.beforeState).toEqual({ unpaidSaleDays: 7, lostDebtDays: 90 });
      expect(asiento.afterState).toEqual({ unpaidSaleDays: 10, lostDebtDays: 120 });
      // La misma firma no sirve dos veces.
      expect((await put(gerente, '/member-terms/debt', { lostDebtDays: 100, reason: 'Otra vez', approvalToken: token })).statusCode).not.toBe(200);
      await deFabrica();
    });
  });

  // ── La venta sin cobrar ───────────────────────────────────────────────────

  describe('la venta sin cobrar se cancela a los 7 días', () => {
    it('la de 8 días se cancela y su cuota se anula (nunca se cobró ni dio acceso); la de 6 se queda; con 10 días del gimnasio, la de 8 también', async () => {
      await deFabrica();
      const [a, b] = [await socioPropio(g), await socioPropio(g)];
      const de8 = await membresia(a, 'PENDING', { vendidaHaceDias: 8 });
      const de6 = await membresia(b, 'PENDING', { vendidaHaceDias: 6 });
      const cuota8 = await cuota(a, de8, 8, 'OPEN');
      const cuota6 = await cuota(b, de6, 6, 'OPEN');

      // Con el plazo del gimnasio en 10 días, ninguna de las dos se toca.
      await ponerPlazos({ unpaidSaleDays: 10 });
      const con10 = await expirePendingSales(org);
      expect(con10.errors).toEqual([]);
      expect(await estadoDe(de8)).toBe('PENDING');

      await deFabrica();
      const r = await expirePendingSales(org);
      expect(r.errors).toEqual([]);
      expect(r.processed).toBe(1);
      expect(await estadoDe(de8)).toBe('CANCELED');
      expect(await estadoDe(de6)).toBe('PENDING');
      expect((await db().membership.findUniqueOrThrow({ where: { id: de8 } })).cancellationReason).toBe('Venta sin cobro en 7 días');
      expect((await cargo(cuota8)).status).toBe('VOID');
      expect((await cargo(cuota6)).status).toBe('OPEN');
      // Repetirlo no hace nada.
      expect((await expirePendingSales(org)).processed).toBe(0);
      // Y esa venta que nunca se cobró no es una baja: por ella no fue socio.
      const s = await get(gerente, `/members/${a}/standing`);
      expect(s.json().churn).toBeNull();
    });
  });

  // ── La deuda que se da por perdida ────────────────────────────────────────

  describe('la deuda de la suspendida sale de «Por cobrar» a los 90 días', () => {
    let socio91: string; let m91: string; let c91a: string; let c91b: string;
    let socio89: string; let m89: string; let c89: string;
    let antes: Awaited<ReturnType<typeof cartera>>;

    it('a los 91 días suspendida termina; a los 89 no. Con 120 días del gimnasio, tampoco la de 91', async () => {
      await deFabrica();
      socio91 = await socioPropio(g); socio89 = await socioPropio(g);
      m91 = await membresia(socio91, 'SUSPENDED', { graciaHaceDias: 91 });
      m89 = await membresia(socio89, 'SUSPENDED', { graciaHaceDias: 89 });
      c91a = await cuota(socio91, m91, 126);
      c91b = await cuota(socio91, m91, 96);
      c89 = await cuota(socio89, m89, 94);
      antes = await cartera();
      expect(BigInt(antes.totalOutstandingCents)).toBeGreaterThanOrEqual(180_000n);
      expect(antes.lostCents).toBe('0');

      await ponerPlazos({ lostDebtDays: 120 });
      expect((await expireSuspended(org)).processed).toBe(0);
      expect((await markLostDebt(org)).processed).toBe(0);
      expect(await estadoDe(m91)).toBe('SUSPENDED');

      await deFabrica();
      const r = await expireSuspended(org);
      expect(r.errors).toEqual([]);
      expect(r.processed).toBe(1);
      expect(await estadoDe(m91)).toBe('EXPIRED');
      expect(await estadoDe(m89)).toBe('SUSPENDED');
      // Terminar la membresía NO toca su deuda: sigue vencida, con su saldo, y todavía en la cartera.
      expect((await cargo(c91a)).status).toBe('OVERDUE');
      expect((await cartera()).totalOutstandingCents).toBe(antes.totalOutstandingCents);
    });

    it('la corrida la da por perdida: no la borra ni la condona; sale de «Por cobrar» y se informa aparte', async () => {
      const repo = new DeudaPerdidaRepository(org);
      // Antes de correr, se puede contar sin escribir.
      const previo = await repo.porMarcar();
      expect(previo.map((p) => p.chargeId).sort()).toEqual([c91a, c91b].sort());
      expect(previo.reduce((a, p) => a + p.balanceCents, 0n)).toBe(120_000n);
      expect((await cargo(c91a)).lostOn).toBeNull();

      const r = await markLostDebt(org);
      expect(r.errors).toEqual([]);
      expect(r.processed).toBe(2);

      for (const id of [c91a, c91b]) {
        const c = await cargo(id);
        expect(iso(c.lostOn!)).toBe(hoyIso);
        // Ni anulado ni castigado ni condonado: mismo estado, mismo saldo.
        expect(c.status).toBe('OVERDUE');
        expect(c.amountCents - c.allocatedCents - c.adjustedCents).toBe(60_000n);
        expect(c.writtenOffAt).toBeNull();
        expect(c.voidedAt).toBeNull();
      }
      // La de 89 días sigue suspendida y su deuda sigue en la cartera.
      expect((await cargo(c89)).lostOn).toBeNull();

      const despues = await cartera();
      expect(BigInt(despues.totalOutstandingCents)).toBe(BigInt(antes.totalOutstandingCents) - 120_000n);
      expect(BigInt(despues.overdueCents)).toBe(BigInt(antes.overdueCents) - 120_000n);
      expect(despues.membersWithDebt).toBe(antes.membersWithDebt - 1);
      expect(despues).toMatchObject({ lostCents: '120000', lostMembers: 1 });

      // El Tablero dice lo mismo que la cartera.
      const tablero = (await get(gerente, '/dashboard')).json();
      expect(tablero.portfolio).toMatchObject({ outstandingCents: despues.totalOutstandingCents, lostCents: '120000', lostMembers: 1 });

      // Un asiento por socio (su historia) y el resumen de la corrida, que dice que fue la primera.
      const delSocio = await db().auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'billing.debt.lost', resourceId: socio91 } });
      expect(delSocio.actorType).toBe('SYSTEM');
      expect(delSocio.afterState).toMatchObject({ amountCents: '120000', lostOn: hoyIso, lostDebtDays: 90 });
      const resumen = await db().auditLog.findMany({ where: { organizationId: org, action: 'billing.debt.lost.summary' } });
      expect(resumen).toHaveLength(1);
      expect(resumen[0]!.afterState).toMatchObject({ amountCents: '120000', charges: 2, members: 1, firstRun: true, lostDebtDays: 90 });
    });

    it('repetir la corrida no hace nada: ni marca de nuevo, ni mueve el día, ni deja otro asiento', async () => {
      const r = await markLostDebt(org);
      expect(r).toMatchObject({ processed: 0, errors: [] });
      expect(await db().auditLog.count({ where: { organizationId: org, action: 'billing.debt.lost' } })).toBe(1);
      expect(await db().auditLog.count({ where: { organizationId: org, action: 'billing.debt.lost.summary' } })).toBe(1);
      expect((await cartera()).lostCents).toBe('120000');
    });

    it('sigue en el estado de cuenta del socio, con el día en que se dio por perdida, y el socio la sigue debiendo', async () => {
      const r = await get(gerente, `/members/${socio91}/statement`);
      expect(r.statusCode, r.body).toBe(200);
      const cargos = r.json().charges as Array<{ id: string; status: string; balanceCents: string; lostOn: string | null }>;
      for (const id of [c91a, c91b]) {
        expect(cargos.find((c) => c.id === id)).toMatchObject({ status: 'OVERDUE', balanceCents: '60000', lostOn: hoyIso });
      }
      expect(r.json().outstandingCents).toBe('120000');
      const s = await get(gerente, `/members/${socio91}/standing`);
      expect(diferenciasConElContrato(MemberStanding, s.json())).toEqual([]);
      expect(s.json().lostDebtCents).toBe('120000');
      // El de 89 días no tiene nada perdido.
      const otro = (await get(gerente, `/members/${socio89}/statement`)).json().charges as Array<{ lostOn: string | null }>;
      expect(otro.every((c) => c.lostOn === null)).toBe(true);
    });

    it('se puede cobrar: al pagarla deja de deberse y de contarse como perdida, y nunca volvió a «Por cobrar»', async () => {
      const antesDelCobro = await cartera();
      const pago = await app.inject({
        method: 'POST', url: `/members/${socio91}/payments`, headers: { cookie: gerente },
        payload: { method: 'SPEI_TRANSFER', amountCents: '60000', externalRef: 'PRUEBA-PLAZOS-0001', idempotencyKey: `plazos-${uuidv7()}`, branchId: sede, targetChargeIds: [c91a] },
      });
      expect(pago.statusCode, pago.body).toBe(201);
      expect((await cargo(c91a)).status).toBe('PAID');
      const despues = await cartera();
      expect(despues).toMatchObject({ lostCents: '60000', lostMembers: 1, totalOutstandingCents: antesDelCobro.totalOutstandingCents });
      const cargos = (await get(gerente, `/members/${socio91}/statement`)).json().charges as Array<{ id: string; lostOn: string | null; status: string }>;
      expect(cargos.find((c) => c.id === c91a)).toMatchObject({ status: 'PAID', lostOn: null });
      expect(cargos.find((c) => c.id === c91b)).toMatchObject({ status: 'OVERDUE', lostOn: hoyIso });
    });

    it('no toca la deuda de una membresía que canceló una persona, ni la que no es de membresía', async () => {
      const x = await socioPropio(g);
      const cancelada = await membresia(x, 'CANCELED', { terminoHaceDias: 200, venia: 'ACTIVE' });
      const deCancelada = await cuota(x, cancelada, 230);
      const suelto = await cargoPropio(g, x, 15_000n, g.sedes[0]!, hace(200));
      // Y una terminada por fin de periodo (no por suspensión) tampoco.
      const y = await socioPropio(g);
      const terminada = await membresia(y, 'EXPIRED', { terminoHaceDias: 150, venia: 'ACTIVE' });
      const deTerminada = await cuota(y, terminada, 180);
      expect((await markLostDebt(org)).processed).toBe(0);
      for (const id of [deCancelada, suelto, deTerminada]) expect((await cargo(id)).lostOn).toBeNull();
    });

    it('una corrida posterior marca solo lo nuevo y su resumen ya no dice «primera»', async () => {
      const z = await socioPropio(g);
      const m = await membresia(z, 'SUSPENDED', { graciaHaceDias: 95 });
      const c = await cuota(z, m, 100);
      expect((await expireSuspended(org)).processed).toBe(1);
      const r = await markLostDebt(org);
      expect(r.processed).toBe(1);
      expect(iso((await cargo(c)).lostOn!)).toBe(hoyIso);
      const resumenes = await db().auditLog.findMany({ where: { organizationId: org, action: 'billing.debt.lost.summary' }, orderBy: { at: 'asc' } });
      expect(resumenes).toHaveLength(2);
      expect(resumenes[1]!.afterState).toMatchObject({ amountCents: '60000', charges: 1, members: 1, firstRun: false });
    });
  });

  // ── Baja y Recuperar ──────────────────────────────────────────────────────

  describe('baja = el acto, la cancelación, o terminada hace 30 días sin renovar', () => {
    const s: Record<string, string> = {};
    const standing = async (id: string) => (await get(gerente, `/members/${id}/standing`)).json() as MemberStanding;

    beforeAll(async () => {
      await deFabrica();
      // En la segunda sede: las cuentas de «Recuperar» y del Inicio son exactas ahí.
      const otra = g.sedes[1]!;
      for (const k of ['cancelo', 'termino30', 'termino29', 'archivado', 'renovo', 'viejo', 'anonimo', 'perdido', 'viene']) s[k] = await socioPropio(g, otra);
      await membresia(s.cancelo!, 'CANCELED', { terminoHaceDias: 0, motivo: 'Cambió de trabajo' });
      await membresia(s.termino30!, 'EXPIRED', { terminoHaceDias: 30 });
      await membresia(s.termino29!, 'EXPIRED', { terminoHaceDias: 29 });
      await membresia(s.archivado!, 'ACTIVE');
      await db().member.update({ where: { id: s.archivado! }, data: { deletedAt: new Date() } });
      // Terminó hace 60 días pero ya tiene otra: regresó.
      await membresia(s.renovo!, 'EXPIRED', { terminoHaceDias: 60 });
      await membresia(s.renovo!, 'ACTIVE');
      // Canceló hace más de seis meses: es baja, pero ya no se le busca.
      await membresia(s.viejo!, 'CANCELED', { terminoHaceDias: 200 });
      // Anonimizado: no sale en ninguna lista con nombre.
      await membresia(s.anonimo!, 'CANCELED', { terminoHaceDias: 3 });
      await db().member.update({ where: { id: s.anonimo! }, data: { deletedAt: hace(3), anonymizedAt: new Date() } });
      // Con membresía y 70 días sin venir: perdido desde hace 10.
      await membresia(s.perdido!, 'ACTIVE');
      await db().member.update({ where: { id: s.perdido! }, data: { joinedAt: hace(300) } });
      await visita(s.perdido!, 70, otra.id);
      // Con membresía y vino ayer.
      await membresia(s.viene!, 'ACTIVE');
      await db().member.update({ where: { id: s.viene! }, data: { joinedAt: hace(300) } });
      await visita(s.viene!, 1, otra.id);
    }, 60_000);

    it('«está de baja desde», caso por caso', async () => {
      expect((await standing(s.cancelo!)).churn).toEqual({ cause: 'CANCELED', since: hoyIso, endedOn: null });
      expect(await standing(s.termino30!)).toMatchObject({ churn: { cause: 'EXPIRED', since: hoyIso, endedOn: iso(hace(30)) }, churnsOn: null });
      // A los 29 días todavía no: será baja mañana.
      expect(await standing(s.termino29!)).toMatchObject({ churn: null, churnsOn: sumarDias(hoyIso, 1) });
      expect((await standing(s.archivado!)).churn).toMatchObject({ cause: 'ARCHIVED' });
      expect(await standing(s.renovo!)).toMatchObject({ churn: null, churnsOn: null });
      expect((await standing(s.viejo!)).churn).toEqual({ cause: 'CANCELED', since: iso(hace(200)), endedOn: null });
      expect((await standing(s.viene!)).churn).toBeNull();
    });

    it('el plazo de baja es el del gimnasio: con 10 días, quien terminó hace 29 ya es baja desde hace 19', async () => {
      await ponerPlazos({ churnDays: 10 });
      expect((await standing(s.termino29!)).churn).toEqual({ cause: 'EXPIRED', since: iso(hace(19)), endedOn: iso(hace(29)) });
      await ponerPlazos({ churnDays: 45 });
      expect(await standing(s.termino30!)).toMatchObject({ churn: null, churnsOn: sumarDias(hoyIso, 15) });
      await deFabrica();
    });

    it('«Recuperar»: los perdidos y las bajas de los últimos 6 meses, cada uno una vez, sin anonimizados; recepción en su sede y la dueña no', async () => {
      const r = await get(gerente, `/retention/winback?branchId=${g.sedes[1]!.id}`);
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(WinbackList, r.json())).toEqual([]);
      const lista = r.json() as WinbackList;
      const de = (id: string) => lista.members.find((m) => m.memberId === id);
      expect(lista.members.map((m) => m.memberId).sort()).toEqual([s.cancelo!, s.termino30!, s.archivado!, s.perdido!].sort());
      expect(lista.total).toBe(4);
      expect(lista.counts).toEqual({ LOST: 1, ARCHIVED: 1, CANCELED: 1, EXPIRED: 1 });
      expect(lista.terms).toEqual(PLAZOS_DEL_SOCIO);
      expect(de(s.cancelo!)).toMatchObject({ cause: 'CANCELED', since: hoyIso, until: sumarMeses(hoyIso, 6), reason: 'Cambió de trabajo', planName: 'Mensual', archived: false });
      expect(de(s.termino30!)).toMatchObject({ cause: 'EXPIRED', since: hoyIso, reason: null, archived: false });
      expect(de(s.archivado!)).toMatchObject({ cause: 'ARCHIVED', archived: true });
      // Perdido: 70 días sin venir, se cuenta desde que cumplió los 60 (hace 10).
      expect(de(s.perdido!)).toMatchObject({ cause: 'LOST', since: iso(hace(10)), until: sumarMeses(iso(hace(10)), 6), lastVisitOn: iso(hace(70)), archived: false });

      // Con «Recuperar» en 7 meses, entra también quien canceló hace 200 días.
      await ponerPlazos({ winbackMonths: 7 });
      const con7 = (await get(gerente, `/retention/winback?branchId=${g.sedes[1]!.id}`)).json() as WinbackList;
      expect(con7.members.map((m) => m.memberId)).toContain(s.viejo!);
      expect(con7.total).toBe(5);
      await deFabrica();

      // Recepción es de la primera sede: la segunda no la ve; la suya, sí (sin estos socios).
      expect((await get(recepcion, `/retention/winback?branchId=${g.sedes[1]!.id}`)).statusCode).toBe(403);
      const suya = await get(recepcion, '/retention/winback');
      expect(suya.statusCode, suya.body).toBe(200);
      const idsDeLaOtra = new Set(Object.values(s));
      expect((suya.json() as WinbackList).members.some((m) => idsDeLaOtra.has(m.memberId))).toBe(false);
      // La dueña ve cifras, no nombres (ADR-039).
      expect((await get(duena, `/retention/winback?branchId=${g.sedes[1]!.id}`)).statusCode).toBe(403);
    });

    it('«perdido» y «dejó de venir» usan los plazos del gimnasio en la lista de Retención', async () => {
      const lista = async () => (await get(gerente, `/retention/alerts?branchId=${g.sedes[1]!.id}&limit=500`)).json() as RetentionAlerts;
      const de = await lista();
      expect(diferenciasConElContrato(RetentionAlerts, de)).toEqual([]);
      expect(de.terms).toEqual(PLAZOS_DEL_SOCIO);
      // De fábrica: 70 días sin venir es perdido y no está en «A quién llamar».
      expect(de.counts.LOST).toBe(1);
      expect(de.outreach.some((m) => m.memberId === s.perdido)).toBe(false);
      // Con «perdido» a 90 días, vuelve a la lista como «dejó de venir» y sale de «Recuperar».
      await ponerPlazos({ lostDays: 90 });
      const con90 = await lista();
      expect(con90.terms.lostDays).toBe(90);
      expect(con90.counts.LOST).toBe(0);
      expect(con90.outreach.find((m) => m.memberId === s.perdido)).toMatchObject({ state: 'DORMANT' });
      const recuperar = (await get(gerente, `/retention/winback?branchId=${g.sedes[1]!.id}`)).json() as WinbackList;
      expect(recuperar.members.some((m) => m.memberId === s.perdido)).toBe(false);
      await deFabrica();
    });

    it('el Inicio de la dueña cuenta como bajas del mes el acto, la cancelación y la que cumplió el plazo (no solo el acto)', async () => {
      const r = await get(duena, `/reports/pulse?branchId=${g.sedes[1]!.id}&fresh=1`);
      expect(r.statusCode, r.body).toBe(200);
      // Hoy quedaron de baja tres de esa sede: canceló, cumplió 30 días de terminada y lo dieron de baja.
      // (El anonimizado se dio de baja hace 3 días y el de 200 días, hace 200: cuentan o no según el día del mes.)
      const inicioMes = `${hoyIso.slice(0, 7)}-01`;
      const esperadas = 3 + (iso(hace(3)) >= inicioMes ? 1 : 0) + (iso(hace(200)) >= inicioMes ? 1 : 0);
      expect(r.json().month.leftMembers).toBe(esperadas);
    });
  });
});
