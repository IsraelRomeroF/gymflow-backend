import {
  uuidv7,
  type AccessOutcome, type CredentialKind, type DenialReason,
} from '@gymflow/core';
import { PrismaAccessOutcome, PrismaCredentialKind, PrismaGatewayStatus } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

const O = PrismaAccessOutcome;
const K = PrismaCredentialKind;
const G = PrismaGatewayStatus;

export type GatewayRecord = {
  id: string;
  branchId: string;
  code: string;
  name: string;
  status: 'ONLINE' | 'DEGRADED' | 'OFFLINE';
  policyVersion: string | null;
  rosterVersion: bigint | null;
  lastHeartbeatAt: Date | null;
};

const GATEWAY_SELECT = {
  id: true, branchId: true, code: true, name: true, status: true,
  policyVersion: true, rosterVersion: true, lastHeartbeatAt: true,
} as const;

export type DecisionRecord = {
  id: string;
  branchId: string;
  gatewayId: string | null;
  memberId: string | null;
  outcome: AccessOutcome;
  denialReason: string | null;
  credentialKind: CredentialKind;
  policyVersion: string;
  decidedOffline: boolean;
  overrideReason: string | null;
  /** Quién registró la excepción (entrada por el mostrador o paso concedido). */
  overriddenByUserId: string | null;
  /** En una concesión: el rechazo que resuelve (5-10). Un rechazo se resuelve una sola vez. */
  resolvesDecisionId: string | null;
  /** Reentrada (D-07): ya había entrado hoy en esa sede; no nació otra asistencia ni se descontó visita. */
  reentry: boolean;
  at: Date;
};

const DECISION_SELECT = {
  id: true, branchId: true, gatewayId: true, memberId: true, outcome: true,
  denialReason: true, credentialKind: true, policyVersion: true,
  decidedOffline: true, overrideReason: true, overriddenByUserId: true,
  resolvesDecisionId: true, reentry: true, at: true,
} as const;

export class AccessRepository extends TenantRepository {
  /**
   * CLASE SUELTA PAGADA (2026-10-09): la reserva viva del socio cuya clase
   * empieza dentro de una hora o ya está en curso, y cuyo cargo está PAGADO.
   * Es lo que deja entrar a quien no tiene plan.
   */
  async paseDeClase(memberId: string, ahora: Date): Promise<{ branchId: string; className: string }[]> {
    return this.db.$queryRaw<Array<{ branchId: string; className: string }>>`
      SELECT s."branchId", t.name AS "className"
      FROM class_bookings b
      JOIN class_schedules s ON s.id = b."classScheduleId" AND s."organizationId" = b."organizationId"
      JOIN class_types t ON t.id = s."classTypeId" AND t."organizationId" = s."organizationId"
      JOIN charges c ON c.id = b."chargeId" AND c."organizationId" = b."organizationId"
      WHERE b."organizationId" = ${this.organizationId}::uuid AND b."memberId" = ${memberId}::uuid
        AND b.status = 'BOOKED' AND s.status = 'SCHEDULED' AND c.status = 'PAID'
        AND s."startsAt" - interval '60 minutes' <= ${ahora} AND s."endsAt" >= ${ahora}
      ORDER BY s."startsAt"`;
  }

  // ── Gateways ──────────────────────────────────────────────────────────────

  async listGateways(branchId?: string): Promise<GatewayRecord[]> {
    const rows = await this.db.accessGateway.findMany({
      where: this.scope({ deletedAt: null, ...(branchId ? { branchId } : {}) }),
      select: GATEWAY_SELECT,
      orderBy: [{ branchId: 'asc' }, { code: 'asc' }],
    });
    return rows as GatewayRecord[];
  }

  async findGateway(id: string): Promise<GatewayRecord | null> {
    const row = await this.db.accessGateway.findFirst({
      where: this.scope({ id, deletedAt: null }), select: GATEWAY_SELECT,
    });
    return row as GatewayRecord | null;
  }

  async createGateway(input: { branchId: string; code: string; name: string }): Promise<GatewayRecord> {
    const row = await this.db.accessGateway.create({
      data: {
        id: uuidv7(),
        organizationId: this.organizationId,
        branchId: input.branchId,
        code: input.code.toUpperCase(),
        name: input.name,
      },
      select: GATEWAY_SELECT,
    });
    return row as GatewayRecord;
  }

  /**
   * Latido del gateway.
   *
   * Trae la versión de política que ejecuta. Es el dato que permite detectar
   * que la puerta y el servidor no están decidiendo con las mismas reglas —una
   * divergencia que, sin esta comparación, ocurre en silencio.
   */
  async heartbeat(input: {
    gatewayId: string;
    policyVersion: string;
    rosterVersion: bigint | null;
    status: 'ONLINE' | 'DEGRADED' | 'OFFLINE';
  }): Promise<GatewayRecord | null> {
    const res = await this.db.accessGateway.updateMany({
      where: this.scope({ id: input.gatewayId, deletedAt: null }),
      data: {
        policyVersion: input.policyVersion,
        rosterVersion: input.rosterVersion,
        status: G[input.status],
        lastHeartbeatAt: new Date(),
      },
    });
    return res.count === 0 ? null : this.findGateway(input.gatewayId);
  }

