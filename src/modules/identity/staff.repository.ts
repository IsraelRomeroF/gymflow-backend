import { uuidv7, normalizeOverrides, type PermissionOverrides } from '@gymflow/core';
import { Prisma } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

export type StaffRow = {
  id: string; email: string; fullName: string; phoneE164: string | null; isActive: boolean;
  lastLoginAt: Date | null; mustChangePassword: boolean;
  /** Desde cuándo corre su temporal (vence a los 7 días); sin dato, desde el alta. */
  passwordResetAt: Date | null; createdAt: Date;
  /** Secciones de Dirección y Cumplimiento que el dueño le liberó. */
  unlockedSections: string[];
  /** Ajustes de permisos sobre su puesto (recepción y coach). */
  permissionOverrides: PermissionOverrides;
  assignments: Array<{ roleKey: string; roleName: string; branchId: string | null }>;
  /**
   * Gerente nuevo al que la dueña todavía no le decide qué ve (17-06): llegó
   * al puesto y desde entonces nadie guardó su «Qué ve». Nace sin Dirección
   * (D17-03), así que sin este aviso la dueña no se enteraba.
   */
  sectionsReviewPending: boolean;
};

/** Personal de la organización: alta, rol y alcance, baja. */
export class StaffRepository extends TenantRepository {
  async list(): Promise<StaffRow[]> {
    const rows = await this.db.user.findMany({
      where: this.scope({ deletedAt: null }),
      select: {
        id: true, email: true, fullName: true, phoneE164: true, isActive: true, lastLoginAt: true, mustChangePassword: true, unlockedSections: true, permissionOverrides: true,
        passwordResetAt: true, createdAt: true,
        roleAssignments: { where: { revokedAt: null }, select: { branchId: true, grantedAt: true, grantedByUserId: true, role: { select: { key: true, name: true } } } },
      },
      orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
    });
    const porRevisar = await this.gerentesPorRevisar(rows.map((u) => ({
      id: u.id, isActive: u.isActive, unlockedSections: lista(u.unlockedSections),
      gerente: u.roleAssignments.find((a) => a.role.key === 'MANAGER') ?? null,
    })));
    return rows.map(({ roleAssignments, unlockedSections, permissionOverrides, ...u }) => ({
      ...u, unlockedSections: lista(unlockedSections), permissionOverrides: normalizeOverrides(permissionOverrides),
      assignments: roleAssignments.map((a) => ({ roleKey: a.role.key, roleName: a.role.name, branchId: a.branchId })),
      sectionsReviewPending: porRevisar.has(u.id),
    }));
  }

  /**
   * Gerentes activos a los que la dueña no ha decidido qué ven DESDE que
   * llegaron al puesto: ningún «Qué ve» guardado (`staff.unlock` en la
   * bitácora) después de la asignación. El que da de alta la plataforma con
   * todo liberado (el primero de la marca) no cuenta: ya ve Dirección.
   */
  private async gerentesPorRevisar(cuentas: ReadonlyArray<{
    id: string; isActive: boolean; unlockedSections: string[];
    gerente: { grantedAt: Date; grantedByUserId: string | null } | null;
  }>): Promise<Set<string>> {
    const candidatos = cuentas.filter((c): c is typeof c & { gerente: NonNullable<typeof c.gerente> } =>
      c.isActive && c.gerente !== null
      && (c.gerente.grantedByUserId !== null || !c.unlockedSections.some((k) => !k.startsWith('-'))));
    if (candidatos.length === 0) return new Set();
    const decisiones = await this.db.auditLog.findMany({
      where: { organizationId: this.organizationId, resourceType: 'User', action: 'staff.unlock', resourceId: { in: candidatos.map((c) => c.id) } },
      select: { resourceId: true, at: true },
    });
    const ultima = new Map<string, number>();
    for (const d of decisiones) if (d.resourceId) ultima.set(d.resourceId, Math.max(ultima.get(d.resourceId) ?? 0, d.at.getTime()));
    return new Set(candidatos.filter((c) => (ultima.get(c.id) ?? 0) < c.gerente.grantedAt.getTime()).map((c) => c.id));
  }

  async unlockedSections(userId: string): Promise<string[]> {
    const u = await this.db.user.findFirst({ where: this.scope({ id: userId, deletedAt: null }), select: { unlockedSections: true } });
    return lista(u?.unlockedSections);
  }

  /** Lo que la plataforma deja ver al dueño; null = todo (2026-10-09). */
  async platformSections(userId: string): Promise<string[] | null> {
    const u = await this.db.user.findFirst({ where: this.scope({ id: userId, deletedAt: null }), select: { platformSections: true } });
    return u?.platformSections == null ? null : lista(u.platformSections);
  }

