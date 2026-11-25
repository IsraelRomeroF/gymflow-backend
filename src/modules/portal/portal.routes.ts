import type { FastifyInstance, FastifyRequest } from 'fastify';
import { onlinePaymentsEnabled } from '../../platform/payments-mode.js';
import { z } from 'zod';
import { DomainError, formatMoney, money, moduleDisabled, notFound, validation } from '@gymflow/core';
import {
  PAGINA_MAXIMA, PortalAttendance, PortalAttendanceSummary, PortalChargesPage, PortalMe, PortalNotices, PortalNotifications,
  PortalOffer, PortalPaymentsPage, PortalReceipt, PortalSessions, PortalStatement, leerCursor,
  type PartesDelCursor, type PortalCharge, type PortalPayment,
} from '@gymflow/core/contracts';
import type { SessionEndReason } from '@gymflow/core/vocabulario';
import type { ChargeRecord } from '../billing/index.js';
import { MemberRepository, MemberNoticeRepository } from '../members/index.js';
import { hashToken } from '../../platform/crypto.js';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { registerMemberOrganizationResolver } from '../../platform/http/member-session.js';
import { ErrorConMotivo, opcionesDeCookie } from '../../platform/http/sesion.js';
import { moduleViewOf, modulesOf } from '../../platform/modules/module-state.js';
import { contar, registerModuleUsage } from '../../platform/modules/usage.js';
import { CIERRE_DEL_SOCIO, MEMBER_IDLE_DAYS, PortalAuthRepository, PortalRepository } from './portal.repository.js';
import { PORTAL_PAGINA, PortalService, tieneComprobante } from './portal.service.js';
import { PortalNotificationsService } from './notificaciones.js';
import { ofertaPara } from './oferta.js';
import { registerPortalContactRoutes } from './contacto.routes.js';
import type { Env } from '../../platform/env.js';

const idParam = z.object({ id: z.string().uuid() });
const cents = (v: bigint): string => v.toString();
const iso = (d: Date): string => d.toISOString().slice(0, 10);

const PORTAL_COOKIE = 'gf_portal';

/** `?cursor=&limit=` del estado de cuenta del socio: 24 de entrada, como siempre. */
const paginaQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(PAGINA_MAXIMA).default(PORTAL_PAGINA),
});

function cursorDelPortal(texto: string | undefined): PartesDelCursor | null {
  if (texto === undefined) return null;
  const partes = leerCursor(texto);
  if (!partes) throw validation('Esa página ya no existe. Vuelve a abrir tus pagos.');
  return partes;
}

type CargoConSaldado = ChargeRecord & { settledBy: PortalCharge['settledBy'] };

/** Un cargo como lo ve el socio. */
function cargoDelSocio(c: CargoConSaldado): PortalCharge {
  const saldo = c.amountCents - c.allocatedCents - c.adjustedCents;
  return {
    id: c.id,
    concept: c.concept,
    status: c.status,
    amountCents: cents(c.amountCents),
    amountLabel: formatMoney(money(c.amountCents)),
    // Anulado o condonado no debe nada aunque la aritmética diga otra cosa (PS-05).
    balanceCents: cents(!['OPEN', 'PARTIALLY_PAID', 'OVERDUE'].includes(c.status) || saldo < 0n ? 0n : saldo),
    dueDate: iso(c.dueDate),
    // Cómo quedó saldado: una cuota perdonada ya no se le dice «Pagado» (3-06).
    settledBy: c.settledBy,
  };
}

/** Un pago como lo ve el socio (negativo = se le devolvió). */
function pagoDelSocio(p: { id: string; method: PortalPayment['method']; status: string; amountCents: bigint; folio: string | null; businessDate: Date }): PortalPayment {
  return {
    id: p.id,
    method: p.method,
    amountCents: cents(p.amountCents),
    amountLabel: formatMoney(money(p.amountCents)),
    folio: p.folio,
    businessDate: iso(p.businessDate),
    // Con comprobante que puede abrir (25-14): un pago aplicado o su contra-asiento.
    hasReceipt: tieneComprobante(p.status),
  };
}

/**
 * Sesión del SOCIO, separada de la del personal.
 *
 * No pasa por `authPlugin`: ese resuelve usuarios con permisos, y un socio no
 * es un usuario (ADR-023). Mezclarlos significaría que un fallo aquí podría
 * conceder permisos de personal, y un fallo así no revienta: autoriza.
 */