  // ── Decisiones y asistencias ──────────────────────────────────────────────

  /**
   * Registra la decisión y, si entró, la asistencia. En UNA transacción.
   *
   * Son dos hechos distintos —lo que la política resolvió y que alguien entró
   * de verdad— pero nacen juntos. Separar las escrituras dejaría decisiones
   * permitidas sin su asistencia, y la pregunta "¿cuánta gente entró hoy?"
   * dejaría de tener respuesta fiable.
   */
  async record(input: {
    branchId: string;
    gatewayId: string | null;
    memberId: string | null;
    outcome: AccessOutcome;
    denialReason: DenialReason | null;
    credentialKind: CredentialKind;
    policyVersion: string;
    decidedOffline: boolean;
    overriddenByUserId?: string | null;
    overrideReason?: string | null;
    /**
     * Evidencia del reconocimiento biométrico (ADR-032).
     *
     * Sin esto, un acierto y un falso positivo son indistinguibles después.
     * Es lo único que permite calibrar el umbral con datos reales en vez de
     * heredarlo, y lo único que permite defender una decisión meses más tarde.
     */
    matchScore?: number | null;
    matchMargin?: number | null;
    livenessMode?: string | null;
    livenessPassed?: boolean | null;
    businessDate: Date;
    /** Clave del intento: el mismo intento repetido es la misma decisión (UXA-01). */
    requestKey?: string | null;
    /**
     * Concesión: el rechazo que resuelve (5-10). La base admite UNA concesión
     * por rechazo (`access_decisions_resolves_key`): la segunda revienta aquí
     * con una violación de unicidad, aunque llegue al mismo tiempo que la primera.
     */
    resolvesDecisionId?: string | null;
    /**
     * REENTRADA (D-07): ya tiene hoy una entrada contada en esta sede. La
     * decisión se registra (quién, cuándo, por dónde), pero NO nace otra
     * asistencia: «entradas de hoy» cuenta personas, no pasos.
     */
    reentry?: boolean;
  }): Promise<{ decision: DecisionRecord; attendanceId: string | null }> {
    return this.db.$transaction(async (tx) => {
      const decision = await tx.accessDecision.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          branchId: input.branchId,
          gatewayId: input.gatewayId,
          memberId: input.memberId,
          outcome: O[input.outcome],
          denialReason: input.denialReason,
          credentialKind: K[input.credentialKind],
          policyVersion: input.policyVersion,
          decidedOffline: input.decidedOffline,
          overriddenByUserId: input.overriddenByUserId ?? null,
          overrideReason: input.overrideReason ?? null,
          matchScore: input.matchScore ?? null,
          matchMargin: input.matchMargin ?? null,
          livenessMode: input.livenessMode ?? null,
          livenessPassed: input.livenessPassed ?? null,
          businessDate: input.businessDate,
          requestKey: input.requestKey ?? null,
          resolvesDecisionId: input.resolvesDecisionId ?? null,
          reentry: input.outcome === 'GRANTED' && (input.reentry ?? false),
        },
        select: DECISION_SELECT,
      });

      let attendanceId: string | null = null;
      if (input.outcome === 'GRANTED' && input.memberId && !input.reentry) {
        const asistencia = await tx.attendanceEvent.create({
          data: {
            id: uuidv7(),
            organizationId: this.organizationId,
            branchId: input.branchId,
            memberId: input.memberId,
            accessDecisionId: decision.id,
            businessDate: input.businessDate,
          },
          select: { id: true },
        });
        attendanceId = asistencia.id;
      }

