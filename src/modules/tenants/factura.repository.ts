import { uuidv7 } from '@gymflow/core';
import { GlobalRepository } from '../../platform/db/tenant-repository.js';
import { seEnciman, type Ajuste, type CambioDeIva, type ClaseDeAjuste } from './factura-reglas.js';

/** Un descuento o precio especial como está guardado. */
export type AjusteGuardado = Ajuste & {
  organizationId: string; createdAt: Date; createdByUserId: string | null;
  canceledAt: Date | null; canceledByUserId: string | null; cancelReason: string | null;
};
/** Un cambio de IVA como está guardado. */
export type IvaGuardado = CambioDeIva & {
  announcedOn: string; createdAt: Date; createdByUserId: string | null;
  canceledAt: Date | null; canceledByUserId: string | null; cancelReason: string | null;
};

const SELECT_AJUSTE = {
  id: true, organizationId: true, kind: true, percentBps: true, amountCents: true, fromMonth: true, months: true, reason: true,
  createdAt: true, createdByUserId: true, canceledAt: true, canceledByUserId: true, cancelReason: true,
} as const;
const SELECT_IVA = {
  id: true, rateBps: true, included: true, effectiveFrom: true, announcedOn: true, createdAt: true, createdByUserId: true,
  canceledAt: true, canceledByUserId: true, cancelReason: true,
} as const;

const dia = (fecha: string): Date => new Date(`${fecha}T00:00:00.000Z`);
const iso = (d: Date): string => d.toISOString().slice(0, 10);
type FilaDeAjuste = { id: string; organizationId: string; kind: string; percentBps: number | null; amountCents: bigint | null; fromMonth: Date; months: number; reason: string; createdAt: Date; createdByUserId: string | null; canceledAt: Date | null; canceledByUserId: string | null; cancelReason: string | null };
const ajuste = (f: FilaDeAjuste): AjusteGuardado => ({ ...f, kind: f.kind as ClaseDeAjuste, fromMonth: iso(f.fromMonth), canceled: f.canceledAt !== null });
type FilaDeIva = { id: string; rateBps: number; included: boolean; effectiveFrom: Date; announcedOn: Date; createdAt: Date; createdByUserId: string | null; canceledAt: Date | null; canceledByUserId: string | null; cancelReason: string | null };
const iva = (f: FilaDeIva): IvaGuardado => ({ ...f, effectiveFrom: iso(f.effectiveFrom), announcedOn: iso(f.announcedOn), canceled: f.canceledAt !== null });

/**
 * LO QUE LA FACTURA DE GYMFLOW NECESITA ADEMÁS DE PRECIOS Y PLANES (D-39,
 * bloque 4.9): los descuentos o precios especiales de cada marca, el IVA con
 * su fecha de inicio y desde qué día está contratado cada módulo agregado.
 * Global: lo opera quien lleva GymFlow. Nada de esto se borra.
 */
export class PlatformInvoiceRulesRepository extends GlobalRepository {
  // ── Descuentos ─────────────────────────────────────────────────────────────

  /** Los ajustes VIVOS de todas las marcas, en una consulta: el panorama y el lote los reparten por marca. */
  async ajustesVivos(): Promise<Map<string, AjusteGuardado[]>> {
    const filas = await this.db.organizationBillingAdjustment.findMany({ where: { canceledAt: null }, select: SELECT_AJUSTE, orderBy: [{ fromMonth: 'asc' }, { id: 'asc' }] });
    const mapa = new Map<string, AjusteGuardado[]>();
    for (const f of filas) mapa.set(f.organizationId, [...(mapa.get(f.organizationId) ?? []), ajuste(f)]);
    return mapa;
  }

