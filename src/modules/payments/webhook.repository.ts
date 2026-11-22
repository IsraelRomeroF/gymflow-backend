import { uuidv7 } from '@gymflow/core';
import { PrismaWebhookEventStatus } from '@gymflow/db';
import { GlobalRepository } from '../../platform/db/tenant-repository.js';
import { Prisma } from '@gymflow/db';

const S = PrismaWebhookEventStatus;

export type WebhookRecord = {
  id: string;
  organizationId: string | null;
  provider: string;
  providerEventId: string;
  eventType: string;
  rawPayload: unknown;
  signatureStatus: string;
  status: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED' | 'DEAD_LETTER';
  processAttempts: number;
  receivedAt: Date;
};

const SELECT = {
  id: true, organizationId: true, provider: true, providerEventId: true,
  eventType: true, rawPayload: true, signatureStatus: true, status: true,
  processAttempts: true, receivedAt: true,
} as const;

const MAX_PROCESS_ATTEMPTS = 5;

/**
 * Eventos del procesador.
 *
 * Es un `GlobalRepository` y no uno de tenant: **el evento llega antes de
 * saber de quién es**. Forzar un organizationId aquí obligaría a adivinarlo
 * en el borde, que es donde menos información hay.
 */
export class WebhookRepository extends GlobalRepository {
  /**
   * Guarda el evento crudo. Devuelve `null` si ya se había recibido.
   *
   * La deduplicación es del índice único, no de una consulta previa: dos
   * reenvíos simultáneos del proveedor pasarían los dos por la rendija entre
   * consultar e insertar.
   */
  async ingest(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    rawPayload: unknown;
    signatureValid: boolean;
    providerCreatedAt: Date | null;
  }): Promise<WebhookRecord | null> {
    /**
     * Solo un evento con firma VÁLIDA ocupa su `providerEventId`. Antes uno
     * sin firma con el id de un pago real "llegaba primero" y el legítimo se
     * descartaba como duplicado (SEC-05). Los inválidos se guardan para
     * investigar, con un id propio que no choca con nada, y la retención
     * los purga.
     */
    const eventId = input.signatureValid ? input.providerEventId : `invalid:${uuidv7()}:${input.providerEventId}`.slice(0, 200);
    if (input.signatureValid) {
      const existing = await this.db.webhookEvent.findFirst({
        where: { provider: input.provider, providerEventId: eventId },
        select: SELECT,
      });
      if (existing) return null;
    }

    try {
      const row = await this.db.webhookEvent.create({
        data: {
          id: uuidv7(),
          provider: input.provider,
          providerEventId: eventId,
          eventType: input.eventType,
          rawPayload: input.rawPayload as Prisma.InputJsonValue,
          signatureStatus: input.signatureValid ? 'VALID' : 'INVALID',
          providerCreatedAt: input.providerCreatedAt,
          // Una firma inválida se GUARDA y se marca. Descartarla sin registro
          // deja sin rastro justo el evento que hay que investigar.
          status: input.signatureValid ? S.RECEIVED : S.FAILED,
          lastError: input.signatureValid ? null : 'Firma inválida',
        },
        select: SELECT,
      });
      return row as WebhookRecord;
    } catch {
      return null;
    }
  }

  /** RETENCIÓN: los de firma inválida solo sirven unos días para investigar. */
  async purgeInvalidBefore(antes: Date): Promise<number> {
    const { count } = await this.db.webhookEvent.deleteMany({
      where: { signatureStatus: 'INVALID', receivedAt: { lt: antes } },
    });
    return count;
  }

  /**
   * Eventos válidos de UNA organización, por atender. Antes la cola era
   * global: 100 eventos de otra organización o inaplicables al frente la
   * atascaban para siempre, porque siempre eran los primeros 100.
   */
  async pending(organizationId: string, limit: number): Promise<WebhookRecord[]> {
    const rows = await this.db.webhookEvent.findMany({
      where: { status: S.RECEIVED, signatureStatus: 'VALID', organizationId },
      select: SELECT,
      orderBy: { receivedAt: 'asc' },
      take: limit,
    });
    return rows as WebhookRecord[];
  }

  /** Válidos que todavía no se sabe de qué organización son. */
  /** Por cursor: los que no se pueden atribuir aún siguen ahí y no deben tapar a los de atrás. */
  async unattributed(limit: number, afterId: string | null): Promise<WebhookRecord[]> {
    const rows = await this.db.webhookEvent.findMany({
      where: {
        status: S.RECEIVED, signatureStatus: 'VALID', organizationId: null,
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: SELECT,
      // uuidv7: el id ya viene en orden de llegada.
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows as WebhookRecord[];
  }

  /**
   * La organización dueña del pago al que se refiere el procesador. El
   * webhook llega sin sesión ni tenant: solo la referencia del pago lo ata.
   */
  async organizationForProviderPayment(providerPaymentId: string): Promise<string | null> {
    const pago = await this.db.payment.findFirst({
      where: { externalRef: providerPaymentId }, select: { organizationId: true },
    });
    return pago?.organizationId ?? null;
  }

  async attribute(id: string, organizationId: string): Promise<void> {
    await this.db.webhookEvent.update({ where: { id }, data: { organizationId } });
  }

  async markProcessed(id: string, organizationId: string | null): Promise<void> {
    await this.db.webhookEvent.update({
      where: { id },
      data: { status: S.PROCESSED, organizationId, processedAt: new Date() },
    });
  }

  async markIgnored(id: string, why: string): Promise<void> {
    await this.db.webhookEvent.update({
      where: { id },
      data: { status: S.IGNORED, lastError: why, processedAt: new Date() },
    });
  }

  /**
   * Un fallo reintenta; al quinto, va a la bandeja muerta.
   *
   * Lo importante es que NO desaparece: un evento que se descarta en silencio
   * es un pago que el sistema nunca supo que ocurrió.
   */
  async markFailed(id: string, error: string): Promise<void> {
    const current = await this.db.webhookEvent.findUnique({
      where: { id }, select: { processAttempts: true },
    });
    const attempts = (current?.processAttempts ?? 0) + 1;
    await this.db.webhookEvent.update({
      where: { id },
      data: {
        processAttempts: attempts,
        lastError: error,
        status: attempts >= MAX_PROCESS_ATTEMPTS ? S.DEAD_LETTER : S.RECEIVED,
      },
    });
  }

  async deadLetters(limit = 50): Promise<WebhookRecord[]> {
    const rows = await this.db.webhookEvent.findMany({
      where: { status: S.DEAD_LETTER }, select: SELECT,
      orderBy: { receivedAt: 'desc' }, take: limit,
    });
    return rows as WebhookRecord[];
  }
}
