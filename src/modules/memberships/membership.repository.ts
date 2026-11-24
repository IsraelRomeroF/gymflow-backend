import { conflict, uuidv7, paidThrough, type ChargeStatus, type MembershipStatus } from '@gymflow/core';
import { PrismaMembershipStatus, PrismaMembershipEventType, PrismaChargeType, PrismaChargeStatus, PrismaBillingModel } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { Prisma } from '@gymflow/db';
import { dondeSede } from '../../platform/db/filtro-de-sede.js';
import type { SedesDelDia } from '../../platform/time/business-calendar.js';

/** Puente entre el estado del DOMINIO y el enum generado. Son los mismos
 *  valores por construcción, y este mapa lo hace explícito en vez de
 *  confiarlo a un cast. */
const S = PrismaMembershipStatus;
const LIVE = [S.PENDING, S.TRIALING, S.ACTIVE, S.PAST_DUE, S.FROZEN];
const toPrisma = (status: MembershipStatus) => S[status];

export type MembershipRecord = {
  id: string;
  memberId: string;
  planId: string;
  soldAtBranchId: string | null;
  status: MembershipStatus;
  startDate: Date;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  billingAnchorDay: number;
  graceUntil: Date | null;
  autoRenew: boolean;
  frozenDaysUsedThisYear: number;
  frozenDaysUsedYear: number | null;
  frozenSince: Date | null;
  frozenUntil: Date | null;
  replacesMembershipId: string | null;
  cancellationReason: string | null;
  /** Precio pactado al vender (DM-05); null = precio vigente del plan en la sede de venta. */
  agreedPriceCents: bigint | null;
  /** «Conserva su precio» (D-19, bloque 3.6): un cambio de precio del plan no la toca salvo decisión. */
  priceProtected: boolean;
};

const SELECT = {
  id: true, memberId: true, planId: true, soldAtBranchId: true, status: true,
  startDate: true, currentPeriodStart: true, currentPeriodEnd: true,
  billingAnchorDay: true, graceUntil: true, autoRenew: true,
  frozenDaysUsedThisYear: true, frozenDaysUsedYear: true,
  frozenSince: true, frozenUntil: true, replacesMembershipId: true,
  cancellationReason: true, agreedPriceCents: true, priceProtected: true,
} as const;

export type MembershipEventRecord = {
  id: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  actorUserId: string | null;
  at: Date;
  payload: unknown;
};

export class MembershipRepository extends TenantRepository {
  async findById(id: string): Promise<MembershipRecord | null> {
    const row = await this.db.membership.findFirst({ where: this.scope({ id }), select: SELECT });
    return row as MembershipRecord | null;
  }

  /** La membresía VIGENTE del socio. Solo puede haber una (constraint parcial). */
  /** La venta que ya se hizo con esta clave (DM-08): el reintento la devuelve en vez de duplicarla. */
  async findBySaleKey(saleKey: string): Promise<MembershipRecord | null> {
    const row = await this.db.membership.findFirst({ where: this.scope({ saleKey }), select: SELECT });
    return row as MembershipRecord | null;
  }

  /** La membresía viva de MUCHOS socios en una consulta: el padrón del torniquete recorre miles. */
  async findLiveForMembers(memberIds: readonly string[]): Promise<Map<string, MembershipRecord>> {
    if (memberIds.length === 0) return new Map();
    const rows = await this.db.membership.findMany({ where: this.scope({ memberId: { in: [...memberIds] }, status: { in: LIVE } }), select: SELECT });
    return new Map((rows as MembershipRecord[]).map((m) => [m.memberId, m]));
  }

  async findLiveForMember(memberId: string): Promise<MembershipRecord | null> {
    const row = await this.db.membership.findFirst({
      where: this.scope({ memberId, status: { in: LIVE } }),
      select: SELECT,
    });
    return row as MembershipRecord | null;
  }