type SesionDeSocio = { organizationId: string; memberId: string; /** La hora tope de la sesión de ESTE teléfono. */ expiresAt: Date; /** La sesión de ESTE teléfono: a ella se atan sus notificaciones (3.10). */ sessionId: string };
/** Una consulta por petición: la puerta de módulos y el handler preguntan lo mismo. */
const resueltas = new WeakMap<FastifyRequest, Promise<SesionDeSocio>>();
/** Las peticiones en las que la sesión se renovó con el uso (D-04): al responder se vuelve a poner su cookie con la fecha nueva. */
const renovadas = new WeakMap<FastifyRequest, { token: string; hasta: Date }>();

/**
 * Por qué terminó el portal en ese teléfono, con el mismo catálogo de `reason`
 * que la sesión del personal (`SESSION_END_REASONS` del núcleo) y el texto
 * para el socio. Sin cookie o con una que no es de nadie: `NO_SESSION`.
 */
const FIN_DEL_PORTAL = {
  NO_SESSION: 'Sesión requerida',
  SESSION_EXPIRED: 'Tu acceso en este teléfono venció. Pide en recepción un código nuevo para volver a entrar.',
  SESSION_IDLE: `Pasaron ${MEMBER_IDLE_DAYS} días sin abrir el portal y se cerró en este teléfono. Pide en recepción un código nuevo.`,
  SESSION_LOGGED_OUT: 'Cerraste el portal en este teléfono. Pide en recepción un código nuevo para volver a entrar.',
  SESSION_CLOSED_EVERYWHERE: 'El portal se cerró en todos tus teléfonos. Pide en recepción un código nuevo para volver a entrar.',
  ACCOUNT_DEACTIVATED: 'Tu cuenta ya no está activa en este gimnasio. Pregunta en recepción.',
} as const satisfies Partial<Record<SessionEndReason, string>>;

function finDelPortal(reason: keyof typeof FIN_DEL_PORTAL): ErrorConMotivo {
  return new ErrorConMotivo('UNAUTHENTICATED', FIN_DEL_PORTAL[reason], reason);
}

export function requireMemberSession(request: FastifyRequest): Promise<SesionDeSocio> {
  let sesion = resueltas.get(request);
  if (!sesion) {
    sesion = (async () => {
      // El 401 dice POR QUÉ (`reason`), como el del personal (1.12): «Activar» le cuenta al socio qué pasó.
      const token = request.cookies[PORTAL_COOKIE];
      if (!token) throw finDelPortal('NO_SESSION');
      const auth = new PortalAuthRepository();
      const session = await auth.findSession(hashToken(token));
      if (!session) throw finDelPortal(await auth.whyEnded(hashToken(token)) ?? 'NO_SESSION');
      // Con el servicio suspendido o el portal apagado, ninguna sesión de
      // socio sirve para nada, tampoco para las rutas de otros módulos.
      const vista = await moduleViewOf(session.organizationId);
      if (vista.serviceStatus !== 'ACTIVE') throw new DomainError('FORBIDDEN', 'El servicio de tu gimnasio no está activo. Pregunta en recepción.');
      if (!vista.org.has('member_portal')) throw moduleDisabled('Portal del socio');
      if (session.renovada) renovadas.set(request, { token, hasta: session.expiresAt });
      return { organizationId: session.organizationId, memberId: session.memberId, expiresAt: session.expiresAt, sessionId: session.id };
    })();
    resueltas.set(request, sesion);
  }
  return sesion;
}

