import { isValidLast4, uuidv7, validation } from '@gymflow/core';
import { PrismaPaymentMethodStatus } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

const S = PrismaPaymentMethodStatus;

export type PaymentMethodRecord = {
  id: string;
  memberId: string;
  provider: string;
  providerTokenRef: string;
  providerCustomerId: string | null;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
  consentId: string | null;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  createdAt: Date;
  revokedAt: Date | null;
};

const SELECT = {
  id: true, memberId: true, provider: true, providerTokenRef: true,
  providerCustomerId: true, brand: true, last4: true, expMonth: true, expYear: true,
  isDefault: true, consentId: true, status: true, createdAt: true, revokedAt: true,
} as const;

export class PaymentMethodRepository extends TenantRepository {
  async listForMember(memberId: string): Promise<PaymentMethodRecord[]> {
    const rows = await this.db.paymentMethod.findMany({
      where: this.scope({ memberId }),
      select: SELECT,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return rows as PaymentMethodRecord[];
  }

  async defaultForMember(memberId: string): Promise<PaymentMethodRecord | null> {
    const row = await this.db.paymentMethod.findFirst({
      where: this.scope({ memberId, status: S.ACTIVE, isDefault: true }),
      select: SELECT,
    });
    return row as PaymentMethodRecord | null;
  }

  async findById(id: string): Promise<PaymentMethodRecord | null> {
    const row = await this.db.paymentMethod.findFirst({ where: this.scope({ id }), select: SELECT });
    return row as PaymentMethodRecord | null;
  }

  /**
   * Alta de la tarjeta. Lo que entra aquí es un TOKEN.
   *
   * La comprobación de `last4` no es defensiva por costumbre: es el único
   * campo de esta tabla en el que cabría un PAN si una integración futura se
   * equivocara de campo, y la base lo rechaza además con un CHECK.
   */
  async add(input: {
    memberId: string;
    provider: string;
    providerTokenRef: string;
    providerCustomerId: string | null;
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
    consentId: string | null;
    makeDefault: boolean;
  }): Promise<PaymentMethodRecord> {
    if (input.last4 !== null && !isValidLast4(input.last4)) {
      throw validation('`last4` debe ser exactamente cuatro dígitos');
    }

    return this.db.$transaction(async (tx) => {
      if (input.makeDefault) {
        // Se quita el anterior ANTES de poner el nuevo: el índice único
        // parcial no admite dos predeterminados vivos, y hacerlo al revés
        // fallaría con un error que no dice nada.
        await tx.paymentMethod.updateMany({
          where: this.scope({ memberId: input.memberId, isDefault: true }),
          data: { isDefault: false },
        });
      }

      const row = await tx.paymentMethod.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          memberId: input.memberId,
          provider: input.provider,
          providerTokenRef: input.providerTokenRef,
          providerCustomerId: input.providerCustomerId,
          brand: input.brand,
          last4: input.last4,
          expMonth: input.expMonth,
          expYear: input.expYear,
          consentId: input.consentId,
          isDefault: input.makeDefault,
        },
        select: SELECT,
      });
      return row as PaymentMethodRecord;
    });
  }

  /** Cancelar la domiciliación. Un clic, sin pasar por recepción. */
  async revoke(id: string, reason: string): Promise<boolean> {
    const { count } = await this.db.paymentMethod.updateMany({
      where: this.scope({ id, status: S.ACTIVE }),
      data: { status: S.REVOKED, revokedAt: new Date(), revokedReason: reason, isDefault: false },
    });
    return count > 0;
  }

  /** ARCO (PS-08): ninguna tarjeta viva tras la cancelación; un token vivo es un cobro posible a alguien "borrado". */
  async revokeAllForMember(memberId: string, reason: string): Promise<number> {
    const { count } = await this.db.paymentMethod.updateMany({
      where: this.scope({ memberId, status: S.ACTIVE }),
      data: { status: S.REVOKED, revokedAt: new Date(), revokedReason: reason, isDefault: false },
    });
    return count;
  }

  async markExpired(id: string): Promise<void> {
    await this.db.paymentMethod.updateMany({
      where: this.scope({ id, status: S.ACTIVE }),
      data: { status: S.EXPIRED, isDefault: false },
    });
  }

  /** Tarjetas vivas que vencen dentro de la ventana de aviso. */
  async expiringBefore(year: number, month: number): Promise<PaymentMethodRecord[]> {
    const rows = await this.db.$queryRaw<PaymentMethodRecord[]>`
      SELECT "id", "memberId", "provider", "providerTokenRef", "providerCustomerId",
             "brand", "last4", "expMonth", "expYear", "isDefault", "consentId",
             "status"::text AS "status", "createdAt", "revokedAt"
      FROM "payment_methods"
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "status" = 'ACTIVE'
        AND "expYear" IS NOT NULL
        AND ("expYear" * 100 + "expMonth") <= ${year * 100 + month}
      ORDER BY "expYear" ASC, "expMonth" ASC`;
    return rows;
  }
}
