import { RETENTION_THRESHOLDS, conflict, contactStatus, notFound } from '@gymflow/core';
import { OUTBOUND_KINDS, type OutboundCounts, type OutboundKind, type OutboundMessage, type OutboundMessages, type OutboundSummary } from '@gymflow/core/contracts';
import type { RequestContext } from '../../platform/context.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { systemContext, type JobResult } from '../../platform/jobs/types.js';
import { moduleViewOf } from '../../platform/modules/module-state.js';
import { onlinePaymentsEnabled } from '../../platform/payments-mode.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { BranchRepository, OrganizationRepository } from '../organization/index.js';
import { FollowUpRepository } from '../follow-ups/index.js';
import { RetentionService } from '../retention/index.js';
import { LOTE, OutboundRepository, type AlcanceDeMensajes, type Nuevo, type OutboundRow } from './outbound.repository.js';
import { detalleDelMensaje, textoDelMensaje } from './plantillas.js';

/** Los estados de Retención a los que se les escribe (los mismos que se llaman). */
const SE_LES_ESCRIBE = new Set(['ONBOARDING_AT_RISK', 'SLIPPING', 'DORMANT']);
const MS_DIA = 86_400_000;
const fechaDe = (d: Date) => d.toISOString().slice(0, 10);

const enCero = (): OutboundCounts => ({ MEMBERSHIP_SUSPENDED: 0, PAYMENT_OVERDUE: 0, PAYMENT_DUE_SOON: 0, MEMBERSHIP_ENDING: 0, WE_MISS_YOU: 0, PRICE_CHANGE: 0 });
function contar(motivos: readonly OutboundKind[]): OutboundCounts {
  const c = enCero();
  for (const k of motivos) if ((OUTBOUND_KINDS as readonly string[]).includes(k)) c[k] += 1;
  return c;
}

/** Con qué se firma el saludo: el gimnasio y, si tiene varias sedes, la del socio. */
type Membrete = { gimnasio: string; sedes: ReadonlyMap<string, string>; variasSedes: boolean; enLinea: boolean };

/**
 * BANDEJA DE SALIDA (bloque 2.9): los mensajes que el gimnasio le debe a sus
 * socios. Aquí está la regla entera: qué hecho merece mensaje (`generar`, que
 * corre el job), qué se ve en la lista (`lista`, `resumen`) y qué pasa al
 * mandar o descartar uno (`marcar`). Nada sale solo: mandar es que una
 * persona abra WhatsApp con el texto ya escrito (D-34).
 */
export class OutboundService {
  private readonly audit = new AuditService();
  private readonly retention = new RetentionService();

  // ── Leer ─────────────────────────────────────────────────────────────────

  /**
   * `porMotivo` recorta CADA motivo (no la lista entera): así ningún grupo se
   * queda sin verse porque otro venga cargado. `kind` deja un solo motivo.
   */
  async lista(organizationId: string, alcance: AlcanceDeMensajes, opts: { porMotivo: number; kind?: OutboundKind | undefined }): Promise<OutboundMessages> {
    const calendario = new BusinessCalendar(organizationId);
    const repo = new OutboundRepository(organizationId);
    const [hoy, zona, membrete] = await Promise.all([calendario.today(null), calendario.timezoneFor(null), this.membrete(organizationId)]);
    const [pendientes, mandados] = await Promise.all([repo.pendientes(hoy, alcance), repo.mandadosHoy(hoy, zona, alcance)]);
    return {
      asOf: fechaDe(hoy),
      total: pendientes.length,
      counts: contar(pendientes.map((p) => p.kind)),
      pending: OUTBOUND_KINDS.filter((k) => !opts.kind || k === opts.kind)
        .flatMap((k) => pendientes.filter((p) => p.kind === k).slice(0, opts.porMotivo))
        .map((f) => this.json(f, membrete)),
      sentToday: mandados.map((f) => this.json(f, membrete)),
    };
  }

