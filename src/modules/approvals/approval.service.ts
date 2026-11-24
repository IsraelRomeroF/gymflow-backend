import { verify as argonVerify } from '@node-rs/argon2';
import {
  APPROVAL_GRANT_TTL_MS, APPROVAL_REASK_LIMIT, APPROVAL_REJECTION_MEMORY_MS, APPROVAL_REQUEST_TTL_MS, APPROVAL_RESOURCE_OPTIONAL, DomainError,
  approvalFailureStep, approvalRejectLockUntil, approvalResourceTypesFor,
  canApprove, forbidden, isAllowed, isApprovalResourceType, monthOfMonthlyCloseResourceId, validation,
  type ApprovalFailureStep, type ApprovalReach, type ApprovalResourceType, type PermissionKey,
} from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { systemContext } from '../../platform/jobs/types.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { AuthUserRepository, GrantRepository, PushService, UserRepository, type AuthService } from '../identity/index.js';
import { ApprovalGrantRepository, ApprovalReachRepository, ApprovalRequestRepository, ApprovalSignerLockRepository, type RechazoPrevio } from './approval.repository.js';
import { generateOpaqueToken, hashToken } from '../../platform/crypto.js';
import type { RequestContext } from '../../platform/context.js';

/** Tras un restablecimiento hecho por otra persona, no firma durante un día (SEC2-08). */
const ESPERA_TRAS_RESET_MS = 24 * 3_600_000;

/** Lo que se autoriza: la operación concreta y su importe (SEC2-05). */
export type Operacion = {
  /** `undefined` al emitir = el diálogo no la conoce; se revisa al consumir. */
  branchId?: string | null | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  amountCents?: bigint | undefined;
};

/** La operación revisada: con el tipo de registro deducido del permiso si quien pide no lo dijo (29-01). */
export type OperacionRevisada = Omit<Operacion, 'resourceType'> & { resourceType?: ApprovalResourceType | undefined; resourceTypeInferred: boolean };

/** Por qué no se emitió una firma en el mostrador: queda en la bitácora (20-02). */
type CausaDeFallo = 'CONTRASENA' | 'EN_PAUSA' | 'DESCONOCIDO' | 'MISMA_PERSONA' | 'FIRMA_NO_VIGENTE' | 'SIN_AUTORIDAD';

/** Un fallo con la contraseña de quien firma, para asentarlo donde ocurrió (mostrador o teléfono). */
export type FalloDeFirma = { causa: 'CONTRASENA' | 'EN_PAUSA'; failedCount?: number; step?: ApprovalFailureStep; pausedUntil?: Date | null };

type Firmante = { id: string; fullName: string; passwordHash: string };

/**
 * CÓMO ESTÁ UNA OPERACIÓN (D-03): el «no» que sigue vigente, hasta cuándo no
 * se firma en el mostrador y cuántas veces se pidió en la última hora.
 */
export type EstadoDeOperacion = {
  rechazo: (RechazoPrevio & { approverName: string | null }) | null;
  /** Tras un «no»: hasta cuándo solo se firma desde la sesión de quien firma. */
  bloqueoLocalHasta: Date | null;
  pedidas: number;
  tope: number;
  /** Con el tope alcanzado: cuándo se puede volver a pedir. */
  proximaSolicitud: Date | null;
};

/** El registro del asiento: el de la operación si se conoce; si no, la firma misma. */
const recursoDelAsiento = (op: OperacionRevisada, grantId?: string) => (op.resourceType
  ? { resourceType: op.resourceType as string, resourceId: op.resourceId ?? null }
  : { resourceType: 'ApprovalGrant', resourceId: grantId ?? null });

/**
 * Autorización del SEGUNDO usuario en las operaciones maker-checker.
 *
 * Primero se comprobaba solo que el aprobador existiera; luego, que además
 * tuviera el permiso. Faltaba lo esencial: **que estuviera ahí**. Bastaba con
 * mandar el id del dueño —que aparece en cualquier corte— para retirar
 * efectivo o reembolsar, y la bitácora lo culpaba a él.
 *
 * Ahora el aprobador teclea SU contraseña en el mismo mostrador. Eso emite un
 * token de un solo uso atado al permiso, a quien lo pidió y a cinco minutos,
 * y la operación lo consume. Desde la auditoría 8 (bloque 0.9) cada firma
 * emitida y cada intento fallido quedan en la bitácora (20-02), y los fallos
 * llevan su propia escalera, aparte del inicio de sesión (24-11).
 */
