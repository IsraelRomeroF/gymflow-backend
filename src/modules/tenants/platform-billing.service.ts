import { DomainError, MODULES, MODULE_BY_KEY, conflict, formatMoney, masDias, money, notFound, validation } from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { PlatformAuditService, type PlatformActor } from '../../platform/audit/platform-audit.service.js';
import { systemContext } from '../../platform/jobs/types.js';
import { moduleViewOf } from '../../platform/modules/module-state.js';
import {
  DIAS_PARA_DESHACER, diaDeCobroDe, diasDeAtraso, esMes, estadoDeCobro, estadoDeFactura, hoyDeCobro, motivoDeNoEmitir, periodoDe, saldoDe, tieneLaDelMes, venceEl,
  type EstadoDeCobro, type FacturaDeMarca, type MotivoDeNoEmitir,
} from './cobro-reglas.js';
import { PlatformCollectionsService } from './cobranza.service.js';
import { emisor, emisorGuardado, receptorGuardado, type Receptor } from './emisor.js';
import { desglosar, descuentoDe, diasACobrar, prorratear, textoDeAjuste, textoDeDias, ultimoMesDe, type Ajuste, type Desglose, type Impuesto } from './factura-reglas.js';
import { PlatformInvoiceRulesRepository } from './factura.repository.js';
import { PlatformBillingRepository, type Factura, type LineaFactura, type MarcaParaCobro, type Pago } from './platform-billing.repository.js';
import { PlatformPlanRepository, type PlanDePlataforma } from './platform-plan.repository.js';
import { TenantService } from './tenant.service.js';
import { cargarVigencias, type PlanVigente, type Vigencias } from './vigencias.js';

export type { EstadoDeCobro } from './cobro-reglas.js';

const DIA = 86_400_000;
const pesos = (c: bigint): string => formatMoney(money(c));
const iso = (d: Date): string => d.toISOString().slice(0, 10);
/** El día en que la marca quedó en uso: desde ese mes se le puede facturar. Las de antes de ADR-037 no lo tienen: vale su alta. */
const liberadaEl = (m: MarcaParaCobro): string => diaDeCobroDe(m.activatedAt ?? m.createdAt);
const paraEstado = (f: Factura): FacturaDeMarca => ({ status: f.status, totalCents: f.totalCents, paidCents: f.paidCents, dueDate: iso(f.dueDate), periodStart: iso(f.periodStart) });

/** Las formas de pago que la plataforma registra, y cuáles no se concilian sin referencia (23-16). */
export const FORMAS_DE_PAGO = ['SPEI_TRANSFER', 'CARD', 'CASH', 'OTHER'] as const;
export type FormaDePago = (typeof FORMAS_DE_PAGO)[number];
export const PIDE_REFERENCIA: ReadonlySet<string> = new Set(['SPEI_TRANSFER', 'CARD']);

/** El porqué estable (`ERROR_REASONS`) de cada causa de no emitir, y lo que lee quien intentó emitir a UNA marca. */
const NO_EMITIR: Record<MotivoDeNoEmitir, { reason: 'ORG_NOT_IN_USE' | 'MONTH_ALREADY_INVOICED' | 'PRICES_MISSING' | 'MONTH_NOT_BILLABLE'; mensaje: (texto: string, sinPrecio: readonly string[]) => string }> = {
  NOT_IN_USE: { reason: 'ORG_NOT_IN_USE', mensaje: (t) => `${t}. Libera o reanuda el servicio antes de facturar.` },
  ALREADY_INVOICED: { reason: 'MONTH_ALREADY_INVOICED', mensaje: () => 'Ese mes ya tiene factura. Anúlala antes de emitir otra.' },
  MISSING_PRICES: { reason: 'PRICES_MISSING', mensaje: (_t, sin) => `Falta fijar el precio de: ${sin.join(', ')}. Hazlo en Precios antes de facturar.` },
  ZERO_TOTAL: { reason: 'MONTH_NOT_BILLABLE', mensaje: () => 'La mensualidad de esta marca es $0.00: no hay nada que facturar.' },
  BEFORE_RELEASE: { reason: 'MONTH_NOT_BILLABLE', mensaje: (t) => `${t}: no se factura.` },
  FUTURE_MONTH: { reason: 'MONTH_NOT_BILLABLE', mensaje: (t) => `${t}: se factura cuando empiece.` },
};

/**
 * Lo que una marca paga por un mes (D-39, bloque 4.9): sus renglones (con el
 * del descuento, en negativo, si tiene), el subtotal, el IVA y `totalCents`,
 * que es LO QUE SE PAGA. `listCents` es el mes completo a precio de lista,
 * sin descuento ni IVA.
 */
type Cuota = Desglose & {
  lines: LineaFactura[]; sinPrecio: string[]; listCents: bigint; discountCents: bigint;
  /** El descuento o precio especial que lleva ese mes y hasta la factura de qué mes dura. */
  discount: { id: string; label: string; lastMonth: string } | null;
};
/** Lo que entra a la cuenta de un mes además de precios, plan y contratado. */
type ReglasDelMes = {
  /** `AAAA-MM`. */
  mes: string; ajuste: Ajuste | null; impuesto: Impuesto;
  /** Solo al EMITIR: desde qué día cuenta cada cosa (cobro por días) y los días de meses anteriores que esta factura recoge. Sin esto, el mes completo. */
  porDias?: { liberadaEl: string; desde: ReadonlyMap<string, string>; atrasados: readonly LineaFactura[] };
};
const desgloseJson = (d: Desglose) => ({ subtotalCents: d.subtotalCents.toString(), taxCents: d.taxCents.toString(), taxRateBps: d.taxRateBps, taxIncluded: d.taxIncluded, totalCents: d.totalCents.toString() });
export type PorEmitir = ReturnType<typeof desgloseJson> & { organizationId: string; tradeName: string; lines: LineaFactura[]; discountCents: string };
export type Saltada = { organizationId: string; tradeName: string; reason: string; code: MotivoDeNoEmitir | 'ERROR'; /** Con `MISSING_PRICES`: de qué falta el precio. */ missingPrices?: string[] };
export type VistaPreviaDeEmision = { month: string; dueDate: string; toIssue: PorEmitir[]; skipped: Saltada[]; totalCents: string };
export type ResultadoDeEmitirMes = {
  month: string;
  issued: Array<{ organizationId: string; tradeName: string; folio: string; totalCents: string }>;
  skipped: Saltada[];
  /** Marcas a las que les tocaba y fallaron: el lote siguió con las demás (23-12). */
  failed: Array<{ organizationId: string; tradeName: string; error: string }>;
};

