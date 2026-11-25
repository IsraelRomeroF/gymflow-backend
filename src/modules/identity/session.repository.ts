import { uuidv7, type Grant, lockedPermissions, applyOverrides, normalizeOverrides, ADJUSTABLE_ROLES } from '@gymflow/core';
import type { SessionKind } from '@gymflow/core/contracts';
import { GlobalRepository } from '../../platform/db/tenant-repository.js';
import type { LimitRow } from './role.repository.js';
import type { UserRecord } from './user.repository.js';


/** Horas máximas de cualquier sesión, por mucho que se use: el techo de los topes de cada tipo. */
export const STAFF_MAX_SESSION_HOURS = 16;

/**
 * SESIONES POR LUGAR (D-04, opción a; fase 4, bloque 4.1). `sessions.kind`:
 *
 * - `COUNTER`, el MOSTRADOR y, ante la duda, cualquier otro equipo: se cierra
 *   a las 12 horas de haber entrado, pase lo que pase. Es el valor por omisión.
 * - `OWNER_PHONE`, el TELÉFONO DE LA DUEÑA: dura 30 días que se renuevan con
 *   el uso (`OWNER_PHONE_IDLE_DAYS`) y nunca pasa de `OWNER_PHONE_MAX_DAYS`
 *   desde que entró, por mucho que se use.
 *
 * El lugar se decide UNA vez, al entrar con la contraseña correcta
 * (`AuthService.lugarDe`), y queda escrito en la sesión: nada lo sube después.
 * Revocar, «Mis sesiones», el cambio de contraseña y la baja cortan igual a
 * las dos, y una sesión cerrada o vencida no se renueva (`renovar`).
 */
export type LugarDeSesion = SessionKind;

/** Días sin usarlo que aguanta la sesión del teléfono de la dueña. */
export const OWNER_PHONE_IDLE_DAYS = 30;
/**
 * Días que dura como mucho la sesión del teléfono de la dueña aunque la use a
 * diario: una cookie copiada no vive para siempre (SEC-11); la dueña vuelve a
 * escribir su contraseña una vez por trimestre.
 */
export const OWNER_PHONE_MAX_DAYS = 90;
/** Cada cuánto, como mucho, se corre el vencimiento de una sesión que se renueva (y se vuelve a poner su cookie). */
export const RENOVAR_CADA_MS = 3_600_000;

/**
 * TOPE ABSOLUTO de cada tipo de sesión, desde que se entra (24-04): la del
 * personal y la de la plataforma. Es lo que dura la cookie en el navegador, y
 * el servidor no acepta la sesión ni un minuto más: lo que se le dice a la
 * persona («se cierra a las 19:05») es lo que pasa.
 *
 * El teléfono de la dueña (D-04) tiene dos: `telefonoMs`, lo que aguanta sin
 * uso (y lo que dura su cookie cada vez que se renueva), y `telefonoMaxMs`,
 * su tope desde que entró.
 */
export type TopesDeSesion = { personalMs: number; plataformaMs: number; telefonoMs: number; telefonoMaxMs: number };

/** El tope desde que se entró. La sesión de la plataforma no tiene gimnasio y nunca es de teléfono. */
export function topeDe(topes: TopesDeSesion, organizationId: string | null, kind: string = 'COUNTER'): number {
  if (!organizationId) return topes.plataformaMs;
  return kind === 'OWNER_PHONE' ? topes.telefonoMaxMs : topes.personalMs;
}

/** Lo que dura al nacer: su tope, o en el teléfono de la dueña lo que aguanta sin uso. */
export function duracionInicial(topes: TopesDeSesion, organizationId: string | null, kind: string): number {
  return organizationId && kind === 'OWNER_PHONE' ? Math.min(topes.telefonoMs, topes.telefonoMaxMs) : topeDe(topes, organizationId, kind);
}

/** ¿Se renueva con el uso? Solo el teléfono de la dueña, en un gimnasio. */
export function seRenueva(s: { organizationId: string | null; kind: string }): boolean {
  return !!s.organizationId && s.kind === 'OWNER_PHONE';
}

/** Hasta cuándo vale una sesión: su vencimiento, nunca después del tope desde que se entró. */
export function finDe(s: { createdAt: Date; expiresAt: Date; organizationId: string | null; kind?: string }, topes: TopesDeSesion): Date {
  return new Date(Math.min(s.expiresAt.getTime(), s.createdAt.getTime() + topeDe(topes, s.organizationId, s.kind)));
}

