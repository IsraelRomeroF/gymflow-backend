import { uuidv7 } from '@gymflow/core';
import { GlobalRepository } from '../../platform/db/tenant-repository.js';
import type { ClaseDeAviso } from './cobranza-reglas.js';

export type Aviso = {
  id: string; organizationId: string; kind: string; dedupeKey: string; invoiceId: string | null; priceChangeId: string | null;
  title: string; body: string; noticeOn: Date; createdAt: Date;
  pushedAt: Date | null; pushDevices: number; seenAt: Date | null; seenByUserId: string | null; sentAt: Date | null; sentByUserId: string | null;
  deliveredOn: Date | null; closedAt: Date | null; closeReason: string | null;
};
export type Dueno = { id: string; fullName: string; phoneE164: string | null };

const SELECT = {
  id: true, organizationId: true, kind: true, dedupeKey: true, invoiceId: true, priceChangeId: true, title: true, body: true, noticeOn: true, createdAt: true,
  pushedAt: true, pushDevices: true, seenAt: true, seenByUserId: true, sentAt: true, sentByUserId: true, deliveredOn: true, closedAt: true, closeReason: true,
} as const;
const dia = (fecha: string): Date => new Date(`${fecha}T00:00:00.000Z`);

/**
 * AVISOS DE GYMFLOW AL DUEÑO DE UNA MARCA (D-37, bloque 3.11). Global: los
 * escribe la plataforma. Un aviso no se borra ni se reescribe: se cierra
 * cuando deja de hacer falta. La constancia de entrega (`deliveredOn`) solo
 * se escribe la PRIMERA vez: es el día desde el que cuenta la suspensión.
 */
export class PlatformNoticeRepository extends GlobalRepository {
  /**
   * Crea el aviso si no existe uno con esa llave. La llave lleva un número de
   * vuelta (`CLASE:<de qué>:<n>`): si la factura se pagó, el pago se deshizo y
   * volvió a vencer, el aviso es nuevo y sus días vuelven a contar desde cero.
   */
  async crear(input: { organizationId: string; kind: ClaseDeAviso; llave: string; invoiceId?: string | null; priceChangeId?: string | null; title: string; body: string; noticeOn: string }): Promise<Aviso | null> {
    const previos = await this.db.platformNotice.count({ where: { dedupeKey: { startsWith: `${input.kind}:${input.llave}:` } } });
    const id = uuidv7();
    const { count } = await this.db.platformNotice.createMany({
      data: [{
        id, organizationId: input.organizationId, kind: input.kind, dedupeKey: `${input.kind}:${input.llave}:${previos + 1}`,
        invoiceId: input.invoiceId ?? null, priceChangeId: input.priceChangeId ?? null, title: input.title, body: input.body, noticeOn: dia(input.noticeOn),
      }],
      skipDuplicates: true,
    });
    return count > 0 ? this.db.platformNotice.findUnique({ where: { id }, select: SELECT }) : null;
  }

  find(id: string): Promise<Aviso | null> {
    return this.db.platformNotice.findUnique({ where: { id }, select: SELECT });
  }

  /** Los avisos ABIERTOS de esas facturas. */
  abiertosDeFacturas(invoiceIds: readonly string[]): Promise<Aviso[]> {
    if (invoiceIds.length === 0) return Promise.resolve([]);
    return this.db.platformNotice.findMany({ where: { invoiceId: { in: [...invoiceIds] }, closedAt: null }, select: SELECT, orderBy: { createdAt: 'asc' } });
  }

  /** Los avisos abiertos de una marca (los que ve su dueño), del más nuevo al más viejo. */
  abiertosDeMarca(organizationId: string): Promise<Aviso[]> {
    return this.db.platformNotice.findMany({ where: { organizationId, closedAt: null }, select: SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 });
  }

  /** Todos los avisos de una marca, para su ficha en la consola. */
  deMarca(organizationId: string, limite = 30): Promise<Aviso[]> {
    return this.db.platformNotice.findMany({ where: { organizationId }, select: SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limite });
  }

