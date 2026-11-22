import { uuidv7, type PlannedOccurrence } from '@gymflow/core';
import {
  PrismaClassBookingSource, PrismaClassBookingStatus, PrismaClassOccurrenceStatus,
} from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';

const B = PrismaClassBookingStatus;
const O = PrismaClassOccurrenceStatus;
const SRC = PrismaClassBookingSource;

export type ClassTypeRecord = {
  id: string; name: string; description: string | null;
  defaultDurationMin: number; defaultCapacity: number;
  dropInPriceCents: bigint; isActive: boolean;
  /** ¿Puede ir incluida en un plan? Si no, siempre se paga suelta (2026-10-09). */
  includableInPlans: boolean;
};

export type ScheduleRecord = {
  id: string; branchId: string; classTypeId: string; templateId: string | null;
  coachUserId: string | null; room: string | null;
  startsAt: Date; endsAt: Date; businessDate: Date;
  capacity: number; bookedCount: number;
  status: 'SCHEDULED' | 'CANCELED' | 'CLOSED';
  wallTimeResolution: string;
};

export type BookingRecord = {
  id: string; classScheduleId: string; memberId: string; branchId: string;
  status: 'BOOKED' | 'CANCELED' | 'ATTENDED' | 'NO_SHOW';
  chargeId: string | null; bookedAt: Date; canceledAt: Date | null;
  lateCancel: boolean; checkedInAt: Date | null;
};

const TYPE_SELECT = {
  id: true, name: true, description: true, defaultDurationMin: true,
  defaultCapacity: true, dropInPriceCents: true, isActive: true, includableInPlans: true,
} as const;

const SCHEDULE_SELECT = {
  id: true, branchId: true, classTypeId: true, templateId: true,
  coachUserId: true, room: true, startsAt: true, endsAt: true, businessDate: true,
  capacity: true, bookedCount: true, status: true, wallTimeResolution: true,
} as const;

const BOOKING_SELECT = {
  id: true, classScheduleId: true, memberId: true, branchId: true, status: true,
  chargeId: true, bookedAt: true, canceledAt: true, lateCancel: true, checkedInAt: true,
} as const;

/** El cargo de la clase suelta de una reserva, con lo necesario para saber si se debe (11-03). */
export type BookingCharge = { status: string; amountCents: bigint; allocatedCents: bigint; adjustedCents: bigint };
const CHARGE_OF_BOOKING = { status: true, amountCents: true, allocatedCents: true, adjustedCents: true } as const;

export type BookingWithPayment = BookingRecord & { source: 'PORTAL' | 'FRONT_DESK'; charge: BookingCharge | null };

/** Las cinco reglas que guarda `class_settings`, con quién y cuándo las cambió. */
export type ClassSettingsRecord = {
  maxDaysAhead: number; cancelCutoffMinutes: number; noShowWindowDays: number;
  noShowsBeforeBlock: number; blockDays: number; updatedAt: Date; updatedByUserId: string | null;
};
const SETTINGS_SELECT = {
  maxDaysAhead: true, cancelCutoffMinutes: true, noShowWindowDays: true,
  noShowsBeforeBlock: true, blockDays: true, updatedAt: true, updatedByUserId: true,
} as const;

export type ClassPauseRecord = {
  id: string; branchId: string | null; fromDate: Date; toDate: Date; reason: string;
  createdByUserId: string | null; createdAt: Date; endedAt: Date | null;
};
const PAUSE_SELECT = {
  id: true, branchId: true, fromDate: true, toDate: true, reason: true,
  createdByUserId: true, createdAt: true, endedAt: true,
} as const;

export type TemplateRecord = {
  id: string; branchId: string; classTypeId: string; coachUserId: string | null; room: string | null;
  effectiveFrom: Date; effectiveTo: Date | null; isActive: boolean;
  slots: Array<{ weekday: number; startMinute: number; durationMin: number; capacity: number }>;
};

