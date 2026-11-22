import type { ModuleState } from '@gymflow/core';
import { TenantRepository } from '../db/tenant-repository.js';

/**
 * Lo que cada gimnasio encendió o apagó a mano (`organization_modules`).
 *
 * Vive en plataforma, como la bitácora: la puerta de las rutas y los trabajos
 * nocturnos lo consultan, y la plataforma no puede depender de un módulo.
 */
export class ModuleStateRepository extends TenantRepository {
  async state(): Promise<ModuleState> {
    const filas = await this.db.organizationModule.findMany({
      where: this.scope({}),
      select: { moduleKey: true, enabled: true },
    });
    return Object.fromEntries(filas.map((f) => [f.moduleKey, f.enabled]));
  }

  /** Quién cambió cada módulo por última vez, cuándo y por qué. */
  async history(): Promise<Map<string, { enabled: boolean; reason: string | null; updatedAt: Date; updatedByUserId: string | null }>> {
    const filas = await this.db.organizationModule.findMany({
      where: this.scope({}),
      select: { moduleKey: true, enabled: true, reason: true, updatedAt: true, updatedByUserId: true },
    });
    return new Map(filas.map(({ moduleKey, ...resto }) => [moduleKey, resto]));
  }

  /** Una fila por módulo: dos cambios a la vez sobre módulos distintos no se pisan. */
  async set(moduleKey: string, enabled: boolean, byUserId: string | null, reason: string | null): Promise<void> {
    const organizationId = this.organizationId;
    await this.db.organizationModule.upsert({
      where: { organizationId_moduleKey: { organizationId, moduleKey } },
      create: { organizationId, moduleKey, enabled, reason, updatedByUserId: byUserId },
      update: { enabled, reason, updatedByUserId: byUserId, updatedAt: new Date() },
    });
  }

  /** Lo que cada sucursal dejó de usar (solo filas con `enabled = false`). */
  async branchDisabled(): Promise<Map<string, Set<string>>> {
    const filas = await this.db.branchModuleOverride.findMany({
      where: this.scope({ enabled: false }),
      select: { branchId: true, moduleKey: true },
    });
    const porSede = new Map<string, Set<string>>();
    for (const f of filas) {
      if (!porSede.has(f.branchId)) porSede.set(f.branchId, new Set());
      porSede.get(f.branchId)!.add(f.moduleKey);
    }
    return porSede;
  }

  /** Quién cambió qué en cada sucursal, cuándo y por qué. */
  async branchHistory(): Promise<Array<{ branchId: string; moduleKey: string; enabled: boolean; reason: string | null; updatedAt: Date; updatedByUserId: string | null }>> {
    return this.db.branchModuleOverride.findMany({
      where: this.scope({}),
      select: { branchId: true, moduleKey: true, enabled: true, reason: true, updatedAt: true, updatedByUserId: true },
    });
  }

  async setBranch(branchId: string, moduleKey: string, enabled: boolean, byUserId: string | null, reason: string | null): Promise<void> {
    const organizationId = this.organizationId;
    await this.db.branchModuleOverride.upsert({
      where: { branchId_moduleKey: { branchId, moduleKey } },
      create: { organizationId, branchId, moduleKey, enabled, reason, updatedByUserId: byUserId },
      update: { enabled, reason, updatedByUserId: byUserId, updatedAt: new Date() },
    });
  }

  /** Lo que la plataforma marcó como NO contratado (sin fila = contratado). */
  async entitlements(): Promise<Map<string, boolean>> {
    const filas = await this.db.organizationEntitlement.findMany({ where: this.scope({}), select: { moduleKey: true, granted: true } });
    return new Map(filas.map((f) => [f.moduleKey, f.granted]));
  }

  async entitlementHistory(): Promise<Map<string, { granted: boolean; reason: string | null; updatedAt: Date; updatedByUserId: string | null }>> {
    const filas = await this.db.organizationEntitlement.findMany({
      where: this.scope({}), select: { moduleKey: true, granted: true, reason: true, updatedAt: true, updatedByUserId: true },
    });
    return new Map(filas.map(({ moduleKey, ...r }) => [moduleKey, r]));
  }

  async setEntitlement(moduleKey: string, granted: boolean, byUserId: string | null, reason: string | null): Promise<void> {
    const organizationId = this.organizationId;
    await this.db.organizationEntitlement.upsert({
      where: { organizationId_moduleKey: { organizationId, moduleKey } },
      create: { organizationId, moduleKey, granted, reason, updatedByUserId: byUserId },
      update: { granted, reason, updatedByUserId: byUserId, updatedAt: new Date() },
    });
  }

  /** Si la marca puede usar el software: lo decide la plataforma. */
  async serviceStatus(): Promise<'PENDING' | 'ACTIVE' | 'SUSPENDED'> {
    const org = await this.db.organization.findFirst({ where: { id: this.organizationId }, select: { serviceStatus: true } });
    return (org?.serviceStatus as 'PENDING' | 'ACTIVE' | 'SUSPENDED' | undefined) ?? 'SUSPENDED';
  }
}
