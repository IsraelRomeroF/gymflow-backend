import { GlobalRepository, TenantRepository } from '../../platform/db/tenant-repository.js';

export type UserRecord = {
  id: string;
  organizationId: string | null;
  email: string;
  passwordHash: string;
  fullName: string;
  isActive: boolean;
  failedLogins: number;
  lockedUntil: Date | null;
  mustChangePassword: boolean;
  passwordResetAt: Date | null;
  passwordResetByUserId: string | null;
};

/**
 * Lo que el login y el cambio de contraseña necesitan además: desde cuándo
 * existe la cuenta (de ahí vence una temporal sin fecha de restablecimiento)
 * y cuándo entró por última vez (el cambio obligatorio sin «actual»).
 */
export type CuentaRecord = UserRecord & { createdAt: Date; lastLoginAt: Date | null };

/**
 * Búsqueda por credenciales. Es GLOBAL a propósito: en el login todavía no
 * existe un tenant resuelto — precisamente lo que el login establece.
 */
export class AuthUserRepository extends GlobalRepository {
  async findByEmail(email: string): Promise<CuentaRecord | null> {
    const rows = await this.db.$queryRaw<CuentaRecord[]>`
      SELECT id, "organizationId", email, "passwordHash", "fullName",
             "isActive", "failedLogins", "lockedUntil",
             "mustChangePassword", "passwordResetAt", "passwordResetByUserId",
             "createdAt", "lastLoginAt"
      FROM users
      WHERE lower(email) = lower(${email}) AND "deletedAt" IS NULL
      LIMIT 1`;
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<CuentaRecord | null> {
    const user = await this.db.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, organizationId: true, email: true, passwordHash: true,
        fullName: true, isActive: true,
        failedLogins: true, lockedUntil: true,
        mustChangePassword: true, passwordResetAt: true, passwordResetByUserId: true,
        createdAt: true, lastLoginAt: true,
      },
    });
    return user;
  }

  async registerFailedLogin(userId: string, lockThreshold: number): Promise<void> {
    const user = await this.db.user.update({
      where: { id: userId },
      data: { failedLogins: { increment: 1 } },
      select: { failedLogins: true },
    });
    if (user.failedLogins >= lockThreshold) {
      // Bloqueo progresivo: cada fallo por encima del umbral dobla la espera,
      // con techo de 30 minutos. Frena la fuerza bruta sin dejar fuera para
      // siempre a quien simplemente se equivocó.
      const excess = user.failedLogins - lockThreshold;
      const minutes = Math.min(30, 2 ** excess);
      await this.db.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + minutes * 60_000) },
      });
    }
  }

  async registerSuccessfulLogin(userId: string): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
  }

  /** La persona cambia SU contraseña: deja de ser temporal. */
  async setOwnPassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { passwordHash, mustChangePassword: false } });
  }
}

/** Lecturas de usuarios YA dentro de un tenant. */
export class UserRepository extends TenantRepository {
  async list(limit = 50) {
    return this.db.user.findMany({
      where: this.scope({ deletedAt: null }),
      select: { id: true, email: true, fullName: true, isActive: true, lastLoginAt: true },
      orderBy: { fullName: 'asc' },
      take: limit,
    });
  }

  /**
   * Devuelve null —no lanza— si el id pertenece a otra organización.
   * La ruta lo traduce a 404, NUNCA a 403: un 403 confirmaría que el recurso
   * existe, que es justo lo que no queremos revelar.
   */
  async findById(id: string) {
    return this.db.user.findFirst({
      where: this.scope({ id, deletedAt: null }),
      select: { id: true, email: true, fullName: true, isActive: true, lastLoginAt: true },
    });
  }

  /** El personal activo, sin esta persona: los posibles segundos firmantes. */
  async activeExcept(userId: string): Promise<Array<{ id: string; fullName: string }>> {
    return this.db.user.findMany({
      where: this.scope({ isActive: true, deletedAt: null, id: { not: userId } }),
      select: { id: true, fullName: true },
    });
  }

  /** Nombre visible por id, para documentos que dicen quién hizo qué. */
  async namesById(ids: readonly string[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) return new Map();
    const rows = await this.db.user.findMany({
      where: this.scope({ id: { in: unicos } }),
      select: { id: true, fullName: true },
    });
    return new Map(rows.map((u) => [u.id, u.fullName]));
  }
}
