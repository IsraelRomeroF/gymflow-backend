import {
  APPROVAL_PROXY_MAX_DAYS, DomainError, ROLE_BY_KEY, approvalProxyActive, approvalProxyLastDay, conflict, forbidden, isoDate, resolveWallTime, validation,
  type ApprovalProxyEndReason,
} from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { systemContext } from '../../platform/jobs/types.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import type { RequestContext } from '../../platform/context.js';
import { AuthUserRepository, GrantRepository, PushService, UserRepository } from '../identity/index.js';
import { ApprovalProxyRepository, type Nombramiento } from './approval-proxy.repository.js';
import { ApprovalService } from './approval.service.js';

/** Un nombramiento como lo ve el panel: con nombres y con lo que se firmó con él. */
export type NombramientoALaVista = Nombramiento & {
  proxyName: string | null; grantedByName: string | null; active: boolean; signedCount: number; rejectedCount: number;
};

export type Candidato = { userId: string; fullName: string; roleLabel: string | null; cannotSignYet: boolean };

export type EstadoDelApoderado = {
  canManage: boolean; mine: boolean; current: NombramientoALaVista | null; candidates: Candidato[]; history: NombramientoALaVista[];
  today: string; lastDay: string; maxDays: number;
};

/** El orden en que se lee el puesto de alguien con más de uno. */
const PUESTOS = ['MANAGER', 'RECEPTION', 'COACH'] as const;

/**
 * APODERADO TEMPORAL (D-02, opción b; fase 3, bloque 3.1).
 *
 * Solo el dueño daba la segunda firma: sin señal o enfermo, no había
 * reembolsos, retiros, anulaciones ni cierre de mes. Ahora nombra desde su
 * teléfono, con su contraseña, a UNA persona con fecha de fin. Mientras el
 * nombramiento vale, esa persona firma lo que piden los demás con la
 * autoridad del dueño (quién firma qué lo decide `ApprovalService`), y cada
 * firma queda en la bitácora como «firmó como apoderado de …».
 *
 * El nombramiento se apaga solo al terminar su último día (en la zona del
 * gimnasio), el dueño lo revoca cuando quiera sin contraseña, y nombrar a
 * otra persona termina el anterior. Nombrar, revocar, reemplazar y vencer
 * quedan en la bitácora, en «Para revisar».
 */
export class ApprovalProxyService {
  private readonly audit = new AuditService();
  private readonly users = new AuthUserRepository();
  private readonly grants = new GrantRepository();
  private readonly firmas = new ApprovalService();

  /** Nombra y revoca quien da la segunda firma de TODO el gimnasio por su puesto: el dueño. Nunca un apoderado. */
  private administra(ctx: RequestContext): boolean {
    return ctx.tenant.grants.some((g) => g.permission === 'approvals:grant' && g.branchId === null);
  }

  async estado(ctx: RequestContext): Promise<EstadoDelApoderado> {
    const orgId = ctx.tenant.organizationId;
    const yo = ctx.tenant.actorUserId!;
    await this.cerrarVencidos(orgId);
    const repo = new ApprovalProxyRepository(orgId);
    const canManage = this.administra(ctx);
    const vigente = await repo.vigente();
    const mine = vigente?.proxyUserId === yo;
    // El nombramiento lo ven quien lo dio (o puede darlo) y quien lo tiene; a los demás no les toca.
    const [current] = vigente && (canManage || mine) ? await this.aLaVista(orgId, [vigente]) : [];
    const hoy = isoDate(await new BusinessCalendar(orgId).today(null));
    return {
      canManage, mine, current: current ?? null,
      candidates: canManage ? await this.candidatos(orgId, yo) : [],
      history: canManage ? await this.aLaVista(orgId, (await repo.historia()).filter((n) => n.id !== vigente?.id)) : [],
      today: hoy, lastDay: approvalProxyLastDay(hoy), maxDays: APPROVAL_PROXY_MAX_DAYS,
    };
  }

