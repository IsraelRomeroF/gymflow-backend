import { uuidv7, notFound } from '@gymflow/core';
import { getDb } from '../../platform/db/client.js';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { olvidarZonas } from '../../platform/time/business-calendar.js';
import { usageOf } from '../../platform/modules/usage.js';

export class BranchRepository extends TenantRepository {
  /**
   * Sucursal → organización, SIN contexto de tenant.
   *
   * Es la única consulta del sistema que no filtra por organización, y existe
   * para un caso concreto: el formulario público del alta digital llega con el
   * identificador de la sucursal y nada más. Derivar el tenant de un dato del
   * servidor es justo lo contrario de aceptarlo del cliente, que es el ataque
   * clásico de multi-tenancy.
   */
  /**
   * El enlace público del alta trae el id de la sucursal o su `publicSlug`
   * (`fuerza-centro`), que es único entre todos los gimnasios (UXB-14).
   */
  static async resolvePublic(idOrSlug: string): Promise<{ organizationId: string; branchId: string } | null> {
    const esId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
    const row = await getDb().branch.findFirst({
      where: { ...(esId ? { id: idOrSlug } : { publicSlug: idOrSlug.toLowerCase() }), deletedAt: null, isActive: true },
      select: { id: true, organizationId: true },
    });
    return row ? { organizationId: row.organizationId, branchId: row.id } : null;
  }

  static async organizationOf(branchId: string): Promise<string | null> {
    const row = await getDb().branch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: { organizationId: true },
    });
    return row?.organizationId ?? null;
  }

  async list() {
    return this.db.branch.findMany({
      where: this.scope({ deletedAt: null }),
      select: { id: true, code: true, name: true, addressLine: true, publicSlug: true, timezone: true, isActive: true },
      orderBy: { code: 'asc' },
    });
  }

  /**
   * Incrementa la versión del padrón y devuelve la nueva.
   *
   * El `UPDATE ... RETURNING` es atómico: dos generaciones simultáneas no
   * producen la misma versión. Es importante porque la versión es lo que
   * impide aceptar un padrón anterior, y dos padrones distintos con la misma
   * versión romperían esa garantía.
   */
  async bumpRosterVersion(branchId: string): Promise<bigint> {
    const rows = await this.db.$queryRaw<Array<{ rosterVersion: bigint }>>`
      UPDATE "branches" SET "rosterVersion" = "rosterVersion" + 1
      WHERE "id" = ${branchId}::uuid AND "organizationId" = ${this.organizationId}::uuid
      RETURNING "rosterVersion"`;
    const row = rows[0];
    if (!row) throw notFound('Sucursal no encontrada');
    return row.rosterVersion;
  }

  async findById(id: string) {
    return this.db.branch.findFirst({
      where: this.scope({ id, deletedAt: null }),
      select: { id: true, code: true, name: true, addressLine: true, publicSlug: true, timezone: true, isActive: true },
    });
  }

  /** Choca con otra sede viva: mismo código o mismo prefijo de socio (3 letras). */
  async codeClash(code: string, exceptId: string | null = null): Promise<'CODE' | 'PREFIX' | null> {
    const vivas = await this.db.branch.findMany({
      where: this.scope({ deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) }), select: { code: true },
    });
    const c = code.toUpperCase();
    if (vivas.some((b) => b.code.toUpperCase() === c)) return 'CODE';
    if (vivas.some((b) => b.code.slice(0, 3).toUpperCase() === c.slice(0, 3))) return 'PREFIX';
    return null;
  }

  async create(input: { code: string; name: string; addressLine: string | null; timezone: string | null }) {
    return this.db.branch.create({
      data: { id: uuidv7(), organizationId: this.organizationId, ...input, code: input.code.toUpperCase() },
      select: { id: true, code: true, name: true, addressLine: true, publicSlug: true, timezone: true, isActive: true },
    });
  }

  /**
   * Lo que se lleva por delante cerrar la sede (DP-09): se muestra antes. Con
   * caja abierta o con personal asignado se rechaza (19-06): nadie debe quedar
   * «trabajando» en una sede que ya no aparece para vender ni cobrar. Con
   * lugares reservados en clases próximas, tampoco (fase 2 · 2.7).
   */
  async closingSummary(id: string): Promise<{
    homeMembers: number; liveMemberships: number; openCashSessions: number; classTemplates: number;
    staff: Array<{ id: string; fullName: string; roleName: string }>;
    /** Lo vivo de Clases en la sede que impide cerrarla («3 lugares reservados en clases próximas»); lo cuenta Clases. */
    classBlockers: string[];
  }> {
    const org = this.organizationId;
    const [homeMembers, liveMemberships, openCashSessions, classTemplates, asignaciones] = await Promise.all([
      this.db.member.count({ where: { organizationId: org, homeBranchId: id, deletedAt: null } }),
      this.db.membership.count({ where: { organizationId: org, soldAtBranchId: id, status: { in: ['PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'FROZEN', 'SUSPENDED'] } } }),
      this.db.cashSession.count({ where: { organizationId: org, branchId: id, status: 'OPEN' } }),
      this.db.classTemplate.count({ where: { organizationId: org, branchId: id, isActive: true } }),
      // Las cuentas activas asignadas a ESTA sede (la gerencia abarca todo el gimnasio y no cuenta).
      this.db.roleAssignment.findMany({
        where: { organizationId: org, branchId: id, revokedAt: null, user: { isActive: true, deletedAt: null } },
        select: { user: { select: { id: true, fullName: true } }, role: { select: { name: true } } },
        orderBy: { user: { fullName: 'asc' } },
      }),
    ]);
    const staff = [...new Map(asignaciones.map((a) => [a.user.id, { id: a.user.id, fullName: a.user.fullName, roleName: a.role.name }])).values()];
    // Quien ya reservó en esa sede cuenta con su lugar: como al dejar de usar Clases ahí.
    const { blockers: classBlockers } = await usageOf('classes', org, id);
    return { homeMembers, liveMemberships, openCashSessions, classTemplates, staff, classBlockers };
  }

  async update(id: string, patch: { name?: string; addressLine?: string | null; publicSlug?: string | null; timezone?: string | null; isActive?: boolean }) {
    const { count } = await this.db.branch.updateMany({ where: this.scope({ id, deletedAt: null }), data: patch });
    // La fecha de negocio de la sede se calcula con su zona: no esperar al TTL.
    if (patch.timezone !== undefined) olvidarZonas(this.organizationId);
    return count > 0 ? this.findById(id) : null;
  }
}
