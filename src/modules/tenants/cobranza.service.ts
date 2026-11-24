import { DomainError, diasEntre, masDias, notFound, validation } from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { PlatformAuditService, type PlatformActor } from '../../platform/audit/platform-audit.service.js';
import { systemContext } from '../../platform/jobs/types.js';
import { forgetModules } from '../../platform/modules/module-state.js';
import { PushService } from '../identity/index.js';
import { hoyDeCobro } from './cobro-reglas.js';
import {
  DIAS_DE_PRORROGA, DIAS_MAX_DE_PRORROGA, DIAS_PARA_SUSPENDER, avisoDeFacturaEmitida, avisoDeFacturaVencida, avisoDeSuspension, decidirSuspension,
  type ClaseDeAviso, type DecisionDeSuspension, type FacturaEnCobranza, type TextoDeAviso,
} from './cobranza-reglas.js';
import { PlatformBillingRepository, type Factura, type MarcaParaCobro } from './platform-billing.repository.js';
import { PlatformNoticeRepository, type Aviso, type Dueno } from './platform-notice.repository.js';

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const saldo = (f: Factura): bigint => (f.status === 'PENDING' ? f.totalCents - f.paidCents : 0n);
const textoDe = (e: unknown): string => (e instanceof DomainError ? e.message : e instanceof Error ? e.message.split('\n')[0]!.slice(0, 200) : 'error desconocido');

export type ResultadoDeCobranza = {
  day: string;
  /** Avisos que nacieron en esta corrida, por clase. */
  noticesIssued: number; noticesOverdue: number;
  /** Marcas que el sistema suspendió en esta corrida. */
  suspended: Array<{ organizationId: string; tradeName: string; folio: string; noticedDays: number }>;
  /** Marcas con adeudo vencido que NO se suspenden porque el aviso de vencida no tiene constancia de entrega. */
  withoutDelivery: Array<{ organizationId: string; tradeName: string; folio: string; overdueDays: number }>;
  /** Marcas que ya cumplieron los días y están en prórroga. */
  onHold: Array<{ organizationId: string; tradeName: string; until: string }>;
  failed: Array<{ organizationId: string; tradeName: string; error: string }>;
};

export type AvisoJson = ReturnType<typeof serializarAviso>;
export function serializarAviso(a: Aviso) {
  return {
    id: a.id, organizationId: a.organizationId, kind: a.kind as ClaseDeAviso, invoiceId: a.invoiceId, title: a.title, body: a.body,
    noticeOn: iso(a.noticeOn), createdAt: a.createdAt.toISOString(),
    /** Por dónde hay constancia de que le llegó. */
    pushedAt: a.pushedAt?.toISOString() ?? null, pushDevices: a.pushDevices, seenAt: a.seenAt?.toISOString() ?? null, sentAt: a.sentAt?.toISOString() ?? null,
    deliveredOn: a.deliveredOn ? iso(a.deliveredOn) : null,
    closedAt: a.closedAt?.toISOString() ?? null, closeReason: a.closeReason,
  };
}

function serializarDecision(d: DecisionDeSuspension, prorrogaHasta: string | null) {
  return {
    /** `SUSPENDER` nunca se ve aquí salvo el mismo día: el job ya habrá suspendido. */
    state: d.por,
    folio: d.factura?.folio ?? null, invoiceId: d.factura?.id ?? null, balanceCents: d.factura?.saldoCents.toString() ?? null,
    overdueDays: d.overdueDays, noticedDays: d.noticedDays, suspendsOn: d.suspendsOn, holdUntil: prorrogaHasta, suspendsAfterDays: DIAS_PARA_SUSPENDER,
  };
}
export type CobranzaDeMarcaJson = ReturnType<typeof serializarDecision>;

