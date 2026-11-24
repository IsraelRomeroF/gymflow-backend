import {
  APPROVAL_HISTORY_WINDOW_MS, APPROVAL_REASK_LIMIT, APPROVAL_REQUEST_TTL_MS, DomainError, canApprove, conflict, forbidden, formatMoney, isAllowed, money, notFound, validation,
  type ApprovalDelivery, type PermissionKey,
} from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { systemContext } from '../../platform/jobs/types.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { DemasiadosIntentos } from '../../platform/http/rate-limit.js';
import { cifrarSensible, descifrarSensible } from '../../platform/sensitive.js';
import type { RequestContext } from '../../platform/context.js';
import { ApprovalService, comoApoderado, type Apoderado, type Operacion } from './approval.service.js';
import { ApprovalProxyRepository } from './approval-proxy.repository.js';
import { AuthUserRepository, PushService, UserRepository, type AuthService } from '../identity/index.js';
import { ApprovalGrantRepository, ApprovalReachRepository, ApprovalRequestRepository, type RechazoPrevio, type Solicitud } from './approval.repository.js';

export type { Solicitud };

/** El «no» anterior de la misma operación, con el nombre de quien lo dio (D-03). */
export type RechazoAnterior = { requestId: string; at: Date; byUserId: string | null; byName: string | null; reason: string | null };
/** La pregunta de quien firma y lo que se le contestó (D-03). */
export type Pregunta = { text: string; at: Date; byUserId: string | null; byName: string | null; answer: string | null; answeredAt: Date | null };
/** Lo que D-03 le agrega a una solicitud al mostrarla. */
export type ConHistoria = { previousRejection: RechazoAnterior | null; question: Pregunta | null; attempt: number };
export type SolicitudConHistoria = Omit<Solicitud, 'question'> & ConHistoria;

/**
 * Lo que ve quien pidió la firma. `delivery` y `secondsLeft` los calcula el
 * servidor: la firma se entrega mientras no se use (29-03) y la cuenta
 * regresiva no depende del reloj de la PC del mostrador (29-06).
 */
export type EstadoDeSolicitud = SolicitudConHistoria & {
  approvalToken: string | null;
  approverName: string | null;
  /** D-02: quien contestó lo hizo como apoderado de esta persona. */
  approverProxyOf: string | null;
  /** Solo en una aprobada: su firma sigue lista, ya se usó o venció sin usarse. */
  delivery: ApprovalDelivery | null;
  /** Lo que le queda a una pendiente, en segundos, según el reloj del servidor. */
  secondsLeft: number;
};

/** Una solicitud ya resuelta, como se lee en «Resueltas hoy» (20-05). */
export type SolicitudResuelta = SolicitudConHistoria & {
  requesterName: string | null; approverName: string | null; context: string | null;
  /** D-02: quien contestó lo hizo como apoderado de esta persona. */
  approverProxyOf: string | null;
  mine: boolean; resolvedAt: Date; delivery: ApprovalDelivery | null;
};

const minutos = (ms: number) => Math.round(ms / 60_000);
const importe = (s: Pick<Solicitud, 'amountCents'>) => s.amountCents?.toString() ?? null;

/**
 * AUTORIZACIÓN A DISTANCIA (UXB-04).
 *
 * Antes, quien autorizaba tenía que ir al mostrador y teclear su contraseña
 * en la PC de recepción. Ahora quien opera pide la firma; quien puede darla
 * la ve en su teléfono y la aprueba con SU contraseña, en SU sesión. La firma
 * resultante es la misma de siempre: un solo uso, atada a la operación y al
 * importe, cinco minutos.
 *
 * Desde la auditoría 8 (bloque 0.9): la solicitud siempre dice de qué
 * registro se trata (29-01), la firma aprobada se vuelve a entregar mientras
 * no se use (29-03), el servidor lleva la cuenta (29-06) y cancelar y vencer
 * también se asientan (29-04).
 */
export class RemoteApprovalService {
  private readonly firmas = new ApprovalService();
  private readonly audit = new AuditService();
  private readonly users = new AuthUserRepository();

