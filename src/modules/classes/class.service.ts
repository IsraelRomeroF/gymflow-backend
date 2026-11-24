import {
  conflict, expandWeekly, evaluateBooking, evaluateCancellation, evaluateNoShowPenalty,
  canSetCapacity, notFound, validation, DomainError,
  bookingSettingsFrom, attendanceWindowState, ATTENDANCE_WINDOW, isValidSlot, isoDate, resolveWallTime,
  apartadoDeClaseSuelta, apartadoVencido,
  type BookingDecision, type BookingSubject, type BookingSettings, type WeeklySlot,
} from '@gymflow/core';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { moduleViewOf } from '../../platform/modules/module-state.js';
import { BillingService, ChargeRepository } from '../billing/index.js';
import { MemberRepository } from '../members/index.js';
import { MembershipRepository } from '../memberships/index.js';
import { PlanRepository } from '../catalog/index.js';
import { BranchRepository } from '../organization/index.js';
import { ClassRepository, type BookingRecord, type ClassPauseRecord, type ScheduleRecord } from './class.repository.js';
import type { RequestContext } from '../../platform/context.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { systemContext } from '../../platform/jobs/types.js';
import { enUnidadDeDinero } from '../../platform/db/unit-of-work.js';

/**
 * ¿Qué sedes dan clases hoy? Las abiertas que no dejaron de usar Clases
 * (19-04). Una sede que las dejó, o que se cerró, no recibe clases nuevas ni
 * reservas; lo que ya había se queda como estaba y vuelve si las retoma.
 */
export async function sedesConClases(orgId: string): Promise<(branchId: string) => boolean> {
  const [vista, sedes] = await Promise.all([moduleViewOf(orgId), new BranchRepository(orgId).list()]);
  const abiertas = new Set(sedes.filter((b) => b.isActive).map((b) => b.id));
  return (branchId) => abiertas.has(branchId) && vista.at(branchId).has('classes');
}

/**
 * Clases con cupo.
 *
 * El servicio NO decide el cupo: lo decide la base con un comprobar-y-fijar
 * atómico. Aquí se decide todo lo demás —si el socio tiene derecho, si hay que
 * cobrar, si la cancelación llega tarde— y se orquesta en el orden en que
 * menos duele que algo falle.
 */

/** Lo que no cambia entre las clases de un mismo listado. */
/**
 * El sujeto con las clases que su plan incluye (2026-10-09): `includesClasses`
 * dice si el plan trae clases y `incluidas` cuáles (vacío = todas las que se
 * pueden incluir en un plan). Por clase se resuelve en `cubre`.
 */
type Sujeto = BookingSubject & { incluidas: readonly string[] };
type TipoParaPlan = { dropInPriceCents: bigint; includableInPlans: boolean };

/** ¿El plan del socio incluye este tipo de clase? */
function cubre(subject: Sujeto, typeId: string, tipo: TipoParaPlan | null | undefined): BookingSubject {
  const m = subject.membership;
  if (!m) return subject;
  const incluye = m.includesClasses && !!tipo?.includableInPlans
    && (subject.incluidas.length === 0 || subject.incluidas.includes(typeId));
  return { ...subject, membership: { ...m, includesClasses: incluye } };
}

export type BulkContext = {
  subject: Sujeto;
  dropInByType: ReadonlyMap<string, bigint>;
  typeById: ReadonlyMap<string, TipoParaPlan>;
  /** Reserva VIVA del socio por clase: id de la clase → id de la reserva. */
  bookingByScheduleId: ReadonlyMap<string, string>;
  /** Las reglas del gimnasio, leídas una vez para todo el listado. */
  settings: BookingSettings;
};

export type BookingResult = {
  booking: BookingRecord;
  chargeId: string | null;
  priceCents: bigint;
  warnings: readonly string[];
  /** D-16: hasta cuándo se le guarda el lugar si no paga; nulo si está incluida o ya se pagó. */
  holdUntil: Date | null;
  /** D-16: el cobro hecho en el momento de apartar, si lo hubo. */
  paymentId: string | null;
};

/** El cobro en el momento de apartar una clase suelta (D-16): quién cobra y cómo. Solo desde el mostrador. */
export type CobroAlApartar = { ctx: RequestContext; payment: { method: 'CASH' | 'CARD_TERMINAL' | 'SPEI_TRANSFER'; cashSessionId?: string | null; externalRef?: string | null } };

export class ClassService {
  /**
   * Las reglas de reserva del gimnasio (11-08): las que guardó, sobre las de
   * fábrica. Sin nada guardado son las que el producto traía en código.
   */
  async settingsOf(orgId: string): Promise<BookingSettings> {
    return bookingSettingsFrom(await new ClassRepository(orgId).findSettings());
  }