/**
 * LA ESCALERA DE COBRANZA DE GYMFLOW (D-37, bloque 3.11; sustituye el punto 5
 * de ADR-038, ver ADR-046).
 *
 *  1. Al emitir la factura, el dueño recibe un aviso.
 *  2. El primer día de atraso recibe el aviso de «vencida».
 *  3. A los 15 días de atraso AVISADO, el sistema suspende el servicio solo.
 *     Suspender no borra ni cobra nada: cambia el estado del servicio.
 *  4. Al registrar el pago se ofrece reanudar en el mismo paso.
 *
 * Los avisos salen por lo que hay sin costo (D-34): la notificación al
 * teléfono del dueño si la tiene activada, un aviso fijo en su panel, y la
 * lista «Avisos por mandar» de la consola, desde donde una persona de GymFlow
 * se lo manda por WhatsApp con un toque. Todo queda en la bitácora de la
 * marca y, por su espejo, en la cadena de plataforma.
 */
export class PlatformCollectionsService {
  private readonly repo = new PlatformBillingRepository();
  private readonly avisos = new PlatformNoticeRepository();
  private readonly audit = new AuditService();
  private readonly cadena = new PlatformAuditService();
  private readonly push = new PushService();

  /**
   * Crea un aviso, lo manda al teléfono de los dueños que tengan avisos
   * activados y lo asienta. Devuelve null si ya existía (no se duplica).
   */
  async avisar(input: { organizationId: string; kind: ClaseDeAviso; llave: string; texto: TextoDeAviso; invoiceId?: string | null; folio?: string | null; amountCents?: bigint | null }, ahora = new Date()): Promise<Aviso | null> {
    {
      const hoy = hoyDeCobro(ahora);
      const aviso = await this.avisos.crear({
        organizationId: input.organizationId, kind: input.kind, llave: input.llave, invoiceId: input.invoiceId ?? null,
        title: input.texto.title, body: input.texto.body, noticeOn: hoy,
      });
      if (!aviso) return null;
      const duenos = await this.avisos.duenos(input.organizationId);
      const equipos = await this.push.sendToUsers(input.organizationId, duenos.map((d) => d.id), { title: input.texto.title, body: input.texto.body, url: '/cuenta-gymflow', tag: `gymflow-${aviso.id}` });
      await this.avisos.marcarNotificado(aviso.id, equipos, hoy, ahora);
      await this.audit.record(systemContext(input.organizationId), {
        action: 'platform.notice.send', resourceType: 'PlatformNotice', resourceId: aviso.id,
        afterState: {
          kind: input.kind, title: input.texto.title, folio: input.folio ?? null, ...(input.amountCents != null ? { amountCents: input.amountCents.toString() } : {}),
          owners: duenos.length, pushDevices: equipos, delivered: equipos > 0,
        },
      });
      return (await this.avisos.find(aviso.id)) ?? aviso;
    }
  }

  /**
   * El aviso de «factura emitida», en el momento de emitirla. Nunca lanza: un
   * aviso que no sale no tumba la emisión; la corrida diaria lo crea después.
   */
  async avisarEmision(f: Factura, ahora = new Date()): Promise<Aviso | null> {
    try {
      return await this.avisar({
        organizationId: f.organizationId, kind: 'INVOICE_ISSUED', llave: f.id, invoiceId: f.id, folio: f.folio, amountCents: saldo(f),
        texto: avisoDeFacturaEmitida({ folio: f.folio, periodStart: iso(f.periodStart), saldoCents: saldo(f), dueDate: iso(f.dueDate) }),
      }, ahora);
    } catch {
      return null;
    }
  }