/**
 * Lo que GymFlow le cobra a cada marca: la mensualidad es lo básico más los
 * módulos contratados, al precio vigente. Cada factura guarda sus líneas: un
 * cambio de precio no toca lo ya emitido. El cobro se registra a mano (la
 * plataforma no procesa tarjetas): quien lleva GymFlow anota cada pago con su
 * importe, su forma y su referencia; la factura queda pagada cuando sus pagos
 * la cubren. Las fechas son las de la Ciudad de México (`cobro-reglas.ts`).
 */
export class PlatformBillingService {
  private readonly repo = new PlatformBillingRepository();
  private readonly reglas = new PlatformInvoiceRulesRepository();
  private readonly planes = new PlatformPlanRepository();
  private readonly audit = new AuditService();
  private readonly cadena = new PlatformAuditService();
  private readonly cobranza = new PlatformCollectionsService();

  /** Los precios de HOY y, si alguno tiene un cambio anunciado, desde cuándo y a cuánto (D-38). */
  async prices() {
    const vigencias = await cargarVigencias();
    const precios = vigencias.preciosEn(hoyDeCobro());
    const anunciados = new Map(vigencias.pendientes().filter((c) => c.kind === 'PRICE').map((c) => [c.moduleKey!, c]));
    return MODULES.filter((m) => m.kind === 'optional' || m.key === 'core').map((m) => {
      const cambio = anunciados.get(m.key);
      return {
        key: m.key as string, name: m.key === 'core' ? 'Lo básico (software)' : m.name, monthlyCents: precios.get(m.key)?.toString() ?? null,
        pending: cambio ? { id: cambio.id, monthlyCents: cambio.after.monthlyCents, effectiveFrom: iso(cambio.effectiveFrom) } : null,
      };
    });
  }

  /**
   * La mensualidad de HOY para una marca. Con un plan con precio (ADR-039):
   * la línea del plan más cada módulo contratado fuera del plan, a su precio.
   * Sin plan, o con un plan sin precio: lo básico más lo contratado, módulo
   * por módulo.
   */
  async mensualidad(organizationId: string, opciones: { dia?: string | undefined; vigencias?: Vigencias | undefined } = {}): Promise<Cuota> {
    const dia = opciones.dia ?? hoyDeCobro();
    const [vigencias, vista, marca] = await Promise.all([opciones.vigencias ?? cargarVigencias(), moduleViewOf(organizationId), this.repo.organization(organizationId)]);
    if (!marca) throw notFound('Marca no encontrada');
    const catalogo = new Map<string, PlanDePlataforma>();
    if (marca.platformPlanId) { const vivo = await this.planes.find(marca.platformPlanId); if (vivo) catalogo.set(vivo.id, vivo); }
    const contratados = MODULES.filter((m) => m.kind === 'optional' && vista.contracted(m.key)).map((m) => m.key as string);
    // Lo que vale ESE día (D-38): el precio y el plan de un mes pasado o de uno ya anunciado, no los de hoy a secas.
    return this.cuota(vigencias.preciosEn(dia), vigencias.agregadosEn(marca, contratados, dia), vigencias.planEn(marca, catalogo, dia), { mes: dia.slice(0, 7), ajuste: vigencias.ajusteEn(marca.id, dia), impuesto: vigencias.impuestoEn(dia) });
  }

  /**
   * Lo que saldría en la FACTURA de ese mes para una marca (D-39): la
   * mensualidad de ese mes, pero cobrando POR DÍAS el primer mes (desde el día
   * en que se liberó el software) y cada módulo contratado a medio mes, y
   * recogiendo los días de un módulo que se contrató cuando la factura de su
   * mes ya estaba emitida. Con `facturas` ya cargadas no vuelve a pedirlas.
   */
  private async paraEmitir(marca: MarcaParaCobro, mes: string, vigencias: Vigencias, desde: ReadonlyMap<string, string>): Promise<Cuota> {
    const { inicio } = periodoDe(mes);
    const vista = await moduleViewOf(marca.id);
    const catalogo = new Map<string, PlanDePlataforma>();
    if (marca.platformPlanId) { const vivo = await this.planes.find(marca.platformPlanId); if (vivo) catalogo.set(vivo.id, vivo); }
    const contratados = MODULES.filter((m) => m.kind === 'optional' && vista.contracted(m.key)).map((m) => m.key as string);
    const liberada = liberadaEl(marca);
    // Solo quien tiene un módulo con fecha de contratación anterior a este mes puede traer días atrasados: los demás no leen sus facturas.
    const conAtraso = contratados.filter((k) => { const d = desde.get(k); return d !== undefined && d.slice(0, 7) < mes; });
    const atrasados = conAtraso.length === 0 ? [] : this.diasAtrasados(marca, mes, vigencias, catalogo, conAtraso, desde, await this.repo.invoices(marca.id));
    return this.cuota(vigencias.preciosEn(inicio), vigencias.agregadosEn(marca, contratados, inicio), vigencias.planEn(marca, catalogo, inicio), {
      mes, ajuste: vigencias.ajusteEn(marca.id, inicio), impuesto: vigencias.impuestoEn(inicio), porDias: { liberadaEl: liberada, desde, atrasados },
    });
  }

