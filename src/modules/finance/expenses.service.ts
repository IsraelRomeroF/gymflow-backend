import { conflict, isoDate, notFound, validation } from '@gymflow/core';
import type { FrecuenciaDeGasto, RecurringExpenseList } from '@gymflow/core/contracts';
import type { RequestContext } from '../../platform/context.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { ExpensesRepository, NOMINA, RETIRO_DEL_DUENO, type Gasto } from './expenses.repository.js';
import { MonthlyCloseRepository } from './monthly-close.repository.js';
import { mesLargo } from './monthly-close.service.js';
import { RecurringExpensesRepository, type Recurrente } from './recurring.repository.js';
import { propuestasDelMes } from './propuestas.js';
import { esVencimiento, primerVencimiento } from './recurrentes.js';

const aMes = (d: Date) => d.toISOString().slice(0, 7);
const dia1 = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const fecha = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const esUnicidad = (e: unknown) => (e as { code?: unknown } | null)?.code === 'P2002';

/** A quién: una persona del personal (`payeeUserId`) o un nombre escrito a mano. */
export type AQuien = { payeeUserId?: string | null | undefined; payeeName?: string | null | undefined };

export type NuevoGasto = AQuien & {
  category: string;
  /** En la nómina es una nota opcional; en lo demás, de qué es el gasto. */
  description?: string | undefined;
  amountCents: bigint;
  /** `AAAA-MM`. En un pago de nómina sale de su fecha. */
  month?: string | undefined;
  branchId: string | null;
  /** El mes está cerrado: anótalo en el mes en curso como «ajuste de ‹mes›» (D-22). */
  asAdjustment?: boolean | undefined;
  /** La fecha del pago (`AAAA-MM-DD`): obligatoria en la nómina, y solo en ella. */
  paidOn?: string | undefined;
  /** Además, que se proponga cada periodo «por confirmar». */
  repeat?: FrecuenciaDeGasto | undefined;
};

const NOTA_DE_NOMINA = 'Pago de nómina';
const propuestaResuelta = () => conflict('Esa propuesta ya se confirmó o se descartó', 'EXPENSE_PROPOSAL_RESOLVED');

/**
 * GASTOS DEL GIMNASIO (bloque 4.5, D-26). Lo que antes vivía en la ruta, más:
 *
 *  - LA NÓMINA SE ANOTA POR PAGO: fecha, a quién y cuánto. El pago cuenta en
 *    el mes de su fecha, repartido por día como cualquier gasto del mes (no
 *    cambia ninguna regla de cifras, D-24). Un pago con fecha en un mes
 *    cerrado es un «ajuste de ‹mes›» en el mes en curso (D-22).
 *  - LO QUE SE REPITE SE PROPONE, no se anota: una plantilla
 *    (`recurring_expenses`) dice qué toca y cada cuánto; cada vencimiento es
 *    una propuesta «por confirmar» que se CALCULA al consultar. Alguien la
 *    confirma (nace el gasto, con el importe que diga), o la descarta. Lo no
 *    confirmado no es una fila de gasto: ninguna cifra puede contarlo.
 *
 * Quién: `expenses:manage` anota (la ruta lo comprueba con la sede del
 * gasto). La bitácora dice que hubo un pago de nómina y de cuánto, no a
 * quién: eso se ve en Movimientos, con `expenses:payroll:read`.
 */
export class ExpensesService {
  private readonly audit = new AuditService();

  /** Hoy en el gimnasio (su fecha de negocio, no la del servidor). */
  async hoy(organizationId: string): Promise<Date> {
    return new BusinessCalendar(organizationId).today(null);
  }

  /** A quién se le paga: la persona del personal de ESTE gimnasio, o el nombre escrito. */
  private async aQuien(organizationId: string, a: AQuien): Promise<{ payeeUserId: string | null; payeeName: string }> {
    const nombre = a.payeeName?.trim() ?? '';
    if (a.payeeUserId) {
      if (nombre) throw validation('Elige a la persona del personal o escribe su nombre, no las dos cosas');
      const [persona] = await new RecurringExpensesRepository(organizationId).personal([a.payeeUserId]);
      if (!persona) throw notFound('Esa persona no es del personal de este gimnasio');
      return { payeeUserId: persona.id, payeeName: persona.name };
    }
    if (nombre.length < 2) throw validation('Di a quién se le pagó: elige a la persona o escribe su nombre');
    return { payeeUserId: null, payeeName: nombre };
  }