/** Una sesión viva en la lista de «Mis sesiones» y en Seguridad de la plataforma. */
export type SesionViva = {
  id: string; organizationId: string | null; deviceLabel: string | null; userAgent: string | null; ip: string | null;
  createdAt: Date; lastSeenAt: Date; expiresAt: Date; kind: string;
};

/** Lo que queda de una sesión que ya no sirve: con esto se dice por qué (24-06). */
export type SesionTerminada = {
  organizationId: string | null; createdAt: Date; expiresAt: Date; revokedAt: Date | null; revokedReason: string | null; kind: string;
  user: { isActive: boolean; deletedAt: Date | null };
};

export type SessionRecord = {
  id: string;
  userId: string;
  organizationId: string | null;
  activeBranchId: string | null;
  expiresAt: Date;
  lastSeenAt?: Date | null;
  /** De qué lugar es (D-04): `COUNTER` u `OWNER_PHONE`. */
  kind?: string;
  /** Hasta cuándo vale la reconfirmación con la contraseña (plataforma). */
  stepUpUntil?: Date | null;
};

export class SessionRepository extends GlobalRepository {
  async create(input: {
    userId: string;
    organizationId: string | null;
    tokenHash: string;
    ttlMs: number;
    mfaSatisfied: boolean;
    ip?: string | undefined;
    userAgent?: string | undefined;
    deviceLabel?: string | undefined;
    /** El lugar (D-04). Sin decirlo, mostrador: la corta. */
    kind?: LugarDeSesion | undefined;
  }): Promise<SessionRecord> {
    const session = await this.db.session.create({
      data: {
        id: uuidv7(),
        userId: input.userId,
        organizationId: input.organizationId,
        tokenHash: input.tokenHash,
        mfaSatisfied: input.mfaSatisfied,
        expiresAt: new Date(Date.now() + input.ttlMs),
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        deviceLabel: input.deviceLabel ?? null,
        kind: input.kind ?? 'COUNTER',
      },
      select: { id: true, userId: true, organizationId: true, activeBranchId: true, expiresAt: true, lastSeenAt: true, kind: true },
    });
    return session;
  }