  /**
   * Pedir la firma. D-03: si esa operación ya se rechazó en las últimas 24
   * horas, quien pide tiene que contestar ese «no» (`reply`) y la solicitud
   * queda ligada a él; y la misma operación no se pide más de 3 veces en una
   * hora (la 4.ª es un 429 que dice a qué hora se puede otra vez).
   */
  async request(ctx: RequestContext, input: Operacion & { permission: PermissionKey; summary: string; reason?: string | undefined; reply?: string | undefined }): Promise<SolicitudConHistoria> {
    const actor = ctx.tenant.actorUserId;
    if (!actor) throw new DomainError('UNAUTHENTICATED', 'Sesión requerida');
    const orgId = ctx.tenant.organizationId;
    // De qué se trata, siempre (29-01): el tipo se deduce del permiso si el
    // panel no lo mandó, y el registro tiene que existir en este gimnasio.
    const op = await this.firmas.revisarOperacion(orgId, input.permission, input, { exigirTipo: true });
    const solicitudes = new ApprovalRequestRepository(orgId);
    const deQue = await solicitudes.context([{ id: 'nueva', resourceType: op.resourceType ?? null, resourceId: op.resourceId ?? null }]);
    if (!deQue.has('nueva')) throw validation('No encontramos el registro de la operación que se quiere autorizar');
    // Que haya a quién pedírsela: si nadie puede firmar, se dice ahora.
    const { approvers } = await this.firmas.whoCanApprove(ctx, input.permission, op);
    if (approvers.length === 0) throw conflict('Nadie más puede autorizar esta operación');

    const operacion = await this.firmas.estadoDeLaOperacion(orgId, input.permission, op.resourceId!);
    if (operacion.proximaSolicitud) {
      const quienes = approvers.map((a) => a.fullName).join(' o ');
      // La solicitud no se crea, pero que se insistió queda en la bitácora (3.12): es lo que el
      // dueño quiere saber («me la pidieron una cuarta vez»). El asiento va sobre la operación.
      await this.audit.record(ctx, {
        action: 'approval.remote.over_limit', resourceType: 'ApprovalRequest', resourceId: null, branchId: op.branchId ?? null,
        ...(input.reason ? { reason: input.reason } : {}),
        afterState: {
          permission: input.permission, summary: input.summary, amountCents: op.amountCents?.toString() ?? null,
          resourceType: op.resourceType ?? null, resourceId: op.resourceId ?? null,
          attempt: operacion.pedidas + 1, nextRequestAt: operacion.proximaSolicitud.toISOString(),
        },
      });
      throw new DemasiadosIntentos(
        (operacion.proximaSolicitud.getTime() - Date.now()) / 1000,
        `Ya se pidió ${APPROVAL_REASK_LIMIT.max} veces en una hora: habla con ${quienes}. Se puede volver a pedir a las ${await this.firmas.horaLocal(orgId, op.branchId, operacion.proximaSolicitud)}.`,
      );
    }
    const rechazo = operacion.rechazo;
    const reply = input.reply?.trim() || null;
    if (rechazo && !reply) {
      throw new DomainError('CONFLICT',
        `${rechazo.approverName ?? 'Quien autoriza'} ya la rechazó a las ${await this.firmas.horaLocal(orgId, op.branchId, rechazo.decidedAt)}: para volver a pedirla, escríbele una respuesta`,
        rechazo.rejectReason ? `Su motivo: «${rechazo.rejectReason}»` : undefined, 'APPROVAL_REPLY_REQUIRED');
    }

    const s = await solicitudes.create({
      // La respuesta solo existe frente a un «no»: sin él, no se guarda.
      previousRequestId: rechazo?.id ?? null, reply: rechazo ? reply : null,
      requestedByUserId: actor, permission: input.permission,
      branchId: op.branchId ?? null, resourceType: op.resourceType ?? null, resourceId: op.resourceId ?? null,
      amountCents: op.amountCents ?? null, summary: input.summary, reason: input.reason ?? null,
      expiresAt: new Date(Date.now() + APPROVAL_REQUEST_TTL_MS),
    });
    await this.audit.record(ctx, {
      action: 'approval.remote.request', resourceType: 'ApprovalRequest', resourceId: s.id, branchId: s.branchId,
      // El motivo de quien pide también queda en el asiento (20-05), no solo en la tarjeta de quien firma.
      ...(s.reason ? { reason: s.reason } : {}),
      afterState: {
        permission: s.permission, summary: s.summary, amountCents: importe(s), resourceType: s.resourceType, resourceId: s.resourceId,
        // Aviso en la bitácora: el panel no dijo de qué se trataba y el servidor lo dedujo (29-01, fase 0).
        ...(op.resourceTypeInferred ? { resourceTypeInferred: true } : {}),
        // Se vuelve a pedir lo rechazado (D-03): a qué «no» responde, qué se contestó y qué vez es en la hora.
        ...(rechazo ? { previousRequestId: rechazo.id, reply: s.reply } : {}),
        attempt: operacion.pedidas + 1,
      },
    });
    const yaRechazada = rechazo ? `Ya la rechazaste a las ${await this.firmas.horaLocal(orgId, op.branchId, rechazo.decidedAt)}. Te responden: «${s.reply}». ` : '';
    // Al teléfono de quien puede firmar (DP-10). Si no llega, la solicitud sigue viva en la bandeja.
    // A cuántos teléfonos salió se anota en la solicitud (29-05): el mostrador
    // lee «le llegó el aviso» solo si de verdad salió. No se espera: pedir no
    // tarda lo que tarde el proveedor de avisos.
    void new PushService().sendToUsers(orgId, approvers.map((a) => a.userId), {
      title: rechazo ? 'Te vuelven a pedir lo que rechazaste' : 'Autorización pendiente',
      body: `${yaRechazada}${input.summary}${s.amountCents ? ` · ${formatMoney(money(s.amountCents))}` : ''}. Vence en ${minutos(APPROVAL_REQUEST_TTL_MS)} minutos.`,
      url: '/autorizaciones', tag: `approval-${s.id}`,
    }).then((n) => new ApprovalRequestRepository(orgId).markNotified(s.id, n)).catch(() => undefined);
    return {
      ...s, question: null, attempt: operacion.pedidas + 1,
      previousRejection: rechazo ? { requestId: rechazo.id, at: rechazo.decidedAt, byUserId: rechazo.approverUserId, byName: rechazo.approverName, reason: rechazo.rejectReason } : null,
    };
  }