  /** Genera las ocurrencias de las plantillas activas para el horizonte dado. */
  async materializeHorizon(
    orgId: string,
    opts: { days?: number; from?: Date } = {},
  ): Promise<{ created: number; shifted: number; skipped: number }> {
    const repo = new ClassRepository(orgId);
    const calendar = new BusinessCalendar(orgId);
    const [templates, daClases] = await Promise.all([repo.listActiveTemplates(), sedesConClases(orgId)]);
    // Días en pausa (11-05): no se generan. Se leen desde ayer para cubrir
    // cualquier zona; cada fecha se compara con el calendario de su sede.
    const pausas = await repo.livePauses(new Date((opts.from ?? new Date()).getTime() - 2 * 86_400_000));
    const enPausa = (branchId: string, dia: Date) => pausas.some((p) => (p.branchId === null || p.branchId === branchId)
      && isoDate(dia) >= isoDate(p.fromDate) && isoDate(dia) <= isoDate(p.toDate));

    const ahora = new Date();
    let created = 0;
    let shifted = 0;
    // Horarios de sedes que dejaron de dar clases o se cerraron (19-04): no generan.
    let skipped = 0;

    for (const template of templates) {
      if (!daClases(template.branchId)) { skipped += 1; continue; }
      // La zona es la de LA SUCURSAL, no la de la organización: la sede de la
      // frontera norte sí cambia de hora y sus clases se mueven con ella.
      const timezone = await calendar.timezoneFor(template.branchId);
      const from = opts.from ?? await calendar.today(template.branchId);
      const to = new Date(from.getTime() + (opts.days ?? 21) * 86_400_000);

      const occurrences = expandWeekly(
        {
          id: template.id,
          slots: template.slots,
          effectiveFrom: template.effectiveFrom,
          effectiveTo: template.effectiveTo,
        },
        timezone, from, to,
      );

      // Lo que ya terminó (con su gracia del pase de lista) no se genera: editar a media mañana un horario
      // de las 7:00 a las 7:30 dejaba «la de hoy a las 7:30», una sesión que nadie pudo tomar (11-06).
      const yaPaso = ahora.getTime() - ATTENDANCE_WINDOW.afterMin * 60_000;
      const vivas = occurrences.filter((o) => o.endsAt.getTime() > yaPaso && !enPausa(template.branchId, o.businessDate));
      shifted += vivas.filter((o) => o.resolution !== 'EXACT').length;
      created += await repo.materialize(vivas, {
        branchId: template.branchId,
        classTypeId: template.classTypeId,
        coachUserId: template.coachUserId,
        room: template.room,
      });
    }
    return { created, shifted, skipped };
  }

  /**
   * Estado del socio frente a UNA clase concreta.
   *
   * `subject` entra por parámetro para poder reutilizarlo: el listado del
   * portal evalúa una semana entera, y reconstruirlo por clase son cuatro
   * consultas por fila. Con cincuenta clases eso es un listado de doscientas
   * consultas para responder algo que no cambia entre ellas.
   */
  async evaluate(
    orgId: string, memberId: string, schedule: ScheduleRecord, now: Date,
    prebuilt?: BulkContext,
  ): Promise<{ decision: BookingDecision; dropInPriceCents: bigint }> {
    const repo = new ClassRepository(orgId);
    const tipo = prebuilt ? prebuilt.typeById.get(schedule.classTypeId) : await repo.findType(schedule.classTypeId);
    const dropIn = tipo?.dropInPriceCents ?? 0n;

    const sujeto = prebuilt?.subject ?? await this.buildSubject(orgId, memberId, now);
    if (!sujeto) throw notFound('Socio no encontrado');
    // Incluida o suelta, según su plan y esta clase.
    const subject = cubre(sujeto, schedule.classTypeId, tipo);

    const yaReservada = prebuilt
      ? prebuilt.bookingByScheduleId.has(schedule.id)
      : (await repo.findActiveBooking(schedule.id, memberId)) !== null;

    const decision = evaluateBooking(
      { ...subject, alreadyBooked: yaReservada },
      {
        branchId: schedule.branchId,
        startsAt: schedule.startsAt,
        status: schedule.status,
        capacity: schedule.capacity,
        bookedCount: schedule.bookedCount,
        dropInPriceCents: dropIn,
      },
      now,
      prebuilt?.settings ?? await this.settingsOf(orgId),
    );
    return { decision, dropInPriceCents: dropIn };
  }

  /**
   * Contexto compartido para evaluar MUCHAS clases de una vez.
   *
   * Se calcula una sola vez por listado: el socio, su membresía y su plan no
   * cambian entre la clase del lunes y la del jueves.
   */
  async bulkContext(orgId: string, memberId: string, now: Date, from: Date): Promise<BulkContext> {
    const repo = new ClassRepository(orgId);
    const subject = await this.buildSubject(orgId, memberId, now);
    if (!subject) throw notFound('Socio no encontrado');

    const tipos = await repo.listTypes(true);
    const reservas = await repo.listBookingsForMember(memberId, from);

    return {
      settings: await this.settingsOf(orgId),
      subject,
      dropInByType: new Map(tipos.map((t) => [t.id, t.dropInPriceCents])),
      typeById: new Map(tipos.map((t) => [t.id, t])),
      bookingByScheduleId: new Map(
        reservas.filter((b) => b.status === 'BOOKED').map((b) => [b.classScheduleId, b.id]),
      ),
    };
  }

