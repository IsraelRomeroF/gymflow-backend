import { ACTIONS_REQUIRING_REASON, validation, verifyAuditChain, type AuditActorType, type ChainVerification } from '@gymflow/core';
import { AuditRepository, type AuditEntry, type AuditListOptions } from './audit.repository.js';
import type { RequestContext } from '../context.js';
import { BusinessCalendar } from '../time/business-calendar.js';
import { olvidarTableros } from '../cache.js';

export type AuditInput = {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  reason?: string | null;
  approvedByUserId?: string | null;
  branchId?: string | null;
};

/**
 * Escritura de bitácora. Es PRODUCTO, no log técnico (ADR-018): lo que se
 * guarda aquí es lo que el dueño va a leer para responder "¿qué descuentos
 * aplicó Juan este mes y por qué?".
 */
export class AuditService {
  private readonly repo = new AuditRepository();

  async record(ctx: RequestContext, input: AuditInput): Promise<{ id: string; hash: string }> {
    // El motivo no es opcional en operaciones sensibles, aunque el permiso
    // no lo exija: la lista vive en el dominio y se comprueba aquí también.
    if (ACTIONS_REQUIRING_REASON.has(input.action) && !input.reason?.trim()) {
      throw validation(`La acción ${input.action} exige un motivo`);
    }

    const branchId = input.branchId ?? ctx.tenant.branchScopeHint ?? null;
    const businessDate = await new BusinessCalendar(ctx.tenant.organizationId).today(branchId);

    // Todo lo que mueve dinero o socios deja bitácora: es el momento de tirar
    // los tableros guardados de esta organización para que quien acaba de
    // cobrar no vea un "Cobrado hoy" de hace medio minuto. Dos veces: ahora y
    // tras confirmarse la transacción en la que suele ir el asiento.
    olvidarTableros(ctx.tenant.organizationId);
    setTimeout(() => olvidarTableros(ctx.tenant.organizationId), 1_500).unref();

    return this.repo.append({
      organizationId: ctx.tenant.organizationId,
      branchId,
      actorUserId: ctx.tenant.actorUserId ?? null,
      actorType: ctx.tenant.actorType as AuditActorType,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      beforeState: input.beforeState,
      afterState: input.afterState,
      reason: input.reason ?? null,
      approvedByUserId: input.approvedByUserId ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      sessionId: ctx.tenant.sessionId ?? null,
      requestId: ctx.requestId,
      // Fecha de negocio en la zona de la SUCURSAL, no del servidor.
      businessDate,
    });
  }

  list(organizationId: string, opts: AuditListOptions): Promise<AuditEntry[]> {
    return this.repo.list(organizationId, opts);
  }

  names(organizationId: string, entries: readonly AuditEntry[]) {
    return this.repo.names(organizationId, entries);
  }

  /** Quién ha escrito en la bitácora en el periodo: el filtro «Persona» (20-12). */
  actors(organizationId: string, opts: Parameters<AuditRepository['actors']>[1]) {
    return this.repo.actors(organizationId, opts);
  }

  /** Entradas por excepción resumidas por persona, día y sede (20-06). */
  exceptionSummary(organizationId: string, opts: Parameters<AuditRepository['exceptionSummary']>[1]) {
    return this.repo.exceptionSummary(organizationId, opts);
  }

  /** Las sedes de la organización con su nombre y su zona: el CSV las necesita (20-09). */
  branches(organizationId: string) {
    return this.repo.branches(organizationId);
  }

  /** Recorre la cadena completa por tramos y la verifica eslabón por eslabón. */
  async verifyChain(organizationId: string, pageSize = 1000): Promise<ChainVerification> {
    let after: { at: Date; id: string } | null = null;
    let prev: string | null = null;
    let checked = 0;
    for (;;) {
      const tramo = await this.repo.chainPage(organizationId, after, pageSize);
      if (tramo.length === 0) return { ok: true, checked, lastHash: prev };
      const r = verifyAuditChain(tramo, prev);
      if (!r.ok) return { ...r, checked: checked + r.checked };
      checked += r.checked;
      prev = r.lastHash;
      const ultimo = tramo.at(-1)!;
      after = { at: ultimo.at, id: ultimo.content.id };
    }
  }
}