export class ClassRepository extends TenantRepository {
  /** Para la pantalla de Módulos: qué hay vivo antes de apagar Clases. */
  async usage(branchId?: string): Promise<{ types: number; upcomingSessions: number; futureBookings: number }> {
    const ahora = new Date();
    const proximas = { startsAt: { gt: ahora }, status: 'SCHEDULED' as const, ...(branchId ? { branchId } : {}) };
    const [types, upcomingSessions, futureBookings] = await Promise.all([
      this.db.classType.count({ where: this.scope({ isActive: true, deletedAt: null }) }),
      this.db.classSchedule.count({ where: this.scope(proximas) }),
      this.db.classBooking.count({ where: this.scope({ status: 'BOOKED' as const, classSchedule: proximas }) }),
    ]);
    return { types, upcomingSessions, futureBookings };
  }

  // ── Catálogo ──────────────────────────────────────────────────────────────

  async listTypes(includeInactive = false): Promise<ClassTypeRecord[]> {
    const rows = await this.db.classType.findMany({
      where: this.scope(includeInactive ? { deletedAt: null } : { deletedAt: null, isActive: true }),
      select: TYPE_SELECT,
      orderBy: { name: 'asc' },
    });
    return rows as ClassTypeRecord[];
  }

  async findType(id: string): Promise<ClassTypeRecord | null> {
    const row = await this.db.classType.findFirst({
      where: this.scope({ id, deletedAt: null }), select: TYPE_SELECT,
    });
    return row as ClassTypeRecord | null;
  }

  async createType(input: {
    name: string; description?: string | null | undefined;
    defaultDurationMin: number; defaultCapacity: number; dropInPriceCents: bigint; includableInPlans?: boolean | undefined;
  }): Promise<ClassTypeRecord> {
    const row = await this.db.classType.create({
      data: {
        id: uuidv7(),
        organizationId: this.organizationId,
        name: input.name,
        description: input.description ?? null,
        defaultDurationMin: input.defaultDurationMin,
        defaultCapacity: input.defaultCapacity,
        dropInPriceCents: input.dropInPriceCents,
        includableInPlans: input.includableInPlans ?? true,
      },
      select: TYPE_SELECT,
    });
    return row as ClassTypeRecord;
  }

  async updateType(id: string, patch: {
    name?: string; description?: string | null; defaultDurationMin?: number;
    defaultCapacity?: number; dropInPriceCents?: bigint; isActive?: boolean; includableInPlans?: boolean;
  }): Promise<ClassTypeRecord | null> {
    const { count } = await this.db.classType.updateMany({ where: this.scope({ id, deletedAt: null }), data: patch });
    return count === 0 ? null : this.findType(id);
  }

  // ── Plantillas ────────────────────────────────────────────────────────────

  /** Horario semanal vigente, con sus bloques. */
  async templateBranch(id: string): Promise<string | null | undefined> {
    const t = await this.db.classTemplate.findFirst({ where: this.scope({ id }), select: { branchId: true } });
    return t ? t.branchId : undefined;
  }

  /**
   * Quién imparte (2026-10-09): el horario y sus clases que aún no empiezan.
   * Las pasadas conservan a quien la dio.
   */
  async setTemplateCoach(templateId: string, coachUserId: string | null, desde: Date): Promise<number> {
    await this.db.classTemplate.updateMany({ where: this.scope({ id: templateId }), data: { coachUserId } });
    const { count } = await this.db.classSchedule.updateMany({ where: this.scope({ templateId, startsAt: { gt: desde } }), data: { coachUserId } });
    return count;
  }

  /** Quién imparte UNA clase (un suplente, por ejemplo). */
  async setScheduleCoach(scheduleId: string, coachUserId: string | null): Promise<boolean> {
    const { count } = await this.db.classSchedule.updateMany({ where: this.scope({ id: scheduleId }), data: { coachUserId } });
    return count === 1;
  }