  /** La llave del dueño: qué secciones ve esta persona. */
  /** Permisos de la persona sobre su puesto; vacío = exactamente su puesto. */
  async setPermissionOverrides(userId: string, o: PermissionOverrides): Promise<boolean> {
    const vacio = o.add.length === 0 && o.remove.length === 0;
    const { count } = await this.db.user.updateMany({ where: this.scope({ id: userId, deletedAt: null }), data: { permissionOverrides: vacio ? Prisma.DbNull : o } });
    return count === 1;
  }

  async setUnlockedSections(userId: string, sections: string[]): Promise<boolean> {
    const { count } = await this.db.user.updateMany({ where: this.scope({ id: userId, deletedAt: null }), data: { unlockedSections: sections } });
    return count === 1;
  }

  async find(id: string): Promise<StaffRow | null> {
    return (await this.list()).find((u) => u.id === id) ?? null;
  }

  /** Cuántas cuentas activas tiene cada puesto. */
  async roleUsage(): Promise<Map<string, number>> {
    const filas = await this.db.roleAssignment.findMany({
      where: { organizationId: this.organizationId, revokedAt: null, user: { isActive: true, deletedAt: null } },
      select: { userId: true, role: { select: { key: true } } },
    });
    const porPuesto = new Map<string, Set<string>>();
    for (const f of filas) porPuesto.set(f.role.key, (porPuesto.get(f.role.key) ?? new Set()).add(f.userId));
    return new Map([...porPuesto].map(([k, v]) => [k, v.size]));
  }

  /** Roles que la organización puede asignar: los de sistema y los propios. */
  async roles() {
    const rows = await this.db.role.findMany({
      where: { OR: [{ organizationId: null }, { organizationId: this.organizationId }] },
      select: { id: true, key: true, name: true, permissions: { select: { permissionKey: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, key: r.key, name: r.name, permissions: r.permissions.map((p) => p.permissionKey) }));
  }

  /** Topes por rol de ESTA organización (descuento, condonación, retiros...). */
  async roleLimits() {
    return this.db.roleLimitSet.findMany({
      where: { organizationId: this.organizationId },
      select: {
        roleId: true, maxDiscountPercent: true, maxWaiverAmountCents: true, maxManualBalanceAdjustCents: true,
        maxCashWithdrawalCents: true, maxRefundAmountCents: true, maxManualAccessGrantsPerShift: true, maxPosVoidsPerShift: true,
      },
    });
  }

  /** ¿Ese correo ya entra a GymFlow? El login busca por correo en TODAS las organizaciones. */
  async emailInUse(email: string): Promise<boolean> {
    const n = await this.db.user.count({ where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null } });
    return n > 0;
  }

  /**
   * La contraseña temporal la conoce quien la dio: obliga a cambiarla y deja
   * constancia de quién y cuándo, para que no sirva de "segundo firmante".
   * `passwordResetAt` es también desde cuándo corre: vence a los 7 días y,
   * mientras tanto, solo sirve para elegir la propia (A4-N1, `auth.service.ts`).
   */
  async create(input: { email: string; fullName: string; phoneE164: string | null; passwordHash: string }, byUserId: string): Promise<string> {
    const id = uuidv7();
    await this.db.user.create({
      data: { id, organizationId: this.organizationId, ...input, mustChangePassword: true, passwordResetAt: new Date(), passwordResetByUserId: byUserId },
    });
    return id;
  }

  async update(id: string, patch: { fullName?: string; phoneE164?: string | null; isActive?: boolean }): Promise<boolean> {
    const { count } = await this.db.user.updateMany({ where: this.scope({ id, deletedAt: null }), data: patch });
    return count > 0;
  }

  /** Una temporal nueva: desbloquea la cuenta y vuelve a correr sus 7 días. */
  async setPassword(id: string, passwordHash: string, byUserId: string): Promise<boolean> {
    const { count } = await this.db.user.updateMany({
      where: this.scope({ id, deletedAt: null }),
      data: {
        passwordHash, failedLogins: 0, lockedUntil: null,
        mustChangePassword: true, passwordResetAt: new Date(), passwordResetByUserId: byUserId,
      },
    });
    return count > 0;
  }

  /** Reemplaza el rol y su alcance: revoca lo anterior (con fecha) y asigna lo nuevo. */
  async replaceRole(userId: string, roleId: string, branchIds: readonly string[] | null, grantedByUserId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.roleAssignment.updateMany({ where: this.scope({ userId, revokedAt: null }), data: { revokedAt: new Date() } });
      const sedes = branchIds && branchIds.length > 0 ? branchIds : [null];
      await tx.roleAssignment.createMany({
        data: sedes.map((branchId) => ({ id: uuidv7(), organizationId: this.organizationId, userId, roleId, branchId, grantedByUserId })),
      });
    });
  }
}

/** El JSON de la base, como lista de claves (y nada más). */
function lista(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