export function registerPortalRoutes(app: FastifyInstance, env: Env): void {
  const service = new PortalService();
  // La puerta de módulos pregunta de qué gimnasio es el socio sin conocer al portal.
  registerMemberOrganizationResolver((request) => requireMemberSession(request).then((s) => s.organizationId, () => null));
  // D-04 (bloque 4.1): el portal queda abierto mientras se use. Cuando un uso corrió el vencimiento de la
  // sesión, la respuesta vuelve a poner la cookie de ESE teléfono con la misma fecha que quedó en la base
  // (en cualquier ruta de socio, también las de otros módulos). Salir la borra: ahí no se vuelve a poner.
  app.addHook('onSend', async (request, reply) => {
    const r = renovadas.get(request);
    if (!r) return;
    renovadas.delete(request);
    const url = request.routeOptions.url;
    if (url === '/portal/logout' || url === '/portal/logout-all') return;
    reply.setCookie(PORTAL_COOKIE, r.token, opcionesDeCookie(request, env, r.hasta));
  });
  registerModuleUsage('member_portal', async (orgId) => ({
    inUse: contar(await new PortalAuthRepository().activeSessions(orgId), 'socio con el portal activo en su teléfono', 'socios con el portal activo en su teléfono'),
    blockers: [],
  }));

  // ── Recepción emite la invitación ─────────────────────────────────────────
  route(app, {
    method: 'POST',
    url: '/members/:id/portal-invite',
    security: { kind: 'permission', permission: 'members:portal:invite' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      // Una invitación abre TODO el expediente del socio: solo la emite quien
      // tiene alcance sobre su sede de casa (SEC2-01).
      const socio = await new MemberRepository(ctx.tenant.organizationId).findById(id);
      if (!socio) throw notFound('Socio no encontrado');
      request.requirePermission('members:portal:invite', socio.homeBranchId);
      const { code, expiresAt } = await service.issueInvite(ctx, id);
      // El código EN CLARO se devuelve UNA vez. La base solo guarda su hash.
      return reply.status(201).send({ code, expiresAt: expiresAt.toISOString() });
    },
  });

  /** Teléfonos con el portal abierto: para que recepción sepa si cerrar o no. */
  route(app, {
    method: 'GET',
    url: '/members/:id/portal-sessions',
    security: { kind: 'permission', permission: 'members:portal:invite' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const socio = await new MemberRepository(ctx.tenant.organizationId).findById(id);
      if (!socio) throw notFound('Socio no encontrado');
      request.requirePermission('members:portal:invite', socio.homeBranchId);
      const r = await service.sessions(ctx.tenant.organizationId, id);
      return { active: r.active, lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null };
    },
  });

  /** Teléfono perdido: recepción cierra el portal en todos los aparatos del socio (PS-02). */
  route(app, {
    method: 'POST',
    url: '/members/:id/portal-sessions/revoke',
    security: { kind: 'permission', permission: 'members:portal:invite' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const socio = await new MemberRepository(ctx.tenant.organizationId).findById(id);
      if (!socio) throw notFound('Socio no encontrado');
      request.requirePermission('members:portal:invite', socio.homeBranchId);
      return { revoked: await service.revokeAllSessions(ctx, id) };
    },
  });

  // ── Activación del dispositivo ────────────────────────────────────────────
  route(app, {
    method: 'POST',
    url: '/portal/enroll',
    security: {
      kind: 'public',
      why: 'El socio llega con un código y sin sesión; es el equivalente al login del personal',
    },
    config: { rateLimit: { max: env.PORTAL_ENROLL_ATTEMPTS, timeWindow: '5 minutes' } },
    handler: async (request, reply) => {
      const body = z.object({ code: z.string().min(6).max(24) }).parse(request.body);

      const r = await service.enroll(env, {
        code: body.code,
        userAgent: request.headers['user-agent'] ?? null,
      });

      // `Secure` también cuando llega por https (el túnel), no solo en producción.
      reply.setCookie(PORTAL_COOKIE, r.token, opcionesDeCookie(request, env, r.expiresAt));

      return reply.status(201).send({
        memberId: r.memberId,
        expiresAt: r.expiresAt.toISOString(),
      });
    },
  });

  route(app, {
    method: 'POST',
    url: '/portal/logout',
    security: { kind: 'public', why: 'Cerrar sesión no puede depender de que la sesión siga siendo válida' },
    handler: async (request, reply) => {
      const token = request.cookies[PORTAL_COOKIE];
      if (token) await service.revokeSession(token, CIERRE_DEL_SOCIO);
      reply.clearCookie(PORTAL_COOKIE, opcionesDeCookie(request, env));
      return { ok: true };
    },
  });

  /** "Cerrar sesión en todos mis teléfonos": el socio perdió uno (PS-02). */
  route(app, {
    method: 'POST',
    url: '/portal/logout-all',
    security: { kind: 'member' },
    handler: async (request, reply) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const revoked = await service.logoutEverywhere(organizationId, memberId);
      reply.clearCookie(PORTAL_COOKIE, opcionesDeCookie(request, env));
      return { ok: true, revoked };
    },
  });

  /** Avisos del socio (PS-03): pagos, clases, suspensión, aviso de privacidad nuevo. */
  route(app, {
    method: 'GET',
    url: '/portal/notices',
    security: { kind: 'member' },
    schema: respuesta(200, PortalNotices),
    handler: async (request): Promise<PortalNotices> => {
      const { organizationId, memberId } = await requireMemberSession(request);
      // Lo que hoy sigue pendiente (dinero, acceso) va arriba; lo demás, por fecha (25-11).
      const r = await service.notices(organizationId, memberId);
      return {
        unread: r.unread,
        notices: r.notices.map((n) => ({
          id: n.id, kind: n.kind, title: n.title, body: n.body, priority: n.priority,
          createdAt: n.createdAt.toISOString(), readAt: n.readAt ? n.readAt.toISOString() : null,
        })),
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/portal/notices/read',
    security: { kind: 'member' },
    handler: async (request) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const { ids } = z.object({ ids: z.array(z.string().uuid()).max(100).optional() }).parse(request.body ?? {});
      return { read: await new MemberNoticeRepository(organizationId).markRead(memberId, ids ?? null) };
    },
  });

  /**
   * Cuántos teléfonos tienen el portal abierto, para decidir si cerrarlos, y
   * hasta cuándo queda abierto ESTE (pendiente de 1.12): antes la fecha solo
   * la sabía el teléfono que la guardó al activar.
   */
  route(app, {
    method: 'GET',
    url: '/portal/sessions',
    security: { kind: 'member' },
    schema: respuesta(200, PortalSessions),
    handler: async (request): Promise<PortalSessions> => {
      const { organizationId, memberId, expiresAt } = await requireMemberSession(request);
      const r = await service.sessions(organizationId, memberId);
      return {
        active: r.active, lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
        current: { expiresAt: expiresAt.toISOString(), idleDays: MEMBER_IDLE_DAYS },
      };
    },
  });

  // ── Datos del socio ───────────────────────────────────────────────────────
  route(app, {
    method: 'GET',
    url: '/portal/me',
    security: { kind: 'member' },
    schema: respuesta(200, PortalMe),
    handler: async (request): Promise<PortalMe> => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const [a, conTarjeta, modulos] = await Promise.all([
        service.account(organizationId, memberId),
        new PortalRepository(organizationId).hasActiveCard(memberId),
        modulesOf(organizationId),
      ]);
      const enLinea = onlinePaymentsEnabled();
      // Contrato: `PortalMe` (`@gymflow/core/contracts`); trae `timezone` para pintar con la hora del gimnasio (1.5).
      return {
        ...a,
        membershipStatus: a.membershipStatus as PortalMe['membershipStatus'],
        joinedAt: iso(a.joinedAt),
        currentPeriodEnd: a.currentPeriodEnd ? iso(a.currentPeriodEnd) : null,
        graceUntil: a.graceUntil ? iso(a.graceUntil) : null,
        nextPayment: a.nextPayment ? { amountCents: a.nextPayment.amountCents.toString(), date: iso(a.nextPayment.date) } : null,
        // Nunca la referencia de la plantilla: el socio no la necesita y es
        // justo lo que ordena su borrado.
        accessMethods: a.accessMethods.map((m) => ({ ...m, enrolledAt: m.enrolledAt.toISOString() })),
        visitPack: a.visitPack && { ...a.visitPack, expiresOn: a.visitPack.expiresOn ? iso(a.visitPack.expiresOn) : null },
        dayPass: a.dayPass && { branchName: a.dayPass.branchName, validOn: iso(a.dayPass.validOn) },
        trialPass: a.trialPass && { branchName: a.trialPass.branchName, validOn: iso(a.trialPass.validOn) },
        planEnded: a.planEnded && { ...a.planEnded, periodEnd: iso(a.planEnded.periodEnd) },
        // Lo que el gimnasio le ofrece al socio (ADR-036), ya resuelto: el portal no interpreta claves de módulo.
        // `classes` es el módulo; si además hay clases en el horario lo contesta `/portal/classes/offered`.
        features: { classes: modulos.has('classes'), routines: modulos.has('training'), onlinePayments: enLinea },
        // EN RETIRO: lo mismo que `features`, para quien todavía lo lea.
        modules: [...modulos],
        // Sin procesador conectado, el portal no ofrece domiciliar ni pagar: se paga en recepción.
        onlinePayments: enLinea,
        // Ya domicilió: Inicio deja de invitarlo a hacerlo (UX7 Portal 8).
        hasCardOnFile: conTarjeta,
      };
    },
  });

  route(app, {
    method: 'GET',
    url: '/portal/statement',
    security: { kind: 'member' },
    schema: respuesta(200, PortalStatement),
    handler: async (request): Promise<PortalStatement> => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const { limit } = paginaQuery.parse(request.query);
      const s = await service.statement(organizationId, memberId, limit);
      // Contrato: `PortalStatement` (`@gymflow/core/contracts`).
      return {
        /** Principio 10: ninguna cifra sin su origen. */
        computedAt: s.computedAt.toISOString(),
        outstandingCents: cents(s.outstandingCents),
        creditCents: cents(s.creditCents),
        netBalanceCents: cents(s.netBalanceCents),
        netBalanceLabel: s.netBalanceLabel,
        /** Lo más reciente, más todo lo que deba aunque sea viejo. */
        charges: s.charges.map(cargoDelSocio),
        payments: s.payments.map(pagoDelSocio),
        /** Cuántos hay y cómo pedir los demás: ya no se corta en 24 sin avisar (4-15). */
        pages: s.pages,
      };
    },
  });

  /** «Ver más» de sus cargos. Contrato: `PortalChargesPage`. */
  route(app, {
    method: 'GET',
    url: '/portal/statement/charges',
    security: { kind: 'member' },
    schema: respuesta(200, PortalChargesPage),
    handler: async (request): Promise<PortalChargesPage> => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const q = paginaQuery.parse(request.query);
      const p = await service.chargesPage(organizationId, memberId, q.limit, cursorDelPortal(q.cursor));
      return { ...p, items: p.items.map(cargoDelSocio) };
    },
  });

  /** «Ver más» de sus pagos. Contrato: `PortalPaymentsPage`. */
  route(app, {
    method: 'GET',
    url: '/portal/statement/payments',
    security: { kind: 'member' },
    schema: respuesta(200, PortalPaymentsPage),
    handler: async (request): Promise<PortalPaymentsPage> => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const q = paginaQuery.parse(request.query);
      const p = await service.paymentsPage(organizationId, memberId, q.limit, cursorDelPortal(q.cursor));
      return { ...p, items: p.items.map(pagoDelSocio) };
    },
  });

  /** Sus días de visita (para el calendario) y sus últimas entradas. Contrato: `PortalAttendance`. */
  route(app, {
    method: 'GET',
    url: '/portal/attendance',
    security: { kind: 'member' },
    schema: respuesta(200, PortalAttendance),
    handler: async (request): Promise<PortalAttendance> => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const r = await service.attendance(organizationId, memberId);
      return {
        days: r.days.map(iso),
        visits: r.visits.map((v) => ({ at: v.at.toISOString(), day: iso(v.businessDate), branchId: v.branchId, branchName: v.branchName })),
      };
    },
  });

  /** Sus visitas del mes y de las últimas cuatro semanas, en DÍAS y con el hoy del gimnasio (27-05, 25-16). */
  route(app, {
    method: 'GET',
    url: '/portal/attendance/summary',
    security: { kind: 'member' },
    schema: respuesta(200, PortalAttendanceSummary),
    handler: async (request): Promise<PortalAttendanceSummary> => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const r = await service.attendanceSummary(organizationId, memberId);
      return { today: iso(r.today), daysThisMonth: r.daysThisMonth, daysLast28: r.daysLast28 };
    },
  });

  /** El comprobante de un pago SUYO (25-14). De otro socio, o de otro gimnasio: 404. Contrato: `PortalReceipt`. */
  route(app, {
    method: 'GET',
    url: '/portal/payments/:id/receipt',
    security: { kind: 'member' },
    schema: respuesta(200, PortalReceipt),
    handler: async (request): Promise<PortalReceipt> => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const { id } = idParam.parse(request.params);
      const r = await service.receipt(organizationId, memberId, id);
      return {
        gymName: r.gymName, branchName: r.branchName, memberName: r.memberName, memberCode: r.memberCode,
        folio: r.pago.folio, method: r.pago.method,
        amountCents: cents(r.pago.amountCents), unappliedCents: cents(r.pago.unappliedCents),
        businessDate: iso(r.pago.businessDate), receivedAt: r.pago.receivedAt.toISOString(),
        reversal: r.pago.reversesPaymentId !== null,
        lines: r.lines.map((l) => ({ concept: l.concept, amountCents: cents(l.amountCents) })),
        // El aviso del cambio de precio de su plan (D-19), el mismo del comprobante del mostrador.
        priceNotice: r.priceNotice && {
          kind: r.priceNotice.kind, planName: r.priceNotice.planName, fromPriceCents: cents(r.priceNotice.fromPriceCents), toPriceCents: cents(r.priceNotice.toPriceCents),
          // 4.20 (P-14): el día desde el que paga el aumento, si espera sus 15 días.
          startsOn: r.priceNotice.startsOn ? r.priceNotice.startsOn.toISOString().slice(0, 10) : null,
        },
        gym: r.gym,
      };
    },
  });

  // ── Fase 3, bloque 3.10 · D-35: qué puede renovar o comprar, a precio de lista ──

  /**
   * SOLO LECTURA. Los planes, paquetes, pases y clases sueltas que se venden
   * en su sede, a precio de lista, y lo que costaría renovar el suyo. No hay
   * ruta que compre desde el teléfono: eso llega con el cobro en línea (fase
   * 5) y mientras tanto se paga en recepción. Contrato: `PortalOffer`.
   */
  route(app, {
    method: 'GET',
    url: '/portal/offer',
    security: { kind: 'member' },
    schema: respuesta(200, PortalOffer),
    handler: async (request): Promise<PortalOffer> => {
      const { organizationId, memberId } = await requireMemberSession(request);
      return ofertaPara(organizationId, memberId);
    },
  });

  // ── Fase 3, bloque 3.10 · D-34: notificaciones gratis que el socio enciende y apaga ──
  const notificaciones = new PortalNotificationsService();
  const suscripcion = z.object({
    endpoint: z.string().url().max(2000),
    keys: z.object({ p256dh: z.string().min(10).max(500), auth: z.string().min(5).max(200) }),
  });

  /** Si este servidor notifica, en cuántos de sus teléfonos están encendidas y de qué temas. Contrato: `PortalNotifications`. */
  route(app, {
    method: 'GET',
    url: '/portal/notifications',
    security: { kind: 'member' },
    schema: respuesta(200, PortalNotifications),
    handler: async (request): Promise<PortalNotifications> => {
      const { organizationId, memberId } = await requireMemberSession(request);
      return notificaciones.estado(organizationId, memberId);
    },
  });

  /** Encender o apagar un tema (pagos, clases). Lo de seguridad y de acceso no se apaga. */
  route(app, {
    method: 'PUT',
    url: '/portal/notifications/preferences',
    security: { kind: 'member' },
    schema: respuesta(200, PortalNotifications),
    handler: async (request): Promise<PortalNotifications> => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const body = z.object({ payments: z.boolean().optional(), classes: z.boolean().optional() }).strict()
        .refine((b) => b.payments !== undefined || b.classes !== undefined, 'Di qué tema enciendes o apagas').parse(request.body);
      return notificaciones.guardarPreferencias(organizationId, memberId, {
        ...(body.payments !== undefined ? { payments: body.payments } : {}), ...(body.classes !== undefined ? { classes: body.classes } : {}),
      });
    },
  });

  /** Encender las notificaciones en ESTE teléfono: guarda la suscripción de su navegador, atada a su sesión. */
  route(app, {
    method: 'POST',
    url: '/portal/push-subscriptions',
    security: { kind: 'member' },
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: respuesta(201, PortalNotifications),
    handler: async (request, reply) => {
      const { organizationId, memberId, sessionId } = await requireMemberSession(request);
      const body = suscripcion.parse(request.body);
      const estado = await notificaciones.suscribir({
        organizationId, memberId, sessionId, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.status(201).send(estado);
    },
  });

  /** Apagarlas en ESTE teléfono. */
  route(app, {
    method: 'DELETE',
    url: '/portal/push-subscriptions',
    security: { kind: 'member' },
    schema: respuesta(200, PortalNotifications),
    handler: async (request): Promise<PortalNotifications> => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const { endpoint } = z.object({ endpoint: z.string().url().max(2000) }).parse(request.body);
      return notificaciones.desuscribir(organizationId, memberId, endpoint);
    },
  });

  // ── Fase 4, bloque 4.8 · D-36: el socio cambia su celular, su correo y su contacto de emergencia ──
  registerPortalContactRoutes(app);
}