  /**
   * Reserva.
   *
   * Orden deliberado: **primero la plaza, después el cargo**. Al revés, un
   * fallo entre ambos pasos deja al socio pagado y sin lugar, que es mucho
   * peor que una plaza tomada sin cobrar. Y si el cargo falla, se devuelve la
   * plaza en el acto.
   */
  async book(
    orgId: string,
    input: {
      scheduleId: string; memberId: string;
      source: 'PORTAL' | 'FRONT_DESK'; bookedByUserId?: string | null;
      /** D-16: cobrar la clase suelta en el momento (obligatorio si debe su mensualidad o falta menos de una hora). */
      cobro?: CobroAlApartar | null;
    },
    now = new Date(),
  ): Promise<BookingResult> {
    const repo = new ClassRepository(orgId);
    const schedule = await repo.findSchedule(input.scheduleId);
    if (!schedule) throw notFound('Clase no encontrada');
    // Tampoco desde el teléfono del socio: una sede que ya no da clases no recibe reservas (19-04).
    if (!(await sedesConClases(orgId))(schedule.branchId)) {
      throw new DomainError('MODULE_DISABLED', 'Esa sucursal ya no da clases: elige una clase de otra sucursal');
    }

    const { decision } = await this.evaluate(orgId, input.memberId, schedule, now);
    if (decision.outcome === 'DENY') throw conflict(await this.porQueNo(orgId, input.memberId, schedule, decision.reason, now));

    // D-16 (b): una clase suelta se aparta sin pagar y se guarda hasta una hora antes. Quien debe su
    // mensualidad, o quien aparta con menos de una hora, solo la aparta PAGÁNDOLA en el momento. Se
    // decide ANTES de tomar la plaza: no se le quita el lugar a nadie para decir que no después.
    let holdUntil: Date | null = null;
    let pago: CobroAlApartar['payment'] | null = null;
    if (decision.requiresPayment) {
      const apartado = apartadoDeClaseSuelta({ startsAt: schedule.startsAt, now, debeSuMensualidad: await this.debeSuMensualidad(orgId, input.memberId, schedule.branchId, now) });
      if (input.cobro) {
        // Paga ahora: la caja se resuelve antes de tocar nada («no hay caja abierta» sale aquí).
        pago = await new BillingService().cobroValidado(input.cobro.ctx, schedule.branchId, input.cobro.payment) as CobroAlApartar['payment'];
      } else if (apartado.outcome === 'PAY_NOW') {
        throw apartado.porQue === 'OWES_MEMBERSHIP'
          ? conflict('Debe su mensualidad: una clase suelta solo se aparta pagándola en el momento, en recepción', 'CLASS_PAY_NOW')
          : conflict('Falta menos de una hora para la clase: ya no se aparta sin pagar. Se paga en recepción al llegar', 'CLASS_HOLD_CLOSED');
      } else {
        holdUntil = apartado.holdUntil;
      }
    }

    const booking = await repo.book({
      scheduleId: schedule.id,
      memberId: input.memberId,
      branchId: schedule.branchId,
      source: input.source,
      bookedByUserId: input.bookedByUserId ?? null,
    });
    // La plaza la adjudica la base: si no vuelve una reserva es que la carrera
    // la ganó otro entre la evaluación y la escritura. No es un fallo del
    // sistema, es exactamente el caso que el cupo atómico existe para resolver.
    if (booking === 'FULL') throw conflict('La clase se llenó', 'CLASS_FULL');
    if (booking === 'DUPLICATE') throw conflict(denialMessage('ALREADY_BOOKED'));

    let chargeId: string | null = null;
    let paymentId: string | null = null;
    if (decision.requiresPayment) {
      try {
        const type = await repo.findType(schedule.classTypeId);
        const businessDate = await new BusinessCalendar(orgId).today(schedule.branchId, now);
        const { charge } = await new ChargeRepository(orgId).create({
          memberId: input.memberId,
          branchId: schedule.branchId,
          chargeType: 'CLASS_SINGLE',
          concept: `Clase suelta · ${type?.name ?? 'clase'}`,
          subtotalCents: decision.priceCents,
          dueDate: businessDate,
          // Derivada de la RESERVA, no de clase+socio: con la clave anterior,
          // reservar, cancelar y volver a reservar reutilizaba el cargo ya
          // anulado y la clase salía gratis.
          idempotencyKey: `class-booking:${booking.id}`,
          createdByUserId: input.bookedByUserId ?? null,
        });
        chargeId = charge.id;
        await repo.attachCharge(booking.id, charge.id, holdUntil);
        // D-16: si se cobra en el momento, el cobro va directo al cargo de la clase, con su llave.
        if (pago && input.cobro) {
          try {
            const p = await new BillingService().cobrarAhora(input.cobro.ctx, {
              memberId: input.memberId, branchId: schedule.branchId, charges: [charge], key: `class-booking-pay:${booking.id}`,
            }, pago);
            paymentId = p?.id ?? null;
          } catch (error) {
            // Sin cobro no hay lugar ni deuda: se anula el cargo recién emitido (la plaza la devuelve el `catch` de afuera).
            await new ChargeRepository(orgId).voidCharge(charge.id, 'No se pudo cobrar al apartar la clase');
            throw error;
          }
        }
      } catch (error) {
        await repo.cancelBooking(booking.id, false);
        throw error;
      }
      // El saldo que pintan Socios y Caja (`balanceCentsCached`) se entera en el
      // momento, como con cualquier cargo de BillingService; antes no se enteraba
      // hasta el siguiente cobro o la reconciliación de la noche (D3, 2026-11-19).
      await new BillingService().refreshCachedBalance(orgId, input.memberId);
    }

    return {
      booking: { ...booking, chargeId, holdUntil },
      chargeId,
      priceCents: decision.priceCents,
      warnings: decision.warnings,
      holdUntil,
      paymentId,
    };
  }

