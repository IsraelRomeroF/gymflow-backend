import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { z, ZodError } from 'zod';
import { DomainError } from '@gymflow/core';
import { generateOpaqueToken, hashToken } from '../../platform/crypto.js';
import { ErrorConMotivo } from '../../platform/http/sesion.js';
import { AuthUserRepository } from './user.repository.js';
import { GrantRepository, mergeLimits } from './role.repository.js';
import {
  OWNER_PHONE_IDLE_DAYS, OWNER_PHONE_MAX_DAYS, RENOVAR_CADA_MS, STAFF_MAX_SESSION_HOURS, SessionRepository,
  duracionInicial, finDe, seRenueva, topeDe, type LugarDeSesion, type SesionViva, type TopesDeSesion,
} from './session.repository.js';
import { finDeSesion, motivoDeRevocacion, textoDeFin, type FinDeSesion } from './fin-de-sesion.js';
import { equipoDe, esTelefono } from './equipo.js';
import { KnownDeviceRepository } from './known-device.repository.js';
import { moduleViewOf } from '../../platform/modules/module-state.js';
import type { Env } from '../../platform/env.js';

const LOCK_THRESHOLD = 5;
/** Lo más que una petición espera a que se anote el último uso de su sesión (bloque 4.16). */
const ESPERA_DE_ULTIMO_USO_MS = 1_000;

/** Parámetros de Argon2id. */
const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/** Una sola regla de longitud para todos (24-10): personal, dueños y plataforma. */
export const PASSWORD_MIN = 12;

/** Días que vale una contraseña temporal para elegir la propia (A4-N1). */
export const TEMPORAL_DIAS = 7;

/**
 * Minutos tras entrar con la temporal en los que se elige la propia SIN volver
 * a escribirla (24-10): se acaba de teclear. Pasado ese rato se vuelve a
 * entrar; así una sesión temporal olvidada abierta no le sirve a otra persona.
 */
export const CAMBIO_SIN_ACTUAL_MIN = 15;

const reglaNueva = z.string().min(PASSWORD_MIN, `Mínimo ${PASSWORD_MIN} caracteres`).max(200, 'Máximo 200 caracteres');

const TEMPORAL_VENCIDA = `Tu contraseña temporal venció: dura ${TEMPORAL_DIAS} días. Pide una nueva a quien te la dio.`;

/**
 * Con la contraseña temporal, la sesión del personal solo sirve para esto
 * (A4-N1): saber quién es, elegir la propia y salir. En cualquier otra ruta
 * se comporta como si no hubiera sesión. La plataforma lo marca en sus rutas
 * con `temporal: true` (`platform/http/registry.ts`).
 */
const RUTAS_CON_TEMPORAL: ReadonlySet<string> = new Set([
  'GET /auth/me', 'POST /auth/password', 'POST /auth/logout', 'POST /auth/logout-all',
]);

export function sirveConTemporal(method: string, url: string | undefined): boolean {
  return !!url && RUTAS_CON_TEMPORAL.has(`${method} ${url}`);
}

/**
 * ¿Venció la contraseña temporal? Cuenta desde que se dio; si no se anotó
 * (una cuenta de plataforma creada por guion), desde el alta de la cuenta.
 */
export function temporalVencida(
  u: { mustChangePassword: boolean; passwordResetAt: Date | null; createdAt?: Date | undefined },
  ahora = Date.now(),
): boolean {
  if (!u.mustChangePassword) return false;
  const desde = u.passwordResetAt ?? u.createdAt ?? null;
  return !!desde && ahora - desde.getTime() > TEMPORAL_DIAS * 86_400_000;
}

/** Un error de UN campo, con la forma de los de validación: el panel lo pone debajo de ese campo. */
function errorDeCampo(campo: string, mensaje: string): ZodError {
  return new ZodError([{ code: 'custom', path: [campo], message: mensaje, input: undefined }]);
}

type Resuelta = NonNullable<Awaited<ReturnType<SessionRepository['resolveByTokenHash']>>>;