  /** Las cifras de la campana, con la misma cuenta que la lista. La puede llamar el Inicio (`GET /me/home`) cuando le dé renglón. */
  async resumen(organizationId: string, alcance: AlcanceDeMensajes): Promise<OutboundSummary> {
    const calendario = new BusinessCalendar(organizationId);
    const repo = new OutboundRepository(organizationId);
    const [hoy, zona] = await Promise.all([calendario.today(null), calendario.timezoneFor(null)]);
    const [motivos, mandados] = await Promise.all([repo.motivosPendientes(hoy, alcance), repo.cuantosMandadosHoy(hoy, zona, alcance)]);
    return { total: motivos.length, counts: contar(motivos), sentToday: mandados };
  }

  // ── Mandar o descartar ───────────────────────────────────────────────────

  /**
   * «Mandar por WhatsApp» o «No mandar». Mandar congela el texto (lo guardado
   * es lo que se mandó) y, si es un «te extrañamos», anota en el mismo paso el
   * contacto de Retención (15-08): el socio baja a «Ya contactados» sin un
   * segundo «Le llamé». Si el hecho ya no existe (pagó hace un momento), no
   * se manda: se dice y la lista se pone al día.
   */
  async marcar(ctx: RequestContext, input: {
    memberId: string; messageId: string; como: 'SENT' | 'DISMISSED';
    /** ¿Puede anotar seguimientos de Retención en la sede del socio? */
    puedeRetencion: boolean;
  }): Promise<OutboundMessage> {
    const organizationId = ctx.tenant.organizationId;
    const repo = new OutboundRepository(organizationId);
    const hoy = await new BusinessCalendar(organizationId).today(null);
    const fila = await repo.deSocio(input.messageId, input.memberId, hoy);
    if (!fila) throw notFound('Mensaje no encontrado');
    // Un «te extrañamos» revela quién está en riesgo: sin Retención, para esta persona no existe.
    if (fila.kind === 'WE_MISS_YOU' && !input.puedeRetencion) throw notFound('Mensaje no encontrado');
    if (fila.status !== 'PENDING') throw conflict(fila.status === 'SENT' ? 'Este mensaje ya se mandó.' : 'Este mensaje ya no está por mandar.');
    if (input.como === 'SENT' && !fila.vivo) {
      throw conflict(fila.phoneE164 ? 'Este mensaje ya no hace falta: lo que avisaba cambió. Actualiza la lista.' : 'Este socio ya no tiene celular registrado.');
    }
    const membrete = await this.membrete(organizationId);
    const texto = input.como === 'SENT' ? this.texto(fila, membrete) : null;
    const usuario = ctx.tenant.actorUserId!;

    await enUnaTransaccion(async () => {
      if (!(await repo.resolver(fila.id, input.como, usuario, texto))) throw conflict('Alguien más ya resolvió este mensaje.');
      if (input.como === 'SENT' && fila.kind === 'WE_MISS_YOU') {
        await new FollowUpRepository(organizationId).create({
          memberId: fila.memberId, branchId: fila.homeBranchId, channel: 'WHATSAPP', outcome: 'MESSAGE_SENT',
          note: 'Mensaje mandado desde Mensajes.', createdByUserId: usuario,
        });
      }
      // La bitácora al último: toma su candado por organización.
      await this.audit.record(ctx, {
        action: input.como === 'SENT' ? 'member.message.send' : 'member.message.dismiss',
        resourceType: 'Member', resourceId: fila.memberId, branchId: fila.homeBranchId,
        afterState: { messageId: fila.id, kind: fila.kind, channel: 'WHATSAPP_LINK' },
      });
    });
    const quedo = await repo.deSocio(fila.id, fila.memberId, hoy);
    return this.json(quedo ?? fila, membrete);
  }

  // ── El job ───────────────────────────────────────────────────────────────

