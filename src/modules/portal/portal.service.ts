import {
  formatMoney, money, notFound, unauthorized, validation,
} from '@gymflow/core';
import { generateOpaqueToken, hashToken } from '../../platform/crypto.js';
import { isModuleOn } from '../../platform/modules/module-state.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { ChargeRepository, PaymentRepository, StatementRepository, comoSeSaldo, type ChargeRecord } from '../billing/index.js';
import type { NoticePriority, PartesDelCursor } from '@gymflow/core/contracts';
import type { DenialReason, VisitPackStatus } from '@gymflow/core';
import { MemberRepository, MemberNoticeRepository } from '../members/index.js';
import { MembershipRepository } from '../memberships/index.js';
import { PlanRepository } from '../catalog/index.js';
import { AccessService, AttendanceRepository, EnrollmentRepository } from '../access/index.js';
import { VisitPackRepository } from '../memberships/index.js';
import { prioridadDe, type EstadoParaAvisos } from './notice-priority.js';
import { BranchRepository, OrganizationRepository } from '../organization/index.js';
import { PortalRepository, PortalAuthRepository, newInviteCode } from './portal.repository.js';
import type { Env } from '../../platform/env.js';
import type { RequestContext } from '../../platform/context.js';

/** Cuántos cargos y cuántos pagos trae el estado de cuenta del socio de entrada; los demás, con «Ver más». */
export const PORTAL_PAGINA = 24;

/** La invitación caduca pronto: el socio está delante del mostrador. */
const INVITE_TTL_MINUTES = 30;

export type PortalMember = {
  memberId: string;
  memberCode: string;
  fullName: string;
  joinedAt: Date;
  tenureDays: number;
  membershipStatus: string | null;
  planName: string | null;
  currentPeriodEnd: Date | null;
  /** Último día que cubren sus cuotas pagadas (`AAAA-MM-DD`), o null. No es el fin del periodo. */
  paidThrough: string | null;
  graceUntil: Date | null;
  /**
   * Lo que se le va a cobrar y cuándo, si su membresía se renueva sola
   * (UX5-P-05). Es el precio del plan al día de corte; null si no renueva.
   */
  nextPayment: { amountCents: bigint; date: Date } | null;
  gymName: string;
  homeBranchName: string | null;
  /** La zona con que el portal pinta fechas y horas: la de su sede de casa o la del gimnasio (1.5). */
  timezone: string;
  /**
   * Con qué entra y dónde (ADR-032). Sin nada aquí, entra por recepción.
   * Va por sucursal porque la plantilla no viaja: el socio tiene que saber
   * que su rostro de Centro no abre en Norte.
   */
  accessMethods: Array<{ modality: 'FACE' | 'FINGERPRINT'; branchName: string; enrolledAt: Date }>;
  /** Lo que diría la puerta ahora mismo (2.8 · 27-04): `evaluateAccess`, no una regla propia. */
  canEnter: boolean;
  accessReason: DenialReason | null;
  accessBranchName: string | null;
  accessUsesVisit: boolean;
  visitPack: { status: VisitPackStatus; visitsLeft: number; visitsPurchased: number; expiresOn: Date | null } | null;
  dayPass: { branchName: string; validOn: Date } | null;
  planEnded: { planName: string | null; how: 'EXPIRED' | 'CANCELED'; paidThrough: string | null; periodEnd: Date } | null;
};

const DIA_MS = 86_400_000;
/** Cuántas entradas trae Asistencia y desde cuándo cuenta sus días (el calendario enseña tres meses). */
const ENTRADAS_RECIENTES = 12;
const DIAS_DE_CALENDARIO = 124;
/** Cuántos avisos se leen para ordenar: lo pendiente no se queda fuera por diez avisos de teléfono nuevo. */
const AVISOS_A_LEER = 60;

export class PortalService {
  private readonly audit = new AuditService();