  /**
   * ¿Debe su mensualidad? (D-16): tiene una cuota o una inscripción de su
   * membresía con saldo y ya exigible (vence hoy o antes, en la fecha de
   * negocio de esa sede). Una cuota de un periodo que aún no empieza no cuenta.
   */
  async debeSuMensualidad(orgId: string, memberId: string, branchId: string, now = new Date()): Promise<boolean> {
    const hoy = await new BusinessCalendar(orgId).today(branchId, now);
    return (await new ChargeRepository(orgId).listOutstanding(memberId)).some((c) =>
      (c.chargeType === 'MEMBERSHIP_PERIOD' || c.chargeType === 'SIGNUP_FEE')
      && c.amountCents - c.allocatedCents - c.adjustedCents > 0n
      && c.dueDate.getTime() <= hoy.getTime());
  }

  /**
   * D-16 (b): LIBERA los lugares apartados sin pagar cuya hora ya pasó (una
   * hora antes de la clase). El lugar vuelve al cupo, su cargo se anula (no
   * debe nada) y NO cuenta como falta. Lo que ya se pagó deja de ser un
   * apartado y se queda. Corre cada 15 minutos; repetirlo no hace nada.
   */
  async releaseUnpaidHolds(orgId: string, now = new Date(), limit = 200): Promise<{ released: number; kept: number; truncated: boolean }> {
    const repo = new ClassRepository(orgId);
    const cargos = new ChargeRepository(orgId);
    const audit = new AuditService();
    const ctx = systemContext(orgId);
    const vencidos = (await repo.holdsDue(now, limit)).filter((b) => apartadoVencido(b.holdUntil, now));
    let released = 0;
    let kept = 0;
    for (const b of vencidos) {
      const cargo = b.chargeId ? await cargos.findById(b.chargeId) : null;
      const falta = cargo ? cargo.amountCents - cargo.allocatedCents - cargo.adjustedCents : 0n;
      // Ya pagada (o perdonada, o con un abono): se queda con su lugar; lo que falte se le cobra al pasar lista.
      if (!cargo || cargo.status === 'VOID' || falta <= 0n || cargo.allocatedCents > 0n || b.checkedInAt) {
        await repo.clearHold(b.id);
        kept += 1;
        continue;
      }
      await enUnidadDeDinero(orgId, async () => {
        const cancelada = await repo.cancelBooking(b.id, false);
        if (!cancelada) return;
        await cargos.voidCharge(cargo.id, 'Clase apartada sin pagar: el lugar se liberó una hora antes');
        await repo.clearHold(b.id);
        await audit.record(ctx, {
          action: 'class.booking.release', resourceType: 'class_booking', resourceId: b.id, branchId: b.branchId,
          afterState: { memberId: b.memberId, chargeId: cargo.id, amountCents: falta.toString(), holdUntil: b.holdUntil?.toISOString() ?? null },
          reason: 'Apartada sin pagar: se guardó hasta una hora antes de la clase',
        });
        await new BillingService().refreshCachedBalance(orgId, b.memberId);
        released += 1;
      });
    }
    return { released, kept, truncated: vencidos.length === limit };
  }

  /**
   * Lo que pasaría si recepción reserva a este socio: incluida en su plan,
   * clase suelta con cargo, o por qué no. Se muestra ANTES de cargarle nada.
   */
  async quote(orgId: string, scheduleId: string, memberId: string, now = new Date()) {
    const schedule = await new ClassRepository(orgId).findSchedule(scheduleId);
    if (!schedule) throw notFound('Clase no encontrada');
    const { decision } = await this.evaluate(orgId, memberId, schedule, now);
    const reason = decision.outcome === 'DENY' ? await this.porQueNo(orgId, memberId, schedule, decision.reason, now) : null;
    // D-16: si la clase se paga aparte, ¿se le puede guardar sin pagar (y hasta cuándo) o solo pagando ahora?
    const apartado = decision.outcome === 'ALLOW' && decision.requiresPayment
      ? apartadoDeClaseSuelta({ startsAt: schedule.startsAt, now, debeSuMensualidad: await this.debeSuMensualidad(orgId, memberId, schedule.branchId, now) })
      : null;
    const d16 = {
      payNow: apartado?.outcome === 'PAY_NOW' ? apartado.porQue : null,
      holdUntil: apartado?.outcome === 'HOLD' ? apartado.holdUntil : null,
    };
    return decision.outcome === 'ALLOW'
      ? { canBook: true, reason: null, requiresPayment: decision.requiresPayment, priceCents: decision.requiresPayment ? decision.priceCents : 0n,
          // Sin plan que la cubra: clase suelta, entra solo a esa clase (2026-10-09).
          dropInOnly: decision.warnings.includes('DROP_IN_ONLY'), ...d16 }
      : { canBook: false, reason, requiresPayment: false, priceCents: 0n, dropInOnly: false, ...d16 };
  }

  /**
   * El motivo en palabras. El bloqueo por faltas dice hasta cuándo dura
   * (11-08): «bloqueadas por faltas» a secas dejaba al socio y al mostrador
   * sin saber cuándo volver a intentarlo.
   */
  private async porQueNo(orgId: string, memberId: string, schedule: ScheduleRecord, reason: string, now: Date): Promise<string> {
    if (reason !== 'BLOCKED_BY_NO_SHOWS') return denialMessage(reason);
    const bloqueo = await new ClassRepository(orgId).activeBlock(memberId, now);
    if (!bloqueo) return denialMessage(reason);
    const zona = await new BusinessCalendar(orgId).timezoneFor(schedule.branchId);
    const hasta = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', timeZone: zona }).format(bloqueo.untilDate);
    return `Las reservas están bloqueadas por faltas hasta el ${hasta}`;
  }