/** Resultado de resolver una cookie: la sesión, o por qué ya no sirve (24-06). */
export type Resolucion =
  | {
    ok: true; session: Resuelta['session']; user: Resuelta['user']; grants: Resuelta['grants']; roleKeys: string[]; limits: ReturnType<typeof mergeLimits> | null;
    /** La sesión se renovó en ESTA petición (D-04): hasta cuándo vale ahora; quien responde vuelve a poner la cookie con esa fecha. */
    renovadaHasta?: Date;
  }
  | { ok: false; fin: FinDeSesion };

/** Una sesión viva, como la ven «Mis sesiones» y Seguridad de la plataforma (24-05, 24-14). */
export type SesionDeLaLista = {
  id: string; ip: string | null; createdAt: Date; lastSeenAt: Date; expiresAt: Date;
  /** El equipo en palabras de la persona («iPhone · Safari»), o null si el navegador no lo dice. */
  deviceLabel: string | null; device: string | null;
  /** A qué hora se cierra aunque se siga usando (el tope desde que se entró); si se renueva, cuándo se cerraría sin más uso. */
  endsAt: Date;
  /** De qué lugar es (D-04) y si se renueva con el uso (solo el teléfono de la dueña). */
  kind: LugarDeSesion; renews: boolean;
  /** Plataforma: a qué hora se cierra si nadie la usa antes. */
  idleEndsAt: Date | null;
};

export type LoginResult = {
  status: 'AUTHENTICATED'; token: string; expiresAt: Date; userId: string; organizationId: string | null;
  /** Entró con una contraseña temporal: solo le sirve para elegir la suya. */
  mustChangePassword: boolean;
  /** La llave de ESTE equipo, para su cookie: con ella se le reconoce la próxima vez (D-01). */
  deviceKey: string;
};

export class AuthService {
  private readonly users = new AuthUserRepository();
  private readonly sessions = new SessionRepository();
  private readonly equipos = new KnownDeviceRepository();

  constructor(private readonly env: Env) {}

  hashPassword(plain: string): Promise<string> {
    return argonHash(plain, ARGON_OPTS);
  }

  /**
   * Cuánto dura cada sesión desde que se entra, por mucho que se use (24-04):
   * `SESSION_TTL_STAFF_HOURS` el personal y `PLATFORM_SESSION_HOURS` la
   * plataforma (la de mayor rango dura menos), nunca más que el techo de
   * `STAFF_MAX_SESSION_HOURS`. Es lo mismo que dura la cookie: las horas no
   * cambian, ahora el servidor dice y cumple exactamente eso.
   */
  topes(): TopesDeSesion {
    const techo = STAFF_MAX_SESSION_HOURS * 3600_000;
    return {
      personalMs: Math.min(this.env.SESSION_TTL_STAFF_HOURS * 3600_000, techo),
      plataformaMs: Math.min(this.env.PLATFORM_SESSION_HOURS * 3600_000, techo),
      // D-04: el teléfono de la dueña. No pasa por el techo de 16 h: es el único lugar con sesión larga.
      telefonoMs: OWNER_PHONE_IDLE_DAYS * 86_400_000,
      telefonoMaxMs: OWNER_PHONE_MAX_DAYS * 86_400_000,
    };
  }

