import { isoDate } from '@gymflow/core';
import type { ExpenseProposal, RecurringExpense, RecurringExpenseList } from '@gymflow/core/contracts';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { NOMINA } from './expenses.repository.js';
import { MonthlyCloseRepository } from './monthly-close.repository.js';
import { RecurringExpensesRepository } from './recurring.repository.js';
import { vencimientos } from './recurrentes.js';

const aMes = (d: Date) => d.toISOString().slice(0, 7);
const fecha = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const mesSiguiente = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));

/**
 * LO QUE SE REPITE Y LO QUE PROPONE PARA UN MES (D-26, bloque 4.5).
 *
 * Las propuestas no están guardadas: se calculan aquí con los vencimientos de
 * cada gasto que se repite, y se dice de cada una si alguien la confirmó (hay
 * un gasto vigente enlazado), la descartó, o sigue por confirmar. Lo que
 * sigue por confirmar no existe en `operating_expenses`: el Tablero,
 * Movimientos y la foto del cierre no lo pueden contar.
 *
 * `sedes`: las de quien consulta (null = todo el gimnasio). `verNomina`: sin
 * Movimientos (`expenses:payroll:read`) no se entrega la nómina por persona.
 * Un mes futuro, o un día que aún no llega, no está «por confirmar» todavía.
 */
export async function propuestasDelMes(organizationId: string, month: string, sedes: readonly string[] | null, verNomina: boolean): Promise<RecurringExpenseList> {
  const from = fecha(`${month}-01`);
  const to = mesSiguiente(from);
  const repo = new RecurringExpensesRepository(organizationId);
  const [todos, cierre, hoy] = await Promise.all([repo.vivos(), new MonthlyCloseRepository(organizationId).find(from), new BusinessCalendar(organizationId).today(null)]);
  const vivos = todos
    .filter((r) => sedes === null || (r.branchId !== null && sedes.includes(r.branchId)))
    .filter((r) => verNomina || r.category !== NOMINA);
  const ids = vivos.map((r) => r.id);
  const [confirmadas, descartes, personas] = await Promise.all([
    repo.confirmadas(ids, from, to),
    repo.descartes(ids, from, to),
    repo.personal([...new Set([...vivos.map((r) => r.payeeUserId)].filter((x): x is string => !!x))]),
  ]);
  const quienDescarto = new Map((await repo.personal([...new Set(descartes.map((d) => d.skippedByUserId))])).map((p) => [p.id, p.name]));
  const llave = (id: string, d: Date) => `${id}:${isoDate(d)}`;
  const hechas = new Map(confirmadas.map((c) => [llave(c.recurringId, c.recurringDue), c.id]));
  const fuera = new Map(descartes.map((d) => [llave(d.recurringId, d.dueOn), d]));
  const activa = new Map(personas.map((p) => [p.id, p.active]));

  const proposals: ExpenseProposal[] = [];
  for (const r of vivos) {
    for (const d of vencimientos(r.frequency, r.startsOn, from, to)) {
      const k = llave(r.id, d);
      const descarte = fuera.get(k);
      const expenseId = hechas.get(k) ?? null;
      proposals.push({
        recurringId: r.id, dueOn: isoDate(d), status: expenseId ? 'CONFIRMED' : descarte ? 'SKIPPED' : 'PENDING', expenseId,
        skippedAt: descarte?.skippedAt.toISOString() ?? null, skippedByName: descarte ? quienDescarto.get(descarte.skippedByUserId) ?? null : null,
        skipReason: descarte?.reason ?? null,
      });
    }
  }
  proposals.sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.recurringId.localeCompare(b.recurringId));
  const hoyIso = isoDate(hoy);
  const recurring: RecurringExpense[] = vivos.map((r) => ({
    id: r.id, branchId: r.branchId, category: r.category, description: r.description, amountCents: r.amountCents.toString(),
    frequency: r.frequency, startsOn: isoDate(r.startsOn), payeeUserId: r.payeeUserId, payeeName: r.payeeName,
    payeeInactive: r.payeeUserId ? activa.get(r.payeeUserId) === false : false,
    createdAt: r.createdAt.toISOString(), endedAt: null,
  }));
  return {
    month, closed: !!cierre, currentMonth: aMes(hoy), today: hoyIso, recurring, proposals,
    // Por confirmar: lo que ya tocó y nadie ha resuelto.
    pending: proposals.filter((p) => p.status === 'PENDING' && p.dueOn <= hoyIso).length,
  };
}

/** Cuántas propuestas de ese mes siguen por confirmar en todo el gimnasio (para la revisión del cierre). */
export async function porConfirmarEnElMes(organizationId: string, month: string): Promise<number> {
  return (await propuestasDelMes(organizationId, month, null, true)).pending;
}