  async cancel(
    orgId: string,
    input: { bookingId: string; byMember: boolean; override?: boolean },
    now = new Date(),
  ): Promise<{ late: boolean; chargeVoided: boolean; paidChargeKept: boolean; lateChargeKept: boolean }> {
    const repo = new ClassRepository(orgId);
    const booking = await repo.findBooking(input.bookingId);
    if (!booking) throw notFound('Reserva no encontrada');

    const schedule = await repo.findSchedule(booking.classScheduleId);
    if (!schedule) throw notFound('Clase no encontrada');

    const decision = evaluateCancellation(
      { status: booking.status, hasCharge: booking.chargeId !== null },
      { startsAt: schedule.startsAt },
      now,
      await this.settingsOf(orgId),
    );
    if (decision.outcome === 'DENY') {
      // Recepción SÍ puede cancelar fuera de tiempo, con permiso y motivo:
      // la clase se suspendió, el socio se lesionó, el sistema falló. Lo que
      // no puede es hacerlo en silencio.
      if (!(input.override && decision.reason === 'CLASS_ALREADY_STARTED')) {
        throw conflict(cancelMessage(decision.reason));
      }
    }

    const late = decision.outcome === 'ALLOW' ? decision.late : true;
    const canceled = await repo.cancelBooking(booking.id, input.byMember ? late : false);
    if (!canceled) throw conflict('La reserva ya no estaba activa');

    // Solo se anula un cargo SIN pagar. Si ya se pagó, anularlo hacía
    // desaparecer el dinero del estado de cuenta: el cargo se conserva y el
    // reembolso o crédito lo decide recepción, que queda avisada.
    let chargeVoided = false;
    let paidChargeKept = false;
    // D-16 (bloque 3.5): un lugar APARTADO sin pagar no deja deuda, se cancele cuando se cancele:
    // si no venir no le costaba nada (se liberaba solo una hora antes), avisar tampoco.
    const apartadoSinPagar = booking.holdUntil !== null;
    if (((decision.outcome === 'ALLOW' && decision.voidsCharge) || apartadoSinPagar) && booking.chargeId) {
      chargeVoided = (await new ChargeRepository(orgId).voidCharge(
        booking.chargeId, apartadoSinPagar && late ? 'Clase apartada sin pagar, cancelada: no deja deuda' : 'Cancelación de clase dentro del plazo',
      )) !== null;
      paidChargeKept = !chargeVoided;
      // Anulado el cargo, el saldo cacheado del socio baja en el momento (D3).
      if (chargeVoided) await new BillingService().refreshCachedBalance(orgId, booking.memberId);
    }
    // Fuera de plazo la clase suelta no se anula: si no se había pagado, se
    // sigue debiendo. El aviso de quien la quitó tiene que decirlo (11-02).
    const lateChargeKept = late && booking.chargeId !== null && !chargeVoided;
    return { late, chargeVoided, paidChargeKept, lateChargeKept };
  }

  async checkIn(orgId: string, bookingId: string, now = new Date()): Promise<void> {
    const repo = new ClassRepository(orgId);
    const booking = await repo.findBooking(bookingId);
    if (!booking) throw notFound('Reserva no encontrada');
    if (booking.status !== 'BOOKED') throw conflict('Esa reserva ya no admite check-in');
    const schedule = await repo.findSchedule(booking.classScheduleId);
    if (!schedule) throw notFound('Clase no encontrada');
    const ventana = attendanceWindowState(schedule, now);
    if (ventana !== 'OPEN') {
      throw conflict(ventana === 'BEFORE'
        ? 'El pase de lista se abre una hora antes de la clase'
        : 'El pase de lista se cerró 30 minutos después de terminar la clase');
    }
    const ok = await repo.checkIn(bookingId, now);
    if (!ok) throw conflict('Esa reserva ya tenía check-in');
  }

  async setCapacity(orgId: string, scheduleId: string, capacity: number): Promise<void> {
    const repo = new ClassRepository(orgId);
    const schedule = await repo.findSchedule(scheduleId);
    if (!schedule) throw notFound('Clase no encontrada');
    if (!canSetCapacity(capacity, schedule.bookedCount)) {
      throw validation(
        `No se puede bajar el cupo a ${capacity}: ya hay ${schedule.bookedCount} reservas. ` +
        'Cancela reservas primero.',
      );
    }
    const ok = await repo.setCapacity(scheduleId, capacity);
    if (!ok) throw conflict('No se pudo cambiar el cupo');
  }