  /**
   * Lo que ve quien la pidió. Aprobada, trae la firma MIENTRAS NO SE USE: si
   * se perdió la respuesta que la traía (red, sesión, reinicio), la siguiente
   * consulta la vuelve a traer. Ya usada o vencida, `delivery` lo dice y el
   * token deja de guardarse (29-03).
   */
  async status(ctx: RequestContext, id: string): Promise<EstadoDeSolicitud> {
    const orgId = ctx.tenant.organizationId;
    const s = await this.find(orgId, id);
    if (s.requestedByUserId !== ctx.tenant.actorUserId) throw notFound('Solicitud no encontrada');
    const { approvalToken, delivery } = s.status === 'APPROVED' ? await this.entrega(orgId, s) : { approvalToken: null, delivery: null };
    const approverName = s.approverUserId ? (await this.users.findById(s.approverUserId))?.fullName ?? null : null;
    const secondsLeft = s.status === 'PENDING' ? Math.max(0, Math.ceil((s.expiresAt.getTime() - Date.now()) / 1000)) : 0;
    const [conHistoria] = await this.conHistoria(orgId, [s]);
    const approverProxyOf = (await this.apoderadosDe(orgId, [s])).get(s.id) ?? null;
    return { ...conHistoria!, approvalToken, approverName, approverProxyOf, delivery, secondsLeft };
  }

  async cancel(ctx: RequestContext, id: string): Promise<void> {
    const s = await this.find(ctx.tenant.organizationId, id);
    if (s.requestedByUserId !== ctx.tenant.actorUserId) throw notFound('Solicitud no encontrada');
    const hecho = await new ApprovalRequestRepository(ctx.tenant.organizationId).decide(id, { status: 'CANCELED' });
    if (!hecho) throw conflict('La solicitud ya no estaba pendiente');
    // Cancelar también deja rastro (29-04): antes solo quedaba el «pidió».
    await this.audit.record(ctx, {
      action: 'approval.remote.cancel', resourceType: 'ApprovalRequest', resourceId: id, branchId: s.branchId,
      afterState: { permission: s.permission, summary: s.summary, amountCents: importe(s), resourceType: s.resourceType, resourceId: s.resourceId },
    });
  }