  /**
   * MÓDULO CONTRATADO A MEDIO MES, CON LA FACTURA DE ESE MES YA EMITIDA (D-39).
   * La factura se emite al empezar el mes; un módulo contratado el día 15 no
   * venía en ella. Sus días (del 15 al último) se cobran en la SIGUIENTE
   * factura que se emita, en un renglón aparte, al precio de aquel mes. Se
   * cobra una sola vez: si la factura de aquel mes ya traía el módulo, o si
   * otra factura viva ya recogió esos días, no hay nada que recoger. Si aquel
   * mes no tiene factura viva, tampoco: cuando se emita, traerá el módulo por
   * días ella misma. Ante la duda, de menos.
   */
  private diasAtrasados(marca: MarcaParaCobro, mes: string, vigencias: Vigencias, catalogo: ReadonlyMap<string, PlanDePlataforma>, claves: readonly string[], desde: ReadonlyMap<string, string>, facturas: readonly Factura[]): LineaFactura[] {
    const vivas = facturas.filter((f) => f.status !== 'VOID');
    const liberada = liberadaEl(marca);
    const lineas: LineaFactura[] = [];
    for (const k of claves) {
      const contratadoEl = desde.get(k)!;
      const suMes = contratadoEl.slice(0, 7);
      if (suMes >= mes) continue;
      const { inicio } = periodoDe(suMes);
      const llave = `dias:${k}:${suMes}`;
      const deSuMes = vivas.find((f) => iso(f.periodStart) === inicio);
      if (!deSuMes || deSuMes.lines.some((l) => l.key === k)) continue;
      if (vivas.some((f) => f.lines.some((l) => l.key === llave))) continue;
      // En aquel mes, ¿era un agregado con precio? Lo que el plan incluía no se cobra aparte.
      const plan = vigencias.planEn(marca, catalogo, inicio);
      if (plan && plan.monthlyCents !== null && plan.modules.includes(k)) continue;
      if (!vigencias.agregadosEn(marca, [k], inicio).includes(k)) continue;
      const precio = vigencias.preciosEn(inicio).get(k);
      if (precio === undefined) continue;
      const { dias, de } = diasACobrar(suMes, contratadoEl > liberada ? contratadoEl : liberada);
      if (dias <= 0) continue;
      lineas.push({
        key: llave, name: `${MODULE_BY_KEY.get(k)?.name ?? k} · ${textoDeDias(suMes, dias, de)}`, monthlyCents: prorratear(precio, dias, de).toString(),
        kind: 'CATCH_UP', listCents: precio.toString(), days: dias, ofDays: de,
      });
    }
    return lineas;
  }

  /**
   * La mensualidad de TODAS las marcas un día dado, con lo ya cargado: la usan
   * el panorama y la vista previa de un cambio de precio (cuánto paga cada
   * marca hoy y cuánto pagará desde la fecha avisada).
   */
  async mensualidades(dia: string, vigencias: Vigencias): Promise<Map<string, Cuota & { marca: MarcaParaCobro }>> {
    const [marcas, contratacion, planes] = await Promise.all([this.repo.organizations(), this.repo.contratacion(), this.planes.list()]);
    const catalogo = new Map<string, PlanDePlataforma>(planes.map((p) => [p.id, p]));
    const opcionales = MODULES.filter((m) => m.kind === 'optional').map((m) => m.key as string);
    const precios = vigencias.preciosEn(dia);
    const salida = new Map<string, Cuota & { marca: MarcaParaCobro }>();
    for (const m of marcas) {
      const suya = contratacion.get(m.id);
      salida.set(m.id, { ...this.cuota(precios, vigencias.agregadosEn(m, opcionales.filter((k) => !suya?.noContratados.has(k)), dia), vigencias.planEn(m, catalogo, dia), { mes: dia.slice(0, 7), ajuste: vigencias.ajusteEn(m.id, dia), impuesto: vigencias.impuestoEn(dia) }), marca: m });
    }
    return salida;
  }

  /**
   * La cuenta de un mes, sin consultar nada: precios, lo contratado, el plan y
   * las reglas del mes ya vienen cargados. En orden (D-39): renglones a precio
   * de lista (por días, si toca) → descuento del mes → IVA sobre lo que queda.
   */
  private cuota(precios: Map<string, bigint>, contratados: readonly string[], plan: PlanVigente | null, reglas: ReglasDelMes): Cuota {
    const nombre = (k: string) => (k === 'core' ? 'Lo básico (software)' : MODULE_BY_KEY.get(k)!.name);
    const lines: LineaFactura[] = [];
    const sinPrecio: string[] = [];
    let lista = 0n; let base = 0n;
    /** Un renglón: completo, o por los días que le tocan de ese mes. Lo que empezó después de ese mes no sale. */
    const renglon = (key: string, name: string, cents: bigint, desde: string | null) => {
      const { dias, de } = reglas.porDias ? diasACobrar(reglas.mes, desde) : { dias: 1, de: 1 };
      if (dias <= 0) return;
      lista += cents;
      if (dias >= de) { base += cents; lines.push({ key, name, monthlyCents: cents.toString() }); return; }
      const cobrado = prorratear(cents, dias, de);
      base += cobrado;
      lines.push({ key, name: `${name} · ${textoDeDias(reglas.mes, dias, de)}`, monthlyCents: cobrado.toString(), kind: 'PRORATED', listCents: cents.toString(), days: dias, ofDays: de });
    };
    const liberada = reglas.porDias?.liberadaEl ?? null;
    /** Un módulo cuenta desde que se contrató, y nunca antes de que la marca empezara. */
    const desdeDe = (k: string): string | null => {
      const suyo = reglas.porDias?.desde.get(k) ?? null;
      return suyo && liberada && suyo > liberada ? suyo : liberada;
    };
    const porModulo = (claves: readonly string[]) => {
      for (const k of claves) {
        if (precios.has(k)) renglon(k, nombre(k), precios.get(k)!, k === 'core' ? liberada : desdeDe(k));
        else sinPrecio.push(k === 'core' ? 'Lo básico' : MODULE_BY_KEY.get(k)!.name);
      }
    };
    if (plan && plan.monthlyCents !== null) {
      renglon(`plan:${plan.id}`, `Plan ${plan.name}`, plan.monthlyCents, liberada);
      porModulo(contratados.filter((k) => !plan.modules.includes(k)));
    } else {
      porModulo(['core', ...contratados]);
    }
    // Los días de un mes anterior que esta factura recoge: se suman, pero el descuento del mes no los toca.
    let atrasado = 0n;
    for (const l of reglas.porDias?.atrasados ?? []) { lines.push(l); atrasado += BigInt(l.monthlyCents); }
    const descuento = reglas.ajuste ? descuentoDe(reglas.ajuste, base, lista) : 0n;
    if (reglas.ajuste && descuento > 0n) lines.push({ key: `ajuste:${reglas.ajuste.id}`, name: textoDeAjuste(reglas.ajuste), monthlyCents: (-descuento).toString(), kind: 'DISCOUNT' });
    return {
      lines, sinPrecio, listCents: lista, discountCents: descuento,
      discount: reglas.ajuste && descuento > 0n ? { id: reglas.ajuste.id, label: textoDeAjuste(reglas.ajuste), lastMonth: ultimoMesDe(reglas.ajuste) } : null,
      ...desglosar(base + atrasado - descuento, reglas.impuesto),
    };
  }

