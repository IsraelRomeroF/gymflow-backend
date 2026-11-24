import { createHash } from 'node:crypto';
import { canonicalJson, uuidv7 } from '@gymflow/core';
import { Prisma } from '@gymflow/db';
import { GlobalRepository } from '../db/tenant-repository.js';

/**
 * CADENA DE PLATAFORMA (auditoría 8, 24-19 y 23-09; bloque 1.11).
 *
 * Lo que GymFlow hace desde su consola vive en UNA cadena de hashes propia,
 * `platform_audit_logs`, aparte de la de cada marca:
 *
 *  - ESPEJO ENLAZADO: cada asiento `platform.*` que se escribe en la cadena de
 *    una marca deja aquí su espejo, en la misma transacción, con el id y el
 *    hash del asiento de la marca. Borrar o alterar cualquiera de los dos lados
 *    se nota al verificar el enlace.
 *  - ASIENTO DIRECTO: lo que no toca a ninguna marca (entrar a la consola,
 *    reconfirmar, cambiar un plan o un precio) se asienta solo aquí.
 *
 * Es append-only igual que `audit_logs` (trigger + REVOKE) y la escritura se
 * serializa con un advisory lock propio: sin él dos peticiones leerían la misma
 * punta y dejarían dos eslabones hermanos.
 */

/** El contenido que entra al hash de un eslabón de la cadena de plataforma. */
export type PlatformAuditContent = {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly organizationId: string | null;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly beforeState: unknown;
  readonly afterState: unknown;
  readonly reason: string | null;
  readonly organizationAuditId: string | null;
  readonly organizationAuditHash: string | null;
  readonly occurredAt: string; // ISO-8601 UTC
  readonly at: string; // ISO-8601 UTC
};

export type PlatformAuditWrite = {
  actorUserId?: string | null;
  action: string;
  organizationId?: string | null;
  resourceType: string;
  resourceId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  reason?: string | null;
  /** El asiento de la cadena de la marca del que este es espejo. */
  organizationAuditId?: string | null;
  organizationAuditHash?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  /** Cuándo pasó; por omisión, ahora. Solo difiere al importar lo anterior a la cadena. */
  occurredAt?: Date;
};

export type PlatformAuditEntry = {
  id: string; at: Date; occurredAt: Date; action: string; actorUserId: string | null; organizationId: string | null;
  resourceType: string; resourceId: string | null; reason: string | null; beforeState: unknown; afterState: unknown;
  organizationAuditId: string | null; hash: string;
};

/** Dónde va la verificación: el último eslabón revisado. */
export type PlatformChainCursor = { at: Date; id: string; chainSeq: number | null };

export type PlatformChainVerification =
  | { readonly ok: true; readonly checked: number; readonly lastHash: string | null }
  | { readonly ok: false; readonly checked: number; readonly brokenAtId: string; readonly reason: string };

/** hash = sha256(prevHash || canonicalJson(contenido)); la semilla es distinta de la de las marcas. */
export function computePlatformAuditHash(prevHash: string | null, content: PlatformAuditContent): string {
  return createHash('sha256').update(prevHash ?? 'GENESIS-PLATAFORMA').update('\u0000').update(canonicalJson(content)).digest('hex');
}

/** Verifica un tramo de la cadena en orden ascendente; `expectedPrev` es la punta del tramo anterior. */
export function verifyPlatformChain(
  links: ReadonlyArray<{ prevHash: string | null; hash: string; content: PlatformAuditContent }>, expectedPrev: string | null,
): PlatformChainVerification {
  let prev = expectedPrev;
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    if (link.prevHash !== prev) {
      return { ok: false, checked: i, brokenAtId: link.content.id, reason: `prevHash no encadena: esperado ${prev ?? 'GENESIS'}, encontrado ${link.prevHash ?? 'null'}` };
    }
    if (computePlatformAuditHash(link.prevHash, link.content) !== link.hash) {
      return { ok: false, checked: i, brokenAtId: link.content.id, reason: 'el contenido no corresponde al hash almacenado (fila alterada)' };
    }
    prev = link.hash;
  }
  return { ok: true, checked: links.length, lastHash: prev };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Quién de la plataforma hizo un acto asentado en la cadena de una marca: viaja en `afterState.byPlatformUserId`. */
export function platformActorOf(afterState: unknown): string | null {
  const v = afterState && typeof afterState === 'object' ? (afterState as Record<string, unknown>).byPlatformUserId : undefined;
  return typeof v === 'string' && UUID.test(v) ? v : null;
}

/**
 * Encadena un asiento DENTRO de una transacción ya abierta (la del asiento de
 * la marca, cuando es su espejo). Toma el candado de la cadena de plataforma.
 */
