import { uuidv7, type Grant, lockedPermissions, applyOverrides, normalizeOverrides, ADJUSTABLE_ROLES } from '@gymflow/core';
import { GlobalRepository } from '../../platform/db/tenant-repository.js';
import type { LimitRow } from './role.repository.js';
import type { UserRecord } from './user.repository.js';


/** Horas máximas de cualquier sesión, por mucho que se use: el techo de los topes de cada tipo. */
export const STAFF_MAX_SESSION_HOURS = 16;

/**
 * TOPE ABSOLUTO de cada tipo de sesión, desde que se entra (24-04): la del
 * personal y la de la plataforma. Es lo que dura la cookie en el navegador, y
 * el servidor no acepta la sesión ni un minuto más: lo que se le dice a la
 * persona («se cierra a las 19:05») es lo que pasa.
 */
export type TopesDeSesion = { personalMs: number; plataformaMs: number };

/** La sesión del personal tiene gimnasio; la de la plataforma, no. */
export function topeDe(topes: TopesDeSesion, organizationId: string | null): number {
  return organizationId ? topes.personalMs : topes.plataformaMs;
}

/** Hasta cuándo vale una sesión: su vencimiento, nunca después del tope desde que se entró. */
export function finDe(s: { createdAt: Date; expiresAt: Date; organizationId: string | null }, topes: TopesDeSesion): Date {
  return new Date(Math.min(s.expiresAt.getTime(), s.createdAt.getTime() + topeDe(topes, s.organizationId)));
}

/** Una sesión viva en la lista de «Mis sesiones» y en Seguridad de la plataforma. */
export type SesionViva = {
  id: string; organizationId: string | null; deviceLabel: string | null; userAgent: string | null; ip: string | null;
  createdAt: Date; lastSeenAt: Date; expiresAt: Date;
};

/** Lo que queda de una sesión que ya no sirve: con esto se dice por qué (24-06). */
export type SesionTerminada = {
  organizationId: string | null; createdAt: Date; expiresAt: Date; revokedAt: Date | null; revokedReason: string | null;
  user: { isActive: boolean; deletedAt: Date | null };
};

export type SessionRecord = {
  id: string;
  userId: string;
  organizationId: string | null;
  activeBranchId: string | null;
  expiresAt: Date;
  lastSeenAt?: Date | null;
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
      },
      select: { id: true, userId: true, organizationId: true, activeBranchId: true, expiresAt: true, lastSeenAt: true },
    });
    return session;
  }

  /**
   * Con TOPE ABSOLUTO desde que se inició sesión (SEC-11): una sesión robada
   * y usada a diario vivía para siempre. El vencimiento ya no se corre con el
   * uso (24-04); aquí queda además el techo de 16 h para cualquier sesión.
   */
  async findValidByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return this.db.session.findFirst({
      where: {
        tokenHash, revokedAt: null, expiresAt: { gt: new Date() },
        createdAt: { gt: new Date(Date.now() - STAFF_MAX_SESSION_HOURS * 3_600_000) },
      },
      select: { id: true, userId: true, organizationId: true, activeBranchId: true, expiresAt: true },
    });
  }

  /**
   * Todo lo que una petición necesita para saber quién llama, en UNA consulta:
   * la sesión, su usuario, sus permisos y sus topes (OPT3-03). Antes eran
   * cuatro consultas por petición, y pesaban más que la consulta útil de casi
   * cualquier ruta. Además del vencimiento, el tope de su tipo desde que se
   * entró (24-04): una sesión de antes, con el vencimiento corrido, tampoco
   * pasa de ahí.
   */
  async resolveByTokenHash(tokenHash: string, topes: TopesDeSesion): Promise<{ session: SessionRecord & { lastSeenAt: Date; createdAt: Date }; user: UserRecord; grants: Grant[]; limitRows: LimitRow[]; unlockedSections: string[]; platformSections: string[] | null; roleKeys: string[] } | null> {
    const desde = new Date(Date.now() - STAFF_MAX_SESSION_HOURS * 3_600_000);
    const desdePersonal = new Date(Date.now() - topes.personalMs);
    const desdePlataforma = new Date(Date.now() - topes.plataformaMs);
    const rows = await this.db.$queryRaw<Array<{
      id: string; userId: string; organizationId: string | null; activeBranchId: string | null; expiresAt: Date; lastSeenAt: Date; stepUpUntil: Date | null; createdAt: Date;
      userOrganizationId: string | null; email: string; passwordHash: string; fullName: string; isActive: boolean;
      failedLogins: number; lockedUntil: Date | null; mustChangePassword: boolean; passwordResetAt: Date | null; passwordResetByUserId: string | null;
      unlockedSections: string[]; platformSections: string[] | null; roleKeys: string[];
      grants: Grant[]; limits: LimitRow[]; permissionOverrides: unknown; assignmentBranches: Array<string | null>; orgHasManager: boolean;
    }>>`
      SELECT s.id, s."userId", s."organizationId", s."activeBranchId", s."expiresAt", s."lastSeenAt", s."stepUpUntil", s."createdAt",
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
      WHERE s."tokenHash" = ${tokenHash} AND s."revokedAt" IS NULL AND s."expiresAt" > now() AND s."createdAt" > ${desde}
        AND s."createdAt" > (CASE WHEN s."organizationId" IS NULL THEN ${desdePlataforma}::timestamptz ELSE ${desdePersonal}::timestamptz END)
      LIMIT 1`;
    const r = rows[0];
    if (!r) return null;
    return {
      session: { id: r.id, userId: r.userId, organizationId: r.organizationId, activeBranchId: r.activeBranchId, expiresAt: r.expiresAt, lastSeenAt: r.lastSeenAt, stepUpUntil: r.stepUpUntil, createdAt: r.createdAt },
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
        if (r.roleKeys.includes('OWNER') && !r.orgHasManager) grants = [...grants, { permission: 'staff:manage', branchId: null }, { permission: 'expenses:manage', branchId: null }];
        const fuera = lockedPermissions(r.unlockedSections, r.roleKeys, r.platformSections);
        return grants.filter((g) => !fuera.has(g.permission));
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
    await this.db.session.updateMany({
      where: { id, lastSeenAt: { lt: new Date(Date.now() - 60_000) } },
      data: { lastSeenAt: new Date() },
    });
  }

  /** Por qué ya no sirve una cookie: la sesión que dejó, si queda (se borran a los 7 días). */
  async terminadaPorToken(tokenHash: string): Promise<SesionTerminada | null> {
    return this.db.session.findUnique({
      where: { tokenHash },
      select: {
        organizationId: true, createdAt: true, expiresAt: true, revokedAt: true, revokedReason: true,
        user: { select: { isActive: true, deletedAt: true } },
      },
    });
  }

  /** Desde cuándo y hasta cuándo, para que el panel diga a qué hora se cierra esta sesión. */
  async porId(id: string): Promise<{ id: string; organizationId: string | null; createdAt: Date; expiresAt: Date } | null> {
    return this.db.session.findUnique({ where: { id }, select: { id: true, organizationId: true, createdAt: true, expiresAt: true } });
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
          { organizationId: { not: null }, createdAt: { gt: new Date(ahora - vivas.topes.personalMs) } },
          { organizationId: null, createdAt: { gt: new Date(ahora - vivas.topes.plataformaMs) }, lastSeenAt: { gt: new Date(ahora - vivas.inactividadPlataformaMs) } },
        ],
      },
      select: { id: true, organizationId: true, deviceLabel: true, userAgent: true, ip: true, createdAt: true, lastSeenAt: true, expiresAt: true },
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