  /** La ficha de una marca: sus facturas, su mensualidad de hoy, su estado de cobro y los meses que se le pueden facturar. */
  async resumen(organizationId: string, ahora = new Date()) {
    const hoy = hoyDeCobro(ahora);
    const vigencias = await cargarVigencias();
    const [marca, facturas, cuota] = await Promise.all([this.repo.organization(organizationId), this.repo.invoices(organizationId), this.mensualidad(organizationId, { dia: hoy, vigencias })]);
    if (!marca) throw notFound('Marca no encontrada');
    // Lo que ya está anunciado (D-38; el IVA, D-39): la primera fecha en que lo anunciado le mueve la mensualidad.
    // Se compara ese mes CON y SIN lo anunciado: un descuento que para entonces ya caducó no es un cambio anunciado.
    let upcoming: { effectiveFrom: string; lines: LineaFactura[]; totalCents: string; taxRateBps: number; taxIncluded: boolean } | null = null;
    const sinAnuncios = vigencias.sinLoAnunciado(hoy);
    for (const fecha of [...new Set([...vigencias.pendientes().map((c) => iso(c.effectiveFrom)), ...vigencias.ivaPendiente(hoy).map((c) => c.effectiveFrom)])].sort()) {
      if (fecha <= hoy) continue;
      const [futura, igual] = await Promise.all([this.mensualidad(organizationId, { dia: fecha, vigencias }), this.mensualidad(organizationId, { dia: fecha, vigencias: sinAnuncios })]);
      if (futura.totalCents !== igual.totalCents || futura.taxCents !== igual.taxCents || futura.lines.map((l) => l.key).join() !== igual.lines.map((l) => l.key).join()) {
        upcoming = { effectiveFrom: fecha, lines: futura.lines, totalCents: futura.totalCents.toString(), taxRateBps: futura.taxRateBps, taxIncluded: futura.taxIncluded }; break;
      }
    }
    const estado = estadoDeCobro({ facturas: facturas.map(paraEstado), serviceStatus: marca.serviceStatus, sinPrecio: cuota.sinPrecio.length > 0, liberadaEl: liberadaEl(marca), hoy, mesEnCero: enCeroPorDescuento(cuota) });
    return {
      month: hoy.slice(0, 7),
      invoices: facturas.map((f) => serializar(f, hoy)),
      /** La mensualidad de un mes completo, hoy: renglones (con el del descuento), subtotal, IVA y total (D-39). */
      monthly: { lines: cuota.lines, ...desgloseJson(cuota), listCents: cuota.listCents.toString(), discountCents: cuota.discountCents.toString(), discount: cuota.discount, missingPrices: cuota.sinPrecio },
      /** La mensualidad que ya se le anunció para una fecha próxima, si cambia. */
      upcoming,
      /** A nombre de quién sale la factura (de la ficha de marca) y quién la emite (de la configuración del servidor). */
      fiscal: { receiver: receptorDe(marca), issuer: emisor() },
      serviceStatus: marca.serviceStatus,
      status: { code: estado.code, overdueDays: estado.overdueDays, pendingCents: estado.pendingCents.toString() },
      /** Los meses que el diálogo de emitir ofrece: del más reciente al de la liberación, a lo más doce. */
      billableMonths: mesesFacturables(liberadaEl(marca), hoy).map((mes) => ({ month: mes, invoiced: facturas.some((f) => f.status !== 'VOID' && iso(f.periodStart).slice(0, 7) === mes) })),
      canIssue: marca.serviceStatus === 'ACTIVE',
    };
  }

