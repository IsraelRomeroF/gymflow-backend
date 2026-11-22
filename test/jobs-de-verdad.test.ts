import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { uuidv7, cycleChargeKey } from '@gymflow/core';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { BACKEND_MODULES } from '../src/modules.js';
import { correr, type Corrida } from '../src/platform/jobs/runner.js';
import { ORDEN_DIARIO, ORDEN_FRECUENTE } from '../src/platform/jobs/plan.js';
import { gimnasioPropio, socioPropio, type GimnasioPropio, type SedePropia } from './gimnasio-propio.js';
import { ponerReloj, relojReal } from './reloj.js';

/**
 * EL CIERRE DIARIO DE VERDAD (bloque 1.17b; 28-19: «sin prueba del orden del
 * cierre diario»).
 *
 * `jobs.test.ts` (1.16) prueba el corredor con jobs de mentira: candados,
 * cortes, «ya corrió hoy». Las pruebas de cada módulo llaman a sus jobs uno
 * por uno. Faltaba lo que pasa en la noche: TODOS los jobs de verdad, en su
 * orden, por el corredor de verdad, sobre un gimnasio que tiene un caso para
 * cada uno; y qué pasa si el cierre se repite el mismo día.
 *
 * El gimnasio es propio y la fecha es fija (10 de junio de 2026 a mediodía,
 * hora de la CDMX): los casos se siembran con fechas escritas, no con «hace N
 * días» contados desde la hora de la máquina.
 */
const HOY = '2026-06-10';
const MEDIODIA = '2026-06-10T18:00:00.000Z';
const dia = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