  /**
   * Las pendientes que ESTA persona puede firmar (y que no pidió ella).
   * `vistas`: la pantalla las está mostrando; se anota la primera vez (29-05).
   * El contador del marco consulta la misma bandeja sin mostrarlas y no cuenta.
   */
  async inbox(ctx: RequestContext, opts: { vistas?: boolean } = {}): Promise<Array<SolicitudConHistoria & { requesterName: string | null; context: string | null }>> {
    const orgId = ctx.tenant.organizationId;
    const yo = ctx.tenant.actorUserId!;
    // La bandeja se consulta seguido: aquí se cierran y se asientan las que
    // vencieron sin que nadie las volviera a leer (29-04).
    await this.vencerOlvidadas(orgId);
    const solicitudes = new ApprovalRequestRepository(orgId);
    const pendientes = await solicitudes.pendingNotRequestedBy(yo);
    // Con los permisos y topes de la SESIÓN, en memoria: antes se volvían a
    // leer de la base por cada solicitud (OPT3-02). El apoderado (D-02) mira
    // con la autoridad del dueño que lo nombró, y no ve lo que otra persona
    // ya rechazó: eso solo lo autoriza el dueño.
    const autoridad = pendientes.length > 0 ? await this.firmas.autoridadDeFirma(ctx.tenant) : null;
    const alcanza = autoridad ? pendientes.filter((s) => isAllowed(canApprove(autoridad.tenant, s.permission as PermissionKey, {
      organizationId: orgId, branchId: s.branchId ?? undefined, ...(s.amountCents !== null && s.permission !== 'billing:discount:apply' ? { amountCents: s.amountCents } : {}),
    }))) : [];
    const mias = autoridad?.apoderado
      ? (await Promise.all(alcanza.map(async (s) => (await this.firmas.puedeFirmar(orgId, yo, s.permission as PermissionKey, opDe(s)) ? s : null)))).filter((s): s is Solicitud => s !== null)
      : alcanza;
    const [nombres, contexto, historia] = await Promise.all([
      new UserRepository(orgId).namesById(mias.map((s) => s.requestedByUserId)),
      solicitudes.context(mias),
      this.conHistoria(orgId, mias),
    ]);
    const ahora = new Date();
    const nuevas = opts.vistas ? mias.filter((s) => !s.seenAt).map((s) => s.id) : [];
    await solicitudes.markSeen(nuevas, ahora);
    return historia.map((s) => ({
      ...s, seenAt: s.seenAt ?? (nuevas.includes(s.id) ? ahora : null),
      requesterName: nombres.get(s.requestedByUserId) ?? null, context: contexto.get(s.id) ?? null,
    }));
  }

