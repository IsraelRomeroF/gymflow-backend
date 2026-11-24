import {
  AUTO_MERGE_THRESHOLD, PROSPECT_AUTO_CLOSE_CODE, PROSPECT_OPEN_STAGES, businessDateIn, closesProspect, conflict, deriveStage, dueOn, normalizedNameKey,
  prospectAutoCloseOn, prospectClosesSoon, prospectQueue, rankMatches, revisarMotivo, validation,
  type FollowUpChannel, type FollowUpOutcome, type ProspectActivity, type ProspectOpenStage,
} from '@gymflow/core';
import type { Prospect, ProspectContactResult } from '@gymflow/core/contracts';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import type { RequestContext } from '../../platform/context.js';
import { MemberRepository } from '../members/index.js';
import { FollowUpRepository, contactoJson, type FollowUpRecord } from '../follow-ups/index.js';
import { ProspectRepository, type ProspectRecord } from './prospect.repository.js';

const dia = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const aFecha = (d: string): Date => new Date(`${d}T00:00:00.000Z`);
const CERRADO = (status: string) => status === 'CONVERTED' || status === 'LOST';

/**
 * Lo que cuenta para el cierre solo (D-31), en días de SU sede: un contacto a
 * las 23:30 de Tijuana es de ese día allá, aunque en UTC ya sea mañana.
 */
export function actividadDe(
  p: Pick<ProspectRecord, 'createdAt' | 'lastContactAt' | 'nextStepOn' | 'reopenedAt'>, zona: string,
): ProspectActivity {
  const enSede = (d: Date | null) => (d ? dia(businessDateIn(zona, d)) : null);
  return { createdOn: enSede(p.createdAt)!, lastContactOn: enSede(p.lastContactAt), nextStepOn: dia(p.nextStepOn), reopenedOn: enSede(p.reopenedAt) };
}

/** Lo que la fila necesita además del interesado: la zona de su sede y el nombre del plan que preguntó. */
export type ContextoDeFila = { zona: string; planes: ReadonlyMap<string, { name: string }> };

/** Quién ya existe con ese contacto y ese nombre, para no registrar dos veces a la misma persona (10-07). */
export type YaExiste =
  | { kind: 'PROSPECT'; id: string; fullName: string; branchId: string }
  | { kind: 'MEMBER' | 'FORMER_MEMBER'; id: string; fullName: string; branchId: string | null };

/**
 * INTERESADOS (auditoría 8, bloque 2.4): la etapa se deriva de los contactos,
 * cerrar pide motivo, reabrir conserva la etapa y la conversión ocurre en la
 * misma operación que el alta del socio, venga por la puerta que venga.
 */
export class ProspectService {
  private readonly audit = new AuditService();

  /** Hoy en el gimnasio (los interesados cruzan sedes: se usa la zona del gimnasio). */
  async hoy(orgId: string, branchId?: string | null, at?: Date): Promise<Date> {
    return new BusinessCalendar(orgId).today(branchId ?? null, at);
  }

