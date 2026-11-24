import type { ModuleState } from '@gymflow/core';
import { TenantRepository } from '../db/tenant-repository.js';

/** El borrado avisado al apagar (3.12): qué día y cuántos decía el aviso. */
export type BorradoAvisado = { on: Date; warned: number };

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
  async history(): Promise<Map<string, { enabled: boolean; reason: string | null; updatedAt: Date; updatedByUserId: string | null; erasureOn: Date | null; erasureWarned: number | null }>> {
    const filas = await this.db.organizationModule.findMany({
      where: this.scope({}),
      select: { moduleKey: true, enabled: true, reason: true, updatedAt: true, updatedByUserId: true, erasureOn: true, erasureWarned: true },
    });
    return new Map(filas.map(({ moduleKey, ...resto }) => [moduleKey, resto]));
  }

  /**
   * Una fila por módulo: dos cambios a la vez sobre módulos distintos no se pisan.
   * `borrado` solo al APAGAR con aviso confirmado (3.12); encender siempre lo
   * deja en nada: el borrado pendiente se cancela.
   */
  async set(moduleKey: string, enabled: boolean, byUserId: string | null, reason: string | null, borrado: BorradoAvisado | null = null): Promise<void> {
    const organizationId = this.organizationId;
    const aviso = { erasureOn: enabled ? null : borrado?.on ?? null, erasureWarned: enabled ? null : borrado?.warned ?? null };
    await this.db.organizationModule.upsert({
      where: { organizationId_moduleKey: { organizationId, moduleKey } },
      create: { organizationId, moduleKey, enabled, reason, updatedByUserId: byUserId, ...aviso },
      update: { enabled, reason, updatedByUserId: byUserId, updatedAt: new Date(), ...aviso },
    });
  }

  /**
   * Los borrados avisados que siguen en pie para un módulo (3.12): filas
   * APAGADAS con fecha de borrado, del gimnasio (`branchId` null) y de cada
   * sucursal. Encender quita la fecha, así que aquí solo queda lo que sigue apagado.
   */
  async borradosAvisados(moduleKey: string): Promise<Array<{ branchId: string | null; erasureOn: Date; erasureWarned: number | null }>> {
    const [gimnasio, sedes] = await Promise.all([
      this.db.organizationModule.findMany({ where: this.scope({ moduleKey, enabled: false, erasureOn: { not: null } }), select: { erasureOn: true, erasureWarned: true } }),
      this.db.branchModuleOverride.findMany({ where: this.scope({ moduleKey, enabled: false, erasureOn: { not: null } }), select: { branchId: true, erasureOn: true, erasureWarned: true } }),
    ]);
    return [
      ...gimnasio.map((f) => ({ branchId: null, erasureOn: f.erasureOn!, erasureWarned: f.erasureWarned })),
      ...sedes.map((f) => ({ branchId: f.branchId as string | null, erasureOn: f.erasureOn!, erasureWarned: f.erasureWarned })),
    ];
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
  async branchHistory(): Promise<Array<{ branchId: string; moduleKey: string; enabled: boolean; reason: string | null; updatedAt: Date; updatedByUserId: string | null; erasureOn: Date | null; erasureWarned: number | null }>> {
    return this.db.branchModuleOverride.findMany({
      where: this.scope({}),
      select: { branchId: true, moduleKey: true, enabled: true, reason: true, updatedAt: true, updatedByUserId: true, erasureOn: true, erasureWarned: true },
    });
  }

  async setBranch(branchId: string, moduleKey: string, enabled: boolean, byUserId: string | null, reason: string | null, borrado: BorradoAvisado | null = null): Promise<void> {
    const organizationId = this.organizationId;
    const aviso = { erasureOn: enabled ? null : borrado?.on ?? null, erasureWarned: enabled ? null : borrado?.warned ?? null };
    await this.db.branchModuleOverride.upsert({
      where: { branchId_moduleKey: { branchId, moduleKey } },
      create: { organizationId, branchId, moduleKey, enabled, reason, updatedByUserId: byUserId, ...aviso },
      update: { enabled, reason, updatedByUserId: byUserId, updatedAt: new Date(), ...aviso },
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
