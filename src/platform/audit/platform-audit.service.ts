import { PlatformAuditRepository, platformActorOf, verifyPlatformChain, type PlatformAuditEntry, type PlatformChainCursor, type PlatformChainVerification } from './platform-audit.repository.js';

/** Quién de la plataforma actúa: sale de `request.platform` y de la petición. */
export type PlatformActor = {
  userId: string | null;
  sessionId?: string | null | undefined;
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
  requestId?: string | null | undefined;
};

export type PlatformAuditInput = {
  /** Siempre `platform.…`; la frase vive en `@gymflow/core` (`AUDIT_LABELS`). */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  /** La marca a la que se refiere, si la hay y el acto NO se asienta ya en su cadena. */
  organizationId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  reason?: string | null;
};

/**
 * Bitácora de la PLATAFORMA (24-19, 23-09). Dos caminos, una sola cadena:
 *
 *  - Lo que GymFlow hace SOBRE UNA MARCA se sigue asentando como siempre, con
 *    `AuditService.record(systemContext(organizationId), { action: 'platform.…' })`:
 *    el espejo en esta cadena se escribe solo, enlazado y en la misma transacción.
 *  - Lo que pasa SOLO EN LA CONSOLA (entrar, reconfirmar, cambiar su contraseña,
 *    planes y precios de GymFlow) se asienta con `record` de esta clase.
 */
export class PlatformAuditService {
  private readonly repo = new PlatformAuditRepository();

  record(actor: PlatformActor, input: PlatformAuditInput): Promise<{ id: string; hash: string }> {
    if (!input.action.startsWith('platform.')) throw new Error(`La cadena de plataforma solo asienta acciones platform.*: ${input.action}`);
    return this.repo.append({
      actorUserId: actor.userId,
      action: input.action,
      organizationId: input.organizationId ?? null,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      beforeState: input.beforeState,
      afterState: input.afterState,
      reason: input.reason ?? null,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      sessionId: actor.sessionId ?? null,
      requestId: actor.requestId ?? null,
    });
  }

  list(opts: Parameters<PlatformAuditRepository['list']>[0]): Promise<PlatformAuditEntry[]> {
    return this.repo.list(opts);
  }

  names(entries: readonly PlatformAuditEntry[]) {
    return this.repo.names(entries);
  }

  /** Recorre la cadena completa por tramos y la verifica eslabón por eslabón. */
  async verifyChain(pageSize = 1000): Promise<PlatformChainVerification> {
    let after: PlatformChainCursor | null = null;
    let prev: string | null = null;
    let checked = 0;
    for (;;) {
      const tramo = await this.repo.chainPage(after, pageSize);
      if (tramo.length === 0) return { ok: true, checked, lastHash: prev };
      const r = verifyPlatformChain(tramo, prev);
      if (!r.ok) return { ...r, checked: checked + r.checked };
      checked += r.checked;
      prev = r.lastHash;
      const ultimo = tramo.at(-1)!;
      after = { at: ultimo.at, id: ultimo.content.id, chainSeq: ultimo.chainSeq };
    }
  }

  /**
   * La verificación completa: la cadena y su enlace con las de las marcas.
   * `ok` solo si la cadena encadena, ningún espejo apunta a un asiento
   * borrado o alterado, y a ningún asiento `platform.*` posterior al inicio
   * de la cadena le falta su espejo.
   */
  async verify(): Promise<{
    ok: boolean; entries: number; brokenAtId: string | null; reason: string | null;
    links: { linked: number; broken: number; unmirrored: number; previous: number };
  }> {
    const [cadena, enlaces] = await Promise.all([this.verifyChain(), this.repo.links()]);
    const motivo = !cadena.ok ? cadena.reason
      : enlaces.broken.length > 0 ? 'un asiento de la cadena de plataforma apunta a un asiento de marca borrado o alterado'
        : enlaces.unmirrored.length > 0 ? 'hay asientos de plataforma en la cadena de una marca sin su espejo en la cadena de plataforma'
          : null;
    return {
      ok: motivo === null,
      entries: cadena.checked,
      brokenAtId: !cadena.ok ? cadena.brokenAtId : enlaces.broken[0]?.id ?? enlaces.unmirrored[0]?.id ?? null,
      reason: motivo,
      links: { linked: enlaces.linked, broken: enlaces.broken.length, unmirrored: enlaces.unmirrored.length, previous: enlaces.previous },
    };
  }

  /**
   * IMPORTAR LO ANTERIOR A LA CADENA: los asientos `platform.*` que ya estaban
   * en las cadenas de las marcas antes de que existiera esta. Entran en orden
   * cronológico, enlazados con su asiento de marca y con `occurredAt` = cuándo
   * pasaron. Idempotente: lo ya importado no se repite.
   */
  async importPrevious(): Promise<{ imported: number }> {
    let imported = 0;
    for (;;) {
      const lote = await this.repo.sinEspejo(500);
      if (lote.length === 0) return { imported };
      for (const a of lote) {
        await this.repo.append({
          actorUserId: platformActorOf(a.afterState),
          action: a.action, organizationId: a.organizationId, resourceType: a.resourceType, resourceId: a.resourceId,
          beforeState: a.beforeState, afterState: a.afterState, reason: a.reason,
          organizationAuditId: a.id, organizationAuditHash: a.hash, occurredAt: a.at,
        });
        imported++;
      }
    }
  }
}