export async function appendToPlatformChain(tx: Prisma.TransactionClient, entry: PlatformAuditWrite): Promise<{ id: string; hash: string }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('gymflow-platform-audit', 42))`;
  // La punta es el eslabón con el número más alto, no «el más tardío» (3.12):
  // la cadena no depende de que el reloj del servidor nunca retroceda. Lo
  // asentado antes de `chainSeq` busca su punta como antes, por (at, id).
  const tip = (await tx.platformAuditLog.findFirst({ where: { chainSeq: { not: null } }, orderBy: { chainSeq: 'desc' }, select: { hash: true, chainSeq: true } }))
    ?? (await tx.platformAuditLog.findFirst({ orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { hash: true, chainSeq: true } }));
  const chainSeq = (tip?.chainSeq ?? 0) + 1;
  const id = uuidv7();
  const at = new Date();
  const occurredAt = entry.occurredAt ?? at;
  const content: PlatformAuditContent = {
    id,
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    organizationId: entry.organizationId ?? null,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    beforeState: entry.beforeState ?? null,
    afterState: entry.afterState ?? null,
    reason: entry.reason ?? null,
    organizationAuditId: entry.organizationAuditId ?? null,
    organizationAuditHash: entry.organizationAuditHash ?? null,
    occurredAt: occurredAt.toISOString(),
    at: at.toISOString(),
  };
  const prevHash = tip?.hash ?? null;
  const hash = computePlatformAuditHash(prevHash, content);
  await tx.platformAuditLog.create({
    data: {
      id,
      actorUserId: content.actorUserId,
      action: content.action,
      organizationId: content.organizationId,
      resourceType: content.resourceType,
      resourceId: content.resourceId,
      beforeState: entry.beforeState == null ? Prisma.JsonNull : (entry.beforeState as Prisma.InputJsonValue),
      afterState: entry.afterState == null ? Prisma.JsonNull : (entry.afterState as Prisma.InputJsonValue),
      reason: content.reason,
      organizationAuditId: content.organizationAuditId,
      organizationAuditHash: content.organizationAuditHash,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      sessionId: entry.sessionId ?? null,
      requestId: entry.requestId ?? null,
      prevHash,
      hash,
      chainSeq,
      occurredAt,
      at,
    },
  });
  return { id, hash };
}

export class PlatformAuditRepository extends GlobalRepository {
  /** Un asiento directo de la consola (sin espejo en ninguna marca). */
  append(entry: PlatformAuditWrite): Promise<{ id: string; hash: string }> {
    return this.db.$transaction((tx) => appendToPlatformChain(tx, entry));
  }

  /**
   * Un tramo de la cadena en el orden en que se encadenó, después de `after`:
   * primero lo anterior a `chainSeq` (sin número) por (at, id), como siempre
   * se verificó; después lo numerado, por su número (3.12).
   */
  async chainPage(after: PlatformChainCursor | null, limit: number): Promise<Array<{ at: Date; chainSeq: number | null; prevHash: string | null; hash: string; content: PlatformAuditContent }>> {
    const anteriores = after && after.chainSeq !== null ? [] : await this.db.platformAuditLog.findMany({
      where: { chainSeq: null, ...(after ? { OR: [{ at: { gt: after.at } }, { at: after.at, id: { gt: after.id } }] } : {}) },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    const numerados = anteriores.length >= limit ? [] : await this.db.platformAuditLog.findMany({
      where: { chainSeq: after && after.chainSeq !== null ? { gt: after.chainSeq } : { not: null } },
      orderBy: { chainSeq: 'asc' },
      take: limit - anteriores.length,
    });
    const rows = [...anteriores, ...numerados];
    return rows.map((row) => ({
      at: row.at,
      chainSeq: row.chainSeq,
      prevHash: row.prevHash,
      hash: row.hash,
      content: {
        id: row.id, actorUserId: row.actorUserId, action: row.action, organizationId: row.organizationId,
        resourceType: row.resourceType, resourceId: row.resourceId,
        beforeState: row.beforeState ?? null, afterState: row.afterState ?? null, reason: row.reason,
        organizationAuditId: row.organizationAuditId, organizationAuditHash: row.organizationAuditHash,
        occurredAt: row.occurredAt.toISOString(), at: row.at.toISOString(),
      },
    }));
  }

  /** Lo más reciente primero (por cuándo se encadenó), con cursor. */
  async list(opts: {
    limit?: number | undefined; organizationId?: string | undefined; actorUserId?: string | undefined;
    from?: Date | undefined; to?: Date | undefined; before?: { at: Date; id: string } | undefined;
  } = {}): Promise<PlatformAuditEntry[]> {
    const rows = await this.db.platformAuditLog.findMany({
      where: {
        ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
        ...(opts.actorUserId ? { actorUserId: opts.actorUserId } : {}),
        ...(opts.from || opts.to ? { occurredAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lt: opts.to } : {}) } } : {}),
        ...(opts.before ? { AND: [{ OR: [{ at: { lt: opts.before.at } }, { at: opts.before.at, id: { lt: opts.before.id } }] }] } : {}),
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: opts.limit ?? 50,
      select: {
        id: true, at: true, occurredAt: true, action: true, actorUserId: true, organizationId: true, resourceType: true, resourceId: true,
        reason: true, beforeState: true, afterState: true, organizationAuditId: true, hash: true,
      },
    });
    return rows.map((r) => ({ ...r, beforeState: r.beforeState ?? null, afterState: r.afterState ?? null }));
  }

  /** Nombres para leer la cadena: cuentas de plataforma, marcas y la persona sobre la que se actuó. */
  async names(entries: readonly PlatformAuditEntry[]): Promise<{ actors: Map<string, string>; organizations: Map<string, string>; people: Map<string, string> }> {
    const actores = [...new Set(entries.map((e) => e.actorUserId).filter((x): x is string => !!x))];
    const marcas = [...new Set(entries.map((e) => e.organizationId).filter((x): x is string => !!x))];
    const personas = [...new Set(entries.filter((e) => e.resourceType === 'User' && e.resourceId && UUID.test(e.resourceId)).map((e) => e.resourceId!))];
    const [a, o, p] = await Promise.all([
      actores.length ? this.db.user.findMany({ where: { id: { in: actores }, organizationId: null }, select: { id: true, fullName: true, email: true } }) : [],
      marcas.length ? this.db.organization.findMany({ where: { id: { in: marcas } }, select: { id: true, tradeName: true } }) : [],
      personas.length ? this.db.user.findMany({ where: { id: { in: personas } }, select: { id: true, fullName: true } }) : [],
    ]);
    return {
      actors: new Map(a.map((u) => [u.id, u.fullName || u.email])),
      organizations: new Map(o.map((m) => [m.id, m.tradeName])),
      people: new Map(p.map((u) => [u.id, u.fullName])),
    };
  }

  /**
   * EL ENLACE con las cadenas de las marcas, en los dos sentidos:
   *  - `broken`: espejos cuyo asiento de marca ya no existe o cambió de hash;
   *  - `unmirrored`: asientos `platform.*` de una marca sin espejo aquí. Los
   *    anteriores a la cadena (antes de su primer eslabón) son `previous`: se
   *    importan con `importPrevious`; los posteriores son una falta real.
   */
  async links(): Promise<{ linked: number; broken: Array<{ id: string; organizationAuditId: string }>; unmirrored: Array<{ id: string; organizationId: string; at: Date }>; previous: number }> {
    const [enlazados, rotos, primero, sinEspejo] = await Promise.all([
      this.db.platformAuditLog.count({ where: { organizationAuditId: { not: null } } }),
      this.db.$queryRaw<Array<{ id: string; organizationAuditId: string }>>`
        SELECT p.id::text AS id, p."organizationAuditId"::text AS "organizationAuditId"
          FROM platform_audit_logs p
          LEFT JOIN audit_logs a ON a.id = p."organizationAuditId"
         WHERE p."organizationAuditId" IS NOT NULL AND (a.id IS NULL OR a.hash <> p."organizationAuditHash")
         ORDER BY p."at" ASC LIMIT 50`,
      this.db.platformAuditLog.findFirst({ orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { at: true } }),
      this.db.$queryRaw<Array<{ id: string; organizationId: string; at: Date }>>`
        SELECT a.id::text AS id, a."organizationId"::text AS "organizationId", a."at"
          FROM audit_logs a
         WHERE a."action" LIKE 'platform.%'
           AND NOT EXISTS (SELECT 1 FROM platform_audit_logs p WHERE p."organizationAuditId" = a.id)
         ORDER BY a."at" ASC, a.id ASC LIMIT 5000`,
    ]);
    const inicio = primero?.at ?? null;
    const anteriores = sinEspejo.filter((x) => !inicio || x.at < inicio);
    return { linked: enlazados, broken: rotos, unmirrored: sinEspejo.filter((x) => inicio && x.at >= inicio), previous: anteriores.length };
  }

  /** Los asientos `platform.*` de las marcas que todavía no tienen espejo, del más viejo al más nuevo. */
  async sinEspejo(limit: number): Promise<Array<{ id: string; hash: string; at: Date; organizationId: string; action: string; resourceType: string; resourceId: string | null; reason: string | null; beforeState: unknown; afterState: unknown }>> {
    const ids = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT a.id::text AS id
        FROM audit_logs a
       WHERE a."action" LIKE 'platform.%'
         AND NOT EXISTS (SELECT 1 FROM platform_audit_logs p WHERE p."organizationAuditId" = a.id)
       ORDER BY a."at" ASC, a.id ASC LIMIT ${limit}`;
    if (ids.length === 0) return [];
    const filas = await this.db.auditLog.findMany({
      where: { id: { in: ids.map((x) => x.id) } },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
      select: { id: true, hash: true, at: true, organizationId: true, action: true, resourceType: true, resourceId: true, reason: true, beforeState: true, afterState: true },
    });
    return filas.map((f) => ({ ...f, beforeState: f.beforeState ?? null, afterState: f.afterState ?? null }));
  }
}