// Tope amplio: el cierre completo tarda menos de un segundo, pero con la máquina cargada (otras suites, otro
// agente) llegó a pasar de 30 s una vez, y una corrida que se queda a medias deja el candado tomado para las demás.
describe('el cierre diario de verdad: cada job con su caso, en orden, y su repetición el mismo día', { timeout: 180_000 }, () => {
  let g: GimnasioPropio;
  let sede: SedePropia;
  const db = () => getDb();
  /** El id de la membresía de cada caso. */
  const caso: Record<string, string> = {};
  let paquete = '';
  let tarjeta = '';

  /** Una membresía con su cuota del periodo vigente (abierta, con el vencimiento que se diga). */
  async function membresia(nombre: string, m: {
    status: 'ACTIVE' | 'PENDING' | 'FROZEN' | 'PAST_DUE' | 'SUSPENDED'; inicio: string; fin: string; autoRenew?: boolean;
    graceUntil?: string; frozenSince?: string; frozenUntil?: string; creada?: string;
    cuota?: { vence: string; status?: 'OPEN' | 'OVERDUE' } | null; archivado?: boolean;
  }): Promise<string> {
    const socio = await socioPropio(g, sede);
    if (m.archivado) await db().member.update({ where: { id: socio }, data: { deletedAt: new Date(), status: 'ARCHIVED' } }).catch(() => db().member.update({ where: { id: socio }, data: { deletedAt: new Date() } }));
    const id = uuidv7();
    await db().membership.create({
      data: {
        id, organizationId: g.organizationId, memberId: socio, planId: g.planMensual, soldAtBranchId: sede.id, status: m.status,
        startDate: dia(m.inicio), currentPeriodStart: dia(m.inicio), currentPeriodEnd: dia(m.fin), billingAnchorDay: Number(m.inicio.slice(8, 10)),
        autoRenew: m.autoRenew ?? true, agreedPriceCents: 60_000n,
        ...(m.graceUntil ? { graceUntil: dia(m.graceUntil) } : {}),
        ...(m.frozenSince ? { frozenSince: dia(m.frozenSince), frozenUntil: dia(m.frozenUntil!) } : {}),
        ...(m.creada ? { createdAt: new Date(`${m.creada}T18:00:00.000Z`) } : {}),
      },
    });
    if (m.cuota !== null) {
      const cuota = m.cuota ?? { vence: m.fin };
      await db().charge.create({
        data: {
          id: uuidv7(), organizationId: g.organizationId, memberId: socio, membershipId: id, branchId: sede.id, chargeType: 'MEMBERSHIP_PERIOD',
          status: cuota.status ?? 'OPEN', concept: `Cuota de ${nombre}`, subtotalCents: 60_000n, taxCents: 0n, discountCents: 0n, amountCents: 60_000n,
          periodStart: dia(m.inicio), periodEnd: dia(m.fin), dueDate: dia(cuota.vence), issuedAt: dia(m.inicio), idempotencyKey: cycleChargeKey(id, dia(m.inicio)),
        },
      });
    }
    caso[nombre] = id;
    return id;
  }
  const estado = async (nombre: string) => (await db().membership.findUniqueOrThrow({ where: { id: caso[nombre]! } })).status;
  /** Lo que el corredor va diciendo, con el momento en que lo dijo: cada job escribe su renglón al terminar. */
  const dicho: Array<{ t: number; texto: string }> = [];
  const cierre = (extra: { forzar?: boolean } = {}): Promise<Corrida> => {
    dicho.length = 0;
    dicho.push({ t: performance.now(), texto: '(empieza)' });
    return correr({
      runner: 'DAILY', modules: BACKEND_MODULES, soloGimnasios: [g.organizationId], host: 'de-verdad#1', perfil: null,
      bitacora: { archivo: null, linea: (texto) => { dicho.push({ t: performance.now(), texto }); } }, ...extra,
    });
  };
  /** Los renglones que tardaron más de `segundos` en llegar desde el anterior. */
  const lentos = (segundos: number) => dicho.slice(1)
    .map((d, i) => ({ texto: d.texto.trim().slice(0, 60), s: (d.t - dicho[i]!.t) / 1000 }))
    .filter((d) => d.s > segundos).map((d) => `${d.s.toFixed(1)} s → ${d.texto}`);
  const pasos = (runId: string) => db().jobRunStep.findMany({ where: { runId }, orderBy: { startedAt: 'asc' } });
  /** Todo lo que el cierre puede mover, contado: si una repetición cambia algo, cambia esta foto. */
  async function foto() {
    const o = g.organizationId;
    const [membresias, cargos, eventos, visitas, paquetes, tarjetas, clases] = await Promise.all([
      db().membership.findMany({ where: { organizationId: o }, select: { id: true, status: true, currentPeriodStart: true, currentPeriodEnd: true, graceUntil: true }, orderBy: { id: 'asc' } }),
      db().charge.findMany({ where: { organizationId: o }, select: { id: true, status: true, amountCents: true, periodStart: true }, orderBy: { id: 'asc' } }),
      db().membershipEvent.count({ where: { organizationId: o } }),
      db().visitLedgerEntry.count({ where: { organizationId: o } }),
      db().visitPack.findMany({ where: { organizationId: o }, select: { id: true, status: true }, orderBy: { id: 'asc' } }),
      db().paymentMethod.findMany({ where: { organizationId: o }, select: { id: true, status: true }, orderBy: { id: 'asc' } }),
      db().classSchedule.count({ where: { organizationId: o } }),
    ]);
    return JSON.parse(JSON.stringify({ membresias, cargos, eventos, visitas, paquetes, tarjetas, clases }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }

  beforeAll(async () => {
    process.env.GYMFLOW_JOBS_SIN_ARCHIVO = '1';
    // El reloj se pone ANTES de crear el gimnasio: sus primeros asientos (textos publicados) tienen que ser anteriores a los del cierre.
    ponerReloj('2026-06-10T17:00:00.000Z');
    g = await gimnasioPropio({ sedes: [{ name: 'Sede del cierre', cajas: 1 }] });
    sede = g.sedes[0]!;
    const socio = await socioPropio(g, sede);

    // 1 · estados de membresía que se cierran solos
    await membresia('vence sin renovar', { status: 'ACTIVE', autoRenew: false, inicio: '2026-05-10', fin: HOY, cuota: { vence: '2026-07-01' } });
    await membresia('venta sin cobro', { status: 'PENDING', inicio: '2026-05-20', fin: '2026-06-20', creada: '2026-05-20', cuota: { vence: '2026-07-01' } });
    await membresia('socio archivado', { status: 'ACTIVE', inicio: '2026-06-01', fin: '2026-07-01', archivado: true, cuota: { vence: '2026-07-01' } });
    await membresia('descongela hoy', { status: 'FROZEN', inicio: '2026-05-20', fin: '2026-06-20', frozenSince: '2026-06-05', frozenUntil: HOY, cuota: { vence: '2026-07-01' } });
    // 2 · periodos y cuotas
    await membresia('se renueva hoy', { status: 'ACTIVE', inicio: '2026-05-10', fin: HOY, cuota: { vence: '2026-07-01' } });
    await membresia('sin cuota del periodo', { status: 'ACTIVE', inicio: '2026-06-01', fin: '2026-07-01', cuota: null });
    // 3 · mora
    await membresia('cuota vencida', { status: 'ACTIVE', inicio: '2026-06-01', fin: '2026-07-01', cuota: { vence: '2026-06-05' } });
    // 4 · gracia agotada y ventana de recuperación
    await membresia('gracia agotada', { status: 'PAST_DUE', inicio: '2026-06-01', fin: '2026-07-01', graceUntil: '2026-06-08', cuota: { vence: '2026-06-02', status: 'OVERDUE' } });
    await membresia('suspendida 100 días', { status: 'SUSPENDED', inicio: '2026-02-01', fin: '2026-03-01', graceUntil: '2026-03-01', cuota: { vence: '2026-02-02', status: 'OVERDUE' } });
    // Una al corriente, para comprobar que a esa no la toca nadie.
    await membresia('al corriente', { status: 'ACTIVE', inicio: '2026-06-01', fin: '2026-07-01', cuota: { vence: '2026-07-01' } });

    // 6 · paquete de visitas que caducó ayer con 3 visitas sin usar, y tarjeta que venció en mayo
    paquete = uuidv7();
    await db().visitPack.create({ data: { id: paquete, organizationId: g.organizationId, memberId: socio, visitsPurchased: 3, purchasedOn: dia('2026-05-01'), expiresOn: dia('2026-06-09'), status: 'ACTIVE' } });
    await db().visitLedgerEntry.create({ data: { id: uuidv7(), organizationId: g.organizationId, visitPackId: paquete, entryType: 'PURCHASE', delta: 3, businessDate: dia('2026-05-01'), at: dia('2026-05-01') } });
    tarjeta = uuidv7();
    await db().paymentMethod.create({ data: { id: tarjeta, organizationId: g.organizationId, memberId: socio, provider: 'sandbox', providerTokenRef: `tok_cierre_${tarjeta}`, brand: 'visa', last4: '4242', expMonth: 5, expYear: 2026 } });

    // Un reloj corrido que sigue caminando (no congelado): el cierre escribe en la bitácora y verifica su cadena.
    ponerReloj(MEDIODIA);
  }, 60_000);

  afterAll(async () => {
    relojReal();
    await db().jobRunStep.deleteMany({ where: { organizationId: g.organizationId } });
    await db().jobRun.deleteMany({ where: { host: 'de-verdad#1' } });
    await g.cerrar();
    await closeDb();
  });

  let primera: Corrida & { runId: string };
  let trasLaPrimera: Awaited<ReturnType<typeof foto>>;

  it('la primera corrida del día corre todos los jobs diarios en su orden, y después los frecuentes; ninguno falla', async () => {
    const c = await cierre();
    if (c.estado === 'OCUPADO') throw new Error('Había otro cierre diario corriendo');
    primera = c;
    expect(c.resumen.fallidos, 'jobs que reventaron').toEqual([]);
    expect(c.resumen.conErrores, 'jobs con errores por entidad').toEqual([]);
    // Si algún día tarda, el mensaje dice en qué job se fue el tiempo (con once membresías no hay por qué).
    expect(c.estado, `pasos de más de 5 s: ${lentos(5).join(' · ') || 'ninguno'}`).toBe('OK');
    const corridos = (await pasos(c.runId)).filter((p) => p.organizationId === g.organizationId);
    const diarios = corridos.filter((p) => ORDEN_DIARIO.includes(p.job));
    // Todos los diarios, una vez cada uno, en el orden del plan, con la fecha de negocio del gimnasio.
    expect(diarios.map((p) => p.job)).toEqual(ORDEN_DIARIO);
    expect(diarios.every((p) => p.status === 'OK')).toBe(true);
    expect(new Set(diarios.map((p) => p.businessDate.toISOString().slice(0, 10)))).toEqual(new Set([HOY]));
    // Los frecuentes van al final (solo dejan paso los que hicieron algo).
    const ultimoDiario = corridos.map((p) => p.job).lastIndexOf(ORDEN_DIARIO[ORDEN_DIARIO.length - 1]!);
    expect(corridos.slice(ultimoDiario + 1).every((p) => ORDEN_FRECUENTE.includes(p.job))).toBe(true);
    trasLaPrimera = await foto();
  });

  it('cada job hizo su caso', async () => {
    const hechos = new Map((await pasos(primera.runId)).map((p) => [p.job, p.processed]));
    // membership.expire · membership.expire-pending-sales · membership.close-archived · membership.unfreeze-scheduled
    expect(await estado('vence sin renovar')).toBe('EXPIRED');
    expect(await estado('venta sin cobro')).toBe('CANCELED');
    expect(await estado('socio archivado')).toBe('CANCELED');
    const descongelada = await db().membership.findUniqueOrThrow({ where: { id: caso['descongela hoy']! } });
    expect(descongelada).toMatchObject({ status: 'ACTIVE', frozenSince: null, frozenUntil: null });
    // Cinco días congelada: el periodo se corre cinco días.
    expect(descongelada.currentPeriodEnd.toISOString().slice(0, 10)).toBe('2026-06-25');
    for (const job of ['membership.expire', 'membership.expire-pending-sales', 'membership.close-archived', 'membership.unfreeze-scheduled']) expect(hechos.get(job), job).toBe(1);

    // billing.roll-periods: el periodo avanza un mes y nace su cuota, una sola.
    const renovada = await db().membership.findUniqueOrThrow({ where: { id: caso['se renueva hoy']! } });
    expect([renovada.currentPeriodStart, renovada.currentPeriodEnd].map((d) => d.toISOString().slice(0, 10))).toEqual([HOY, '2026-07-10']);
    expect(await db().charge.count({ where: { membershipId: renovada.id, chargeType: 'MEMBERSHIP_PERIOD', periodStart: dia(HOY) } })).toBe(1);
    expect(hechos.get('billing.roll-periods')).toBe(1);
    // billing.generate-cycle-charges: la que no tenía cuota de su periodo la recibe.
    expect(await db().charge.count({ where: { membershipId: caso['sin cuota del periodo']!, chargeType: 'MEMBERSHIP_PERIOD', periodStart: dia('2026-06-01') } })).toBe(1);
    expect(hechos.get('billing.generate-cycle-charges')).toBe(1);
    // OJO (anotado en el informe): esa cuota nace con el vencimiento de su periodo (1 de junio), ya pasado y con la
    // gracia agotada; en la MISMA corrida pasa a vencida, la membresía a mora y de ahí a suspendida. Es el orden del
    // plan funcionando, pero quien no recibió su cuota a tiempo por una falla queda suspendido sin haber podido pagar.
    expect(await estado('sin cuota del periodo')).toBe('SUSPENDED');

    // billing.mark-overdue y, DESPUÉS, billing.mark-memberships-past-due: en la misma corrida la cuota pasa a vencida y la membresía a mora.
    const vencida = await db().charge.findFirstOrThrow({ where: { membershipId: caso['cuota vencida']! } });
    expect(vencida.status).toBe('OVERDUE');
    const enMora = await db().membership.findUniqueOrThrow({ where: { id: caso['cuota vencida']! } });
    expect(enMora.status).toBe('PAST_DUE');
    // Venció el 5; cinco días de gracia: hasta el 10 (hoy) sigue entrando, así que hoy NO se suspende.
    expect(enMora.graceUntil?.toISOString().slice(0, 10)).toBe('2026-06-10');

    // membership.suspend-expired-grace · membership.expire-suspended
    expect(await estado('gracia agotada')).toBe('SUSPENDED');
    expect(await estado('suspendida 100 días')).toBe('EXPIRED');
    // Dos y dos: la de este caso y la que recibió su cuota tarde (arriba).
    expect(hechos.get('billing.mark-overdue')).toBe(2);
    expect(hechos.get('billing.mark-memberships-past-due')).toBe(2);
    expect(hechos.get('membership.suspend-expired-grace')).toBe(2);
    expect(hechos.get('membership.expire-suspended')).toBe(1);

    // visitpack.expire: las 3 visitas se pierden con su renglón en el libro; payments.expire-cards: la tarjeta de mayo ya no sirve.
    expect((await db().visitPack.findUniqueOrThrow({ where: { id: paquete } })).status).toBe('EXPIRED');
    const libro = await db().visitLedgerEntry.findMany({ where: { visitPackId: paquete }, orderBy: { at: 'asc' } });
    expect(libro.map((e) => [e.entryType, e.delta])).toEqual([['PURCHASE', 3], ['EXPIRE', -3]]);
    expect((await db().paymentMethod.findUniqueOrThrow({ where: { id: tarjeta } })).status).toBe('EXPIRED');
    expect(hechos.get('visitpack.expire')).toBe(1);
    expect(hechos.get('payments.expire-cards')).toBe(1);

    // La que está al corriente no la tocó nadie.
    const sana = await db().membership.findUniqueOrThrow({ where: { id: caso['al corriente']! } });
    expect(sana.status).toBe('ACTIVE');
    expect(await db().membershipEvent.count({ where: { membershipId: sana.id } })).toBe(0);
    // Y la cadena de la bitácora del gimnasio quedó verificada, con el asiento del cierre.
    const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'system.daily_run' }, orderBy: { at: 'desc' } });
    expect(asiento.afterState).toMatchObject({ runId: primera.runId, failed: [], chain: 'ok' });
  });

  it('repetir el cierre el mismo día no corre ningún diario ni cambia nada', async () => {
    const c = await cierre();
    if (c.estado === 'OCUPADO') throw new Error('Había otro cierre diario corriendo');
    expect(c.resumen.yaCorrieronHoy).toBe(ORDEN_DIARIO.length);
    expect((await pasos(c.runId)).filter((p) => ORDEN_DIARIO.includes(p.job))).toEqual([]);
    expect(await foto()).toEqual(trasLaPrimera);
    expect(await db().auditLog.count({ where: { organizationId: g.organizationId, action: 'system.daily_run' } })).toBe(1);
  });

  it('forzar el cierre el mismo día los corre todos otra vez y NO duplica nada: cada job es idempotente con datos de verdad', async () => {
    const c = await cierre({ forzar: true });
    if (c.estado === 'OCUPADO') throw new Error('Había otro cierre diario corriendo');
    expect(c.resumen.fallidos).toEqual([]);
    expect(c.resumen.conErrores).toEqual([]);
    const diarios = (await pasos(c.runId)).filter((p) => ORDEN_DIARIO.includes(p.job));
    expect(diarios.map((p) => p.job)).toEqual(ORDEN_DIARIO);
    // Ninguno de los que cambian estados o emiten cuotas encontró nada nuevo que hacer.
    const queCambian = ORDEN_DIARIO.filter((j) => /^(membership|billing|visitpack|payments)\./.test(j) && j !== 'billing.reconcile-balances');
    expect(diarios.filter((p) => queCambian.includes(p.job) && p.processed > 0).map((p) => `${p.job}: ${p.processed}`)).toEqual([]);
    expect(await foto()).toEqual(trasLaPrimera);
  });

  it('al día siguiente vuelve a correr: la que hoy entró en mora con gracia hasta hoy, mañana queda suspendida', async () => {
    ponerReloj('2026-06-11T18:00:00.000Z');
    const c = await cierre();
    if (c.estado === 'OCUPADO') throw new Error('Había otro cierre diario corriendo');
    expect(c.resumen.fallidos).toEqual([]);
    expect(c.resumen.yaCorrieronHoy).toBe(0);
    expect(await estado('cuota vencida')).toBe('SUSPENDED');
    expect(await estado('al corriente')).toBe('ACTIVE');
    const diarios = (await pasos(c.runId)).filter((p) => ORDEN_DIARIO.includes(p.job));
    expect(new Set(diarios.map((p) => p.businessDate.toISOString().slice(0, 10)))).toEqual(new Set(['2026-06-11']));
  });
});