  /**
   * Nombrar. Pide la contraseña del dueño (con la misma escalera de fallos de
   * sus firmas): dar a otra persona el poder de firmar es, como mínimo, una
   * firma. Si ya había un apoderado, su nombramiento termina aquí.
   */
  async nombrar(ctx: RequestContext, input: { proxyUserId: string; endsOn: string; note?: string | undefined; password: string }): Promise<NombramientoALaVista> {
    const orgId = ctx.tenant.organizationId;
    const yo = ctx.tenant.actorUserId;
    if (!yo || !this.administra(ctx)) throw forbidden('Al apoderado lo nombra el dueño del gimnasio');
    const perfil = await this.users.findById(yo);
    if (!perfil || !perfil.isActive) throw new DomainError('UNAUTHENTICATED', 'Sesión requerida');

    await this.firmas.comprobarContrasena(ctx, perfil, input.password, { branchId: null }, {
      canal: 'telefono',
      asentarFallo: async (f) => {
        if (f.causa !== 'CONTRASENA') return;
        await this.audit.record(ctx, {
          action: 'approval.remote.fail', resourceType: 'User', resourceId: input.proxyUserId,
          afterState: { context: 'proxy.grant', failedCount: f.failedCount ?? null, ...(f.step && f.step !== 'none' ? { step: f.step } : {}), ...(f.pausedUntil ? { pausedUntil: f.pausedUntil.toISOString() } : {}) },
        });
      },
    });
    this.firmas.requireFirmaVigente(perfil);

    const persona = await this.personaNombrable(orgId, yo, input.proxyUserId);
    const calendario = new BusinessCalendar(orgId);
    const zona = await calendario.timezoneFor(null);
    const hoy = isoDate(await calendario.today(null));
    if (input.endsOn < hoy || input.endsOn > approvalProxyLastDay(hoy)) {
      throw validation(
        `La fecha de fin va de hoy a ${APPROVAL_PROXY_MAX_DAYS} días: del ${hoy} al ${approvalProxyLastDay(hoy)}`,
        'Si hace falta más tiempo, se vuelve a nombrar al terminar.', 'APPROVAL_PROXY_INVALID_END',
      );
    }
    const endsAt = finDelDia(zona, input.endsOn);
    const note = input.note?.trim() || null;

    const repo = new ApprovalProxyRepository(orgId);
    const ahora = new Date();
    // Terminar el anterior y abrir el nuevo, juntos: la base no admite dos abiertos.
    const { nuevo, anterior } = await enUnaTransaccion(async () => {
      const abierto = await repo.abierto();
      let previo: { n: Nombramiento; reason: ApprovalProxyEndReason } | null = null;
      if (abierto) {
        const reason: ApprovalProxyEndReason = approvalProxyActive(abierto, ahora) ? 'REPLACED' : 'EXPIRED';
        const at = reason === 'EXPIRED' ? abierto.endsAt : ahora;
        if (await repo.terminar(abierto.id, { reason, at, byUserId: reason === 'REPLACED' ? yo : null })) previo = { n: abierto, reason };
      }
      return { nuevo: await repo.create({ grantedByUserId: yo, proxyUserId: persona.id, note, endsAt }), anterior: previo };
    });

    if (anterior) await this.asentarFin(ctx, anterior.n, anterior.reason);
    await this.audit.record(ctx, {
      action: 'approval.proxy.grant', resourceType: 'User', resourceId: persona.id, ...(note ? { reason: note } : {}),
      afterState: { proxyId: nuevo.id, proxyName: persona.fullName, endsOn: input.endsOn, endsAt: endsAt.toISOString(), note },
    });
    void new PushService().sendToUsers(orgId, [persona.id], {
      title: 'Te nombraron apoderado',
      body: `${perfil.fullName} te nombró para autorizar lo que pida el personal hasta el ${diaEnPalabras(input.endsOn)}. Lo tuyo lo sigue autorizando ${perfil.fullName}.`,
      url: '/autorizaciones', tag: `approval-proxy-${nuevo.id}`,
    }).catch(() => undefined);
    if (anterior?.reason === 'REPLACED' && anterior.n.proxyUserId !== persona.id) this.avisarFin(orgId, anterior.n, perfil.fullName);
    const [vista] = await this.aLaVista(orgId, [nuevo]);
    return vista!;
  }

  /** Revocar: desde ese instante el apoderado no firma, ni vale una firma suya que todavía no se haya usado. Sin contraseña: quitar poder no la pide. */
  async revocar(ctx: RequestContext, reason?: string | undefined): Promise<void> {
    const orgId = ctx.tenant.organizationId;
    const yo = ctx.tenant.actorUserId;
    if (!yo || !this.administra(ctx)) throw forbidden('El nombramiento lo revoca el dueño del gimnasio');
    await this.cerrarVencidos(orgId);
    const repo = new ApprovalProxyRepository(orgId);
    const vigente = await repo.vigente();
    if (!vigente || !(await repo.terminar(vigente.id, { reason: 'REVOKED', at: new Date(), byUserId: yo }))) {
      throw conflict('No hay ningún apoderado vigente', 'APPROVAL_PROXY_NONE');
    }
    await this.asentarFin(ctx, vigente, 'REVOKED', reason?.trim() || undefined);
    const quien = (await this.users.findById(yo))?.fullName ?? 'El dueño';
    this.avisarFin(orgId, vigente, quien);
  }

  /**
   * Cierra los nombramientos cuya fecha ya pasó y lo asienta como acto del
   * sistema. No hace falta para que dejen de valer (la fecha manda): es para
   * que la bitácora diga cuándo se apagó. Lo llaman la pantalla y el job.
   */
  async cerrarVencidos(orgId: string): Promise<number> {
    const repo = new ApprovalProxyRepository(orgId);
    const abierto = await repo.abierto();
    if (!abierto || approvalProxyActive(abierto)) return 0;
    if (!(await repo.terminar(abierto.id, { reason: 'EXPIRED', at: abierto.endsAt, byUserId: null }))) return 0;
    await this.asentarFin(systemContext(orgId), abierto, 'EXPIRED');
    return 1;
  }

