import { GlobalRepository } from '../../platform/db/tenant-repository.js';

/**
 * QUÉ AVISOS APAGÓ CADA PERSONA EN SU TELÉFONO (fase 4, bloque 4.2; D-05:
 * «cada aviso se puede apagar»). Sin fila, encendido. Apagar no borra el
 * aviso: deja de sonar en el teléfono y sigue saliendo dentro del panel.
 *
 * Global como las suscripciones: se pregunta por persona, no por pantalla.
 */
export class PushPreferenceRepository extends GlobalRepository {
  /** Los tipos que esta persona tiene apagados. */
  async apagados(userId: string): Promise<Set<string>> {
    const filas = await this.db.pushPreference.findMany({ where: { userId, enabled: false }, select: { kind: true } });
    return new Set(filas.map((f) => f.kind));
  }

  /** De estas personas, quiénes tienen apagado este tipo. */
  async quienesLoApagaron(organizationId: string, userIds: readonly string[], kind: string): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const filas = await this.db.pushPreference.findMany({ where: { organizationId, kind, enabled: false, userId: { in: [...userIds] } }, select: { userId: true } });
    return new Set(filas.map((f) => f.userId));
  }

  /** Enciende o apaga un tipo. Devuelve si cambió algo (para no asentar un toque que no cambió nada). */
  async guardar(input: { organizationId: string; userId: string; kind: string; enabled: boolean }): Promise<boolean> {
    const antes = await this.db.pushPreference.findUnique({ where: { userId_kind: { userId: input.userId, kind: input.kind } }, select: { enabled: true } });
    if ((antes?.enabled ?? true) === input.enabled) return false;
    await this.db.pushPreference.upsert({
      where: { userId_kind: { userId: input.userId, kind: input.kind } },
      create: { userId: input.userId, kind: input.kind, organizationId: input.organizationId, enabled: input.enabled },
      update: { enabled: input.enabled, updatedAt: new Date() },
    });
    return true;
  }
}
