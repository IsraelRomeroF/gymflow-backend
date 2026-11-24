import { conflict, isoDate, mesTerminado, validation, type DateRange } from '@gymflow/core';
import type { CajaDelCierre, MonthlyClose, MonthlyClosePreview, TotalesDelCierre } from '@gymflow/core/contracts';
import type { RequestContext } from '../../platform/context.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { ExpensesRepository } from './expenses.repository.js';
import { monthFigures, type CifrasDeCaja, type CifrasDelMes, type MonthFigures } from './month-figures.js';
import { MonthlyCloseRepository, type MonthlyCloseRecord } from './monthly-close.repository.js';

/** Hoy en el gimnasio y en cada sede, según el servidor (A3 T9). */
export type FechasDeNegocio = MonthlyClosePreview['businessDates'];
type FechasConNombres = FechasDeNegocio & { nombres: Map<string, string> };

const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Hasta cuántos meses atrás se ofrece cerrar un mes que quedó abierto (14-04). */
const MESES_ATRAS = 12;

const NOMBRE_DE_MES = new Intl.DateTimeFormat('es-MX', { month: 'long', timeZone: 'UTC' });
const nombreDeMes = (mes: string) => NOMBRE_DE_MES.format(new Date(`${mes}-15T12:00:00.000Z`));
/** «octubre de 2026» (o «Octubre de 2026» para empezar una frase). */
export const mesLargo = (mes: string, mayuscula = false): string => {
  const n = nombreDeMes(mes);
  return `${mayuscula ? n.charAt(0).toUpperCase() + n.slice(1) : n} de ${mes.slice(0, 4)}`;
};
/** El texto del bloqueo por cajas abiertas con fecha de ese mes (D-22). */
const cajasAbiertas = (n: number): string => (n === 1
  ? 'Hay una caja abierta con fecha de ese mes: haz su corte antes de cerrar, para que entre en la foto.'
  : `Hay ${n} cajas abiertas con fecha de ese mes: haz sus cortes antes de cerrar, para que entren en la foto.`);
