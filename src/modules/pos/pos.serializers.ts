import { z } from 'zod';
import { formatMoney, money } from '@gymflow/core';
import type { ProductRecord } from './product.repository.js';
import type { PosSaleLineRecord, PosSaleRecord } from './pos-sale.repository.js';

/** Lo que comparten las rutas del punto de venta: el parámetro `:id` y cómo se pinta un producto y una venta. */
export const idParam = z.object({ id: z.string().uuid() });
export const cents = (v: bigint): string => v.toString();

/**
 * `conCosto`: el costo solo viaja a quien administra el catálogo
 * (`pos:product:manage`). El mostrador vende sin saber cuánto deja cada cosa.
 */
export function serializeProduct(p: ProductRecord, conCosto = false) {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    priceCents: cents(p.priceCents),
    priceLabel: formatMoney(money(p.priceCents)),
    memberPriceCents: p.memberPriceCents === null ? null : cents(p.memberPriceCents),
    ...(conCosto ? { costCents: p.costCents === null ? null : cents(p.costCents) } : {}),
    tracksInventory: p.tracksInventory,
    isActive: p.isActive,
  };
}

export function serializeSale(s: PosSaleRecord, lines: PosSaleLineRecord[]) {
  return {
    id: s.id,
    branchId: s.branchId,
    cashSessionId: s.cashSessionId,
    memberId: s.memberId,
    status: s.status,
    totalCents: cents(s.totalCents),
    totalLabel: formatMoney(money(s.totalCents)),
    method: s.method,
    folio: s.folio,
    voidReason: s.voidReason,
    soldAt: s.soldAt.toISOString(),
    businessDate: s.businessDate.toISOString().slice(0, 10),
    lines: lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      unitPriceCents: cents(l.unitPriceCents),
      lineTotalCents: cents(l.lineTotalCents),
      priceKind: (l.priceKind === 'MEMBER' ? 'MEMBER' : 'PUBLIC') as 'PUBLIC' | 'MEMBER',
    })),
  };
}