  /**
   * El estado de cobro de TODAS las marcas y lo que GymFlow factura al mes,
   * en una pasada: lo usan la lista de Marcas, su bandeja y Cobranza (23-02).
   * Es la misma función que la ficha (`estadoDeCobro`).
   */
  async panorama(ahora = new Date()): Promise<{
    month: string;
    monthlyIncome: { totalCents: bigint; organizations: number; missingPrices: Array<{ organizationId: string; tradeName: string; modules: string[] }> };
    /** Marcas en uso sin factura viva del mes en curso (23-14). */
    withoutInvoiceThisMonth: number;
    status: Map<string, { code: EstadoDeCobro; overdueDays: number; pendingCents: bigint }>;
  }> {
    const hoy = hoyDeCobro(ahora);
    const { inicio } = periodoDe(hoy.slice(0, 7));
    // Todo se carga una vez para todas las marcas (22-15): la lista ya no consulta marca por marca.
    const [facturas, cuotas] = await Promise.all([this.repo.forStatus(inicio), this.mensualidades(hoy, await cargarVigencias())]);
    const marcas = [...cuotas.values()].map((c) => c.marca);
    const porMarca = new Map<string, FacturaDeMarca[]>();
    for (const f of facturas) porMarca.set(f.organizationId, [...(porMarca.get(f.organizationId) ?? []), paraEstado(f)]);
    let total = 0n; let enUso = 0; let sinDelMes = 0;
    const missing: Array<{ organizationId: string; tradeName: string; modules: string[] }> = [];
    const status = new Map<string, { code: EstadoDeCobro; overdueDays: number; pendingCents: bigint }>();
    for (const m of marcas) {
      const suyas = porMarca.get(m.id) ?? [];
      let sinPrecio = false; let enCero = false;
      if (m.serviceStatus === 'ACTIVE') {
        // La misma cuenta que `mensualidad`, con lo ya cargado: contratado = no marcado como «no contratado».
        const cuota = cuotas.get(m.id)!;
        // El ingreso es lo que GymFlow cobra SIN el IVA (el IVA no es ingreso) y ya con los descuentos del mes (D-39).
        enUso += 1; total += cuota.subtotalCents;
        sinPrecio = cuota.sinPrecio.length > 0;
        enCero = enCeroPorDescuento(cuota);
        if (sinPrecio) missing.push({ organizationId: m.id, tradeName: m.tradeName, modules: cuota.sinPrecio });
        // Un mes que su descuento deja en $0.00 no lleva factura: no «le falta».
        if (!tieneLaDelMes(suyas, hoy) && !enCero) sinDelMes += 1;
      }
      status.set(m.id, estadoDeCobro({ facturas: suyas, serviceStatus: m.serviceStatus, sinPrecio, liberadaEl: liberadaEl(m), hoy, mesEnCero: enCero }));
    }
    return { month: hoy.slice(0, 7), monthlyIncome: { totalCents: total, organizations: enUso, missingPrices: missing }, withoutInvoiceThisMonth: sinDelMes, status };
  }

  /** Lo que GymFlow factura al mes si todas las marcas en uso pagan: la cifra de la portada (DP-03). */
  async ingresoMensual() { return (await this.panorama()).monthlyIncome; }

  // ── Emitir ─────────────────────────────────────────────────────────────────

  /**
   * Qué saldría si se emitiera ese mes (23-05): a quién, por cuánto y a quién
   * se salta y por qué. `emitirMes` y la vista previa comparten este cálculo:
   * lo que se ve es lo que se emite. Con `organizationId`, solo esa marca.
   */
  async vistaPrevia(opciones: { month?: string | undefined; organizationId?: string | undefined } = {}, ahora = new Date()): Promise<VistaPreviaDeEmision> {
    const hoy = hoyDeCobro(ahora);
    const mes = opciones.month ?? hoy.slice(0, 7);
    if (!esMes(mes)) throw validation('Mes inválido: usa AAAA-MM');
    const { inicio } = periodoDe(mes);
    let marcas: MarcaParaCobro[];
    if (opciones.organizationId) {
      const una = await this.repo.organization(opciones.organizationId);
      if (!una) throw notFound('Marca no encontrada');
      marcas = [una];
    } else {
      // El lote es de las marcas en uso; la suspendida sale «se salta» para que se vea a quién no se le cobra.
      marcas = (await this.repo.organizations()).filter((m) => m.serviceStatus === 'ACTIVE' || m.serviceStatus === 'SUSPENDED');
    }
    // Los precios y el plan del MES que se factura (D-38): su día 1. Y desde cuándo está contratado cada módulo agregado (D-39).
    const [vigencias, conFactura, desde] = await Promise.all([cargarVigencias(), this.repo.organizationsWithInvoiceFor(inicio), this.reglas.contratadosDesde(opciones.organizationId)]);
    const vacia: Cuota = { lines: [], sinPrecio: [], listCents: 0n, discountCents: 0n, discount: null, ...desglosar(0n, { rateBps: 0, included: false }) };
    const toIssue: PorEmitir[] = [];
    const skipped: Saltada[] = [];
    for (const m of marcas) {
      const de = { organizationId: m.id, tradeName: m.tradeName };
      try {
        // A la que no está en uso no se le calcula nada: no se le factura.
        const cuota: Cuota = m.serviceStatus === 'ACTIVE' ? await this.paraEmitir(m, mes, vigencias, desde.get(m.id) ?? new Map<string, string>()) : vacia;
        const no = motivoDeNoEmitir({ mes, hoy, serviceStatus: m.serviceStatus, liberadaEl: liberadaEl(m), yaTieneFactura: conFactura.has(m.id), sinPrecio: cuota.sinPrecio, totalCents: cuota.totalCents, porDescuento: enCeroPorDescuento(cuota) });
        if (no) skipped.push({ ...de, reason: no.texto, code: no.reason, ...(no.reason === 'MISSING_PRICES' ? { missingPrices: cuota.sinPrecio } : {}) });
        else { toIssue.push({ ...de, ...desgloseJson(cuota), lines: cuota.lines, discountCents: cuota.discountCents.toString() }); }
      } catch (e) {
        // Una marca que no se puede calcular no tumba a las demás (23-12).
        skipped.push({ ...de, reason: `No se pudo calcular su mensualidad: ${textoDe(e)}`, code: 'ERROR' });
      }
    }
    return { month: mes, dueDate: venceEl(hoy), toIssue, skipped, totalCents: toIssue.reduce((a, x) => a + BigInt(x.totalCents), 0n).toString() };
  }

  /**
   * Emite la factura de un mes a UNA marca (por omisión, el mes en curso en
   * la Ciudad de México). Las mismas reglas que el lote (23-06): solo a una
   * marca en uso, nunca de un mes anterior a su liberación ni de uno que no
   * ha empezado, nunca en $0 y una sola factura viva por mes.
   */
  async emitir(organizationId: string, byUserId: string | null, input: { month?: string | undefined; note?: string | undefined }, ahora = new Date()): Promise<FacturaJson> {
    const previa = await this.vistaPrevia({ month: input.month, organizationId }, ahora);
    const saltada = previa.skipped[0];
    if (saltada) {
      if (saltada.code === 'ERROR') throw conflict(saltada.reason);
      const regla = NO_EMITIR[saltada.code];
      throw conflict(regla.mensaje(saltada.reason, saltada.missingPrices ?? []), regla.reason);
    }
    return this.emitirUna(previa.toIssue[0]!, previa.month, byUserId, input.note ?? null, ahora);
  }