  /** Lo que se guarda de un gasto según su tipo: la nómina con fecha y persona; lo demás, sin ellas. */
  private async normalizar(organizationId: string, e: NuevoGasto, hoy: Date) {
    if (e.category !== NOMINA) {
      if (e.paidOn || e.payeeUserId || e.payeeName) throw validation('La fecha del pago y a quién solo van en la nómina');
      const description = e.description?.trim() ?? '';
      if (description.length < 3) throw validation('Describe el gasto (al menos 3 letras)');
      if (!e.month) throw validation('Falta el mes del gasto');
      return { description, delMes: fecha(`${e.month}-01`), paidOn: null, payeeUserId: null, payeeName: null };
    }
    if (!e.paidOn) throw validation('La nómina se anota por pago: di la fecha, a quién y cuánto');
    const paidOn = fecha(e.paidOn);
    if (paidOn.getTime() > hoy.getTime()) throw validation('La fecha del pago no puede ser posterior a hoy');
    if (e.month && e.month !== e.paidOn.slice(0, 7)) throw validation('El pago cuenta en el mes de su fecha');
    const quien = await this.aQuien(organizationId, e);
    return { description: e.description?.trim() || NOTA_DE_NOMINA, delMes: dia1(paidOn), paidOn, ...quien };
  }

  /**
   * Anota un gasto (o un pago de nómina, o un retiro del dueño). Si su mes
   * está cerrado responde 409 `MONTH_CLOSED`; con `asAdjustment` lo anota en
   * el mes en curso como ajuste. `propuesta`: sale de confirmar un gasto que
   * se repite.
   */
  async anotar(ctx: RequestContext, e: NuevoGasto, propuesta?: { recurrente: Recurrente; dueOn: Date; keepAmount: boolean }): Promise<Gasto> {
    const orgId = ctx.tenant.organizationId;
    const hoy = await this.hoy(orgId);
    const n = await this.normalizar(orgId, e, hoy);
    if (e.repeat) {
      if (e.category === RETIRO_DEL_DUENO) throw validation('El retiro del dueño no es un gasto: no se propone solo');
      if (e.category !== NOMINA && e.repeat !== 'MONTHLY') throw validation('Ese gasto se repite cada mes; cada semana o cada quincena es para la nómina');
      // Desde un mes pasado propondría de golpe todo lo que «tocaba» desde entonces.
      if ((n.paidOn ?? n.delMes).getTime() < dia1(hoy).getTime()) throw validation('Lo que se repite empieza a proponerse desde este mes: registra este gasto sin «Se repite»');
    }

    const mes = aMes(n.delMes);
    const cierre = await new MonthlyCloseRepository(orgId).find(n.delMes);
    if (cierre && !e.asAdjustment) {
      throw conflict(`${mesLargo(mes, true)} ya está cerrado y sus cifras no cambian. Anótalo en el mes en curso como «ajuste de ${mesLargo(mes)}».`, 'MONTH_CLOSED');
    }
    if (!cierre && e.asAdjustment) throw validation('Ese mes sigue abierto: el gasto se anota en él, no como ajuste');
    if (cierre && e.repeat) throw validation('Un ajuste de un mes cerrado no se repite: deja el gasto que se repite desde el mes en curso');
    const periodMonth = cierre ? dia1(hoy) : n.delMes;
    const actor = ctx.tenant.actorUserId!;

    try {
      return await enUnaTransaccion(async () => {
        const recurrentes = new RecurringExpensesRepository(orgId);
        let enlace = propuesta ? { recurringId: propuesta.recurrente.id, recurringDue: propuesta.dueOn } : null;
        if (e.repeat) {
          // Empieza con este gasto: su primer vencimiento queda confirmado por él.
          const startsOn = n.paidOn ?? n.delMes;
          const nuevo = await recurrentes.create({
            branchId: e.branchId, category: e.category, description: n.description, amountCents: e.amountCents, frequency: e.repeat, startsOn,
            payeeUserId: n.payeeUserId, payeeName: n.payeeName, createdByUserId: actor,
          });
          await this.audit.record(ctx, {
            action: 'expense.recurring.create', resourceType: 'RecurringExpense', resourceId: nuevo.id, branchId: e.branchId, reason: n.description,
            afterState: { category: e.category, amountCents: e.amountCents.toString(), frequency: e.repeat, startsOn: isoDate(startsOn) },
          });
          enlace = { recurringId: nuevo.id, recurringDue: primerVencimiento(e.repeat, startsOn) };
        }
        const gasto = await new ExpensesRepository(orgId).create({
          branchId: e.branchId, category: e.category, description: n.description, amountCents: e.amountCents,
          periodMonth, createdByUserId: actor, adjustsMonth: cierre ? n.delMes : null,
          paidOn: n.paidOn, payeeUserId: n.payeeUserId, payeeName: n.payeeName,
          recurringId: enlace?.recurringId ?? null, recurringDue: enlace?.recurringDue ?? null,
        });
        await this.audit.record(ctx, {
          action: cierre ? 'expense.adjust' : n.paidOn ? 'expense.payroll.pay' : 'expense.create',
          resourceType: 'OperatingExpense', resourceId: gasto.id, branchId: e.branchId, reason: n.description,
          // Sin el nombre de a quién se le pagó: la bitácora la ve gente que no ve Movimientos.
          afterState: {
            category: e.category, amountCents: e.amountCents.toString(), month: aMes(periodMonth),
            ...(cierre ? { adjustsMonth: mes } : {}),
            ...(n.paidOn ? { paidOn: isoDate(n.paidOn) } : {}),
            ...(enlace ? { recurringId: enlace.recurringId, recurringDue: isoDate(enlace.recurringDue) } : {}),
          },
        });
        if (propuesta?.keepAmount && propuesta.recurrente.amountCents !== e.amountCents) {
          await recurrentes.cambiarImporte(propuesta.recurrente.id, e.amountCents);
          await this.audit.record(ctx, {
            action: 'expense.recurring.update', resourceType: 'RecurringExpense', resourceId: propuesta.recurrente.id, branchId: e.branchId, reason: n.description,
            beforeState: { amountCents: propuesta.recurrente.amountCents.toString() }, afterState: { amountCents: e.amountCents.toString() },
          });
        }
        return gasto;
      });
    } catch (err) {
      // Dos personas confirmando la misma propuesta: la base deja pasar a una.
      if (propuesta && esUnicidad(err)) throw propuestaResuelta();
      throw err;
    }
  }