  /**
   * DE QUÉ LUGAR ES LA SESIÓN QUE SE ABRE (D-04, opción a). Se decide aquí,
   * una vez, con la contraseña correcta recién tecleada.
   *
   * Es el TELÉFONO DE LA DUEÑA solo si se cumplen las tres cosas:
   *  1. la cuenta es de un gimnasio y su puesto es dueña (OWNER);
   *  2. el navegador es un teléfono (iPhone o Android de bolsillo; una
   *     tableta o una computadora, no);
   *  3. no entró con una contraseña temporal (esa sesión solo sirve para
   *     elegir la propia).
   * Todo lo demás es MOSTRADOR, la sesión corta: recepción, gerencia y coach
   * en cualquier equipo (también en su teléfono), la dueña en la computadora
   * del gimnasio, y cualquier caso dudoso (sin navegador, navegador raro).
   *
   * El navegador puede mentir sobre lo que es, pero no abre ningún hueco: sin
   * la cuenta de la dueña y su contraseña no hay sesión larga, y con ellas ya
   * se tiene lo mismo que en su teléfono.
   */
  lugarDe(user: { organizationId: string | null; mustChangePassword: boolean }, roleKeys: readonly string[], userAgent: string | undefined): LugarDeSesion {
    if (!user.organizationId || user.mustChangePassword) return 'COUNTER';
    return roleKeys.includes('OWNER') && esTelefono(userAgent) ? 'OWNER_PHONE' : 'COUNTER';
  }

  /** Inactividad de la consola de plataforma: sin uso, se cierra. */
  private inactividadPlataformaMs(): number {
    return this.env.PLATFORM_IDLE_MINUTES * 60_000;
  }

  async login(
    email: string,
    password: string,
    /**
     * `anterior`: la cookie que ya traía este navegador; esa sesión se queda sin cookie y se cierra.
     * `equipo`: la llave de equipo conocido que trae este navegador, si ya entró antes (D-01).
     */
    meta: { ip?: string | undefined; userAgent?: string | undefined; anterior?: string | undefined; equipo?: string | undefined },
  ): Promise<LoginResult> {
    const user = await this.users.findByEmail(email);

    // Respuesta genérica y tiempo comparable existan o no las credenciales:
    // no se revela si un correo está registrado.
    if (!user) {
      await argonHash('credencial-inexistente', ARGON_OPTS).catch(() => undefined);
      throw new DomainError('UNAUTHENTICATED', 'El correo o la contraseña no coinciden');
    }
    if (!user.isActive) {
      throw new DomainError('UNAUTHENTICATED', 'El correo o la contraseña no coinciden');
    }

    const ok = await argonVerify(user.passwordHash, password).catch(() => false);

    /**
     * Cuenta bloqueada (SEC-12). Antes respondía "Cuenta bloqueada" solo si el
     * correo existía —enumeraba cuentas— y bastaban cinco intentos de
     * cualquiera para dejar fuera a la dueña media hora, una y otra vez.
     * Ahora la respuesta es la genérica, y quien tiene la contraseña correcta
     * entra si lo hace desde una IP en la que ya había entrado: el bloqueo
     * frena al que adivina, no al titular en su equipo de siempre.
     *
     * D-01 (fase 3): o desde un EQUIPO en el que ya había entrado. Con la
     * dirección fija la dueña entra desde su teléfono con datos, que cambia
     * de IP cada rato: por la IP nunca era «su equipo de siempre» y cualquiera
     * la dejaba fuera tecleando mal su contraseña. El límite es por persona.
     */
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const titular = ok && (
        (!!meta.ip && await this.sessions.knownIp(user.id, meta.ip))
        || (!!meta.equipo && await this.equipos.conocido(user.id, hashToken(meta.equipo)))
      );
      if (!titular) throw new DomainError('UNAUTHENTICATED', 'El correo o la contraseña no coinciden');
    }

    if (!ok) {
      await this.users.registerFailedLogin(user.id, LOCK_THRESHOLD);
      throw new DomainError('UNAUTHENTICATED', 'El correo o la contraseña no coinciden');
    }

    // La consola desde una red no permitida no abre sesión (24-13): antes
    // entraba, ponía la cookie y rebotaba al login sin decir por qué. Solo
    // se le dice a quien tecleó la contraseña correcta, y no cuenta como fallo.
    if (!user.organizationId && this.env.platformAllowedIps.length > 0 && !(meta.ip && this.env.platformAllowedIps.includes(meta.ip))) {
      throw new ErrorConMotivo('FORBIDDEN', textoDeFin('NETWORK_NOT_ALLOWED'), 'NETWORK_NOT_ALLOWED');
    }