  /** Escribe la factura y su asiento. Si otra emisión ganó la carrera, lo dice la base (índice único de factura viva por mes). */
  private async emitirUna(x: PorEmitir, mes: string, byUserId: string | null, note: string | null, ahora: Date): Promise<FacturaJson> {
    const hoy = hoyDeCobro(ahora);
    const { inicio, fin } = periodoDe(mes);
    let factura: Factura;
    // Los datos fiscales se congelan con la factura (D-39): los del gimnasio, de su ficha; los de GymFlow, de la configuración.
    const marca = await this.repo.organization(x.organizationId);
    if (!marca) throw notFound('Marca no encontrada');
    try {
      factura = await this.repo.issue({
        organizationId: x.organizationId, periodStart: inicio, periodEnd: fin, lines: x.lines, totalCents: BigInt(x.totalCents), dueDate: venceEl(hoy), note, byUserId,
        subtotalCents: BigInt(x.subtotalCents), taxCents: BigInt(x.taxCents), taxRateBps: x.taxRateBps, taxIncluded: x.taxIncluded, discountCents: BigInt(x.discountCents),
        receiver: receptorDe(marca), issuer: emisor(),
      });
    } catch (e) {
      if ((e as { code?: unknown }).code === 'P2002') throw conflict('Ese mes ya tiene factura. Anúlala antes de emitir otra.', 'MONTH_ALREADY_INVOICED');
      throw e;
    }
    await this.audit.record(systemContext(x.organizationId), {
      action: 'platform.invoice.issue', resourceType: 'PlatformInvoice', resourceId: factura.id,
      afterState: {
        folio: factura.folio, periodStart: iso(factura.periodStart), totalCents: factura.totalCents.toString(), byPlatformUserId: byUserId,
        // D-39: con qué se armó. El descuento queda con su motivo en la bitácora de la marca.
        subtotalCents: x.subtotalCents, taxCents: x.taxCents, taxRateBps: x.taxRateBps, taxIncluded: x.taxIncluded,
        ...(x.discountCents !== '0' ? { discountCents: x.discountCents, discount: x.lines.find((l) => l.kind === 'DISCOUNT')?.name ?? null } : {}),
        ...(x.lines.some((l) => l.kind === 'PRORATED' || l.kind === 'CATCH_UP') ? { byDays: x.lines.filter((l) => l.kind === 'PRORATED' || l.kind === 'CATCH_UP').map((l) => l.name) } : {}),
      },
    });
    // D-37: el dueño se entera el día que se emite. Si el aviso no sale, la corrida diaria lo crea.
    await this.cobranza.avisarEmision(factura, ahora);
    return serializar(factura, hoy);
  }

  /**
   * Emite el mes a TODAS las marcas en uso (DP-03): la que ya tiene factura
   * se salta; la que no tiene precios completos se reporta, no se inventa.
   * Cada marca va en su propio intento: la que falla queda en `failed` y el
   * lote sigue (23-12). Lo llama el botón de Cobranza y el job del día 1, y
   * deja un asiento en la cadena de plataforma cuando emitió o falló algo.
   */
  async emitirMes(byUserId: string | null, month?: string, ahora = new Date(), actor?: PlatformActor): Promise<ResultadoDeEmitirMes> {
    const previa = await this.vistaPrevia({ month }, ahora);
    const issued: ResultadoDeEmitirMes['issued'] = [];
    const skipped = [...previa.skipped.filter((s) => s.code !== 'ERROR')];
    const failed: ResultadoDeEmitirMes['failed'] = previa.skipped.filter((s) => s.code === 'ERROR').map((s) => ({ organizationId: s.organizationId, tradeName: s.tradeName, error: s.reason }));
    for (const x of previa.toIssue) {
      try {
        const f = await this.emitirUna(x, previa.month, byUserId, null, ahora);
        issued.push({ organizationId: x.organizationId, tradeName: x.tradeName, folio: f.folio, totalCents: f.totalCents });
      } catch (e) {
        // Otra emisión se adelantó con esta marca: no es un fallo, ya tiene su factura.
        if (e instanceof DomainError && e.reason === 'MONTH_ALREADY_INVOICED') skipped.push({ organizationId: x.organizationId, tradeName: x.tradeName, reason: 'Ya tiene factura de ese mes', code: 'ALREADY_INVOICED' });
        else failed.push({ organizationId: x.organizationId, tradeName: x.tradeName, error: textoDe(e) });
      }
    }
    if (issued.length > 0 || failed.length > 0) {
      await this.cadena.record(actor ?? { userId: byUserId }, {
        action: 'platform.invoices.issue_month', resourceType: 'PlatformInvoice',
        afterState: {
          month: previa.month, issued: issued.length, skipped: skipped.length, failed: failed.length,
          totalCents: issued.reduce((a, x) => a + BigInt(x.totalCents), 0n).toString(), folios: issued.map((x) => x.folio).slice(0, 10),
          ...(failed.length > 0 ? { failedOrganizations: failed.map((x) => x.tradeName).slice(0, 10) } : {}),
        },
      });
    }
    return { month: previa.month, issued, skipped, failed };
  }

  // ── Pagar, deshacer, anular ────────────────────────────────────────────────

