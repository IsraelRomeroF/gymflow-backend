import { uuidv7 } from '@gymflow/core';
import type { FrecuenciaDeGasto } from '@gymflow/core/contracts';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

export type Recurrente = {
  id: string; branchId: string | null; category: string; description: string; amountCents: bigint;
  frequency: FrecuenciaDeGasto; startsOn: Date; payeeUserId: string | null; payeeName: string | null;
  createdByUserId: string; createdAt: Date; endedAt: Date | null;
};
export type Descarte = { recurringId: string; dueOn: Date; reason: string | null; skippedByUserId: string; skippedAt: Date };
export type Persona = { id: string; name: string; role: string | null; active: boolean };

const SELECT = {
  id: true, branchId: true, category: true, description: true, amountCents: true, frequency: true, startsOn: true,
  payeeUserId: true, payeeName: true, createdByUserId: true, createdAt: true, endedAt: true,
} as const;

/**
 * GASTOS QUE SE REPITEN (D-26, bloque 4.5). La fila es la PLANTILLA: no es un
 * gasto y ninguna cifra la lee. De ella salen las propuestas «por confirmar»
 * (`recurrentes.ts` dice qué días toca); confirmar una crea el gasto, y
 * descartarla deja aquí quién y cuándo. No se borran: se dejan de repetir.
 */
export class RecurringExpensesRepository extends TenantRepository {
  async create(input: {
    branchId: string | null; category: string; description: string; amountCents: bigint; frequency: FrecuenciaDeGasto; startsOn: Date;
    payeeUserId: string | null; payeeName: string | null; createdByUserId: string;
  }): Promise<Recurrente> {
    return this.db.recurringExpense.create({ data: { id: uuidv7(), organizationId: this.organizationId, ...input }, select: SELECT }) as Promise<Recurrente>;
  }

  async findById(id: string): Promise<Recurrente | null> {
    return this.db.recurringExpense.findFirst({ where: this.scope({ id }), select: SELECT }) as Promise<Recurrente | null>;
  }

  /** Los que siguen repitiéndose. */
  async vivos(): Promise<Recurrente[]> {
    return this.db.recurringExpense.findMany({ where: this.scope({ endedAt: null }), select: SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }) as Promise<Recurrente[]>;
  }

  /** Deja de repetirse. `false` si ya no se repetía. */
  async terminar(id: string, byUserId: string, reason: string): Promise<boolean> {
    const { count } = await this.db.recurringExpense.updateMany({
      where: this.scope({ id, endedAt: null }),
      data: { endedAt: new Date(), endedByUserId: byUserId, endReason: reason },
    });
    return count > 0;
  }

  async cambiarImporte(id: string, amountCents: bigint): Promise<void> {
    await this.db.recurringExpense.updateMany({ where: this.scope({ id, endedAt: null }), data: { amountCents } });
  }

  /** Los gastos VIGENTES que confirmaron una propuesta de esos recurrentes con fecha en `[from, to)`. */
  async confirmadas(ids: readonly string[], from: Date, to: Date): Promise<Array<{ id: string; recurringId: string; recurringDue: Date }>> {
    if (ids.length === 0) return [];
    const filas = await this.db.operatingExpense.findMany({
      where: this.scope({ recurringId: { in: [...ids] }, recurringDue: { gte: from, lt: to }, voidedAt: null }),
      select: { id: true, recurringId: true, recurringDue: true },
    });
    return filas as Array<{ id: string; recurringId: string; recurringDue: Date }>;
  }

  async descartes(ids: readonly string[], from: Date, to: Date): Promise<Descarte[]> {
    if (ids.length === 0) return [];
    return this.db.recurringExpenseSkip.findMany({
      where: this.scope({ recurringId: { in: [...ids] }, dueOn: { gte: from, lt: to } }),
      select: { recurringId: true, dueOn: true, reason: true, skippedByUserId: true, skippedAt: true },
    });
  }

  async descartar(input: { recurringId: string; dueOn: Date; reason: string | null; skippedByUserId: string }): Promise<void> {
    await this.db.recurringExpenseSkip.create({ data: { id: uuidv7(), organizationId: this.organizationId, ...input } });
  }

  /**
   * El personal del gimnasio, activo o no: a quién se le puede anotar un pago.
   * Nombre y puesto; nada de contacto.
   */
  async personal(ids?: readonly string[]): Promise<Persona[]> {
    if (ids && ids.length === 0) return [];
    const filas = await this.db.user.findMany({
      where: { organizationId: this.organizationId, ...(ids ? { id: { in: [...ids] } } : {}) },
      select: { id: true, fullName: true, isActive: true, roleAssignments: { where: { revokedAt: null }, select: { role: { select: { name: true } } }, take: 1 } },
      orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }, { id: 'asc' }],
    });
    return filas.map((u) => ({ id: u.id, name: u.fullName, role: u.roleAssignments[0]?.role.name ?? null, active: u.isActive }));
  }
}
