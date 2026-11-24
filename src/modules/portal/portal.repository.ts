import { uuidv7 } from '@gymflow/core';
import { createHash, randomBytes } from 'node:crypto';
import { TenantRepository, GlobalRepository } from '../../platform/db/tenant-repository.js';

/**
 * Sesiones e invitaciones del portal del socio.
 *
 * Todo lo que aquí se guarda es el HASH: el código de invitación y el
 * identificador de sesión en claro solo existen en la pantalla del socio y en
 * su cookie. Una filtración de la base no permite suplantar a nadie.
 */


/**
 * Días sin abrir el portal tras los que la sesión del socio se cierra (D-04,
 * opción a; fase 4, bloque 4.1). Mientras lo use queda abierta: cada uso
 * corre su vencimiento a `MEMBER_IDLE_DAYS` días de ese momento. Antes eran 7
 * días sin uso y, además, 30 desde que se activó aunque se usara a diario.
 */
export const MEMBER_IDLE_DAYS = 30;
/** Cada cuánto, como mucho, se corre el vencimiento con el uso (y se vuelve a poner la cookie del teléfono). */
export const RENOVAR_PORTAL_CADA_MS = 3_600_000;
/**
 * La causa que dejó la migración de D-04 en las sesiones que ya llevaban más
 * de 7 días sin uso (muertas con la regla anterior): al socio se le dice que
 * se cerró por falta de uso, no que alguien la cerró.
 */
export const CIERRE_POR_REGLA_ANTERIOR = 'Sin uso por más de 7 días (regla anterior a D-04)';
/** Cada cuánto, como mucho, se anota que el socio usó el portal (la inactividad se mide en días). */
const VISTO_CADA_MS = 60_000;
/** La causa que queda escrita cuando el socio sale en UN teléfono (`POST /portal/logout`). */
export const CIERRE_DEL_SOCIO = 'Cierre de sesión del socio';

export type InviteRecord = {
  id: string;
  memberId: string;
  expiresAt: Date;
  usedAt: Date | null;
};

export type MemberSessionRecord = {
  id: string;
  organizationId: string;
  memberId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  /** El vencimiento se corrió en ESTA lectura (D-04): quien responde vuelve a poner la cookie con `expiresAt`. */
  renovada?: boolean;
};

function hashCode(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Código de activación legible en voz alta.
 *
 * Recepción se lo dicta al socio con él delante, así que se excluyen los
 * caracteres que se confunden al hablar y al leer: 0/O, 1/I/L.
 */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newInviteCode(): string {
  const bytes = randomBytes(10);
  let codigo = '';
  for (let i = 0; i < 10; i++) {
    codigo += ALFABETO[bytes[i]! % ALFABETO.length];
    if (i === 4) codigo += '-';
  }
  return codigo;
}

export class PortalRepository extends TenantRepository {
  /** ¿Tiene una tarjeta domiciliada vigente? Solo lectura; la tabla es de payments (sin importarlo: evita el círculo). */
  async hasActiveCard(memberId: string): Promise<boolean> {
    return (await this.db.paymentMethod.count({ where: this.scope({ memberId, status: 'ACTIVE' as const }) })) > 0;
  }

  /**
   * Las clases sueltas que tienen precio (fase 3, bloque 3.10; D-35). Solo
   * lectura: la tabla es de `classes` (sin importarlo: evita el círculo, como arriba).
   */
  clasesConPrecio(): Promise<Array<{ id: string; name: string; dropInPriceCents: bigint }>> {
    return this.db.classType.findMany({
      where: this.scope({ isActive: true, deletedAt: null, dropInPriceCents: { gt: 0n } }),
      select: { id: true, name: true, dropInPriceCents: true }, orderBy: [{ dropInPriceCents: 'asc' }, { name: 'asc' }],
    });
  }

  /**
   * Emite una invitación, invalidando la anterior.
   *
   * Dos códigos válidos a la vez significan que uno anda suelto sin que nadie
   * lo sepa. El índice único parcial también lo impide; esto lo hace explícito.
   */
  async issueInvite(input: {
    memberId: string; code: string; ttlMinutes: number; issuedByUserId: string | null;
  }): Promise<InviteRecord> {
    return this.db.$transaction(async (tx) => {
      await tx.portalInvite.updateMany({
        where: { memberId: input.memberId, organizationId: this.organizationId, usedAt: null },
        data: { usedAt: new Date() },
      });
      const row = await tx.portalInvite.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          memberId: input.memberId,
          codeHash: hashCode(input.code),
          issuedByUserId: input.issuedByUserId,
          expiresAt: new Date(Date.now() + input.ttlMinutes * 60_000),
        },
        select: { id: true, memberId: true, expiresAt: true, usedAt: true },
      });
      return row as InviteRecord;
    });
  }
}