export class ApprovalService {
  private readonly users = new AuthUserRepository();
  private readonly grants = new GrantRepository();
  private readonly audit = new AuditService();

  /**
   * El aprobador se identifica; devuelve el token que la operación consumirá.
   * Se identifica con su correo o, cuando el diálogo ya sabe quién es porque
   * salió en «Pueden autorizar», con su `approverUserId` (20-14): con fila en
   * el mostrador no se teclea el correo cada vez, y el correo de la dueña no
   * viaja a la PC de recepción. La contraseña se comprueba igual.
   */
  async issue(ctx: RequestContext, auth: AuthService, input: Operacion & {
    email?: string | undefined; approverUserId?: string | undefined; password: string;
    permission: PermissionKey;
  }): Promise<{ approvalToken: string; approverName: string; expiresAt: Date }> {
    const actor = ctx.tenant.actorUserId;
    if (!actor) throw new DomainError('UNAUTHENTICATED', 'Sesión requerida');
    const orgId = ctx.tenant.organizationId;
    const op = await this.revisarOperacion(orgId, input.permission, input, { exigirTipo: false });
    if (!input.email && !input.approverUserId) throw validation('Falta decir quién autoriza');
    // D-03: lo que se rechazó hace menos de 30 minutos no se firma en el
    // mostrador, ni con la contraseña correcta: solo quien firma, desde su
    // sesión. Va antes de comparar la contraseña: aquí no se prueba ninguna.
    await this.negarSiSeRechazoHacePoco(ctx, input.permission, op, input.email ? input.email.trim().toLowerCase().slice(0, 200) : `elegido:${input.approverUserId}`);
    // En el asiento del fallo: el correo tecleado o, si se eligió por nombre, a quién se eligió.
    const correo = input.email ? input.email.trim().toLowerCase().slice(0, 200) : `elegido:${input.approverUserId}`;
    const fallo = (causa: CausaDeFallo, firmante: string | null, extra: Omit<FalloDeFirma, 'causa'> = {}) =>
      this.asentarFalloLocal(ctx, input.permission, op, { correo, firmante, causa, ...extra });

    const aprobador = input.email ? await this.users.findByEmail(input.email) : await this.users.findById(input.approverUserId!);
    if (!aprobador || aprobador.organizationId !== orgId || !aprobador.isActive) {
      // De otro gimnasio, de baja o inexistente: misma respuesta y mismo tiempo
      // que una contraseña mala, sin confirmar que el correo exista y sin sumar
      // fallos a la cuenta de nadie.
      await auth.hashPassword('credencial-inexistente').catch(() => undefined);
      await fallo('DESCONOCIDO', null);
      throw new DomainError('UNAUTHENTICATED', 'Credenciales del autorizador inválidas');
    }
    await this.comprobarContrasena(ctx, aprobador, input.password, op, {
      canal: 'mostrador',
      asentarFallo: (f) => fallo(f.causa, aprobador.id, f),
    });
    if (aprobador.id === actor) {
      await fallo('MISMA_PERSONA', aprobador.id);
      throw forbidden('Nadie se autoriza a sí mismo: tiene que ser otra persona');
    }
    try { this.requireFirmaVigente(aprobador); } catch (e) { await fallo('FIRMA_NO_VIGENTE', aprobador.id); throw e; }
    try { await this.requireAuthority(orgId, aprobador.id, input.permission, op); } catch (e) { await fallo('SIN_AUTORIDAD', aprobador.id); throw e; }

    const { token, expiresAt, grantId } = await this.crearFirma(orgId, aprobador.id, actor, input.permission, op);
    // La firma presencial deja rastro (20-02): quién la pidió, quién firmó, qué y cuánto.
    await this.audit.record(ctx, {
      action: 'approval.local.issue', ...recursoDelAsiento(op, grantId), branchId: op.branchId ?? null, approvedByUserId: aprobador.id,
      afterState: {
        permission: input.permission, amountCents: op.amountCents?.toString() ?? null, resourceId: op.resourceId ?? null, grantId, expiresAt: expiresAt.toISOString(),
        ...(op.resourceTypeInferred ? { resourceTypeInferred: true } : {}),
      },
    });
    return { approvalToken: token, approverName: aprobador.fullName, expiresAt };
  }