const diaLargo = (fecha: string) => new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${fecha}T12:00:00.000Z`));

/**
 * ¿Terminó el mes en todas las sedes? Si no, por qué (para decirlo): la regla
 * es `mesTerminado` del núcleo; aquí solo se arma el texto. `nombres` son los
 * de las sucursales por id.
 */
export function mesTerminadoEnTodasLasSedes(month: string, fechas: FechasDeNegocio & { nombres: ReadonlyMap<string, string> }): { ok: true } | { ok: false; message: string } {
  if (mesTerminado(month, [fechas.organization, ...fechas.byBranch.map((b) => b.date)])) return { ok: true };
  // En el gimnasio ya terminó pero alguna sede va un día atrás (otra zona).
  const rezagada = mesTerminado(month, [fechas.organization]) ? fechas.byBranch.find((b) => !mesTerminado(month, [b.date])) : undefined;
  if (rezagada) {
    const mes = nombreDeMes(month);
    return { ok: false, message: `${mes.charAt(0).toUpperCase()}${mes.slice(1)} todavía no termina en ${fechas.nombres.get(rezagada.branchId) ?? 'una sucursal'}: allá es ${diaLargo(rezagada.date)}. Se podrá cerrar en cuanto cambie el día.` };
  }
  return { ok: false, message: 'Solo se cierra un mes que ya terminó' };
}

/**
 * CIERRE DE MES (fase 4; auditoría 8, bloque 1.9, hallazgos 13-01, 13-19,
 * 14-04). Tres cosas que antes vivían sueltas en la ruta:
 *
 * 1. CUÁNDO se puede cerrar: cuando el mes terminó en TODAS las sedes
 *    (`mesTerminado`, la misma regla que usa el botón del Tablero). Con
 *    Frontera en Tijuana, a las 23:00 del 31 en la Ciudad de México allá
 *    todavía es 31 y un cobro de ese mes puede estar por entrar.
 * 2. QUÉ va a pasar (`vistaPrevia`): bloqueos, avisos y las cifras que
 *    quedarían congeladas, antes de pedir la firma.
 * 3. El cierre mismo: la foto y su asiento en la bitácora se confirman JUNTOS
 *    (13-19). Antes, si fallaba el asiento quedaba un mes cerrado sin rastro.
 *
 * Fase 3, bloque 3.7:
 *  - D-22 · Las cifras quedan FIJAS. No se cierra con una caja abierta de ese
 *    mes (bloqueo, antes aviso); la foto es completa (Tablero y Movimientos,
 *    total y por sucursal, `version: 2`) y el Tablero y Movimientos de un mes
 *    cerrado se sirven de ella; lo que llega tarde se anota en el mes en
 *    curso como «ajuste de ‹mes›» (`expenses.routes.ts`, `assertOpen`).
 *  - D-23 · Sin un gerente que administre, la dueña cierra el mes con su
 *    contraseña (la ruta la comprueba); queda en la bitácora que cerró sola.
 */
export class MonthlyCloseService {
  private readonly audit = new AuditService();

  /** La ventana `[1.º del mes, 1.º del siguiente)` de un mes `AAAA-MM`. */
  rangoDelMes(month: string): DateRange {
    if (!MES.test(month)) throw validation('Mes como AAAA-MM');
    const from = new Date(`${month}-01T00:00:00.000Z`);
    return { from, to: new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)) };
  }

  /** Hoy en el gimnasio y en cada sede abierta: con eso se decide si el mes terminó. */
  async fechasDeNegocio(ctx: RequestContext): Promise<FechasConNombres> {
    const orgId = ctx.tenant.organizationId;
    const cal = new BusinessCalendar(orgId);
    const sedes = await new MonthlyCloseRepository(orgId).sedesVivas();
    const [organization, ...porSede] = await Promise.all([
      cal.today(null).then(isoDate),
      ...sedes.map((s) => cal.today(s.id).then((d) => ({ branchId: s.id, date: isoDate(d) }))),
    ]);
    return { organization: organization as string, byBranch: porSede as FechasDeNegocio['byBranch'], nombres: new Map(sedes.map((s) => [s.id, s.name])) };
  }

  /** Revienta si ese mes no se puede cerrar: no terminó en todas las sedes (422) o ya está cerrado (409). */
  async comprobar(ctx: RequestContext, month: string): Promise<void> {
    const { from } = this.rangoDelMes(month);
    const fin = mesTerminadoEnTodasLasSedes(month, await this.fechasDeNegocio(ctx));
    if (!fin.ok) throw validation(fin.message);
    const repo = new MonthlyCloseRepository(ctx.tenant.organizationId);
    if (await repo.find(from)) throw conflict('Ese mes ya está cerrado', 'MONTH_ALREADY_CLOSED');
    // D-22: con una caja de ese mes abierta, su corte quedaría fuera de la foto.
    const cajas = await repo.cajasAbiertasDelMes(from, this.rangoDelMes(month).to);
    if (cajas.length > 0) throw conflict(cajasAbiertas(cajas.length), 'MONTH_HAS_OPEN_CASH');
  }

  /**
   * ¿Está abierto el mes de esa fecha de negocio? Revienta con 409
   * `MONTH_CLOSED` si ya se cerró (D-22). Para lo que otros módulos quieran
   * impedir con fecha en un mes cerrado; lo tardío se anota en el mes en curso.
   */
  async assertOpen(organizationId: string, fecha: Date): Promise<void> {
    const cierre = await new MonthlyCloseRepository(organizationId).cierreDe(fecha);
    if (!cierre) return;
    const mes = cierre.month.toISOString().slice(0, 7);
    throw conflict(`${mesLargo(mes, true)} ya está cerrado y sus cifras no cambian. Anótalo en el mes en curso como «ajuste de ${mesLargo(mes)}».`, 'MONTH_CLOSED');
  }

  /** Lo que va a pasar al cerrar ese mes: bloqueos, avisos y la foto que quedaría. */
  async vistaPrevia(ctx: RequestContext, month: string, signature: MonthlyClosePreview['signature'] = 'approver'): Promise<MonthlyClosePreview> {
    const orgId = ctx.tenant.organizationId;
    const { from, to } = this.rangoDelMes(month);
    const repo = new MonthlyCloseRepository(orgId);
    const [fechas, cerrado, cajas, gastos, cifras] = await Promise.all([
      this.fechasDeNegocio(ctx),
      repo.find(from),
      repo.cajasAbiertasDelMes(from, to),
      new ExpensesRepository(orgId).vigentes(from, to),
      monthFigures(ctx, { from, to }),
    ]);
    const fijos = gastos.filter((g) => g.periodMonth.getTime() === from.getTime());

    const blockers: MonthlyClosePreview['blockers'] = [];
    const warnings: MonthlyClosePreview['warnings'] = [];
    const fin = mesTerminadoEnTodasLasSedes(month, fechas);
    if (!fin.ok) blockers.push({ code: 'MONTH_NOT_ENDED', message: fin.message });
    if (cerrado) blockers.push({ code: 'ALREADY_CLOSED', message: 'Ese mes ya está cerrado' });
    // D-22: una caja de ese mes abierta IMPIDE cerrar (hasta la fase 2 solo avisaba). Con el mes
    // todavía en curso no se dice: tener cajas abiertas es lo normal y el bloqueo que cuenta es el otro.
    if (fin.ok && cajas.length > 0) blockers.push({ code: 'OPEN_CASH_SESSIONS', message: cajasAbiertas(cajas.length) });
    if (fijos.length === 0) warnings.push({ code: 'NO_FIXED_EXPENSES', message: 'No hay gastos fijos registrados en ese mes (renta, nómina): la utilidad sale sin ellos.' });

    const { nombres: _n, ...businessDates } = fechas;
    return {
      month,
      closable: blockers.length === 0,
      blockers,
      warnings,
      closed: cerrado ? await this.conNombres(repo, [cerrado]).then((xs) => xs[0]!) : null,
      totals: totales(cifras),
      byBranch: porSede(cifras),
      businessDates,
      openCashSessions: cajas.map((c) => ({ id: c.id, branchId: c.branchId, registerCode: c.registerCode, openedAt: c.openedAt.toISOString() })),
      fixedExpensesCount: fijos.length,
      signature,
    };
  }

  /**
   * Cierra el mes: comprueba que terminó en todas las sedes y que no está
   * cerrado, toma la foto y la escribe CON su asiento de bitácora en una
   * transacción. `aprobador` es quien firmó (ya verificado por la ruta), o
   * null cuando cierra el dueño con su contraseña (D-23).
   */
  async cerrar(ctx: RequestContext, input: { month: string; reason: string; note: string | null; aprobador: string | null; conContrasenaPropia?: boolean }): Promise<MonthlyClose> {
    const orgId = ctx.tenant.organizationId;
    const { from, to } = this.rangoDelMes(input.month);
    const repo = new MonthlyCloseRepository(orgId);
    await this.comprobar(ctx, input.month);

    // La foto se calcula fuera de la transacción (son lecturas); lo que se
    // confirma junto es la fila y su asiento (13-19).
    const cifras = await monthFigures(ctx, { from, to });
    const totals = totales(cifras);
    const byBranch = porSede(cifras);
    const fila = await enUnaTransaccion(async () => {
      const c = await repo.create({ month: from, totals, byBranch, closedByUserId: ctx.tenant.actorUserId!, approvedByUserId: input.aprobador, note: input.note });
      await this.audit.record(ctx, {
        action: 'report.month.close', resourceType: 'MonthlyClose', resourceId: c.id, reason: input.reason, approvedByUserId: input.aprobador,
        // La foto completa no cabe en un asiento: van las cifras de siempre.
        afterState: { month: input.month, ...cifrasDelAsiento(totals), ...(input.conContrasenaPropia ? { ownerClosedAlone: true } : {}) },
      });
      return c;
    });
    return (await this.conNombres(repo, [fila]))[0]!;
  }

  /** Los meses cerrados con quién cerró y quién firmó, y los terminados que siguen sin cerrar (14-04). */
  async lista(ctx: RequestContext): Promise<{ closes: MonthlyClose[]; pending: string[] }> {
    const orgId = ctx.tenant.organizationId;
    const repo = new MonthlyCloseRepository(orgId);
    const [filas, fechas, primero] = await Promise.all([repo.list(), this.fechasDeNegocio(ctx), repo.primerMesConMovimiento()]);
    const closes = await this.conNombres(repo, filas);
    const cerrados = new Set(closes.map((c) => c.month));
    const pending: string[] = [];
    if (primero) {
      // Desde el primer mes con dinero (o hace 12 meses, lo que sea más
      // reciente) hasta el último mes que ya terminó en todas las sedes.
      const hoy = fechas.organization;
      const piso = new Date(Date.UTC(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)) - 1 - MESES_ATRAS, 1));
      let m = new Date(Math.max(primero.getTime(), piso.getTime()));
      for (let i = 0; i <= MESES_ATRAS + 1; i++) {
        const mes = m.toISOString().slice(0, 7);
        if (!mesTerminado(mes, [fechas.organization, ...fechas.byBranch.map((b) => b.date)])) break;
        if (!cerrados.has(mes)) pending.push(mes);
        m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
      }
    }
    return { closes, pending };
  }

  private async conNombres(repo: MonthlyCloseRepository, filas: readonly MonthlyCloseRecord[]): Promise<MonthlyClose[]> {
    const nombres = await repo.nombres(filas.flatMap((c) => [c.closedByUserId, ...(c.approvedByUserId ? [c.approvedByUserId] : [])]));
    return filas.map((c) => ({
      id: c.id,
      month: c.month.toISOString().slice(0, 7),
      totals: c.totals,
      byBranch: c.byBranch,
      closedAt: c.closedAt.toISOString(),
      closedByUserId: c.closedByUserId,
      closedByName: nombres.get(c.closedByUserId) ?? null,
      approvedByUserId: c.approvedByUserId,
      approvedByName: c.approvedByUserId ? nombres.get(c.approvedByUserId) ?? null : null,
      note: c.note,
    }));
  }
}

const texto = (v: bigint): string => v.toString();

function caja(c: CifrasDeCaja): CajaDelCierre {
  return {
    incomeCents: texto(c.incomeCents), refundsCents: texto(c.refundsCents), expensesCents: texto(c.expensesCents),
    shortageCents: texto(c.shortageCents), overageCents: texto(c.overageCents), netCents: texto(c.netCents), toBankCents: texto(c.toBankCents),
    creditNotesCents: texto(c.creditNotesCents), fixedExpensesCents: texto(c.fixedExpensesCents), profitCents: texto(c.profitCents),
    byMethod: Object.fromEntries(Object.entries(c.byMethod).map(([k, v]) => [k, texto(v)])),
  };
}

/** Todo lo de un alcance (el gimnasio o una sucursal), en centavos como texto (ADR-005). */
function completa(d: CifrasDelMes) {
  return {
    collectedCents: texto(d.collectedCents), accruedCents: texto(d.accruedCents), deferredCents: texto(d.deferredCents),
    mrrCents: texto(d.mrrCents), outstandingCents: texto(d.outstandingCents), overdueCents: texto(d.overdueCents), activeMembers: d.activeMembers,
    cashExpensesCents: texto(d.cashExpensesCents), fixedExpensesCents: texto(d.fixedExpensesCents), profitCents: texto(d.profitCents),
    cashOverageCents: texto(d.cashOverageCents), ownerDrawsCents: texto(d.ownerDrawsCents), costOfGoodsCents: texto(d.costOfGoodsCents),
    membersBehind: d.membersBehind, membersBase: d.membersBase, cash: caja(d.cash),
  };
}

/** La foto de toda la organización. `version: 2` = completa (3.7): Tablero y Movimientos. */
function totales(d: MonthFigures): TotalesDelCierre {
  return { ...completa(d), version: 2 };
}

function porSede(d: MonthFigures): MonthlyClose['byBranch'] {
  return d.branches.map((b) => ({
    branchId: b.branchId, collectedCents: texto(b.collectedCents), accruedCents: texto(b.accruedCents),
    outstandingCents: texto(b.outstandingCents), activeMembers: b.activeMembers,
    ...(b.completa ? completa(b.completa) : {}),
  }));
}

/** Las cifras del total que van al asiento de bitácora (sin el detalle de caja). */
function cifrasDelAsiento(t: TotalesDelCierre) {
  const { cash: _caja, version: _v, ...resto } = t;
  return resto;
}