  /** Contrato `Prospect` (`@gymflow/core/contracts`): la fila con su último contacto y su grupo de la bandeja. */
  serialize(p: ProspectRecord, ultimo: { last: FollowUpRecord; count: number } | undefined, hoy: Date, fila: ContextoDeFila): Prospect {
    // Cuándo se cierra solo, con el día de SU sede (D-31). Cerrado, ya no aplica.
    const cierraSolo = CERRADO(p.status) ? null : prospectAutoCloseOn(actividadDe(p, fila.zona));
    return {
      id: p.id, firstName: p.firstName, lastName: p.lastName, phoneE164: p.phoneE164, email: p.email, source: p.source,
      status: p.status, branchId: p.branchId, assignedToUserId: p.assignedToUserId, convertedMemberId: p.convertedMemberId, notes: p.notes,
      createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
      lastFollowUp: ultimo ? contactoJson(ultimo.last) : null, followUps: ultimo?.count ?? 0,
      // Cerrado, no «toca» nunca (la migración pudo dejarle la fecha de su último contacto).
      nextStepOn: CERRADO(p.status) ? null : dia(p.nextStepOn), dueOn: CERRADO(p.status) ? null : dia(p.dueOn),
      queue: CERRADO(p.status) ? null : prospectQueue(dia(p.dueOn), dia(hoy)!),
      referredByMemberId: p.referredByMemberId, referredByName: p.referredByName,
      lostReasonCode: p.lostReasonCode, lostReason: p.lostReason, closedAt: p.closedAt ? p.closedAt.toISOString() : null,
      interestPlanId: p.interestPlanId, interestPlanName: p.interestPlanId ? fila.planes.get(p.interestPlanId)?.name ?? null : null,
      autoCloseOn: cierraSolo, autoCloseSoon: cierraSolo !== null && prospectClosesSoon(cierraSolo, dia(businessDateIn(fila.zona))!),
      autoClosed: p.status === 'LOST' && p.lostReasonCode === PROSPECT_AUTO_CLOSE_CODE,
    };
  }

  /**
   * ¿Ya existe esa persona? Mismo celular o correo Y mismo nombre: un
   * interesado abierto en cualquier sede, o un socio (activo o dado de baja).
   * El celular solo nunca une: mamá e hija lo comparten.
   */
  async yaExiste(orgId: string, d: { firstName: string; lastName: string; phoneE164?: string | null | undefined; email?: string | null | undefined }): Promise<YaExiste | null> {
    const nombre = normalizedNameKey(`${d.firstName} ${d.lastName}`);
    const abierto = (await new ProspectRepository(orgId).findOpenByContact(d.phoneE164, d.email)).find((p) => p.nameKey === nombre);
    if (abierto) return { kind: 'PROSPECT', id: abierto.id, fullName: `${abierto.firstName} ${abierto.lastName}`, branchId: abierto.branchId };
    if (!d.phoneE164 && !d.email) return null;
    const socios = new MemberRepository(orgId);
    const candidatos = await socios.findDuplicateCandidates({ firstName: d.firstName, lastName: d.lastName, phoneE164: d.phoneE164, email: d.email });
    const mejor = rankMatches({ id: 'interesado', firstName: d.firstName, lastName: d.lastName, phoneE164: d.phoneE164 ?? null, email: d.email ?? null, curp: null }, candidatos)
      .find((m) => m.score >= AUTO_MERGE_THRESHOLD && (m.method === 'PHONE' || m.method === 'EMAIL'));
    if (!mejor) return null;
    const socio = await socios.findByIdIncludingArchived(mejor.candidateId);
    if (!socio) return null;
    return { kind: socio.status === 'ARCHIVED' ? 'FORMER_MEMBER' : 'MEMBER', id: socio.id, fullName: `${socio.firstName} ${socio.lastName}`, branchId: socio.homeBranchId ?? null };
  }

