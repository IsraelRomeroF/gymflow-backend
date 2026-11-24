import { PLAZOS_DEL_SOCIO, PLAZO_KEYS, resolverPlazos, type PlazoKey, type PlazosDelSocio } from '@gymflow/core';
import { TenantRepository } from '../db/tenant-repository.js';

/**
 * LOS PLAZOS DEL SOCIO DE UN GIMNASIO (D-18; fase 4, bloque 4.4).
 *
 * Vive en `platform` y no en un módulo porque los leen cuatro: `memberships`
 * (la venta sin cobrar y la suspendida que termina), `billing` (la deuda que
 * se da por perdida), `retention` (dejó de venir, perdido, Recuperar) y
 * `analytics` (las bajas del Inicio). Si viviera en uno, los otros tres
 * dependerían de él.
 *
 * Sin fila, o con una columna nula, vale el de fábrica del núcleo
 * (`PLAZOS_DEL_SOCIO`). Lo guardado que ya no sea válido se ignora
 * (`resolverPlazos`): un valor raro en la base no tira ninguna pantalla.
 */
export type PlazosDelGimnasio = {
  terms: PlazosDelSocio;
  /** Las llaves que el gimnasio ajustó. */
  customized: PlazoKey[];
  updatedAt: Date | null;
  updatedByUserId: string | null;
  updatedByName: string | null;
};

const SELECT = {
  dormantDays: true, churnDays: true, lostDays: true, winbackMonths: true, unpaidSaleDays: true, lostDebtDays: true,
  updatedAt: true, updatedByUserId: true,
} as const;

export class PlazosDelSocioRepository extends TenantRepository {
  async get(): Promise<PlazosDelGimnasio> {
    const fila = await this.db.memberTermSettings.findUnique({ where: { organizationId: this.organizationId }, select: SELECT });
    if (!fila) return { terms: PLAZOS_DEL_SOCIO, customized: [], updatedAt: null, updatedByUserId: null, updatedByName: null };
    const quien = fila.updatedByUserId
      ? await this.db.user.findFirst({ where: this.scope({ id: fila.updatedByUserId }), select: { fullName: true } })
      : null;
    const terms = resolverPlazos(fila);
    return {
      terms,
      // «Ajustado» es lo que de verdad rige distinto de fábrica, no lo que haya en la columna.
      customized: PLAZO_KEYS.filter((k) => fila[k] !== null && terms[k] === fila[k] && terms[k] !== PLAZOS_DEL_SOCIO[k]),
      updatedAt: fila.updatedAt, updatedByUserId: fila.updatedByUserId, updatedByName: quien?.fullName ?? null,
    };
  }

  /** Solo los plazos: lo que necesitan los jobs y las consultas. */
  async terms(): Promise<PlazosDelSocio> {
    return (await this.get()).terms;
  }

  /**
   * Guarda SOLO las llaves que llegan; las demás columnas no se tocan. Un
   * valor igual al de fábrica se guarda como nulo: «sin ajuste» sigue al de
   * fábrica si algún día cambia.
   */
  async set(cambios: Partial<Record<PlazoKey, number>>, userId: string | null): Promise<PlazosDelGimnasio> {
    const datos: Partial<Record<PlazoKey, number | null>> = {};
    for (const k of PLAZO_KEYS) {
      const v = cambios[k];
      if (v !== undefined) datos[k] = v === PLAZOS_DEL_SOCIO[k] ? null : v;
    }
    await this.db.memberTermSettings.upsert({
      where: { organizationId: this.organizationId },
      create: { organizationId: this.organizationId, ...datos, updatedByUserId: userId },
      update: { ...datos, updatedByUserId: userId },
    });
    return this.get();
  }
}

/** Atajo para los jobs y las consultas: los plazos que rigen hoy en ese gimnasio. */
export function plazosDe(organizationId: string): Promise<PlazosDelSocio> {
  return new PlazosDelSocioRepository(organizationId).terms();
}
