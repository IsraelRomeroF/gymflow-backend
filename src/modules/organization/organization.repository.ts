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
   * El gimnasio de la sesión como lo pide el PANEL (`GET /organization`): con
   * lo que su recibo imprime (D-27, bloque 4.6). `current()` no los trae a
   * propósito: lo usan el portal y el alta pública. El logo se pide aparte.
   */
  async paraElPanel() {
    const org = await this.db.organization.findFirst({
      where: { id: this.organizationId, deletedAt: null },
      select: { id: true, legalName: true, tradeName: true, timezone: true, defaultCurrency: true, rfc: true, phone: true, whatsapp: true, receiptLegend: true },
    });
    if (!org) return null;
    const conLogo = await this.db.organization.count({ where: { id: this.organizationId, logo: { not: null } } });
    return { ...org, hasLogo: conLogo > 0 };
  }

  /**
   * Lo que el recibo imprime del gimnasio, en una lectura, para el comprobante que el socio abre en su
   * teléfono (bloque 4.11): logo, leyenda, teléfonos y RFC. Es lo mismo que ya imprime el del mostrador.
   */
  async paraElRecibo(): Promise<{ logo: string | null; phone: string | null; whatsapp: string | null; rfc: string | null; receiptLegend: string | null }> {
    const org = await this.db.organization.findFirst({
      where: { id: this.organizationId, deletedAt: null }, select: { logo: true, phone: true, whatsapp: true, rfc: true, receiptLegend: true },
    });
    return { logo: org?.logo ?? null, phone: org?.phone ?? null, whatsapp: org?.whatsapp ?? null, rfc: org?.rfc ?? null, receiptLegend: org?.receiptLegend ?? null };
  }

  /** El logo del gimnasio (`data:` URL) o null. */
  async logo(): Promise<string | null> {
    const org = await this.db.organization.findFirst({ where: { id: this.organizationId, deletedAt: null }, select: { logo: true } });
    return org?.logo ?? null;
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
        rfc: true, phone: true, whatsapp: true, receiptLegend: true, logo: true,
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
      // D-06 (fase 3, bloque 3.3): nace apagada; la enciende la gerencia en Biometría.
      requireFaceToEnter: acceso.requireFaceToEnter === true,
    };
  }

  /**
   * D-06 (bloque 3.3): enciende o apaga «nadie entra sin su rostro, salvo que
   * la gerencia autorice esa visita». Guarda también cuándo y quién, para
   * decirlo en la pantalla. Lo llama `access` (`PUT /access/face-rule`), que
   * asienta el cambio en la bitácora.
   */
  async setRequireFaceToEnter(enabled: boolean, byUserId: string | null): Promise<void> {
    const org = await this.db.organization.findFirst({ where: { id: this.organizationId }, select: { settings: true } });
    const settings = { ...((org?.settings ?? {}) as Record<string, unknown>) };
    settings.access = {
      ...((settings.access ?? {}) as Record<string, unknown>),
      requireFaceToEnter: enabled, requireFaceChangedAt: new Date().toISOString(), requireFaceChangedByUserId: byUserId,
    };
    await this.db.organization.updateMany({ where: { id: this.organizationId }, data: { settings: settings as Prisma.InputJsonValue } });
  }

  /** Cuándo y quién cambió por última vez la regla del rostro (D-06). */
  async requireFaceLastChange(): Promise<{ at: Date; byUserId: string | null } | null> {
    const org = await this.db.organization.findFirst({ where: { id: this.organizationId }, select: { settings: true } });
    const acceso = (((org?.settings ?? {}) as Record<string, unknown>).access ?? {}) as Record<string, unknown>;
    if (typeof acceso.requireFaceChangedAt !== 'string') return null;
    return { at: new Date(acceso.requireFaceChangedAt), byUserId: typeof acceso.requireFaceChangedByUserId === 'string' ? acceso.requireFaceChangedByUserId : null };
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
