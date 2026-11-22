import { canConsumeVisit, conflict, uuidv7, validation, visitBalance, type VisitPackStatus, type VisitLedgerEntry } from '@gymflow/core';
import { PrismaVisitPackStatus } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { dondeSede } from '../../platform/db/filtro-de-sede.js';
import type { SedesDelDia } from '../../platform/time/business-calendar.js';

const VP = PrismaVisitPackStatus;

export type VisitPackRecord = {
  id: string;
  memberId: string;
  planId: string | null;
  visitsPurchased: number;
  purchasedOn: Date;
  expiresOn: Date | null;
  status: VisitPackStatus;
  expiredAt: Date | null;
  soldAtBranchId: string | null;
};

export type VisitEntryRecord = {
  id: string;
  entryType: string;
  delta: number;
  reason: string | null;
  branchId: string | null;
  attendanceEventId: string | null;
  at: Date;
};

const SELECT = {
  id: true, memberId: true, planId: true, visitsPurchased: true,
  purchasedOn: true, expiresOn: true, status: true, expiredAt: true,
  soldAtBranchId: true,
} as const;

export class VisitPackRepository extends TenantRepository {
  async findById(id: string): Promise<VisitPackRecord | null> {
    const row = await this.db.visitPack.findFirst({ where: this.scope({ id }), select: SELECT });
    return row as VisitPackRecord | null;
  }

  async listForMember(memberId: string): Promise<VisitPackRecord[]> {
    const rows = await this.db.visitPack.findMany({
      where: this.scope({ memberId }),
      select: SELECT,
      orderBy: { purchasedOn: 'desc' },
    });
    return rows as VisitPackRecord[];
  }

  /** Paquetes y saldos de MUCHOS socios en dos consultas (padrón). */
  async balancesForMembers(memberIds: readonly string[]): Promise<Map<string, { packs: VisitPackRecord[]; balanceOf: Map<string, number> }>> {
    const out = new Map<string, { packs: VisitPackRecord[]; balanceOf: Map<string, number> }>();
    if (memberIds.length === 0) return out;
    const packs = await this.db.visitPack.findMany({ where: this.scope({ memberId: { in: [...memberIds] } }), select: SELECT, orderBy: { purchasedOn: 'desc' } }) as VisitPackRecord[];
    const saldos = await this.db.visitLedgerEntry.groupBy({ by: ['visitPackId'], where: this.scope({ visitPackId: { in: packs.map((p) => p.id) } }), _sum: { delta: true } });
    const saldoPorPack = new Map(saldos.map((s) => [s.visitPackId, s._sum.delta ?? 0]));
    for (const p of packs) {
      const e = out.get(p.memberId) ?? { packs: [], balanceOf: new Map<string, number>() };
      e.packs.push(p); e.balanceOf.set(p.id, saldoPorPack.get(p.id) ?? 0); out.set(p.memberId, e);
    }
    return out;
  }

  async entries(visitPackId: string): Promise<VisitEntryRecord[]> {
    const rows = await this.db.visitLedgerEntry.findMany({
      where: this.scope({ visitPackId }),
      select: { id: true, entryType: true, delta: true, reason: true, branchId: true, attendanceEventId: true, at: true },
      orderBy: { at: 'asc' },
    });
    return rows as VisitEntryRecord[];
  }

  /** Saldo = suma del LIBRO. Nunca un contador almacenado (ADR-024). */
  async balance(visitPackId: string): Promise<number> {
    const rows = await this.db.visitLedgerEntry.findMany({
      where: this.scope({ visitPackId }),
      select: { delta: true, entryType: true },
    });
    return visitBalance(rows as readonly VisitLedgerEntry[]);
  }