  /**
   * La membresía que decide la puerta: la viva o, si no hay, la SUSPENDIDA.
   * Suspendida no es "sin membresía": es alguien que debe y a quien
   * recepción puede cobrarle y dejar pasar. Tratarla como inexistente dejaba
   * al socio con adeudo sin salida en el mostrador.
   */
  async findCurrentForMember(memberId: string): Promise<MembershipRecord | null> {
    const row = await this.db.membership.findFirst({
      where: this.scope({ memberId, status: { in: [...LIVE, S.SUSPENDED] } }),
      select: SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return row as MembershipRecord | null;
  }

  /** D-14 (bloque 3.5): si al terminar su periodo se cobra otro igual o vence y se vuelve a vender. Solo en una membresía viva. */
  async setAutoRenew(id: string, autoRenew: boolean): Promise<MembershipRecord | null> {
    const r = await this.db.membership.updateMany({ where: this.scope({ id, status: { in: [...LIVE, S.SUSPENDED] } }), data: { autoRenew } });
    return r.count === 0 ? null : this.findById(id);
  }

  /**
   * D-14: las membresías de un plan PAGADO POR ADELANTADO que siguen vivas y
   * marcadas «se renueva sola»: las que nacieron así sin que nadie lo eligiera.
   * Con el plan y el socio, para listarlas antes de tocarlas.
   */
  async prepagosQueSeRenuevan(): Promise<Array<{
    id: string; memberId: string; memberCode: string; planName: string; status: string; currentPeriodEnd: Date; createdAt: Date; priceCents: bigint;
  }>> {
    const rows = await this.db.membership.findMany({
      where: this.scope({ autoRenew: true, status: { in: [...LIVE, S.SUSPENDED] }, plan: { billingModel: PrismaBillingModel.PREPAID_PERIOD } }),
      select: {
        id: true, memberId: true, status: true, currentPeriodEnd: true, createdAt: true, agreedPriceCents: true,
        member: { select: { memberCode: true } }, plan: { select: { name: true, priceCents: true } },
      },
      orderBy: { currentPeriodEnd: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id, memberId: r.memberId, memberCode: r.member.memberCode, planName: r.plan.name, status: r.status,
      currentPeriodEnd: r.currentPeriodEnd, createdAt: r.createdAt, priceCents: r.agreedPriceCents ?? r.plan.priceCents,
    }));
  }

  /** Historial completo: los periodos y sus huecos son visibles a propósito. */
  async listForMember(memberId: string): Promise<MembershipRecord[]> {
    const rows = await this.db.membership.findMany({
      where: this.scope({ memberId }),
      select: SELECT,
      orderBy: { startDate: 'desc' },
    });
    return rows as MembershipRecord[];
  }

  async list(opts: { status?: MembershipStatus | undefined; limit?: number | undefined } = {}): Promise<MembershipRecord[]> {
    const rows = await this.db.membership.findMany({
      where: this.scope(opts.status ? { status: toPrisma(opts.status) } : {}),
      select: SELECT,
      orderBy: { currentPeriodEnd: 'asc' },
      take: opts.limit ?? 50,
    });
    return rows as MembershipRecord[];
  }

  async create(input: {
    memberId: string; planId: string; soldAtBranchId: string | null;
    startDate: Date; periodStart: Date; periodEnd: Date; billingAnchorDay: number;
    autoRenew: boolean; branchIds: string[]; createdByUserId: string; saleKey?: string | null;
    agreedPriceCents?: bigint | null;
    /** Nace conservando su precio (D-19): se pactó uno distinto al de lista. Exige `agreedPriceCents`. */
    priceProtected?: boolean;
  }): Promise<MembershipRecord> {
    const id = uuidv7();
    const row = await this.db.$transaction(async (tx) => {
      const created = await tx.membership.create({
        data: {
          id,
          organizationId: this.organizationId,
          memberId: input.memberId,
          planId: input.planId,
          soldAtBranchId: input.soldAtBranchId,
          status: S.PENDING,
          startDate: input.startDate,
          currentPeriodStart: input.periodStart,
          currentPeriodEnd: input.periodEnd,
          billingAnchorDay: input.billingAnchorDay,
          autoRenew: input.autoRenew,
          saleKey: input.saleKey ?? null,
          agreedPriceCents: input.agreedPriceCents ?? null,
          ...(input.priceProtected && input.agreedPriceCents != null
            ? { priceProtected: true, priceProtectedReason: 'Se pactó un precio distinto al de lista' } : {}),
          createdByUserId: input.createdByUserId,
        },
        select: SELECT,
      });
      if (input.branchIds.length > 0) {
        await tx.membershipBranchAccess.createMany({
          data: input.branchIds.map((branchId) => ({
            membershipId: id, branchId, organizationId: this.organizationId,
          })),
          skipDuplicates: true,
        });
      }
      return created;
    });
    return row as MembershipRecord;
  }

  /**
   * Aplica una transición y deja constancia, en UNA transacción.
   *
   * El evento no es un log técnico: es la historia del contrato, y es lo que
   * permite explicar seis meses después por qué a un socio se le extendió el
   * periodo o se le suspendió el acceso.
   */
  async transition(input: {
    membershipId: string;
    fromStatus: MembershipStatus;
    toStatus: MembershipStatus;
    eventType: string;
    data?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    reason?: string | null;
    actorUserId?: string | null;
    branchId?: string | null;
    businessDate: Date;
    /**
     * Si se indica, la transición solo aplica si el periodo sigue empezando
     * ahí. Es lo que vuelve idempotente una renovación: RENEW va de ACTIVE a
     * ACTIVE, así que el estado solo no distingue "ya se renovó".
     */
    expectedPeriodStart?: Date;
  }): Promise<MembershipRecord> {
    return this.db.$transaction(async (tx) => {
      // Actualiza SOLO si sigue en el estado esperado: evita que dos
      // procesos concurrentes apliquen transiciones contradictorias.
      const { count } = await tx.membership.updateMany({
        where: {
          id: input.membershipId, organizationId: this.organizationId, status: toPrisma(input.fromStatus),
          ...(input.expectedPeriodStart ? { currentPeriodStart: input.expectedPeriodStart } : {}),
        },
        data: { status: toPrisma(input.toStatus), ...(input.data ?? {}) } as Prisma.MembershipUpdateManyMutationInput,
      });
      if (count === 0) {
        throw conflict(input.expectedPeriodStart
          ? 'La membresía cambió mientras se procesaba (¿ya se renovó?). Recarga y revisa'
          : `La membresía ya no está en estado ${input.fromStatus}`);
      }

      await tx.membershipEvent.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          membershipId: input.membershipId,
          branchId: input.branchId ?? null,
          eventType: input.eventType as PrismaMembershipEventType,
          fromStatus: toPrisma(input.fromStatus),
          toStatus: toPrisma(input.toStatus),
          payload: (input.payload ?? {}) as Prisma.InputJsonValue,
          actorUserId: input.actorUserId ?? null,
          reason: input.reason ?? null,
          businessDate: input.businessDate,
        },
      });

      const updated = await tx.membership.findFirstOrThrow({
        where: { id: input.membershipId }, select: SELECT,
      });
      return updated as MembershipRecord;
    });
  }

  async events(membershipId: string): Promise<MembershipEventRecord[]> {
    const rows = await this.db.membershipEvent.findMany({
      where: this.scope({ membershipId }),
      select: {
        id: true, eventType: true, fromStatus: true, toStatus: true,
        reason: true, actorUserId: true, at: true, payload: true,
      },
      orderBy: { at: 'desc' },
    });
    return rows as MembershipEventRecord[];
  }

  async branchAccess(membershipId: string): Promise<string[]> {
    const rows = await this.db.membershipBranchAccess.findMany({
      where: { membershipId, organizationId: this.organizationId },
      select: { branchId: true },
    });
    return rows.map((r) => r.branchId);
  }

  // ── Consultas para los jobs ───────────────────────────────────────────────

  /**
   * Vigentes con autorrenovación cuyo periodo ya terminó: toca el siguiente.
   * La visita suelta NUNCA se renueva, diga lo que diga su bandera (4-01): la
   * que nació con «se renueva sola» fabricaba una cuota al día siguiente.
   */
  async dueForRenewal(today: Date, limit = 500, sedes: SedesDelDia | null = null): Promise<MembershipRecord[]> {
    const rows = await this.db.membership.findMany({
      where: this.scope({
        status: S.ACTIVE, autoRenew: true, currentPeriodEnd: { lte: today }, AND: dondeSede('soldAtBranchId', sedes),
        plan: { billingModel: { notIn: [PrismaBillingModel.DAY_PASS, PrismaBillingModel.VISIT_PACK] } },
      }),
      select: SELECT, take: limit, orderBy: [{ currentPeriodEnd: 'asc' }, { id: 'asc' }],
    });
    return rows as MembershipRecord[];
  }

  async dueForSuspension(today: Date, limit = 500, sedes: SedesDelDia | null = null): Promise<MembershipRecord[]> {
    const rows = await this.db.membership.findMany({
      where: this.scope({ status: S.PAST_DUE, graceUntil: { lt: today }, AND: dondeSede('soldAtBranchId', sedes) }),
      select: SELECT, take: limit,
    });
    return rows as MembershipRecord[];
  }

  async dueForUnfreeze(today: Date, limit = 500, sedes: SedesDelDia | null = null): Promise<MembershipRecord[]> {
    const rows = await this.db.membership.findMany({
      where: this.scope({ status: S.FROZEN, frozenUntil: { lte: today }, AND: dondeSede('soldAtBranchId', sedes) }),
      select: SELECT, take: limit,
    });
    return rows as MembershipRecord[];
  }

  /**
   * Membresías VIVAS de socios ARCHIVADOS.
   *
   * Archivar un socio no cancelaba su membresía. El resultado es una membresía
   * fantasma que infla el MRR y —lo grave— **abriría el torniquete**. El motor
   * de acceso ya lo deniega por su cuenta, pero dejar el dato torcido haría
   * que cada reporte mintiera.
   */
  async liveForArchivedMembers(limit = 500, sedes: SedesDelDia | null = null): Promise<MembershipRecord[]> {
    const rows = await this.db.membership.findMany({
      where: this.scope({ status: { in: LIVE }, member: { deletedAt: { not: null } }, AND: dondeSede('soldAtBranchId', sedes) }),
      select: SELECT, take: limit,
    });
    return rows as MembershipRecord[];
  }

  /** Ventas que nunca se cobraron: PENDING desde hace más de `days` días (DM-07). */
  async pendingOlderThan(today: Date, days: number, limit = 500, sedes: SedesDelDia | null = null): Promise<MembershipRecord[]> {
    const limite = new Date(today.getTime() - days * 86_400_000);
    const rows = await this.db.membership.findMany({
      // Solo la venta que de verdad NO se cobró: una pendiente con sus cargos
      // pagados es una activación que no ocurrió, y cancelarla borraría una
      // membresía pagada. Esa la resuelve la reconciliación, no este job.
      where: this.scope({
        status: S.PENDING, createdAt: { lt: limite }, AND: dondeSede('soldAtBranchId', sedes),
        charges: { some: { chargeType: { in: [PrismaChargeType.MEMBERSHIP_PERIOD, PrismaChargeType.SIGNUP_FEE] }, status: { in: [PrismaChargeStatus.OPEN, PrismaChargeStatus.OVERDUE, PrismaChargeStatus.PARTIALLY_PAID] } } },
      }),
      select: SELECT, take: limit, orderBy: { createdAt: 'asc' },
    });
    return rows as MembershipRecord[];
  }

  /** Suspendidas que agotaron la ventana de recuperación: `days` días sin pagar (DM-07). */
  async suspendedOlderThan(today: Date, days: number, limit = 500, sedes: SedesDelDia | null = null): Promise<MembershipRecord[]> {
    const limite = new Date(today.getTime() - days * 86_400_000);
    const rows = await this.db.membership.findMany({
      where: this.scope({ status: S.SUSPENDED, OR: [{ graceUntil: { lt: limite } }, { graceUntil: null, updatedAt: { lt: limite } }], AND: dondeSede('soldAtBranchId', sedes) }),
      select: SELECT, take: limit,
    });
    return rows as MembershipRecord[];
  }

  /** Vigentes que terminaron su periodo y no se renuevan: los prepagos sin renovación y TODA visita suelta (vence esa noche). */
  async dueForExpiry(today: Date, limit = 500, sedes: SedesDelDia | null = null): Promise<MembershipRecord[]> {
    const rows = await this.db.membership.findMany({
      where: this.scope({
        status: S.ACTIVE, currentPeriodEnd: { lte: today }, AND: dondeSede('soldAtBranchId', sedes),
        OR: [{ autoRenew: false }, { plan: { billingModel: PrismaBillingModel.DAY_PASS } }],
      }),
      select: SELECT, take: limit,
    });
    return rows as MembershipRecord[];
  }

  // ── Hasta dónde está pagado (3-01, 4-03) ──────────────────────────────────

  /**
   * «Pagado hasta» de cada membresía: el último día que cubren sus cuotas de
   * periodo SALDADAS, con la regla única del núcleo (`paidThrough`). Una
   * consulta para todas. Sin cuotas saldadas, `null`.
   */
  async paidThroughFor(membershipIds: readonly string[]): Promise<Map<string, Date | null>> {
    const salida = new Map<string, Date | null>(membershipIds.map((id) => [id, null]));
    if (membershipIds.length === 0) return salida;
    const [cuotas, periodos] = await Promise.all([
      this.db.charge.findMany({
        where: this.scope({
          membershipId: { in: [...membershipIds] }, chargeType: PrismaChargeType.MEMBERSHIP_PERIOD,
          status: { not: PrismaChargeStatus.VOID }, periodStart: { not: null }, periodEnd: { not: null },
        }),
        select: { membershipId: true, periodStart: true, periodEnd: true, status: true, amountCents: true, allocatedCents: true, adjustedCents: true },
      }),
      // El periodo en curso: un congelamiento lo recorre sin tocar su cuota.
      this.db.membership.findMany({
        where: this.scope({ id: { in: [...membershipIds] } }),
        select: { id: true, currentPeriodStart: true, currentPeriodEnd: true },
      }),
    ]);
    const actual = new Map(periodos.map((p) => [p.id, { start: p.currentPeriodStart, end: p.currentPeriodEnd }]));
    const porMembresia = new Map<string, typeof cuotas>();
    for (const c of cuotas) {
      if (!c.membershipId) continue;
      porMembresia.set(c.membershipId, [...(porMembresia.get(c.membershipId) ?? []), c]);
    }
    for (const [id, xs] of porMembresia) {
      salida.set(id, paidThrough(xs.map((c) => ({
        periodStart: c.periodStart!, periodEnd: c.periodEnd!, status: c.status as ChargeStatus,
        amountCents: c.amountCents, allocatedCents: c.allocatedCents, adjustedCents: c.adjustedCents,
      })), actual.get(id)));
    }
    return salida;
  }

  /**
   * «Pagado hasta» de la membresía que decide la puerta de cada socio (la
   * viva o, si no hay, la suspendida; la más reciente), para el resumen de
   * acceso de muchos socios a la vez.
   */
  async paidThroughForMembers(memberIds: readonly string[]): Promise<Map<string, Date | null>> {
    if (memberIds.length === 0) return new Map();
    const rows = await this.db.membership.findMany({
      where: this.scope({ memberId: { in: [...memberIds] }, status: { in: [...LIVE, S.SUSPENDED] } }),
      select: { id: true, memberId: true },
      orderBy: { startDate: 'desc' },
    });
    const actual = new Map<string, string>();
    for (const r of rows) if (!actual.has(r.memberId)) actual.set(r.memberId, r.id);
    const pagado = await this.paidThroughFor([...actual.values()]);
    return new Map([...actual].map(([memberId, membershipId]) => [memberId, pagado.get(membershipId) ?? null]));
  }
}