  /**
   * Recepción emite la invitación con el socio delante.
   *
   * Es como ocurre de verdad en el alta, no necesita proveedor de SMS, y es
   * más seguro que un código de seis dígitos por mensaje: el canal es el
   * mostrador, no la red telefónica.
   */
  async issueInvite(ctx: RequestContext, memberId: string): Promise<{ code: string; expiresAt: Date }> {
    const orgId = ctx.tenant.organizationId;
    const member = await new MemberRepository(orgId).findById(memberId);
    if (!member) throw notFound('Socio no encontrado');

    // Un código nuevo NO cierra lo que ya está abierto: un segundo teléfono es
    // legítimo. Cerrar los demás es un acto aparte y explícito (PS-02): desde
    // la ficha o desde el propio portal.
    const code = newInviteCode();
    const invite = await new PortalRepository(orgId).issueInvite({
      memberId,
      code,
      ttlMinutes: INVITE_TTL_MINUTES,
      issuedByUserId: ctx.tenant.actorUserId ?? null,
    });

    await this.audit.record(ctx, {
      action: 'portal.invite.issue',
      resourceType: 'portal_invite',
      resourceId: invite.id,
      afterState: { memberId, expiresAt: invite.expiresAt.toISOString() },
    });

    // El código EN CLARO se devuelve una vez y no se guarda: la base solo
    // tiene su hash.
    return { code, expiresAt: invite.expiresAt };
  }

  /** Recepción cierra el portal en todos los teléfonos del socio (PS-02). */
  async revokeAllSessions(ctx: RequestContext, memberId: string): Promise<number> {
    const orgId = ctx.tenant.organizationId;
    const member = await new MemberRepository(orgId).findById(memberId);
    if (!member) throw notFound('Socio no encontrado');
    const cerradas = await new PortalAuthRepository().revokeAllForMember(orgId, memberId, 'Cerrado desde recepción');
    await this.audit.record(ctx, {
      action: 'portal.sessions.revoke', resourceType: 'Member', resourceId: memberId,
      branchId: member.homeBranchId, afterState: { sessionsRevoked: cerradas },
    });
    return cerradas;
  }

  /** El socio, desde su teléfono: "cerrar en todos" (teléfono perdido). */
  async logoutEverywhere(organizationId: string, memberId: string): Promise<number> {
    return new PortalAuthRepository().revokeAllForMember(organizationId, memberId, 'El socio cerró sesión en todos sus teléfonos');
  }

  async sessions(organizationId: string, memberId: string): Promise<{ active: number; lastSeenAt: Date | null }> {
    return new PortalAuthRepository().activeForMember(organizationId, memberId);
  }

  /**
   * Canjea el código y activa el dispositivo.
   *
   * Solo crea la sesión del socio. Hasta ADR-032 además emitía la credencial
   * QR y devolvía su secreto; con acceso por rostro y huella, ese secreto no
   * serviría para nada salvo para filtrarse.
   */
  async enroll(env: Env, input: { code: string; userAgent: string | null }): Promise<{
    token: string; memberId: string; organizationId: string; expiresAt: Date;
  }> {
    const auth = new PortalAuthRepository();
    const canje = await auth.redeem(input.code.trim().toUpperCase());
    // Mensaje único para código inválido, caducado o ya usado: distinguirlos
    // diría a quien prueba códigos cuáles existen.
    if (!canje) throw unauthorized('Código inválido o caducado');
    // El gimnasio apagó el portal después de emitir el código: se le dice
    // claro, no "código inválido".
    if (!(await isModuleOn(canje.organizationId, 'member_portal'))) {
      throw notFound('El portal del socio no está disponible en este gimnasio. Pregunta en recepción.');
    }

    const token = generateOpaqueToken();
    const session = await auth.createSession({
      organizationId: canje.organizationId,
      memberId: canje.memberId,
      tokenHash: hashToken(token),
      ttlDays: env.SESSION_TTL_MEMBER_DAYS,
      userAgent: input.userAgent,
    });

    // El socio se entera de que su portal se abrió en otro aparato (PS-03): si no fue él, cierra todo desde Cuenta.
    // Con la fecha y la hora de SU gimnasio (25-11): «Hoy a las 16:31» seguía diciendo «hoy» una semana después.
    const socio = await new MemberRepository(canje.organizationId).findById(canje.memberId);
    const zona = await new BusinessCalendar(canje.organizationId).timezoneFor(socio?.homeBranchId ?? null);
    await new MemberNoticeRepository(canje.organizationId).emit({
      memberId: canje.memberId, kind: 'NEW_DEVICE', dedupeKey: `NEW_DEVICE:${session.id}`,
      title: 'Tu portal se activó en un teléfono',
      body: `${cuandoSeActivo(new Date(), zona)}. Si no fuiste tú, cierra la sesión en todos tus teléfonos desde Cuenta y avisa en recepción.`,
    });

    return {
      token,
      memberId: canje.memberId,
      organizationId: canje.organizationId,
      expiresAt: session.expiresAt,
    };
  }