  /**
   * «Contacto con {nombre}»: el contacto, la etapa que resulta y desde cuándo
   * vuelve a tocar, en UNA operación. «No le interesa» lo cierra ahí mismo
   * con su motivo (10-05): antes quedaba «Contactado» y en seguimiento.
   */
  async registrarContacto(ctx: RequestContext, p: ProspectRecord, body: {
    channel: FollowUpChannel; outcome: FollowUpOutcome; note?: string | undefined; nextStepOn?: string | undefined; lostReasonCode?: string | undefined;
  }): Promise<ProspectContactResult> {
    const orgId = ctx.tenant.organizationId;
    if (p.status === 'CONVERTED' || p.convertedMemberId) throw conflict('Ese prospecto ya es socio', 'PROSPECT_CLOSED');
    if (p.status === 'LOST') throw conflict('Ese interesado está cerrado. Reábrelo para seguir anotando contactos', 'PROSPECT_CLOSED');

    const cierra = closesProspect(body.outcome);
    const motivo = cierra ? revisarMotivo('interesadoPerdido', { codigo: body.lostReasonCode ?? '', nota: body.note ?? null }) : null;
    if (motivo && !motivo.ok) throw validation(body.lostReasonCode ? motivo.error : 'Elige por qué ya no se va a inscribir');

    return enUnaTransaccion(async () => {
      const repo = new ProspectRepository(orgId);
      const contactos = new FollowUpRepository(orgId);
      const f = await contactos.create({
        prospectId: p.id, branchId: p.branchId, channel: body.channel, outcome: body.outcome, note: body.note ?? null,
        // Lo que cierra no deja próximo paso.
        nextStepOn: !cierra && body.nextStepOn ? aFecha(body.nextStepOn) : null,
        createdByUserId: ctx.tenant.actorUserId!,
      });
      let status: ProspectContactResult['status'];
      if (motivo?.ok) {
        if (!await repo.close(p.id, { reasonCode: motivo.codigo, reason: motivo.texto, userId: ctx.tenant.actorUserId ?? null, lastContactAt: f.createdAt })) {
          throw conflict('Ese interesado ya estaba cerrado', 'PROSPECT_CLOSED');
        }
        status = 'LOST';
      } else {
        // La más avanzada entre la que dan sus contactos y la que ya tenía: las etapas elegidas a mano
        // antes de este bloque (un «Visitó» sin contacto que lo respalde) no retroceden con un «No contestó».
        const derivada = deriveStage(await contactos.stagesOf(p.id));
        const etapa = PROSPECT_OPEN_STAGES[Math.max(PROSPECT_OPEN_STAGES.indexOf(derivada), PROSPECT_OPEN_STAGES.indexOf(p.status as ProspectOpenStage))] ?? derivada;
        const proximo = body.nextStepOn ?? null;
        // Sin próximo paso, toca desde hoy: nadie contactado se queda sin que alguien lo vuelva a ver.
        const toca = dueOn({ nextStepOn: proximo, lastContactOn: dia(await this.hoy(orgId, p.branchId, f.createdAt)) });
        if (!await repo.afterContact(p.id, { status: etapa, lastContactAt: f.createdAt, nextStepOn: proximo ? aFecha(proximo) : null, dueOn: toca ? aFecha(toca) : null })) {
          throw conflict('Ese interesado ya estaba cerrado', 'PROSPECT_CLOSED');
        }
        status = etapa;
      }
      await this.audit.record(ctx, {
        action: 'prospect.follow_up', resourceType: 'Prospect', resourceId: p.id, branchId: p.branchId,
        afterState: { channel: body.channel, outcome: body.outcome, nextStepOn: cierra ? null : body.nextStepOn ?? null, status },
      });
      if (motivo?.ok) {
        await this.audit.record(ctx, {
          action: 'prospect.close', resourceType: 'Prospect', resourceId: p.id, branchId: p.branchId,
          beforeState: { status: p.status }, afterState: { status: 'LOST', reasonCode: motivo.codigo }, reason: motivo.texto,
        });
      }
      return { ...contactoJson(f), status };
    });
  }

