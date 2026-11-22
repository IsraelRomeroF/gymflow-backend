import { ROLES, uuidv7, type RoleKey } from '@gymflow/core';
import { Prisma } from '@gymflow/db';
import { GlobalRepository } from '../../platform/db/tenant-repository.js';

/**
 * ALTA DE MARCAS: lo único del sistema que escribe en varios gimnasios.
 *
 * Es global a propósito: quien opera la plataforma no pertenece a ningún
 * gimnasio y crea el siguiente. Todo lo que crea queda con el
 * `organizationId` de la marca nueva: desde ese instante, el personal de
 * esa marca opera por los repositorios de siempre, acotados a su gimnasio.
 */
export type NuevaMarca = {
  legalName: string; tradeName: string; timezone: string;
  /** Plan de la plataforma contratado; null = a la medida (ADR-039). */
  platformPlanId: string | null;
  branch: { code: string; name: string; addressLine: string | null; timezone: string | null };
  /**
   * Lo que la marca contrató: lo demás queda marcado como no contratado. En el
   * alta, contratado = encendido (22-01): ya no se escribe `OrganizationModule`;
   * la gerencia apaga después, desde Módulos, lo que no use.
   */
  contracted: { notGranted: readonly string[]; reason: string };
  conCaja: boolean;
  /** «Liberar al terminar» (22-11): nace en uso. Sin esto nace sin liberar y nadie entra. */
  liberar: boolean;
};

export type Cuenta = {
  fullName: string; email: string; phoneE164: string | null; passwordHash: string; roleKey: RoleKey; branchScoped: boolean;
  /** Las secciones de Dirección y Cumplimiento con que nace (la llave del dueño). Sin esto, ninguna. */
  unlockedSections?: readonly string[];
};

/** El último cierre diario de una marca, como lo dejó `system.daily_run` en su bitácora. */
export type UltimoCierre = { at: Date; jobs: number; failed: string[]; chain: string };

export class TenantRepository extends GlobalRepository {
  /**
   * Lo que hicieron las cuentas de plataforma en todas las marcas (UX7
   * Plataforma · Seguridad): quién, qué, en qué marca y por qué. Solo lectura
   * de la bitácora; cada marca conserva su propia cadena.
   */
  /** Lo que la plataforma deja ver al DUEÑO de una marca; null = todo. Solo a dueños. */
  async setPlatformSections(organizationId: string, userId: string, sections: string[] | null): Promise<'ok' | 'no_existe' | 'no_es_dueno'> {
    const u = await this.db.user.findFirst({
      where: { id: userId, organizationId, deletedAt: null },
      select: { id: true, roleAssignments: { where: { revokedAt: null }, select: { role: { select: { key: true } } } } },
    });
    if (!u) return 'no_existe';
    if (!u.roleAssignments.some((a) => a.role.key === 'OWNER')) return 'no_es_dueno';
    await this.db.user.update({ where: { id: userId }, data: { platformSections: sections === null ? Prisma.DbNull : sections } });
    return 'ok';
  }