  // ── Lo que se repite ──────────────────────────────────────────────────────

  /** El recurrente vivo de ese id, o 404 / 409 si ya no se repite. */
  async recurrente(organizationId: string, id: string): Promise<Recurrente> {
    const r = await new RecurringExpensesRepository(organizationId).findById(id);
    if (!r) throw notFound('Ese gasto que se repite no existe');
    if (r.endedAt) throw conflict('Ese gasto ya no se repite', 'EXPENSE_PROPOSAL_RESOLVED');
    return r;
  }

  /** Deja un gasto para que se proponga cada periodo, SIN anotar ninguno ahora. */
  async dejarQueSeRepita(ctx: RequestContext, e: AQuien & {
    category: string; description?: string | undefined; amountCents: bigint; branchId: string | null; frequency: FrecuenciaDeGasto; startsOn: string;
  }): Promise<Recurrente> {
    const orgId = ctx.tenant.organizationId;
    const hoy = await this.hoy(orgId);
    const startsOn = fecha(e.startsOn);
    // Hacia atrás propondría de golpe todo lo que «tocaba»: eso se anota a mano.
    if (startsOn.getTime() < dia1(hoy).getTime()) throw validation('Empieza a proponerse desde este mes: lo de meses anteriores se anota a mano');
    const esNomina = e.category === NOMINA;
    if (!esNomina && (e.payeeUserId || e.payeeName)) throw validation('A quién solo va en la nómina');
    if (!esNomina && e.frequency !== 'MONTHLY') throw validation('Ese gasto se repite cada mes; cada semana o cada quincena es para la nómina');
    const quien = esNomina ? await this.aQuien(orgId, e) : { payeeUserId: null, payeeName: null };
    const description = e.description?.trim() || (esNomina ? NOTA_DE_NOMINA : '');
    if (description.length < 3) throw validation('Describe el gasto (al menos 3 letras)');
    return enUnaTransaccion(async () => {
      const nuevo = await new RecurringExpensesRepository(orgId).create({
        branchId: e.branchId, category: e.category, description, amountCents: e.amountCents, frequency: e.frequency, startsOn,
        ...quien, createdByUserId: ctx.tenant.actorUserId!,
      });
      await this.audit.record(ctx, {
        action: 'expense.recurring.create', resourceType: 'RecurringExpense', resourceId: nuevo.id, branchId: e.branchId, reason: description,
        afterState: { category: e.category, amountCents: e.amountCents.toString(), frequency: e.frequency, startsOn: e.startsOn },
      });
      return nuevo;
    });
  }

