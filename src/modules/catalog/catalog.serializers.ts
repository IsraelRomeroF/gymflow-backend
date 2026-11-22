import type { PlanRecord } from './plan.repository.js';

/** Un plan como lo ve el panel: el dinero, a texto (ADR-005). */
export function serializePlan(p: PlanRecord) {
  return {
    ...p,
    priceCents: p.priceCents.toString(),
    signupFeeCents: p.signupFeeCents.toString(),
  };
}

/** Solo esas claves: lo que cambió, para la bitácora. */
export function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}