  /**
   * Todo lo que una petición necesita para saber quién llama, en UNA consulta:
   * la sesión, su usuario, sus permisos y sus topes (OPT3-03). Antes eran
   * cuatro consultas por petición, y pesaban más que la consulta útil de casi
   * cualquier ruta. Además del vencimiento, el tope de su tipo desde que se
   * entró (24-04): una sesión de antes, con el vencimiento corrido, tampoco
   * pasa de ahí.
   *
   * D-04 (bloque 4.1): el tope es el de su LUGAR. La hora sale del reloj de
   * la API (`Date`), no del de la base: una sola hora para decidir si vive,
   * para renovarla y para decir cuándo se cierra.
   */
  async resolveByTokenHash(tokenHash: string, topes: TopesDeSesion): Promise<{ session: SessionRecord & { lastSeenAt: Date; createdAt: Date; kind: string }; user: UserRecord; grants: Grant[]; limitRows: LimitRow[]; unlockedSections: string[]; platformSections: string[] | null; roleKeys: string[] } | null> {
    const ahora = new Date();
    const desdePersonal = new Date(ahora.getTime() - topes.personalMs);
    const desdePlataforma = new Date(ahora.getTime() - topes.plataformaMs);
    const desdeTelefono = new Date(ahora.getTime() - topes.telefonoMaxMs);
    const rows = await this.db.$queryRaw<Array<{
      id: string; userId: string; organizationId: string | null; activeBranchId: string | null; expiresAt: Date; lastSeenAt: Date; stepUpUntil: Date | null; createdAt: Date; kind: string;
      userOrganizationId: string | null; email: string; passwordHash: string; fullName: string; isActive: boolean;
      failedLogins: number; lockedUntil: Date | null; mustChangePassword: boolean; passwordResetAt: Date | null; passwordResetByUserId: string | null;
      unlockedSections: string[]; platformSections: string[] | null; roleKeys: string[];
      grants: Grant[]; limits: LimitRow[]; permissionOverrides: unknown; assignmentBranches: Array<string | null>; orgHasManager: boolean;
      isProxy: boolean;
    }>>`
      SELECT s.id, s."userId", s."organizationId", s."activeBranchId", s."expiresAt", s."lastSeenAt", s."stepUpUntil", s."createdAt", s."kind",
             u."organizationId" AS "userOrganizationId", u.email, u."passwordHash", u."fullName", u."isActive",
             u."failedLogins", u."lockedUntil", u."mustChangePassword", u."passwordResetAt", u."passwordResetByUserId",
             u."unlockedSections", u."platformSections", u."permissionOverrides",
             COALESCE((
               SELECT json_agg(ra."branchId") FROM role_assignments ra
               WHERE ra."userId" = u.id AND ra."revokedAt" IS NULL
             ), '[]'::json) AS "assignmentBranches",
             -- ¿Hay un gerente que ADMINISTRA? Activo y con Personal liberado (17-04, D17-05).
             -- Sin él, el dueño administra al personal (2026-10-09): si el único gerente
             -- no tiene Personal, nadie más podría contratar.
             EXISTS (
               SELECT 1 FROM role_assignments ra JOIN roles r ON r.id = ra."roleId" JOIN users g ON g.id = ra."userId"
               WHERE ra."organizationId" = u."organizationId" AND ra."revokedAt" IS NULL AND r.key = 'MANAGER'
                 AND g."isActive" AND g."deletedAt" IS NULL AND g."unlockedSections" @> '["personal"]'::jsonb
             ) AS "orgHasManager",
             -- ¿Tiene un nombramiento de apoderado vigente? (D-02, bloque 3.1)
             EXISTS (
               SELECT 1 FROM approval_proxies ap
               WHERE ap."proxyUserId" = u.id AND ap."organizationId" = u."organizationId" AND ap."endedAt" IS NULL AND ap."endsAt" > now()
             ) AS "isProxy",
             COALESCE((
               SELECT json_agg(DISTINCT r.key)
               FROM role_assignments ra JOIN roles r ON r.id = ra."roleId"
               WHERE ra."userId" = u.id AND ra."revokedAt" IS NULL
             ), '[]'::json) AS "roleKeys",
             COALESCE((
               SELECT json_agg(json_build_object('permission', rp."permissionKey", 'branchId', ra."branchId"))
               FROM role_assignments ra JOIN role_permissions rp ON rp."roleId" = ra."roleId"
               WHERE ra."userId" = u.id AND ra."revokedAt" IS NULL
             ), '[]'::json) AS grants,
             COALESCE((
               SELECT json_agg(json_build_object(
                 'maxDiscountPercent', rls."maxDiscountPercent", 'maxWaiverAmountCents', rls."maxWaiverAmountCents"::text,
                 'maxManualBalanceAdjustCents', rls."maxManualBalanceAdjustCents"::text, 'maxCashWithdrawalCents', rls."maxCashWithdrawalCents"::text,
                 'maxRefundAmountCents', rls."maxRefundAmountCents"::text, 'maxManualAccessGrantsPerShift', rls."maxManualAccessGrantsPerShift",
                 'maxPosVoidsPerShift', rls."maxPosVoidsPerShift"))
               FROM role_assignments ra JOIN role_limit_sets rls ON rls."roleId" = ra."roleId" AND rls."organizationId" = s."organizationId"
               WHERE ra."userId" = u.id AND ra."revokedAt" IS NULL
             ), '[]'::json) AS limits
      FROM sessions s
      JOIN users u ON u.id = s."userId" AND u."deletedAt" IS NULL
      WHERE s."tokenHash" = ${tokenHash} AND s."revokedAt" IS NULL AND s."expiresAt" > ${ahora}
        AND s."createdAt" > (CASE WHEN s."organizationId" IS NULL THEN ${desdePlataforma}::timestamptz
                                  WHEN s."kind" = 'OWNER_PHONE' THEN ${desdeTelefono}::timestamptz
                                  ELSE ${desdePersonal}::timestamptz END)
      LIMIT 1`;
    const r = rows[0];
    if (!r) return null;
    return {
      session: { id: r.id, userId: r.userId, organizationId: r.organizationId, activeBranchId: r.activeBranchId, expiresAt: r.expiresAt, lastSeenAt: r.lastSeenAt, stepUpUntil: r.stepUpUntil, createdAt: r.createdAt, kind: r.kind },
      user: {
        id: r.userId, organizationId: r.userOrganizationId, email: r.email, passwordHash: r.passwordHash, fullName: r.fullName,
        isActive: r.isActive, failedLogins: r.failedLogins, lockedUntil: r.lockedUntil, mustChangePassword: r.mustChangePassword,
        passwordResetAt: r.passwordResetAt, passwordResetByUserId: r.passwordResetByUserId,
      },
      // Las secciones cerradas por el dueño se descuentan aquí: la sesión
      // nace sin esos permisos, igual que si el puesto no los tuviera.
      grants: (() => {
        let grants = r.grants;
        // Ajustes por persona (recepción y coach), sobre su puesto. Solo los que
        // su puesto admite (17-02): caja guardada a un coach no le da caja.
        const ajustable = r.roleKeys.find((k) => ADJUSTABLE_ROLES.has(k));
        if (ajustable) grants = applyOverrides(grants, normalizeOverrides(r.permissionOverrides, ajustable), r.assignmentBranches);
        // Sin un gerente que administre (activo y con Personal liberado, D17-05), el dueño da de alta y ajusta al personal (2026-10-09).
        // Y registra los gastos fijos (renta, nómina…): sin ellos la ganancia del Tablero miente.
        if (r.roleKeys.includes('OWNER') && !r.orgHasManager) grants = [...grants, { permission: 'staff:manage', branchId: null }];
        // D-23 (fase 3, bloque 3.7): la dueña anota gastos, nómina y «Retiro del dueño» AUNQUE haya gerente
        // (antes, solo sin él); y sin un gerente que administre, cierra el mes ella, con su contraseña.
        if (r.roleKeys.includes('OWNER')) {
          grants = [...grants, { permission: 'expenses:manage', branchId: null }];
          if (!r.orgHasManager) grants = [...grants, { permission: 'reports:month:close', branchId: null }];
        }
        const fuera = lockedPermissions(r.unlockedSections, r.roleKeys, r.platformSections);
        const vigentes = grants.filter((g) => !fuera.has(g.permission));
        // D-02 (fase 3, bloque 3.1): mientras su nombramiento esté vigente, el apoderado ve Autorizaciones.
        // Es solo la entrada a la pantalla: quién firma qué lo decide `ApprovalService.requireAuthority`
        // leyendo el nombramiento, no este permiso. NO es `approvals:grant`, que abre actos propios del dueño.
        return r.isProxy ? [...vigentes, { permission: 'approvals:proxy', branchId: null }] : vigentes;
      })(),
      limitRows: r.limits,
      unlockedSections: r.unlockedSections,
      platformSections: r.platformSections,
      roleKeys: r.roleKeys,
    };
  }

