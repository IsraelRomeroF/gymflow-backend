import { UNLIMITED_LIMITS, type Grant, type RoleLimits, type TenantContext } from '@gymflow/core';
import type { ModuleView } from './modules/module-state.js';

/**
 * Contexto del actor, resuelto SIEMPRE desde la sesión.
 * `branchScopeHint` es la sucursal activa en la UI: sirve para atribuir la
 * auditoría, NUNCA para decidir permisos (eso lo hace `can()` con el recurso).
 */
export type ResolvedTenant = TenantContext & { branchScopeHint: string | null };

export type RequestContext = {
  requestId: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
  tenant: ResolvedTenant;
  /** Los módulos activos del gimnasio y de cada sede, resueltos al entrar (ADR-036). */
  modules?: ModuleView | undefined;
  /**
   * Si quien llama es SOLO coach (2026-10-09): su id. Ve únicamente a sus
   * socios asignados; lo aplica `coach-scope` en cada ruta de socio.
   */
  coachOf?: string | undefined;
};

export function buildTenant(input: {
  organizationId: string;
  actorUserId: string;
  sessionId: string;
  grants: Grant[];
  limits: RoleLimits | null;
  branchScopeHint: string | null;
  requestId: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}): ResolvedTenant {
  return {
    organizationId: input.organizationId,
    actorType: 'USER',
    actorUserId: input.actorUserId,
    sessionId: input.sessionId,
    grants: input.grants,
    limits: input.limits ?? UNLIMITED_LIMITS,
    branchScopeHint: input.branchScopeHint,
    requestId: input.requestId,
    ip: input.ip,
    userAgent: input.userAgent,
  };
}
