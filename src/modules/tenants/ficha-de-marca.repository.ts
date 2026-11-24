import { uuidv7 } from '@gymflow/core';
import { GlobalRepository } from '../../platform/db/tenant-repository.js';

/** Lo que la plataforma lleva de la marca (D-27): sus nombres y lo que el gimnasio no puede cambiar desde su panel. */
export type DatosDeMarca = {
  id: string; tradeName: string; legalName: string;
  rfc: string | null; phone: string | null; whatsapp: string | null; receiptLegend: string | null; logo: string | null;
};
export type SedeDeMarca = { id: string; code: string; name: string; isActive: boolean; phone: string | null; openingHours: string | null };
export type CambioDeMarca = Partial<Pick<DatosDeMarca, 'tradeName' | 'legalName' | 'rfc' | 'phone' | 'whatsapp' | 'receiptLegend' | 'logo'>>;
export type CambioDeSede = Partial<Pick<SedeDeMarca, 'phone' | 'openingHours'>>;

export type Solicitud = {
  id: string; organizationId: string; branchId: string | null; field: string; proposedValue: string | null; proposedLogo: string | null; reason: string;
  requestedByUserId: string; requestedAt: Date; status: string; response: string | null; appliedValue: string | null;
  resolvedByUserId: string | null; resolvedAt: Date | null; seenAt: Date | null;
  branch: { name: string } | null; requestedBy: { id: string; fullName: string }; organization: { tradeName: string };
};

const MARCA = { id: true, tradeName: true, legalName: true, rfc: true, phone: true, whatsapp: true, receiptLegend: true, logo: true } as const;
const SEDE = { id: true, code: true, name: true, isActive: true, phone: true, openingHours: true } as const;
const SOLICITUD = {
  id: true, organizationId: true, branchId: true, field: true, proposedValue: true, proposedLogo: true, reason: true,
  requestedByUserId: true, requestedAt: true, status: true, response: true, appliedValue: true, resolvedByUserId: true, resolvedAt: true, seenAt: true,
  branch: { select: { name: true } }, requestedBy: { select: { id: true, fullName: true } }, organization: { select: { tradeName: true } },
} as const;

/**
 * LA FICHA DE MARCA Y LAS SOLICITUDES DE CAMBIO (D-27, bloque 4.6). Global:
 * la escribe la plataforma. El gimnasio solo crea solicitudes y marca como
 * vistas las suyas; siempre con el `organizationId` de su sesión.
 */
export class GymBrandRepository extends GlobalRepository {
  marca(organizationId: string): Promise<DatosDeMarca | null> {
    return this.db.organization.findFirst({ where: { id: organizationId, deletedAt: null }, select: MARCA });
  }

  marcas(ids: readonly string[]): Promise<DatosDeMarca[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.db.organization.findMany({ where: { id: { in: [...ids] } }, select: MARCA });
  }

  sedes(organizationId: string): Promise<SedeDeMarca[]> {
    return this.db.branch.findMany({ where: { organizationId, deletedAt: null }, select: SEDE, orderBy: { code: 'asc' } });
  }

  sedesDe(ids: readonly string[]): Promise<SedeDeMarca[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.db.branch.findMany({ where: { id: { in: [...ids] } }, select: SEDE });
  }

  sede(organizationId: string, branchId: string): Promise<SedeDeMarca | null> {
    return this.db.branch.findFirst({ where: { id: branchId, organizationId, deletedAt: null }, select: SEDE });
  }

  async actualizarMarca(organizationId: string, datos: CambioDeMarca): Promise<boolean> {
    const { count } = await this.db.organization.updateMany({ where: { id: organizationId, deletedAt: null }, data: datos });
    return count > 0;
  }

  async actualizarSede(organizationId: string, branchId: string, datos: CambioDeSede): Promise<boolean> {
    const { count } = await this.db.branch.updateMany({ where: { id: branchId, organizationId, deletedAt: null }, data: datos });
    return count > 0;
  }

  // ── Solicitudes ────────────────────────────────────────────────────────────

  async crear(input: { organizationId: string; branchId: string | null; field: string; proposedValue: string | null; proposedLogo: string | null; reason: string; requestedByUserId: string }): Promise<Solicitud> {
    const id = uuidv7();
    await this.db.gymChangeRequest.create({ data: { id, ...input } });
    return this.db.gymChangeRequest.findUniqueOrThrow({ where: { id }, select: SOLICITUD });
  }

  solicitud(id: string): Promise<Solicitud | null> {
    return this.db.gymChangeRequest.findUnique({ where: { id }, select: SOLICITUD });
  }

  /** Las de una marca, de la más nueva a la más vieja. */
  deMarca(organizationId: string, limite = 50): Promise<Solicitud[]> {
    return this.db.gymChangeRequest.findMany({ where: { organizationId }, select: SOLICITUD, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: limite });
  }

  /** Las pendientes de todas las marcas vivas, de la más vieja a la más nueva: así se atienden. */
  pendientes(limite = 100): Promise<Solicitud[]> {
    return this.db.gymChangeRequest.findMany({
      where: { status: 'PENDING', organization: { deletedAt: null } }, select: SOLICITUD, orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }], take: limite,
    });
  }

  contarPendientes(): Promise<number> {
    return this.db.gymChangeRequest.count({ where: { status: 'PENDING', organization: { deletedAt: null } } });
  }

  /** ¿Ya hay una pendiente para ese mismo dato (y esa misma sucursal)? */
  async hayPendiente(organizationId: string, field: string, branchId: string | null): Promise<boolean> {
    return (await this.db.gymChangeRequest.count({ where: { organizationId, field, branchId, status: 'PENDING' } })) > 0;
  }

  /** Resuelve SOLO si sigue pendiente: dos personas de GymFlow no aplican la misma dos veces. */
  async resolver(id: string, datos: { status: 'APPLIED' | 'REJECTED'; response: string | null; appliedValue: string | null; resolvedByUserId: string }): Promise<boolean> {
    const { count } = await this.db.gymChangeRequest.updateMany({ where: { id, status: 'PENDING' }, data: { ...datos, resolvedAt: new Date() } });
    return count > 0;
  }

  /** Las que esa persona pidió, ya resueltas y que todavía no ve. */
  sinVer(organizationId: string, userId: string): Promise<number> {
    return this.db.gymChangeRequest.count({ where: { organizationId, requestedByUserId: userId, status: { not: 'PENDING' }, seenAt: null } });
  }

  async marcarVistas(organizationId: string, userId: string): Promise<number> {
    const { count } = await this.db.gymChangeRequest.updateMany({
      where: { organizationId, requestedByUserId: userId, status: { not: 'PENDING' }, seenAt: null }, data: { seenAt: new Date() },
    });
    return count;
  }
}