  /**
   * El último uso, como mucho una vez por minuto: de él salen la inactividad
   * de la plataforma y el «último uso» de «Mis sesiones».
   *
   * Ya NO corre el vencimiento (24-04). La cookie vence a la hora que se puso
   * al entrar y nadie la vuelve a poner, así que correrlo solo dejaba la
   * sesión viva en el servidor después de muerta en el navegador: la lista
   * de sesiones mostraba sesiones que ya nadie podía usar (24-05) y una
   * cookie copiada seguía sirviendo hasta 16 h.
   */
  async touch(id: string): Promise<void> {
    // Bloque 4.16: es contabilidad, no la petición. Antes era un UPDATE que esperaba su turno sobre la fila
    // de la sesión (hasta el tope de 5 s): las tres o cuatro peticiones que el panel lanza juntas con la
    // misma cookie hacían fila sobre ESA fila, y con la base lenta para confirmar (disco ocupado) la que
    // esperaba de más caía en 500 «lock timeout» aunque solo quisiera leer. Ahora, si otra petición ya la
    // está anotando (fila tomada), esta no espera (SKIP LOCKED); y un fallo aquí nunca tumba la petición.
    const ahora = new Date();
    try {
      await this.db.$executeRaw`
        UPDATE "sessions" SET "lastSeenAt" = ${ahora}
         WHERE "id" = (SELECT "id" FROM "sessions"
                        WHERE "id" = ${id}::uuid AND "lastSeenAt" < ${new Date(ahora.getTime() - 60_000)}
                        FOR UPDATE SKIP LOCKED)`;
    } catch {
      // Se anota en la siguiente petición (a lo más un minuto después).
    }
  }

