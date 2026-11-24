import { createHash, randomInt } from 'node:crypto';
import { uuidv7 } from '@gymflow/core';
import { COACH_CODE } from '@gymflow/core/contracts';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';

/**
 * EL CÓDIGO DE «HACERME SU COACH» (D-29, fase 3, bloque 3.8).
 *
 * Tablas propias: `coach_link_codes` y `coach_link_attempts`. El código en
 * claro solo existe en la pantalla del socio: aquí se guarda su huella
 * (`liveKey`) mientras está vivo, y se borra al usarse, anularse o caducar.
 */
export class CoachLinkRepository extends TenantRepository {
  /** La huella lleva el gimnasio: el mismo código en dos gimnasios no choca ni se cruza. */
  private huella(code: string): string {
    return createHash('sha256').update(`coach-link:${this.organizationId}:${code}`).digest('hex');
  }

  /**
   * Un código nuevo para el socio. Anula el que tuviera vivo (uno a la vez) y
   * limpia los caducados del gimnasio, para que su huella no estorbe a otro.
   */
  async issue(memberId: string, now: Date): Promise<{ code: string; expiresAt: Date }> {
    await this.db.coachLinkCode.updateMany({
      where: this.scope({ liveKey: { not: null }, OR: [{ memberId }, { expiresAt: { lte: now } }] }),
      data: { liveKey: null, revokedAt: now },
    });
    const expiresAt = new Date(now.getTime() + COACH_CODE.minutes * 60_000);
    for (let intento = 0; intento < 8; intento++) {
      const code = String(randomInt(0, 10 ** COACH_CODE.digits)).padStart(COACH_CODE.digits, '0');
      try {
        await this.db.coachLinkCode.create({
          data: { id: uuidv7(), organizationId: this.organizationId, memberId, liveKey: this.huella(code), expiresAt, createdAt: now },
        });
        return { code, expiresAt };
      } catch (err) {
        // Otro socio del gimnasio tiene ese mismo código vivo: se sortea otro.
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw new Error('No se pudo generar un código libre');
  }

  /** El código vivo que coincide, si lo hay y no ha caducado. */
  async findLive(code: string, now: Date): Promise<{ id: string; memberId: string } | null> {
    return this.db.coachLinkCode.findFirst({
      where: this.scope({ liveKey: this.huella(code), usedAt: null, revokedAt: null, expiresAt: { gt: now } }),
      select: { id: true, memberId: true },
    });
  }

  /** Un solo uso: se quema al teclearlo bien, haya o no servido para ligar. */
  async burn(id: string, userId: string, now: Date): Promise<boolean> {
    const { count } = await this.db.coachLinkCode.updateMany({
      where: this.scope({ id, liveKey: { not: null } }),
      data: { liveKey: null, usedAt: now, usedByUserId: userId },
    });
    return count === 1;
  }

  /**
   * Un coach a la vez por su cuenta: contar los fallos y anotar el nuevo no se
   * pisan entre dos peticiones simultáneas. Se suelta al confirmar la transacción.
   */
  async lockAttempts(userId: string): Promise<void> {
    await this.db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`coach-link:${userId}`}, 0))`;
  }

  /** Los fallos de este coach dentro de la ventana, del más reciente al más viejo. */
  async recentFailures(userId: string, now: Date): Promise<Date[]> {
    const desde = new Date(now.getTime() - COACH_CODE.windowMinutes * 60_000);
    const filas = await this.db.coachLinkAttempt.findMany({
      where: this.scope({ userId, succeeded: false, createdAt: { gt: desde } }),
      orderBy: { createdAt: 'desc' }, take: COACH_CODE.maxFailures, select: { createdAt: true },
    });
    return filas.map((f) => f.createdAt);
  }

  async recordAttempt(userId: string, succeeded: boolean, now: Date): Promise<void> {
    await this.db.coachLinkAttempt.create({ data: { id: uuidv7(), organizationId: this.organizationId, userId, succeeded, createdAt: now } });
  }
}