  /**
   * «RESUELTAS HOY» (20-05): lo aprobado, rechazado, vencido y cancelado de
   * las últimas 24 horas. Quien da la segunda firma ve todo lo que podía
   * firmar, más lo que pidió; los demás, solo lo que pidieron. Antes una
   * solicitud resuelta desaparecía de la bandeja sin más.
   */
  async history(ctx: RequestContext): Promise<{ requests: SolicitudResuelta[]; scope: 'all' | 'mine'; windowHours: number }> {
    const orgId = ctx.tenant.organizationId;
    const yo = ctx.tenant.actorUserId!;
    // Lo vencido que nadie volvió a leer se cierra aquí también: si no, faltaría en la lista.
    await this.vencerOlvidadas(orgId);
    // Quien da la segunda firma, por su puesto o como apoderado vigente (D-02), ve lo que podía firmar.
    const autoridad = await this.firmas.autoridadDeFirma(ctx.tenant);
    const firma = autoridad !== null;
    const solicitudes = new ApprovalRequestRepository(orgId);
    const desde = new Date(Date.now() - APPROVAL_HISTORY_WINDOW_MS);
    const todas = await solicitudes.resolvedSince(desde, firma ? {} : { pedidasPor: yo });
    const visibles = todas.filter((s) => s.requestedByUserId === yo || isAllowed(canApprove(autoridad?.tenant ?? ctx.tenant, s.permission as PermissionKey, {
      organizationId: orgId, branchId: s.branchId ?? undefined, ...(s.amountCents !== null && s.permission !== 'billing:discount:apply' ? { amountCents: s.amountCents } : {}),
    })));
    const [nombres, contexto, historia, firmas, apoderados] = await Promise.all([
      new UserRepository(orgId).namesById(visibles.flatMap((s) => [s.requestedByUserId, ...(s.approverUserId ? [s.approverUserId] : [])])),
      solicitudes.context(visibles),
      // En «Resueltas hoy» no se dice «2.ª vez»: basta el «no» al que respondía y lo que se preguntó.
      this.conHistoria(orgId, visibles, { sinIntento: true }),
      new ApprovalReachRepository(orgId).grantStates(visibles.flatMap((s) => (s.status === 'APPROVED' && s.grantId ? [s.grantId] : []))),
      this.apoderadosDe(orgId, visibles),
    ]);
    const ahora = new Date();
    const entrega = (s: Pick<Solicitud, 'status' | 'grantId'>): ApprovalDelivery | null => {
      if (s.status !== 'APPROVED' || !s.grantId) return null;
      const f = firmas.get(s.grantId);
      if (!f) return null;
      return f.usedAt ? 'used' : f.expiresAt > ahora ? 'ready' : 'expired';
    };
    return {
      scope: firma ? 'all' : 'mine',
      windowHours: Math.round(APPROVAL_HISTORY_WINDOW_MS / 3_600_000),
      requests: historia.map((s) => ({
        ...s, mine: s.requestedByUserId === yo, resolvedAt: s.decidedAt ?? s.expiresAt, delivery: entrega(s),
        requesterName: nombres.get(s.requestedByUserId) ?? null,
        approverName: s.approverUserId ? nombres.get(s.approverUserId) ?? null : null,
        approverProxyOf: apoderados.get(s.id) ?? null,
        context: contexto.get(s.id) ?? null,
      })),
    };
  }

  /**
   * Aprobar desde el propio teléfono: la sesión dice QUIÉN es; la contraseña
   * dice que está ahí en este momento. Equivocarse cuenta en la escalera de
   * SUS firmas, no en su inicio de sesión (24-11).
   */
  async approve(ctx: RequestContext, _auth: AuthService, id: string, input: { password: string }): Promise<void> {
    const orgId = ctx.tenant.organizationId;
    const yo = ctx.tenant.actorUserId!;
    const s = await this.find(orgId, id);
    if (s.status !== 'PENDING') throw conflict('La solicitud ya no está pendiente');
    if (s.expiresAt < new Date()) throw conflict('La solicitud venció: que la vuelvan a pedir');
    if (s.requestedByUserId === yo) throw forbidden('Nadie se autoriza a sí mismo: tiene que ser otra persona');

    const perfil = await this.users.findById(yo);
    if (!perfil || !perfil.isActive) throw new DomainError('UNAUTHENTICATED', 'Sesión requerida');
    await this.firmas.comprobarContrasena(ctx, perfil, input.password, opDe(s), {
      canal: 'telefono',
      // En su propio teléfono, intentar durante la pausa no es un hallazgo: solo se asienta la contraseña equivocada.
      asentarFallo: async (f) => {
        if (f.causa !== 'CONTRASENA') return;
        await this.audit.record(ctx, {
          action: 'approval.remote.fail', resourceType: 'ApprovalRequest', resourceId: id, branchId: s.branchId,
          afterState: {
            permission: s.permission, amountCents: importe(s), failedCount: f.failedCount ?? null,
            ...(f.step && f.step !== 'none' ? { step: f.step } : {}), ...(f.pausedUntil ? { pausedUntil: f.pausedUntil.toISOString() } : {}),
          },
        });
      },
    });
    this.firmas.requireFirmaVigente(perfil);
    // Por su puesto o como apoderado (D-02). Un apoderado que quiere autorizar
    // lo que otra persona rechazó no pasa, y el intento queda en «Para revisar».
    let apoderado: Apoderado | null;
    try {
      apoderado = await this.firmas.firmaComo(orgId, yo, s.permission as PermissionKey, opDe(s));
    } catch (e) {
      if (!(e instanceof DomainError) || e.reason !== 'APPROVAL_PROXY_BLOCKED_BY_REJECTION') {
        throw forbidden('No tienes permiso o tope suficiente para autorizar esta operación');
      }
      await this.audit.record(ctx, {
        action: 'approval.proxy.blocked', resourceType: 'ApprovalRequest', resourceId: id, branchId: s.branchId,
        afterState: { permission: s.permission, summary: s.summary, amountCents: importe(s), resourceType: s.resourceType, resourceId: s.resourceId, previousRequestId: s.previousRequestId },
      });
      throw e;
    }

    // Firma y decisión en UNA unidad: si otra aprobación ganó la solicitud en
    // este instante, la firma de esta se deshace y no queda huérfana (1.17b).
    await enUnaTransaccion(async () => {
      const { token, grantId } = await this.firmas.crearFirma(orgId, yo, s.requestedByUserId, s.permission as PermissionKey, opDe(s), apoderado);
      const hecho = await new ApprovalRequestRepository(orgId).decide(id, { status: 'APPROVED', approverUserId: yo, deliveryToken: cifrarSensible(token), grantId, proxyId: apoderado?.proxyId ?? null });
      if (!hecho) throw conflict('Otra persona ya contestó esta solicitud');
    });
    await this.audit.record(ctx, {
      action: 'approval.remote.approve', resourceType: 'ApprovalRequest', resourceId: id, branchId: s.branchId,
      afterState: { permission: s.permission, summary: s.summary, amountCents: importe(s), resourceType: s.resourceType, resourceId: s.resourceId, ...comoApoderado(apoderado) },
    });
  }