/**
 * Canje y sesión: son GLOBALES por necesidad.
 *
 * El socio llega con un código y nada más — no hay contexto de organización
 * todavía, igual que en el login del personal. Por eso esta clase no extiende
 * `TenantRepository`: el tenant se DEDUCE del código, no se recibe.
 */
export class PortalAuthRepository extends GlobalRepository {
  /** Canjea el código. Un solo uso, garantizado por la transacción. */
  async redeem(code: string): Promise<{ memberId: string; organizationId: string } | null> {
    return this.db.$transaction(async (tx) => {
      const invite = await tx.portalInvite.findFirst({
        where: { codeHash: hashCode(code), usedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, memberId: true, organizationId: true },
      });
      if (!invite) return null;

      // `usedAt: null` en el where: dos canjes simultáneos, solo uno gana.
      const res = await tx.portalInvite.updateMany({
        where: { id: invite.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (res.count === 0) return null;

      return { memberId: invite.memberId, organizationId: invite.organizationId };
    });
  }

  async createSession(input: {
    organizationId: string; memberId: string; tokenHash: string;
    ttlDays: number; userAgent: string | null;
  }): Promise<MemberSessionRecord> {
    const row = await this.db.memberSession.create({
      data: {
        id: uuidv7(),
        organizationId: input.organizationId,
        memberId: input.memberId,
        tokenHash: input.tokenHash,
        userAgent: input.userAgent,
        expiresAt: new Date(Date.now() + input.ttlDays * 86_400_000),
      },
      select: { id: true, organizationId: true, memberId: true, expiresAt: true, revokedAt: true },
    });
    return row as MemberSessionRecord;
  }

  /** Para la pantalla de Módulos: socios que hoy tienen el portal abierto en su teléfono. */
  async activeSessions(organizationId: string): Promise<number> {
    const vivas = await this.db.memberSession.groupBy({
      by: ['memberId'],
      where: { organizationId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    return vivas.length;
  }

  /**
   * Sesión del socio vigente: sin revocar, sin caducar, sin `MEMBER_IDLE_DAYS`
   * días de inactividad y de un socio que no está dado de baja (SEC-11).
   *
   * D-04 (bloque 4.1): queda ABIERTA mientras se use. Cada uso corre el
   * vencimiento a `MEMBER_IDLE_DAYS` días (como mucho una vez por hora), así
   * que se cierra sola a los 30 días sin abrirlo. Solo se corre una sesión
   * sin cerrar y sin vencer: la que recepción o el socio cerraron, o la de un
   * socio dado de baja, no revive aunque alguien siga presentando su cookie.
   */
  async findSession(tokenHash: string): Promise<MemberSessionRecord | null> {
    const ahora = Date.now();
    const row = await this.db.memberSession.findFirst({
      where: {
        tokenHash, revokedAt: null, expiresAt: { gt: new Date(ahora) },
        lastSeenAt: { gt: new Date(ahora - MEMBER_IDLE_DAYS * 86_400_000) },
        member: { deletedAt: null },
      },
      select: { id: true, organizationId: true, memberId: true, expiresAt: true, revokedAt: true },
    });
    if (!row) return null;
    const hasta = new Date(ahora + MEMBER_IDLE_DAYS * 86_400_000);
    if (hasta.getTime() - row.expiresAt.getTime() > RENOVAR_PORTAL_CADA_MS) {
      const { count } = await this.db.memberSession.updateMany({
        where: { id: row.id, revokedAt: null, expiresAt: { gt: new Date(ahora), lt: hasta } },
        data: { expiresAt: hasta, lastSeenAt: new Date(ahora) },
      });
      if (count > 0) return { ...row, expiresAt: hasta, renovada: true } as MemberSessionRecord;
      // Otra petición de la misma pantalla la corrió primero (o se cerró en este instante): se lee como quedó.
      const actual = await this.db.memberSession.findFirst({ where: { id: row.id, revokedAt: null }, select: { expiresAt: true } });
      if (!actual) return null;
      return { ...row, expiresAt: actual.expiresAt, renovada: true } as MemberSessionRecord;
    }
    // «Visto por última vez» con precisión de un minuto (fase 2, bloque 2.8): una pantalla del
    // portal hace varias peticiones a la vez y todas escribían el mismo renglón de la sesión.
    // Ahora escribe la primera; las demás no encuentran nada que cambiar y no esperan turno.
    await this.db.memberSession.updateMany({
      where: { id: row.id, lastSeenAt: { lt: new Date(ahora - VISTO_CADA_MS) } }, data: { lastSeenAt: new Date(ahora) },
    });
    return row as MemberSessionRecord;
  }

  /**
   * POR QUÉ ya no sirve esa cookie (bloque 1.6, pendiente de 1.12): solo se
   * llama cuando `findSession` no encontró sesión viva. `null` = esa cookie
   * no es de ninguna sesión (nunca existió o ya se purgó).
   */
  async whyEnded(tokenHash: string): Promise<'ACCOUNT_DEACTIVATED' | 'SESSION_LOGGED_OUT' | 'SESSION_CLOSED_EVERYWHERE' | 'SESSION_EXPIRED' | 'SESSION_IDLE' | null> {
    const s = await this.db.memberSession.findFirst({
      where: { tokenHash },
      select: { expiresAt: true, lastSeenAt: true, revokedAt: true, revokedReason: true, member: { select: { deletedAt: true } } },
    });
    if (!s) return null;
    if (s.member.deletedAt) return 'ACCOUNT_DEACTIVATED';
    // Salir en este teléfono lo anota `revokeSession`; todo lo demás cierra todos (`revokeAllForMember`).
    if (s.revokedAt) {
      if (s.revokedReason === CIERRE_POR_REGLA_ANTERIOR) return 'SESSION_IDLE';
      return s.revokedReason === CIERRE_DEL_SOCIO ? 'SESSION_LOGGED_OUT' : 'SESSION_CLOSED_EVERYWHERE';
    }
    // D-04: el vencimiento se corre con el uso, así que llegar a él ES haber dejado de abrirlo.
    if (s.expiresAt.getTime() <= Date.now() || s.lastSeenAt.getTime() <= Date.now() - MEMBER_IDLE_DAYS * 86_400_000) return 'SESSION_IDLE';
    return null;
  }

  /** RETENCIÓN (PS-08): una invitación caducada hace más de `antes` ya no abre nada; su hash sobra. */
  async purgeInvitesBefore(antes: Date): Promise<number> {
    const { count } = await this.db.portalInvite.deleteMany({ where: { expiresAt: { lt: antes } } });
    return count;
  }

  /** RETENCIÓN: sesiones del socio cerradas o caducadas hace más de `dias`. */
  async purgeSessionsBefore(antes: Date): Promise<number> {
    const { count } = await this.db.memberSession.deleteMany({
      where: { OR: [{ revokedAt: { lt: antes } }, { expiresAt: { lt: antes } }] },
    });
    return count;
  }

  async revokeSession(tokenHash: string, reason: string): Promise<void> {
    await this.db.memberSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /**
   * Cierra TODAS las sesiones del socio (PS-02): teléfono perdido, o código
   * nuevo emitido en recepción. Devuelve cuántas se cerraron.
   */
  async revokeAllForMember(organizationId: string, memberId: string, reason: string): Promise<number> {
    const { count } = await this.db.memberSession.updateMany({
      where: { organizationId, memberId, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count;
  }

  /** Teléfonos con sesión viva del socio: cuántos y cuándo se vio el último. */
  async activeForMember(organizationId: string, memberId: string): Promise<{ active: number; lastSeenAt: Date | null }> {
    const vivas = await this.db.memberSession.findMany({
      where: {
        organizationId, memberId, revokedAt: null, expiresAt: { gt: new Date() },
        lastSeenAt: { gt: new Date(Date.now() - MEMBER_IDLE_DAYS * 86_400_000) },
      },
      select: { lastSeenAt: true },
      orderBy: { lastSeenAt: 'desc' },
    });
    return { active: vivas.length, lastSeenAt: vivas[0]?.lastSeenAt ?? null };
  }
}