  /** Todos los de una marca, vivos y cancelados, del más nuevo al más viejo. */
  async ajustesDe(organizationId: string): Promise<AjusteGuardado[]> {
    return (await this.db.organizationBillingAdjustment.findMany({ where: { organizationId }, select: SELECT_AJUSTE, orderBy: [{ fromMonth: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] })).map(ajuste);
  }

  async ajuste(id: string): Promise<AjusteGuardado | null> {
    const f = await this.db.organizationBillingAdjustment.findUnique({ where: { id }, select: SELECT_AJUSTE });
    return f ? ajuste(f) : null;
  }

  /**
   * Da un ajuste. Con la marca bajo candado: dos capturas a la vez no dejan
   * dos descuentos vivos en el mismo mes. `null` si la marca no existe;
   * `'ENCIMA'` si ya tiene uno vivo que toca alguno de esos meses.
   */
  async crearAjuste(input: { organizationId: string; kind: ClaseDeAjuste; percentBps: number | null; amountCents: bigint | null; fromMonth: string; months: number; reason: string; byUserId: string | null }): Promise<AjusteGuardado | 'ENCIMA' | null> {
    return this.db.$transaction(async (tx) => {
      const marcas = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM organizations WHERE id = ${input.organizationId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
      if (marcas.length === 0) return null;
      const vivos = (await tx.organizationBillingAdjustment.findMany({ where: { organizationId: input.organizationId, canceledAt: null }, select: SELECT_AJUSTE })).map(ajuste);
      if (vivos.some((v) => seEnciman(v, input))) return 'ENCIMA' as const;
      const creado = await tx.organizationBillingAdjustment.create({
        data: {
          id: uuidv7(), organizationId: input.organizationId, kind: input.kind, percentBps: input.percentBps, amountCents: input.amountCents,
          fromMonth: dia(input.fromMonth), months: input.months, reason: input.reason, createdByUserId: input.byUserId,
        },
        select: SELECT_AJUSTE,
      });
      return ajuste(creado);
    });
  }

  /** Cancela un ajuste vivo: las facturas que se emitan desde ahora ya no lo llevan. Las ya emitidas no cambian. */
  async cancelarAjuste(id: string, byUserId: string | null, reason: string, ahora: Date): Promise<boolean> {
    const { count } = await this.db.organizationBillingAdjustment.updateMany({ where: { id, canceledAt: null }, data: { canceledAt: ahora, canceledByUserId: byUserId, cancelReason: reason } });
    return count > 0;
  }

  // ── IVA ────────────────────────────────────────────────────────────────────

  /** Los cambios de IVA no cancelados: con ellos se sabe qué IVA lleva la factura de cada mes. */
  async ivaVigente(): Promise<IvaGuardado[]> {
    return (await this.db.platformTaxChange.findMany({ where: { canceledAt: null }, select: SELECT_IVA, orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }] })).map(iva);
  }

  async ivaReciente(limite = 20): Promise<IvaGuardado[]> {
    return (await this.db.platformTaxChange.findMany({ select: SELECT_IVA, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limite })).map(iva);
  }

  async cambioDeIva(id: string): Promise<IvaGuardado | null> {
    const f = await this.db.platformTaxChange.findUnique({ where: { id }, select: SELECT_IVA });
    return f ? iva(f) : null;
  }

  async anunciarIva(input: { rateBps: number; included: boolean; effectiveFrom: string; announcedOn: string; byUserId: string | null }): Promise<IvaGuardado> {
    return iva(await this.db.platformTaxChange.create({
      data: { id: uuidv7(), rateBps: input.rateBps, included: input.included, effectiveFrom: dia(input.effectiveFrom), announcedOn: dia(input.announcedOn), createdByUserId: input.byUserId },
      select: SELECT_IVA,
    }));
  }

  /** Cancela un cambio de IVA que todavía no empieza (`antesDe`: el primer día que ya no se puede cancelar). */
  async cancelarIva(id: string, byUserId: string | null, reason: string, ahora: Date, hoy: string): Promise<boolean> {
    const { count } = await this.db.platformTaxChange.updateMany({ where: { id, canceledAt: null, effectiveFrom: { gt: dia(hoy) } }, data: { canceledAt: ahora, canceledByUserId: byUserId, cancelReason: reason } });
    return count > 0;
  }

  // ── Desde cuándo está contratado cada módulo agregado ──────────────────────

  /** Por marca: el día en que se contrató cada módulo agregado después del alta. Lo que no está aquí viene desde que la marca empezó. */
  async contratadosDesde(organizationId?: string): Promise<Map<string, Map<string, string>>> {
    const filas = await this.db.organizationEntitlement.findMany({
      where: { granted: true, contractedOn: { not: null }, ...(organizationId ? { organizationId } : {}) }, select: { organizationId: true, moduleKey: true, contractedOn: true },
    });
    const mapa = new Map<string, Map<string, string>>();
    for (const f of filas) {
      if (!mapa.has(f.organizationId)) mapa.set(f.organizationId, new Map());
      mapa.get(f.organizationId)!.set(f.moduleKey, iso(f.contractedOn!));
    }
    return mapa;
  }

  /** Anota (o quita) desde qué día está contratado un módulo. La fila ya existe: la acaba de escribir quien contrató. */
  async marcarContratadoDesde(organizationId: string, moduleKey: string, desde: string | null): Promise<void> {
    await this.db.organizationEntitlement.updateMany({ where: { organizationId, moduleKey }, data: { contractedOn: desde ? dia(desde) : null } });
  }
}
