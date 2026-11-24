import { OrganizationRepository } from '../organization/index.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { PulseRepository, type Conteo, type PorSede } from './pulse.repository.js';
import { MovementsService } from './movements.service.js';
import { AnalyticsService } from './analytics.service.js';
import { TrialPassRepository } from '../billing/index.js';
import type { RequestContext } from '../../platform/context.js';

const HORA = 3_600_000;
const DIA = 24 * HORA;

/** Cuántos minutos va la zona por delante (o detrás) de UTC en ese instante. */
function desfase(zona: string, instante: Date): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zona, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instante).map((x) => [x.type, x.value]));
  const comoUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return Math.round((comoUtc - instante.getTime()) / 60_000);
}

/** Medianoche local del día de `instante`, como instante. */
export function medianoche(zona: string, instante: Date): Date {
  const local = new Date(instante.getTime() + desfase(zona, instante) * 60_000);
  const dia = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(dia - desfase(zona, new Date(dia)) * 60_000);
}

const fecha = (d: Date) => d.toISOString().slice(0, 10);
/**
 * La fecha más vieja de una lista. `.sort()` a secas ordena los `Date` como
 * TEXTO («Fri Nov…» antes que «Thu Oct…»), así que la «más vieja» podía ser
 * cualquiera (1.1 §7, defecto 5).
 */
export const masVieja = (fechas: readonly Date[]): Date | null =>
  fechas.reduce<Date | null>((min, f) => (min === null || f.getTime() < min.getTime() ? f : min), null);
const sumar = (filas: readonly PorSede[], sedes: readonly string[] | null) =>
  filas.filter((f) => sedes === null || (f.branchId !== null && sedes.includes(f.branchId))).reduce((a, f) => a + BigInt(f.cents), 0n);
const contar = (filas: readonly Conteo[], sedes: readonly string[] | null) =>
  filas.filter((f) => sedes === null || (f.branchId !== null && sedes.includes(f.branchId))).reduce((a, f) => a + f.total, 0);

/**
 * EL PULSO DE LA DUEÑA (UXD-01): en una sola llamada, lo que ella pregunta
 * al abrir el teléfono — cómo va hoy, cuánto lleva ganado este mes y si hay
 * algo que la deba preocupar.
 *
 * Las comparaciones son honestas (UXD-02): hoy HASTA ESTA HORA contra ayer
 * hasta la misma hora y contra el mismo día de la semana pasada; el mes a la
 * fecha contra el mes pasado al mismo día.
 */