  /**
   * LA CORRIDA DIARIA. Dos pasadas, en este orden:
   *
   *  A. Avisos que faltan. Toda factura que debe y no ha vencido tiene su aviso
   *     de «emitida»; toda factura vencida tiene su aviso de «vencida». Aquí
   *     nacen los de las facturas que ya existían antes de este bloque.
   *  B. Suspensión. Con los avisos ya leídos de la base, se decide marca por
   *     marca (`decidirSuspension`). Un aviso que nació en esta misma corrida
   *     tiene, a lo más, un día: jamás suspende en la corrida que lo crea.
   *
   * Cada marca va en su propio intento: la que falla queda en `failed` y las
   * demás siguen. Si algo pasó, queda un asiento en la cadena de plataforma.
   */
  async correr(ahora = new Date(), opciones: { /** Solo estas marcas (pruebas, o una corrida a mano para una). */ soloMarcas?: readonly string[] } = {}): Promise<ResultadoDeCobranza> {
    const hoy = hoyDeCobro(ahora);
    const r: ResultadoDeCobranza = { day: hoy, noticesIssued: 0, noticesOverdue: 0, suspended: [], withoutDelivery: [], onHold: [], failed: [] };
    const marcas = new Map((await this.repo.organizations()).filter((m) => !opciones.soloMarcas || opciones.soloMarcas.includes(m.id)).map((m) => [m.id, m]));
    const porMarca = this.agrupar(await this.repo.pending(), marcas);

    // A. Avisos que faltan.
    for (const [organizationId, facturas] of porMarca) {
      const marca = marcas.get(organizationId)!;
      try {
        const abiertos = await this.avisos.abiertosDeFacturas(facturas.map((f) => f.id));
        for (const f of facturas) {
          if (saldo(f) <= 0n) continue;
          const vencida = diasEntre(iso(f.dueDate), hoy) > 0;
          const clase: ClaseDeAviso = vencida ? 'INVOICE_OVERDUE' : 'INVOICE_ISSUED';
          if (abiertos.some((a) => a.invoiceId === f.id && a.kind === clase)) continue;
          const datos = { folio: f.folio, periodStart: iso(f.periodStart), saldoCents: saldo(f), dueDate: iso(f.dueDate) };
          const creado = await this.avisar({
            organizationId, kind: clase, llave: f.id, invoiceId: f.id, folio: f.folio, amountCents: saldo(f),
            texto: vencida ? avisoDeFacturaVencida(datos) : avisoDeFacturaEmitida(datos),
          }, ahora);
          if (creado) { if (vencida) r.noticesOverdue += 1; else r.noticesIssued += 1; }
        }
      } catch (e) {
        r.failed.push({ organizationId, tradeName: marca.tradeName, error: textoDe(e) });
      }
    }

    // B. Suspensión: solo marcas en uso, con los avisos vueltos a leer.
    for (const [organizationId, facturas] of porMarca) {
      const marca = marcas.get(organizationId)!;
      if (marca.serviceStatus !== 'ACTIVE') continue;
      try {
        const d = await this.decidir(marca, facturas, hoy);
        if (d.por === 'AVISO_SIN_ENTREGAR' && d.factura) r.withoutDelivery.push({ organizationId, tradeName: marca.tradeName, folio: d.factura.folio, overdueDays: d.overdueDays });
        if (d.por === 'PRORROGA' && marca.autoSuspendHoldUntil) r.onHold.push({ organizationId, tradeName: marca.tradeName, until: iso(marca.autoSuspendHoldUntil) });
        if (!d.suspender || !d.factura) continue;
        if (await this.suspender(marca, d, hoy, ahora)) r.suspended.push({ organizationId, tradeName: marca.tradeName, folio: d.factura.folio, noticedDays: d.noticedDays });
      } catch (e) {
        r.failed.push({ organizationId, tradeName: marca.tradeName, error: textoDe(e) });
      }
    }

    if (r.noticesIssued + r.noticesOverdue + r.suspended.length + r.failed.length > 0) {
      await this.cadena.record({ userId: null }, {
        action: 'platform.collections.run', resourceType: 'PlatformNotice',
        afterState: {
          day: hoy, noticesIssued: r.noticesIssued, noticesOverdue: r.noticesOverdue,
          suspended: r.suspended.map((s) => s.tradeName).slice(0, 20), suspendedCount: r.suspended.length,
          withoutDelivery: r.withoutDelivery.length, onHold: r.onHold.length,
          ...(r.failed.length > 0 ? { failedOrganizations: r.failed.map((x) => x.tradeName).slice(0, 10) } : {}),
        },
      });
    }
    return r;
  }

