import {
  accruedInWindow, delinquencyRate, descuadreQueCuenta, monthlyValueOf, money, rankBranches, splitPrepaid,
  type BranchKpi, type DateRange, type Money, type PlanDuration,
} from '@gymflow/core';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { PortfolioRepository } from '../billing/index.js';
import { AnalyticsRepository } from './analytics.repository.js';
import { MovementsRepository } from './movements.repository.js';
import { ExpensesRepository, ajustesPorMes, prorrateoDiario, restaDeLaGanancia, retirosDelDueno } from '../finance/index.js';
import type { RequestContext } from '../../platform/context.js';

/**
 * Tablero del dueño (§20).
 *
 * Todo el módulo existe para separar tres cifras que hoy se confunden en una:
 * lo COBRADO, lo DEVENGADO y lo DIFERIDO. Ver `@gymflow/core/kpi`.
 */

export type Dashboard = {
  range: { from: string; to: string };
  collectedCents: bigint;
  accruedCents: bigint;
  deferredCents: bigint;
  mrrCents: bigint;
  activeMembers: number;
  /** Socios con la cuota vencida o suspendidos, y la base contra la que se miden. */
  membersBehind: number;
  membersBase: number;
  outstandingCents: bigint;
  overdueCents: bigint;
  delinquencyRate: number;
  /** D-18 (bloque 4.4, edición puntual): la deuda dada por perdida, que ya no está en `outstandingCents`. */
  lostCents: bigint;
  lostMembers: number;
  openCashSessions: Array<{
    id: string; branchId: string; registerCode: string;
    openedAt: Date; openingFloatCents: bigint;
  }>;
  branches: BranchKpi[];
  /** Paquetes sin cargo enlazado, valorados por precio de lista. Ver nota. */
  packsValuedByListPrice: number;
  /** Gastos pagados de la caja y FALTANTES de los cortes del periodo (negativo). */
  cashExpensesCents: bigint;
  /** Sobrantes de los cortes (positivo): no suman a la utilidad, se informan «por aclarar» (13-05). */
  cashOverageCents: bigint;
  /** Gastos fijos (renta, nómina) que le tocan al periodo, prorrateados (negativo). */
  fixedExpensesCents: bigint;
  /** UTILIDAD: lo ganado (servicio prestado) menos gastos de caja y fijos. */
  profitCents: bigint;
  /** Retiros del dueño de los meses del periodo (positivo): se informan, no restan (D-23). */
  ownerDrawsCents: bigint;
  /** Costo de lo vendido en la tienda (negativo): la utilidad ya lo resta (D-21). */
  costOfGoodsCents: bigint;
  /** Piezas vendidas de productos sin costo registrado. */
  soldWithoutCost: number;
  /** «Ajustes de ‹mes›» anotados en los meses del periodo (D-22). */
  adjustments: Array<{ month: string; cents: bigint; count: number }>;
  /** El periodo anterior de la misma duración, para comparar. */
  previous: { from: string; to: string; collectedCents: bigint; accruedCents: bigint; profitCents: bigint };
};

type Dinero = {
  cobradoPorSede: Map<string | null, bigint>;
  devengadoPorSede: Map<string | null, bigint>;
  porListaDePrecios: number;
  gastosCaja: bigint;
  sobrantesCaja: bigint;
  gastosFijos: bigint;
  retiros: bigint;
  /** Costo de lo vendido (negativo) y piezas sin costo. */
  costoVendido: bigint;
  sinCosto: number;
  ajustes: Array<{ month: string; cents: bigint; count: number }>;
};

function suma(mapa: Map<string | null, bigint>, clave: string | null, valor: bigint): void {
  mapa.set(clave, (mapa.get(clave) ?? 0n) + valor);
}