  /**
   * «Avisos por mandar» de la consola: abiertos, sin constancia de entrega, de marcas vivas; del más
   * viejo al más nuevo. Sin tope (bloque 4.17): antes eran los 500 abiertos más VIEJOS de cualquier
   * clase y el filtro iba después, así que con más de 500 abiertos (entregados o de marcas dadas de
   * baja incluidos) el aviso más nuevo no salía en la lista y nadie lo mandaba. Lo que queda aquí es
   * lo que alguien tiene que mandar: sale de aquí al tener constancia de entrega o al cerrarse.
   */
  porMandar(): Promise<Aviso[]> {
    return this.db.platformNotice.findMany({
      where: { closedAt: null, deliveredOn: null, organization: { deletedAt: null } },
      select: SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** Avisos abiertos de cambio de precio para esa fecha. */
  abiertosDeCambio(effectiveFrom: string): Promise<Aviso[]> {
    return this.db.platformNotice.findMany({ where: { kind: 'PRICE_CHANGE', closedAt: null, dedupeKey: { contains: `:${effectiveFrom}:` } }, select: SELECT });
  }

  /** La notificación llegó a `devices` equipos del dueño. */
  async marcarNotificado(id: string, devices: number, hoy: string, ahora: Date): Promise<void> {
    if (devices <= 0) return;
    await this.db.$executeRaw`
      UPDATE "platform_notices" SET "pushedAt" = COALESCE("pushedAt", ${ahora}), "pushDevices" = "pushDevices" + ${devices}, "deliveredOn" = COALESCE("deliveredOn", ${hoy}::date)
       WHERE "id" = ${id}::uuid`;
  }

  /** El dueño vio en su panel los avisos abiertos de su marca. Devuelve los que no había visto. */
  async marcarVistos(organizationId: string, userId: string, hoy: string, ahora: Date): Promise<Aviso[]> {
    const filas = await this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE "platform_notices" SET "seenAt" = ${ahora}, "seenByUserId" = ${userId}::uuid, "deliveredOn" = COALESCE("deliveredOn", ${hoy}::date)
       WHERE "organizationId" = ${organizationId}::uuid AND "closedAt" IS NULL AND "seenAt" IS NULL
      RETURNING "id"`;
    if (filas.length === 0) return [];
    return this.db.platformNotice.findMany({ where: { id: { in: filas.map((f) => f.id) } }, select: SELECT });
  }

  /** Una persona de GymFlow se lo mandó (WhatsApp, llamada). Solo la primera vez. */
  async marcarMandado(id: string, byUserId: string, hoy: string, ahora: Date): Promise<boolean> {
    const n = await this.db.$executeRaw`
      UPDATE "platform_notices" SET "sentAt" = ${ahora}, "sentByUserId" = ${byUserId}::uuid, "deliveredOn" = COALESCE("deliveredOn", ${hoy}::date)
       WHERE "id" = ${id}::uuid AND "sentAt" IS NULL AND "closedAt" IS NULL`;
    return n > 0;
  }

  async cerrar(ids: readonly string[], reason: string, ahora: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.db.platformNotice.updateMany({ where: { id: { in: [...ids] }, closedAt: null }, data: { closedAt: ahora, closeReason: reason } });
    return count;
  }

  /** Cierra los avisos abiertos de una factura (se pagó o se anuló). */
  async cerrarDeFactura(invoiceId: string, reason: string, ahora: Date): Promise<number> {
    const { count } = await this.db.platformNotice.updateMany({ where: { invoiceId, closedAt: null }, data: { closedAt: ahora, closeReason: reason } });
    return count;
  }

  /** Cierra los avisos abiertos de una clase en una marca (p. ej. «suspendido» al reanudar). */
  async cerrarDeMarca(organizationId: string, kind: ClaseDeAviso, reason: string, ahora: Date): Promise<number> {
    const { count } = await this.db.platformNotice.updateMany({ where: { organizationId, kind, closedAt: null }, data: { closedAt: ahora, closeReason: reason } });
    return count;
  }

  /** Los dueños activos de la marca: a ellos van los avisos. */
  async duenos(organizationId: string): Promise<Dueno[]> {
    return this.db.user.findMany({
      where: { organizationId, isActive: true, deletedAt: null, roleAssignments: { some: { revokedAt: null, role: { key: 'OWNER' } } } },
      select: { id: true, fullName: true, phoneE164: true }, orderBy: { createdAt: 'asc' },
    });
  }

  /** Los dueños de varias marcas, en una consulta. */
  async duenosDe(organizationIds: readonly string[]): Promise<Map<string, Dueno[]>> {
    if (organizationIds.length === 0) return new Map();
    const filas = await this.db.user.findMany({
      where: { organizationId: { in: [...organizationIds] }, isActive: true, deletedAt: null, roleAssignments: { some: { revokedAt: null, role: { key: 'OWNER' } } } },
      select: { id: true, fullName: true, phoneE164: true, organizationId: true }, orderBy: { createdAt: 'asc' },
    });
    const mapa = new Map<string, Dueno[]>();
    for (const { organizationId, ...d } of filas) mapa.set(organizationId!, [...(mapa.get(organizationId!) ?? []), d]);
    return mapa;
  }

  async esDueno(organizationId: string, userId: string): Promise<boolean> {
    return (await this.db.roleAssignment.count({ where: { organizationId, userId, revokedAt: null, role: { key: 'OWNER' } } })) > 0;
  }
}