  private agrupar(facturas: ReadonlyArray<Factura>, marcas: ReadonlyMap<string, MarcaParaCobro>): Map<string, Factura[]> {
    const porMarca = new Map<string, Factura[]>();
    for (const f of facturas) {
      // Una marca borrada no está en el mapa: ni se le avisa ni se le suspende.
      if (!marcas.has(f.organizationId)) continue;
      porMarca.set(f.organizationId, [...(porMarca.get(f.organizationId) ?? []), f]);
    }
    return porMarca;
  }

  /** La decisión de una marca con sus facturas pendientes y la constancia de sus avisos de vencida. */
  private async decidir(marca: MarcaParaCobro, facturas: readonly Factura[], hoy: string): Promise<DecisionDeSuspension> {
    const abiertos = await this.avisos.abiertosDeFacturas(facturas.map((f) => f.id));
    const enCobranza: FacturaEnCobranza[] = facturas.map((f) => {
      // El aviso de vencida VIGENTE de la factura: el abierto más reciente.
      const aviso = abiertos.filter((a) => a.invoiceId === f.id && a.kind === 'INVOICE_OVERDUE').at(-1) ?? null;
      return { id: f.id, folio: f.folio, dueDate: iso(f.dueDate), saldoCents: saldo(f), avisoEntregadoEl: aviso?.deliveredOn ? iso(aviso.deliveredOn) : null };
    });
    return decidirSuspension({ serviceStatus: marca.serviceStatus, facturas: enCobranza, hoy, prorrogaHasta: marca.autoSuspendHoldUntil ? iso(marca.autoSuspendHoldUntil) : null });
  }

  /**
   * Suspende el servicio por adeudo. Solo cambia el estado del servicio (con
   * la marca bajo candado y la factura vuelta a comprobar): no anula ni cobra
   * nada, no genera recargos y no toca los datos del gimnasio. Queda en la
   * bitácora de la marca como acto del sistema, con la factura, los días y la
   * constancia del aviso; el espejo va a la cadena de plataforma.
   */
  private async suspender(marca: MarcaParaCobro, d: DecisionDeSuspension, hoy: string, ahora: Date): Promise<boolean> {
    const f = d.factura!;
    const reason = `Falta de pago: la factura ${f.folio} lleva ${d.overdueDays} días vencida (${d.noticedDays} desde que se avisó)`;
    const hecho = await this.repo.suspenderPorAdeudo(marca.id, f.id, hoy, reason, ahora);
    if (!hecho) return false;
    forgetModules(marca.id);
    await this.audit.record(systemContext(marca.id), {
      action: 'platform.service.auto_suspend', resourceType: 'Organization', resourceId: marca.id, reason,
      afterState: {
        serviceStatus: 'SUSPENDED', previous: 'ACTIVE', automatic: true, folio: f.folio, invoiceId: f.id, amountCents: f.saldoCents.toString(),
        dueDate: f.dueDate, overdueDays: d.overdueDays, noticedDays: d.noticedDays, noticeDeliveredOn: f.avisoEntregadoEl, afterDays: DIAS_PARA_SUSPENDER,
      },
    });
    try {
      await this.avisar({
        organizationId: marca.id, kind: 'SERVICE_SUSPENDED', llave: f.id, invoiceId: f.id, folio: f.folio, amountCents: f.saldoCents,
        texto: avisoDeSuspension({ folio: f.folio, saldoCents: f.saldoCents }),
      }, ahora);
    } catch { /* La suspensión ya quedó asentada: el aviso de «suspendido» no la deshace. */ }
    return true;
  }

  // ── Lo que lee la consola ──────────────────────────────────────────────────