  /** «Ya no se va a inscribir», con su motivo de la lista corta (10-09). */
  async cerrar(ctx: RequestContext, p: ProspectRecord, elegido: { reasonCode: string; note?: string | undefined }): Promise<{ reason: string }> {
    if (p.status === 'CONVERTED' || p.convertedMemberId) throw conflict('Ese prospecto ya es socio', 'PROSPECT_CLOSED');
    if (p.status === 'LOST') throw conflict('Ese interesado ya estaba cerrado', 'PROSPECT_CLOSED');
    const motivo = revisarMotivo('interesadoPerdido', { codigo: elegido.reasonCode, nota: elegido.note ?? null });
    if (!motivo.ok) throw validation(motivo.error);
    return enUnaTransaccion(async () => {
      if (!await new ProspectRepository(ctx.tenant.organizationId).close(p.id, { reasonCode: motivo.codigo, reason: motivo.texto, userId: ctx.tenant.actorUserId ?? null })) {
        throw conflict('Ese interesado ya estaba cerrado', 'PROSPECT_CLOSED');
      }
      await this.audit.record(ctx, {
        action: 'prospect.close', resourceType: 'Prospect', resourceId: p.id, branchId: p.branchId,
        beforeState: { status: p.status }, afterState: { status: 'LOST', reasonCode: motivo.codigo }, reason: motivo.texto,
      });
      return { reason: motivo.texto };
    });
  }

  /**
   * «Reabrir»: vuelve a seguimiento con la etapa que le dan sus contactos
   * (10-09; antes regresaba a «Nuevo» aunque ya hubiera visitado). Si alguna
   * vez fue contactado, toca hoy; si no, queda «Sin contactar».
   */
  async reabrir(ctx: RequestContext, p: ProspectRecord): Promise<{ status: 'NEW' | 'CONTACTED' | 'VISITED' | 'TRIAL' }> {
    if (p.status !== 'LOST') throw conflict(p.status === 'CONVERTED' ? 'Ese prospecto ya es socio' : 'Ese interesado no está cerrado');
    const orgId = ctx.tenant.organizationId;
    return enUnaTransaccion(async () => {
      // La etapa más avanzada que alcanzó antes de cerrarse; el «No le interesa» que lo cerró cuenta como contacto.
      const status = deriveStage(await new FollowUpRepository(orgId).stagesOf(p.id));
      const toca = p.lastContactAt ? await this.hoy(orgId, p.branchId) : null;
      if (!await new ProspectRepository(orgId).reopen(p.id, { status, dueOn: toca })) throw conflict('Ese interesado no está cerrado');
      await this.audit.record(ctx, {
        action: 'prospect.reopen', resourceType: 'Prospect', resourceId: p.id, branchId: p.branchId,
        beforeState: { status: 'LOST', reasonCode: p.lostReasonCode }, afterState: { status },
      });
      return { status };
    });
  }

  /**
   * El socio que acaba de nacer (o de vincularse) era un interesado: mismo
   * celular o correo y mismo nombre. Se convierte en la MISMA operación que
   * el alta (10-07, 10-10): antes dependía de una segunda llamada del panel
   * que fallaba en silencio, y el interesado que llenaba el QR seguía «en
   * seguimiento» para siempre. Llamar dentro de la unidad de trabajo del alta.
   */
  async convertirPorIdentidad(ctx: RequestContext, socio: {
    memberId: string; firstName: string; lastName: string; phoneE164: string | null; email: string | null;
  }): Promise<string | null> {
    const repo = new ProspectRepository(ctx.tenant.organizationId);
    const nombre = normalizedNameKey(`${socio.firstName} ${socio.lastName}`);
    const p = (await repo.findOpenByContact(socio.phoneE164, socio.email)).find((x) => x.nameKey === nombre);
    if (!p) return null;
    return (await this.convertir(ctx, p, socio.memberId, 'identidad')) ? p.id : null;
  }

  /** Liga al interesado con su ficha y lo asienta. `via`: `inscribir` (desde su fila), `identidad` (otra puerta) o `manual`. */
  async convertir(ctx: RequestContext, p: Pick<ProspectRecord, 'id' | 'branchId'>, memberId: string, via: 'inscribir' | 'identidad' | 'manual'): Promise<boolean> {
    if (!await new ProspectRepository(ctx.tenant.organizationId).markConverted(p.id, memberId)) return false;
    await this.audit.record(ctx, { action: 'prospect.convert', resourceType: 'Prospect', resourceId: p.id, branchId: p.branchId, afterState: { memberId, via } });
    return true;
  }
}
