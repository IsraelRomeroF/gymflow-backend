import { AUDIT_CATEGORIES, AUDIT_SUMMARIZED, computeAuditHash, uuidv7, type AuditActorType, type AuditContent, type ChainLink } from '@gymflow/core';
import { GlobalRepository } from '../db/tenant-repository.js';
import { Prisma } from '@gymflow/db';
import { appendToPlatformChain, platformActorOf } from './platform-audit.repository.js';

/** Proyección de lectura de la bitácora. Explícita a propósito: evita filtrar
 *  tipos generados de Prisma fuera de la capa de repositorio. */
export type AuditEntry = {
  id: string;
  at: Date;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorUserId: string | null;
  actorType: string;
  branchId: string | null;
  reason: string | null;
  approvedByUserId: string | null;
  beforeState: unknown;
  afterState: unknown;
};

/** A quién toca un asiento: el socio (con su número) y, si se actuó sobre alguien del personal, esa persona. */
export type AuditNames = {
  users: Map<string, string>;
  /** Por id de asiento. */
  members: Map<string, { name: string; memberId: string; memberCode: string | null }>;
  /** Por id de asiento: la persona del personal sobre la que se actuó. */
  people: Map<string, string>;
};

export type AuditListOptions = {
  limit?: number | undefined; actorUserId?: string | undefined; resourceType?: string | undefined;
  /** null/undefined = toda la organización. */
  branchIds?: readonly string[] | null | undefined;
  /** Prefijos de acción (`payments.`, `cash.`) o acciones exactas. */
  actions?: readonly string[] | undefined;
  /** Solo «Para revisar»: la lista fija del núcleo más las tres reglas que dependen del asiento (20-06). */
  review?: boolean | undefined;
  resourceId?: string | undefined;
  /** «Todo lo de este socio»: lo asentado sobre él o sobre sus pagos, cargos, membresías, consentimientos… */
  memberId?: string | undefined;
  from?: Date | undefined; to?: Date | undefined;
  /** Cursor: lo anterior a este evento (at, id). */
  before?: { at: Date; id: string } | undefined;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `member_credential`, `MemberCredential` y `membercredential` son el mismo tipo de recurso. */
const tipo = (resourceType: string): string => resourceType.toLowerCase().replace(/_/g, '');
const porAccion = (a: string): Prisma.AuditLogWhereInput => (a.endsWith('.') ? { action: { startsWith: a } } : { action: a });

/**
 * «PARA REVISAR» EN LA CONSULTA (20-06): lo mismo que `auditNeedsReview` del
 * núcleo, dicho en SQL. La lista fija, más: el corte solo con diferencia, el
 * descuento solo si pidió firma y la venta solo con fecha anterior. Una prueba
 * (`test/bitacora.test.ts`) comprueba que las dos reglas digan lo mismo.
 */
export function filtroParaRevisar(): Prisma.AuditLogWhereInput {
  return {
    OR: [
      ...AUDIT_CATEGORIES.sensibles!.map(porAccion),
      { action: 'cash.session.close', afterState: { path: ['varianceCents'], not: '0' } },
      { action: 'billing.discount.apply', approvedByUserId: { not: null } },
      { action: 'membership.sale', afterState: { path: ['backdated'], equals: true } },
    ],
  };
}

export type AuditWrite = {
  organizationId: string;
  branchId?: string | null;
  actorUserId?: string | null;
  actorType: AuditActorType;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  reason?: string | null;
  approvedByUserId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  businessDate: Date;
};

/**
 * Bitácora append-only con cadena de hashes por organización (ADR-018).
 *
 * La escritura se serializa con un advisory lock de PostgreSQL por
 * organización: sin él, dos peticiones concurrentes leerían el mismo último
 * hash y producirían dos eslabones hermanos, rompiendo la cadena. El lock es
 * a nivel de transacción, así que se libera solo al terminar.
 */
export class AuditRepository extends GlobalRepository {
  async append(entry: AuditWrite): Promise<{ id: string; hash: string }> {
    return this.db.$transaction(async (tx) => {
      // Un lock por organización: dos organizaciones no se estorban.
      // $executeRaw y no $queryRaw: la función devuelve `void` y el driver
      // no puede deserializar ese tipo como conjunto de resultados.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${entry.organizationId}, 42))`;

      const tip = await tx.auditLog.findFirst({
        where: { organizationId: entry.organizationId },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        select: { hash: true },
      });

      const id = uuidv7();
      const at = new Date();
      const content: AuditContent = {
        id,
        organizationId: entry.organizationId,
        branchId: entry.branchId ?? null,
        actorUserId: entry.actorUserId ?? null,
        actorType: entry.actorType,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        beforeState: entry.beforeState ?? null,
        afterState: entry.afterState ?? null,
        reason: entry.reason ?? null,
        approvedByUserId: entry.approvedByUserId ?? null,
        at: at.toISOString(),
      };

      const prevHash = tip?.hash ?? null;
      const hash = computeAuditHash(prevHash, content);

      await tx.auditLog.create({
        data: {
          id,
          organizationId: entry.organizationId,
          branchId: entry.branchId ?? null,
          actorUserId: entry.actorUserId ?? null,
          actorType: entry.actorType,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          beforeState: entry.beforeState == null ? Prisma.JsonNull : (entry.beforeState as Prisma.InputJsonValue),
          afterState: entry.afterState == null ? Prisma.JsonNull : (entry.afterState as Prisma.InputJsonValue),
          reason: entry.reason ?? null,
          approvedByUserId: entry.approvedByUserId ?? null,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
          sessionId: entry.sessionId ?? null,
          requestId: entry.requestId ?? null,
          prevHash,
          hash,
          at,
          businessDate: entry.businessDate,
        },
      });

      // ESPEJO EN LA CADENA DE PLATAFORMA (24-19, 23-09): lo que GymFlow hace
      // sobre una marca queda también en la cadena propia de la plataforma,
      // enlazado con este asiento (id y hash) y en esta misma transacción: o
      // quedan los dos o no queda ninguno.
      if (entry.action.startsWith('platform.')) {
        await appendToPlatformChain(tx, {
          actorUserId: platformActorOf(entry.afterState),
          action: entry.action,
          organizationId: entry.organizationId,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          beforeState: entry.beforeState,
          afterState: entry.afterState,
          reason: entry.reason ?? null,
          organizationAuditId: id,
          organizationAuditHash: hash,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
          requestId: entry.requestId ?? null,
          occurredAt: at,
        });
      }

      return { id, hash };
    });
  }

  /** Cadena completa en orden ascendente, para el job de verificación diaria. */
  /**
   * Un tramo de la cadena, en el mismo orden en que se encadenó: después de
   * `after` (at, id), hasta `limit` eslabones. Verificar por tramos mantiene
   * la memoria constante aunque la bitácora tenga millones de filas (OPT-03).
   */
  async chainPage(organizationId: string, after: { at: Date; id: string } | null, limit: number): Promise<Array<ChainLink & { at: Date }>> {
    const rows = await this.db.auditLog.findMany({
      where: {
        organizationId,
        ...(after ? { OR: [{ at: { gt: after.at } }, { at: after.at, id: { gt: after.id } }] } : {}),
      },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map((row) => ({
      at: row.at,
      prevHash: row.prevHash,
      hash: row.hash,
      content: {
        id: row.id,
        organizationId: row.organizationId,
        branchId: row.branchId,
        actorUserId: row.actorUserId,
        actorType: row.actorType as AuditActorType,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        beforeState: row.beforeState ?? null,
        afterState: row.afterState ?? null,
        reason: row.reason,
        approvedByUserId: row.approvedByUserId,
        at: row.at.toISOString(),
      },
    }));
  }

  async list(organizationId: string, opts: AuditListOptions = {}): Promise<AuditEntry[]> {
    const y: Prisma.AuditLogWhereInput[] = [];
    if (opts.actions?.length) y.push({ OR: opts.actions.map(porAccion) });
    if (opts.review) y.push(filtroParaRevisar());
    if (opts.memberId) {
      const suyos = await this.recursosDelSocio(organizationId, opts.memberId);
      y.push({
        OR: [
          { resourceId: { in: suyos } },
          { afterState: { path: ['memberId'], equals: opts.memberId } },
          { beforeState: { path: ['memberId'], equals: opts.memberId } },
        ],
      });
    }
    if (opts.before) y.push({ OR: [{ at: { lt: opts.before.at } }, { at: opts.before.at, id: { lt: opts.before.id } }] });
    const rows = await this.db.auditLog.findMany({
      where: {
        organizationId,
        ...(opts.branchIds ? { branchId: { in: [...opts.branchIds] } } : {}),
        ...(opts.actorUserId ? { actorUserId: opts.actorUserId } : {}),
        ...(opts.resourceType ? { resourceType: opts.resourceType } : {}),
        ...(opts.resourceId ? { resourceId: opts.resourceId } : {}),
        ...(opts.from || opts.to ? { at: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lt: opts.to } : {}) } } : {}),
        ...(y.length ? { AND: y } : {}),
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: opts.limit ?? 50,
      select: {
        id: true, at: true, action: true, resourceType: true, resourceId: true,
        actorUserId: true, actorType: true, branchId: true, reason: true,
        approvedByUserId: true, beforeState: true, afterState: true,
      },
    });
    return rows.map((row) => ({ ...row, beforeState: row.beforeState ?? null, afterState: row.afterState ?? null }));
  }

  /**
   * Los ids de todo lo que es de un socio y puede ser recurso de un asiento:
   * él mismo, sus pagos (y los reembolsos de esos pagos), cargos, membresías,
   * paquetes, ventas de mostrador, consentimientos, credenciales, biometría,
   * invitaciones al portal, altas digitales, solicitudes ARCO, tarjetas,
   * cobros en línea, pasos por la puerta y reservas.
   */
  private async recursosDelSocio(organizationId: string, memberId: string): Promise<string[]> {
    const w = { where: { organizationId, memberId }, select: { id: true }, take: 2000 } as const;
    const d = this.db;
    const listas = await Promise.all([
      d.payment.findMany(w), d.charge.findMany(w), d.membership.findMany(w), d.visitPack.findMany(w), d.posSale.findMany(w),
      d.memberConsent.findMany(w), d.memberCredential.findMany(w), d.biometricEnrollment.findMany(w), d.portalInvite.findMany(w),
      d.memberIntake.findMany(w), d.privacyRequest.findMany(w), d.paymentMethod.findMany(w), d.paymentAttempt.findMany(w),
      d.accessDecision.findMany({ ...w, orderBy: { id: 'desc' } }), d.classBooking.findMany({ ...w, orderBy: { id: 'desc' } }),
    ]);
    const pagos = listas[0]!.map((x) => x.id);
    const reembolsos = pagos.length ? await d.refund.findMany({ where: { organizationId, paymentId: { in: pagos } }, select: { id: true }, take: 2000 }) : [];
    return [memberId, ...listas.flat().map((x) => x.id), ...reembolsos.map((x) => x.id)];
  }

  /**
   * Nombres para leer la bitácora en frases (20-07): quién actuó, quién
   * autorizó, DE QUÉ SOCIO se trata y sobre qué persona del personal se actuó.
   *
   * El socio se resuelve por lo que el asiento diga, en este orden: el
   * `memberId` de su estado; el recurso mismo si es un socio; o el dueño del
   * recurso (su pago, cargo, membresía, paquete, venta, consentimiento,
   * credencial, biometría, invitación, alta, solicitud ARCO, reserva…).
   */
  async names(organizationId: string, entries: readonly AuditEntry[]): Promise<AuditNames> {
    const userIds = new Set(entries.flatMap((e) => [e.actorUserId, e.approvedByUserId]).filter((x): x is string => !!x));
    for (const e of entries) if (tipo(e.resourceType) === 'user' && e.resourceId) userIds.add(e.resourceId);

    const enEstado = (e: AuditEntry): string | null => {
      for (const estado of [e.afterState, e.beforeState]) {
        const v = estado && typeof estado === 'object' ? (estado as Record<string, unknown>).memberId : undefined;
        if (typeof v === 'string' && UUID.test(v)) return v;
      }
      return null;
    };
    const directo = new Map<string, string>();
    const idsPorTipo = new Map<string, Set<string>>();
    for (const e of entries) {
      const m = enEstado(e) ?? (tipo(e.resourceType) === 'member' ? e.resourceId : null);
      if (m) { directo.set(e.id, m); continue; }
      if (!e.resourceId) continue;
      const t = tipo(e.resourceType);
      idsPorTipo.set(t, (idsPorTipo.get(t) ?? new Set()).add(e.resourceId));
    }
    // Sin ids no se consulta: Prisma manda igual un `WHERE 1=0` (OPT3-09).
    const d = this.db;
    const de = async (t: string, consulta: (ids: string[]) => Promise<Array<{ id: string; memberId: string | null }>>): Promise<Array<{ id: string; memberId: string | null }>> => {
      const ids = [...(idsPorTipo.get(t) ?? [])];
      return ids.length === 0 ? [] : consulta(ids);
    };
    const q = (ids: string[]) => ({ where: { organizationId, id: { in: ids } }, select: { id: true, memberId: true } });
    const dueños = (await Promise.all([
      de('payment', (ids) => d.payment.findMany(q(ids))),
      de('charge', (ids) => d.charge.findMany(q(ids))),
      de('membership', (ids) => d.membership.findMany(q(ids))),
      de('visitpack', (ids) => d.visitPack.findMany(q(ids))),
      de('possale', (ids) => d.posSale.findMany(q(ids))),
      de('memberconsent', (ids) => d.memberConsent.findMany(q(ids))),
      de('membercredential', (ids) => d.memberCredential.findMany(q(ids))),
      de('biometricenrollment', (ids) => d.biometricEnrollment.findMany(q(ids))),
      de('portalinvite', (ids) => d.portalInvite.findMany(q(ids))),
      de('memberintake', (ids) => d.memberIntake.findMany(q(ids))),
      de('privacyrequest', (ids) => d.privacyRequest.findMany(q(ids))),
      de('paymentmethod', (ids) => d.paymentMethod.findMany(q(ids))),
      de('paymentattempt', (ids) => d.paymentAttempt.findMany(q(ids))),
      de('accessdecision', (ids) => d.accessDecision.findMany(q(ids))),
      de('classbooking', (ids) => d.classBooking.findMany(q(ids))),
      // El reembolso es de un pago, y el pago es del socio.
      de('refund', async (ids) => (await d.refund.findMany({ where: { organizationId, id: { in: ids } }, select: { id: true, payment: { select: { memberId: true } } } }))
        .map((r) => ({ id: r.id, memberId: r.payment.memberId }))),
    ])).flat();
    const deRecurso = new Map<string, string>();
    for (const r of dueños) if (r.memberId) deRecurso.set(r.id, r.memberId);

    const memberIds = [...new Set([...directo.values(), ...deRecurso.values()])];
    const [users, socios] = await Promise.all([
      userIds.size === 0 ? [] : d.user.findMany({ where: { organizationId, id: { in: [...userIds] } }, select: { id: true, fullName: true } }),
      memberIds.length === 0 ? [] : d.member.findMany({ where: { organizationId, id: { in: memberIds } }, select: { id: true, firstName: true, lastName: true, memberCode: true } }),
    ]);
    const socio = new Map(socios.map((m) => [m.id, m]));
    const usuario = new Map(users.map((u) => [u.id, u.fullName]));
    const members: AuditNames['members'] = new Map();
    const people: AuditNames['people'] = new Map();
    for (const e of entries) {
      const memberId = directo.get(e.id) ?? (e.resourceId ? deRecurso.get(e.resourceId) : undefined);
      const m = memberId ? socio.get(memberId) : undefined;
      if (m) members.set(e.id, { name: `${m.firstName} ${m.lastName}`.trim(), memberId: m.id, memberCode: m.memberCode ?? null });
      const persona = tipo(e.resourceType) === 'user' && e.resourceId ? usuario.get(e.resourceId) : undefined;
      if (persona) people.set(e.id, persona);
    }
    return { users: usuario, members, people };
  }

  /** Nombre y zona de cada sede (también las cerradas: sus asientos siguen ahí). */
  async branches(organizationId: string): Promise<Array<{ id: string; name: string; timezone: string | null }>> {
    return this.db.branch.findMany({ where: { organizationId }, select: { id: true, name: true, timezone: true } });
  }

  /**
   * QUIÉN HA ESCRITO en la bitácora en un periodo (20-12): el filtro «Persona»
   * sale de aquí, bajo el permiso de la bitácora, y no del directorio de
   * Personal (que una gerencia con Bitácora liberada puede no tener).
   */
  async actors(organizationId: string, opts: { branchIds?: readonly string[] | null | undefined; from?: Date | undefined; to?: Date | undefined }): Promise<Array<{ id: string; fullName: string; entries: number }>> {
    const grupos = await this.db.auditLog.groupBy({
      by: ['actorUserId'],
      where: {
        organizationId, actorUserId: { not: null },
        ...(opts.branchIds ? { branchId: { in: [...opts.branchIds] } } : {}),
        ...(opts.from || opts.to ? { at: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lt: opts.to } : {}) } } : {}),
      },
      _count: { _all: true },
    });
    const ids = grupos.map((g) => g.actorUserId).filter((x): x is string => !!x);
    if (ids.length === 0) return [];
    const users = await this.db.user.findMany({ where: { organizationId, id: { in: ids } }, select: { id: true, fullName: true } });
    const nombre = new Map(users.map((u) => [u.id, u.fullName]));
    return grupos
      .filter((g) => g.actorUserId && nombre.has(g.actorUserId))
      .map((g) => ({ id: g.actorUserId!, fullName: nombre.get(g.actorUserId!)!, entries: g._count._all }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'es'));
  }

  /**
   * ENTRADAS POR EXCEPCIÓN, RESUMIDAS (20-06): cuántas veces dejó pasar cada
   * persona en cada día de operación y sede, con el tope de su puesto
   * (`maxManualAccessGrantsPerShift`; el más permisivo de sus puestos, null =
   * sin tope). El día de operación hace de turno: el tope se compara con lo
   * que la persona dejó pasar ese día en esa sede.
   */
  async exceptionSummary(organizationId: string, opts: { branchIds?: readonly string[] | null | undefined; from?: Date | undefined; to?: Date | undefined }): Promise<Array<{
    businessDate: Date; actorUserId: string | null; actorName: string | null; branchId: string | null; count: number; limit: number | null;
  }>> {
    const grupos = await this.db.auditLog.groupBy({
      by: ['businessDate', 'actorUserId', 'branchId'],
      where: {
        organizationId, action: { in: [...AUDIT_SUMMARIZED] },
        ...(opts.branchIds ? { branchId: { in: [...opts.branchIds] } } : {}),
        ...(opts.from || opts.to ? { at: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lt: opts.to } : {}) } } : {}),
      },
      _count: { _all: true },
    });
    const ids = [...new Set(grupos.map((g) => g.actorUserId).filter((x): x is string => !!x))];
    if (grupos.length === 0) return [];
    const [users, topes] = await Promise.all([
      ids.length ? this.db.user.findMany({ where: { organizationId, id: { in: ids } }, select: { id: true, fullName: true } }) : [],
      ids.length ? this.db.$queryRaw<Array<{ userId: string; sinTope: boolean; tope: number | null }>>`
        SELECT ra."userId"::text AS "userId",
               bool_or(rls."maxManualAccessGrantsPerShift" IS NULL) AS "sinTope",
               max(rls."maxManualAccessGrantsPerShift")::int AS "tope"
          FROM role_assignments ra
          LEFT JOIN role_limit_sets rls ON rls."roleId" = ra."roleId" AND rls."organizationId" = ${organizationId}::uuid
         WHERE ra."userId"::text = ANY(${ids}) AND ra."revokedAt" IS NULL
         GROUP BY ra."userId"` : [],
    ]);
    const nombre = new Map(users.map((u) => [u.id, u.fullName]));
    const tope = new Map(topes.map((t) => [t.userId, t.sinTope ? null : t.tope]));
    return grupos
      .map((g) => ({
        businessDate: g.businessDate, actorUserId: g.actorUserId, actorName: g.actorUserId ? nombre.get(g.actorUserId) ?? null : null,
        branchId: g.branchId, count: g._count._all, limit: g.actorUserId ? tope.get(g.actorUserId) ?? null : null,
      }))
      .sort((a, b) => b.businessDate.getTime() - a.businessDate.getTime() || b.count - a.count);
  }
}