  /**
   * Cierra las clases terminadas y aplica la sanción por faltas.
   *
   * Vive en un job y no en el momento del check-in porque nadie va a marcar a
   * mano que alguien NO vino: la ausencia solo se sabe cuando la clase acaba.
   */
  async closeFinished(
    orgId: string, now = new Date(), limit = 200,
  ): Promise<{ closed: number; attended: number; noShow: number; blocked: number }> {
    const repo = new ClassRepository(orgId);
    // Se cierra pasada la gracia del pase de lista: cerrar al minuto de
    // terminar marcaba "faltó" a quien el coach aún no alcanzaba a registrar.
    const pendientes = await repo.schedulesToClose(new Date(now.getTime() - ATTENDANCE_WINDOW.afterMin * 60_000), limit);
    const reglas = await this.settingsOf(orgId);

    let attended = 0;
    let noShow = 0;
    let blocked = 0;

    for (const schedule of pendientes) {
      const r = await repo.closeSchedule(schedule.id);
      attended += r.attended;
      noShow += r.noShow;

      for (const memberId of await repo.membersWithBookingsIn(schedule.id)) {
        const desde = new Date(now.getTime() - reglas.noShowWindowDays * 86_400_000);
        const faltas = await repo.noShowsSince(memberId, desde);
        const penalty = evaluateNoShowPenalty(faltas, now, reglas);
        if (penalty.kind !== 'BOOKING_BLOCK') continue;
        if (await repo.activeBlock(memberId, now)) continue;

        await repo.createBlock({
          memberId,
          untilDate: penalty.untilDate,
          noShowCount: penalty.count,
          reason: `${penalty.count} faltas en ${reglas.noShowWindowDays} días`,
        });
        blocked += 1;
      }
    }
    return { closed: pendientes.length, attended, noShow, blocked };
  }

  /**
   * Retira un horario: deja de generar clases y CANCELA las futuras ya
   * generadas. Quien tenía lugar pierde la reserva sin que cuente como falta
   * y, si pagó la clase suelta, el cargo se anula (lo hace `cancelSchedule`).
   */
  async retireTemplate(ctx: RequestContext, templateId: string, reason: string): Promise<{ canceledClasses: number; canceledBookings: number }> {
    if (!reason.trim()) throw validation('Quitar un horario exige un motivo');
    const orgId = ctx.tenant.organizationId;
    const repo = new ClassRepository(orgId);
    const now = new Date();
    // 2.13: el día de operación de la sede del horario, no el del gimnasio.
    const hoy = await new BusinessCalendar(orgId).today(await repo.templateBranch(templateId) ?? null);
    if (!await repo.retireTemplate(templateId, hoy)) throw notFound('Horario no encontrado o ya retirado');

    let canceledBookings = 0;
    const futuras = await repo.futureScheduleIds(templateId, now);
    for (const id of futuras) canceledBookings += await this.cancelSchedule(ctx, id, reason);
    return { canceledClasses: futuras.length, canceledBookings };
  }

  /**
   * Retira un tipo de clase entero: todos sus horarios y el tipo. Es "este
   * gimnasio ya no da Spinning". El historial se conserva.
   */
  async retireType(ctx: RequestContext, typeId: string, reason: string): Promise<{ canceledClasses: number; canceledBookings: number }> {
    const orgId = ctx.tenant.organizationId;
    const repo = new ClassRepository(orgId);
    if (!await repo.findType(typeId)) throw notFound('Tipo de clase no encontrado');

    let canceledClasses = 0;
    let canceledBookings = 0;
    for (const t of await repo.listTemplates({ classTypeId: typeId })) {
      const r = await this.retireTemplate(ctx, t.id, reason);
      canceledClasses += r.canceledClasses;
      canceledBookings += r.canceledBookings;
    }
    await repo.updateType(typeId, { isActive: false });
    return { canceledClasses, canceledBookings };
  }

  async cancelSchedule(ctx: RequestContext, scheduleId: string, reason: string): Promise<number> {
    if (!reason.trim()) throw validation('Cancelar una clase exige un motivo');
    const repo = new ClassRepository(ctx.tenant.organizationId);
    const afectadas = await repo.cancelSchedule(scheduleId, reason);

    // El cargo de clase suelta se anula: el gimnasio no da la clase.
    const charges = new ChargeRepository(ctx.tenant.organizationId);
    const billing = new BillingService();
    // Un cargo ya pagado no se anula (la base lo impide): queda para que
    // recepción decida reembolso o crédito.
    for (const booking of afectadas) {
      if (!booking.chargeId) continue;
      const anulado = await charges.voidCharge(booking.chargeId, `Clase cancelada: ${reason}`);
      // Con el cargo anulado, el saldo cacheado del socio baja en el momento (D3).
      if (anulado !== null) await billing.refreshCachedBalance(ctx.tenant.organizationId, booking.memberId);
    }
    return afectadas.length;
  }

  // ── Horario flexible (11-05, 11-06) ───────────────────────────────────────

  /**
   * SESIÓN ÚNICA: un taller, una clase de prueba, una masterclass. No sale
   * del horario semanal ni se repite; se reserva, se cobra y se cierra como
   * cualquier otra.
   */
  async createSingle(orgId: string, input: {
    branchId: string; classTypeId: string; date: string; startMinute: number; durationMin: number; capacity: number;
    coachUserId: string | null; room: string | null;
  }, now = new Date()): Promise<ScheduleRecord> {
    const repo = new ClassRepository(orgId);
    if (!await repo.findType(input.classTypeId)) throw notFound('Tipo de clase no encontrado');
    if (!(await sedesConClases(orgId))(input.branchId)) {
      throw new DomainError('MODULE_DISABLED', 'Esa sucursal no da clases');
    }
    const [y, m, d] = input.date.split('-').map(Number) as [number, number, number];
    const zona = await new BusinessCalendar(orgId).timezoneFor(input.branchId);
    const { at, resolution } = resolveWallTime(zona, y, m, d, Math.floor(input.startMinute / 60), input.startMinute % 60);
    if (at.getTime() <= now.getTime()) throw validation('Esa fecha y hora ya pasaron');
    if (at.getTime() > now.getTime() + 180 * 86_400_000) throw validation('Una sesión única se programa con seis meses de antelación como máximo');
    return repo.createSingle({
      branchId: input.branchId, classTypeId: input.classTypeId, coachUserId: input.coachUserId, room: input.room,
      startsAt: at, endsAt: new Date(at.getTime() + input.durationMin * 60_000),
      businessDate: new Date(Date.UTC(y, m - 1, d)), capacity: input.capacity, wallTimeResolution: resolution,
    });
  }