  // ── Datos del portal ──────────────────────────────────────────────────────

  async account(organizationId: string, memberId: string): Promise<PortalMember> {
    const member = await new MemberRepository(organizationId).findById(memberId);
    if (!member) throw notFound('Socio no encontrado');

    // Una suspendida no está "viva", pero es la que el socio tiene que ver:
    // decirle "sin plan" a quien debe una cuota le esconde por qué no entra
    // y cómo arreglarlo.
    const membresias = new MembershipRepository(organizationId);
    const membership = await membresias.findLiveForMember(memberId)
      ?? (await membresias.listForMember(memberId)).find((m) => m.status === 'SUSPENDED')
      ?? null;
    const plan = membership ? await new PlanRepository(organizationId).findById(membership.planId) : null;
    const hoy = await new BusinessCalendar(organizationId).today(member.homeBranchId);
    const [org, sedes, enrolamientos] = await Promise.all([
      new OrganizationRepository(organizationId).current(),
      new BranchRepository(organizationId).list(),
      new EnrollmentRepository(organizationId).listForMember(memberId),
    ]);
    const nombreSede = new Map(sedes.map((b) => [b.id, b.name]));

    // «¿Puedo entrar hoy?» lo contesta la puerta (27-04), en su sede de casa.
    const sedeDeCasa = member.homeBranchId ?? membership?.soldAtBranchId ?? sedes[0]?.id ?? null;
    const [puerta, paquete, terminada] = await Promise.all([
      sedeDeCasa ? this.puerta(organizationId, memberId, sedeDeCasa) : null,
      this.paquete(organizationId, memberId),
      membership ? null : this.planTerminado(membresias, organizationId, memberId),
    ]);
    const pase = puerta?.subject?.dayPass ?? null;

    return {
      memberId: member.id,
      memberCode: member.memberCode,
      fullName: `${member.firstName} ${member.lastName}`,
      joinedAt: member.joinedAt,
      tenureDays: Math.floor((hoy.getTime() - member.joinedAt.getTime()) / 86_400_000),
      membershipStatus: membership?.status ?? null,
      planName: plan?.name ?? null,
      currentPeriodEnd: membership?.currentPeriodEnd ?? null,
      // «Pagado hasta» de verdad (auditoría 8, 3-01): el fin del periodo no dice si se pagó.
      paidThrough: membership ? ((p) => (p ? p.toISOString().slice(0, 10) : null))((await membresias.paidThroughFor([membership.id])).get(membership.id) ?? null) : null,
      graceUntil: membership?.graceUntil ?? null,
      nextPayment: membership && plan && membership.autoRenew && (membership.status === 'ACTIVE' || membership.status === 'TRIALING')
        && (plan.billingModel === 'RECURRING' || plan.billingModel === 'PREPAID_PERIOD') && (membership.agreedPriceCents ?? plan.priceCents) > 0n
        // Lo que de verdad se le va a cobrar (DM-05): su precio pactado, no el de lista.
        ? { amountCents: membership.agreedPriceCents ?? plan.priceCents, date: membership.currentPeriodEnd }
        : null,
      gymName: org?.tradeName ?? '',
      homeBranchName: member.homeBranchId ? nombreSede.get(member.homeBranchId) ?? null : null,
      timezone: (member.homeBranchId ? sedes.find((b) => b.id === member.homeBranchId)?.timezone : null) ?? org?.timezone ?? 'America/Mexico_City',
      accessMethods: enrolamientos
        .filter((e) => e.revokedAt === null)
        .map((e) => ({ modality: e.modality, branchName: nombreSede.get(e.branchId) ?? 'Otra sucursal', enrolledAt: e.enrolledAt })),
      canEnter: puerta?.decision.outcome === 'GRANTED',
      accessReason: puerta ? puerta.decision.reason : 'NO_MEMBERSHIP',
      accessBranchName: puerta ? nombreSede.get(puerta.branchId) ?? null : null,
      accessUsesVisit: puerta?.decision.consumesVisit ?? false,
      visitPack: paquete,
      // El pase que armó la puerta ya es el pagado de hoy (1.8); aquí solo se le pone el nombre de su sede.
      dayPass: pase ? { branchName: nombreSede.get(pase.branchId) ?? 'Otra sucursal', validOn: await new BusinessCalendar(organizationId).today(pase.branchId) } : null,
      planEnded: terminada,
    };
  }

