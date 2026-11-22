import { DEFAULT_ACCESS_SETTINGS, type AccessSettings } from '@gymflow/core';
import type { Prisma } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

export class OrganizationRepository extends TenantRepository {
  async current() {
    return this.db.organization.findFirst({
      where: { id: this.organizationId, deletedAt: null },
      select: { id: true, legalName: true, tradeName: true, timezone: true, defaultCurrency: true },
    });
  }

  /**
   * Los datos del gimnasio que la plataforma administra (D-27) y lo que tiene
   * contratado (19-09): el plan de la plataforma, o `null` si el contrato es a
   * la medida. Solo se leen: desde el panel no se cambia ninguno.
   */
  async profile() {
    const org = await this.db.organization.findFirst({
      where: { id: this.organizationId, deletedAt: null },
      select: {
        legalName: true, tradeName: true, timezone: true, defaultCurrency: true, billingEmail: true, activatedAt: true,
        platformPlan: { select: { name: true, description: true, modules: true } },
      },
    });
    if (!org) return null;
    const { platformPlan, ...datos } = org;
    const claves = Array.isArray(platformPlan?.modules) ? platformPlan.modules.filter((k): k is string => typeof k === 'string') : [];
    return { ...datos, plan: platformPlan ? { name: platformPlan.name, description: platformPlan.description, moduleKeys: claves } : null };
  }

  /**
   * Ajustes de política de acceso del gimnasio.
   *
   * Vive en `settings` de la organización y NO en el código porque es política
   * del negocio: un gimnasio cierra la puerta al primer día de mora y otro da
   * margen. Fijarlo en el código obligaría a desplegar para cambiar una regla,
   * y a bifurcar el día que dos clientes discrepen.
   */
  async accessSettings(): Promise<AccessSettings> {
    const org = await this.db.organization.findFirst({
      where: { id: this.organizationId }, select: { settings: true },
    });
    const raw = (org?.settings ?? {}) as Record<string, unknown>;
    const acceso = (raw.access ?? {}) as Record<string, unknown>;
    return {
      allowAccessWhilePastDue:
        typeof acceso.allowAccessWhilePastDue === 'boolean'
          ? acceso.allowAccessWhilePastDue
          : DEFAULT_ACCESS_SETTINGS.allowAccessWhilePastDue,
    };
  }

  /** Ajustes del arranque (DP-07): hoy, si el gerente atiende el mostrador (gimnasio de una persona y media). */
  async setupFlags(): Promise<{ managerAttendsFrontDesk: boolean }> {
    const org = await this.db.organization.findFirst({ where: { id: this.organizationId }, select: { settings: true } });
    const setup = ((org?.settings ?? {}) as Record<string, unknown>).setup as Record<string, unknown> | undefined;
    return { managerAttendsFrontDesk: setup?.managerAttendsFrontDesk === true };
  }

  /** Plazo de supresión (PS-08): meses tras la baja para proponer anonimizar. null = el gimnasio no lo fijó. */
  async privacySettings(): Promise<{ monthsAfterArchive: number | null }> {
    const org = await this.db.organization.findFirst({ where: { id: this.organizationId }, select: { settings: true } });
    const privacy = ((org?.settings ?? {}) as Record<string, unknown>).privacy as Record<string, unknown> | undefined;
    const m = privacy?.monthsAfterArchive;
    return { monthsAfterArchive: typeof m === 'number' && m > 0 ? m : null };
  }

  async setPrivacyMonths(monthsAfterArchive: number | null): Promise<void> {
    const org = await this.db.organization.findFirst({ where: { id: this.organizationId }, select: { settings: true } });
    const settings = { ...((org?.settings ?? {}) as Record<string, unknown>) };
    settings.privacy = { ...((settings.privacy ?? {}) as Record<string, unknown>), monthsAfterArchive };
    await this.db.organization.updateMany({ where: { id: this.organizationId }, data: { settings: settings as Prisma.InputJsonValue } });
  }

  async setSetupFlag(key: 'managerAttendsFrontDesk', value: boolean): Promise<void> {
    const org = await this.db.organization.findFirst({ where: { id: this.organizationId }, select: { settings: true } });
    const settings = { ...((org?.settings ?? {}) as Record<string, unknown>) };
    settings.setup = { ...((settings.setup ?? {}) as Record<string, unknown>), [key]: value };
    await this.db.organization.updateMany({ where: { id: this.organizationId }, data: { settings: settings as Prisma.InputJsonValue } });
  }

  async effectiveTimezone(branchId?: string | null): Promise<string> {
    const org = await this.db.organization.findFirst({
      where: { id: this.organizationId },
      select: { timezone: true },
    });
    if (!branchId) return org?.timezone ?? 'America/Mexico_City';
    const branch = await this.db.branch.findFirst({
      where: this.scope({ id: branchId }),
      select: { timezone: true },
    });
    return branch?.timezone ?? org?.timezone ?? 'America/Mexico_City';
  }
}