  async reject(ctx: RequestContext, id: string, reason: string): Promise<void> {
    const orgId = ctx.tenant.organizationId;
    const yo = ctx.tenant.actorUserId!;
    const s = await this.find(orgId, id);
    if (s.requestedByUserId === yo) throw forbidden('Para retirarla, cancélala desde donde la pediste');
    const apoderado = await this.firmaOEscondida(orgId, yo, s);
    const hecho = await new ApprovalRequestRepository(orgId).decide(id, { status: 'REJECTED', approverUserId: yo, rejectReason: reason, proxyId: apoderado?.proxyId ?? null });
    if (!hecho) throw conflict('La solicitud ya no está pendiente');
    // El «no autorizó» dice también cuánto (29-04).
    await this.audit.record(ctx, {
      action: 'approval.remote.reject', resourceType: 'ApprovalRequest', resourceId: id, branchId: s.branchId, reason,
      afterState: { permission: s.permission, summary: s.summary, amountCents: importe(s), resourceType: s.resourceType, resourceId: s.resourceId, ...comoApoderado(apoderado) },
    });
  }

  /**
   * «PREGUNTAR» EN VEZ DE RECHAZAR (D-03). Antes, para pedir un dato («¿de qué
   * socio?») había que decir que no y obligar a empezar de nuevo. Quien puede
   * firmarla pregunta; la solicitud sigue pendiente, con su reloj otra vez
   * completo, y quien la pidió contesta en una línea. Una pregunta a la vez.
   */
  async ask(ctx: RequestContext, id: string, question: string): Promise<void> {
    const orgId = ctx.tenant.organizationId;
    const yo = ctx.tenant.actorUserId!;
    const s = await this.find(orgId, id);
    if (s.requestedByUserId === yo) throw forbidden('La pregunta la hace quien autoriza');
    const apoderado = await this.firmaOEscondida(orgId, yo, s);
    if (s.status !== 'PENDING') throw conflict('La solicitud ya no está pendiente');
    if (s.question && !s.answer) throw conflict('Ya hay una pregunta esperando respuesta');
    const hecho = await new ApprovalRequestRepository(orgId).ask(id, { question, byUserId: yo, expiresAt: new Date(Date.now() + APPROVAL_REQUEST_TTL_MS) });
    if (!hecho) throw conflict('La solicitud ya no está pendiente');
    await this.audit.record(ctx, {
      action: 'approval.remote.ask', resourceType: 'ApprovalRequest', resourceId: id, branchId: s.branchId,
      afterState: { permission: s.permission, summary: s.summary, amountCents: importe(s), resourceType: s.resourceType, resourceId: s.resourceId, question, ...comoApoderado(apoderado) },
    });
    // A quien la pidió, por si dejó la pantalla: el diálogo y la franja también lo dicen.
    void new PushService().sendToUsers(orgId, [s.requestedByUserId], {
      title: 'Te preguntan antes de autorizar', body: `${s.summary}: «${question}»`, url: '/autorizaciones', tag: `approval-${s.id}`,
    }).catch(() => undefined);
  }

