import { armarCursor, cortarPagina, type PartesDelCursor } from '@gymflow/core/contracts';
import { PrismaChargeStatus } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import type { AdjustmentRecord, ChargeRecord } from './charge.repository.js';
import type { PaymentRecord } from './payment.repository.js';

/**
 * LECTURA DEL ESTADO DE CUENTA POR PÁGINAS (auditoría 8: 3-04, 3-05, 3-06, 4-15).
 *
 * Solo lee. Antes el estado de cuenta pedía «los 50 más recientes» de cargos
 * y de pagos y no decía que había más; ahora cada lista sale por cursor
 * (vencimiento o fecha de cobro, e id para desempatar) con su total, y trae
 * lo que hacía falta abrir en otra parte: quién cobró, qué cubrió cada pago y
 * los ajustes de cada cargo con quien los autorizó.
 */

const S = PrismaChargeStatus;
const CON_DEUDA = [S.OPEN, S.PARTIALLY_PAID, S.OVERDUE];

// Las mismas columnas que `ChargeRecord` y `PaymentRecord`: si alguno gana un
// campo, `satisfies` hace que esto deje de compilar en vez de mandarlo vacío.
const CARGO = {
  id: true, memberId: true, membershipId: true, branchId: true, billingCycleId: true,
  chargeType: true, status: true, concept: true,
  subtotalCents: true, taxCents: true, discountCents: true, amountCents: true,
  allocatedCents: true, adjustedCents: true,
  periodStart: true, periodEnd: true, issuedAt: true, dueDate: true,
  idempotencyKey: true, voidReason: true, writeOffReason: true, createdAt: true,
} as const satisfies Record<keyof ChargeRecord, true>;

const PAGO = {
  id: true, memberId: true, branchId: true, method: true, status: true,
  amountCents: true, unappliedCents: true, idempotencyKey: true,
  externalRef: true, processorName: true, receivedAt: true, businessDate: true,
  cashSessionId: true, folio: true,
  reversesPaymentId: true, reversalReason: true, failureCode: true,
  failureReason: true, createdAt: true,
} as const satisfies Record<keyof PaymentRecord, true>;

/** Un pago con quién lo registró (`null` = el sistema: domiciliación, portal). */
export type PagoConAutor = PaymentRecord & { createdByUserId: string | null };
/** A qué cargo se aplicó un pago, con el concepto para leerlo sin abrir el cargo. */
export type Cobertura = { chargeId: string; concept: string; amountCents: bigint };

export type PaginaDe<T> = { items: T[]; total: number; nextCursor: string | null; hasMore: boolean };

const dia = (d: Date): string => d.toISOString().slice(0, 10);

