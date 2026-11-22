import type { Grant, RoleLimits } from '@gymflow/core';
import { GlobalRepository } from '../../platform/db/tenant-repository.js';

/**
 * Resuelve las concesiones efectivas de un usuario: el producto cartesiano
 * de sus asignaciones de rol vigentes por los permisos de cada rol.
 *
 * `branchId` NULL en la asignación significa alcance organizacional.
 */
export class GrantRepository extends GlobalRepository {
  async grantsForUser(userId: string): Promise<Grant[]> {
    const rows = await this.db.$queryRaw<Array<{ permission: string; branchId: string | null }>>`
      SELECT rp."permissionKey" AS permission, ra."branchId" AS "branchId"
      FROM role_assignments ra
      JOIN role_permissions rp ON rp."roleId" = ra."roleId"
      WHERE ra."userId" = ${userId}::uuid AND ra."revokedAt" IS NULL`;
    return rows.map((r) => ({ permission: r.permission, branchId: r.branchId }));
  }

  /** Claves de los roles vigentes del usuario (OWNER, MANAGER…). */
  async roleKeysForUser(userId: string): Promise<string[]> {
    const rows = await this.db.$queryRaw<Array<{ key: string }>>`
      SELECT DISTINCT r.key FROM role_assignments ra JOIN roles r ON r.id = ra."roleId"
      WHERE ra."userId" = ${userId}::uuid AND ra."revokedAt" IS NULL`;
    return rows.map((r) => r.key);
  }

  /**
   * Límites efectivos: el MÁS PERMISIVO de los roles asignados. Si algún rol
   * no define un límite (NULL), ese eje queda sin límite.
   */
  async limitsForUser(userId: string, organizationId: string): Promise<RoleLimits> {
    const rows = await this.db.$queryRaw<Array<Record<string, number | bigint | null>>>`
      SELECT rls."maxDiscountPercent", rls."maxWaiverAmountCents",
             rls."maxManualBalanceAdjustCents", rls."maxCashWithdrawalCents",
             rls."maxRefundAmountCents", rls."maxManualAccessGrantsPerShift",
             rls."maxPosVoidsPerShift"
      FROM role_assignments ra
      JOIN role_limit_sets rls
        ON rls."roleId" = ra."roleId" AND rls."organizationId" = ${organizationId}::uuid
      WHERE ra."userId" = ${userId}::uuid AND ra."revokedAt" IS NULL`;

    return mergeLimits(rows);
  }
}

/** Una fila por rol asignado con sus topes; los importes pueden venir como texto (JSON). */
export type LimitRow = Record<string, number | bigint | string | null>;

/**
 * El tope efectivo es el MÁS PERMISIVO de los roles asignados; un rol sin
 * tope (NULL) deja ese eje sin límite. Es una función pura para que la
 * autenticación en una sola consulta (OPT3-03) y `limitsForUser` den lo mismo.
 */
export function mergeLimits(rows: readonly LimitRow[]): RoleLimits {
  if (rows.length === 0) return ZERO_LIMITS;
  const pickNumber = (key: string): number | null => {
    let best: number | null = 0;
    for (const row of rows) {
      const v = row[key];
      if (v === null || v === undefined) return null; // sin límite gana
      best = Math.max(best ?? 0, Number(v));
    }
    return best;
  };
  const pickBigInt = (key: string): bigint | null => {
    let best: bigint | null = 0n;
    for (const row of rows) {
      const v = row[key];
      if (v === null || v === undefined) return null;
      const asBig = typeof v === 'bigint' ? v : typeof v === 'string' ? BigInt(v) : BigInt(Math.trunc(v));
      best = asBig > (best ?? 0n) ? asBig : best;
    }
    return best;
  };
  return {
    maxDiscountPercent: pickNumber('maxDiscountPercent'),
    maxWaiverAmountCents: pickBigInt('maxWaiverAmountCents'),
    maxManualBalanceAdjustCents: pickBigInt('maxManualBalanceAdjustCents'),
    maxCashWithdrawalCents: pickBigInt('maxCashWithdrawalCents'),
    maxRefundAmountCents: pickBigInt('maxRefundAmountCents'),
    maxManualAccessGrantsPerShift: pickNumber('maxManualAccessGrantsPerShift'),
    maxPosVoidsPerShift: pickNumber('maxPosVoidsPerShift'),
  };
}

/** Sin configuración explícita se asume lo más restrictivo, no lo más laxo. */
const ZERO_LIMITS: RoleLimits = {
  maxDiscountPercent: 0,
  maxWaiverAmountCents: 0n,
  maxManualBalanceAdjustCents: 0n,
  maxCashWithdrawalCents: 0n,
  maxRefundAmountCents: 0n,
  maxManualAccessGrantsPerShift: null,
  maxPosVoidsPerShift: null,
};
