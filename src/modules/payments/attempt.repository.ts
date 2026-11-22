import { uuidv7 } from '@gymflow/core';
import { PrismaPaymentAttemptOutcome } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { Prisma } from '@gymflow/db';

const O = PrismaPaymentAttemptOutcome;

export type AttemptOutcome = 'SUCCESS' | 'SOFT_DECLINE' | 'HARD_DECLINE' | 'AUTH_REQUIRED' | 'ERROR' | 'UNKNOWN';

export type AttemptRecord = {
  id: string;
  memberId: string;
  paymentId: string | null;
  chargeId: string | null;
  attemptNumber: number;
  idempotencyKey: string;
  outcome: AttemptOutcome | null;
  providerCode: string | null;
  providerMessage: string | null;
  attemptedAt: Date;
  resolvedAt: Date | null;
};

const SELECT = {
  id: true, memberId: true, paymentId: true, chargeId: true, attemptNumber: true,
  idempotencyKey: true, outcome: true, providerCode: true, providerMessage: true,
  attemptedAt: true, resolvedAt: true,
} as const;

/**
 * Intentos contra el procesador.
 *
 * El orden de este repositorio es el sprint entero en miniatura: **se escribe
 * la fila, y solo entonces se llama**. Al revés, un proceso que muere entre
 * la llamada y la respuesta deja dinero movido sin rastro de que se movió.
 */
export class AttemptRepository extends TenantRepository {
  async open(input: {
    memberId: string; chargeId: string | null; attemptNumber: number; idempotencyKey: string;
  }): Promise<AttemptRecord | null> {
    try {
      const row = await this.db.paymentAttempt.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          memberId: input.memberId,
          chargeId: input.chargeId,
          attemptNumber: input.attemptNumber,
          idempotencyKey: input.idempotencyKey,
        },
        select: SELECT,
      });
      return row as AttemptRecord;
    } catch (err) {
      // Otro proceso ya abrió ESTE intento. No es un error: es la carrera que
      // la clave derivada existe para ganar sin cobrar dos veces.
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async resolve(id: string, input: {
    outcome: AttemptOutcome;
    paymentId?: string | null;
    providerCode?: string | null;
    providerMessage?: string | null;
    rawResponse?: unknown;
  }): Promise<void> {
    await this.db.paymentAttempt.updateMany({
      where: this.scope({ id }),
      data: {
        outcome: O[input.outcome],
        paymentId: input.paymentId ?? null,
        providerCode: input.providerCode ?? null,
        providerMessage: input.providerMessage ?? null,
        rawResponse: input.rawResponse == null ? Prisma.JsonNull : (input.rawResponse as Prisma.InputJsonValue),
        resolvedAt: new Date(),
      },
    });
  }

  async findByKey(key: string): Promise<AttemptRecord | null> {
    const row = await this.db.paymentAttempt.findFirst({
      where: this.scope({ idempotencyKey: key }), select: SELECT,
    });
    return row as AttemptRecord | null;
  }

  async listForCharge(chargeId: string): Promise<AttemptRecord[]> {
    const rows = await this.db.paymentAttempt.findMany({
      where: this.scope({ chargeId }),
      select: SELECT,
      orderBy: { attemptNumber: 'asc' },
    });
    return rows as AttemptRecord[];
  }

  /** Intentos sin resolver: el insumo de la reconsulta que cierra los UNKNOWN. */
  async unresolved(limit: number): Promise<AttemptRecord[]> {
    const rows = await this.db.paymentAttempt.findMany({
      where: this.scope({ OR: [{ outcome: null }, { outcome: O.UNKNOWN }] }),
      select: SELECT,
      orderBy: { attemptedAt: 'asc' },
      take: limit,
    });
    return rows as AttemptRecord[];
  }
}