  /** La cobranza de UNA marca: cuándo se suspendería, por qué no, su prórroga y sus avisos. */
  async deMarca(organizationId: string, ahora = new Date()): Promise<{ collections: CobranzaDeMarcaJson; notices: AvisoJson[]; owners: Dueno[] }> {
    const hoy = hoyDeCobro(ahora);
    const marca = await this.repo.organization(organizationId);
    if (!marca) throw notFound('Marca no encontrada');
    const facturas = (await this.repo.invoices(organizationId)).filter((f) => f.status === 'PENDING');
    const [d, avisos, owners] = await Promise.all([this.decidir(marca, facturas, hoy), this.avisos.deMarca(organizationId), this.avisos.duenos(organizationId)]);
    const prorroga = marca.autoSuspendHoldUntil && iso(marca.autoSuspendHoldUntil) >= hoy ? iso(marca.autoSuspendHoldUntil) : null;
    return { collections: serializarDecision(d, prorroga), notices: avisos.map(serializarAviso), owners };
  }

  /**
   * El tablero de cobranza de todas las marcas: quién se suspende y cuándo,
   * a quién no se le puede suspender porque el aviso no le ha llegado, y los
   * avisos abiertos sin constancia de entrega, con el celular del dueño para
   * mandárselo.
   */
  async tablero(ahora = new Date()) {
    const hoy = hoyDeCobro(ahora);
    const marcas = new Map((await this.repo.organizations()).map((m) => [m.id, m]));
    const porMarca = this.agrupar(await this.repo.pending(), marcas);
    const enRiesgo: Array<CobranzaDeMarcaJson & { organizationId: string; tradeName: string }> = [];
    for (const [organizationId, facturas] of porMarca) {
      const marca = marcas.get(organizationId)!;
      if (marca.serviceStatus !== 'ACTIVE') continue;
      const d = await this.decidir(marca, facturas, hoy);
      if (d.por === 'SIN_ADEUDO_VENCIDO' || d.por === 'NO_EN_USO') continue;
      const prorroga = marca.autoSuspendHoldUntil && iso(marca.autoSuspendHoldUntil) >= hoy ? iso(marca.autoSuspendHoldUntil) : null;
      enRiesgo.push({ organizationId, tradeName: marca.tradeName, ...serializarDecision(d, prorroga) });
    }
    const sinEntregar = (await this.avisos.abiertos()).filter((a) => a.deliveredOn === null && marcas.has(a.organizationId));
    const duenos = await this.avisos.duenosDe([...new Set(sinEntregar.map((a) => a.organizationId))]);
    return {
      suspendsAfterDays: DIAS_PARA_SUSPENDER,
      atRisk: enRiesgo.sort((a, b) => (a.suspendsOn ?? '9999').localeCompare(b.suspendsOn ?? '9999')),
      toSend: sinEntregar.map((a) => ({ ...serializarAviso(a), tradeName: marcas.get(a.organizationId)!.tradeName, owners: duenos.get(a.organizationId) ?? [] })),
    };
  }

  /** Una persona de GymFlow le mandó el aviso al dueño: desde hoy hay constancia. */
  async marcarMandado(noticeId: string, byUserId: string, ahora = new Date()): Promise<AvisoJson> {
    const aviso = await this.avisos.find(noticeId);
    if (!aviso) throw notFound('Aviso no encontrado');
    const hoy = hoyDeCobro(ahora);
    if (await this.avisos.marcarMandado(noticeId, byUserId, hoy, ahora)) {
      await this.audit.record(systemContext(aviso.organizationId), {
        action: 'platform.notice.deliver', resourceType: 'PlatformNotice', resourceId: noticeId,
        afterState: { kind: aviso.kind, title: aviso.title, via: 'PERSON', firstDelivery: aviso.deliveredOn === null, byPlatformUserId: byUserId },
      });
    }
    return serializarAviso((await this.avisos.find(noticeId))!);
  }

  /** El dueño abrió su panel y vio los avisos abiertos de su marca. */
  async marcarVistos(organizationId: string, userId: string, ahora = new Date()): Promise<number> {
    const vistos = await this.avisos.marcarVistos(organizationId, userId, hoyDeCobro(ahora), ahora);
    for (const a of vistos) {
      await this.audit.record(systemContext(organizationId), {
        action: 'platform.notice.deliver', resourceType: 'PlatformNotice', resourceId: a.id,
        afterState: { kind: a.kind, title: a.title, via: 'PANEL', firstDelivery: a.pushedAt === null && a.sentAt === null, seenByUserId: userId },
      });
    }
    return vistos.length;
  }