  /** Venta: crea el paquete y su asiento de compra en una sola transacción. */
  async sell(input: {
    memberId: string; planId: string | null; soldAtBranchId: string | null;
    visits: number; purchasedOn: Date; expiresOn: Date | null;
    createdByUserId: string; businessDate: Date;
    /** Cargo que lo financia. Sin él el ingreso diferido sería una estimación. */
    chargeId?: string | null;
  }): Promise<VisitPackRecord> {
    const id = uuidv7();
    const row = await this.db.$transaction(async (tx) => {
      const pack = await tx.visitPack.create({
        data: {
          id,
          organizationId: this.organizationId,
          memberId: input.memberId,
          planId: input.planId,
          soldAtBranchId: input.soldAtBranchId,
          visitsPurchased: input.visits,
          purchasedOn: input.purchasedOn,
          expiresOn: input.expiresOn,
          chargeId: input.chargeId ?? null,
          // Nace sin dar acceso: se activa cuando su cargo queda pagado (BE2-03).
          status: VP.PENDING_PAYMENT,
          createdByUserId: input.createdByUserId,
        },
        select: SELECT,
      });
      await tx.visitLedgerEntry.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          visitPackId: id,
          branchId: input.soldAtBranchId,
          entryType: 'PURCHASE',
          delta: input.visits,
          createdByUserId: input.createdByUserId,
          businessDate: input.businessDate,
        },
      });
      return pack;
    });
    return row as VisitPackRecord;
  }

  /**
   * Añade un movimiento al libro. `attendanceEventId` es la clave de
   * idempotencia del consumo: el índice único impide que un doble paso del
   * torniquete descuente dos visitas por una sola entrada.
   */
  async addEntry(input: {
    visitPackId: string;
    entryType: 'CONSUME' | 'EXPIRE' | 'ADJUST' | 'REFUND';
    delta: number;
    reason?: string | null;
    branchId?: string | null;
    attendanceEventId?: string | null;
    createdByUserId?: string | null;
    businessDate: Date;
  }): Promise<VisitEntryRecord> {
    const row = await this.db.visitLedgerEntry.create({
      data: {
        id: uuidv7(),
        organizationId: this.organizationId,
        visitPackId: input.visitPackId,
        branchId: input.branchId ?? null,
        attendanceEventId: input.attendanceEventId ?? null,
        entryType: input.entryType,
        delta: input.delta,
        reason: input.reason ?? null,
        createdByUserId: input.createdByUserId ?? null,
        businessDate: input.businessDate,
      },
      select: { id: true, entryType: true, delta: true, reason: true, branchId: true, attendanceEventId: true, at: true },
    });
    return row as VisitEntryRecord;
  }

  /**
   * Consume UNA visita, de forma atómica (BE2-04). Antes se leía el saldo,
   * se decidía y se escribía por separado: doce toques simultáneos dieron
   * once visitas de un paquete de diez. El paquete se toma FOR UPDATE, el
   * saldo se recalcula dentro y el agotado se marca en la misma transacción.
   */
  async consume(input: {
    visitPackId: string; businessDate: Date; branchId?: string | null;
    attendanceEventId?: string | null; createdByUserId?: string | null;
  }): Promise<{ entry: VisitEntryRecord; balance: number }> {
    return this.db.$transaction(async (tx) => {
      const [pack] = await tx.$queryRaw<Array<{ status: string; expiresOn: Date | null }>>`
        SELECT "status"::text AS status, "expiresOn" FROM "visit_packs"
         WHERE "id" = ${input.visitPackId}::uuid AND "organizationId" = ${this.organizationId}::uuid FOR UPDATE`;
      if (!pack) throw conflict('Paquete no encontrado');
      const entries = await tx.visitLedgerEntry.findMany({
        where: { organizationId: this.organizationId, visitPackId: input.visitPackId },
        select: { entryType: true, delta: true },
      });
      const veredicto = canConsumeVisit(pack.status as VisitPackStatus, entries as readonly VisitLedgerEntry[], input.businessDate, pack.expiresOn);
      if (!veredicto.ok) throw validation(veredicto.reason);
      const entry = await tx.visitLedgerEntry.create({
        data: {
          id: uuidv7(), organizationId: this.organizationId, visitPackId: input.visitPackId,
          branchId: input.branchId ?? null, attendanceEventId: input.attendanceEventId ?? null,
          entryType: 'CONSUME', delta: -1, createdByUserId: input.createdByUserId ?? null,
          businessDate: input.businessDate,
        },
        select: { id: true, entryType: true, delta: true, reason: true, branchId: true, attendanceEventId: true, at: true },
      });
      const balance = visitBalance(entries as readonly VisitLedgerEntry[]) - 1;
      if (balance <= 0) {
        await tx.visitPack.update({ where: { id: input.visitPackId }, data: { status: VP.EXHAUSTED } });
      }
      return { entry: entry as VisitEntryRecord, balance };
    });
  }

  /** El paquete que financia ese cargo. */
  async findByChargeId(chargeId: string): Promise<VisitPackRecord | null> {
    const row = await this.db.visitPack.findFirst({ where: this.scope({ chargeId }), select: SELECT });
    return row as VisitPackRecord | null;
  }

  /** Pagado su cargo, el paquete empieza a dar acceso. Idempotente. */
  async activateIfPending(id: string): Promise<boolean> {
    const { count } = await this.db.visitPack.updateMany({
      where: this.scope({ id, status: VP.PENDING_PAYMENT }), data: { status: VP.ACTIVE },
    });
    return count > 0;
  }

  async setStatus(id: string, status: VisitPackStatus, expiredAt?: Date): Promise<void> {
    await this.db.visitPack.updateMany({
      where: this.scope({ id }),
      data: { status: VP[status], ...(expiredAt ? { expiredAt } : {}) },
    });
  }

  async dueForExpiry(today: Date, limit = 500, sedes: SedesDelDia | null = null): Promise<VisitPackRecord[]> {
    const rows = await this.db.visitPack.findMany({
      where: this.scope({ status: VP.ACTIVE, expiresOn: { lte: today }, AND: dondeSede('soldAtBranchId', sedes) }),
      select: SELECT, take: limit,
    });
    return rows as VisitPackRecord[];
  }
}