export class StatementRepository extends TenantRepository {
  /** Cargos del socio, del vencimiento más reciente al más viejo; también anulados y condonados. */
  async chargesPage(memberId: string, limit: number, cursor: PartesDelCursor | null): Promise<PaginaDe<ChargeRecord>> {
    const desde = cursor ? new Date(`${cursor.orden.slice(0, 10)}T00:00:00.000Z`) : null;
    const [filas, total] = await Promise.all([
      this.db.charge.findMany({
        where: this.scope({
          memberId,
          ...(cursor && desde ? { OR: [{ dueDate: { lt: desde } }, { dueDate: desde, id: { lt: cursor.id } }] } : {}),
        }),
        select: CARGO,
        orderBy: [{ dueDate: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.db.charge.count({ where: this.scope({ memberId }) }),
    ]);
    return { ...cortarPagina(filas as ChargeRecord[], limit, (u) => armarCursor(dia(u.dueDate), u.id)), total };
  }

  /**
   * Los cargos con deuda que NO vienen en esa página (más viejos que su
   * último renglón): la primera respuesta del estado de cuenta los incluye
   * siempre, para que lo que se debe nunca quede escondido tras «Cargar más».
   */
  async debtOutside(memberId: string, yaVienen: readonly string[]): Promise<ChargeRecord[]> {
    const filas = await this.db.charge.findMany({
      where: this.scope({ memberId, status: { in: CON_DEUDA }, ...(yaVienen.length ? { id: { notIn: [...yaVienen] } } : {}) }),
      select: CARGO,
      orderBy: [{ dueDate: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return filas as ChargeRecord[];
  }

  /** Pagos y contra-asientos del socio, del más reciente al más viejo, en cualquier estado. */
  async paymentsPage(memberId: string, limit: number, cursor: PartesDelCursor | null): Promise<PaginaDe<PagoConAutor>> {
    const desde = cursor ? new Date(cursor.orden) : null;
    const [filas, total] = await Promise.all([
      this.db.payment.findMany({
        where: this.scope({
          memberId,
          ...(cursor && desde ? { OR: [{ receivedAt: { lt: desde } }, { receivedAt: desde, id: { lt: cursor.id } }] } : {}),
        }),
        select: { ...PAGO, createdByUserId: true },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.db.payment.count({ where: this.scope({ memberId }) }),
    ]);
    return { ...cortarPagina(filas as PagoConAutor[], limit, (u) => armarCursor(u.receivedAt.toISOString(), u.id)), total };
  }

  /**
   * D-18 (bloque 4.4): el día en que se dio por perdido cada cargo de la
   * lista (solo los que tienen marca y siguen debiéndose).
   */
  async lostOnFor(chargeIds: readonly string[]): Promise<Map<string, Date>> {
    if (chargeIds.length === 0) return new Map();
    const filas = await this.db.charge.findMany({
      where: this.scope({ id: { in: [...chargeIds] }, lostOn: { not: null }, status: { in: CON_DEUDA } }),
      select: { id: true, lostOn: true },
    });
    return new Map(filas.map((f) => [f.id, f.lostOn!]));
  }

  /** Los ajustes de varios cargos de una vez (descuentos, condonaciones, correcciones), en orden. */
  async adjustmentsFor(chargeIds: readonly string[]): Promise<Map<string, AdjustmentRecord[]>> {
    const out = new Map<string, AdjustmentRecord[]>();
    if (chargeIds.length === 0) return out;
    const filas = await this.db.chargeAdjustment.findMany({
      where: this.scope({ chargeId: { in: [...chargeIds] } }),
      select: {
        id: true, chargeId: true, adjustmentType: true, amountCents: true,
        reason: true, reasonCode: true, approvedByUserId: true, createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const a of filas as AdjustmentRecord[]) {
      const lista = out.get(a.chargeId);
      if (lista) lista.push(a); else out.set(a.chargeId, [a]);
    }
    return out;
  }

  /** Qué cubrió cada pago, con el concepto del cargo. En un contra-asiento va en negativo: lo que dejó de cubrir. */
  async coversFor(paymentIds: readonly string[]): Promise<Map<string, Cobertura[]>> {
    const out = new Map<string, Cobertura[]>();
    if (paymentIds.length === 0) return out;
    const filas = await this.db.paymentAllocation.findMany({
      where: this.scope({ paymentId: { in: [...paymentIds] } }),
      select: { paymentId: true, chargeId: true, amountCents: true, charge: { select: { concept: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const a of filas) {
      const lista = out.get(a.paymentId) ?? [];
      const ya = lista.find((c) => c.chargeId === a.chargeId);
      if (ya) ya.amountCents += a.amountCents;
      else lista.push({ chargeId: a.chargeId, concept: a.charge.concept, amountCents: a.amountCents });
      out.set(a.paymentId, lista);
    }
    return out;
  }

  /** Nombres del personal (quién cobró, quién autorizó): el estado de cuenta dice personas, no ids. */
  /** Quién registró UN pago, por nombre (para el comprobante, 3-05); `null` si fue el sistema o la cuenta ya no existe. */
  async collectorOf(paymentId: string): Promise<string | null> {
    const pago = await this.db.payment.findFirst({ where: this.scope({ id: paymentId }), select: { createdByUserId: true } });
    if (!pago?.createdByUserId) return null;
    return (await this.staffNames([pago.createdByUserId])).get(pago.createdByUserId) ?? null;
  }

  async staffNames(ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
    const unicos = [...new Set(ids.filter((x): x is string => !!x))];
    if (unicos.length === 0) return new Map();
    const us = await this.db.user.findMany({ where: { id: { in: unicos }, organizationId: this.organizationId }, select: { id: true, fullName: true } });
    return new Map(us.map((u) => [u.id, u.fullName]));
  }
}