  /**
   * Prórroga: hasta ese día, incluido, la suspensión automática no toca a la
   * marca. `null` la quita. Es la palanca de quien opera GymFlow cuando ya
   * habló con el dueño; queda con motivo en la bitácora.
   */
  async prorroga(organizationId: string, until: string | null, reason: string, actor: PlatformActor, ahora = new Date()): Promise<{ holdUntil: string | null }> {
    const hoy = hoyDeCobro(ahora);
    const marca = await this.repo.organization(organizationId);
    if (!marca) throw notFound('Marca no encontrada');
    if (until !== null) {
      if (until < hoy) throw validation('La prórroga no puede terminar antes de hoy');
      if (until > masDias(hoy, DIAS_MAX_DE_PRORROGA)) throw validation(`La prórroga no puede pasar de ${DIAS_MAX_DE_PRORROGA} días`);
    }
    await this.repo.setHold(organizationId, until);
    await this.audit.record(systemContext(organizationId), {
      action: 'platform.collections.hold', resourceType: 'Organization', resourceId: organizationId, reason,
      beforeState: { holdUntil: marca.autoSuspendHoldUntil ? iso(marca.autoSuspendHoldUntil) : null },
      afterState: { holdUntil: until, byPlatformUserId: actor.userId },
    });
    return { holdUntil: until };
  }

  // ── Lo que pasa cuando cambia el hecho ─────────────────────────────────────

  /** La factura quedó pagada o anulada: sus avisos ya no hacen falta. */
  async alCerrarFactura(f: Factura, por: 'PAID' | 'VOIDED', ahora = new Date()): Promise<void> {
    await this.avisos.cerrarDeFactura(f.id, por, ahora);
  }

  /**
   * La marca se reanudó. Su aviso de «suspendido» se cierra, y si todavía debe
   * algo vencido se le da una prórroga de `DIAS_DE_PRORROGA` días (salvo que
   * ya tenga una más larga): sin ella, el cierre de mañana la volvería a
   * suspender. Devuelve la prórroga que quedó, si quedó alguna.
   */
  async alReanudar(organizationId: string, byUserId: string | null, ahora = new Date()): Promise<{ holdUntil: string | null }> {
    const hoy = hoyDeCobro(ahora);
    await this.avisos.cerrarDeMarca(organizationId, 'SERVICE_SUSPENDED', 'RESUMED', ahora);
    const marca = await this.repo.organization(organizationId);
    if (!marca) return { holdUntil: null };
    const vencidas = (await this.repo.invoices(organizationId)).filter((f) => saldo(f) > 0n && diasEntre(iso(f.dueDate), hoy) > 0);
    const actual = marca.autoSuspendHoldUntil && iso(marca.autoSuspendHoldUntil) >= hoy ? iso(marca.autoSuspendHoldUntil) : null;
    if (vencidas.length === 0) return { holdUntil: actual };
    const hasta = masDias(hoy, DIAS_DE_PRORROGA);
    if (actual && actual >= hasta) return { holdUntil: actual };
    await this.repo.setHold(organizationId, hasta);
    await this.audit.record(systemContext(organizationId), {
      action: 'platform.collections.hold', resourceType: 'Organization', resourceId: organizationId,
      reason: `Se reanudó el servicio con ${vencidas.length === 1 ? 'una factura vencida' : `${vencidas.length} facturas vencidas`}: ${DIAS_DE_PRORROGA} días de prórroga`,
      beforeState: { holdUntil: actual },
      afterState: { holdUntil: hasta, onResume: true, folios: vencidas.map((f) => f.folio).slice(0, 10), byPlatformUserId: byUserId },
    });
    return { holdUntil: hasta };
  }
}