  /**
   * RENOVAR con el uso (D-04): corre el vencimiento de la sesión del teléfono
   * de la dueña hasta `hasta`. Solo a una sesión de ese lugar, SIN cerrar y
   * SIN vencer, y solo hacia adelante: una sesión revocada («Mis sesiones»,
   * cambio de contraseña, baja) o ya vencida no revive por más que alguien
   * siga presentando su cookie. `true` si se corrió.
   */
  async renovar(id: string, hasta: Date): Promise<boolean> {
    const ahora = new Date();
    const { count } = await this.db.session.updateMany({
      where: { id, kind: 'OWNER_PHONE', organizationId: { not: null }, revokedAt: null, expiresAt: { gt: ahora, lt: hasta } },
      data: { expiresAt: hasta, lastSeenAt: ahora },
    });
    return count > 0;
  }

  /** Por qué ya no sirve una cookie: la sesión que dejó, si queda (se borran a los 7 días). */
  async terminadaPorToken(tokenHash: string): Promise<SesionTerminada | null> {
    return this.db.session.findUnique({
      where: { tokenHash },
      select: {
        organizationId: true, createdAt: true, expiresAt: true, revokedAt: true, revokedReason: true, kind: true,
        user: { select: { isActive: true, deletedAt: true } },
      },
    });
  }

  /** Desde cuándo y hasta cuándo, para que el panel diga a qué hora se cierra esta sesión. */
  async porId(id: string): Promise<{ id: string; organizationId: string | null; createdAt: Date; expiresAt: Date; kind: string } | null> {
    return this.db.session.findUnique({ where: { id }, select: { id: true, organizationId: true, createdAt: true, expiresAt: true, kind: true } });
  }

  /**
   * Al entrar en un navegador que ya traía otra sesión, esa queda sin cookie:
   * se cierra, para que no aparezca viva en «Mis sesiones» sin que nadie la
   * pueda usar.
   */
  async revokeByTokenHash(tokenHash: string, reason: string): Promise<void> {
    await this.db.session.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Reconfirmación de plataforma: vale `minutos` en ESTA sesión. */
  async setStepUp(id: string, until: Date): Promise<void> {
    await this.db.session.update({ where: { id }, data: { stepUpUntil: until } });
  }

  async revoke(id: string, reason: string): Promise<void> {
    await this.db.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Cierre de sesión en todos los dispositivos. Trivial con sesiones opacas. */
  async revokeAllForUser(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
    const { count } = await this.db.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count;
  }

  /**
   * Solo las sesiones VIVAS (24-05): sin cerrar, sin vencer, dentro del tope
   * de su tipo y, en la plataforma, usadas dentro de la inactividad. Antes
   * salían también las que ya nadie podía usar, y una lista de veinte
   * «Otro equipo» no dejaba ver si había alguien más en la cuenta.
   */
  async listForUser(userId: string, vivas: { topes: TopesDeSesion; inactividadPlataformaMs: number }): Promise<SesionViva[]> {
    const ahora = Date.now();
    return this.db.session.findMany({
      where: {
        userId, revokedAt: null, expiresAt: { gt: new Date(ahora) },
        OR: [
          { organizationId: { not: null }, kind: { not: 'OWNER_PHONE' }, createdAt: { gt: new Date(ahora - vivas.topes.personalMs) } },
          { organizationId: { not: null }, kind: 'OWNER_PHONE', createdAt: { gt: new Date(ahora - vivas.topes.telefonoMaxMs) } },
          { organizationId: null, createdAt: { gt: new Date(ahora - vivas.topes.plataformaMs) }, lastSeenAt: { gt: new Date(ahora - vivas.inactividadPlataformaMs) } },
        ],
      },
      select: { id: true, organizationId: true, deviceLabel: true, userAgent: true, ip: true, createdAt: true, lastSeenAt: true, expiresAt: true, kind: true },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  /** ¿Ese usuario ya entró alguna vez desde esa IP en los últimos `dias`? */
  async knownIp(userId: string, ip: string, dias = 90): Promise<boolean> {
    const n = await this.db.session.count({
      where: { userId, ip, createdAt: { gte: new Date(Date.now() - dias * 86_400_000) } },
    });
    return n > 0;
  }

  async purgeExpired(): Promise<number> {
    const { count } = await this.db.session.deleteMany({
      where: { OR: [
        { expiresAt: { lt: new Date(Date.now() - 7 * 24 * 3600_000) } },
        { revokedAt: { lt: new Date(Date.now() - 7 * 24 * 3600_000) } },
      ] },
    });
    return count;
  }
}