  /** Quien pidió contesta la pregunta de quien firma (D-03). */
  async answer(ctx: RequestContext, id: string, answer: string): Promise<void> {
    const orgId = ctx.tenant.organizationId;
    const s = await this.find(orgId, id);
    if (s.requestedByUserId !== ctx.tenant.actorUserId) throw notFound('Solicitud no encontrada');
    if (s.status !== 'PENDING') throw conflict('La solicitud ya no está pendiente');
    if (!s.question || s.answer) throw conflict('No hay ninguna pregunta por contestar');
    const hecho = await new ApprovalRequestRepository(orgId).answer(id, { answer, expiresAt: new Date(Date.now() + APPROVAL_REQUEST_TTL_MS) });
    if (!hecho) throw conflict('La solicitud ya no está pendiente');
    await this.audit.record(ctx, {
      action: 'approval.remote.answer', resourceType: 'ApprovalRequest', resourceId: id, branchId: s.branchId,
      afterState: { permission: s.permission, summary: s.summary, amountCents: importe(s), resourceType: s.resourceType, resourceId: s.resourceId, question: s.question, answer },
    });
    if (s.questionByUserId) {
      void new PushService().sendToUsers(orgId, [s.questionByUserId], {
        title: 'Te contestaron', body: `${s.summary}: «${answer}»`, url: '/autorizaciones', tag: `approval-${s.id}`,
      }).catch(() => undefined);
    }
  }

  /**
   * Lo que D-03 agrega al mostrar una solicitud: el «no» al que responde (con
   * el nombre de quien lo dio), la pregunta con su contestación y qué vez es
   * en la última hora.
   */
  private async conHistoria(orgId: string, sols: readonly Solicitud[], opts: { sinIntento?: boolean } = {}): Promise<SolicitudConHistoria[]> {
    if (sols.length === 0) return [];
    const solicitudes = new ApprovalRequestRepository(orgId);
    const rechazos = await solicitudes.rejectionsById(sols.flatMap((s) => (s.previousRequestId ? [s.previousRequestId] : [])));
    const [nombres, intentos] = await Promise.all([
      new UserRepository(orgId).namesById([
        ...[...rechazos.values()].flatMap((r: RechazoPrevio) => (r.approverUserId ? [r.approverUserId] : [])),
        ...sols.flatMap((s) => (s.questionByUserId ? [s.questionByUserId] : [])),
      ]),
      Promise.all(sols.map(async (s) => {
        if (opts.sinIntento || !s.resourceId) return 1;
        const { n } = await solicitudes.requestedSince(s.permission, s.resourceId, new Date(s.createdAt.getTime() - APPROVAL_REASK_LIMIT.perMs), s.createdAt);
        // Una ya autorizada no se cuenta a sí misma en esa consulta.
        return Math.max(1, s.status === 'APPROVED' ? n + 1 : n);
      })),
    ]);
    return sols.map((s, i) => {
      const r = s.previousRequestId ? rechazos.get(s.previousRequestId) : undefined;
      return {
        ...s, attempt: intentos[i]!,
        previousRejection: r ? { requestId: r.id, at: r.decidedAt, byUserId: r.approverUserId, byName: r.approverUserId ? nombres.get(r.approverUserId) ?? null : null, reason: r.rejectReason } : null,
        question: s.question && s.questionAt
          ? { text: s.question, at: s.questionAt, byUserId: s.questionByUserId, byName: s.questionByUserId ? nombres.get(s.questionByUserId) ?? null : null, answer: s.answer, answeredAt: s.answeredAt }
          : null,
      };
    });
  }