  private async asentarFin(ctx: RequestContext, n: Nombramiento, reason: ApprovalProxyEndReason, motivo?: string): Promise<void> {
    const accion = reason === 'REVOKED' ? 'approval.proxy.revoke' : reason === 'REPLACED' ? 'approval.proxy.replace' : 'approval.proxy.expire';
    const uso = (await new ApprovalProxyRepository(ctx.tenant.organizationId).uso([n.id])).get(n.id);
    // Vencer lo asienta el sistema; revocar y reemplazar, quien lo hizo.
    await this.audit.record(reason === 'EXPIRED' ? systemContext(ctx.tenant.organizationId) : ctx, {
      action: accion, resourceType: 'User', resourceId: n.proxyUserId, ...(motivo ? { reason: motivo } : {}),
      afterState: {
        proxyId: n.id, grantedByUserId: n.grantedByUserId, grantedAt: n.createdAt.toISOString(), endsAt: n.endsAt.toISOString(),
        signedCount: uso?.firmadas ?? 0, rejectedCount: uso?.rechazadas ?? 0,
      },
    });
  }

  private avisarFin(orgId: string, n: Nombramiento, quien: string): void {
    void new PushService().sendToUsers(orgId, [n.proxyUserId], {
      title: 'Tu nombramiento de apoderado terminó',
      body: `${quien} lo dio por terminado. Ya no autorizas lo que pide el personal.`,
      url: '/panel', tag: `approval-proxy-${n.id}`,
    }).catch(() => undefined);
  }

  /** Activa, de este gimnasio, otra persona, y que no dé ya la segunda firma por su puesto. */
  private async personaNombrable(orgId: string, yo: string, proxyUserId: string): Promise<{ id: string; fullName: string }> {
    const invalida = (mensaje: string) => validation(mensaje, undefined, 'APPROVAL_PROXY_INVALID_PERSON');
    if (proxyUserId === yo) throw invalida('No puedes nombrarte a ti: el apoderado es otra persona');
    const persona = await this.users.findById(proxyUserId);
    if (!persona || persona.organizationId !== orgId || !persona.isActive) throw invalida('Esa persona no está activa en el personal de este gimnasio');
    if ((await this.grants.grantsForUser(persona.id)).some((g) => g.permission === 'approvals:grant')) {
      throw invalida(`${persona.fullName} ya da la segunda firma por su puesto: no necesita nombramiento`);
    }
    return { id: persona.id, fullName: persona.fullName };
  }

  private async candidatos(orgId: string, yo: string): Promise<Candidato[]> {
    const out: Candidato[] = [];
    for (const u of await new UserRepository(orgId).activeExcept(yo)) {
      const [grants, roles, perfil] = await Promise.all([this.grants.grantsForUser(u.id), this.grants.roleKeysForUser(u.id), this.users.findById(u.id)]);
      if (!perfil || grants.some((g) => g.permission === 'approvals:grant')) continue;
      const puesto = PUESTOS.find((p) => roles.includes(p)) ?? roles[0];
      let cannotSignYet = false;
      try { this.firmas.requireFirmaVigente(perfil); } catch { cannotSignYet = true; }
      out.push({ userId: u.id, fullName: u.fullName, roleLabel: puesto ? ROLE_BY_KEY.get(puesto)?.name ?? null : null, cannotSignYet });
    }
    return out.sort((a, b) => a.fullName.localeCompare(b.fullName, 'es'));
  }

  private async aLaVista(orgId: string, lista: readonly Nombramiento[]): Promise<NombramientoALaVista[]> {
    if (lista.length === 0) return [];
    const [nombres, uso] = await Promise.all([
      new UserRepository(orgId).namesById(lista.flatMap((n) => [n.proxyUserId, n.grantedByUserId])),
      new ApprovalProxyRepository(orgId).uso(lista.map((n) => n.id)),
    ]);
    const ahora = new Date();
    return lista.map((n) => ({
      ...n, proxyName: nombres.get(n.proxyUserId) ?? null, grantedByName: nombres.get(n.grantedByUserId) ?? null,
      active: approvalProxyActive(n, ahora), signedCount: uso.get(n.id)?.firmadas ?? 0, rejectedCount: uso.get(n.id)?.rechazadas ?? 0,
    }));
  }
}

/** El instante en que termina ese día en la zona del gimnasio: la medianoche del día siguiente. */
export function finDelDia(zona: string, dia: string): Date {
  const d = new Date(`${dia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return resolveWallTime(zona, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0).at;
}

/** «5 de diciembre», de una fecha `YYYY-MM-DD`. */
function diaEnPalabras(dia: string): string {
  return new Date(`${dia}T12:00:00Z`).toLocaleDateString('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'long' });
}