  /**
   * Lo de hoy: cierra lo que ya no hace falta, arma los mensajes nuevos con
   * el día de operación de cada sede y deja uno por socio. Idempotente por
   * `dedupeKey`: correrlo dos veces no duplica nada.
   */
  async generar(organizationId: string): Promise<JobResult> {
    const result: JobResult = { job: 'outbound.generate', processed: 0, skipped: 0, batches: 1, truncated: false, errors: [] };
    const repo = new OutboundRepository(organizationId);
    const dias = await new BusinessCalendar(organizationId).dias();
    const paso = async (nombre: string, fn: () => Promise<number>) => {
      try { result.processed += await fn(); } catch (error) { result.errors.push({ entityId: nombre, error: error instanceof Error ? error.message : String(error) }); }
    };

    await paso('caducar', () => repo.caducar(dias.gimnasio));
    for (const { day, sedes } of dias.grupos) {
      await paso('dinero', async () => {
        const [porVencer, vencidos, suspendidas, porTerminar] = await Promise.all([
          repo.porVencer(day, sedes), repo.vencidos(day, sedes), repo.suspendidas(sedes), repo.porTerminar(day, sedes),
        ]);
        if ([porVencer, vencidos, suspendidas, porTerminar].some((f) => f.length >= LOTE)) result.truncated = true;
        const nuevos: Nuevo[] = [
          ...porVencer.map((c): Nuevo => ({ kind: 'PAYMENT_DUE_SOON', memberId: c.memberId, branchId: c.homeBranchId, chargeId: c.id, dedupeKey: `PAYMENT_DUE_SOON:${c.id}` })),
          ...vencidos.map((c): Nuevo => ({ kind: 'PAYMENT_OVERDUE', memberId: c.memberId, branchId: c.homeBranchId, chargeId: c.id, dedupeKey: `PAYMENT_OVERDUE:${c.id}` })),
          ...suspendidas.map((m): Nuevo => ({ kind: 'MEMBERSHIP_SUSPENDED', memberId: m.memberId, branchId: m.homeBranchId, membershipId: m.id, dedupeKey: `MEMBERSHIP_SUSPENDED:${m.id}` })),
          // Con el fin del periodo en la clave: el del mes siguiente es otro mensaje. La que se
          // renueva sola es un pago por venir; la que no, un plan que termina.
          ...porTerminar.map((m): Nuevo => (m.autoRenew
            ? { kind: 'PAYMENT_DUE_SOON', memberId: m.memberId, branchId: m.homeBranchId, membershipId: m.id, dedupeKey: `PAYMENT_DUE_SOON:M:${m.id}:${fechaDe(m.periodEnd)}` }
            : { kind: 'MEMBERSHIP_ENDING', memberId: m.memberId, branchId: m.homeBranchId, membershipId: m.id, dedupeKey: `MEMBERSHIP_ENDING:${m.id}:${fechaDe(m.periodEnd)}` })),
        ];
        return repo.crear(nuevos);
      });
    }
    await paso('te-extrañamos', () => this.generarTeExtranamos(organizationId, repo));
    // Los avisos de cambio de precio que el momento del cambio no alcanzó a armar (D-19).
    await paso('cambio-de-precio', async () => {
      const r = await this.avisarCambiosDePrecio(organizationId);
      if (r.truncated) result.truncated = true;
      return r.created;
    });
    await paso('uno-por-socio', async () => { await repo.reemplazar(); return 0; });
    return result;
  }

  /**
   * «Te extrañamos»: la lista de Retención (misma regla, mismo orden), uno por
   * episodio y mes, solo donde el módulo Retención está encendido y solo a
   * quien nadie ha contactado en el plazo en que Retención lo da por contactado.
   */
  private async generarTeExtranamos(organizationId: string, repo: OutboundRepository): Promise<number> {
    const modulos = await moduleViewOf(organizationId);
    if (!modulos.org.has('retention')) return 0;
    const r = await this.retention.report(systemContext(organizationId), { branchId: null });
    const candidatos = r.outreach.filter((m) => m.phoneE164 && SE_LES_ESCRIBE.has(m.verdict.state) && modulos.at(m.homeBranchId).has('retention'));
    if (candidatos.length === 0) return 0;
    const ids = candidatos.map((m) => m.memberId);
    const ahora = new Date();
    const [contactos, recientes] = await Promise.all([
      new FollowUpRepository(organizationId).latest('member', ids),
      repo.conMensajeReciente(ids, new Date(ahora.getTime() - RETENTION_THRESHOLDS.contactValidDays * MS_DIA)),
    ]);
    const mes = r.asOf.slice(0, 7);
    const nuevos = candidatos
      .filter((m) => !recientes.has(m.memberId))
      .filter((m) => {
        const ultimo = contactos.get(m.memberId)?.last;
        return contactStatus(ultimo ? { createdAt: ultimo.createdAt, nextStepOn: ultimo.nextStepOn ? fechaDe(ultimo.nextStepOn) : null } : null, r.asOf, ahora) === 'POR_LLAMAR';
      })
      .map((m): Nuevo => ({
        kind: 'WE_MISS_YOU', memberId: m.memberId, branchId: m.homeBranchId, engagementState: m.verdict.state,
        dedupeKey: `WE_MISS_YOU:${m.memberId}:${m.verdict.state}:${mes}`,
      }));
    return repo.crear(nuevos);
  }