export class AnalyticsService {
  /**
   * Fotografía del negocio en una ventana `[desde, hasta)`.
   *
   * La ventana es semiabierta igual que los periodos de facturación, así que
   * dos ventanas consecutivas no cuentan un día dos veces.
   */
  /**
   * `branchIds` null = toda la organización. Si viene, TODO se acota a esas
   * sedes —cobrado, devengado, cartera, cajas—: un gerente de dos sucursales
   * ve las suyas, no el negocio entero.
   */
  async dashboard(ctx: RequestContext, range: DateRange, branchIds: readonly string[] | null = null, comparar: 'periodo' | 'mes' = 'periodo'): Promise<Dashboard> {
    const orgId = ctx.tenant.organizationId;
    const repo = new AnalyticsRepository(orgId);
    const dentro = <T extends { branchId: string | null }>(rows: T[]): T[] =>
      branchIds ? rows.filter((r) => r.branchId !== null && branchIds.includes(r.branchId)) : rows;

    const [dinero, previo, paquetesT, prepagadosT, planesT, sociosT, cajasT, sedesVivas, atrasadosT] = await Promise.all([
      this.dinero(orgId, range, branchIds),
      this.dinero(orgId, anterior(range, comparar), branchIds),
      repo.deferredPacks(),
      repo.prepaidPeriods(range.to),
      repo.liveMemberships(),
      repo.activeMembers(),
      repo.openCashSessions(),
      repo.liveBranchIds(),
      repo.membersBehind(),
    ]);
    const atrasados = dentro(atrasadosT);
    const [paquetes, prepagados, planes, socios, cajas] = [
      dentro(paquetesT), dentro(prepagadosT), dentro(planesT), dentro(sociosT), dentro(cajasT),
    ] as const;
    const { cobradoPorSede, devengadoPorSede, porListaDePrecios } = dinero;

    // Pasivo: dinero cobrado por visitas que todavía no se han prestado.
    let diferido = 0n;
    for (const p of paquetes) {
      const base = p.chargeAmountCents ?? p.planPriceCents;
      if (base === null || p.visitsPurchased <= 0) continue;
      const usadas = Math.min(p.consumedTotal, p.visitsPurchased);
      const caducadas = Math.min(p.expiredTotal, p.visitsPurchased - usadas);
      diferido += splitPrepaid({
        collected: money(base),
        visitsIncluded: p.visitsPurchased,
        visitsConsumed: usadas,
        visitsExpired: caducadas,
      }).deferred.cents;
    }

    // Y los periodos pagados por adelantado: de una anualidad cobrada, lo que
    // falta por prestar después de la ventana también se le debe al socio.
    for (const r of prepagados) {
      diferido += accruedInWindow({
        amount: money(r.amountCents), periodStart: r.periodStart, periodEnd: r.periodEnd,
        window: { from: range.to, to: r.periodEnd },
      }).cents;
    }

    // MRR: valor mensual equivalente de lo que se renueva solo.
    const mrrPorSede = new Map<string | null, bigint>();
    let mrr = 0n;
    for (const r of planes) {
      const mensual = monthlyValueOf(money(r.priceCents), {
        unit: r.durationUnit as PlanDuration['unit'],
        value: r.durationValue,
      });
      if (!mensual) continue;
      const total = mensual.cents * BigInt(r.memberships);
      mrr += total;
      suma(mrrPorSede, r.branchId, total);
    }

    // La cartera al ÚLTIMO día de la ventana: con `range.to` (mañana) lo que
    // vencía hoy ya contaba como vencido y salía "Vencido 100%" (UXB-02).
    const cartera = await this.carteraDe(orgId, new Date(range.to.getTime() - 86_400_000), branchIds);

    const sociosPorSede = new Map<string | null, number>(socios.map((s) => [s.branchId, s.total]));
    const deudaPorSede = new Map<string | null, bigint>(
      cartera.byBranch.map((b) => [b.branchId, b.amountCents]),
    );

    // Solo sucursales VIVAS (y el cajón "sin sucursal"). Una sede archivada
    // con cargos históricos aparecía en el comparativo como si operara: con
    // los datos reales salían 28 sedes donde hay 3.
    const sedes = new Set<string | null>(
      [...cobradoPorSede.keys(), ...devengadoPorSede.keys(),
       ...sociosPorSede.keys(), ...deudaPorSede.keys()]
        .filter((id) => id === null || sedesVivas.has(id)),
    );

    const branches: BranchKpi[] = [...sedes].map((branchId) => ({
      branchId,
      collectedCents: cobradoPorSede.get(branchId) ?? 0n,
      accruedCents: devengadoPorSede.get(branchId) ?? 0n,
      activeMembers: sociosPorSede.get(branchId) ?? 0,
      outstandingCents: deudaPorSede.get(branchId) ?? 0n,
    }));

    const totalCobrado = [...cobradoPorSede.values()].reduce((a, b) => a + b, 0n);
    const totalDevengado = [...devengadoPorSede.values()].reduce((a, b) => a + b, 0n);

    return {
      range: { from: iso(range.from), to: iso(range.to) },
      collectedCents: totalCobrado,
      accruedCents: totalDevengado,
      deferredCents: diferido,
      mrrCents: mrr,
      activeMembers: socios.reduce((a, s) => a + s.total, 0),
      membersBehind: atrasados.reduce((a, s) => a + s.behind, 0),
      membersBase: socios.reduce((a, s) => a + s.total, 0) + atrasados.reduce((a, s) => a + s.suspended, 0),
      outstandingCents: cartera.totalOutstandingCents,
      overdueCents: cartera.overdueCents,
      delinquencyRate: delinquencyRate(cartera.overdueCents, cartera.totalOutstandingCents),
      lostCents: cartera.lostCents,
      lostMembers: cartera.lostMembers,
      openCashSessions: cajas,
      branches: rankBranches(branches),
      packsValuedByListPrice: porListaDePrecios,
      cashExpensesCents: dinero.gastosCaja,
      cashOverageCents: dinero.sobrantesCaja,
      fixedExpensesCents: dinero.gastosFijos,
      // Utilidad = lo ganado − gastos de caja y faltantes − gastos fijos − costo de lo vendido (D-21).
      profitCents: totalDevengado + dinero.gastosCaja + dinero.gastosFijos + dinero.costoVendido,
      ownerDrawsCents: dinero.retiros,
      costOfGoodsCents: dinero.costoVendido,
      soldWithoutCost: dinero.sinCosto,
      adjustments: dinero.ajustes,
      previous: {
        ...(() => { const r = anterior(range, comparar); return { from: iso(r.from), to: iso(r.to) }; })(),
        collectedCents: [...previo.cobradoPorSede.values()].reduce((a, b) => a + b, 0n),
        accruedCents: [...previo.devengadoPorSede.values()].reduce((a, b) => a + b, 0n),
        profitCents: [...previo.devengadoPorSede.values()].reduce((a, b) => a + b, 0n) + previo.gastosCaja + previo.gastosFijos + previo.costoVendido,
      },
    };
  }

