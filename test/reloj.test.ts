import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import type { MonthlyClosePreview } from '@gymflow/core/contracts';
import { makeApp, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { correr, type Corrida } from '../src/platform/jobs/runner.js';
import type { BackendModule } from '../src/platform/modules/types.js';
import { expireMemberships } from '../src/modules/memberships/membership.jobs.js';
import { abrirTurno, cargoPropio, gimnasioPropio, sesionesDe, socioPropio, type GimnasioPropio, type SedePropia } from './gimnasio-propio.js';

/**
 * EL RELOJ (bloque 1.17b; 28-19: «0 usos de `setSystemTime` en `test/`»).
 *
 * Hasta hoy toda prueba corría «ahora»: lo que pasa a la medianoche, al
 * cambiar de mes o el día que Tijuana adelanta el reloj solo se habría visto
 * si alguien corría la suite justo en ese minuto. Aquí la hora la pone la
 * prueba (`vi.setSystemTime`): nada depende de la hora real de la máquina.
 *
 * Un gimnasio propio con dos sedes: Centro (hora de la Ciudad de México, sin
 * horario de verano desde 2022: siempre UTC−6) y Frontera (Tijuana: UTC−8 en
 * invierno, UTC−7 en verano). Las fechas son de 2026, ya pasadas: el reloj
 * falso solo cambia `Date` en el proceso de la API, no el `now()` de la base,
 * y una sesión «creada en el futuro» no la reconoce nadie.
 */
describe('el reloj: medianoche por sede, fin de mes y cambio de horario', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let centro: SedePropia;
  let frontera: SedePropia;
  let sesiones: Awaited<ReturnType<typeof sesionesDe>>;
  const db = () => getDb();

  /**
   * Pone la hora (UTC). Las sesiones son las de `beforeAll`, abiertas con el reloj de
   * verdad: la base compara su vigencia con su propio `now()`, que el reloj falso no mueve.
   */
  async function alas(instante: string) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(instante));
    return sesiones;
  }
  const previa = async (cookie: string, mes: string) =>
    (await app.inject({ method: 'GET', url: `/reports/monthly-close/preview?month=${mes}`, headers: { cookie } })).json() as MonthlyClosePreview;
  /** «Hoy» en cada sede, según el servidor. */
  async function hoy(cookie: string): Promise<{ gimnasio: string; centro: string; frontera: string }> {
    const p = await previa(cookie, '2025-01');
    const de = (s: SedePropia) => p.businessDates.byBranch.find((b) => b.branchId === s.id)!.date;
    return { gimnasio: p.businessDates.organization, centro: de(centro), frontera: de(frontera) };
  }
  async function cobrar(cookie: string, sede: SedePropia, turno: string, centavos = '10000'): Promise<{ id: string; businessDate: string }> {
    const socio = await socioPropio(g, sede);
    await cargoPropio(g, socio, BigInt(centavos), sede);
    const r = await app.inject({
      method: 'POST', url: `/members/${socio}/payments`, headers: { cookie },
      payload: { method: 'CASH', amountCents: centavos, idempotencyKey: `reloj-${randomUUID()}`, branchId: sede.id, cashSessionId: turno },
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().payment.id as string;
    const fila = await db().payment.findUniqueOrThrow({ where: { id }, select: { businessDate: true } });
    return { id, businessDate: fila.businessDate.toISOString().slice(0, 10) };
  }
  const diaDelTurno = async (id: string) => (await db().cashSession.findUniqueOrThrow({ where: { id }, select: { businessDate: true } })).businessDate.toISOString().slice(0, 10);

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Centro', cajas: 2 }, { name: 'Frontera', zona: 'America/Tijuana', cajas: 2 }] });
    [centro, frontera] = g.sedes as [SedePropia, SedePropia];
    sesiones = await sesionesDe(app, g);
  }, 60_000);

  afterEach(() => { vi.useRealTimers(); });

  afterAll(async () => {
    vi.useRealTimers();
    await g.cerrar();
    await app.close();
    await closeDb();
  });

  it('la hora de la prueba manda: el servidor dice la fecha que se le puso, no la de la máquina', async () => {
    const s = await alas('2026-06-16T18:00:00.000Z');
    expect(await hoy(s.gerente)).toEqual({ gimnasio: '2026-06-16', centro: '2026-06-16', frontera: '2026-06-16' });
  });

  it('a las 00:30 de la Ciudad de México, en Frontera todavía es ayer: el turno y el cobro llevan la fecha de SU sede', async () => {
    // 06:30 UTC del 16 de junio = 00:30 del 16 en la CDMX y 23:30 del 15 en Tijuana (verano, UTC−7).
    const s = await alas('2026-06-16T06:30:00.000Z');
    expect(await hoy(s.gerente)).toEqual({ gimnasio: '2026-06-16', centro: '2026-06-16', frontera: '2026-06-15' });

    const turnoCentro = await abrirTurno(app, s.gerente, centro.cajas[0]!);
    const turnoFrontera = await abrirTurno(app, s.gerente2, frontera.cajas[0]!);
    expect(await diaDelTurno(turnoCentro)).toBe('2026-06-16');
    expect(await diaDelTurno(turnoFrontera)).toBe('2026-06-15');
    expect((await cobrar(s.gerente, centro, turnoCentro)).businessDate).toBe('2026-06-16');
    expect((await cobrar(s.gerente2, frontera, turnoFrontera)).businessDate).toBe('2026-06-15');

    // Una hora después ya es 16 en las dos.
    vi.setSystemTime(new Date('2026-06-16T07:30:00.000Z'));
    expect(await hoy(s.gerente)).toMatchObject({ centro: '2026-06-16', frontera: '2026-06-16' });
    // El turno de Frontera sigue siendo el del 15: nació ese día y no cambia de fecha por seguir abierto.
    expect(await diaDelTurno(turnoFrontera)).toBe('2026-06-15');
    for (const [turno, quien] of [[turnoCentro, s.gerente], [turnoFrontera, s.gerente2]] as const) {
      const corte = await app.inject({ method: 'POST', url: `/cash-sessions/${turno}/close`, headers: { cookie: quien }, payload: { countedCashCents: '60000' } });
      expect(corte.statusCode, corte.body).toBe(200);
    }
  });

  it('fin de mes: un cobro de las 23:30 es del mes que termina; el mes no se cierra hasta que acaba en Frontera, y la foto trae lo cobrado allá después de la medianoche de la CDMX', async () => {
    // 30 de junio, 23:30 en la CDMX (05:30 UTC del 1 de julio).
    const s = await alas('2026-07-01T05:30:00.000Z');
    const turnoCentro = await abrirTurno(app, s.gerente, centro.cajas[1]!);
    const turnoFrontera = await abrirTurno(app, s.gerente2, frontera.cajas[1]!);
    const antes = await previa(s.gerente, '2026-06');
    expect((await cobrar(s.gerente, centro, turnoCentro, '11100')).businessDate).toBe('2026-06-30');
    expect((await previa(s.gerente, '2026-06')).closable).toBe(false);

    // 1 de julio, 00:30 en la CDMX; en Tijuana, 23:30 del 30 de junio.
    vi.setSystemTime(new Date('2026-07-01T06:30:00.000Z'));
    expect((await cobrar(s.gerente, centro, turnoCentro, '22200')).businessDate).toBe('2026-07-01');
    expect((await cobrar(s.gerente2, frontera, turnoFrontera, '33300')).businessDate).toBe('2026-06-30');
    const aMedias = await previa(s.gerente, '2026-06');
    expect(aMedias.businessDates).toMatchObject({ organization: '2026-07-01' });
    expect(aMedias.closable, 'junio no ha terminado en Frontera').toBe(false);
    expect(aMedias.blockers.length).toBeGreaterThan(0);

    // 1 de julio, 00:30 en Tijuana: junio terminó en todas.
    vi.setSystemTime(new Date('2026-07-01T07:30:00.000Z'));
    for (const [turno, quien] of [[turnoCentro, s.gerente], [turnoFrontera, s.gerente2]] as const) {
      const rep = await app.inject({ method: 'GET', url: `/cash-sessions/${turno}`, headers: { cookie: quien } });
      const corte = await app.inject({ method: 'POST', url: `/cash-sessions/${turno}/close`, headers: { cookie: quien }, payload: { countedCashCents: String(rep.json().expectedCashCents ?? '0'), varianceReason: 'Corte de la prueba de reloj' } });
      expect(corte.statusCode, corte.body).toBe(200);
    }
    const alFin = await previa(s.gerente, '2026-06');
    expect(alFin.blockers, JSON.stringify(alFin.blockers)).toEqual([]);
    expect(alFin.closable).toBe(true);
    // Junio: los $111 de Centro (23:30 del 30) y los $333 de Frontera (23:30 del 30 allá). Los $222 son de julio.
    expect(BigInt(alFin.totals.collectedCents) - BigInt(antes.totals.collectedCents)).toBe(11_100n + 33_300n);
    const deJulio = await previa(s.gerente, '2026-07');
    expect(deJulio.totals.collectedCents).toBe('22200');
    expect(deJulio.closable).toBe(false);

    const token = await aprobacion(app, s.gerente, 'reports:month:close', g.correos.owner);
    const cierre = await app.inject({ method: 'POST', url: '/reports/monthly-close', headers: { cookie: s.gerente }, payload: { month: '2026-06', reason: 'Cierre de junio', approvalToken: token } });
    expect(cierre.statusCode, cierre.body).toBe(201);
    expect(cierre.json().totals.collectedCents).toBe(alFin.totals.collectedCents);
  });

  it('el día que Tijuana adelanta el reloj dura 23 horas y el que lo atrasa, 25: la fecha de Frontera cambia a SU medianoche', async () => {
    const s = await alas('2026-03-08T07:59:00.000Z');
    const frontera_ = async (instante: string) => { vi.setSystemTime(new Date(instante)); return (await hoy(s.gerente)).frontera; };
    // Invierno (UTC−8): la medianoche del 8 de marzo es a las 08:00 UTC.
    expect(await frontera_('2026-03-08T07:59:00.000Z')).toBe('2026-03-07');
    expect(await frontera_('2026-03-08T08:00:00.000Z')).toBe('2026-03-08');
    // Ese día se adelanta el reloj (UTC−7): la medianoche del 9 llega a las 07:00 UTC, 23 horas después.
    expect(await frontera_('2026-03-09T06:59:00.000Z')).toBe('2026-03-08');
    expect(await frontera_('2026-03-09T07:00:00.000Z')).toBe('2026-03-09');
    // 1 de noviembre: se atrasa. Empieza a las 07:00 UTC y termina a las 08:00 UTC del 2: 25 horas.
    expect(await frontera_('2026-11-01T06:59:00.000Z')).toBe('2026-10-31');
    expect(await frontera_('2026-11-01T07:00:00.000Z')).toBe('2026-11-01');
    expect(await frontera_('2026-11-02T07:59:00.000Z')).toBe('2026-11-01');
    expect(await frontera_('2026-11-02T08:00:00.000Z')).toBe('2026-11-02');
  });

  it('la Ciudad de México ya no cambia de horario: su medianoche es a las 06:00 UTC todo el año', async () => {
    const s = await alas('2026-04-05T05:59:00.000Z');
    const centro_ = async (instante: string) => { vi.setSystemTime(new Date(instante)); return (await hoy(s.gerente)).centro; };
    for (const dia of ['2026-01-15', '2026-04-05', '2026-07-15', '2026-10-25', '2026-11-01']) {
      const anterior = new Date(new Date(`${dia}T00:00:00.000Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
      expect(await centro_(`${dia}T05:59:59.000Z`), dia).toBe(anterior);
      expect(await centro_(`${dia}T06:00:00.000Z`), dia).toBe(dia);
    }
  });

  it('el cierre diario de un gimnasio de Tijuana corre una vez por día de allá, también el día de 23 horas', async () => {
    const tj = await gimnasioPropio({ zona: 'America/Tijuana', sedes: [{ name: 'Tijuana', cajas: 1 }] });
    const llamadas: string[] = [];
    const modules: BackendModule[] = [{ name: 'prueba-reloj', module: 'core', register: () => {}, jobs: [
      { name: 'prueba.reloj-diario', handler: async () => { llamadas.push(new Date().toISOString()); return { job: 'prueba.reloj-diario', processed: 1, skipped: 0, batches: 1, truncated: false, errors: [] }; } },
    ] }];
    const ordenes = { diario: ['prueba.reloj-diario'], frecuente: [], plataforma: [] };
    const pasada = async (instante: string): Promise<Corrida> => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(instante));
      const c = await correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [tj.organizationId], host: 'reloj#1', perfil: null });
      vi.useRealTimers();
      return c;
    };
    try {
      await pasada('2026-03-08T08:30:00.000Z'); // 00:30 del 8 (invierno)
      expect(llamadas).toHaveLength(1);
      await pasada('2026-03-08T20:00:00.000Z'); // 13:00 del 8 (ya verano): mismo día
      await pasada('2026-03-09T06:30:00.000Z'); // 23:30 del 8
      expect(llamadas, 'el mismo día de Tijuana no repite').toHaveLength(1);
      await pasada('2026-03-09T07:30:00.000Z'); // 00:30 del 9
      expect(llamadas).toHaveLength(2);
      const pasos = await db().jobRunStep.findMany({ where: { organizationId: tj.organizationId, job: 'prueba.reloj-diario' }, orderBy: { startedAt: 'asc' } });
      expect(pasos.map((p) => p.businessDate.toISOString().slice(0, 10))).toEqual(['2026-03-08', '2026-03-09']);
    } finally {
      await db().jobRunStep.deleteMany({ where: { organizationId: tj.organizationId } });
      await db().jobRun.deleteMany({ where: { host: 'reloj#1' } });
      await tj.cerrar();
    }
  });

  /** Membresía de prepago sin renovación que cubre hasta `ultimoDia` inclusive. */
  async function prepagoHasta(sede: SedePropia, finExclusivo: string, desde = '2026-05-16'): Promise<string> {
    const socio = await socioPropio(g, sede);
    const id = uuidv7();
    const inicio = new Date(`${desde}T00:00:00.000Z`);
    await db().membership.create({
      data: {
        id, organizationId: g.organizationId, memberId: socio, planId: g.planMensual, soldAtBranchId: sede.id, status: 'ACTIVE',
        startDate: inicio, currentPeriodStart: inicio, currentPeriodEnd: new Date(`${finExclusivo}T00:00:00.000Z`), billingAnchorDay: 16, autoRenew: false,
      },
    });
    return id;
  }
  const estadoDe = async (id: string) => (await db().membership.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

  it('una membresía que no se renueva vence cuando termina su último día, no antes: en Centro, a la medianoche de la CDMX', async () => {
    const m = await prepagoHasta(centro, '2026-06-16'); // cubre hasta el 15 de junio
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-16T05:30:00.000Z')); // 23:30 del 15 en la CDMX
    await expireMemberships(g.organizationId);
    expect(await estadoDe(m)).toBe('ACTIVE');
    vi.setSystemTime(new Date('2026-06-16T06:30:00.000Z')); // 00:30 del 16
    await expireMemberships(g.organizationId);
    expect(await estadoDe(m)).toBe('EXPIRED');
  });

  /**
   * EL «HOY» DE LA SEDE EN LOS JOBS (defecto 2 de 1.17b, cerrado en 2.13). Los jobs de
   * membresías y cobro tomaban UN «hoy» por gimnasio; en un gimnasio de la CDMX con una
   * sede en Tijuana, la membresía de Frontera vencía a la medianoche de la CDMX: una o
   * dos horas antes de que terminara su último día pagado. Ahora cada membresía, cargo o
   * aviso se decide con el día de operación de SU sede (`BusinessCalendar.dias`).
   */
  it('una membresía de Frontera no vence antes de la medianoche de Frontera: en la misma pasada vence la de Centro y la de Frontera sigue', async () => {
    const deFrontera = await prepagoHasta(frontera, '2026-06-16'); // cubre hasta el 15 de junio
    const deCentro = await prepagoHasta(centro, '2026-06-16');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-16T06:30:00.000Z')); // 23:30 del 15 en Tijuana; 00:30 del 16 en la CDMX
    await expireMemberships(g.organizationId);
    expect(await estadoDe(deFrontera), 'a las 23:30 de su último día sigue vigente').toBe('ACTIVE');
    expect(await estadoDe(deCentro), 'la de Centro ya terminó su día').toBe('EXPIRED');
    vi.setSystemTime(new Date('2026-06-16T07:30:00.000Z')); // 00:30 del 16 en Tijuana
    await expireMemberships(g.organizationId);
    expect(await estadoDe(deFrontera)).toBe('EXPIRED');
    // El evento lleva la fecha de negocio de SU sede.
    const evento = await db().membershipEvent.findFirstOrThrow({ where: { membershipId: deFrontera, eventType: 'EXPIRED' }, select: { businessDate: true } });
    expect(evento.businessDate.toISOString().slice(0, 10)).toBe('2026-06-16');
  });

  it('en invierno Tijuana va dos horas atrás: la membresía de Frontera vence a las 08:00 UTC, no a las 06:00 ni a las 07:00', async () => {
    const m = await prepagoHasta(frontera, '2026-01-16', '2025-12-16');
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const antes of ['2026-01-16T06:30:00.000Z', '2026-01-16T07:30:00.000Z']) {
      vi.setSystemTime(new Date(antes));
      await expireMemberships(g.organizationId);
      expect(await estadoDe(m), antes).toBe('ACTIVE');
    }
    vi.setSystemTime(new Date('2026-01-16T08:30:00.000Z'));
    await expireMemberships(g.organizationId);
    expect(await estadoDe(m)).toBe('EXPIRED');
  });

  it('un cargo vence con el día de su sede: el de Frontera no sale «vencido» mientras allá siga siendo su fecha límite, y el aviso «vence pronto» cuenta los días desde el hoy de cada sede', async () => {
    const { markOverdueCharges } = await import('../src/modules/billing/billing.jobs.js');
    const { PORTAL_JOBS } = await import('../src/modules/portal/notices.jobs.js');
    const dia = (f: string) => new Date(`${f}T00:00:00.000Z`);
    const estadoDelCargo = async (id: string) => (await db().charge.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
    const [socioC, socioF] = [await socioPropio(g, centro), await socioPropio(g, frontera)];
    // Vencen el 15: el 16 ya están vencidos, cada uno en SU 16.
    const cargoC = await cargoPropio(g, socioC, 10_000n, centro, dia('2026-06-15'));
    const cargoF = await cargoPropio(g, socioF, 10_000n, frontera, dia('2026-06-15'));
    // «Vence en 3 días»: para Centro (día 16) es el 19; para Frontera (día 15), el 18.
    const pronto = {
      c19: await cargoPropio(g, socioC, 20_000n, centro, dia('2026-06-19')),
      c18: await cargoPropio(g, socioC, 20_000n, centro, dia('2026-06-18')),
      f18: await cargoPropio(g, socioF, 20_000n, frontera, dia('2026-06-18')),
      f19: await cargoPropio(g, socioF, 20_000n, frontera, dia('2026-06-19')),
    };
    const avisados = async () => new Set((await db().memberNotice.findMany({
      where: { organizationId: g.organizationId, dedupeKey: { in: Object.values(pronto).map((id) => `PAYMENT_DUE_SOON:${id}`) } }, select: { dedupeKey: true },
    })).map((n) => n.dedupeKey!.split(':')[1]));

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-16T06:30:00.000Z')); // 00:30 del 16 en la CDMX; 23:30 del 15 en Tijuana
    const r = await markOverdueCharges(g.organizationId);
    expect(r.errors).toEqual([]);
    expect(await estadoDelCargo(cargoC)).toBe('OVERDUE');
    expect(await estadoDelCargo(cargoF), 'en Frontera todavía es su fecha límite').toBe('OPEN');
    const avisos = await PORTAL_JOBS[0]!.handler(g.organizationId);
    expect(avisos.errors).toEqual([]);
    expect(await avisados()).toEqual(new Set([pronto.c19, pronto.f18]));

    vi.setSystemTime(new Date('2026-06-16T07:30:00.000Z')); // ya es 16 en las dos
    await markOverdueCharges(g.organizationId);
    expect(await estadoDelCargo(cargoF)).toBe('OVERDUE');
    await PORTAL_JOBS[0]!.handler(g.organizationId);
    expect(await avisados()).toEqual(new Set([pronto.c19, pronto.f18, pronto.f19]));
  });

  it('en la ventana de dos fechas, los demás jobs con fecha corren sin errores y la cuota de Frontera no se emite antes de su día', async () => {
    const { BILLING_JOBS } = await import('../src/modules/billing/billing.jobs.js');
    const { MEMBERSHIP_JOBS } = await import('../src/modules/memberships/membership.jobs.js');
    // Con renovación: el periodo termina el 15 (fin exclusivo el 16) y el 16 toca avanzar y emitir la cuota.
    const conRenovacion = async (sede: SedePropia) => {
      const id = await prepagoHasta(sede, '2026-09-16', '2026-08-16');
      const m = await db().membership.update({ where: { id }, data: { autoRenew: true }, select: { memberId: true } });
      // La cuota del periodo que termina ya existe y no ha vencido: lo único que toca hoy es avanzar.
      await db().charge.create({
        data: {
          id: uuidv7(), organizationId: g.organizationId, memberId: m.memberId, membershipId: id, branchId: sede.id, chargeType: 'MEMBERSHIP_PERIOD', status: 'OPEN',
          concept: 'Cuota de agosto', subtotalCents: 60_000n, taxCents: 0n, discountCents: 0n, amountCents: 60_000n,
          periodStart: new Date('2026-08-16T00:00:00.000Z'), periodEnd: new Date('2026-09-16T00:00:00.000Z'), dueDate: new Date('2026-12-01T00:00:00.000Z'), issuedAt: new Date('2026-08-16T00:00:00.000Z'),
        },
      });
      return id;
    };
    const [deCentro, deFrontera] = [await conRenovacion(centro), await conRenovacion(frontera)];
    const inicioDe = async (id: string) => (await db().membership.findUniqueOrThrow({ where: { id }, select: { currentPeriodStart: true } })).currentPeriodStart.toISOString().slice(0, 10);
    const cuotasDe = (id: string, inicio: string) => db().charge.count({ where: { membershipId: id, chargeType: 'MEMBERSHIP_PERIOD', periodStart: new Date(`${inicio}T00:00:00.000Z`) } });
    const corrida = async () => {
      for (const job of [...MEMBERSHIP_JOBS, ...BILLING_JOBS]) {
        const r = await job.handler(g.organizationId);
        expect(r.errors, job.name).toEqual([]);
      }
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-16T06:30:00.000Z')); // 16 en la CDMX, 15 en Tijuana (verano)
    await corrida();
    expect(await inicioDe(deCentro)).toBe('2026-09-16');
    expect(await cuotasDe(deCentro, '2026-09-16')).toBe(1);
    expect(await inicioDe(deFrontera), 'en Frontera sigue siendo el último día del periodo').toBe('2026-08-16');
    expect(await cuotasDe(deFrontera, '2026-09-16')).toBe(0);
    vi.setSystemTime(new Date('2026-09-16T07:30:00.000Z'));
    await corrida();
    expect(await inicioDe(deFrontera)).toBe('2026-09-16');
    expect(await cuotasDe(deFrontera, '2026-09-16')).toBe(1);
    // Una corrida de cobro por fecha, y la del 16 es una sola aunque la alimentaron dos pasadas.
    const corridas = await db().billingCycle.findMany({ where: { organizationId: g.organizationId, runDate: { in: [new Date('2026-09-15T00:00:00.000Z'), new Date('2026-09-16T00:00:00.000Z')] } }, select: { runDate: true, chargesCreated: true } });
    expect(corridas.filter((c) => c.runDate.toISOString().startsWith('2026-09-16'))).toHaveLength(1);
  });

  it('una tarjeta de junio sirve hasta que junio termina en todas las sedes (antes: se marcaba vencida con el mes en UTC, desde las 18:00 del 30 en la CDMX)', async () => {
    const { PAYMENT_JOBS } = await import('../src/modules/payments/payments.jobs.js');
    const vencer = PAYMENT_JOBS.find((j) => j.name === 'payments.expire-cards')!.handler;
    const socio = await socioPropio(g, frontera);
    const tarjeta = uuidv7();
    await db().paymentMethod.create({ data: { id: tarjeta, organizationId: g.organizationId, memberId: socio, provider: 'sandbox', providerTokenRef: `tok_reloj_${tarjeta}`, brand: 'visa', last4: '4242', expMonth: 6, expYear: 2026 } });
    const estado = async () => (await db().paymentMethod.findUniqueOrThrow({ where: { id: tarjeta }, select: { status: true } })).status;
    vi.useFakeTimers({ toFake: ['Date'] });
    // 1 de julio en UTC (18:30 del 30 en la CDMX), y 1 de julio en la CDMX pero 30 de junio en Tijuana.
    for (const antes of ['2026-07-01T00:30:00.000Z', '2026-07-01T06:30:00.000Z']) {
      vi.setSystemTime(new Date(antes));
      await vencer(g.organizationId);
      expect(await estado(), antes).toBe('ACTIVE');
    }
    vi.setSystemTime(new Date('2026-07-01T07:30:00.000Z')); // 1 de julio en todas
    await vencer(g.organizationId);
    expect(await estado()).toBe('EXPIRED');
  });

  it('con sedes en dos fechas, el cierre diario corre UNA vez por fecha: cuando ese día ya empezó en todas las sedes', async () => {
    const dos = await gimnasioPropio({ sedes: [{ name: 'Centro', cajas: 1 }, { name: 'Frontera', zona: 'America/Tijuana', cajas: 1 }] });
    const llamadas: string[] = [];
    const modules: BackendModule[] = [{ name: 'prueba-reloj-2', module: 'core', register: () => {}, jobs: [
      { name: 'prueba.reloj-dos-zonas', handler: async () => { llamadas.push(new Date().toISOString()); return { job: 'prueba.reloj-dos-zonas', processed: 1, skipped: 0, batches: 1, truncated: false, errors: [] }; } },
    ] }];
    const ordenes = { diario: ['prueba.reloj-dos-zonas'], frecuente: [], plataforma: [] };
    const pasada = async (instante: string): Promise<void> => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(instante));
      await correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [dos.organizationId], host: 'reloj#2', perfil: null });
      vi.useRealTimers();
    };
    const fechas = async () => (await db().jobRunStep.findMany({ where: { organizationId: dos.organizationId, job: 'prueba.reloj-dos-zonas' }, orderBy: { startedAt: 'asc' } })).map((p) => p.businessDate.toISOString().slice(0, 10));
    try {
      await pasada('2026-06-15T18:00:00.000Z'); // mediodía del 15 en las dos
      expect(await fechas()).toEqual(['2026-06-15']);
      await pasada('2026-06-16T06:30:00.000Z'); // ya es 16 en la CDMX; en Tijuana, 23:30 del 15
      expect(await fechas(), 'el cierre del 16 espera a que empiece en Frontera').toEqual(['2026-06-15']);
      await pasada('2026-06-16T07:30:00.000Z'); // 16 en las dos
      expect(await fechas()).toEqual(['2026-06-15', '2026-06-16']);
      await pasada('2026-06-16T20:00:00.000Z');
      await pasada('2026-06-17T06:30:00.000Z');
      expect(await fechas(), 'el mismo día no repite').toEqual(['2026-06-15', '2026-06-16']);
      expect(llamadas).toHaveLength(2);
      // Una sede cerrada no detiene el cierre: sin Frontera, el día es el de la CDMX.
      await db().branch.update({ where: { id: dos.sedes[1]!.id }, data: { isActive: false } });
      await pasada('2026-06-18T06:30:00.000Z');
      expect((await fechas()).at(-1)).toBe('2026-06-18');
    } finally {
      await db().jobRunStep.deleteMany({ where: { organizationId: dos.organizationId } });
      await db().jobRun.deleteMany({ where: { host: 'reloj#2' } });
      await dos.cerrar();
    }
  });

  /**
   * DEFECTO DE 1.17b, CERRADO EN 3.12. La cadena de la bitácora se ENLAZABA con «el
   * último asiento» y se VERIFICABA en orden, y las dos cosas se decidían por la hora del
   * servidor (`at`, y dentro del mismo milisegundo el id, que es al azar). Si el reloj
   * retrocedía (una corrección de hora; en WSL2 pasa al despertar la máquina) el siguiente
   * asiento volvía a enlazarse con el mismo y la verificación decía «prevHash no encadena»,
   * como si alguien hubiera tocado la bitácora. Ahora cada eslabón lleva su número
   * (`chainSeq`) y la hora ya no decide nada. Más casos en `cadena-secuencia.test.ts`.
   */
  it('la cadena de la bitácora no depende de que el reloj del servidor nunca retroceda', async () => {
    const { AuditService } = await import('../src/platform/audit/audit.service.js');
    const { systemContext } = await import('../src/platform/jobs/types.js');
    const propio = await gimnasioPropio({ sedes: [{ name: 'Sede de la cadena', cajas: 1 }] });
    try {
      const audit = new AuditService();
      const ctx = systemContext(propio.organizationId);
      const asentar = (paso: string) => audit.record(ctx, { action: 'cash.register.update', resourceType: 'cash_register', resourceId: propio.sedes[0]!.cajas[0]!, afterState: { paso } });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-06-16T18:00:02.000Z'));
      await asentar('antes de la corrección');
      // El reloj se corrige dos segundos hacia atrás y el mostrador sigue trabajando.
      vi.setSystemTime(new Date('2026-06-16T18:00:00.000Z'));
      await asentar('primero después');
      vi.setSystemTime(new Date('2026-06-16T18:00:01.000Z'));
      await asentar('segundo después');
      const v = await audit.verifyChain(propio.organizationId);
      expect(v.ok, JSON.stringify(v)).toBe(true);
    } finally {
      vi.useRealTimers();
      await propio.cerrar();
    }
  });
});