  /** Quien no puede firmarla no sabe que existe: 404. Si puede, con qué autoridad (D-02). */
  private async firmaOEscondida(orgId: string, yo: string, s: Solicitud): Promise<Apoderado | null> {
    try { return await this.firmas.firmaComo(orgId, yo, s.permission as PermissionKey, opDe(s)); } catch { throw notFound('Solicitud no encontrada'); }
  }

  /** De quién era apoderado quien contestó cada solicitud (D-02): su nombre, por id de solicitud. */
  private async apoderadosDe(orgId: string, sols: readonly Solicitud[]): Promise<Map<string, string>> {
    const conNombramiento = sols.filter((s) => s.proxyId);
    if (conNombramiento.length === 0) return new Map();
    const duenos = await new ApprovalProxyRepository(orgId).duenosDe(conNombramiento.map((s) => s.proxyId!));
    const nombres = await new UserRepository(orgId).namesById([...duenos.values()]);
    return new Map(conNombramiento.flatMap((s) => {
      const nombre = nombres.get(duenos.get(s.proxyId!) ?? '');
      return nombre ? [[s.id, nombre] as const] : [];
    }));
  }

  /** Cierra y asienta las que vencieron sin respuesta y nadie volvió a leer (29-04). */
  async vencerOlvidadas(orgId: string): Promise<number> {
    let n = 0;
    for (const s of await new ApprovalRequestRepository(orgId).pendingExpired()) {
      if (await this.asentarVencida(orgId, s)) n += 1;
    }
    return n;
  }

  private async find(orgId: string, id: string): Promise<Solicitud> {
    const solicitudes = new ApprovalRequestRepository(orgId);
    const s = await solicitudes.find(id);
    if (!s) throw notFound('Solicitud no encontrada');
    if (s.status === 'PENDING' && s.expiresAt < new Date()) {
      if (await this.asentarVencida(orgId, s)) return { ...s, status: 'EXPIRED' };
      // Alguien la contestó o la cerró en ese mismo instante: lo que diga la base.
      return (await solicitudes.find(id)) ?? s;
    }
    return s;
  }

  /**
   * La marca vencida y, si fue esta llamada la que la cerró, lo asienta como
   * acto del sistema: nadie la venció, se le acabó el tiempo. Una sola vez
   * aunque dos lecturas lleguen juntas.
   */
  private async asentarVencida(orgId: string, s: Solicitud): Promise<boolean> {
    if (!(await new ApprovalRequestRepository(orgId).decide(s.id, { status: 'EXPIRED' }))) return false;
    await this.audit.record(systemContext(orgId), {
      action: 'approval.remote.expire', resourceType: 'ApprovalRequest', resourceId: s.id, branchId: s.branchId,
      afterState: {
        permission: s.permission, summary: s.summary, amountCents: importe(s), resourceType: s.resourceType, resourceId: s.resourceId,
        requestedByUserId: s.requestedByUserId, expiresAt: s.expiresAt.toISOString(),
      },
    });
    return true;
  }

  /** La firma de una aprobada (29-03): lista mientras no se use ni venza. */
  private async entrega(orgId: string, s: Solicitud): Promise<{ approvalToken: string | null; delivery: ApprovalDelivery | null }> {
    const solicitudes = new ApprovalRequestRepository(orgId);
    if (!s.grantId) {
      // Aprobada antes de que la solicitud recordara su firma: una sola entrega, como entonces.
      return { approvalToken: descifrarSensible(await solicitudes.takeDeliveryToken(s.id)), delivery: null };
    }
    const firma = await new ApprovalGrantRepository(orgId).state(s.grantId);
    if (firma && !firma.usedAt && firma.expiresAt > new Date()) {
      const token = descifrarSensible(await solicitudes.peekDeliveryToken(s.id));
      if (token) return { approvalToken: token, delivery: 'ready' };
    }
    await solicitudes.clearDeliveryToken(s.id);
    return { approvalToken: null, delivery: firma?.usedAt ? 'used' : 'expired' };
  }
}

function opDe(s: Pick<Solicitud, 'branchId' | 'resourceType' | 'resourceId' | 'amountCents'>): Operacion {
  return {
    branchId: s.branchId, resourceType: s.resourceType ?? undefined, resourceId: s.resourceId ?? undefined,
    amountCents: s.amountCents ?? undefined,
  };
}