  /**
   * La contraseña de quien firma, con SU escalera de fallos (24-11, D24-04):
   * no suma al contador del inicio de sesión, así que equivocarse con prisa
   * —o que alguien pruebe la contraseña de la dueña en el mostrador— ya no
   * deja a nadie fuera del panel. En pausa, ni siquiera se compara: así la
   * pausa sí frena a quien adivina.
   */
  async comprobarContrasena(ctx: RequestContext, firmante: Firmante, password: string, op: Pick<Operacion, 'branchId'>, opts: {
    canal: 'mostrador' | 'telefono';
    asentarFallo: (f: FalloDeFirma) => Promise<unknown>;
  }): Promise<void> {
    const orgId = ctx.tenant.organizationId;
    const candados = new ApprovalSignerLockRepository(orgId);
    const pausa = await candados.pausedUntil(firmante.id);
    if (pausa) {
      await opts.asentarFallo({ causa: 'EN_PAUSA', pausedUntil: pausa });
      const hora = await this.horaLocal(orgId, op.branchId, pausa);
      throw opts.canal === 'mostrador'
        ? new DomainError('RATE_LIMITED', `Las firmas de esa persona están en pausa hasta las ${hora} por intentos fallidos con su contraseña`,
          'Cuando termine la pausa puede firmar aquí o desde su teléfono.')
        : new DomainError('RATE_LIMITED', `Tus firmas están en pausa hasta las ${hora} por intentos fallidos con tu contraseña`,
          'Si no fuiste tú, cambia tu contraseña.');
    }
    if (await argonVerify(firmante.passwordHash, password).catch(() => false)) {
      await candados.clear(firmante.id);
      return;
    }
    const r = await candados.registerFailure(firmante.id);
    const step = approvalFailureStep(r.failedCount);
    await opts.asentarFallo({ causa: 'CONTRASENA', failedCount: r.failedCount, step, pausedUntil: r.pausedUntil });
    if (step !== 'none') await this.subirEscalon(ctx, firmante, step, r, op, opts.canal);
    const pausada = r.pausedUntil ? ` Demasiados intentos: ${opts.canal === 'mostrador' ? 'sus' : 'tus'} firmas quedan en pausa hasta las ${await this.horaLocal(orgId, op.branchId, r.pausedUntil)}.` : '';
    throw opts.canal === 'mostrador'
      ? new DomainError('UNAUTHENTICATED', 'Credenciales del autorizador inválidas', pausada.trim() || undefined)
      : new DomainError('UNAUTHENTICATED', `La contraseña no es correcta.${pausada}`);
  }

  /**
   * Una contraseña que puso otra persona no sirve para firmar hasta que se
   * cambie, ni durante las 24 h siguientes: así no se "fabrica" al segundo
   * firmante restableciéndole la clave (SEC2-08).
   */
  requireFirmaVigente(aprobador: { id: string; mustChangePassword: boolean; passwordResetAt: Date | null; passwordResetByUserId: string | null }): void {
    if (aprobador.mustChangePassword) throw forbidden('Quien autoriza tiene una contraseña temporal: primero debe cambiarla');
    if (aprobador.passwordResetAt && aprobador.passwordResetByUserId !== aprobador.id
      && Date.now() - aprobador.passwordResetAt.getTime() < ESPERA_TRAS_RESET_MS) {
      throw forbidden('A quien autoriza le restablecieron la contraseña hace menos de 24 horas: todavía no puede autorizar');
    }
  }