  /**
   * La puerta, preguntada por el socio (2.8 · 27-04): `evaluateAccess` con el
   * sujeto que arma el mostrador, en su sede de casa. Si ahí no entra pero hoy
   * trae un pase del día o una clase suelta pagada de OTRA sede, se pregunta
   * también en esa: la respuesta sigue siendo de la puerta, y dice dónde vale.
   */
  private async puerta(organizationId: string, memberId: string, sedeDeCasa: string) {
    const acceso = new AccessService();
    const enCasa = await acceso.veredictoParaElSocio(organizationId, memberId, sedeDeCasa);
    if (enCasa.decision.outcome === 'GRANTED') return { ...enCasa, branchId: sedeDeCasa };
    const otras = new Set([enCasa.subject?.dayPass?.branchId, enCasa.subject?.classPass?.branchId].filter((b): b is string => !!b && b !== sedeDeCasa));
    for (const branchId of otras) {
      const ahi = await acceso.veredictoParaElSocio(organizationId, memberId, branchId);
      if (ahi.decision.outcome === 'GRANTED') return { ...ahi, branchId };
    }
    return { ...enCasa, branchId: sedeDeCasa };
  }

  /** Su paquete de visitas: el activo o, si no hay, el más reciente (el mismo que mira la puerta). */
  private async paquete(organizationId: string, memberId: string): Promise<PortalMember['visitPack']> {
    const repo = new VisitPackRepository(organizationId);
    const todos = await repo.listForMember(memberId);
    const p = todos.find((x) => x.status === 'ACTIVE') ?? todos[0] ?? null;
    if (!p) return null;
    return { status: p.status, visitsLeft: Math.max(0, await repo.balance(p.id)), visitsPurchased: p.visitsPurchased, expiresOn: p.expiresOn };
  }

  /** Sin membresía viva ni suspendida: la última que tuvo, para decir «terminó» y no «no tienes» (25-04). */
  private async planTerminado(membresias: MembershipRepository, organizationId: string, memberId: string): Promise<PortalMember['planEnded']> {
    const ultima = (await membresias.listForMember(memberId)).find((m) => m.status === 'EXPIRED' || m.status === 'CANCELED');
    if (!ultima) return null;
    const [plan, pagado] = await Promise.all([
      new PlanRepository(organizationId).findById(ultima.planId),
      membresias.paidThroughFor([ultima.id]),
    ]);
    const hasta = pagado.get(ultima.id) ?? null;
    return {
      planName: plan?.name ?? null,
      how: ultima.status === 'CANCELED' ? 'CANCELED' : 'EXPIRED',
      paidThrough: hasta ? hasta.toISOString().slice(0, 10) : null,
      periodEnd: new Date(ultima.currentPeriodEnd.getTime() - DIA_MS),
    };
  }