    // La temporal vence a los siete días (A4-N1). Solo se le dice a quien
    // tecleó la correcta: a nadie más le confirma que la cuenta existe.
    if (temporalVencida(user)) throw new ErrorConMotivo('FORBIDDEN', TEMPORAL_VENCIDA, 'TEMPORARY_PASSWORD_EXPIRED');

    // La plataforma libera o suspende el servicio de cada marca (ADR-037):
    // fuera de ACTIVE nadie de la marca entra, con la razón clara.
    if (user.organizationId) {
      const servicio = (await moduleViewOf(user.organizationId)).serviceStatus;
      if (servicio !== 'ACTIVE') {
        const motivo = servicio === 'PENDING' ? 'SERVICE_PENDING' : 'SERVICE_SUSPENDED';
        throw new ErrorConMotivo('FORBIDDEN', textoDeFin(motivo), motivo);
      }
    }
    await this.users.registerSuccessfulLogin(user.id);

    // Sin verificación en dos pasos (decisión del dueño, 2026-10-09; ver la
    // nota en ADR-008): la sesión nace completa con la contraseña correcta.
    // `mfaSatisfied` se sigue escribiendo porque la columna nace en falso y la
    // resolución de la sesión todavía la mira.
    const token = generateOpaqueToken();
    // D-04: mostrador (12 h fijas) o teléfono de la dueña (30 días que se renuevan con el uso).
    const kind = this.lugarDe(user, user.organizationId ? await new GrantRepository().roleKeysForUser(user.id) : [], meta.userAgent);
    const session = await this.sessions.create({
      userId: user.id,
      organizationId: user.organizationId,
      tokenHash: hashToken(token),
      kind,
      // El vencimiento ES el tope: la cookie dura eso y no se vuelve a poner (24-04).
      // En el teléfono de la dueña es lo que aguanta sin uso, y se corre al usarla (`resolveSession`).
      ttlMs: duracionInicial(this.topes(), user.organizationId, kind),
      mfaSatisfied: true,
      ip: meta.ip,
      userAgent: meta.userAgent,
      // De qué equipo es, para reconocerlo en «Mis sesiones» (24-05).
      deviceLabel: equipoDe(meta.userAgent) ?? undefined,
    });
    if (meta.anterior) await this.sessions.revokeByTokenHash(hashToken(meta.anterior), 'replaced');
    // Este equipo queda como conocido de esta cuenta (D-01): la llave que ya traía, o una nueva.
    const deviceKey = meta.equipo && /^[A-Za-z0-9_-]{20,200}$/.test(meta.equipo) ? meta.equipo : generateOpaqueToken();
    await this.equipos.anotar(user.id, hashToken(deviceKey), equipoDe(meta.userAgent) ?? null).catch(() => undefined);

