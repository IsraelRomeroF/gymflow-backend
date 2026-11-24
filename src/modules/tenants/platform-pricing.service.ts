import { MODULE_BY_KEY, conflict, notFound, uuidv7, validation } from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { PlatformAuditService, type PlatformActor } from '../../platform/audit/platform-audit.service.js';
import { systemContext } from '../../platform/jobs/types.js';
import { forgetModules } from '../../platform/modules/module-state.js';
import { ModuleStateRepository } from '../../platform/modules/module-state.repository.js';
import { hoyDeCobro } from './cobro-reglas.js';
import { avisoDeCambioCancelado, avisoDeCambioDePrecio, primeraVigencia } from './cobranza-reglas.js';
import { PlatformCollectionsService } from './cobranza.service.js';
import { PlatformBillingRepository } from './platform-billing.repository.js';
import { PlatformBillingService } from './platform-billing.service.js';
import { PlatformNoticeRepository } from './platform-notice.repository.js';
import { PlatformPlanRepository, type PlanDePlataforma } from './platform-plan.repository.js';
import { PlatformPriceChangeRepository, type CambioAnunciado, type ValorDePlan } from './platform-price-change.repository.js';
import { cargarVigencias, type Vigencias } from './vigencias.js';

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const nombreDe = (k: string): string => (k === 'core' ? 'Lo básico' : MODULE_BY_KEY.get(k)?.name ?? k);
const mismos = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Una marca a la que un cambio le mueve la mensualidad. */
export type Afectada = { organizationId: string; tradeName: string; beforeCents: string; afterCents: string };
export type VistaPreviaDeCambio = {
  /** La primera factura que puede llevar el cambio si se anuncia hoy. */
  minEffectiveFrom: string;
  /** Desde cuándo aplicaría (lo pedido, o la primera posible). */
  effectiveFrom: string;
  /** No le cambia la mensualidad a nadie: se guarda en el acto, sin fecha. */
  immediate: boolean;
  affected: Afectada[];
};

export type CambioJson = ReturnType<PlatformPricingService['serializar']>;

/**
 * CAMBIOS DE PRECIO Y DE PLAN CON UN MES DE AVISO (D-38, bloque 3.11).
 *
 * Un cambio que le mueve la mensualidad a alguna marca no se guarda en el
 * acto: se ANUNCIA para la primera factura con al menos un mes de aviso (o
 * una posterior). Hasta esa fecha cada marca conserva lo que tenía; ese día
 * aplica a todas. Lo que no le cambia nada a nadie (el primer precio de un
 * concepto, un plan que ninguna marca tiene) se guarda en el acto.
 *
 * Cada marca afectada recibe su aviso («tu mensualidad pasa de $X a $Y desde
 * la factura de enero») por las mismas vías que los avisos de cobranza.
 */
export class PlatformPricingService {
  private readonly repo = new PlatformBillingRepository();
  private readonly cambios = new PlatformPriceChangeRepository();
  private readonly planes = new PlatformPlanRepository();
  private readonly avisos = new PlatformNoticeRepository();
  private readonly cobro = new PlatformBillingService();
  private readonly cobranza = new PlatformCollectionsService();
  private readonly audit = new AuditService();
  private readonly cadena = new PlatformAuditService();