  /**
   * EDITAR UN HORARIO sin cancelarle la semana a nadie (11-06). Antes, mover
   * Spinning de 7:00 a 7:30 era quitar el horario (cancelando tres semanas de
   * reservas) y armarlo otra vez.
   *
   * La regla: las sesiones futuras cuyo día y hora siguen en el horario se
   * ajustan en su sitio (cupo, duración, salón, coach). Las que ya no caben
   * (cambió su hora, se quitó su día o quedaron después del «hasta») se
   * quitan SOLO si nadie tiene lugar; las que tienen reservas se quedan como
   * estaban y se devuelven en `kept`, para que una persona decida qué hacer
   * con cada una. Después se generan las del horario nuevo.
   */
  async updateTemplate(ctx: RequestContext, templateId: string, patch: {
    slots?: readonly WeeklySlot[] | undefined; room?: string | null | undefined; coachUserId?: string | null | undefined;
    /** Último día en que se da, INCLUIDO; `null` quita el fin. */
    until?: string | null | undefined;
  }, now = new Date()): Promise<{ updated: number; removed: number; generated: number; kept: Array<{ scheduleId: string; startsAt: Date; bookedCount: number }> }> {
    const orgId = ctx.tenant.organizationId;
    const repo = new ClassRepository(orgId);
    const actual = await repo.findTemplate(templateId);
    if (!actual || !actual.isActive) throw notFound('Horario no encontrado o ya retirado');

    const slots = patch.slots ?? actual.slots;
    if (slots.some((x) => !isValidSlot(x))) throw validation('Revisa los días, la hora, la duración y el cupo del horario');
    if (new Set(slots.map((x) => `${x.weekday}:${x.startMinute}`)).size !== slots.length) {
      throw validation('El horario repite el mismo día a la misma hora');
    }

    // El fin se guarda semiabierto (ADR-006): «hasta el 20» es `effectiveTo` = 21.
    let effectiveTo = actual.effectiveTo;
    if (patch.until !== undefined) {
      effectiveTo = patch.until === null ? null : new Date(new Date(`${patch.until}T00:00:00.000Z`).getTime() + 86_400_000);
      if (effectiveTo) {
        const hoy = await new BusinessCalendar(orgId).today(actual.branchId, now);
        if (effectiveTo.getTime() <= hoy.getTime() || effectiveTo.getTime() <= actual.effectiveFrom.getTime()) {
          throw validation('La fecha «hasta» ya pasó: para terminarlo hoy, quita el horario');
        }
      }
    }

    const room = patch.room !== undefined ? patch.room : actual.room;
    const coachUserId = patch.coachUserId !== undefined ? patch.coachUserId : actual.coachUserId;
    await repo.updateTemplate(templateId, {
      room, coachUserId, effectiveTo,
      ...(patch.slots ? { slots } : {}),
    });
    // Quién imparte vale para todas las que aún no empiezan, también las que se quedan en su hora anterior.
    if (coachUserId !== actual.coachUserId) await repo.setTemplateCoach(templateId, coachUserId, now);

    const porClave = new Map(slots.map((x) => [`${x.weekday}:${x.startMinute}`, x]));
    let updated = 0;
    let removed = 0;
    const kept: Array<{ scheduleId: string; startsAt: Date; bookedCount: number }> = [];
    for (const s of await repo.futureOfTemplate(templateId, now)) {
      // `plantilla:AAAA-MM-DD:díaDeLaSemana:minuto` (`occurrenceKeyOf`).
      const [, , weekday, minuto] = s.occurrenceKey.split(':');
      const slot = porClave.get(`${weekday}:${minuto}`);
      const dentro = !effectiveTo || s.businessDate.getTime() < effectiveTo.getTime();
      if (slot && dentro) {
        const endsAt = new Date(s.startsAt.getTime() + slot.durationMin * 60_000);
        const cambia = s.capacity !== slot.capacity || s.endsAt.getTime() !== endsAt.getTime() || s.room !== room;
        if (cambia && await repo.reshapeSchedule(s.id, { capacity: slot.capacity, endsAt, room, coachUserId })) updated += 1;
        continue;
      }
      if (s.bookedCount > 0) { kept.push({ scheduleId: s.id, startsAt: s.startsAt, bookedCount: s.bookedCount }); continue; }
      // Sin nadie inscrito: se quita. Si alguna vez tuvo reservas (ya canceladas), se cancela para conservar su historia.
      if (!await repo.deleteUnbooked(s.id)) await this.cancelSchedule(ctx, s.id, 'Cambio de horario');
      removed += 1;
    }
    const { created } = await this.materializeHorizon(orgId);
    return { updated, removed, generated: created, kept };
  }

