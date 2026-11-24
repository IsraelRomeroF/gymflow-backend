import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * Lo que una marca recién liberada tiene que dejar listo antes de operar.
 * Son conteos de solo lectura sobre lo que cada módulo ya guarda: el
 * asistente de arranque no escribe nada, solo dice qué falta y a dónde ir.
 */
export type Conteos = {
  textosPublicados: Set<string>; planes: number; sedes: number;
  /** Tipos de texto con una versión que espera la firma de la dueña (D-25): ya se pidió publicar. */
  textosEsperandoFirma: Set<string>;
  /** Ids de las sucursales activas sin caja registradora; el asistente descuenta las que tienen Caja apagada. */
  sedesSinCaja: string[];
  recepcion: number; horarios: number; productos: number; enlaces: number;
  /** Códigos del sistema anterior cargados: señal de que ya se importó la base. */
  importados: number;
  /** Alguna cuenta de dueño ya entró y cambió su contraseña temporal. */
  duenoEntro: boolean;
};

export class SetupRepository extends TenantRepository {
  async conteos(): Promise<Conteos> {
    const org = this.organizationId;
    const [publicados, planes, sedes, cajas, recepcion, horarios, productos, enlaces, importados, dueno, porFirmar] = await Promise.all([
      this.db.consentDocument.findMany({ where: { organizationId: org, status: 'PUBLISHED' }, select: { consentType: true } }),
      this.db.plan.count({ where: { organizationId: org, deletedAt: null, isActive: true } }),
      this.db.branch.findMany({ where: { organizationId: org, deletedAt: null, isActive: true }, select: { id: true, publicSlug: true } }),
      this.db.cashRegister.groupBy({ by: ['branchId'], where: { organizationId: org, isActive: true }, _count: { _all: true } }),
      this.db.roleAssignment.count({ where: { organizationId: org, revokedAt: null, role: { key: 'RECEPTION' }, user: { isActive: true, deletedAt: null } } }),
      this.db.classTemplate.count({ where: { organizationId: org, isActive: true } }),
      this.db.product.count({ where: { organizationId: org, deletedAt: null, isActive: true } }),
      this.db.branch.count({ where: { organizationId: org, deletedAt: null, isActive: true, publicSlug: { not: null } } }),
      this.db.memberLegacyCode.count({ where: { organizationId: org } }),
      // "El dueño ya entró": alguna cuenta de dueño inició sesión y cambió su contraseña temporal.
      this.db.user.count({ where: { organizationId: org, deletedAt: null, isActive: true, mustChangePassword: false, lastLoginAt: { not: null }, roleAssignments: { some: { revokedAt: null, role: { key: 'OWNER' } } } } }),
      this.db.consentSignatureRequest.findMany({ where: { organizationId: org, status: 'PENDING' }, select: { document: { select: { consentType: true } } } }),
    ]);
    return {
      textosPublicados: new Set(publicados.map((d) => d.consentType)),
      textosEsperandoFirma: new Set(porFirmar.map((s) => s.document.consentType as string)),
      planes, sedes: sedes.length,
      sedesSinCaja: sedes.filter((s) => !cajas.some((c) => c.branchId === s.id)).map((s) => s.id),
      recepcion, horarios, productos, enlaces, importados, duenoEntro: dueno > 0,
    };
  }
}