  /** La fecha pedida, validada: día 1 de un mes y con al menos un mes de aviso. */
  private fecha(pedida: string | undefined, hoy: string): string {
    const minima = primeraVigencia(hoy);
    if (pedida === undefined) return minima;
    if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(pedida)) throw validation('El cambio aplica desde una factura: elige el día 1 de un mes');
    if (pedida < minima) throw validation('Un cambio de precio se avisa con al menos un mes: no puede aplicar antes', undefined, 'PRICE_CHANGE_TOO_SOON');
    return pedida;
  }

  /** A qué marcas con contrato corriendo (en uso o suspendidas) les cambia la mensualidad de esa fecha con esos cambios encima. */
  private async impacto(vigencias: Vigencias, hipoteticos: readonly CambioAnunciado[], fecha: string): Promise<Afectada[]> {
    const [antes, despues] = await Promise.all([this.cobro.mensualidades(fecha, vigencias), this.cobro.mensualidades(fecha, vigencias.con(hipoteticos))]);
    const afectadas: Afectada[] = [];
    for (const [id, a] of antes) {
      const d = despues.get(id)!;
      if (a.marca.serviceStatus !== 'ACTIVE' && a.marca.serviceStatus !== 'SUSPENDED') continue;
      if (a.totalCents === d.totalCents && a.sinPrecio.join() === d.sinPrecio.join()) continue;
      afectadas.push({ organizationId: id, tradeName: a.marca.tradeName, beforeCents: a.totalCents.toString(), afterCents: d.totalCents.toString() });
    }
    return afectadas.sort((x, y) => x.tradeName.localeCompare(y.tradeName));
  }

  private hipotetico(x: { kind: 'PRICE' | 'PLAN'; moduleKey?: string; planId?: string; before: ValorDePlan; after: ValorDePlan; effectiveFrom: string }): CambioAnunciado {
    return {
      id: uuidv7(), kind: x.kind, moduleKey: x.moduleKey ?? null, planId: x.planId ?? null, before: x.before, after: x.after,
      effectiveFrom: new Date(`${x.effectiveFrom}T00:00:00.000Z`), announcedOn: new Date(), createdAt: new Date(), createdByUserId: null,
      appliedAt: null, canceledAt: null, canceledByUserId: null, cancelReason: null,
    };
  }

  // ── Precios sueltos ────────────────────────────────────────────────────────

  /** Separa lo pedido en: nada que hacer, lo que se guarda ya (primer precio) y lo que cambia un precio que ya existe. */
  private async clasificar(pedidos: ReadonlyArray<{ key: string; monthlyCents: bigint }>, vigencias: Vigencias, hoy: string) {
    for (const c of pedidos) {
      const def = MODULE_BY_KEY.get(c.key);
      if (!def || (def.kind !== 'optional' && def.key !== 'core')) throw notFound('Módulo no encontrado');
      if (c.monthlyCents < 0n) throw validation('El precio no puede ser negativo');
    }
    const hoyValen = vigencias.preciosEn(hoy);
    const anunciados = new Map(vigencias.pendientes().filter((c) => c.kind === 'PRICE').map((c) => [c.moduleKey!, c]));
    const primeros: Array<{ key: string; monthlyCents: bigint }> = [];
    const cambian: Array<{ key: string; monthlyCents: bigint; antes: bigint }> = [];
    for (const c of pedidos) {
      const pendiente = anunciados.get(c.key);
      if (pendiente) {
        // Lo mismo que ya está anunciado: nada que hacer. Otra cosa: primero se cancela lo anunciado.
        if (pendiente.after.monthlyCents === c.monthlyCents.toString()) continue;
        throw conflict(`${nombreDe(c.key)} ya tiene un cambio de precio anunciado: cancélalo antes de anunciar otro`, 'PRICE_CHANGE_PENDING');
      }
      const antes = hoyValen.get(c.key);
      if (antes === undefined) primeros.push(c);
      else if (antes !== c.monthlyCents) cambian.push({ ...c, antes });
    }
    return { primeros, cambian };
  }

  /** Qué pasaría al guardar esos precios: desde cuándo aplican y a qué marcas les mueven la mensualidad. */
  async vistaPreviaDePrecios(pedidos: ReadonlyArray<{ key: string; monthlyCents: bigint }>, effectiveFrom?: string, ahora = new Date()): Promise<VistaPreviaDeCambio> {
    const hoy = hoyDeCobro(ahora);
    const fecha = this.fecha(effectiveFrom, hoy);
    const vigencias = await cargarVigencias();
    const { cambian } = await this.clasificar(pedidos, vigencias, hoy);
    const affected = cambian.length === 0 ? [] : await this.impacto(vigencias, cambian.map((c) => this.hipotetico({
      kind: 'PRICE', moduleKey: c.key, before: { monthlyCents: c.antes.toString(), modules: [] }, after: { monthlyCents: c.monthlyCents.toString(), modules: [] }, effectiveFrom: fecha,
    })), fecha);
    return { minEffectiveFrom: primeraVigencia(hoy), effectiveFrom: fecha, immediate: affected.length === 0, affected };
  }

  /**
   * Guarda precios. El primer precio de un concepto, y un cambio que no le
   * mueve la mensualidad a ninguna marca, quedan en el acto (una transacción,
   * un asiento con el antes y el después, como en 1.13). Lo demás se ANUNCIA
   * para `effectiveFrom`: el catálogo no cambia hasta ese día.
   */
  async setPrices(pedidos: ReadonlyArray<{ key: string; monthlyCents: bigint }>, actor: PlatformActor, opciones: { effectiveFrom?: string | undefined } = {}, ahora = new Date()): Promise<{ changed: number; scheduled: CambioJson[]; affected: number }> {
    const hoy = hoyDeCobro(ahora);
    const fecha = this.fecha(opciones.effectiveFrom, hoy);
    const vigencias = await cargarVigencias();
    const { primeros, cambian } = await this.clasificar(pedidos, vigencias, hoy);
    const afectadas = cambian.length === 0 ? [] : await this.impacto(vigencias, cambian.map((c) => this.hipotetico({
      kind: 'PRICE', moduleKey: c.key, before: { monthlyCents: c.antes.toString(), modules: [] }, after: { monthlyCents: c.monthlyCents.toString(), modules: [] }, effectiveFrom: fecha,
    })), fecha);
    const alMomento = afectadas.length === 0 ? [...primeros, ...cambian] : primeros;
    const porAnunciar = afectadas.length === 0 ? [] : cambian;

    const hechos = alMomento.length > 0 ? await this.repo.setPrices(alMomento.map((c) => ({ moduleKey: c.key, monthlyCents: c.monthlyCents })), actor.userId) : [];
    if (hechos.length > 0) {
      await this.cadena.record(actor, {
        action: 'platform.catalog.price.update', resourceType: 'PlatformPrice', resourceId: hechos.length === 1 ? hechos[0]!.moduleKey : null,
        beforeState: { prices: Object.fromEntries(hechos.map((h) => [h.moduleKey, h.beforeCents?.toString() ?? null])) },
        afterState: { prices: Object.fromEntries(hechos.map((h) => [h.moduleKey, h.afterCents.toString()])), changed: hechos.length, concepts: hechos.map((h) => nombreDe(h.moduleKey)) },
      });
    }
    let anunciados: CambioAnunciado[] = [];
    if (porAnunciar.length > 0) {
      try {
        anunciados = await this.cambios.anunciar(porAnunciar.map((c) => ({
          kind: 'PRICE' as const, moduleKey: c.key, before: { monthlyCents: c.antes.toString() }, after: { monthlyCents: c.monthlyCents.toString() }, effectiveFrom: fecha,
        })), hoy, actor.userId);
      } catch (e) {
        if ((e as { code?: unknown }).code === 'P2002') throw conflict('Uno de esos precios ya tiene un cambio anunciado: cancélalo antes de anunciar otro', 'PRICE_CHANGE_PENDING');
        throw e;
      }
      await this.cadena.record(actor, {
        action: 'platform.catalog.change.schedule', resourceType: 'PlatformPriceChange', resourceId: anunciados.length === 1 ? anunciados[0]!.id : null,
        beforeState: { prices: Object.fromEntries(porAnunciar.map((c) => [c.key, c.antes.toString()])) },
        afterState: {
          prices: Object.fromEntries(porAnunciar.map((c) => [c.key, c.monthlyCents.toString()])), concepts: porAnunciar.map((c) => nombreDe(c.key)),
          effectiveFrom: fecha, announcedOn: hoy, organizationsAffected: afectadas.length,
        },
      });
      await this.reconciliarAvisos(fecha, ahora);
    }
    return { changed: hechos.length, scheduled: await this.serializarVarios(anunciados), affected: afectadas.length };
  }

  // ── Planes ─────────────────────────────────────────────────────────────────

  private terminos(antes: PlanDePlataforma, pedido: { monthlyCents?: bigint | null | undefined; modules?: string[] | undefined }): { antes: ValorDePlan; despues: ValorDePlan; cambia: boolean } {
    const a: ValorDePlan = { monthlyCents: antes.monthlyCents?.toString() ?? null, modules: antes.modules };
    const d: ValorDePlan = {
      monthlyCents: pedido.monthlyCents === undefined ? a.monthlyCents : pedido.monthlyCents === null ? null : pedido.monthlyCents.toString(),
      modules: pedido.modules ?? a.modules,
    };
    return { antes: a, despues: d, cambia: a.monthlyCents !== d.monthlyCents || !mismos(a.modules, d.modules) };
  }

  /** Qué pasaría al cambiar el precio o los módulos de un plan. */
  async vistaPreviaDePlan(planId: string, pedido: { monthlyCents?: bigint | null | undefined; modules?: string[] | undefined }, effectiveFrom?: string, ahora = new Date()): Promise<VistaPreviaDeCambio & { organizations: number }> {
    const hoy = hoyDeCobro(ahora);
    const fecha = this.fecha(effectiveFrom, hoy);
    const plan = await this.planes.find(planId);
    if (!plan) throw notFound('Plan no encontrado');
    const t = this.terminos(plan, pedido);
    const conPlan = (await this.repo.organizations()).filter((m) => m.platformPlanId === planId).length;
    const affected = t.cambia ? await this.impacto(await cargarVigencias(), [this.hipotetico({ kind: 'PLAN', planId, before: t.antes, after: t.despues, effectiveFrom: fecha })], fecha) : [];
    return { minEffectiveFrom: primeraVigencia(hoy), effectiveFrom: fecha, immediate: !t.cambia || conPlan === 0, affected, organizations: conPlan };
  }

  /**
   * Cambia un plan. El nombre, la descripción, el orden y si se ofrece cambian
   * en el acto: no mueven lo que nadie paga. El PRECIO y los MÓDULOS, si alguna
   * marca tiene el plan, se anuncian para `effectiveFrom`: hasta ese día cada
   * marca conserva su versión.
   */
  async actualizarPlan(planId: string, pedido: Partial<{ name: string; description: string | null; modules: string[]; monthlyCents: bigint | null; isActive: boolean; sortOrder: number }>, actor: PlatformActor, opciones: { effectiveFrom?: string | undefined } = {}, ahora = new Date()): Promise<{ plan: PlanDePlataforma; antes: PlanDePlataforma; scheduled: CambioJson | null; affected: number }> {
    const hoy = hoyDeCobro(ahora);
    const antes = await this.planes.find(planId);
    if (!antes) throw notFound('Plan no encontrado');
    const t = this.terminos(antes, pedido);
    const conPlan = t.cambia ? (await this.repo.organizations()).filter((m) => m.platformPlanId === planId).length : 0;
    const seAnuncia = t.cambia && conPlan > 0;
    const { modules: _m, monthlyCents: _c, ...cosmeticos } = pedido;
    void _m; void _c;
    let anunciado: CambioAnunciado | null = null;
    let afectadas: Afectada[] = [];
    if (seAnuncia) {
      const fecha = this.fecha(opciones.effectiveFrom, hoy);
      const vigencias = await cargarVigencias();
      if (vigencias.pendientes().some((c) => c.kind === 'PLAN' && c.planId === planId)) throw conflict('Ese plan ya tiene un cambio anunciado: cancélalo antes de anunciar otro', 'PRICE_CHANGE_PENDING');
      afectadas = await this.impacto(vigencias, [this.hipotetico({ kind: 'PLAN', planId, before: t.antes, after: t.despues, effectiveFrom: fecha })], fecha);
      try {
        [anunciado] = await this.cambios.anunciar([{ kind: 'PLAN', planId, before: t.antes, after: t.despues, effectiveFrom: fecha }], hoy, actor.userId) as [CambioAnunciado];
      } catch (e) {
        if ((e as { code?: unknown }).code === 'P2002') throw conflict('Ese plan ya tiene un cambio anunciado: cancélalo antes de anunciar otro', 'PRICE_CHANGE_PENDING');
        throw e;
      }
      await this.cadena.record(actor, {
        action: 'platform.catalog.change.schedule', resourceType: 'PlatformPriceChange', resourceId: anunciado.id,
        beforeState: { plan: antes.name, ...t.antes }, afterState: { plan: antes.name, planId, ...t.despues, effectiveFrom: fecha, announcedOn: hoy, organizationsWithPlan: conPlan, organizationsAffected: afectadas.length },
      });
    }
    const alMomento = { ...cosmeticos, ...(t.cambia && !seAnuncia ? { modules: t.despues.modules, monthlyCents: t.despues.monthlyCents === null ? null : BigInt(t.despues.monthlyCents) } : {}) };
    const plan = Object.keys(alMomento).length > 0 ? await this.planes.update(planId, alMomento) : antes;
    if (!plan) throw notFound('Plan no encontrado');
    if (anunciado) await this.reconciliarAvisos(iso(anunciado.effectiveFrom), ahora);
    return { plan, antes, scheduled: anunciado ? (await this.serializarVarios([anunciado]))[0]! : null, affected: afectadas.length };
  }

  // ── Cancelar, aplicar, avisar ──────────────────────────────────────────────

  /** Cancela un cambio anunciado que todavía no aplica: todo sigue como estaba. A quien ya se le había avisado se le avisa que ya no aplica. */
  async cancelar(id: string, reason: string, actor: PlatformActor, ahora = new Date()): Promise<CambioJson> {
    const c = await this.cambios.find(id);
    if (!c) throw notFound('Cambio no encontrado');
    if (!(await this.cambios.cancelar(id, actor.userId, reason, ahora))) {
      throw conflict(c.appliedAt ? 'Ese cambio ya aplicó: para regresar al precio anterior se anuncia otro cambio' : 'Ese cambio ya estaba cancelado', 'PRICE_CHANGE_CLOSED');
    }
    await this.cadena.record(actor, {
      action: 'platform.catalog.change.cancel', resourceType: 'PlatformPriceChange', resourceId: id, reason,
      afterState: { kind: c.kind, concept: await this.concepto(c), effectiveFrom: iso(c.effectiveFrom), ...c.after },
    });
    await this.reconciliarAvisos(iso(c.effectiveFrom), ahora);
    return (await this.serializarVarios([(await this.cambios.find(id))!]))[0]!;
  }

  /**
   * Aplica los cambios cuya fecha ya llegó (lo corre el cierre diario, antes
   * de emitir). El catálogo pasa a valer lo nuevo; en un plan, cada marca que
   * lo tiene recibe su versión nueva y los módulos que el plan gana quedan
   * contratados. Un módulo que el plan pierde NO se le quita a nadie: sigue
   * contratado y desde ese mes se cobra aparte, como se le avisó.
   */
  async aplicarVencidos(ahora = new Date(), opciones: { /** Solo estos cambios (pruebas, o una corrida a mano). */ soloCambios?: readonly string[] } = {}): Promise<{ applied: number; organizations: number; errors: Array<{ id: string; error: string }> }> {
    const hoy = hoyDeCobro(ahora);
    const r = { applied: 0, organizations: 0, errors: [] as Array<{ id: string; error: string }> };
    const fechas = new Set<string>();
    for (const c of await this.cambios.pendientes()) {
      if (iso(c.effectiveFrom) > hoy) continue;
      if (opciones.soloCambios && !opciones.soloCambios.includes(c.id)) continue;
      try {
        const hecho = await this.cambios.aplicar(c, hoy, ahora);
        if (!hecho) continue;
        r.applied += 1;
        fechas.add(iso(c.effectiveFrom));
        const nuevos = c.kind === 'PLAN' ? c.after.modules.filter((k) => !c.before.modules.includes(k)) : [];
        const concepto = await this.concepto(c);
        for (const m of hecho.organizations) {
          r.organizations += 1;
          for (const k of nuevos) await new ModuleStateRepository(m.id).setEntitlement(k, true, null, `Plan «${concepto}»: lo incluye desde ${iso(c.effectiveFrom)}`);
          forgetModules(m.id);
          await this.audit.record(systemContext(m.id), {
            action: 'platform.plan.version', resourceType: 'Organization', resourceId: m.id,
            beforeState: { plan: concepto, ...c.before }, afterState: { plan: concepto, planId: c.planId, ...c.after, effectiveFrom: iso(c.effectiveFrom), announcedOn: iso(c.announcedOn) },
          });
        }
        await this.cadena.record({ userId: null }, {
          action: 'platform.catalog.change.apply', resourceType: 'PlatformPriceChange', resourceId: c.id,
          beforeState: { ...c.before }, afterState: { kind: c.kind, concept: concepto, ...c.after, effectiveFrom: iso(c.effectiveFrom), announcedOn: iso(c.announcedOn), organizations: hecho.organizations.length },
        });
      } catch (e) {
        r.errors.push({ id: c.id, error: e instanceof Error ? e.message.split('\n')[0]!.slice(0, 200) : 'error desconocido' });
      }
    }
    // Lo anunciado ya es lo vigente: sus avisos dejan de hacer falta.
    for (const fecha of fechas) await this.avisos.cerrar((await this.avisos.abiertosDeCambio(fecha)).map((a) => a.id), 'APPLIED', ahora);
    return r;
  }

  /**
   * Deja los avisos de «tu mensualidad cambia» como deben estar para una
   * fecha: uno abierto por cada marca con contrato corriendo cuya mensualidad
   * de ese día es distinta de la de hoy, con las cifras de ahora. Se puede
   * correr las veces que sea: no duplica; si las cifras cambiaron, sustituye
   * el aviso; si el cambio se canceló, lo cierra y, a quien ya lo había
   * recibido, le avisa que ya no aplica.
   */
  async reconciliarAvisos(fecha: string, ahora = new Date()): Promise<{ created: number; closed: number }> {
    const hoy = hoyDeCobro(ahora);
    const r = { created: 0, closed: 0 };
    if (fecha <= hoy) return r;
    const vigencias = await cargarVigencias();
    const [actuales, futuras, abiertos] = await Promise.all([this.cobro.mensualidades(hoy, vigencias), this.cobro.mensualidades(fecha, vigencias), this.avisos.abiertosDeCambio(fecha)]);
    for (const [id, a] of actuales) {
      if (a.marca.serviceStatus !== 'ACTIVE' && a.marca.serviceStatus !== 'SUSPENDED') continue;
      const f = futuras.get(id)!;
      const abierto = abiertos.find((x) => x.organizationId === id) ?? null;
      const llave = `${id}:${fecha}`;
      if (f.totalCents !== a.totalCents) {
        const texto = avisoDeCambioDePrecio({ effectiveFrom: fecha, antesCents: a.totalCents, despuesCents: f.totalCents });
        if (abierto?.body === texto.body) continue;
        if (abierto) r.closed += await this.avisos.cerrar([abierto.id], 'SUPERSEDED', ahora);
        if (await this.cobranza.avisar({ organizationId: id, kind: 'PRICE_CHANGE', llave, texto, amountCents: f.totalCents }, ahora)) r.created += 1;
      } else if (abierto) {
        r.closed += await this.avisos.cerrar([abierto.id], 'CANCELED', ahora);
        if (abierto.deliveredOn) await this.cobranza.avisar({ organizationId: id, kind: 'PRICE_CHANGE_CANCELED', llave, texto: avisoDeCambioCancelado({ effectiveFrom: fecha, sigueCents: a.totalCents }) }, ahora);
      }
    }
    return r;
  }

  /** La corrida diaria: aplica lo que ya llegó a su fecha y pone al día los avisos de lo que sigue anunciado. */
  async correr(ahora = new Date()): Promise<{ applied: number; organizations: number; notices: number; errors: Array<{ id: string; error: string }> }> {
    const aplicado = await this.aplicarVencidos(ahora);
    let notices = 0;
    for (const fecha of new Set((await this.cambios.pendientes()).map((c) => iso(c.effectiveFrom)))) notices += (await this.reconciliarAvisos(fecha, ahora)).created;
    return { ...aplicado, notices };
  }

  // ── Leer ───────────────────────────────────────────────────────────────────

  private async concepto(c: CambioAnunciado): Promise<string> {
    if (c.kind === 'PRICE') return nombreDe(c.moduleKey!);
    return (await this.planes.find(c.planId!))?.name ?? 'Plan';
  }

  serializar(c: CambioAnunciado, concepto: string) {
    return {
      id: c.id, kind: c.kind, moduleKey: c.moduleKey, planId: c.planId, concept: concepto,
      beforeCents: c.before.monthlyCents, afterCents: c.after.monthlyCents,
      ...(c.kind === 'PLAN' ? { beforeModules: c.before.modules, afterModules: c.after.modules } : {}),
      effectiveFrom: iso(c.effectiveFrom), announcedOn: iso(c.announcedOn),
      status: (c.canceledAt ? 'CANCELED' : c.appliedAt ? 'APPLIED' : 'PENDING') as 'PENDING' | 'APPLIED' | 'CANCELED',
      cancelReason: c.cancelReason,
    };
  }

  private async serializarVarios(cs: readonly CambioAnunciado[]): Promise<CambioJson[]> {
    const salida: CambioJson[] = [];
    for (const c of cs) salida.push(this.serializar(c, await this.concepto(c)));
    return salida;
  }

  /** Los cambios anunciados (pendientes primero) y los últimos aplicados o cancelados. */
  async lista(ahora = new Date()): Promise<{ minEffectiveFrom: string; changes: CambioJson[] }> {
    const todos = await this.serializarVarios(await this.cambios.recientes());
    const orden = { PENDING: 0, APPLIED: 1, CANCELED: 2 } as const;
    return { minEffectiveFrom: primeraVigencia(hoyDeCobro(ahora)), changes: todos.sort((a, b) => orden[a.status] - orden[b.status] || a.effectiveFrom.localeCompare(b.effectiveFrom)) };
  }
}