  /**
   * De QUÉ registro se trata (29-01). Si quien pide no lo dijo, se deduce
   * del permiso (la condonación, por el id: membresía o cargo) y el asiento
   * lo marca como deducido; si lo dijo y no corresponde a la operación, no
   * se acepta. A distancia (`exigirTipo`) es obligatorio: la dueña firma
   * viendo de qué socio o caja se trata, no solo lo que escribió quien pide.
   */
  async revisarOperacion(orgId: string, permission: string, op: Operacion, opts: { exigirTipo: boolean }): Promise<OperacionRevisada> {
    const posibles = approvalResourceTypesFor(permission);
    let tipo: ApprovalResourceType | undefined;
    let deducido = false;
    if (op.resourceType !== undefined) {
      if (!isApprovalResourceType(op.resourceType) || (posibles.length > 0 && !posibles.includes(op.resourceType))) {
        throw validation('La autorización no corresponde a esa operación', posibles.length ? `Para esta operación el registro es: ${posibles.join(' o ')}` : undefined);
      }
      tipo = op.resourceType;
    } else if (posibles.length === 1) {
      tipo = posibles[0]; deducido = true;
    } else if (posibles.length > 1 && op.resourceId) {
      const t = await new ApprovalRequestRepository(orgId).waiverResourceType(op.resourceId);
      if (t && posibles.includes(t)) { tipo = t; deducido = true; }
    }
    if (tipo === 'MonthlyClose' && op.resourceId && monthOfMonthlyCloseResourceId(op.resourceId) === null) {
      throw validation('La firma del cierre de mes va atada al mes que se cierra');
    }
    if (opts.exigirTipo) {
      if (posibles.length === 0) throw validation('Esa operación no lleva segunda firma');
      if (!tipo) throw validation('Falta decir de qué registro se trata la operación que se quiere autorizar');
      // A distancia siempre con registro: el cierre de mes, con el id de SU mes (20-01).
      if (!op.resourceId) {
        throw validation(tipo === 'MonthlyClose' ? 'La firma del cierre de mes va atada al mes que se cierra' : 'Falta decir qué registro se quiere autorizar');
      }
    }
    return { branchId: op.branchId, resourceId: op.resourceId, amountCents: op.amountCents, resourceType: tipo, resourceTypeInferred: deducido };
  }

  /**
   * El estado de una operación para D-03. El «no» deja de estar vigente si
   * después alguien la autorizó (a distancia o, pasados los 30 minutos, en el
   * mostrador): un «sí» posterior manda.
   */
  async estadoDeLaOperacion(orgId: string, permission: string, resourceId: string, ahora = new Date()): Promise<EstadoDeOperacion> {
    const solicitudes = new ApprovalRequestRepository(orgId);
    const [previo, pedidas] = await Promise.all([
      solicitudes.lastRejection(permission, resourceId, new Date(ahora.getTime() - APPROVAL_REJECTION_MEMORY_MS)),
      solicitudes.requestedSince(permission, resourceId, new Date(ahora.getTime() - APPROVAL_REASK_LIMIT.perMs)),
    ]);
    const vigente = previo && !(await new ApprovalGrantRepository(orgId).signedSince(permission, resourceId, previo.decidedAt)) ? previo : null;
    const rechazo = vigente
      ? { ...vigente, approverName: vigente.approverUserId ? (await this.users.findById(vigente.approverUserId))?.fullName ?? null : null }
      : null;
    return {
      rechazo,
      bloqueoLocalHasta: rechazo ? approvalRejectLockUntil(rechazo.decidedAt, ahora) : null,
      pedidas: pedidas.n, tope: APPROVAL_REASK_LIMIT.max,
      proximaSolicitud: pedidas.n >= APPROVAL_REASK_LIMIT.max && pedidas.primera ? new Date(pedidas.primera.getTime() + APPROVAL_REASK_LIMIT.perMs) : null,
    };
  }

  /** D-03: el intento de firmar en el mostrador lo recién rechazado se niega y queda en «Para revisar». */
  private async negarSiSeRechazoHacePoco(ctx: RequestContext, permission: string, op: OperacionRevisada, correo: string): Promise<void> {
    if (!op.resourceId) return;
    const orgId = ctx.tenant.organizationId;
    const { rechazo, bloqueoLocalHasta } = await this.estadoDeLaOperacion(orgId, permission, op.resourceId);
    if (!rechazo || !bloqueoLocalHasta) return;
    await this.audit.record(ctx, {
      action: 'approval.local.after_reject', ...recursoDelAsiento(op), branchId: op.branchId ?? null,
      afterState: {
        permission, amountCents: op.amountCents?.toString() ?? null, resourceId: op.resourceId, email: correo,
        rejectedRequestId: rechazo.id, rejectedAt: rechazo.decidedAt.toISOString(), rejectedByUserId: rechazo.approverUserId,
        lockedUntil: bloqueoLocalHasta.toISOString(),
      },
    });
    const quien = rechazo.approverName ?? 'Quien autoriza';
    const minutos = Math.max(1, Math.round((Date.now() - rechazo.decidedAt.getTime()) / 60_000));
    throw new DomainError('CONFLICT',
      `${quien} la rechazó hace ${minutos} min: hasta las ${await this.horaLocal(orgId, op.branchId, bloqueoLocalHasta)} no se firma aquí, solo desde su teléfono`,
      'Pídesela a su teléfono con tu respuesta a ese «no».', 'APPROVAL_REJECTED_RECENTLY');
  }