export class PulseService {
  async pulso(ctx: RequestContext, sedes: readonly string[] | null, ahora = new Date()) {
    const orgId = ctx.tenant.organizationId;
    const repo = new PulseRepository(orgId);
    const zona = await new OrganizationRepository(orgId).effectiveTimezone(null);

    const hoy = medianoche(zona, ahora);
    const transcurrido = ahora.getTime() - hoy.getTime();
    const ayer = new Date(hoy.getTime() - DIA);
    const semanaPasada = new Date(hoy.getTime() - 7 * DIA);

    // Fechas de negocio (los reportes por día usan fechas, no instantes).
    const local = new Date(ahora.getTime() + desfase(zona, ahora) * 60_000);
    const hoyFecha = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
    const inicioMes = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1));
    const manana = new Date(hoyFecha.getTime() + DIA);
    const inicioMesPasado = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1));
    const diasDelMes = Math.round((manana.getTime() - inicioMes.getTime()) / DIA);
    const finMesPasado = inicioMes;
    const mismoDiaMesPasado = new Date(Math.min(inicioMesPasado.getTime() + diasDelMes * DIA, finMesPasado.getTime()));

    const movimientos = new MovementsService();
    const [
      entroHoy, entroAyer, entroSemana, horasHoy, horasSemana,
      visitasHoy, visitasAyer, altasHoy, altasMes, bajasMes, mora,
      cortes, cajas, devoluciones, firmas, mes, mesPasado, mesPasadoTodo, tablero, sensibles,
      puertas, ultimas, horarioCaja, equipo, pasesDePrueba, sinRostro,
    ] = await Promise.all([
      repo.entroEntre(hoy, ahora),
      repo.entroEntre(ayer, new Date(ayer.getTime() + transcurrido)),
      repo.entroEntre(semanaPasada, new Date(semanaPasada.getTime() + transcurrido)),
      repo.entroPorHora(hoy, ahora, zona),
      repo.entroPorHora(semanaPasada, new Date(semanaPasada.getTime() + DIA), zona),
      repo.entradas(hoy, ahora),
      repo.entradas(ayer, new Date(ayer.getTime() + transcurrido)),
      repo.altas(hoyFecha, manana),
      repo.altas(inicioMes, manana),
      repo.bajas(inicioMes, manana),
      repo.enMora(),
      repo.cortesConFaltante(new Date(ahora.getTime() - 7 * DIA)),
      repo.cajasAbiertas(),
      repo.devoluciones(hoy, ahora),
      repo.firmasPendientes(),
      movimientos.resumen(orgId, inicioMes, manana, sedes),
      movimientos.resumen(orgId, inicioMesPasado, mismoDiaMesPasado, sedes),
      movimientos.resumen(orgId, inicioMesPasado, finMesPasado, sedes),
      new AnalyticsService().dashboard(ctx, { from: hoyFecha, to: manana }, sedes),
      // «Sensibles hoy» ES «Para revisar» de la Bitácora (2.13): la misma regla
      // (`auditNeedsReview` del núcleo, dicha en SQL por `review: true`), no una
      // lista propia. Antes eran 13 acciones escritas aquí y las dos pantallas
      // no contaban lo mismo.
      new AuditService().list(orgId, { limit: 200, branchIds: sedes, from: hoy, to: ahora, review: true }),
      repo.puertas(hoy, ahora),
      repo.ultimasEntradas(hoy, ahora),
      repo.horarioDeCaja(hoy, ahora),
      repo.equipo(hoy, ahora),
      // Pases de prueba del mes (D-08) y entradas autorizadas sin rostro de los últimos 7 días (D-06): 3.12.
      Promise.all((sedes ?? [null]).map((s) => new TrialPassRepository(orgId).contar(s, inicioMes, manana))),
      new AuditService().withoutFaceSummary(orgId, { branchIds: sedes, from: new Date(hoy.getTime() - 6 * DIA), to: ahora }),
    ]);

    const enSede = <T extends { branchId: string | null }>(xs: readonly T[]) => xs.filter((x) => sedes === null || (x.branchId !== null && sedes.includes(x.branchId)));
    const porHora = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      cents: enSede(horasHoy).filter((x) => Number(x.hora) === h).reduce((a, x) => a + BigInt(x.cents), 0n),
      lastWeekCents: enSede(horasSemana).filter((x) => Number(x.hora) === h).reduce((a, x) => a + BigInt(x.cents), 0n),
    }));
    const sedesVistas = new Set<string>([...tablero.branches.map((b) => b.branchId), ...enSede(entroHoy).map((x) => x.branchId)].filter((x): x is string => !!x));
    const devs = enSede(devoluciones);

    return {
      asOf: ahora,
      timezone: zona,
      today: {
        collectedCents: sumar(entroHoy, sedes),
        yesterdaySameTimeCents: sumar(entroAyer, sedes),
        lastWeekSameTimeCents: sumar(entroSemana, sedes),
        byHour: porHora,
        visits: contar(visitasHoy, sedes),
        visitsYesterdaySameTime: contar(visitasAyer, sedes),
        newMembers: contar(altasHoy, sedes),
      },
      month: {
        from: fecha(inicioMes), to: fecha(hoyFecha),
        profitCents: mes.totals.profitCents,
        incomeCents: mes.totals.incomeCents + mes.totals.refundsCents,
        // La misma suma que la tarjeta «Gastos» de Movimientos: gastos, FALTANTES
        // de los cortes y fijos. Un sobrante no paga un faltante (14-09).
        expensesCents: mes.totals.expensesCents + mes.totals.shortageCents + mes.totals.fixedExpensesCents,
        /** Sobrantes de caja del mes: no suman, se informan «por aclarar». */
        cashOverageCents: mes.totals.overageCents,
        /** Aparte, para avisar cuando falta registrar renta y nómina (UX5-D-05). */
        fixedExpensesCents: mes.totals.fixedExpensesCents,
        lastMonthSameDayProfitCents: mesPasado.totals.profitCents,
        lastMonthTotalProfitCents: mesPasadoTodo.totals.profitCents,
        newMembers: contar(altasMes, sedes),
        leftMembers: contar(bajasMes, sedes),
        trialPasses: pasesDePrueba.reduce((a, n) => a + n, 0),
      },
      alerts: {
        shortCounts: enSede(cortes).map((c) => ({ ...c, closedAt: c.closedAt })),
        refundsToday: { count: devs.reduce((a, d) => a + d.total, 0), cents: devs.reduce((a, d) => a + BigInt(d.cents), 0n) },
        cashOpenSinceYesterday: enSede(cajas).filter((c) => c.openedAt < hoy),
        pendingApprovals: { count: enSede(firmas).reduce((a, f) => a + f.total, 0), oldest: masVieja(enSede(firmas).map((f) => f.desde)) },
        sensitiveToday: sensibles.length,
        entriesWithoutFace7d: sinRostro.reduce((a, f) => a + f.count, 0),
      },
      owed: {
        overdueCents: tablero.overdueCents,
        outstandingCents: tablero.outstandingCents,
        membersBehind: contar(mora, sedes),
        // La deuda por sucursal, en cifras y sin nombres (D-25): la cartera del
        // Tablero (sede de casa del socio) y los atrasados de cada sede.
        byBranch: tablero.branches
          .map((b) => ({ branchId: b.branchId, outstandingCents: b.outstandingCents, membersBehind: contar(mora.filter((m) => m.branchId === b.branchId), null) }))
          .filter((b) => b.outstandingCents > 0n || b.membersBehind > 0),
      },
      // `base` = los vivos más los suspendidos: la misma base que el Tablero para "N de M atrasados".
      members: { active: tablero.activeMembers, base: tablero.membersBase },
      branches: [...sedesVistas].map((branchId) => ({
        branchId,
        todayCents: sumar(entroHoy.filter((x) => x.branchId === branchId), null),
        yesterdaySameTimeCents: sumar(entroAyer.filter((x) => x.branchId === branchId), null),
        visits: contar(visitasHoy.filter((x) => x.branchId === branchId), null),
      })),
      openCash: enSede(cajas),
      // A qué hora abrió cada sede y hasta cuándo hubo movimiento, y quién
      // entró hace un momento: "el flujo de mi gimnasio" visto desde el teléfono.
      doors: enSede(puertas).map((p) => {
        const caja = horarioCaja.find((c) => c.branchId === p.branchId);
        return { branchId: p.branchId, firstEntryAt: p.firstAt, lastEntryAt: p.lastAt, entries: p.total, cashOpenedAt: caja?.openedAt ?? null, cashClosedAt: caja?.closedAt ?? null };
      }),
      recentEntries: enSede(ultimas),
      // Su equipo hoy (ADR-039): quién entró al panel, qué hizo y cuánto cobró,
      // sin un solo expediente de socio. Quien abarca todo el gimnasio sale siempre.
      staff: [...equipo].sort((a, b) => (b.lastActionAt?.getTime() ?? 0) - (a.lastActionAt?.getTime() ?? 0) || a.fullName.localeCompare(b.fullName)).filter((e) => sedes === null || e.branchId === null || sedes.includes(e.branchId)).map((e) => ({
        userId: e.userId, fullName: e.fullName, roleKey: e.roleKey, roleName: e.roleName, branchId: e.branchId,
        lastLoginAt: e.lastLoginAt, lastActionAt: e.lastActionAt, actionsToday: e.actionsToday, paymentsToday: e.paymentsToday, manualEntriesToday: e.entriesToday,
        openCash: cajas.some((c) => c.openedByUserId === e.userId),
      })),
    };
  }
}