  /**
   * EL AVISO DE UN CAMBIO DE PRECIO (D-19, bloque 3.6): un mensaje por
   * membresía tocada, para que recepción le avise al socio antes de su
   * siguiente pago. Se llama en cuanto el cambio queda confirmado (gancho de
   * `catalog`) y otra vez en el job diario, por si aquel falló. Idempotente
   * por `dedupeKey`. Nada sale solo: quedan en «Mensajes» (D-34).
   */
  async avisarCambiosDePrecio(organizationId: string): Promise<{ created: number; truncated: boolean }> {
    const repo = new OutboundRepository(organizationId);
    let created = 0;
    // Un aumento puede tocar a miles: por lotes, hasta 20 por llamada (el job sigue con el resto).
    for (let vuelta = 0; vuelta < 20; vuelta++) {
      const filas = await repo.cambiosDePrecio();
      if (filas.length === 0) return { created, truncated: false };
      created += await repo.crear(filas.map((f): Nuevo => ({
        kind: 'PRICE_CHANGE', memberId: f.memberId, branchId: f.homeBranchId, membershipId: f.membershipId, priceChangeId: f.id,
        dedupeKey: `PRICE_CHANGE:${f.id}`,
      })));
      if (filas.length < LOTE) { await repo.reemplazar(); return { created, truncated: false }; }
    }
    await repo.reemplazar();
    return { created, truncated: true };
  }

  // ── Armar ────────────────────────────────────────────────────────────────

  private async membrete(organizationId: string): Promise<Membrete> {
    const [org, sedes] = await Promise.all([new OrganizationRepository(organizationId).current(), new BranchRepository(organizationId).list()]);
    const activas = sedes.filter((s) => s.isActive);
    return {
      gimnasio: org?.tradeName ?? 'tu gimnasio', sedes: new Map(sedes.map((s) => [s.id, s.name])),
      variasSedes: activas.length > 1, enLinea: onlinePaymentsEnabled(),
    };
  }

  private texto(f: OutboundRow, m: Membrete): string {
    return textoDelMensaje({
      kind: f.kind, firstName: f.firstName, gimnasio: m.gimnasio,
      sede: m.variasSedes && f.homeBranchId ? m.sedes.get(f.homeBranchId) ?? null : null,
      concept: f.concept, dueCents: f.dueCents, dueDate: f.dueDate, planName: f.planName, periodEnd: f.periodEnd,
      priceFromCents: f.priceFromCents, priceToCents: f.priceToCents,
      engagementState: f.engagementState, enLinea: m.enLinea,
    });
  }

  private json(f: OutboundRow, m: Membrete): OutboundMessage {
    return {
      id: f.id, kind: f.kind, status: f.status as OutboundMessage['status'],
      memberId: f.memberId, memberCode: f.memberCode, memberName: `${f.firstName} ${f.lastName}`.trim(),
      branchId: f.homeBranchId, phoneE164: f.phoneE164,
      detail: detalleDelMensaje(f),
      // Lo mandado dice lo que se mandó; lo pendiente, lo que se mandaría hoy.
      text: f.body ?? this.texto(f, m),
      createdAt: f.createdAt.toISOString(),
      resolvedAt: f.resolvedAt ? f.resolvedAt.toISOString() : null,
      resolvedByName: f.resolvedByName,
    };
  }
}
