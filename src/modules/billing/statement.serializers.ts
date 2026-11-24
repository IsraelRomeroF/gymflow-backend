import type { SettledBy, StatementCharge, StatementPayment } from '@gymflow/core/contracts';
import type { AdjustmentRecord, ChargeRecord } from './charge.repository.js';
import { cents, serializeAdjustment, serializeCharge, serializePayment } from './billing.serializers.js';
import type { Cobertura, PagoConAutor } from './statement.repository.js';

/**
 * CÓMO QUEDÓ SALDADO un cargo (3-06). El estado dice `PAID` tanto si el socio
 * pagó como si se le perdonó todo: una condonación total deja el cargo PAID,
 * no WRITTEN_OFF. Aquí se mira con qué se cubrió, y panel, portal y descarga
 * dicen la misma palabra (`COMO_SE_SALDO` del vocabulario).
 *
 * `null` mientras deba algo, o si se anuló: un cargo anulado nunca existió.
 */
export function comoSeSaldo(
  c: Pick<ChargeRecord, 'status' | 'allocatedCents' | 'adjustedCents' | 'discountCents'>,
  ajustes: ReadonlyArray<Pick<AdjustmentRecord, 'adjustmentType'>>,
): SettledBy | null {
  if (c.status === 'WRITTEN_OFF') return 'WAIVER';
  if (c.status !== 'PAID') return null;
  const pagado = c.allocatedCents > 0n;
  const ajustado = c.adjustedCents > 0n;
  if (pagado) return ajustado ? 'MIXED' : 'PAYMENT';
  if (ajustado) {
    if (ajustes.some((a) => a.adjustmentType === 'WAIVER')) return 'WAIVER';
    // Solo correcciones (el crédito al cambiar de plan): ni pagó ni se le perdonó.
    return ajustes.some((a) => a.adjustmentType === 'DISCOUNT') || ajustes.length === 0 ? 'DISCOUNT' : 'CORRECTION';
  }
  // Nació en cero: una cortesía con descuento del 100 % al venderla.
  return c.discountCents > 0n ? 'DISCOUNT' : 'PAYMENT';
}

/** Un cargo del estado de cuenta: el cargo, cómo quedó saldado y sus ajustes con quien los autorizó. */
export function serializeStatementCharge(
  c: ChargeRecord, ajustes: readonly AdjustmentRecord[], nombres: ReadonlyMap<string, string>,
  /** D-18 (4.4): el día en que se dio por perdido, si pasó y se sigue debiendo. */
  lostOn: Date | null = null,
): StatementCharge {
  return {
    ...serializeCharge(c),
    settledBy: comoSeSaldo(c, ajustes),
    lostOn: lostOn ? lostOn.toISOString().slice(0, 10) : null,
    adjustments: ajustes.map((a) => ({
      ...serializeAdjustment(a),
      approvedByName: a.approvedByUserId ? nombres.get(a.approvedByUserId) ?? null : null,
    })),
  };
}

/** Un pago del estado de cuenta: el pago, quién lo cobró y qué cargos cubrió (3-05). */
export function serializeStatementPayment(p: PagoConAutor, cubre: readonly Cobertura[], nombres: ReadonlyMap<string, string>): StatementPayment {
  return {
    ...serializePayment(p),
    collectedByUserId: p.createdByUserId,
    collectedByName: p.createdByUserId ? nombres.get(p.createdByUserId) ?? null : null,
    covers: cubre.map((x) => ({ chargeId: x.chargeId, concept: x.concept, amountCents: cents(x.amountCents) })),
  };
}
