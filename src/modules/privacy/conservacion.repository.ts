import { uuidv7, type EstadoDeListaDeConservacion, type EstadoDeRenglonDeConservacion } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

export type ListaRecord = {
  id: string; period: string; status: EstadoDeListaDeConservacion; monthsAfterArchive: number; cutoffOn: Date;
  preparedAt: Date; signedAt: Date | null; signedByUserId: string | null; closedAt: Date | null;
};

export type RenglonRecord = {
  id: string; batchId: string; memberId: string; memberCode: string; archivedAt: Date; archivedOn: Date;
  status: EstadoDeRenglonDeConservacion; note: string | null;
};

/** Lo que hace falta saber de un exsocio para listarlo o para volver a comprobarlo antes de tocarlo. */
export type ExsocioRecord = {
  id: string; memberCode: string; firstName: string; lastName: string; homeBranchId: string | null;
  deletedAt: Date | null; anonymizedAt: Date | null;
};

const LISTA = {
  id: true, period: true, status: true, monthsAfterArchive: true, cutoffOn: true,
  preparedAt: true, signedAt: true, signedByUserId: true, closedAt: true,
} as const;
const RENGLON = { id: true, batchId: true, memberId: true, memberCode: true, archivedAt: true, archivedOn: true, status: true, note: true } as const;
const EXSOCIO = { id: true, memberCode: true, firstName: true, lastName: true, homeBranchId: true, deletedAt: true, anonymizedAt: true } as const;

/**
 * CONSERVACIÓN (D-32; bloque 3.9): cuándo empezaron a correr los plazos en el
 * gimnasio y las listas mensuales de exsocios por anonimizar.
 *
 * Tablas propias: `privacy_conservation_starts`, `privacy_batches` y
 * `privacy_batch_items`. De `members` solo LEE (quién está de baja y desde
 * cuándo): anonimizar lo hace `PrivacyService.anonymize`, como siempre.
 *
 * La base cuida lo que no puede fallar (migración `conservacion_lista_mensual`):
 * a lo más una lista en espera por gimnasio, una por mes, y ningún renglón
 * pasa a ANONYMIZED si su lista no está firmada.
 */
export class ConservacionRepository extends TenantRepository {
  // ── El arranque ───────────────────────────────────────────────────────────

  async arranque(): Promise<Date | null> {
    const fila = await this.db.privacyConservationStart.findFirst({ where: this.scope({}), select: { startedOn: true } });
    return fila?.startedOn ?? null;
  }

  /** Fija el día de arranque si no lo había. Devuelve `true` solo la vez que lo fijó. */
  async fijarArranque(dia: Date): Promise<boolean> {
    const { count } = await this.db.privacyConservationStart.createMany({
      data: [{ organizationId: this.organizationId, startedOn: dia }], skipDuplicates: true,
    });
    return count > 0;
  }

  // ── Exsocios (solo lectura) ───────────────────────────────────────────────

  /** Dados de baja antes de ese instante y aún con nombre, del más antiguo al más reciente. */
  async exsociosDeBajaAntesDe(instante: Date): Promise<ExsocioRecord[]> {
    return this.db.member.findMany({
      where: this.scope({ deletedAt: { lt: instante }, anonymizedAt: null }),
      select: EXSOCIO, orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
    });
  }

  async exsocios(ids: readonly string[]): Promise<Map<string, ExsocioRecord>> {
    if (ids.length === 0) return new Map();
    const filas = await this.db.member.findMany({ where: this.scope({ id: { in: [...new Set(ids)] } }), select: EXSOCIO });
    return new Map(filas.map((f) => [f.id, f]));
  }

  // ── Las listas ────────────────────────────────────────────────────────────

  async pendiente(): Promise<ListaRecord | null> {
    return this.db.privacyBatch.findFirst({ where: this.scope({ status: 'PENDING' }), select: LISTA }) as Promise<ListaRecord | null>;
  }

  async porId(id: string): Promise<ListaRecord | null> {
    return this.db.privacyBatch.findFirst({ where: this.scope({ id }), select: LISTA }) as Promise<ListaRecord | null>;
  }

  async delPeriodo(period: string): Promise<ListaRecord | null> {
    return this.db.privacyBatch.findFirst({ where: this.scope({ period }), select: LISTA }) as Promise<ListaRecord | null>;
  }

  /** Las ya resueltas (firmadas o reemplazadas), de la más reciente a la más antigua. */
  async resueltas(limite: number): Promise<ListaRecord[]> {
    return this.db.privacyBatch.findMany({
      where: this.scope({ status: { not: 'PENDING' } }), select: LISTA, orderBy: { period: 'desc' }, take: limite,
    }) as Promise<ListaRecord[]>;
  }

