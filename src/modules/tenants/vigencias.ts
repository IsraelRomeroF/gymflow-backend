import { valorEn, type CambioDeValor } from './cobranza-reglas.js';
import { ajusteDe, impuestoEn, type Ajuste, type CambioDeIva, type Impuesto } from './factura-reglas.js';
import { PlatformInvoiceRulesRepository } from './factura.repository.js';
import { PlatformBillingRepository } from './platform-billing.repository.js';
import { PlatformPriceChangeRepository, versionDePlan, type CambioAnunciado, type ValorDePlan } from './platform-price-change.repository.js';
import type { PlanDePlataforma } from './platform-plan.repository.js';

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** El plan como le aplica a una marca un día dado: lo que cuesta y lo que incluye. */
export type PlanVigente = Pick<PlanDePlataforma, 'id' | 'name' | 'modules' | 'monthlyCents'>;

/**
 * QUÉ VALE CADA COSA CADA DÍA (D-38, bloque 3.11). Los precios de hoy más los
 * cambios anunciados y los ya aplicados: con eso se responde «¿cuánto costaba
 * Clases en la factura de noviembre?» y «¿cuánto costará en la de enero?» sin
 * depender de que el job haya aplicado ya el cambio. Sin estado: se carga una
 * vez por operación.
 */
export class Vigencias {
  constructor(
    private readonly precios: ReadonlyMap<string, bigint>, readonly cambios: readonly CambioAnunciado[],
    /** D-39 (bloque 4.9): el IVA con su fecha de inicio y los descuentos vivos de cada marca. Sin ellos, ni IVA ni descuentos. */
    readonly iva: readonly CambioDeIva[] = [], private readonly ajustes: ReadonlyMap<string, readonly Ajuste[]> = new Map(),
  ) {}

  /** Lo mismo, con cambios hipotéticos encima (la vista previa de un cambio que todavía no se anuncia). */
  con(extra: readonly CambioAnunciado[]): Vigencias {
    return new Vigencias(this.precios, [...this.cambios, ...extra], this.iva, this.ajustes);
  }

  /** Lo mismo, sin un cambio (la vista previa de cancelarlo). */
  sin(id: string): Vigencias {
    return new Vigencias(this.precios, this.cambios.filter((c) => c.id !== id), this.iva, this.ajustes);
  }

  /** Lo mismo, con un cambio de IVA hipotético encima (la vista previa de anunciarlo). */
  conIva(extra: readonly CambioDeIva[]): Vigencias {
    return new Vigencias(this.precios, this.cambios, [...this.iva, ...extra], this.ajustes);
  }

  /**
   * Lo mismo, como si NADA de lo anunciado para después de `hoy` fuera a
   * aplicar (ni precios, ni planes, ni IVA). Comparar un mes futuro «con» y
   * «sin» dice cuánto le mueve la mensualidad lo anunciado, sin mezclarlo con
   * un descuento que para entonces ya caducó.
   */
  sinLoAnunciado(hoy: string): Vigencias {
    return new Vigencias(this.precios, this.cambios.filter((c) => c.appliedAt !== null || iso(c.effectiveFrom) <= hoy), this.iva.filter((c) => c.effectiveFrom <= hoy), this.ajustes);
  }

  /** El IVA que lleva la factura del mes de ese día (D-39). Sin nada anunciado, ninguno. */
  impuestoEn(dia: string): Impuesto {
    return impuestoEn(this.iva, dia);
  }

  /** Los cambios de IVA que todavía no empiezan. */
  ivaPendiente(hoy: string): CambioDeIva[] {
    return this.iva.filter((c) => !c.canceled && c.effectiveFrom > hoy);
  }

  /** Los descuentos o precios especiales vivos de una marca. */
  ajustesDe(organizationId: string): readonly Ajuste[] {
    return this.ajustes.get(organizationId) ?? [];
  }