      return { decision: decision as DecisionRecord, attendanceId };
    });
  }

  async findDecision(id: string): Promise<DecisionRecord | null> {
    const row = await this.db.accessDecision.findFirst({
      where: this.scope({ id }), select: DECISION_SELECT,
    });
    return row as DecisionRecord | null;
  }

  /** La concesión que ya resolvió ese rechazo, si la hay (5-10). */
  async resolucionDe(decisionId: string): Promise<DecisionRecord | null> {
    const row = await this.db.accessDecision.findFirst({
      where: this.scope({ resolvesDecisionId: decisionId }), select: DECISION_SELECT,
    });
    return row as DecisionRecord | null;
  }

  /** Qué rechazos de la lista ya están resueltos, y por cuál concesión. Una consulta para todos. */
  async resolucionesDe(decisionIds: readonly string[]): Promise<Map<string, DecisionRecord>> {
    const ids = [...new Set(decisionIds)];
    if (ids.length === 0) return new Map();
    const rows = await this.db.accessDecision.findMany({
      where: this.scope({ resolvesDecisionId: { in: ids } }), select: DECISION_SELECT,
    }) as DecisionRecord[];
    return new Map(rows.map((r) => [r.resolvesDecisionId!, r]));
  }

  /** Nombres del personal que registró excepciones: el historial dice quién, no un identificador. */
  async nombresDePersonal(ids: readonly string[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids.filter(Boolean))];
    if (unicos.length === 0) return new Map();
    const us = await this.db.user.findMany({ where: { id: { in: unicos }, organizationId: this.organizationId }, select: { id: true, fullName: true } });
    return new Map(us.map((u) => [u.id, u.fullName]));
  }

  async listDecisions(opts: {
    branchId?: string | undefined;
    memberId?: string | undefined;
    outcome?: AccessOutcome | undefined;
    limit?: number | undefined;
    /** Solo lo posterior a este instante: el monitor pide lo nuevo, no todo. */
    since?: Date | undefined;
  } = {}): Promise<DecisionRecord[]> {
    const rows = await this.db.accessDecision.findMany({
      where: this.scope({
        ...(opts.branchId ? { branchId: opts.branchId } : {}),
        ...(opts.memberId ? { memberId: opts.memberId } : {}),
        ...(opts.outcome ? { outcome: O[opts.outcome] } : {}),
        ...(opts.since ? { at: { gt: opts.since } } : {}),
      }),
      select: DECISION_SELECT,
      orderBy: { at: 'desc' },
      take: opts.limit ?? 100,
    });
    return rows as DecisionRecord[];
  }

  /** Motivos de rechazo agrupados: es lo que alimenta la retención (§9). */
  async denialBreakdown(from: Date, to: Date, branchId: string | null = null): Promise<Array<{ reason: string; total: number }>> {
    return this.db.$queryRaw`
      SELECT "denialReason" AS reason, COUNT(*)::int AS total
      FROM "access_decisions"
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND (${branchId}::uuid IS NULL OR "branchId" = ${branchId}::uuid)
        AND "outcome" = 'DENIED'
        AND "businessDate" >= ${from}::date AND "businessDate" < ${to}::date
      GROUP BY "denialReason"
      ORDER BY total DESC`;
  }

  /**
   * D-07 · La entrada que YA CONTÓ hoy en esa sede (la primera asistencia del
   * día de operación), y de qué paquete descontó su visita, si descontó. Con
   * ella, lo que pase después es una reentrada. `null` = hoy no ha entrado ahí.
   */
  async entradaContadaDeHoy(memberId: string, branchId: string, businessDate: Date): Promise<{ attendanceId: string; visitPackId: string | null } | null> {
    const filas = await this.db.$queryRaw<Array<{ attendanceId: string; visitPackId: string | null }>>`
      SELECT a."id" AS "attendanceId", v."visitPackId"
        FROM "attendance_events" a
        LEFT JOIN "visit_ledger_entries" v
          ON v."organizationId" = a."organizationId" AND v."attendanceEventId" = a."id" AND v."delta" < 0
       WHERE a."organizationId" = ${this.organizationId}::uuid AND a."memberId" = ${memberId}::uuid
         AND a."branchId" = ${branchId}::uuid AND a."businessDate" = ${businessDate}::date
       ORDER BY a."at" ASC
       LIMIT 1`;
    return filas[0] ?? null;
  }

  /**
   * El mismo candado de `withMemberLock`, tomado DENTRO de la transacción en
   * curso (la concesión sobre un rechazo corre en su propia unidad): así «¿ya
   * entró hoy?» se lee y se escribe sin que otro paso del mismo socio se cuele.
   */
  async candadoDelSocio(memberId: string): Promise<void> {
    await this.db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`access:${this.organizationId}:${memberId}`}, 0))`;
  }

  /**
   * Serializa los intentos de UN socio: dos pasos simultáneos (dos clics, dos
   * sedes, un reintento) ya no leen el mismo saldo ni el mismo "último paso"
   * a la vez. El candado vive lo que dure `fn` y se suelta solo.
   */
  async withMemberLock<T>(memberId: string, fn: () => Promise<T>): Promise<T> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`access:${this.organizationId}:${memberId}`}, 0))`;
      return fn();
    }, { timeout: 15_000, maxWait: 10_000 });
  }

  /** El intento ya registrado con esa clave, con su asistencia y si consumió visita. */
  async findByRequestKey(requestKey: string): Promise<{ decision: DecisionRecord; attendanceId: string | null; consumedVisit: boolean } | null> {
    const decision = await this.db.accessDecision.findFirst({
      where: this.scope({ requestKey }), select: DECISION_SELECT,
    });
    if (!decision) return null;
    const asistencia = await this.db.attendanceEvent.findFirst({ where: { organizationId: this.organizationId, accessDecisionId: decision.id }, select: { id: true } });
    // El consumo se liga a la ASISTENCIA (5-24). El id de la decisión se sigue
    // mirando por las filas escritas antes de la corrección.
    const consumo = await this.db.visitLedgerEntry.count({
      where: { organizationId: this.organizationId, attendanceEventId: { in: asistencia ? [asistencia.id, decision.id] : [decision.id] } },
    });
    return { decision: decision as DecisionRecord, attendanceId: asistencia?.id ?? null, consumedVisit: consumo > 0 };
  }

  async credentialUsedSince(memberId: string, since: Date): Promise<boolean> {
    const n = await this.db.accessDecision.count({
      where: this.scope({ memberId, outcome: O.GRANTED, at: { gte: since } }),
    });
    return n > 0;
  }
}
