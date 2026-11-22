import { businessDateIn } from '@gymflow/core';
import { TenantRepository } from '../db/tenant-repository.js';

/**
 * Fecha de negocio efectiva.
 *
 * Vive en PLATAFORMA y no en el módulo de organización por dos razones:
 *
 *  1. La necesitan todos: membresías, libro financiero, caja y bitácora. Si
 *     colgara de un módulo, la plataforma dependería de él para poder sellar
 *     una entrada de auditoría, que es exactamente la dependencia invertida
 *     que las fronteras existen para impedir.
 *  2. Antes estaba duplicada: cuatro servicios repetían `effectiveTimezone`
 *     seguido de `businessDateIn`. Una sola implementación es una sola
 *     oportunidad de equivocarse.
 *
 * México eliminó el horario de verano SALVO en la franja fronteriza norte
 * (ADR-006): por eso la zona se resuelve por SUCURSAL, no por organización,
 * y `null` significa "la de la organización".
 */
const ZONA_POR_DEFECTO = 'America/Mexico_City';

/**
 * Caché de zonas por (organización, sucursal). Casi toda escritura pide la
 * fecha de negocio —a veces varias veces— y cada consulta costaba dos
 * lecturas (OPT-05). La zona cambia rarísima vez: vive un minuto, y quien la
 * edita la olvida en el acto con `olvidarZonas`.
 */
const TTL_MS = 60_000;
const zonas = new Map<string, { zona: string; hasta: number }>();

export function olvidarZonas(organizationId: string): void {
  for (const k of zonas.keys()) if (k.startsWith(`${organizationId}:`)) zonas.delete(k);
}

/**
 * LAS SEDES QUE HOY COMPARTEN FECHA (fase 2, bloque 2.13).
 *
 * Un gimnasio de la Ciudad de México con una sede en Tijuana vive dos horas al
 * día en dos fechas distintas. Lo que se decide «por día» (vencer una
 * membresía, dar por vencido un cargo, avisar que mañana hay clase) se decide
 * con la fecha de LA SEDE de cada cosa, no con la del gimnasio.
 *
 * `sedes: null` quiere decir «todas»: el gimnasio entero está en la misma
 * fecha (lo normal: 22 de las 24 horas, y siempre si todas las sedes comparten
 * zona) y la consulta sale igual que antes, sin filtro.
 */
export type SedesDelDia = {
  readonly branchIds: readonly string[];
  /** Lo que no tiene sede (venta sin sucursal) va con la fecha del gimnasio. */
  readonly sinSede: boolean;
};
export type DiaDeSedes = { readonly day: Date; readonly sedes: SedesDelDia | null };
export type DiasDelGimnasio = {
  /** Hoy en la zona del gimnasio. */
  readonly gimnasio: Date;
  /**
   * La fecha que ya empezó en TODAS las sedes abiertas (la más atrasada). Es
   * la fecha del cierre diario: un día se cierra cuando terminó en todas.
   */
  readonly cierre: Date;
  /** Las sedes agrupadas por su fecha de hoy, de la más atrasada a la más adelantada. */
  readonly grupos: readonly DiaDeSedes[];
};

// Los filtros de consulta viven en `platform/db` (solo ahí se importa el cliente de la base).
export { dondeSede, sqlDeSede } from '../db/filtro-de-sede.js';

export class BusinessCalendar extends TenantRepository {
  /** Zona de la sucursal; si no tiene propia, la de la organización. */
  async timezoneFor(branchId?: string | null): Promise<string> {
    const clave = `${this.organizationId}:${branchId ?? ''}`;
    const guardada = zonas.get(clave);
    if (guardada && guardada.hasta > Date.now()) return guardada.zona;

    const zona = await this.leerZona(branchId);
    zonas.set(clave, { zona, hasta: Date.now() + TTL_MS });
    return zona;
  }

  private async leerZona(branchId?: string | null): Promise<string> {
    const org = await this.db.organization.findFirst({
      where: { id: this.organizationId },
      select: { timezone: true },
    });
    if (!branchId) return org?.timezone ?? ZONA_POR_DEFECTO;

    const branch = await this.db.branch.findFirst({
      where: this.scope({ id: branchId }),
      select: { timezone: true },
    });
    return branch?.timezone ?? org?.timezone ?? ZONA_POR_DEFECTO;
  }

  /** Hoy, en la zona de esa sucursal. Es la fecha con la que opera el negocio. */
  async today(branchId?: string | null, at: Date = new Date()): Promise<Date> {
    return businessDateIn(await this.timezoneFor(branchId), at);
  }

  /**
   * Hoy en cada sede del gimnasio. Lo usan los jobs: cada membresía, cargo o
   * aviso se decide con el día de operación de SU sede. Lee las zonas en una
   * consulta (cuentan también las sedes cerradas: sus membresías y cargos
   * siguen vivos); para la fecha del cierre solo mandan las abiertas.
   */
  async dias(at: Date = new Date()): Promise<DiasDelGimnasio> {
    const [org, sedes] = await Promise.all([
      this.db.organization.findFirst({ where: { id: this.organizationId }, select: { timezone: true } }),
      this.db.branch.findMany({ where: this.scope({}), select: { id: true, timezone: true, isActive: true, deletedAt: true } }),
    ]);
    const zonaDelGimnasio = org?.timezone ?? ZONA_POR_DEFECTO;
    const gimnasio = businessDateIn(zonaDelGimnasio, at);
    const porFecha = new Map<number, string[]>();
    let cierre = gimnasio;
    let abiertas = 0;
    for (const s of sedes) {
      const dia = businessDateIn(s.timezone ?? zonaDelGimnasio, at);
      porFecha.set(dia.getTime(), [...(porFecha.get(dia.getTime()) ?? []), s.id]);
      if (s.deletedAt === null && s.isActive) {
        cierre = abiertas === 0 || dia < cierre ? dia : cierre;
        abiertas += 1;
      }
    }
    if ([...porFecha.keys()].every((t) => t === gimnasio.getTime())) return { gimnasio, cierre, grupos: [{ day: gimnasio, sedes: null }] };
    if (!porFecha.has(gimnasio.getTime())) porFecha.set(gimnasio.getTime(), []);
    const grupos = [...porFecha.entries()].sort(([a], [b]) => a - b)
      .map(([t, branchIds]): DiaDeSedes => ({ day: new Date(t), sedes: { branchIds, sinSede: t === gimnasio.getTime() } }));
    return { gimnasio, cierre, grupos };
  }
}