    return {
      status: 'AUTHENTICATED',
      token,
      expiresAt: session.expiresAt,
      userId: user.id,
      organizationId: user.organizationId,
      mustChangePassword: user.mustChangePassword,
      deviceKey,
    };
  }

  /**
   * Comprueba las credenciales de un TERCERO sin abrirle sesión: es lo que
   * pide una aprobación maker-checker. Mismas reglas que el login: bloqueo
   * tras intentos fallidos y respuesta genérica.
   */
  async verifyCredentials(email: string, password: string) {
    const user = await this.users.findByEmail(email);
    if (!user) {
      await argonHash('credencial-inexistente', ARGON_OPTS).catch(() => undefined);
      throw new DomainError('UNAUTHENTICATED', 'Credenciales del autorizador inválidas');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new DomainError('UNAUTHENTICATED', 'Credenciales del autorizador inválidas');
    }
    if (!user.isActive) throw new DomainError('UNAUTHENTICATED', 'Credenciales del autorizador inválidas');

    const ok = await argonVerify(user.passwordHash, password).catch(() => false);
    if (!ok) {
      await this.users.registerFailedLogin(user.id, LOCK_THRESHOLD);
      throw new DomainError('UNAUTHENTICATED', 'Credenciales del autorizador inválidas');
    }
    return {
      id: user.id, organizationId: user.organizationId,
      mustChangePassword: user.mustChangePassword, passwordResetAt: user.passwordResetAt, passwordResetByUserId: user.passwordResetByUserId,
    };
  }

  /**
   * La sesión de una cookie, o POR QUÉ ya no sirve (24-06): cerrada (y por
   * quién), vencida, sin uso, la cuenta dada de baja… El motivo viaja en el
   * 401 y el panel lo convierte en el aviso del login.
   */
  async resolveSession(token: string, meta: { userAgent?: string | undefined } = {}): Promise<Resolucion> {
    // UNA consulta por petición: sesión, usuario, permisos y topes (OPT3-03).
    // El último uso se anota como mucho una vez por minuto.
    const tokenHash = hashToken(token);
    const r = await this.sessions.resolveByTokenHash(tokenHash, this.topes());
    // Solo cuando la cookie ya no sirve se pregunta por qué: es el camino raro.
    if (!r) return { ok: false, fin: await this.porQueTermino(tokenHash) };
    if (!r.user.isActive) return { ok: false, fin: finDeSesion('ACCOUNT_DEACTIVATED') };
    // La temporal que venció ya no sostiene la sesión que abrió (A4-N1).
    if (temporalVencida(r.user)) {
      await this.sessions.revoke(r.session.id, 'temporal_vencida');
      return { ok: false, fin: finDeSesion('TEMPORARY_PASSWORD_EXPIRED', TEMPORAL_VENCIDA) };
    }
    // Plataforma: sin uso por más de PLATFORM_IDLE_MINUTES, la sesión se cierra.
    if (!r.user.organizationId && Date.now() - r.session.lastSeenAt.getTime() > this.inactividadPlataformaMs()) {
      await this.sessions.revoke(r.session.id, 'idle');
      return { ok: false, fin: finDeSesion('SESSION_IDLE') };
    }
    let renovadaHasta: Date | undefined;
    if (seRenueva(r.session)) {
      const topes = this.topes();
      const ahora = Date.now();
      if (!r.roleKeys.includes('OWNER')) {
        // Ya no es la dueña (lo normal es que el cambio de puesto le haya cerrado las sesiones; esto es
        // por si no): su sesión larga vale lo que una de mostrador, y pasado ese tiempo se cierra.
        if (r.session.createdAt.getTime() + topes.personalMs <= ahora) {
          await this.sessions.revoke(r.session.id, 'role_changed');
          return { ok: false, fin: finDeSesion('ACCESS_CHANGED') };
        }
      } else if (esTelefono(meta.userAgent)) {
        // Se renueva con el uso, como mucho una vez por hora y nunca más allá de su tope desde que entró.
        // Solo desde un teléfono: una cookie copiada a una computadora no la alarga.
        const hasta = new Date(Math.min(ahora + topes.telefonoMs, r.session.createdAt.getTime() + topes.telefonoMaxMs));
        if (hasta.getTime() - r.session.expiresAt.getTime() > RENOVAR_CADA_MS && await this.sessions.renovar(r.session.id, hasta)) {
          r.session.expiresAt = hasta;
          renovadaHasta = hasta;
        }
      }
    }
    // El último uso se espera solo un rato (bloque 4.16): si la base tarda en confirmar (disco ocupado),
    // la petición sigue sin él; `touch` no falla y termina por su cuenta.
    if (!renovadaHasta && Date.now() - r.session.lastSeenAt.getTime() > 60_000) {
      await Promise.race([this.sessions.touch(r.session.id), new Promise<void>((res) => setTimeout(res, ESPERA_DE_ULTIMO_USO_MS).unref())]);
    }
    return {
      ok: true, session: r.session, user: r.user, grants: r.grants, roleKeys: r.roleKeys, limits: r.session.organizationId ? mergeLimits(r.limitRows) : null,
      ...(renovadaHasta ? { renovadaHasta } : {}),
    };
  }

  /** La cookie no abrió nada: lo que quedó de su sesión dice por qué. */
  private async porQueTermino(tokenHash: string): Promise<FinDeSesion> {
    const s = await this.sessions.terminadaPorToken(tokenHash);
    // Nunca existió o ya se borró (a los 7 días): no hay nada que contar.
    if (!s) return finDeSesion('NO_SESSION');
    if (s.user.deletedAt || !s.user.isActive) return finDeSesion('ACCOUNT_DEACTIVATED');
    if (s.revokedAt) {
      const motivo = motivoDeRevocacion(s.revokedReason);
      return motivo === 'TEMPORARY_PASSWORD_EXPIRED' ? finDeSesion(motivo, TEMPORAL_VENCIDA) : finDeSesion(motivo);
    }
    const topes = this.topes();
    if (finDe(s, topes).getTime() <= Date.now()) {
      // El teléfono de la dueña (D-04): si no llegó a su tope desde que entró, se cerró por falta de uso.
      const sinUso = seRenueva(s) && s.createdAt.getTime() + topeDe(topes, s.organizationId, s.kind) > Date.now();
      return sinUso
        ? finDeSesion('SESSION_IDLE', `Pasaron ${OWNER_PHONE_IDLE_DAYS} días sin usar GymFlow en este teléfono y tu sesión se cerró. Vuelve a entrar.`)
        : finDeSesion('SESSION_EXPIRED');
    }
    return finDeSesion('SESSION_REVOKED');
  }

  /** Desde cuándo y hasta cuándo vale ESTA sesión, por mucho que se use (24-04). */
  async sesionActual(sessionId: string): Promise<{
    startedAt: Date; endsAt: Date;
    /** D-04: el lugar; si se renueva con el uso, cuántos días aguanta sin él; y el día en que se cierra aunque se use. */
    kind: LugarDeSesion; renews: boolean; idleDays: number | null; maxEndsAt: Date;
  } | null> {
    const s = await this.sessions.porId(sessionId);
    if (!s) return null;
    const topes = this.topes();
    const renews = seRenueva(s);
    const endsAt = finDe(s, topes);
    return {
      startedAt: s.createdAt, endsAt,
      kind: renews ? 'OWNER_PHONE' : 'COUNTER', renews, idleDays: renews ? OWNER_PHONE_IDLE_DAYS : null,
      // Sin renovación no hay dos fechas: se cierra cuando se cierra.
      maxEndsAt: renews ? new Date(s.createdAt.getTime() + topeDe(topes, s.organizationId, s.kind)) : endsAt,
    };
  }

  /**
   * Reconfirmación de plataforma: la contraseña de la cuenta eleva ESTA sesión
   * unos minutos para acciones críticas. Un fallo cuenta como intento fallido
   * de la cuenta, igual que en el login, y con la cuenta bloqueada la sesión
   * se cierra.
   */
  async stepUp(sessionId: string, userId: string, password: string): Promise<Date> {
    const user = await this.users.findById(userId);
    // Con la cuenta bloqueada la sesión se cierra: el 401 dice por qué y la consola lleva al login.
    if (!user || (user.lockedUntil && user.lockedUntil > new Date())) {
      await this.sessions.revoke(sessionId, 'locked');
      throw new ErrorConMotivo('UNAUTHENTICATED', 'Cuenta bloqueada temporalmente por intentos fallidos', 'ACCOUNT_LOCKED');
    }
    if (!(await argonVerify(user.passwordHash, password).catch(() => false))) {
      await this.users.registerFailedLogin(userId, LOCK_THRESHOLD);
      const tras = await this.users.findById(userId);
      if (tras?.lockedUntil && tras.lockedUntil > new Date()) {
        await this.sessions.revoke(sessionId, 'locked');
        throw new ErrorConMotivo('UNAUTHENTICATED', 'La contraseña no es correcta y tu cuenta se bloqueó por intentos fallidos. Espera unos minutos y vuelve a entrar.', 'ACCOUNT_LOCKED');
      }
      // Un error de teclear: la sesión sigue y el diálogo lo dice en su campo.
      throw new DomainError('UNAUTHENTICATED', 'La contraseña no es correcta');
    }
    const until = new Date(Date.now() + this.env.PLATFORM_STEP_UP_MINUTES * 60_000);
    await this.sessions.setStepUp(sessionId, until);
    return until;
  }

  logout(sessionId: string) {
    return this.sessions.revoke(sessionId, 'logout');
  }

  /**
   * Cambiar la propia contraseña, con la regla única de longitud. Sin
   * `current` solo en el cambio OBLIGATORIO (24-10): la temporal vigente y en
   * los minutos siguientes a entrar con ella, que es cuando se acaba de
   * teclear. Cierra las demás sesiones: si alguien más la conocía, queda fuera.
   */
  async changePassword(userId: string, current: string | undefined, next: string, keepSessionId: string | null | undefined): Promise<{ obligatorio: boolean }> {
    // Antes de tocar la base: una nueva demasiado corta no cuenta como intento.
    z.object({ next: reglaNueva }).parse({ next });
    const user = await this.users.findById(userId);
    if (!user) throw new DomainError('UNAUTHENTICATED', 'Sesión inválida');
    const obligatorio = current === undefined;
    if (obligatorio) {
      if (!user.mustChangePassword) throw errorDeCampo('current', 'Escribe tu contraseña actual');
      if (temporalVencida(user)) throw new ErrorConMotivo('FORBIDDEN', TEMPORAL_VENCIDA, 'TEMPORARY_PASSWORD_EXPIRED');
      if (!user.lastLoginAt || Date.now() - user.lastLoginAt.getTime() > CAMBIO_SIN_ACTUAL_MIN * 60_000) {
        throw new DomainError('FORBIDDEN', `Pasaron más de ${CAMBIO_SIN_ACTUAL_MIN} minutos desde que entraste: vuelve a entrar con tu contraseña temporal para elegir la tuya.`);
      }
      // La temporal no se queda como la de siempre: la conoce quien la dio.
      if (await argonVerify(user.passwordHash, next).catch(() => false)) throw errorDeCampo('next', 'Tiene que ser distinta de la temporal');
    } else {
      if (!(await argonVerify(user.passwordHash, current).catch(() => false))) {
        await this.users.registerFailedLogin(userId, LOCK_THRESHOLD);
        throw new DomainError('UNAUTHENTICATED', 'La contraseña actual no es correcta');
      }
      if (current === next) throw errorDeCampo('next', 'La nueva contraseña tiene que ser distinta');
    }
    await this.users.setOwnPassword(userId, await this.hashPassword(next));
    await this.sessions.revokeAllForUser(userId, 'password_changed', keepSessionId ?? undefined);
    return { obligatorio };
  }

  logoutOthers(userId: string, keepSessionId: string | null | undefined) {
    return this.sessions.revokeAllForUser(userId, 'logout_others', keepSessionId ?? undefined);
  }

  logoutEverywhere(userId: string) {
    return this.sessions.revokeAllForUser(userId, 'logout_all');
  }

  /**
   * Las sesiones VIVAS de la cuenta, con su equipo y a qué hora se cierran
   * (24-05, 24-14). Las que ya nadie puede usar no salen.
   */
  async listSessions(userId: string): Promise<SesionDeLaLista[]> {
    const topes = this.topes();
    const vivas = await this.sessions.listForUser(userId, { topes, inactividadPlataformaMs: this.inactividadPlataformaMs() });
    return vivas.map((s: SesionViva) => {
      const device = s.deviceLabel ?? equipoDe(s.userAgent);
      return {
        id: s.id, ip: s.ip, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt,
        deviceLabel: device, device,
        endsAt: finDe(s, topes),
        kind: seRenueva(s) ? 'OWNER_PHONE' : 'COUNTER', renews: seRenueva(s),
        idleEndsAt: s.organizationId ? null : new Date(s.lastSeenAt.getTime() + this.inactividadPlataformaMs()),
      };
    });
  }
}