  /**
   * PAUSA POR FECHAS (11-05): «del 22 de diciembre al 2 de enero no hay
   * clases». Cancela con UN motivo las sesiones de esos días que aún no
   * empiezan (quien tenía lugar lo pierde sin falta y su cargo sin pagar se
   * anula, como en cualquier cancelación del gimnasio) y deja de generar
   * sesiones en esas fechas mientras la pausa viva.
   */
  async createPause(ctx: RequestContext, input: { branchId: string | null; fromDate: string; toDate: string; reason: string }, now = new Date()): Promise<{ pause: ClassPauseRecord; canceledClasses: number; canceledBookings: number }> {
    const orgId = ctx.tenant.organizationId;
    const repo = new ClassRepository(orgId);
    const desde = new Date(`${input.fromDate}T00:00:00.000Z`);
    const hasta = new Date(`${input.toDate}T00:00:00.000Z`);
    if (hasta.getTime() < desde.getTime()) throw validation('La pausa termina antes de empezar');
    const hoy = await new BusinessCalendar(orgId).today(input.branchId, now);
    if (hasta.getTime() < hoy.getTime()) throw validation('Esas fechas ya pasaron');
    if (hasta.getTime() - desde.getTime() > 92 * 86_400_000) throw validation('Una pausa dura tres meses como máximo: si la clase ya no se da, quítala del horario');

    const pause = await repo.createPause({
      branchId: input.branchId, fromDate: desde, toDate: hasta, reason: input.reason, createdByUserId: ctx.tenant.actorUserId ?? null,
    });
    const ids = await repo.scheduledInDates({ branchId: input.branchId, fromDate: desde, toDate: hasta, after: now });
    let canceledBookings = 0;
    for (const id of ids) canceledBookings += await this.cancelSchedule(ctx, id, `Pausa del horario: ${input.reason}`);
    await repo.markPaused(ids, pause.id);
    return { pause, canceledClasses: ids.length, canceledBookings };
  }

  /** Quitar la pausa: vuelven (vacías) las sesiones que canceló y aún no empiezan, y se generan las que faltaban. */
  async endPause(ctx: RequestContext, pauseId: string, now = new Date()): Promise<{ restored: number; generated: number }> {
    const orgId = ctx.tenant.organizationId;
    const repo = new ClassRepository(orgId);
    if (!await repo.endPause(pauseId, ctx.tenant.actorUserId ?? null)) throw notFound('Pausa no encontrada o ya quitada');
    const restored = await repo.restorePaused(pauseId, now);
    const { created } = await this.materializeHorizon(orgId);
    return { restored, generated: created };
  }

  private async buildSubject(orgId: string, memberId: string, now: Date): Promise<Sujeto | null> {
    const member = await new MemberRepository(orgId).findByIdIncludingArchived(memberId);
    if (!member) return null;

    const membership = await new MembershipRepository(orgId).findLiveForMember(memberId);
    let view: BookingSubject['membership'] = null;
    let incluidas: readonly string[] = [];

    if (membership) {
      const plan = await new PlanRepository(orgId).findById(membership.planId);
      view = {
        status: membership.status,
        homeBranchId: member.homeBranchId,
        allowedBranchIds: membership.soldAtBranchId ? [membership.soldAtBranchId] : [],
        allBranches: (plan?.branchAccessScope ?? 'ALL_BRANCHES') === 'ALL_BRANCHES',
        // La cobertura llega hasta el fin del periodo vigente; con gracia, la
        // gracia manda, que es lo que el socio percibe como "sigo cubierto".
        coveredUntil: membership.graceUntil ?? membership.currentPeriodEnd,
        includesClasses: plan?.includesClasses ?? false,
      };
      incluidas = plan?.includedClassTypeIds ?? [];
    }

    const repo = new ClassRepository(orgId);
    const block = await repo.activeBlock(memberId, now);

    return {
      memberId,
      archived: member.status === 'ARCHIVED',
      membership: view,
      blockedUntil: block?.untilDate ?? null,
      alreadyBooked: false,
      incluidas,
    };
  }
}

function denialMessage(reason: string): string {
  const messages: Record<string, string> = {
    CLASS_CANCELED: 'Esa clase está cancelada',
    CLASS_CLOSED: 'Esa clase ya terminó',
    CLASS_ALREADY_STARTED: 'Esa clase ya empezó',
    CLASS_FULL: 'La clase está llena',
    ALREADY_BOOKED: 'Ya tienes lugar en esa clase',
    BOOKING_WINDOW_NOT_OPEN: 'Todavía no se abren las reservas de esa clase',
    MEMBER_ARCHIVED: 'El socio está dado de baja',
    NO_MEMBERSHIP: 'No hay una membresía vigente',
    MEMBERSHIP_NOT_VALID_AT_CLASS_TIME: 'La membresía no llega a la fecha de esa clase',
    MEMBERSHIP_FROZEN: 'La membresía está congelada',
    BRANCH_NOT_ALLOWED: 'La membresía no cubre esa sucursal',
    BLOCKED_BY_NO_SHOWS: 'Las reservas están bloqueadas por faltas acumuladas',
  };
  return messages[reason] ?? 'No se puede reservar esa clase';
}

function cancelMessage(reason: string): string {
  return reason === 'CLASS_ALREADY_STARTED'
    ? 'Esa clase ya empezó'
    : 'Esa reserva ya no está activa';
}