  /**
   * Estado de cuenta del socio.
   *
   * Lleva `computedAt` porque el principio 10 de la visión lo exige: ninguna
   * cifra se muestra sin su origen. Un saldo sin "actualizado hace X" invita a
   * discutirlo, y el socio no tiene forma de saber si mira algo viejo.
   */
  async statement(organizationId: string, memberId: string, limit = PORTAL_PAGINA) {
    const charges = new ChargeRepository(organizationId);
    const payments = new PaymentRepository(organizationId);
    const lectura = new StatementRepository(organizationId);

    const [outstanding, credit, cargos, pagos] = await Promise.all([
      charges.outstandingTotalCents(memberId),
      payments.creditBalanceCents(memberId),
      this.chargesPage(organizationId, memberId, limit, null),
      lectura.paymentsPage(memberId, limit, null),
    ]);
    // Lo que debe y quedó más atrás que la primera página viene también: «Por pagar» nunca esconde una cuota.
    const viejos = cargos.hasMore ? await this.conSaldado(lectura, await lectura.debtOutside(memberId, cargos.items.map((c) => c.id))) : [];

    return {
      computedAt: new Date(),
      outstandingCents: outstanding,
      creditCents: credit,
      netBalanceCents: outstanding - credit,
      netBalanceLabel: formatMoney(money(outstanding - credit)),
      charges: [...cargos.items, ...viejos],
      payments: pagos.items,
      pages: {
        charges: { total: cargos.total, nextCursor: cargos.nextCursor, hasMore: cargos.hasMore },
        payments: { total: pagos.total, nextCursor: pagos.nextCursor, hasMore: pagos.hasMore },
      },
    };
  }

  /** Una página de sus cargos, cada uno con cómo quedó saldado (3-06). */
  async chargesPage(organizationId: string, memberId: string, limit: number, cursor: PartesDelCursor | null) {
    const lectura = new StatementRepository(organizationId);
    const pagina = await lectura.chargesPage(memberId, limit, cursor);
    return { ...pagina, items: await this.conSaldado(lectura, pagina.items) };
  }

  /** Una página de sus pagos, del más reciente al más viejo. */
  async paymentsPage(organizationId: string, memberId: string, limit: number, cursor: PartesDelCursor | null) {
    return new StatementRepository(organizationId).paymentsPage(memberId, limit, cursor);
  }

  private async conSaldado(lectura: StatementRepository, cargos: readonly ChargeRecord[]) {
    const ajustes = await lectura.adjustmentsFor(cargos.filter((c) => c.adjustedCents > 0n).map((c) => c.id));
    return cargos.map((c) => ({ ...c, settledBy: comoSeSaldo(c, ajustes.get(c.id) ?? []) }));
  }

  /**
   * Historial de asistencia. Es lo que el socio quiere ver de verdad. Los DÍAS
   * son los de operación del gimnasio, como los guardó la puerta (27-05): el
   * teléfono ya no los deduce con su hora, y el calendario los marca tal cual.
   */
  async attendance(organizationId: string, memberId: string) {
    const repo = new AttendanceRepository(organizationId);
    const [visitas, dias, sedes] = await Promise.all([
      repo.visitsWithDay(memberId, ENTRADAS_RECIENTES),
      repo.visitDays(memberId, new Date(Date.now() - DIAS_DE_CALENDARIO * DIA_MS)),
      new BranchRepository(organizationId).list(),
    ]);
    const nombreSede = new Map(sedes.map((b) => [b.id, b.name]));
    return { days: dias, visits: visitas.map((v) => ({ ...v, branchName: nombreSede.get(v.branchId) ?? null })) };
  }

  /** Sus visitas en días, con el «hoy» de su sede (27-05, 25-16): lo mismo para Inicio y para Asistencia. */
  async attendanceSummary(organizationId: string, memberId: string) {
    const member = await new MemberRepository(organizationId).findById(memberId);
    if (!member) throw notFound('Socio no encontrado');
    const hoy = await new BusinessCalendar(organizationId).today(member.homeBranchId);
    const dias = await new AttendanceRepository(organizationId).visitDays(memberId, new Date(hoy.getTime() - 31 * DIA_MS));
    return { today: hoy, ...contarDias(dias, hoy) };
  }