  /**
   * El dinero de una ventana: lo que entró (con LA definición de Movimientos),
   * lo ganado (devengado) y los gastos. Se usa para el periodo y para el
   * anterior, así que la comparación cuenta igual en los dos lados.
   */
  private async dinero(orgId: string, range: DateRange, branchIds: readonly string[] | null): Promise<Dinero> {
    const repo = new AnalyticsRepository(orgId);
    const dentro = <T extends { branchId: string | null }>(rows: T[]): T[] =>
      branchIds ? rows.filter((r) => r.branchId !== null && branchIds.includes(r.branchId)) : rows;
    const [movT, inmediatoT, periodosT, visitasT, gastos, costosT] = await Promise.all([
      new MovementsRepository(orgId).porDia(range.from, range.to),
      repo.accruedImmediate(range.from, range.to),
      repo.periodCharges(range.from, range.to),
      repo.visitRecognition(range.from, range.to),
      new ExpensesRepository(orgId).vigentes(range.from, range.to),
      repo.costOfGoodsSold(range.from, range.to),
    ]);
    const [mov, inmediato, periodos, visitas, costos] = [dentro(movT), dentro(inmediatoT), dentro(periodosT), dentro(visitasT), dentro(costosT)] as const;

    // Cobrado = LA definición de "dinero que entró" (BE2-15): la misma suma
    // que Movimientos, sin notas de crédito y con las devoluciones restadas.
    const cobradoPorSede = new Map<string | null, bigint>();
    let gastosCaja = 0n;
    let sobrantesCaja = 0n;
    for (const r of mov) {
      if (r.kind === 'PAYMENT' || r.kind === 'POS_SALE' || r.kind === 'REFUND') suma(cobradoPorSede, r.branchId, BigInt(r.amountCents));
      if (r.kind === 'CASH_EXPENSE') gastosCaja += BigInt(r.amountCents);
      // El descuadre con LA regla de Movimientos, corte por corte (13-05):
      // antes el Tablero lo sumaba con su signo y un sobrante subía la utilidad.
      if (r.kind === 'CASH_VARIANCE') {
        const corte = descuadreQueCuenta(BigInt(r.amountCents));
        gastosCaja += corte.faltanteCents;
        sobrantesCaja += corte.sobranteCents;
      }
    }

    const devengadoPorSede = new Map<string | null, bigint>();
    for (const r of inmediato) suma(devengadoPorSede, r.branchId, r.amountCents);

    // Las cuotas de periodo se devengan por SOLAPE de días, no de golpe: una
    // anualidad cobrada en enero no es ingreso de enero.
    for (const r of periodos) {
      const parte = accruedInWindow({
        amount: money(r.amountCents),
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        window: range,
      });
      suma(devengadoPorSede, r.branchId, parte.cents);
    }

    // Las visitas se devengan al CONSUMIRSE (o al caducar), valoradas por lo
    // que el socio pagó de verdad.
    let porListaDePrecios = 0;
    for (const r of visitas) {
      const base = r.chargeAmountCents ?? r.planPriceCents;
      if (r.chargeAmountCents === null) porListaDePrecios++;
      if (base === null || r.visitsPurchased <= 0) continue;
      const split = splitPrepaid({
        collected: money(base),
        visitsIncluded: r.visitsPurchased,
        visitsConsumed: Math.min(r.consumedInWindow, r.visitsPurchased),
        visitsExpired: Math.min(r.expiredInWindow, r.visitsPurchased - Math.min(r.consumedInWindow, r.visitsPurchased)),
      });
      suma(devengadoPorSede, r.branchId, split.earned.cents + split.expired.cents);
    }

    // El retiro del dueño no es gasto (D-23): se informa aparte y no se prorratea.
    const queRestan = gastos.filter(restaDeLaGanancia);
    const fijos = prorrateoDiario(branchIds === null ? queRestan : queRestan.filter((g) => g.branchId !== null && branchIds.includes(g.branchId)), range.from, range.to);
    const gastosFijos = [...fijos.values()].reduce((a, b) => a + b, 0n);
    return {
      cobradoPorSede, devengadoPorSede, porListaDePrecios, gastosCaja, sobrantesCaja, gastosFijos,
      retiros: retirosDelDueno(gastos, branchIds), ajustes: ajustesPorMes(gastos, branchIds),
      costoVendido: -costos.reduce((a, c) => a + BigInt(c.costCents), 0n), sinCosto: costos.reduce((a, c) => a + c.sinCosto, 0),
    };
  }