  /** El descuento o precio especial que lleva la factura de la marca en el mes de ese día, si tiene. */
  ajusteEn(organizationId: string, dia: string): Ajuste | null {
    return ajusteDe(this.ajustesDe(organizationId), dia);
  }

  /** Los precios sueltos que valen ese día. */
  preciosEn(dia: string): Map<string, bigint> {
    const salida = new Map(this.precios);
    const porClave = new Map<string, Array<CambioDeValor<string | null>>>();
    for (const c of this.cambios) {
      if (c.kind !== 'PRICE' || !c.moduleKey) continue;
      porClave.set(c.moduleKey, [...(porClave.get(c.moduleKey) ?? []), { effectiveFrom: iso(c.effectiveFrom), before: c.before.monthlyCents, after: c.after.monthlyCents, applied: c.appliedAt !== null }]);
    }
    for (const [clave, suyos] of porClave) {
      const v = valorEn<string | null>(this.precios.get(clave)?.toString() ?? null, suyos, dia);
      if (v === null) salida.delete(clave); else salida.set(clave, BigInt(v));
    }
    return salida;
  }

  /**
   * El plan de una marca ese día. Parte de la VERSIÓN que la marca tiene
   * guardada (si no la tiene, del catálogo) y le aplica los cambios de ese
   * plan: hasta la fecha avisada conserva lo que tenía.
   */
  planEn(marca: { platformPlanId: string | null; platformPlanSnapshot: unknown }, catalogo: ReadonlyMap<string, PlanDePlataforma>, dia: string): PlanVigente | null {
    if (!marca.platformPlanId) return null;
    const vivo = catalogo.get(marca.platformPlanId) ?? null;
    const version = versionDePlan(marca.platformPlanSnapshot);
    const suya = version && version.planId === marca.platformPlanId ? version : null;
    const base: ValorDePlan | null = suya ? { monthlyCents: suya.monthlyCents, modules: suya.modules }
      : vivo ? { monthlyCents: vivo.monthlyCents?.toString() ?? null, modules: vivo.modules } : null;
    if (!base) return null;
    const suyos = this.cambios.filter((c) => c.kind === 'PLAN' && c.planId === marca.platformPlanId)
      .map((c): CambioDeValor<ValorDePlan> => ({ effectiveFrom: iso(c.effectiveFrom), before: c.before, after: c.after, applied: c.appliedAt !== null }));
    const v = valorEn(base, suyos, dia);
    return { id: marca.platformPlanId, name: vivo?.name ?? suya?.name ?? 'Plan', modules: v.modules, monthlyCents: v.monthlyCents === null ? null : BigInt(v.monthlyCents) };
  }

  /**
   * Lo contratado que cuenta como AGREGADO (se cobra aparte del plan) ese día.
   * Para un mes anterior a la versión del plan que la marca tiene hoy, lo que
   * esa versión incluye no se cobra aparte: no hay historia de contratos, y un
   * módulo que el plan ganó después (y por eso quedó contratado) no era un
   * agregado entonces. Ante la duda, de menos y no de más.
   */
  agregadosEn(marca: { platformPlanId: string | null; platformPlanSnapshot: unknown }, contratados: readonly string[], dia: string): string[] {
    const version = versionDePlan(marca.platformPlanSnapshot);
    if (!version || version.planId !== marca.platformPlanId || !version.since || dia >= version.since) return [...contratados];
    return contratados.filter((k) => !version.modules.includes(k));
  }

  /** Los cambios anunciados que todavía no aplican. */
  pendientes(): CambioAnunciado[] {
    return this.cambios.filter((c) => c.appliedAt === null);
  }
}

export async function cargarVigencias(): Promise<Vigencias> {
  const reglas = new PlatformInvoiceRulesRepository();
  const [precios, cambios, iva, ajustes] = await Promise.all([new PlatformBillingRepository().prices(), new PlatformPriceChangeRepository().vigentes(), reglas.ivaVigente(), reglas.ajustesVivos()]);
  return new Vigencias(precios, cambios, iva, ajustes);
}