  /**
   * Sus avisos, lo pendiente arriba (25-11): un aviso de dinero o de acceso va
   * en «Por resolver» solo mientras HOY siga pendiente; pagado, baja a los
   * recientes. Dentro de cada grupo, del más nuevo al más viejo.
   */
  async notices(organizationId: string, memberId: string) {
    const repo = new MemberNoticeRepository(organizationId);
    const membresias = new MembershipRepository(organizationId);
    const [avisos, unread, debe, membresia] = await Promise.all([
      repo.listForMember(memberId, AVISOS_A_LEER), repo.unreadCount(memberId),
      new ChargeRepository(organizationId).outstandingTotalCents(memberId),
      membresias.findCurrentForMember(memberId),
    ]);
    const estado: EstadoParaAvisos = { debe: debe > 0n, sinAcceso: membresia?.status === 'SUSPENDED' || membresia?.status === 'PAST_DUE', ahora: new Date() };
    const ORDEN: Record<NoticePriority, number> = { RESOLVE: 0, CLASS: 1, INFO: 2 };
    const conPrioridad = avisos.map((n) => ({ ...n, priority: prioridadDe(n, estado) }))
      .sort((a, b) => ORDEN[a.priority] - ORDEN[b.priority] || b.createdAt.getTime() - a.createdAt.getTime());
    return { unread, notices: conPrioridad };
  }

  /**
   * El comprobante de UN pago suyo (25-14), con lo mínimo: gimnasio, sede,
   * folio, fecha, forma de pago y a qué se aplicó. Solo de un pago aplicado
   * (o revertido, y entonces lo dice su contra-asiento); nunca de otro socio.
   */
  async receipt(organizationId: string, memberId: string, paymentId: string) {
    const pagos = new PaymentRepository(organizationId);
    const pago = await pagos.findById(paymentId);
    if (!pago || pago.memberId !== memberId || !tieneComprobante(pago.status)) throw notFound('Ese pago no tiene comprobante');
    const cargos = new ChargeRepository(organizationId);
    const [socio, org, sedes, asignaciones] = await Promise.all([
      new MemberRepository(organizationId).findById(memberId),
      new OrganizationRepository(organizationId).current(),
      new BranchRepository(organizationId).list(),
      pagos.listAllocations(paymentId),
    ]);
    if (!socio) throw notFound('Socio no encontrado');
    const tocados = await Promise.all(asignaciones.map((a) => cargos.findById(a.chargeId)));
    return {
      gymName: org?.tradeName ?? '',
      branchName: pago.branchId ? sedes.find((b) => b.id === pago.branchId)?.name ?? null : null,
      memberName: `${socio.firstName} ${socio.lastName}`,
      memberCode: socio.memberCode,
      pago,
      lines: asignaciones.map((a, i) => ({ concept: tocados[i]?.concept ?? 'Cargo', amountCents: a.amountCents })),
    };
  }

  async revokeSession(token: string, reason: string): Promise<void> {
    await new PortalAuthRepository().revokeSession(hashToken(token), reason);
  }
}

export { validation };

/** Un pago con comprobante para el socio: aplicado, o aplicado y después revertido. */
export function tieneComprobante(status: string): boolean {
  return status === 'SUCCEEDED' || status === 'REVERSED';
}

/** «El 17 de noviembre a las 16:31», en la zona del gimnasio. */
export function cuandoSeActivo(at: Date, zona: string): string {
  const dia = new Intl.DateTimeFormat('es-MX', { timeZone: zona, day: 'numeric', month: 'long' }).format(at);
  const hora = new Intl.DateTimeFormat('es-MX', { timeZone: zona, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  return `El ${dia} a las ${hora}`;
}

/** Días distintos del mes en curso y de los últimos 28 días (hoy incluido). `dias` y `hoy` son días de operación (medianoche UTC). */
export function contarDias(dias: readonly Date[], hoy: Date): { daysThisMonth: number; daysLast28: number } {
  const unicos = [...new Set(dias.map((d) => d.getTime()))].filter((t) => t <= hoy.getTime());
  const inicioDeMes = Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1);
  const hace28 = hoy.getTime() - 27 * DIA_MS;
  return {
    daysThisMonth: unicos.filter((t) => t >= inicioDeMes).length,
    daysLast28: unicos.filter((t) => t >= hace28).length,
  };
}