  async listTemplates(opts: { branchId?: string | undefined; classTypeId?: string | undefined } = {}) {
    return this.db.classTemplate.findMany({
      where: this.scope({
        isActive: true,
        ...(opts.branchId ? { branchId: opts.branchId } : {}),
        ...(opts.classTypeId ? { classTypeId: opts.classTypeId } : {}),
      }),
      select: {
        id: true, branchId: true, classTypeId: true, coachUserId: true, room: true,
        effectiveFrom: true, effectiveTo: true,
        slots: {
          select: { weekday: true, startMinute: true, durationMin: true, capacity: true },
          orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Retira una plantilla: deja de generar clases desde hoy. No se borra: las
   * clases que ya ocurrieron siguen apuntando a ella y a sus asistencias.
   */
  async retireTemplate(id: string, today: Date): Promise<boolean> {
    // El CHECK exige fin > inicio: una plantilla creada hoy se desactiva sin
    // fecha de fin (nunca llegó a correr), las demás se cierran en hoy.
    const cerrada = await this.db.classTemplate.updateMany({
      where: this.scope({ id, isActive: true, effectiveFrom: { lt: today } }),
      data: { isActive: false, effectiveTo: today },
    });
    if (cerrada.count > 0) return true;
    const nueva = await this.db.classTemplate.updateMany({
      where: this.scope({ id, isActive: true }),
      data: { isActive: false },
    });
    return nueva.count > 0;
  }

  /** Clases FUTURAS aún programadas de una plantilla. */
  async futureScheduleIds(templateId: string, from: Date): Promise<string[]> {
    const rows = await this.db.classSchedule.findMany({
      where: this.scope({ templateId, status: O.SCHEDULED, startsAt: { gte: from } }),
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** ¿Ofrece clases la organización? Algún tipo activo con horario vigente. */
  async offersClasses(): Promise<boolean> {
    const n = await this.db.classTemplate.count({
      where: this.scope({ isActive: true, classType: { isActive: true, deletedAt: null } }),
    });
    return n > 0;
  }

  async createTemplate(input: {
    branchId: string; classTypeId: string;
    coachUserId?: string | null | undefined; room?: string | null | undefined;
    effectiveFrom: Date; effectiveTo?: Date | null | undefined;
    slots: ReadonlyArray<{ weekday: number; startMinute: number; durationMin: number; capacity: number }>;
  }): Promise<{ id: string }> {
    return this.db.$transaction(async (tx) => {
      const template = await tx.classTemplate.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          branchId: input.branchId,
          classTypeId: input.classTypeId,
          coachUserId: input.coachUserId ?? null,
          room: input.room ?? null,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
        },
        select: { id: true },
      });

      for (const slot of input.slots) {
        await tx.classTemplateSlot.create({
          data: { id: uuidv7(), templateId: template.id, ...slot },
        });
      }
      return template;
    });
  }

  async listActiveTemplates(): Promise<Array<{
    id: string; branchId: string; classTypeId: string; coachUserId: string | null; room: string | null;
    effectiveFrom: Date; effectiveTo: Date | null;
    slots: Array<{ weekday: number; startMinute: number; durationMin: number; capacity: number }>;
  }>> {
    return this.db.classTemplate.findMany({
      where: this.scope({ isActive: true }),
      select: {
        id: true, branchId: true, classTypeId: true, coachUserId: true, room: true,
        effectiveFrom: true, effectiveTo: true,
        slots: { select: { weekday: true, startMinute: true, durationMin: true, capacity: true } },
      },
    });
  }

  /**
   * Materializa ocurrencias. Idempotente por `occurrenceKey`.
   *
   * `ON CONFLICT DO NOTHING` y no un `SELECT` previo: el generador corre a
   * diario sobre un horizonte que se solapa con el del día anterior, y dos
   * ejecuciones simultáneas —cron y alguien pulsando "regenerar"— pasarían
   * las dos por la rendija entre consultar e insertar.
   */
  async materialize(
    occurrences: readonly PlannedOccurrence[],
    meta: { branchId: string; classTypeId: string; coachUserId: string | null; room: string | null },
  ): Promise<number> {
    let created = 0;
    for (const occ of occurrences) {
      const inserted = await this.db.$executeRaw`
        INSERT INTO "class_schedules" (
          "id", "organizationId", "branchId", "classTypeId", "templateId",
          "coachUserId", "room", "occurrenceKey", "startsAt", "endsAt",
          "businessDate", "capacity", "bookedCount", "status", "wallTimeResolution", "createdAt"
        ) VALUES (
          ${uuidv7()}::uuid, ${this.organizationId}::uuid, ${meta.branchId}::uuid,
          ${meta.classTypeId}::uuid, ${occ.templateId}::uuid,
          ${meta.coachUserId}::uuid, ${meta.room}, ${occ.occurrenceKey},
          ${occ.startsAt}, ${occ.endsAt}, ${occ.businessDate}::date,
          ${occ.capacity}, 0, 'SCHEDULED'::"ClassOccurrenceStatus", ${occ.resolution}, now()
        )
        ON CONFLICT ("organizationId", "occurrenceKey") DO NOTHING`;
      created += inserted;
    }
    return created;
  }

  // ── Ocurrencias ───────────────────────────────────────────────────────────

  async listSchedules(opts: {
    branchId?: string | undefined; from: Date; to: Date;
  }): Promise<ScheduleRecord[]> {
    const rows = await this.db.classSchedule.findMany({
      where: this.scope({
        ...(opts.branchId ? { branchId: opts.branchId } : {}),
        startsAt: { gte: opts.from, lt: opts.to },
      }),
      select: SCHEDULE_SELECT,
      orderBy: { startsAt: 'asc' },
    });
    return rows as ScheduleRecord[];
  }

  async findSchedule(id: string): Promise<ScheduleRecord | null> {
    const row = await this.db.classSchedule.findFirst({
      where: this.scope({ id }), select: SCHEDULE_SELECT,
    });
    return row as ScheduleRecord | null;
  }

  async setCapacity(id: string, capacity: number): Promise<boolean> {
    // El CHECK `bookedCount <= capacity` es quien impide de verdad recortar
    // por debajo de lo reservado; esto solo evita el viaje a la excepción.
    const { count } = await this.db.classSchedule.updateMany({
      where: this.scope({ id, bookedCount: { lte: capacity } }),
      data: { capacity },
    });
    return count > 0;
  }

  async cancelSchedule(id: string, reason: string): Promise<BookingRecord[]> {
    return this.db.$transaction(async (tx) => {
      const { count } = await tx.classSchedule.updateMany({
        where: this.scope({ id, status: O.SCHEDULED }),
        data: { status: O.CANCELED, canceledAt: new Date(), cancelReason: reason },
      });
      if (count === 0) return [];

      const afectadas = await tx.classBooking.findMany({
        where: this.scope({ classScheduleId: id, status: B.BOOKED }),
        select: BOOKING_SELECT,
      });
      // Cancelar la clase cancela las reservas, y NO cuenta como falta de
      // nadie: la ausencia la provocó el gimnasio.
      await tx.classBooking.updateMany({
        where: this.scope({ classScheduleId: id, status: B.BOOKED }),
        data: { status: B.CANCELED, canceledAt: new Date(), lateCancel: false },
      });
      await tx.classSchedule.updateMany({ where: this.scope({ id }), data: { bookedCount: 0 } });
      return afectadas as BookingRecord[];
    });
  }

  // ── Reservas ──────────────────────────────────────────────────────────────

  /**
   * Toma la plaza y crea la reserva EN UNA TRANSACCIÓN.
   *
   * El cupo se adjudica con `UPDATE ... WHERE bookedCount < capacity`: es un
   * comprobar-y-fijar atómico, y el orden importa. Primero el `UPDATE`, que
   * bloquea la fila de la clase y serializa a los dos socios que pulsan a la
   * vez; después el `INSERT`, cuyo índice único parcial impide que el mismo
   * socio ocupe dos plazas. Si cualquiera falla, la transacción devuelve la
   * plaza sin que nadie la vea ocupada.
   */
  async book(input: {
    scheduleId: string; memberId: string; branchId: string;
    source: 'PORTAL' | 'FRONT_DESK'; bookedByUserId?: string | null;
  }): Promise<BookingRecord | 'FULL' | 'DUPLICATE'> {
    try {
      return await this.bookInTransaction(input);
    } catch (error) {
      // El índice único parcial lo rechaza cuando el mismo socio pulsa dos
      // veces a la vez y las dos peticiones pasan la comprobación previa. La
      // transacción ya devolvió la plaza; aquí solo se traduce.
      if (isUniqueViolation(error)) return 'DUPLICATE';
      throw error;
    }
  }

  private async bookInTransaction(input: {
    scheduleId: string; memberId: string; branchId: string;
    source: 'PORTAL' | 'FRONT_DESK'; bookedByUserId?: string | null;
  }): Promise<BookingRecord | 'FULL'> {
    return this.db.$transaction(async (tx) => {
      const taken = await tx.$executeRaw`
        UPDATE "class_schedules"
           SET "bookedCount" = "bookedCount" + 1
         WHERE "id" = ${input.scheduleId}::uuid
           AND "organizationId" = ${this.organizationId}::uuid
           AND "status" = 'SCHEDULED'
           AND "bookedCount" < "capacity"`;
      if (taken === 0) return 'FULL';

      const row = await tx.classBooking.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          branchId: input.branchId,
          classScheduleId: input.scheduleId,
          memberId: input.memberId,
          status: B.BOOKED,
          source: SRC[input.source],
          bookedByUserId: input.bookedByUserId ?? null,
        },
        select: BOOKING_SELECT,
      });
      return row as BookingRecord;
    });
  }

  async findBooking(id: string): Promise<BookingRecord | null> {
    const row = await this.db.classBooking.findFirst({
      where: this.scope({ id }), select: BOOKING_SELECT,
    });
    return row as BookingRecord | null;
  }

  async findActiveBooking(scheduleId: string, memberId: string): Promise<BookingRecord | null> {
    const row = await this.db.classBooking.findFirst({
      where: this.scope({ classScheduleId: scheduleId, memberId, status: { not: B.CANCELED } }),
      select: BOOKING_SELECT,
    });
    return row as BookingRecord | null;
  }

  async listBookingsForMember(memberId: string, from: Date, take = 50): Promise<Array<BookingWithPayment & {
    startsAt: Date; endsAt: Date; classTypeId: string; coachUserId: string | null; room: string | null; chargeStatus: string | null;
    scheduleStatus: ScheduleRecord['status'];
  }>> {
    const rows = await this.db.classBooking.findMany({
      where: this.scope({ memberId, classSchedule: { startsAt: { gte: from } } }),
      select: {
        ...BOOKING_SELECT,
        source: true,
        classSchedule: { select: { startsAt: true, endsAt: true, classTypeId: true, coachUserId: true, room: true, status: true } },
        charge: { select: CHARGE_OF_BOOKING },
      },
      orderBy: { bookedAt: 'desc' },
      take,
    });
    return rows.map((r) => ({
      ...(r as unknown as BookingRecord),
      source: r.source,
      charge: r.charge,
      startsAt: r.classSchedule.startsAt,
      endsAt: r.classSchedule.endsAt,
      classTypeId: r.classSchedule.classTypeId,
      coachUserId: r.classSchedule.coachUserId,
      room: r.classSchedule.room,
      scheduleStatus: r.classSchedule.status,
      chargeStatus: r.charge?.status ?? null,
    }));
  }

  /** La lista de la sesión, con el cargo de cada clase suelta (11-03). */
  async listBookingsForSchedule(scheduleId: string): Promise<BookingWithPayment[]> {
    const rows = await this.db.classBooking.findMany({
      where: this.scope({ classScheduleId: scheduleId }),
      select: { ...BOOKING_SELECT, source: true, charge: { select: CHARGE_OF_BOOKING } },
      orderBy: { bookedAt: 'asc' },
    });
    return rows as BookingWithPayment[];
  }

  /**
   * Cancela y devuelve la plaza. El `WHERE status = 'BOOKED'` es la barrera
   * de idempotencia: cancelar dos veces no devuelve dos plazas.
   */
  async cancelBooking(id: string, late: boolean): Promise<BookingRecord | null> {
    return this.db.$transaction(async (tx) => {
      const { count } = await tx.classBooking.updateMany({
        where: this.scope({ id, status: B.BOOKED }),
        data: { status: B.CANCELED, canceledAt: new Date(), lateCancel: late },
      });
      if (count === 0) return null;

      const row = await tx.classBooking.findFirst({ where: this.scope({ id }), select: BOOKING_SELECT });
      await tx.$executeRaw`
        UPDATE "class_schedules"
           SET "bookedCount" = "bookedCount" - 1
         WHERE "id" = ${row!.classScheduleId}::uuid
           AND "organizationId" = ${this.organizationId}::uuid
           AND "bookedCount" > 0`;
      return row as BookingRecord;
    });
  }

  async attachCharge(bookingId: string, chargeId: string): Promise<void> {
    await this.db.classBooking.updateMany({
      where: this.scope({ id: bookingId }), data: { chargeId },
    });
  }

  /** Reservas del socio en esa sede cuya clase empieza en ±una hora: la entrada en la puerta vale como llegada. */
  async bookedAround(memberId: string, branchId: string, at: Date): Promise<string[]> {
    const rows = await this.db.classBooking.findMany({
      where: this.scope({
        memberId, branchId, status: B.BOOKED, checkedInAt: null,
        classSchedule: { status: O.SCHEDULED, startsAt: { gte: new Date(at.getTime() - 60 * 60_000), lte: new Date(at.getTime() + 60 * 60_000) } },
      }),
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async checkIn(id: string, at: Date): Promise<boolean> {
    const { count } = await this.db.classBooking.updateMany({
      where: this.scope({ id, status: B.BOOKED, checkedInAt: null }),
      data: { checkedInAt: at },
    });
    return count > 0;
  }

  // ── Cierre y sanciones ────────────────────────────────────────────────────

  /** Clases terminadas que siguen abiertas. Las cierra el job. */
  async schedulesToClose(until: Date, limit: number): Promise<ScheduleRecord[]> {
    const rows = await this.db.classSchedule.findMany({
      where: this.scope({ status: O.SCHEDULED, endsAt: { lt: until } }),
      select: SCHEDULE_SELECT,
      orderBy: { endsAt: 'asc' },
      take: limit,
    });
    return rows as ScheduleRecord[];
  }

  async closeSchedule(id: string): Promise<{ attended: number; noShow: number }> {
    return this.db.$transaction(async (tx) => {
      const attended = await tx.classBooking.updateMany({
        where: this.scope({ classScheduleId: id, status: B.BOOKED, checkedInAt: { not: null } }),
        data: { status: B.ATTENDED, closedAt: new Date() },
      });
      const noShow = await tx.classBooking.updateMany({
        where: this.scope({ classScheduleId: id, status: B.BOOKED, checkedInAt: null }),
        data: { status: B.NO_SHOW, closedAt: new Date() },
      });
      await tx.classSchedule.updateMany({
        where: this.scope({ id, status: O.SCHEDULED }),
        data: { status: O.CLOSED, closedAt: new Date() },
      });
      return { attended: attended.count, noShow: noShow.count };
    });
  }

  /**
   * Faltas del socio en la ventana. Cuenta las ausencias Y las cancelaciones
   * fuera de plazo: para el cupo son lo mismo, una plaza que nadie pudo usar.
   */
  async noShowsSince(memberId: string, since: Date): Promise<number> {
    const rows = await this.db.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(*)::bigint AS total
      FROM "class_bookings"
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "memberId" = ${memberId}::uuid
        AND "bookedAt" >= ${since}
        AND ("status" = 'NO_SHOW' OR ("status" = 'CANCELED' AND "lateCancel" = true))`;
    return Number(rows[0]?.total ?? 0n);
  }

  async activeBlock(memberId: string, now: Date): Promise<{ untilDate: Date; noShowCount: number } | null> {
    return this.db.classBookingBlock.findFirst({
      where: this.scope({ memberId, untilDate: { gt: now } }),
      select: { untilDate: true, noShowCount: true },
      orderBy: { untilDate: 'desc' },
    });
  }

  async createBlock(input: {
    memberId: string; untilDate: Date; noShowCount: number; reason: string;
  }): Promise<void> {
    await this.db.classBookingBlock.create({
      data: { id: uuidv7(), organizationId: this.organizationId, ...input },
    });
  }

  async membersWithBookingsIn(scheduleId: string): Promise<string[]> {
    const rows = await this.db.classBooking.findMany({
      where: this.scope({ classScheduleId: scheduleId, status: B.NO_SHOW }),
      select: { memberId: true },
    });
    return rows.map((r) => r.memberId);
  }

  // ── Reglas de reserva del gimnasio (11-08) ────────────────────────────────

  /** Lo que el gimnasio guardó; `null` si nunca cambió las de fábrica. */
  async findSettings(): Promise<ClassSettingsRecord | null> {
    return this.db.classSettings.findFirst({ where: { organizationId: this.organizationId }, select: SETTINGS_SELECT });
  }

  async saveSettings(rules: {
    maxDaysAhead: number; cancelCutoffMinutes: number; noShowWindowDays: number; noShowsBeforeBlock: number; blockDays: number;
  }, userId: string | null): Promise<ClassSettingsRecord> {
    return this.db.classSettings.upsert({
      where: { organizationId: this.organizationId },
      create: { organizationId: this.organizationId, ...rules, updatedByUserId: userId },
      update: { ...rules, updatedByUserId: userId },
      select: SETTINGS_SELECT,
    });
  }

  // ── Sesión única (11-05) ──────────────────────────────────────────────────

  /** Una sesión suelta, fuera del horario semanal: sin plantilla y con su propia clave. */
  async createSingle(input: {
    branchId: string; classTypeId: string; coachUserId: string | null; room: string | null;
    startsAt: Date; endsAt: Date; businessDate: Date; capacity: number; wallTimeResolution: string;
  }): Promise<ScheduleRecord> {
    const id = uuidv7();
    const row = await this.db.classSchedule.create({
      data: { id, organizationId: this.organizationId, occurrenceKey: `unica:${id}`, ...input },
      select: SCHEDULE_SELECT,
    });
    return row as ScheduleRecord;
  }

  // ── Editar un horario (11-06) ─────────────────────────────────────────────

  async findTemplate(id: string): Promise<TemplateRecord | null> {
    return this.db.classTemplate.findFirst({
      where: this.scope({ id }),
      select: {
        id: true, branchId: true, classTypeId: true, coachUserId: true, room: true,
        effectiveFrom: true, effectiveTo: true, isActive: true,
        slots: { select: { weekday: true, startMinute: true, durationMin: true, capacity: true }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] },
      },
    });
  }

  /** Cambia el horario y, si vienen, sus bloques enteros (se sustituyen todos a la vez). */
  async updateTemplate(id: string, patch: {
    room?: string | null; coachUserId?: string | null; effectiveTo?: Date | null;
    slots?: ReadonlyArray<{ weekday: number; startMinute: number; durationMin: number; capacity: number }>;
  }): Promise<void> {
    const { slots, ...datos } = patch;
    await this.db.$transaction(async (tx) => {
      if (Object.keys(datos).length > 0) await tx.classTemplate.updateMany({ where: this.scope({ id }), data: datos });
      if (slots) {
        await tx.classTemplateSlot.deleteMany({ where: { templateId: id, template: { organizationId: this.organizationId } } });
        for (const slot of slots) await tx.classTemplateSlot.create({ data: { id: uuidv7(), templateId: id, ...slot } });
      }
    });
  }

  /** Sesiones programadas de un horario que aún no empiezan, con cuántas reservas (vivas o no) cuelgan de cada una. */
  async futureOfTemplate(templateId: string, from: Date): Promise<Array<ScheduleRecord & { occurrenceKey: string; bookingRows: number }>> {
    const rows = await this.db.classSchedule.findMany({
      where: this.scope({ templateId, status: O.SCHEDULED, startsAt: { gt: from } }),
      select: { ...SCHEDULE_SELECT, occurrenceKey: true, _count: { select: { bookings: true } } },
      orderBy: { startsAt: 'asc' },
    });
    return rows.map(({ _count, ...r }) => ({ ...(r as ScheduleRecord & { occurrenceKey: string }), bookingRows: _count.bookings }));
  }

  /** Lo que cambia en una sesión ya generada sin moverla de hora. El cupo nunca baja de lo reservado. */
  async reshapeSchedule(id: string, patch: { capacity: number; endsAt: Date; room: string | null; coachUserId: string | null }): Promise<boolean> {
    const { capacity, ...resto } = patch;
    const { count } = await this.db.classSchedule.updateMany({ where: this.scope({ id, status: O.SCHEDULED }), data: resto });
    if (count === 0) return false;
    await this.db.classSchedule.updateMany({ where: this.scope({ id, bookedCount: { lte: capacity } }), data: { capacity } });
    return true;
  }

  /** Borra una sesión que nadie reservó nunca. Con alguna reserva (aunque esté cancelada) no borra nada. */
  async deleteUnbooked(id: string): Promise<boolean> {
    const { count } = await this.db.classSchedule.deleteMany({
      where: this.scope({ id, status: O.SCHEDULED, bookedCount: 0, bookings: { none: {} } }),
    });
    return count > 0;
  }

  // ── Pausas por fechas (11-05) ─────────────────────────────────────────────

  /** Las pausas vivas que no han terminado en `desde` (un día de calendario). */
  async livePauses(desde: Date): Promise<ClassPauseRecord[]> {
    return this.db.classPause.findMany({
      where: this.scope({ endedAt: null, toDate: { gte: desde } }),
      select: PAUSE_SELECT,
      orderBy: [{ fromDate: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async findPause(id: string): Promise<ClassPauseRecord | null> {
    return this.db.classPause.findFirst({ where: this.scope({ id }), select: PAUSE_SELECT });
  }

  async createPause(input: { branchId: string | null; fromDate: Date; toDate: Date; reason: string; createdByUserId: string | null }): Promise<ClassPauseRecord> {
    return this.db.classPause.create({
      data: { id: uuidv7(), organizationId: this.organizationId, ...input },
      select: PAUSE_SELECT,
    });
  }

  async endPause(id: string, userId: string | null): Promise<boolean> {
    const { count } = await this.db.classPause.updateMany({
      where: this.scope({ id, endedAt: null }), data: { endedAt: new Date(), endedByUserId: userId },
    });
    return count > 0;
  }

  /** Sesiones programadas que caen en esas fechas y todavía no empiezan. */
  async scheduledInDates(opts: { branchId: string | null; fromDate: Date; toDate: Date; after: Date }): Promise<string[]> {
    const rows = await this.db.classSchedule.findMany({
      where: this.scope({
        status: O.SCHEDULED, startsAt: { gt: opts.after },
        businessDate: { gte: opts.fromDate, lte: opts.toDate },
        ...(opts.branchId ? { branchId: opts.branchId } : {}),
      }),
      select: { id: true },
      orderBy: { startsAt: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  async markPaused(scheduleIds: readonly string[], pauseId: string): Promise<void> {
    if (scheduleIds.length === 0) return;
    await this.db.classSchedule.updateMany({ where: this.scope({ id: { in: [...scheduleIds] }, status: O.CANCELED }), data: { pauseId } });
  }

  /**
   * Quitar la pausa devuelve las sesiones que ella canceló y que todavía no
   * empiezan. Vuelven VACÍAS: las reservas se cancelaron con la pausa y cada
   * quien vuelve a apartar si quiere.
   */
  async restorePaused(pauseId: string, now: Date): Promise<number> {
    const { count } = await this.db.classSchedule.updateMany({
      where: this.scope({ pauseId, status: O.CANCELED, startsAt: { gt: now } }),
      data: { status: O.SCHEDULED, canceledAt: null, cancelReason: null, pauseId: null },
    });
    return count;
  }
}