  /**
   * Registra un pago: el importe recibido (sin él, lo que falta), la forma,
   * el día en que llegó y la referencia, obligatoria en transferencia y
   * tarjeta (23-08, 23-16). Con abonos la factura sigue pendiente hasta que
   * sus pagos la cubren.
   */
  async pagar(id: string, byUserId: string, input: { amountCents?: bigint | undefined; paidOn?: string | undefined; paymentMethod: string; paymentRef?: string | undefined; note?: string | undefined; /** Reanudar el servicio en el mismo paso, si la marca está suspendida (D-37). */ resume?: boolean | undefined }, ahora = new Date()): Promise<FacturaConPagosJson & { service: ServicioTrasElPago }> {
    const hoy = hoyDeCobro(ahora);
    const paidOn = input.paidOn ?? hoy;
    if (paidOn > hoy) throw validation('La fecha del pago no puede ser posterior a hoy');
    const referencia = input.paymentRef?.trim() || null;
    if (PIDE_REFERENCIA.has(input.paymentMethod) && !referencia) throw validation('Escribe la referencia del pago: sin ella no se puede conciliar');
    if (input.amountCents !== undefined && input.amountCents <= 0n) throw validation('El importe del pago debe ser mayor que cero');
    const r = await this.repo.registerPayment(id, { amountCents: input.amountCents ?? null, paidOn, paymentMethod: input.paymentMethod, paymentRef: referencia, note: input.note?.trim() || null, byUserId });
    if (!r.ok) {
      if (r.por === 'NO_EXISTE') throw notFound('Factura no encontrada');
      if (r.por === 'PAGADA') throw conflict('Esa factura ya está pagada', 'ALREADY_PAID');
      if (r.por === 'ANULADA') throw conflict('Esa factura está anulada', 'ALREADY_VOIDED');
      throw conflict(`El pago es mayor que lo que falta: la factura debe ${pesos(r.saldoCents ?? 0n)}`, 'AMOUNT_OVER_BALANCE');
    }
    const f = r.factura;
    await this.audit.record(systemContext(f.organizationId), {
      action: 'platform.invoice.pay', resourceType: 'PlatformInvoice', resourceId: id,
      afterState: {
        folio: f.folio, amountCents: r.pago.amountCents.toString(), totalCents: f.totalCents.toString(), balanceCents: saldoDe(f).toString(), paid: f.status === 'PAID',
        paymentId: r.pago.id, paymentMethod: r.pago.paymentMethod, paymentRef: r.pago.paymentRef, paidOn, byPlatformUserId: byUserId,
      },
    });
    if (f.status === 'PAID') await this.cobranza.alCerrarFactura(f, 'PAID', ahora);
    return { ...(await this.conPagos(f, ahora)), service: await this.servicioTrasElPago(f, byUserId, input.resume === true, ahora) };
  }

  /**
   * D-37: al registrar el pago de una marca suspendida se ofrece reanudar EN
   * EL MISMO PASO. Sin `resume`, solo dice que se puede (la consola lo
   * pregunta); con `resume`, reanuda y lo asienta como «reanudó el servicio»,
   * con el folio del pago como motivo. Reanudar nunca es automático: lo pide
   * quien registra el pago.
   */
  private async servicioTrasElPago(f: Factura, byUserId: string, reanudar: boolean, ahora: Date): Promise<ServicioTrasElPago> {
    const marca = await this.repo.organization(f.organizationId);
    const suspendida = marca?.serviceStatus === 'SUSPENDED';
    const base = { status: (marca?.serviceStatus ?? 'ACTIVE') as ServicioTrasElPago['status'], suspendedAutomatically: marca?.suspendedAutomatically ?? false };
    if (!suspendida || !reanudar) return { ...base, canResume: suspendida, resumed: false, holdUntil: null };
    await new TenantService().cambiarServicio(f.organizationId, 'ACTIVE', byUserId, `Pago recibido: ${f.folio}`);
    const { holdUntil } = await this.cobranza.alReanudar(f.organizationId, byUserId, ahora);
    return { status: 'ACTIVE', suspendedAutomatically: false, canResume: false, resumed: true, holdUntil };
  }

  /**
   * Deshace un pago registrado por error (23-07): con motivo y hasta
   * `DIAS_PARA_DESHACER` días después de registrarlo. La factura vuelve a
   * deber ese importe; el pago queda a la vista, tachado. No es anular.
   */
  async deshacerPago(invoiceId: string, paymentId: string, byUserId: string, reason: string, ahora = new Date()): Promise<FacturaConPagosJson> {
    const r = await this.repo.undoPayment(invoiceId, paymentId, { reason, byUserId, desde: new Date(ahora.getTime() - DIAS_PARA_DESHACER * DIA) });
    if (!r.ok) {
      if (r.por === 'NO_EXISTE') throw notFound('Pago no encontrado');
      if (r.por === 'YA_DESHECHO') throw conflict('Ese pago ya se había deshecho', 'ALREADY_REVERSED');
      if (r.por === 'ANULADA') throw conflict('Esa factura está anulada', 'ALREADY_VOIDED');
      throw conflict(`Ese pago se registró hace más de ${DIAS_PARA_DESHACER} días: ya no se deshace desde aquí`, 'UNDO_WINDOW_CLOSED');
    }
    const f = r.factura;
    await this.audit.record(systemContext(f.organizationId), {
      action: 'platform.invoice.payment.undo', resourceType: 'PlatformInvoice', resourceId: invoiceId, reason,
      afterState: {
        folio: f.folio, amountCents: r.pago.amountCents.toString(), balanceCents: saldoDe(f).toString(),
        paymentId, paymentMethod: r.pago.paymentMethod, paymentRef: r.pago.paymentRef, byPlatformUserId: byUserId,
      },
    });
    return this.conPagos(f, ahora);
  }

  async anular(id: string, byUserId: string, reason: string, ahora = new Date()): Promise<FacturaJson> {
    const f = await this.repo.invoice(id);
    if (!f) throw notFound('Factura no encontrada');
    const ok = await this.repo.void(id, reason);
    if (!ok) {
      if (f.status === 'PAID') throw conflict('Una factura pagada no se anula', 'ALREADY_PAID');
      if (f.status === 'VOID') throw conflict('Esa factura ya estaba anulada', 'ALREADY_VOIDED');
      throw conflict('Esta factura tiene pagos registrados: deshazlos antes de anularla', 'INVOICE_HAS_PAYMENTS');
    }
    await this.audit.record(systemContext(f.organizationId), {
      action: 'platform.invoice.void', resourceType: 'PlatformInvoice', resourceId: id, reason, afterState: { folio: f.folio, byPlatformUserId: byUserId },
    });
    await this.cobranza.alCerrarFactura(f, 'VOIDED', ahora);
    return serializar((await this.repo.invoice(id))!, hoyDeCobro(ahora));
  }