  /** Las firmadas a las que todavía les queda algún renglón por hacer (una falla a media ejecución). */
  async firmadasConPendientes(): Promise<ListaRecord[]> {
    return this.db.privacyBatch.findMany({
      where: this.scope({ status: 'SIGNED', items: { some: { status: 'LISTED' } } }), select: LISTA, orderBy: { period: 'asc' },
    }) as Promise<ListaRecord[]>;
  }

  /** Crea la lista del mes con sus renglones. Se llama dentro de una unidad: o nace entera o no nace. */
  async crear(input: {
    period: string; monthsAfterArchive: number; cutoffOn: Date; preparedAt: Date;
    renglones: ReadonlyArray<{ memberId: string; memberCode: string; archivedAt: Date; archivedOn: Date }>;
  }): Promise<ListaRecord> {
    const id = uuidv7();
    const lista = await this.db.privacyBatch.create({
      data: {
        id, organizationId: this.organizationId, period: input.period, status: 'PENDING',
        monthsAfterArchive: input.monthsAfterArchive, cutoffOn: input.cutoffOn, preparedAt: input.preparedAt,
      },
      select: LISTA,
    });
    await this.db.privacyBatchItem.createMany({
      data: input.renglones.map((r) => ({ id: uuidv7(), batchId: id, organizationId: this.organizationId, ...r })),
    });
    return lista as ListaRecord;
  }

  /** Cierra sin firma la lista que nadie firmó. Solo si sigue en espera. */
  async reemplazar(id: string, cuando: Date): Promise<boolean> {
    const { count } = await this.db.privacyBatch.updateMany({
      where: this.scope({ id, status: 'PENDING' }), data: { status: 'REPLACED', closedAt: cuando },
    });
    return count > 0;
  }

  /** La firma: una sola vez. `false` si otra firma ganó o la lista ya no espera. */
  async firmar(id: string, userId: string, cuando: Date): Promise<boolean> {
    const { count } = await this.db.privacyBatch.updateMany({
      where: this.scope({ id, status: 'PENDING' }), data: { status: 'SIGNED', signedAt: cuando, signedByUserId: userId },
    });
    return count > 0;
  }

  /** Una lista firmada sin renglones por hacer queda cerrada. */
  async cerrarSiTermino(id: string, cuando: Date): Promise<void> {
    await this.db.privacyBatch.updateMany({
      where: this.scope({ id, status: 'SIGNED', closedAt: null, items: { none: { status: 'LISTED' } } }), data: { closedAt: cuando },
    });
  }

  // ── Los renglones ─────────────────────────────────────────────────────────

  async renglones(batchId: string): Promise<RenglonRecord[]> {
    return this.db.privacyBatchItem.findMany({
      where: this.scope({ batchId }), select: RENGLON, orderBy: [{ archivedAt: 'asc' }, { id: 'asc' }],
    }) as Promise<RenglonRecord[]>;
  }

  async renglon(batchId: string, memberId: string): Promise<RenglonRecord | null> {
    return this.db.privacyBatchItem.findFirst({ where: this.scope({ batchId, memberId }), select: RENGLON }) as Promise<RenglonRecord | null>;
  }

  /** Cuántos renglones hay en cada estado, por lista, en una consulta. */
  async conteos(batchIds: readonly string[]): Promise<Map<string, Record<EstadoDeRenglonDeConservacion, number>>> {
    const salida = new Map<string, Record<EstadoDeRenglonDeConservacion, number>>();
    for (const id of batchIds) salida.set(id, { LISTED: 0, ANONYMIZED: 0, EXCLUDED: 0, SKIPPED: 0 });
    if (batchIds.length === 0) return salida;
    const grupos = await this.db.privacyBatchItem.groupBy({
      by: ['batchId', 'status'], where: this.scope({ batchId: { in: [...batchIds] } }), _count: { _all: true },
    });
    for (const g of grupos) salida.get(g.batchId)![g.status as EstadoDeRenglonDeConservacion] = g._count._all;
    return salida;
  }

  /** Resuelve un renglón que sigue en la lista. `false` si ya estaba resuelto (otra pasada llegó antes). */
  async resolver(id: string, input: { status: Exclude<EstadoDeRenglonDeConservacion, 'LISTED'>; note: string | null; cuando: Date; userId: string | null }): Promise<boolean> {
    const { count } = await this.db.privacyBatchItem.updateMany({
      where: this.scope({ id, status: 'LISTED' }),
      data: { status: input.status, note: input.note, resolvedAt: input.cuando, resolvedByUserId: input.userId },
    });
    return count > 0;
  }
}