  /** La propuesta `dueOn` de ese recurrente: existe, ya tocó y nadie la resolvió. */
  private async propuestaPendiente(organizationId: string, r: Recurrente, dueOn: string): Promise<Date> {
    const dia = fecha(dueOn);
    if (!esVencimiento(r.frequency, r.startsOn, dia)) throw validation('Ese gasto no toca ese día');
    if (dia.getTime() > (await this.hoy(organizationId)).getTime()) throw validation('Esa propuesta todavía no toca: se confirma o se descarta cuando llegue su día');
    const repo = new RecurringExpensesRepository(organizationId);
    const manana = new Date(dia.getTime() + 86_400_000);
    const [confirmadas, descartes] = await Promise.all([repo.confirmadas([r.id], dia, manana), repo.descartes([r.id], dia, manana)]);
    if (confirmadas.length > 0 || descartes.length > 0) throw propuestaResuelta();
    return dia;
  }

  /**
   * Confirma una propuesta: nace el gasto. `amountCents` corrige el importe de
   * ESTA vez (`keepAmount`: y de las siguientes). En la nómina `paidOn` es el
   * día en que de verdad se pagó (por omisión, el día que tocaba).
   */
  async confirmar(ctx: RequestContext, r: Recurrente, e: { dueOn: string; amountCents?: bigint | undefined; paidOn?: string | undefined; asAdjustment?: boolean | undefined; keepAmount?: boolean | undefined }): Promise<Gasto> {
    const dueOn = await this.propuestaPendiente(ctx.tenant.organizationId, r, e.dueOn);
    const esNomina = r.category === NOMINA;
    if (!esNomina && e.paidOn) throw validation('La fecha del pago solo va en la nómina');
    return this.anotar(ctx, {
      category: r.category, description: r.description, amountCents: e.amountCents ?? r.amountCents, branchId: r.branchId, asAdjustment: e.asAdjustment,
      ...(esNomina
        // La persona es la de la plantilla, con el nombre que quedó guardado en ella.
        ? { paidOn: e.paidOn ?? e.dueOn, ...(r.payeeUserId ? { payeeUserId: r.payeeUserId } : { payeeName: r.payeeName }) }
        : { month: e.dueOn.slice(0, 7) }),
    }, { recurrente: r, dueOn, keepAmount: !!e.keepAmount });
  }

  /** Descarta una propuesta: esta vez no se pagó. No se anota ningún gasto. */
  async descartar(ctx: RequestContext, r: Recurrente, e: { dueOn: string; reason?: string | undefined }): Promise<void> {
    const orgId = ctx.tenant.organizationId;
    const dueOn = await this.propuestaPendiente(orgId, r, e.dueOn);
    const reason = e.reason?.trim() || null;
    try {
      await enUnaTransaccion(async () => {
        await new RecurringExpensesRepository(orgId).descartar({ recurringId: r.id, dueOn, reason, skippedByUserId: ctx.tenant.actorUserId! });
        await this.audit.record(ctx, {
          action: 'expense.recurring.skip', resourceType: 'RecurringExpense', resourceId: r.id, branchId: r.branchId, reason: reason ?? r.description,
          afterState: { category: r.category, amountCents: r.amountCents.toString(), dueOn: e.dueOn },
        });
      });
    } catch (err) {
      if (esUnicidad(err)) throw propuestaResuelta();
      throw err;
    }
  }

  /** Deja de repetirse: no propone nada más (tampoco lo que seguía por confirmar). Los gastos ya confirmados no cambian. */
  async dejarDeRepetir(ctx: RequestContext, r: Recurrente, reason: string): Promise<void> {
    const orgId = ctx.tenant.organizationId;
    await enUnaTransaccion(async () => {
      if (!(await new RecurringExpensesRepository(orgId).terminar(r.id, ctx.tenant.actorUserId!, reason))) throw conflict('Ese gasto ya no se repite', 'EXPENSE_PROPOSAL_RESOLVED');
      await this.audit.record(ctx, {
        action: 'expense.recurring.end', resourceType: 'RecurringExpense', resourceId: r.id, branchId: r.branchId, reason,
        beforeState: { category: r.category, amountCents: r.amountCents.toString(), frequency: r.frequency },
      });
    });
  }

  /** Lo que se repite y lo que propone para ese mes (`propuestas.ts`). */
  async propuestas(organizationId: string, month: string, sedes: readonly string[] | null, verNomina: boolean): Promise<RecurringExpenseList> {
    return propuestasDelMes(organizationId, month, sedes, verNomina);
  }
}