  // ── Leer ───────────────────────────────────────────────────────────────────

  /** Todas las facturas con su marca, para la pantalla de Cobranza. */
  async facturas(filtro: { status?: string | undefined; month?: string | undefined }, ahora = new Date()) {
    if (filtro.month !== undefined && !esMes(filtro.month)) throw validation('Mes inválido: usa AAAA-MM');
    const hoy = hoyDeCobro(ahora);
    return (await this.repo.all({ status: filtro.status, periodStart: filtro.month ? periodoDe(filtro.month).inicio : undefined })).map((f) => ({ ...serializar(f, hoy), tradeName: f.tradeName }));
  }

  async pendientes(ahora = new Date()) {
    const hoy = hoyDeCobro(ahora);
    return (await this.repo.pending()).map((f) => ({ ...serializar(f, hoy), tradeName: f.tradeName }));
  }

  /** Una factura con sus pagos (vivos y deshechos). */
  async factura(id: string, ahora = new Date()): Promise<FacturaConPagosJson | null> {
    const f = await this.repo.invoice(id);
    return f ? this.conPagos(f, ahora) : null;
  }

  private async conPagos(f: Factura, ahora: Date): Promise<FacturaConPagosJson> {
    const pagos = await this.repo.payments(f.id);
    return { ...serializar(f, hoyDeCobro(ahora)), payments: pagos.map((p) => serializarPago(p, f, ahora)) };
  }
}

/** A nombre de quién sale la factura: razón social y RFC de la ficha de marca (bloque 4.6). */
const receptorDe = (m: MarcaParaCobro): Receptor => ({ legalName: m.legalName, rfc: m.rfc, tradeName: m.tradeName });
/** El descuento de ese mes deja la mensualidad en $0.00: no hay nada que facturar, y no es que «falte» la factura. */
const enCeroPorDescuento = (c: Cuota): boolean => c.totalCents <= 0n && c.discountCents > 0n && c.sinPrecio.length === 0;

const textoDe = (e: unknown): string => (e instanceof DomainError ? e.message : e instanceof Error ? e.message.split('\n')[0]!.slice(0, 200) : 'error desconocido');

/** Del mes en curso hacia atrás hasta el de la liberación, a lo más doce: lo que «Generar factura» ofrece. */
function mesesFacturables(liberada: string, hoy: string): string[] {
  const meses: string[] = [];
  let cursor = `${hoy.slice(0, 7)}-01`;
  const primero = liberada.slice(0, 7);
  while (meses.length < 12 && cursor.slice(0, 7) >= primero) {
    meses.push(cursor.slice(0, 7));
    cursor = `${masDias(cursor, -1).slice(0, 7)}-01`;
  }
  return meses;
}

/** Cómo quedó el servicio de la marca al registrar un pago (D-37). */
export type ServicioTrasElPago = {
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED'; suspendedAutomatically: boolean;
  /** La marca sigue suspendida: la consola ofrece reanudar. */
  canResume: boolean;
  /** Se reanudó en este mismo paso. */
  resumed: boolean;
  /** Si al reanudar todavía debía algo vencido, hasta cuándo no se le vuelve a suspender sola. */
  holdUntil: string | null;
};

export type FacturaJson = ReturnType<typeof serializar>;
export type PagoJson = ReturnType<typeof serializarPago>;
export type FacturaConPagosJson = FacturaJson & { payments: PagoJson[] };

/**
 * La factura como la lee la consola. `state` es EL estado (uno solo, 23-02);
 * `status` es lo guardado (PENDING, PAID, VOID) y se conserva para quien ya
 * lo leía. Las fechas son días de calendario; `paidOn` no trae hora porque
 * nadie la captura (23-15).
 */
function serializar(f: Factura, hoy: string) {
  const e = paraEstado(f);
  return {
    id: f.id, organizationId: f.organizationId, folio: f.folio, lines: f.lines, status: f.status,
    state: estadoDeFactura(e, hoy), overdueDays: diasDeAtraso(e, hoy),
    totalCents: f.totalCents.toString(), paidCents: f.paidCents.toString(), balanceCents: saldoDe(f).toString(),
    // D-39. Una factura anterior no tiene desglose: se emitió por un total y así se lee (subtotal = total, sin IVA).
    itemized: f.subtotalCents !== null, subtotalCents: (f.subtotalCents ?? f.totalCents).toString(), taxCents: f.taxCents.toString(), taxRateBps: f.taxRateBps, taxIncluded: f.taxIncluded,
    discountCents: f.discountCents.toString(),
    /** Los datos fiscales como estaban al emitir; `null` en las anteriores a D-39. */
    receiver: receptorGuardado(f.receiver), issuer: emisorGuardado(f.issuer),
    periodStart: iso(f.periodStart), periodEnd: iso(f.periodEnd), dueDate: iso(f.dueDate),
    issuedAt: f.issuedAt.toISOString(), issuedOn: diaDeCobroDe(f.issuedAt),
    paidAt: f.paidAt?.toISOString() ?? null, paidOn: f.paidAt ? diaDeCobroDe(f.paidAt) : null,
    paymentMethod: f.paymentMethod, paymentRef: f.paymentRef, note: f.note, voidReason: f.voidReason,
  };
}

function serializarPago(p: Pago, f: Factura, ahora: Date) {
  const hasta = new Date(p.createdAt.getTime() + DIAS_PARA_DESHACER * DIA);
  return {
    id: p.id, amountCents: p.amountCents.toString(), paymentMethod: p.paymentMethod, paymentRef: p.paymentRef,
    paidOn: iso(p.paidOn), note: p.note, createdAt: p.createdAt.toISOString(),
    undone: p.undoneAt !== null, undoneAt: p.undoneAt?.toISOString() ?? null, undoReason: p.undoReason,
    /** Se puede deshacer: sigue vivo, la factura no está anulada y no pasó el plazo. */
    canUndo: p.undoneAt === null && f.status !== 'VOID' && hasta.getTime() > ahora.getTime(),
    undoUntil: hasta.toISOString(),
  };
}
