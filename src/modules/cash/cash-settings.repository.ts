import { TOPE_FONDO_Y_GASTO_CHICO_CENTS, TOPE_RETIRO_POR_TURNO_CENTS } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

/** Los topes del cajón de un gimnasio (D-15, bloque 3.5). Sin fila valen los del núcleo: $500 y $5,000. */
export type TopesDelCajon = { pettyLimitCents: bigint; withdrawalShiftLimitCents: bigint; isDefault: boolean };

export class CashSettingsRepository extends TenantRepository {
  async get(): Promise<TopesDelCajon> {
    const fila = await this.db.cashSettings.findUnique({
      where: { organizationId: this.organizationId }, select: { pettyLimitCents: true, withdrawalShiftLimitCents: true },
    });
    return fila
      ? { ...fila, isDefault: false }
      : { pettyLimitCents: TOPE_FONDO_Y_GASTO_CHICO_CENTS, withdrawalShiftLimitCents: TOPE_RETIRO_POR_TURNO_CENTS, isDefault: true };
  }

  async set(input: { pettyLimitCents: bigint; withdrawalShiftLimitCents: bigint; userId: string | null }): Promise<TopesDelCajon> {
    const datos = { pettyLimitCents: input.pettyLimitCents, withdrawalShiftLimitCents: input.withdrawalShiftLimitCents, updatedByUserId: input.userId };
    const fila = await this.db.cashSettings.upsert({
      where: { organizationId: this.organizationId },
      create: { organizationId: this.organizationId, ...datos },
      update: datos,
      select: { pettyLimitCents: true, withdrawalShiftLimitCents: true },
    });
    return { ...fila, isDefault: false };
  }
}