  /** Cuentas de plataforma: quién puede entrar a esta consola. */
  async cuentasPlataforma() {
    return this.db.user.findMany({
      where: { organizationId: null, deletedAt: null },
      select: { id: true, fullName: true, email: true, isActive: true, lastLoginAt: true, mustChangePassword: true, failedLogins: true, lockedUntil: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async emailEnUso(email: string): Promise<boolean> {
    return (await this.db.user.count({ where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null } })) > 0;
  }

  /** Todo en una transacción: una marca a medias no existe. */
  async crear(marca: NuevaMarca, cuentas: readonly Cuenta[], byUserId: string): Promise<{ organizationId: string; branchId: string; users: Array<{ id: string; email: string; roleKey: RoleKey }> }> {
    return this.db.$transaction(async (tx) => {
      const organizationId = uuidv7();
      await tx.organization.create({
        // Nace sin liberar: la plataforma la libera cuando el dueño ya puede usar el
        // software. Con «Liberar al terminar» nace en uso y ese instante es su liberación.
        data: {
          id: organizationId, legalName: marca.legalName, tradeName: marca.tradeName, timezone: marca.timezone, settings: {}, platformPlanId: marca.platformPlanId,
          ...(marca.liberar ? { serviceStatus: 'ACTIVE' as const, activatedAt: new Date() } : { serviceStatus: 'PENDING' as const }),
        },
      });
      for (const moduleKey of marca.contracted.notGranted) {
        await tx.organizationEntitlement.create({ data: { organizationId, moduleKey, granted: false, reason: marca.contracted.reason, updatedByUserId: byUserId } });
      }
      const branchId = uuidv7();
      await tx.branch.create({
        data: { id: branchId, organizationId, code: marca.branch.code, name: marca.branch.name, addressLine: marca.branch.addressLine, timezone: marca.branch.timezone },
      });
      if (marca.conCaja) {
        await tx.cashRegister.create({ data: { id: uuidv7(), organizationId, branchId, code: 'C1', name: `Caja 1 ${marca.branch.code}` } });
      }

      // Cada puesto nace con los topes del catálogo (ADR-039); la gerencia los ajusta después.
      const roles = await tx.role.findMany({ where: { organizationId: null }, select: { id: true, key: true } });
      const rolPorClave = new Map(roles.map((r) => [r.key, r.id]));
      for (const def of ROLES) {
        const roleId = rolPorClave.get(def.key);
        if (roleId) await tx.roleLimitSet.create({ data: { id: uuidv7(), organizationId, roleId, ...def.limits } });
      }

      const users: Array<{ id: string; email: string; roleKey: RoleKey }> = [];
      for (const c of cuentas) {
        const roleId = rolPorClave.get(c.roleKey);
        if (!roleId) throw new Error(`Rol de sistema ${c.roleKey} no sembrado`);
        const id = uuidv7();
        await tx.user.create({
          data: {
            id, organizationId, email: c.email, fullName: c.fullName, phoneE164: c.phoneE164, passwordHash: c.passwordHash,
            // La contraseña la puso la plataforma: se cambia al entrar (SEC2-08).
            mustChangePassword: true, passwordResetAt: new Date(),
            // Lo decide el servicio: solo el PRIMER gerente del alta nace con Dirección
            // y Cumplimiento liberados (22-08); los demás, cerrados.
            unlockedSections: [...(c.unlockedSections ?? [])],
          },
        });
        await tx.roleAssignment.create({ data: { id: uuidv7(), organizationId, userId: id, roleId, branchId: c.branchScoped ? branchId : null } });
        users.push({ id, email: c.email, roleKey: c.roleKey });
      }
      return { organizationId, branchId, users };
    });
  }

  async marcas() {
    const orgs = await this.db.organization.findMany({
      where: { deletedAt: null },
      select: { id: true, legalName: true, tradeName: true, timezone: true, createdAt: true, serviceStatus: true, activatedAt: true, suspendedAt: true, platformPlan: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const ids = orgs.map((o) => o.id);
    const hace24h = new Date(Date.now() - 24 * 3_600_000);
    const [sedes, socios, personal, ultimos, entradas, noContratados] = await Promise.all([
      this.db.branch.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, deletedAt: null, isActive: true }, _count: { _all: true } }),
      this.db.member.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, status: 'ACTIVE', deletedAt: null }, _count: { _all: true } }),
      // El último acceso de su personal sale de la misma consulta que lo cuenta.
      this.db.user.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, deletedAt: null, isActive: true }, _count: { _all: true }, _max: { lastLoginAt: true } }),
      // Actividad REAL (22-06): lo último que hizo la gente del gimnasio. Lo que hace la
      // plataforma (`platform.*`: facturar, suspender, dar una cuenta) y lo que hace el
      // sistema (`system.*`: el cierre diario) no cuenta: «revivía» a una marca que nadie usa.
      this.db.auditLog.groupBy({
        by: ['organizationId'],
        where: { organizationId: { in: ids }, NOT: [{ action: { startsWith: 'platform.' } }, { action: { startsWith: 'system.' } }] },
        _max: { at: true },
      }),
      this.db.attendanceEvent.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, at: { gt: hace24h } }, _count: { _all: true } }),
      this.db.organizationEntitlement.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, granted: false }, _count: { _all: true } }),
    ]);
    const cuenta = (xs: Array<{ organizationId: string | null; _count: { _all: number } }>, id: string) => xs.find((x) => x.organizationId === id)?._count._all ?? 0;
    return orgs.map(({ platformPlan, ...o }) => ({
      ...o,
      plan: platformPlan ? { id: platformPlan.id, name: platformPlan.name } : null,
      branches: cuenta(sedes, o.id),
      activeMembers: cuenta(socios, o.id),
      staff: cuenta(personal, o.id),
      entriesLast24h: cuenta(entradas, o.id),
      notContracted: cuenta(noContratados, o.id),
      lastActivityAt: ultimos.find((x) => x.organizationId === o.id)?._max.at ?? null,
      lastStaffLoginAt: personal.find((x) => x.organizationId === o.id)?._max.lastLoginAt ?? null,
    }));
  }

  /**
   * El último cierre diario de CADA marca en una sola consulta (22-15). Antes
   * la lista de Marcas pedía la bitácora marca por marca: con 24 marcas, 24
   * consultas más por carga.
   */
  async ultimosCierres(organizationIds: readonly string[]): Promise<Map<string, UltimoCierre>> {
    if (organizationIds.length === 0) return new Map();
    const filas = await this.db.$queryRaw<Array<{ organizationId: string; at: Date; afterState: unknown }>>`
      SELECT DISTINCT ON (a."organizationId") a."organizationId", a.at, a."afterState"
      FROM audit_logs a
      WHERE a."organizationId" IN (${Prisma.join(organizationIds.map((id) => Prisma.sql`${id}::uuid`))}) AND a.action = 'system.daily_run'
      ORDER BY a."organizationId", a.at DESC, a.id DESC`;
    return new Map(filas.map((f) => {
      const e = (f.afterState && typeof f.afterState === 'object' ? f.afterState : {}) as { jobs?: number; failed?: string[]; chain?: string };
      return [f.organizationId, { at: f.at, jobs: e.jobs ?? 0, failed: e.failed ?? [], chain: e.chain ?? 'unknown' }];
    }));
  }

  /** Quién tiene el panel abierto ahora en la marca, y el último acceso de cada cuenta (DP-04). */
  async soporte(organizationId: string) {
    const [sesiones, cuentas] = await Promise.all([
      this.db.session.findMany({
        where: { organizationId, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { userId: true, lastSeenAt: true }, orderBy: { lastSeenAt: 'desc' }, take: 50,
      }),
      this.db.user.findMany({
        where: { organizationId, deletedAt: null, isActive: true },
        select: { id: true, fullName: true, lastLoginAt: true, roleAssignments: { where: { revokedAt: null }, select: { role: { select: { key: true } } } } },
        orderBy: { lastLoginAt: 'desc' },
      }),
    ]);
    const porId = new Map(cuentas.map((u) => [u.id, u]));
    return {
      activeSessions: sesiones.map((s) => ({
        userId: s.userId, fullName: porId.get(s.userId)?.fullName ?? null,
        roleKeys: porId.get(s.userId)?.roleAssignments.map((r) => r.role.key) ?? [], lastSeenAt: s.lastSeenAt,
      })),
      staffLastLogin: cuentas.map((u) => ({ userId: u.id, fullName: u.fullName, roleKeys: u.roleAssignments.map((r) => r.role.key), lastLoginAt: u.lastLoginAt })),
    };
  }

  async marca(organizationId: string) {
    const org = await this.db.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: {
        id: true, legalName: true, tradeName: true, timezone: true, billingEmail: true, createdAt: true, serviceStatus: true, activatedAt: true, suspendedAt: true, suspendedReason: true,
        platformPlan: { select: { id: true, name: true, modules: true, monthlyCents: true } },
      },
    });
    if (!org) return null;
    const [branches, users, members, today] = await Promise.all([
      this.db.branch.findMany({ where: { organizationId, deletedAt: null }, select: { id: true, code: true, name: true, isActive: true, publicSlug: true }, orderBy: { code: 'asc' } }),
      this.db.user.findMany({
        where: { organizationId, deletedAt: null },
        select: {
          // El celular, para entregarle a esa persona una temporal nueva (22-03).
          id: true, fullName: true, email: true, phoneE164: true, isActive: true, lastLoginAt: true, mustChangePassword: true, platformSections: true,
          roleAssignments: { where: { revokedAt: null }, select: { branchId: true, role: { select: { key: true } } } },
        },
        orderBy: { fullName: 'asc' },
      }),
      this.db.member.count({ where: { organizationId, status: 'ACTIVE', deletedAt: null } }),
      this.db.attendanceEvent.count({ where: { organizationId, at: { gt: new Date(Date.now() - 24 * 3_600_000) } } }),
    ]);
    const { platformPlan, ...datos } = org;
    return {
      ...datos, branches, activeMembers: members, entriesLast24h: today,
      /** El plan contratado, ya plano: sus módulos como lista y su precio como texto. */
      plan: platformPlan
        ? { id: platformPlan.id, name: platformPlan.name, modules: Array.isArray(platformPlan.modules) ? (platformPlan.modules as string[]) : [], monthlyCents: platformPlan.monthlyCents?.toString() ?? null }
        : null,
      users: users.map(({ roleAssignments, ...u }) => ({
        ...u,
        roleKeys: [...new Set(roleAssignments.map((a) => a.role.key))],
        branchIds: roleAssignments.some((a) => a.branchId === null) ? null : [...new Set(roleAssignments.flatMap((a) => (a.branchId ? [a.branchId] : [])))],
      })),
    };
  }

  /** Los datos de la marca que la plataforma puede corregir. */
  async editar(organizationId: string, datos: { legalName?: string; tradeName?: string; timezone?: string; billingEmail?: string | null }): Promise<boolean> {
    const { count } = await this.db.organization.updateMany({ where: { id: organizationId, deletedAt: null }, data: datos });
    return count > 0;
  }

  async planIdOf(organizationId: string): Promise<string | null> {
    const org = await this.db.organization.findFirst({ where: { id: organizationId, deletedAt: null }, select: { platformPlanId: true } });
    return org?.platformPlanId ?? null;
  }

  async setPlan(organizationId: string, platformPlanId: string | null): Promise<boolean> {
    const { count } = await this.db.organization.updateMany({ where: { id: organizationId, deletedAt: null }, data: { platformPlanId } });
    return count > 0;
  }

  /**
   * Temporal nueva desde la plataforma, como la que da la gerencia: desbloquea
   * la cuenta, vuelve a correr sus 7 días y cierra las sesiones que tuviera.
   * Una sesión de antes no debe seguir operando mientras la cuenta espera
   * que su dueño elija contraseña (A4-N1).
   */
  async setTemporaryPassword(organizationId: string, userId: string, passwordHash: string): Promise<boolean> {
    const { count } = await this.db.user.updateMany({
      where: { id: userId, organizationId, deletedAt: null },
      data: { passwordHash, failedLogins: 0, lockedUntil: null, mustChangePassword: true, passwordResetAt: new Date(), passwordResetByUserId: null },
    });
    if (count > 0) {
      await this.db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'password_reset' } });
    }
    return count > 0;
  }

  /**
   * Libera, reanuda o suspende. Devuelve el estado que tenía (o null si la
   * marca no existe) para que el servicio sepa si fue liberar o reanudar.
   *
   * `activatedAt` es la PRIMERA liberación y no se vuelve a escribir: el cobro
   * la usa como «desde cuándo se le factura» (bloque 1.13), y reanudar en
   * diciembre a una marca liberada en agosto impedía emitirle noviembre.
   */
  async setServiceStatus(organizationId: string, status: 'ACTIVE' | 'SUSPENDED', reason: string | null): Promise<'PENDING' | 'ACTIVE' | 'SUSPENDED' | null> {
    return this.db.$transaction(async (tx) => {
      // Con candado: dos cambios a la vez no leen el mismo «antes».
      const filas = await tx.$queryRaw<Array<{ serviceStatus: 'PENDING' | 'ACTIVE' | 'SUSPENDED'; activatedAt: Date | null }>>`
        SELECT "serviceStatus", "activatedAt" FROM organizations WHERE id = ${organizationId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
      const antes = filas[0];
      if (!antes) return null;
      await tx.organization.update({
        where: { id: organizationId },
        data: status === 'ACTIVE'
          ? { serviceStatus: 'ACTIVE', ...(antes.activatedAt ? {} : { activatedAt: new Date() }), suspendedAt: null, suspendedReason: null }
          : { serviceStatus: 'SUSPENDED', suspendedAt: new Date(), suspendedReason: reason },
      });
      return antes.serviceStatus;
    });
  }

  /**
   * ¿La marca tiene (otro) gerente activo? Cuenta activa, sin borrar y con el
   * puesto vigente. De esto depende si un gerente dado desde la plataforma
   * nace con Dirección y Cumplimiento liberados (22-09).
   */
  async hayGerenteActivo(organizationId: string): Promise<boolean> {
    return (await this.db.roleAssignment.count({
      where: { organizationId, revokedAt: null, role: { key: 'MANAGER' }, user: { isActive: true, deletedAt: null } },
    })) > 0;
  }

  /** Una cuenta más para la marca, con su rol y su alcance. */
  async addUser(organizationId: string, c: Cuenta, branchIds: readonly string[] | null): Promise<string> {
    return this.db.$transaction(async (tx) => {
      const role = await tx.role.findFirst({ where: { organizationId: null, key: c.roleKey }, select: { id: true } });
      if (!role) throw new Error(`Rol de sistema ${c.roleKey} no sembrado`);
      const id = uuidv7();
      await tx.user.create({
        data: {
          id, organizationId, email: c.email, fullName: c.fullName, phoneE164: c.phoneE164, passwordHash: c.passwordHash, mustChangePassword: true, passwordResetAt: new Date(),
          unlockedSections: [...(c.unlockedSections ?? [])],
        },
      });
      for (const branchId of branchIds ?? [null]) {
        await tx.roleAssignment.create({ data: { id: uuidv7(), organizationId, userId: id, roleId: role.id, branchId } });
      }
      return id;
    });
  }

  async setUserActive(organizationId: string, userId: string, isActive: boolean): Promise<boolean> {
    const { count } = await this.db.user.updateMany({ where: { id: userId, organizationId, deletedAt: null }, data: { isActive } });
    if (count > 0 && !isActive) {
      // Una cuenta suspendida no sigue con sus sesiones abiertas.
      await this.db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'platform_suspend' } });
    }
    return count > 0;
  }

  async branchesOf(organizationId: string): Promise<Set<string>> {
    return new Set((await this.db.branch.findMany({ where: { organizationId, deletedAt: null }, select: { id: true } })).map((b) => b.id));
  }
}