  /** Emite la firma de un solo uso, atada a la operación y al importe. */
  async crearFirma(organizationId: string, approverUserId: string, requestedByUserId: string, permission: PermissionKey, op: Operacion): Promise<{ token: string; expiresAt: Date; grantId: string }> {
    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + APPROVAL_GRANT_TTL_MS);
    const { id } = await new ApprovalGrantRepository(organizationId).create({
      approverUserId, requestedByUserId, permission,
      tokenHash: hashToken(token),
      branchId: op.branchId ?? null, resourceType: op.resourceType ?? null, resourceId: op.resourceId ?? null,
      amountCents: op.amountCents ?? null, expiresAt,
    });
    return { token, expiresAt, grantId: id };
  }

  /** ¿Puede esta persona firmar esta operación? Sin lanzar: para la bandeja. */
  async puedeFirmar(organizationId: string, userId: string, permission: PermissionKey, op: Operacion): Promise<boolean> {
    try { await this.requireAuthority(organizationId, userId, permission, op); return true; } catch { return false; }
  }

  /**
   * Consume el token y devuelve el id del aprobador. Sin token devuelve
   * null: la ruta decide si la operación lo necesita (según límites y rol).
   */
  async verify(
    ctx: RequestContext,
    approvalToken: string | null | undefined,
    permission: PermissionKey,
    scope: Partial<Operacion> & { percent?: number | undefined } = {},
    /** Se llama con el id de la firma cuando quedó consumida y vale: quien llama puede devolverla si la operación no se registra. */
    alConsumir?: (grantId: string) => void,
  ): Promise<string | null> {
    if (!approvalToken?.trim()) return null;
    const grant = await new ApprovalGrantRepository(ctx.tenant.organizationId)
      .consume(hashToken(approvalToken), ctx.tenant.actorUserId ?? '', permission);
    if (!grant) {
      throw validation('La autorización no es válida: expiró, ya se usó o es para otra operación. Pide que vuelvan a autorizar');
    }

    // La firma es para ESA operación y hasta ESE importe (SEC2-05). El cierre
    // de mes se ata al mes; la firma sin mes de un panel anterior aún vale (fase 0).
    const otra = 'La autorización es para otra operación. Pide que vuelvan a autorizar';
    if (grant.resourceId !== null && scope.resourceId !== undefined && grant.resourceId !== scope.resourceId) throw validation(otra);
    if (grant.resourceId === null && scope.resourceId !== undefined && !APPROVAL_RESOURCE_OPTIONAL.has(permission)) {
      throw validation('La autorización no dice para qué operación es. Pide que vuelvan a autorizar');
    }
    if (scope.amountCents !== undefined && (grant.amountCents === null || scope.amountCents > grant.amountCents)) {
      throw validation('El importe es mayor que el autorizado. Pide que vuelvan a autorizar');
    }
    if (grant.branchId !== null && scope.branchId && grant.branchId !== scope.branchId) throw validation(otra);

    // Se revalida al CONSUMIR: si le quitaron el permiso o lo desactivaron en
    // esos cinco minutos, la autorización ya no vale.
    const aprobador = await this.users.findById(grant.approverUserId);
    if (!aprobador || !aprobador.isActive) throw validation('El usuario que autoriza ya no está activo');
    await this.requireAuthority(ctx.tenant.organizationId, grant.approverUserId, permission, {
      branchId: scope.branchId, amountCents: scope.amountCents, percent: scope.percent,
    });
    alConsumir?.(grant.id);
    return grant.approverUserId;
  }

  /**
   * Quiénes podrían autorizar esta operación: para decirlo ANTES de llenar
   * el formulario, no al final (UXB-04). Con cada uno, si sus firmas están en
   * pausa por intentos fallidos (24-11), y cuánto valen la solicitud y la
   * firma: el diálogo no escribe los minutos a mano (29-09).
   */
  async whoCanApprove(ctx: RequestContext, permission: PermissionKey, op: Operacion): Promise<{
    approvers: Array<{ fullName: string; userId: string; pausedUntil: string | null; reach: ApprovalReach }>;
    requestTtlSeconds: number; grantTtlSeconds: number;
    /** D-03: el «no» vigente y el tope de esta operación; null si no se dijo de qué registro se trata. */
    operation: EstadoDeOperacion | null;
  }> {
    const orgId = ctx.tenant.organizationId;
    // Nadie se autoriza a sí mismo; firma quien tiene la segunda firma: el
    // dueño, desde su teléfono (decisión del 2026-10-05).
    const candidatos = await new UserRepository(orgId).activeExcept(ctx.tenant.actorUserId ?? '');
    const out: Array<{ fullName: string; userId: string }> = [];
    for (const u of candidatos) {
      if (await this.puedeFirmar(orgId, u.id, permission, op)) out.push({ fullName: u.fullName, userId: u.id });
    }
    const ids = out.map((a) => a.userId);
    // Cómo se va a enterar cada uno (29-05): aviso en su teléfono, panel abierto o ninguna de las dos.
    const [pausas, alcance, operation] = await Promise.all([
      new ApprovalSignerLockRepository(orgId).pausesFor(ids),
      new ApprovalReachRepository(orgId).reachOf(ids, new PushService().publicKey() !== null),
      op.resourceId ? this.estadoDeLaOperacion(orgId, permission, op.resourceId) : Promise.resolve(null),
    ]);
    return {
      approvers: out.map((a) => ({ ...a, pausedUntil: pausas.get(a.userId)?.toISOString() ?? null, reach: alcance.get(a.userId) ?? 'none' })),
      requestTtlSeconds: APPROVAL_REQUEST_TTL_MS / 1000,
      grantTtlSeconds: APPROVAL_GRANT_TTL_MS / 1000,
      operation,
    };
  }

  /** Tiene la segunda firma sobre ESA sucursal (SEC2-05, 2026-10-05). */
  private async requireAuthority(organizationId: string, userId: string, permission: PermissionKey, op: { branchId?: string | null | undefined; amountCents?: bigint | undefined; percent?: number | undefined }): Promise<void> {
    const [grants, limits] = await Promise.all([this.grants.grantsForUser(userId), this.grants.limitsForUser(userId, organizationId)]);
    // La segunda firma la da quien tiene `approvals:grant` (el dueño, 2026-10-05).
    if (!grants.some((g) => g.permission === 'approvals:grant')) throw forbidden('La segunda firma la da el dueño del gimnasio');
    const decision = canApprove(
      { organizationId, actorType: 'USER', actorUserId: userId, grants, limits, requestId: 'approval' },
      permission,
      // Sin sede (cargo de organización) basta el permiso en cualquier alcance,
      // como antes. El descuento se mide en PORCENTAJE: sin él (al emitir) no
      // hay tope que comparar; se revisa al consumir, cuando ya se conoce.
      {
        organizationId, branchId: op.branchId ?? undefined,
        ...(permission === 'billing:discount:apply'
          ? (op.percent === undefined ? {} : { percent: op.percent })
          : { amountCents: op.amountCents }),
      },
    );
    if (!isAllowed(decision)) {
      throw forbidden(decision.outcome === 'DENY' && decision.code === 'OUT_OF_BRANCH_SCOPE'
        ? 'Quien autoriza no tiene autoridad sobre esta sucursal'
        : decision.outcome === 'DENY' ? decision.detail : 'Quien autoriza no puede cubrir ese importe');
    }
  }

  /** Lo que no se firmó en el mostrador también queda (20-02): quién pedía, qué correo se tecleó y por qué no pasó. */
  private async asentarFalloLocal(ctx: RequestContext, permission: string, op: OperacionRevisada, f: {
    correo: string; firmante: string | null; causa: CausaDeFallo; failedCount?: number | undefined; step?: ApprovalFailureStep | undefined; pausedUntil?: Date | null | undefined;
  }): Promise<void> {
    await this.audit.record(ctx, {
      action: 'approval.local.fail', ...recursoDelAsiento(op), branchId: op.branchId ?? null,
      afterState: {
        permission, amountCents: op.amountCents?.toString() ?? null, resourceId: op.resourceId ?? null, cause: f.causa, email: f.correo, signerUserId: f.firmante,
        ...(f.failedCount !== undefined ? { failedCount: f.failedCount } : {}),
        ...(f.step && f.step !== 'none' ? { step: f.step } : {}),
        ...(f.pausedUntil ? { pausedUntil: f.pausedUntil.toISOString() } : {}),
        ...(op.resourceTypeInferred ? { resourceTypeInferred: true } : {}),
      },
    });
  }

  /**
   * Los escalones (24-11): al 3.er fallo se le avisa al firmante; al 5.º sus
   * firmas quedan en pausa, se asienta como acto del sistema y se avisa a
   * quienes dan la segunda firma. Un aviso que no llega no tumba nada.
   */
  private async subirEscalon(ctx: RequestContext, firmante: Firmante, step: Exclude<ApprovalFailureStep, 'none'>, r: { failedCount: number; pausedUntil: Date | null }, op: Pick<Operacion, 'branchId'>, canal: 'mostrador' | 'telefono'): Promise<void> {
    const orgId = ctx.tenant.organizationId;
    const push = new PushService();
    const tag = `approval-fails-${firmante.id}`;
    if (step === 'warn' || !r.pausedUntil) {
      void push.sendToUsers(orgId, [firmante.id], {
        title: 'Intentos fallidos con tu contraseña',
        body: canal === 'mostrador'
          ? `Alguien tecleó mal tu contraseña ${r.failedCount} veces al pedir una firma en el mostrador. Si no fuiste tú, cámbiala.`
          : `Tu contraseña no coincidió ${r.failedCount} veces al autorizar. Si no fuiste tú, cámbiala.`,
        url: '/bitacora', tag,
      }).catch(() => undefined);
      return;
    }
    const hasta = r.pausedUntil;
    const hora = await this.horaLocal(orgId, op.branchId, hasta);
    await this.audit.record(systemContext(orgId), {
      action: 'approval.pause', resourceType: 'User', resourceId: firmante.id, branchId: op.branchId ?? null,
      afterState: {
        signerName: firmante.fullName, failedCount: r.failedCount, pausedUntil: hasta.toISOString(), channel: canal,
        lastAttemptByUserId: ctx.tenant.actorUserId ?? null,
      },
    });
    void push.sendToUsers(orgId, [firmante.id], {
      title: 'Tus firmas quedaron en pausa',
      body: `Hubo ${r.failedCount} intentos fallidos con tu contraseña. Podrás volver a firmar a las ${hora}. Si no fuiste tú, cambia tu contraseña.`,
      url: '/bitacora', tag,
    }).catch(() => undefined);
    const otros = await this.firmantesDelGimnasio(orgId, firmante.id);
    if (otros.length > 0) {
      void push.sendToUsers(orgId, otros, {
        title: 'Firmas en pausa',
        body: `Las firmas de ${firmante.fullName} quedaron en pausa hasta las ${hora} por intentos fallidos con su contraseña.`,
        url: '/bitacora', tag,
      }).catch(() => undefined);
    }
  }

  /** Quienes dan la segunda firma en el gimnasio (la dueña), salvo esta persona. */
  private async firmantesDelGimnasio(orgId: string, salvo: string): Promise<string[]> {
    const out: string[] = [];
    for (const u of await new UserRepository(orgId).activeExcept(salvo)) {
      if ((await this.grants.grantsForUser(u.id)).some((g) => g.permission === 'approvals:grant')) out.push(u.id);
    }
    return out;
  }

  /** La hora en la zona de la sede (o del gimnasio), como la lee el mostrador. */
  async horaLocal(orgId: string, branchId: string | null | undefined, d: Date): Promise<string> {
    const zona = await new BusinessCalendar(orgId).timezoneFor(branchId ?? null);
    return d.toLocaleTimeString('es-MX', { timeZone: zona, hour: '2-digit', minute: '2-digit', hour12: false });
  }
}