  /** La cartera de toda la organización, o la suma de la de cada sede permitida. */
  private async carteraDe(orgId: string, day: Date, branchIds: readonly string[] | null) {
    const repo = new PortfolioRepository(orgId);
    if (!branchIds) return repo.snapshot(day);
    const partes = await Promise.all(branchIds.map((b) => repo.snapshot(day, b)));
    return {
      totalOutstandingCents: partes.reduce((a, p) => a + p.totalOutstandingCents, 0n),
      overdueCents: partes.reduce((a, p) => a + p.overdueCents, 0n),
      lostCents: partes.reduce((a, p) => a + p.lostCents, 0n),
      // Un socio debe en la sede donde se le cobró: sumando sedes puede contarse dos veces si debe en dos.
      lostMembers: partes.reduce((a, p) => a + p.lostMembers, 0),
      byBranch: partes.flatMap((p) => p.byBranch),
    };
  }

  /** Hoy, en la zona de la organización. Es el rango por defecto del tablero. */
  async todayRange(ctx: RequestContext, branchId?: string | null): Promise<DateRange> {
    const hoy = await new BusinessCalendar(ctx.tenant.organizationId).today(branchId ?? null);
    return { from: hoy, to: new Date(hoy.getTime() + 86_400_000) };
  }
}

/**
 * Contra qué se compara (UXD-02). `periodo`: la ventana inmediata anterior,
 * de la misma duración. `mes`: las MISMAS fechas del mes anterior — "1 al 2
 * de octubre" contra "1 al 2 de septiembre", y septiembre completo contra
 * agosto completo —, no los días que van justo antes.
 */
function anterior(range: DateRange, comparar: 'periodo' | 'mes' = 'periodo'): DateRange {
  if (comparar === 'mes') {
    const atras = (d: Date) => {
      const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
      const ultimo = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
      return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), Math.min(d.getUTCDate(), ultimo)));
    };
    return { from: atras(range.from), to: atras(range.to) };
  }
  const largo = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - largo), to: range.from };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type { Money };
