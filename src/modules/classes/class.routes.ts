import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  conflict, DomainError, formatMoney, money, notFound, validation, isoDate,
  BOOKING_RULE_LIMITS, DEFAULT_BOOKING_SETTINGS, GYM_BOOKING_RULE_KEYS, type BookingSettings,
} from '@gymflow/core';
import {
  ClassPauseCreated, ClassPauseEnded, ClassPauses, ClassSessionCreated, ClassSettings, ClassTemplateUpdated,
  MemberClassBookings, SessionBookings,
  type ClassBookingPayment, type ClassPause, type ClassRules, type MemberClassBooking,
} from '@gymflow/core/contracts';
import { respuesta } from '../../platform/http/respuesta.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { route } from '../../platform/http/registry.js';
import { contar, registerModuleUsage } from '../../platform/modules/usage.js';
import { isModuleOn } from '../../platform/modules/module-state.js';
import { MemberRepository } from '../members/index.js';
import { BranchRepository } from '../organization/index.js';
import { StaffRepository, UserRepository } from '../identity/index.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { requireMemberSession } from '../portal/index.js';
import { ClassRepository, type BookingCharge, type ClassPauseRecord } from './class.repository.js';
import { ClassService, sedesConClases } from './class.service.js';

const idParam = z.object({ id: z.string().uuid() });
const iso = (d: Date) => d.toISOString();

const rangeQuery = z.object({
  branchId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD').refine((t) => !Number.isNaN(Date.parse(`${t}T00:00:00.000Z`)), 'Esa fecha no existe');
const slotSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1439),
  durationMin: z.number().int().min(5).max(480),
  capacity: z.number().int().min(1).max(500),
});

/**
 * Cómo va el dinero de un lugar (11-03): sin cargo va incluida en su plan;
 * con cargo, pagada, por pagar (con cuánto falta) o sin cobro si el cargo se
 * anuló o se condonó.
 */
function pagoDe(b: { chargeId: string | null; charge: BookingCharge | null }): { payment: ClassBookingPayment; pendingCents: bigint } {
  if (!b.chargeId || !b.charge) return { payment: 'INCLUDED', pendingCents: 0n };
  if (b.charge.status === 'VOID' || b.charge.status === 'WRITTEN_OFF') return { payment: 'WAIVED', pendingCents: 0n };
  const falta = b.charge.amountCents - b.charge.allocatedCents - b.charge.adjustedCents;
  if (falta > 0n) return { payment: 'PENDING', pendingCents: falta };
  return { payment: b.charge.allocatedCents > 0n ? 'PAID' : 'WAIVED', pendingCents: 0n };
}

const reglasDe = (s: BookingSettings): ClassRules => ({
  maxDaysAhead: s.maxDaysAhead, cancelCutoffMinutes: s.cancelCutoffMinutes, noShowWindowDays: s.noShowWindowDays,
  noShowsBeforeBlock: s.noShowsBeforeBlock, blockDays: s.blockDays,
});

function defaultRange(q: z.infer<typeof rangeQuery>): { from: Date; to: Date } {
  const from = q.from ?? new Date();
  const to = q.to ?? new Date(from.getTime() + 7 * 86_400_000);
  return { from, to };
}

export function registerClassRoutes(app: FastifyInstance): void {
  // Lo que hay vivo antes de apagar Clases: con lugares reservados, los
  // socios cuentan con esas clases y hay que resolverlo primero.
  registerModuleUsage('classes', async (orgId, branchId) => {
    const u = await new ClassRepository(orgId).usage(branchId);
    return {
      inUse: [...contar(u.types, 'clase', 'clases'), ...contar(u.upcomingSessions, 'sesión próxima', 'sesiones próximas')],
      blockers: contar(u.futureBookings, 'lugar reservado en clases próximas', 'lugares reservados en clases próximas'),
    };
  });
  const service = new ClassService();
  const audit = new AuditService();

  /** Una clase, su horario y sus reservas son de UNA sucursal: se opera ahí. */
  async function sedeDeClase(request: FastifyRequest, scheduleId: string): Promise<string> {
    const clase = await new ClassRepository(request.ctx!.tenant.organizationId).findSchedule(scheduleId);
    if (!clase) throw notFound('Clase no encontrada');
    return clase.branchId;
  }
  async function sesionDeReserva(request: FastifyRequest, bookingId: string): Promise<{ sede: string; sesion: { coachUserId: string | null } }> {
    const repo = new ClassRepository(request.ctx!.tenant.organizationId);
    const reserva = await repo.findBooking(bookingId);
    if (!reserva) throw notFound('Reserva no encontrada');
    const clase = await repo.findSchedule(reserva.classScheduleId);
    if (!clase) throw notFound('Clase no encontrada');
    return { sede: clase.branchId, sesion: clase };
  }

  // ── D-28 (fase 3, bloque 3.8): el coach opera SUS clases ──────────────────

  const ajena = () => new DomainError('FORBIDDEN', 'Esa clase la imparte otra persona: solo operas las tuyas', undefined, 'NOT_YOUR_CLASS');

  /**
   * Inscribir, quitar y pasar lista: quien es SOLO coach lo hace en las
   * sesiones que imparte o cubre, no en las de otro coach ni en las que no
   * tienen coach. Recepción y gerencia, en cualquiera de su sede.
   */
  function soloEnLaSuya(request: FastifyRequest, sesion: { coachUserId: string | null }): void {
    const coach = request.ctx!.coachOf;
    if (coach && sesion.coachUserId !== coach) throw ajena();
  }

  /** Y solo a SUS socios: a uno ajeno no lo encuentra, igual que en `/members/:id`. */
  async function soloAlSuyo(request: FastifyRequest, memberId: string): Promise<void> {
    const coach = request.ctx!.coachOf;
    if (!coach) return;
    const suyos = await new MemberRepository(request.ctx!.tenant.organizationId).assignedTo(coach);
    if (!suyos.includes(memberId.toLowerCase())) throw notFound('Socio no encontrado');
  }

  /**
   * Suplente y cupo (`classes:session:operate`): quien arma el horario de la
   * sede (`classes:manage`) opera cualquier sesión; los demás, la que imparten.
   * Devuelve si opera como dueño del horario.
   */
  function operaLaSesion(request: FastifyRequest, sesion: { branchId: string; coachUserId: string | null }): { armaElHorario: boolean } {
    if (request.holds('classes:manage', sesion.branchId)) return { armaElHorario: true };
    const yo = request.ctx!.tenant.actorUserId ?? null;
    if (yo === null || sesion.coachUserId !== yo) throw ajena();
    return { armaElHorario: false };
  }

  // ── Catálogo y horarios ───────────────────────────────────────────────────

  route(app, {
    method: 'GET',
    url: '/classes/types',
    security: { kind: 'session' },
    handler: async (request) => {
      const tipos = await new ClassRepository(request.ctx!.tenant.organizationId).listTypes(true);
      return {
        types: tipos.map((t) => ({
          ...t,
          dropInPriceCents: t.dropInPriceCents.toString(),
          dropInPriceLabel: formatMoney(money(t.dropInPriceCents)),
        })),
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/classes/types',
    security: { kind: 'permission', permission: 'classes:manage' },
    handler: async (request, reply) => {
      const body = z.object({
        name: z.string().min(2).max(80),
        description: z.string().max(500).nullish(),
        defaultDurationMin: z.number().int().min(5).max(480).default(60),
        defaultCapacity: z.number().int().min(1).max(500).default(20),
        dropInPriceCents: z.coerce.bigint().min(0n).default(0n),
        includableInPlans: z.boolean().default(true),
      }).parse(request.body);
      // El precio de la clase suelta es dinero: lo fija quien maneja precios
      // (SEC2-03), no cualquiera que arme el horario.
      if (body.dropInPriceCents > 0n) request.requirePermission('catalog:manage', null);

      let tipo;
      try {
        tipo = await new ClassRepository(request.ctx!.tenant.organizationId).createType(body);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict(`Ya existe una clase llamada ${body.name}. Si la retiraste, reactívala`);
        throw err;
      }
      await audit.record(request.ctx!, {
        action: 'class.type.create', resourceType: 'class_type', resourceId: tipo.id,
        afterState: { name: tipo.name, dropInPriceCents: tipo.dropInPriceCents.toString() },
      });
      return reply.status(201).send({ ...tipo, dropInPriceCents: tipo.dropInPriceCents.toString() });
    },
  });

  route(app, {
    method: 'PATCH',
    url: '/classes/types/:id',
    security: { kind: 'permission', permission: 'classes:manage' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({
        name: z.string().min(2).max(80).optional(),
        description: z.string().max(500).nullish(),
        defaultDurationMin: z.number().int().min(5).max(480).optional(),
        defaultCapacity: z.number().int().min(1).max(500).optional(),
        dropInPriceCents: z.coerce.bigint().min(0n).optional(),
        includableInPlans: z.boolean().optional(),
        // Reactivar una clase retirada: su nombre sigue ocupado, así que
        // volver a darla es reactivarla, no crear otra.
        isActive: z.literal(true).optional(),
        reason: z.string().trim().max(300).optional(),
      }).parse(request.body);
      const { reason, ...cambios } = body;
      const repo = new ClassRepository(request.ctx!.tenant.organizationId);
      let precioAntes: bigint | null = null;
      if (cambios.dropInPriceCents !== undefined) {
        const actual = await repo.findType(id);
        if (!actual) throw notFound('Tipo de clase no encontrado');
        if (actual.dropInPriceCents !== cambios.dropInPriceCents) {
          // Cambiar el precio pide el permiso de precios y su motivo (SEC2-03).
          request.requirePermission('catalog:manage', null);
          if (!reason || reason.length < 3) throw validation('Cambiar el precio pide un motivo');
          request.authorize('catalog:manage', { reason, branchId: null });
          precioAntes = actual.dropInPriceCents;
        }
      }
      // Si va incluida en los planes o se cobra siempre aparte es dinero: lo decide quien maneja precios.
      if (cambios.includableInPlans !== undefined) request.requirePermission('catalog:manage', null);
      const patch = Object.fromEntries(Object.entries(cambios).filter(([, v]) => v !== undefined));
      let tipo;
      try {
        tipo = await repo.updateType(id, patch);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('Ya existe otra clase con ese nombre');
        throw err;
      }
      if (!tipo) throw notFound('Tipo de clase no encontrado');
      await audit.record(request.ctx!, {
        action: precioAntes !== null ? 'class.type.price' : 'class.type.update', resourceType: 'class_type', resourceId: id,
        reason: precioAntes !== null ? reason ?? null : null,
        ...(precioAntes !== null ? { beforeState: { dropInPriceCents: precioAntes.toString() } } : {}),
        afterState: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
      });
      return { ...tipo, dropInPriceCents: tipo.dropInPriceCents.toString() };
    },
  });

  /** "Este gimnasio ya no da esta clase": retira sus horarios y cancela lo futuro. */
  route(app, {
    method: 'POST',
    url: '/classes/types/:id/retire',
    // Retirar cancela las sesiones futuras: es de la gerencia (D-28).
    security: { kind: 'permission', permission: 'classes:session:cancel' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(request.body);
      // Un tipo de clase es de todo el gimnasio: retirarlo exige alcance organizacional.
      request.authorize('classes:session:cancel', { reason, branchId: null });
      const r = await service.retireType(request.ctx!, id, reason);
      await audit.record(request.ctx!, {
        action: 'class.type.retire', resourceType: 'class_type', resourceId: id, reason, afterState: r,
      });
      return { ok: true, ...r };
    },
  });

  /** Horario semanal vigente. */
  route(app, {
    method: 'GET',
    url: '/classes/templates',
    security: { kind: 'session' },
    handler: async (request) => {
      const q = z.object({ branchId: z.string().uuid().optional() }).parse(request.query);
      const repo = new ClassRepository(request.ctx!.tenant.organizationId);
      const tipos = new Map((await repo.listTypes(true)).map((t) => [t.id, t.name]));
      const ts = await repo.listTemplates({ branchId: q.branchId });
      const coaches = await new UserRepository(request.ctx!.tenant.organizationId).namesById(ts.map((t) => t.coachUserId).filter((x): x is string => !!x));
      return {
        templates: ts.map((t) => ({
          ...t,
          className: tipos.get(t.classTypeId) ?? null,
          coachName: t.coachUserId ? coaches.get(t.coachUserId) ?? null : null,
          effectiveFrom: t.effectiveFrom.toISOString().slice(0, 10),
          effectiveTo: t.effectiveTo ? t.effectiveTo.toISOString().slice(0, 10) : null,
          // El último día en que se da, incluido (el fin guardado es semiabierto).
          until: t.effectiveTo ? isoDate(new Date(t.effectiveTo.getTime() - 86_400_000)) : null,
        })),
      };
    },
  });

  /** Quitar un horario: deja de generar clases y cancela las futuras. */
  route(app, {
    method: 'POST',
    url: '/classes/templates/:id/retire',
    // Quitar un horario cancela sus sesiones futuras: es de la gerencia (D-28).
    security: { kind: 'permission', permission: 'classes:session:cancel' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(request.body);
      const sede = await new ClassRepository(request.ctx!.tenant.organizationId).templateBranch(id);
      if (sede === undefined) throw notFound('Horario no encontrado');
      request.authorize('classes:session:cancel', { reason, branchId: sede });
      const r = await service.retireTemplate(request.ctx!, id, reason);
      await audit.record(request.ctx!, {
        action: 'class.template.retire', resourceType: 'class_template', resourceId: id, reason, afterState: r,
      });
      return { ok: true, ...r };
    },
  });

  route(app, {
    method: 'POST',
    url: '/classes/templates',
    security: { kind: 'permission', permission: 'classes:manage' },
    handler: async (request, reply) => {
      const body = z.object({
        branchId: z.string().uuid(),
        classTypeId: z.string().uuid(),
        coachUserId: z.string().uuid().nullish(),
        room: z.string().max(60).nullish(),
        effectiveFrom: z.coerce.date(),
        effectiveTo: z.coerce.date().nullish(),
        /** Último día en que se da, incluido (11-05). Manda sobre `effectiveTo`. */
        until: fechaIso.nullish(),
        slots: z.array(slotSchema).min(1).max(21),
      }).parse(request.body);

      request.authorize('classes:manage', { branchId: body.branchId });
      const orgId = request.ctx!.tenant.organizationId;
      if (!await new ClassRepository(orgId).findType(body.classTypeId)) throw notFound('Tipo de clase no encontrado');
      await coachValido(orgId, body.coachUserId ?? null);
      const { until, ...datos } = body;
      if (until) {
        datos.effectiveTo = new Date(new Date(`${until}T00:00:00.000Z`).getTime() + 86_400_000);
        if (datos.effectiveTo.getTime() <= datos.effectiveFrom.getTime()) throw validation('La fecha «hasta» es anterior al inicio del horario');
      }
      const created = await new ClassRepository(orgId).createTemplate(datos);
      // Se generan YA: esperar al job de la noche dejaría el horario nuevo
      // invisible en el portal hasta mañana.
      const { created: clases } = await service.materializeHorizon(orgId);
      await audit.record(request.ctx!, {
        action: 'class.template.create', resourceType: 'class_template', resourceId: created.id,
        branchId: body.branchId, afterState: { slots: body.slots.length, generated: clases },
      });
      return reply.status(201).send({ ...created, generated: clases });
    },
  });

  /**
   * EDITAR UN HORARIO (11-06): días, hora, duración, cupo, salón, coach y
   * hasta cuándo. Las sesiones con reservas no se tocan si su hora cambia:
   * vuelven en `kept` para que alguien decida.
   */
  route(app, {
    method: 'PATCH',
    url: '/classes/templates/:id',
    security: { kind: 'permission', permission: 'classes:manage' },
    schema: respuesta(200, ClassTemplateUpdated),
    handler: async (request): Promise<ClassTemplateUpdated> => {
      const { id } = idParam.parse(request.params);
      const body = z.object({
        slots: z.array(slotSchema).min(1).max(21).optional(),
        room: z.string().trim().max(60).nullish(),
        coachUserId: z.string().uuid().nullish(),
        until: fechaIso.nullish(),
      }).parse(request.body);
      const orgId = request.ctx!.tenant.organizationId;
      const repo = new ClassRepository(orgId);
      const sede = await repo.templateBranch(id);
      if (sede === undefined) throw notFound('Horario no encontrado');
      request.authorize('classes:manage', { branchId: sede });
      if (body.coachUserId) await coachValido(orgId, body.coachUserId);
      const antes = await repo.findTemplate(id);
      const r = await service.updateTemplate(request.ctx!, id, {
        slots: body.slots,
        ...(body.room !== undefined ? { room: body.room || null } : {}),
        ...(body.coachUserId !== undefined ? { coachUserId: body.coachUserId } : {}),
        ...(body.until !== undefined ? { until: body.until } : {}),
      });
      await audit.record(request.ctx!, {
        action: 'class.template.update', resourceType: 'class_template', resourceId: id, branchId: sede,
        beforeState: antes ? { slots: antes.slots, room: antes.room, coachUserId: antes.coachUserId, effectiveTo: antes.effectiveTo ? isoDate(antes.effectiveTo) : null } : null,
        afterState: { ...body, updated: r.updated, removed: r.removed, generated: r.generated, kept: r.kept.length },
      });
      return { ok: true, updated: r.updated, removed: r.removed, generated: r.generated, kept: r.kept.map((k) => ({ scheduleId: k.scheduleId, startsAt: iso(k.startsAt), bookedCount: k.bookedCount })) };
    },
  });

  /** Los coaches del gimnasio, para decir quién imparte cada clase. */
  route(app, {
    method: 'GET',
    url: '/classes/coaches',
    security: { kind: 'permission', permission: 'classes:read' },
    handler: async (request) => {
      const gente = await new StaffRepository(request.ctx!.tenant.organizationId).list();
      return {
        coaches: gente.filter((u) => u.isActive && u.assignments.some((a) => a.roleKey === 'COACH'))
          .map((u) => ({ id: u.id, fullName: u.fullName, branchIds: u.assignments.map((a) => a.branchId).filter((b): b is string => !!b) })),
      };
    },
  });

  async function coachValido(orgId: string, coachUserId: string | null) {
    if (!coachUserId) return;
    const c = await new StaffRepository(orgId).find(coachUserId);
    if (!c || !c.isActive || !c.assignments.some((a) => a.roleKey === 'COACH')) throw validation('Esa persona no es coach activo del gimnasio');
  }

  /**
   * QUIÉN IMPARTE (2026-10-09). En el horario: cambia el coach de ese horario
   * y de sus clases que aún no empiezan. El socio lo ve en su portal.
   */
  route(app, {
    method: 'PUT',
    url: '/classes/templates/:id/coach',
    security: { kind: 'permission', permission: 'classes:manage' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { coachUserId } = z.object({ coachUserId: z.string().uuid().nullable() }).parse(request.body);
      const orgId = request.ctx!.tenant.organizationId;
      const repo = new ClassRepository(orgId);
      const sede = await repo.templateBranch(id);
      if (sede === undefined) throw notFound('Horario no encontrado');
      request.authorize('classes:manage', { branchId: sede });
      await coachValido(orgId, coachUserId);
      const clases = await repo.setTemplateCoach(id, coachUserId, new Date());
      await audit.record(request.ctx!, { action: 'class.template.coach', resourceType: 'class_template', resourceId: id, branchId: sede, afterState: { coachUserId, clases } });
      return { ok: true, updated: clases };
    },
  });

  /**
   * Quién imparte UNA clase: un suplente ese día. El coach lo pone en la
   * sesión que imparte (D-28) y tiene que nombrar a alguien: dejarla sin coach
   * es de quien arma el horario.
   */
  route(app, {
    method: 'PUT',
    url: '/classes/schedules/:id/coach',
    security: { kind: 'permission', permission: 'classes:session:operate' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { coachUserId } = z.object({ coachUserId: z.string().uuid().nullable() }).parse(request.body);
      const orgId = request.ctx!.tenant.organizationId;
      const repo = new ClassRepository(orgId);
      const clase = await repo.findSchedule(id);
      if (!clase) throw notFound('Clase no encontrada');
      request.requirePermission('classes:session:operate', clase.branchId);
      const { armaElHorario } = operaLaSesion(request, clase);
      if (clase.status !== 'SCHEDULED') throw conflict('Esa clase ya no está programada');
      if (!armaElHorario && coachUserId === null) throw validation('Elige quién te cubre: dejar la clase sin coach lo decide la gerencia');
      await coachValido(orgId, coachUserId);
      await repo.setScheduleCoach(id, coachUserId);
      await audit.record(request.ctx!, {
        action: 'class.schedule.coach', resourceType: 'class_schedule', resourceId: id, branchId: clase.branchId,
        beforeState: { coachUserId: clase.coachUserId }, afterState: { coachUserId },
      });
      return { ok: true };
    },
  });

  /** Materializa el horizonte. Idempotente: se puede pulsar dos veces. */
  route(app, {
    method: 'POST',
    url: '/classes/schedules/generate',
    security: { kind: 'permission', permission: 'classes:manage' },
    handler: async (request) => {
      // Genera las clases de TODAS las sedes: acción de organización.
      request.requirePermission('classes:manage', null);
      const body = z.object({ days: z.number().int().min(1).max(90).default(21) }).parse(request.body ?? {});
      const r = await service.materializeHorizon(request.ctx!.tenant.organizationId, { days: body.days });
      return {
        ...r,
        // Si el cambio de hora movió alguna clase, que se vea aquí y no en la
        // puerta el domingo por la mañana.
        note: r.shifted > 0 ? `${r.shifted} clases quedaron marcadas por el cambio de hora` : null,
      };
    },
  });

  route(app, {
    method: 'GET',
    url: '/classes/schedules',
    security: { kind: 'session' },
    handler: async (request) => {
      // `mine=1`: solo las que imparte o cubre quien pregunta («Mis clases» del coach, 11-11).
      const q = rangeQuery.extend({ mine: z.enum(['1']).optional() }).parse(request.query);
      const { from, to } = defaultRange(q);
      const repo = new ClassRepository(request.ctx!.tenant.organizationId);
      const yo = request.ctx!.tenant.actorUserId ?? null;
      const todas = await repo.listSchedules({ branchId: q.branchId, from, to });
      const schedules = q.mine ? todas.filter((s) => yo !== null && s.coachUserId === yo) : todas;
      const tipos = new Map((await repo.listTypes(true)).map((t) => [t.id, t.name]));
      const coaches = await new UserRepository(request.ctx!.tenant.organizationId).namesById(schedules.map((s) => s.coachUserId).filter((x): x is string => !!x));

      return {
        schedules: schedules.map((s) => ({
          id: s.id,
          branchId: s.branchId,
          classTypeId: s.classTypeId,
          className: tipos.get(s.classTypeId) ?? null,
          templateId: s.templateId ?? null,
          coachUserId: s.coachUserId,
          coachName: s.coachUserId ? coaches.get(s.coachUserId) ?? null : null,
          room: s.room,
          startsAt: iso(s.startsAt),
          endsAt: iso(s.endsAt),
          capacity: s.capacity,
          bookedCount: s.bookedCount,
          spotsLeft: s.capacity - s.bookedCount,
          status: s.status,
          ...(s.wallTimeResolution === 'EXACT' ? {} : { timeShifted: s.wallTimeResolution }),
        })),
      };
    },
  });

  /**
   * SESIÓN ÚNICA (11-05): un taller, una clase de prueba, una masterclass.
   * La fecha y la hora son las de la sucursal.
   */
  route(app, {
    method: 'POST',
    url: '/classes/schedules',
    security: { kind: 'permission', permission: 'classes:manage' },
    schema: respuesta(201, ClassSessionCreated),
    handler: async (request, reply) => {
      const body = z.object({
        branchId: z.string().uuid(),
        classTypeId: z.string().uuid(),
        date: fechaIso,
        startMinute: z.number().int().min(0).max(1439),
        durationMin: z.number().int().min(5).max(480),
        capacity: z.number().int().min(1).max(500),
        coachUserId: z.string().uuid().nullish(),
        room: z.string().trim().max(60).nullish(),
      }).parse(request.body);
      request.authorize('classes:manage', { branchId: body.branchId });
      const orgId = request.ctx!.tenant.organizationId;
      await coachValido(orgId, body.coachUserId ?? null);
      const s = await service.createSingle(orgId, { ...body, coachUserId: body.coachUserId ?? null, room: body.room || null });
      await audit.record(request.ctx!, {
        action: 'class.schedule.create', resourceType: 'class_schedule', resourceId: s.id, branchId: s.branchId,
        afterState: { classTypeId: s.classTypeId, startsAt: iso(s.startsAt), capacity: s.capacity },
      });
      const creada: ClassSessionCreated = {
        id: s.id, branchId: s.branchId, classTypeId: s.classTypeId, startsAt: iso(s.startsAt), endsAt: iso(s.endsAt),
        capacity: s.capacity, timeShifted: s.wallTimeResolution === 'EXACT' ? null : s.wallTimeResolution,
      };
      return reply.status(201).send(creada);
    },
  });

  route(app, {
    method: 'PATCH',
    url: '/classes/schedules/:id/capacity',
    // El coach cambia el cupo de la sesión que imparte (D-28).
    security: { kind: 'permission', permission: 'classes:session:operate' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { capacity } = z.object({ capacity: z.number().int().min(1).max(500) }).parse(request.body);
      const antes = await new ClassRepository(request.ctx!.tenant.organizationId).findSchedule(id);
      if (!antes) throw notFound('Clase no encontrada');
      const sede = antes.branchId;
      request.requirePermission('classes:session:operate', sede);
      operaLaSesion(request, antes);
      await service.setCapacity(request.ctx!.tenant.organizationId, id, capacity);
      // Desde la lista de la sesión ya se usa (antes la ruta no tenía pantalla): queda en la bitácora.
      await audit.record(request.ctx!, {
        action: 'class.schedule.capacity', resourceType: 'class_schedule', resourceId: id, branchId: sede,
        beforeState: { capacity: antes.capacity }, afterState: { capacity },
      });
      return { ok: true, capacity };
    },
  });

  /**
   * CANCELAR UNA SESIÓN es de la gerencia (D-28, opción c): el coach no
   * cancela ninguna, ni la suya; si no puede darla, pone suplente o avisa.
   */
  route(app, {
    method: 'POST',
    url: '/classes/schedules/:id/cancel',
    security: { kind: 'permission', permission: 'classes:session:cancel' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(request.body);
      request.authorize('classes:session:cancel', { reason, branchId: await sedeDeClase(request, id) });

      const canceladas = await service.cancelSchedule(request.ctx!, id, reason);
      await audit.record(request.ctx!, {
        action: 'class.schedule.cancel',
        resourceType: 'class_schedule',
        resourceId: id,
        reason,
        afterState: { canceledBookings: canceladas },
      });
      return { ok: true, canceledBookings: canceladas };
    },
  });

  route(app, {
    method: 'GET',
    url: '/classes/schedules/:id/bookings',
    // Antes bastaba con tener sesión: cualquier usuario veía quién reservó.
    // Verla es `classes:read` (la dueña consulta); reservar sigue aparte.
    security: { kind: 'permission', permission: 'classes:read' },
    schema: respuesta(200, SessionBookings),
    handler: async (request): Promise<SessionBookings> => {
      const { id } = idParam.parse(request.params);
      const orgId = request.ctx!.tenant.organizationId;
      const repo = new ClassRepository(orgId);
      const sesion = await repo.findSchedule(id);
      if (!sesion) throw notFound('Clase no encontrada');
      request.requirePermission('classes:read', sesion.branchId);
      const bookings = await repo.listBookingsForSchedule(id);
      // Con nombre: el coach pasa lista viendo a quién, no identificadores.
      const socios = new MemberRepository(orgId);
      // Pero solo en la sesión que imparte o cubre; en las demás ve el cupo y a
      // SUS socios (A2 N-01): «el coach solo ve a sus socios asignados».
      const coach = request.ctx!.coachOf;
      const suyos = coach && sesion.coachUserId !== coach ? new Set(await socios.assignedTo(coach)) : null;
      const ve = (memberId: string) => suyos === null || suyos.has(memberId);
      // Una sola consulta para todos los nombres (antes, una por socio: 11-21).
      const nombres = await socios.namesByIds(bookings.map((b) => b.memberId).filter(ve));
      const filas = bookings.map((b) => {
        const visible = ve(b.memberId);
        // El pago (11-03): la lista es la puerta de un estudio sin torniquete.
        const { payment, pendingCents } = pagoDe(b);
        return {
          id: b.id,
          // Ajeno: el lugar cuenta, la persona no se dice.
          memberId: visible ? b.memberId : null,
          fullName: nombres.get(b.memberId)?.fullName ?? null,
          memberCode: nombres.get(b.memberId)?.memberCode ?? null,
          status: b.status,
          checkedInAt: b.checkedInAt ? iso(b.checkedInAt) : null,
          lateCancel: b.lateCancel,
          source: b.source,
          payment,
          chargeId: visible ? b.chargeId : null,
          pendingCents: pendingCents.toString(),
          pendingLabel: pendingCents > 0n ? formatMoney(money(pendingCents)) : null,
          // D-16 (bloque 3.5): si sigue sin pagar, hasta cuándo se le guarda el lugar.
          holdUntil: payment === 'PENDING' && b.holdUntil ? iso(b.holdUntil) : null,
          ...(visible ? {} : { hidden: true }),
        };
      });
      return {
        bookings: filas,
        pendingCount: filas.filter((b) => b.status !== 'CANCELED' && b.payment === 'PENDING').length,
      };
    },
  });

  /**
   * LAS CLASES DE UN SOCIO, para su ficha (11-04): lo que viene, lo de los
   * últimos 30 días y, si está bloqueado por faltas, hasta cuándo. Antes el
   * mostrador solo se enteraba de una reserva abriendo la sesión.
   */
  route(app, {
    method: 'GET',
    url: '/members/:id/bookings',
    security: { kind: 'permission', permission: 'classes:read' },
    schema: respuesta(200, MemberClassBookings),
    handler: async (request): Promise<MemberClassBookings> => {
      const { id } = idParam.parse(request.params);
      const orgId = request.ctx!.tenant.organizationId;
      // También de quien se dio de baja: su historial sigue ahí.
      const socio = await new MemberRepository(orgId).findByIdIncludingArchived(id);
      if (!socio) throw notFound('Socio no encontrado');
      const repo = new ClassRepository(orgId);
      const now = new Date();
      const reglas = await service.settingsOf(orgId);
      const filas = await repo.listBookingsForMember(id, new Date(now.getTime() - 30 * 86_400_000), 120);
      const tipos = new Map((await repo.listTypes(true)).map((t) => [t.id, t.name]));
      const coaches = await new UserRepository(orgId).namesById(filas.map((b) => b.coachUserId).filter((x): x is string => !!x));
      const sedes = new Map((await new BranchRepository(orgId).list()).map((b) => [b.id, b.name]));
      // El dinero de la clase suelta solo lo ve quien ve estados de cuenta en la sede del socio.
      const veDinero = request.holds('billing:statement:read', socio.homeBranchId);

      const serializar = (b: (typeof filas)[number]): MemberClassBooking => {
        const { payment, pendingCents } = pagoDe(b);
        return {
          id: b.id,
          classScheduleId: b.classScheduleId,
          className: tipos.get(b.classTypeId) ?? null,
          coachName: b.coachUserId ? coaches.get(b.coachUserId) ?? null : null,
          branchId: b.branchId,
          branchName: sedes.get(b.branchId) ?? null,
          room: b.room,
          startsAt: iso(b.startsAt),
          endsAt: iso(b.endsAt),
          status: b.status,
          lateCancel: b.lateCancel,
          checkedInAt: b.checkedInAt ? iso(b.checkedInAt) : null,
          source: b.source,
          payment,
          chargeId: veDinero ? b.chargeId : null,
          pendingCents: pendingCents.toString(),
          pendingLabel: pendingCents > 0n ? formatMoney(money(pendingCents)) : null,
        };
      };
      // «Lo que viene»: lugares vivos en clases que no han terminado (con la gracia del pase de lista).
      const viene = (b: (typeof filas)[number]) => b.status === 'BOOKED' && b.scheduleStatus === 'SCHEDULED'
        && b.endsAt.getTime() + 30 * 60_000 > now.getTime();
      const bloqueo = await repo.activeBlock(id, now);
      return {
        upcoming: filas.filter(viene).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).map(serializar),
        recent: filas.filter((b) => !viene(b)).sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime()).slice(0, 30).map(serializar),
        block: bloqueo ? { until: iso(bloqueo.untilDate), noShowCount: bloqueo.noShowCount } : null,
        noShows: {
          count: await repo.noShowsSince(id, new Date(now.getTime() - reglas.noShowWindowDays * 86_400_000)),
          windowDays: reglas.noShowWindowDays,
          blockAt: reglas.noShowsBeforeBlock,
        },
      };
    },
  });

  // ── Reglas de reserva del gimnasio (11-08) ────────────────────────────────

  async function ajustes(orgId: string): Promise<ClassSettings> {
    const guardado = await new ClassRepository(orgId).findSettings();
    const quien = guardado?.updatedByUserId ? (await new UserRepository(orgId).namesById([guardado.updatedByUserId])).get(guardado.updatedByUserId) ?? null : null;
    return {
      rules: reglasDe(await service.settingsOf(orgId)),
      defaults: reglasDe(DEFAULT_BOOKING_SETTINGS),
      isDefault: guardado === null,
      updatedAt: guardado ? iso(guardado.updatedAt) : null,
      updatedByName: quien,
    };
  }

  /** Las reglas vigentes: las lee todo el personal (el mostrador las cita al quitar una reserva). */
  route(app, {
    method: 'GET',
    url: '/classes/settings',
    security: { kind: 'session' },
    schema: respuesta(200, ClassSettings),
    handler: async (request): Promise<ClassSettings> => ajustes(request.ctx!.tenant.organizationId),
  });

  /**
   * Cambiarlas es de quien arma las clases de TODO el gimnasio y además
   * maneja precios y planes: deciden qué se le promete al socio, igual que un
   * plan. Valen desde que se guardan; un bloqueo ya puesto no se acorta.
   */
  route(app, {
    method: 'PUT',
    url: '/classes/settings',
    security: { kind: 'permission', permission: 'classes:manage' },
    schema: respuesta(200, ClassSettings),
    handler: async (request): Promise<ClassSettings> => {
      const campo = (k: keyof ClassRules) => z.number().int().min(BOOKING_RULE_LIMITS[k].min).max(BOOKING_RULE_LIMITS[k].max);
      const body = z.object({
        maxDaysAhead: campo('maxDaysAhead'), cancelCutoffMinutes: campo('cancelCutoffMinutes'),
        noShowWindowDays: campo('noShowWindowDays'), noShowsBeforeBlock: campo('noShowsBeforeBlock'), blockDays: campo('blockDays'),
      }).parse(request.body);
      request.requirePermission('classes:manage', null);
      request.requirePermission('catalog:manage', null);
      const orgId = request.ctx!.tenant.organizationId;
      const antes = reglasDe(await service.settingsOf(orgId));
      await new ClassRepository(orgId).saveSettings(body, request.ctx!.tenant.actorUserId ?? null);
      const cambios = GYM_BOOKING_RULE_KEYS.filter((k) => antes[k] !== body[k]);
      if (cambios.length > 0) {
        await audit.record(request.ctx!, {
          action: 'class.settings.update', resourceType: 'class_settings', resourceId: orgId,
          beforeState: Object.fromEntries(cambios.map((k) => [k, antes[k]])),
          afterState: Object.fromEntries(cambios.map((k) => [k, body[k]])),
        });
      }
      return ajustes(orgId);
    },
  });

  // ── Pausas del horario por fechas (11-05) ─────────────────────────────────

  async function pausasPara(orgId: string, filas: ClassPauseRecord[]): Promise<ClassPause[]> {
    const sedes = new Map((await new BranchRepository(orgId).list()).map((b) => [b.id, b.name]));
    const quienes = await new UserRepository(orgId).namesById(filas.map((p) => p.createdByUserId).filter((x): x is string => !!x));
    return filas.map((p) => ({
      id: p.id,
      branchId: p.branchId,
      branchName: p.branchId ? sedes.get(p.branchId) ?? null : null,
      fromDate: isoDate(p.fromDate),
      toDate: isoDate(p.toDate),
      reason: p.reason,
      createdAt: iso(p.createdAt),
      createdByName: p.createdByUserId ? quienes.get(p.createdByUserId) ?? null : null,
    }));
  }

  /** Las pausas que no han terminado, de la sucursal pedida y las de todo el gimnasio. */
  route(app, {
    method: 'GET',
    url: '/classes/pauses',
    security: { kind: 'permission', permission: 'classes:read' },
    schema: respuesta(200, ClassPauses),
    handler: async (request): Promise<ClassPauses> => {
      const q = z.object({ branchId: z.string().uuid().optional() }).parse(request.query);
      const orgId = request.ctx!.tenant.organizationId;
      if (q.branchId) request.requirePermission('classes:read', q.branchId);
      const hoy = await new BusinessCalendar(orgId).today(q.branchId ?? null);
      const vivas = await new ClassRepository(orgId).livePauses(hoy);
      return { pauses: await pausasPara(orgId, vivas.filter((p) => !q.branchId || p.branchId === null || p.branchId === q.branchId)) };
    },
  });

  route(app, {
    method: 'POST',
    url: '/classes/pauses',
    // Una pausa cancela las sesiones de esas fechas: es de la gerencia (D-28).
    security: { kind: 'permission', permission: 'classes:session:cancel' },
    schema: respuesta(201, ClassPauseCreated),
    handler: async (request, reply) => {
      const body = z.object({
        /** Sin sucursal: todo el gimnasio (pide alcance sobre todas). */
        branchId: z.string().uuid().nullish(),
        fromDate: fechaIso,
        toDate: fechaIso,
        reason: z.string().trim().min(3).max(300),
      }).parse(request.body);
      const sede = body.branchId ?? null;
      request.authorize('classes:session:cancel', { reason: body.reason, branchId: sede });
      const orgId = request.ctx!.tenant.organizationId;
      if (sede && !(await new BranchRepository(orgId).list()).some((b) => b.id === sede)) throw notFound('Sucursal no encontrada');
      const r = await service.createPause(request.ctx!, { branchId: sede, fromDate: body.fromDate, toDate: body.toDate, reason: body.reason });
      await audit.record(request.ctx!, {
        action: 'class.pause.create', resourceType: 'class_pause', resourceId: r.pause.id, branchId: sede, reason: body.reason,
        afterState: { fromDate: body.fromDate, toDate: body.toDate, canceledClasses: r.canceledClasses, canceledBookings: r.canceledBookings },
      });
      const creada: ClassPauseCreated = { pause: (await pausasPara(orgId, [r.pause]))[0]!, canceledClasses: r.canceledClasses, canceledBookings: r.canceledBookings };
      return reply.status(201).send(creada);
    },
  });

  /** Quitar una pausa: el id va en el cuerpo (ver `pendientes/2.5.md`). */
  route(app, {
    method: 'POST',
    url: '/classes/pauses/end',
    security: { kind: 'permission', permission: 'classes:manage' },
    schema: respuesta(200, ClassPauseEnded),
    handler: async (request): Promise<ClassPauseEnded> => {
      const { pauseId } = z.object({ pauseId: z.string().uuid() }).parse(request.body);
      const orgId = request.ctx!.tenant.organizationId;
      const pausa = await new ClassRepository(orgId).findPause(pauseId);
      if (!pausa) throw notFound('Pausa no encontrada');
      request.requirePermission('classes:manage', pausa.branchId);
      const r = await service.endPause(request.ctx!, pauseId);
      await audit.record(request.ctx!, {
        action: 'class.pause.end', resourceType: 'class_pause', resourceId: pauseId, branchId: pausa.branchId,
        afterState: { fromDate: isoDate(pausa.fromDate), toDate: isoDate(pausa.toDate), restored: r.restored, generated: r.generated },
      });
      return { ok: true, restored: r.restored, generated: r.generated };
    },
  });

  // ── Reservas desde el mostrador ───────────────────────────────────────────

  route(app, {
    method: 'POST',
    url: '/classes/schedules/:id/bookings',
    security: { kind: 'permission', permission: 'classes:book_for_member' },
    handler: async (request, reply) => {
      const { id } = idParam.parse(request.params);
      // D-16 (bloque 3.5): `payment` cobra la clase suelta en el momento de apartarla. Es obligatorio si el
      // socio debe su mensualidad o falta menos de una hora; sin él, el lugar se guarda hasta una hora antes.
      const { memberId, payment } = z.object({
        memberId: z.string().uuid(),
        payment: z.object({
          method: z.enum(['CASH', 'CARD_TERMINAL', 'SPEI_TRANSFER']),
          cashSessionId: z.string().uuid().optional(),
          externalRef: z.string().trim().max(120).optional(),
        }).refine((p) => p.method !== 'SPEI_TRANSFER' || !!p.externalRef, { message: 'Una transferencia necesita su referencia o clave de rastreo', path: ['externalRef'] }).optional(),
      }).parse(request.body);
      const ctx = request.ctx!;
      const sesion = await new ClassRepository(ctx.tenant.organizationId).findSchedule(id);
      if (!sesion) throw notFound('Clase no encontrada');
      request.requirePermission('classes:book_for_member', sesion.branchId);
      // Cobrar es otro permiso: el coach inscribe, pero no cobra.
      if (payment) request.authorize('payments:record', { branchId: sesion.branchId });
      // D-28: el coach inscribe a SUS socios en SUS clases.
      soloEnLaSuya(request, sesion);
      await soloAlSuyo(request, memberId);

      const r = await service.book(ctx.tenant.organizationId, {
        scheduleId: id,
        memberId,
        source: 'FRONT_DESK',
        bookedByUserId: ctx.tenant.actorUserId ?? null,
        cobro: payment ? { ctx, payment: { method: payment.method, cashSessionId: payment.cashSessionId ?? null, externalRef: payment.externalRef ?? null } } : null,
      });
      return reply.status(201).send(serializeBooking(r));
    },
  });

  route(app, {
    method: 'GET',
    url: '/classes/schedules/:id/quote',
    security: { kind: 'permission', permission: 'classes:book_for_member' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const sesion = await new ClassRepository(request.ctx!.tenant.organizationId).findSchedule(id);
      if (!sesion) throw notFound('Clase no encontrada');
      request.requirePermission('classes:book_for_member', sesion.branchId);
      const { memberId } = z.object({ memberId: z.string().uuid() }).parse(request.query);
      soloEnLaSuya(request, sesion);
      await soloAlSuyo(request, memberId);
      const q = await service.quote(request.ctx!.tenant.organizationId, id, memberId);
      return {
        ...q,
        priceCents: q.priceCents.toString(),
        priceLabel: q.priceCents > 0n ? formatMoney(money(q.priceCents)) : null,
        // D-16: hasta cuándo se le guardaría sin pagar, o por qué solo pagando ahora.
        holdUntil: q.holdUntil ? iso(q.holdUntil) : null,
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/classes/bookings/:id/cancel',
    security: { kind: 'permission', permission: 'classes:book_for_member' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({
        override: z.boolean().default(false),
        reason: z.string().max(300).optional(),
      }).parse(request.body ?? {});
      const ctx = request.ctx!;
      const { sede, sesion } = await sesionDeReserva(request, id);
      request.requirePermission('classes:book_for_member', sede);
      // D-28: el coach quita a alguien solo de la sesión que imparte.
      soloEnLaSuya(request, sesion);

      // Cancelar por el socio fuera de ventana es una excepción: exige su
      // propio permiso y su motivo, y queda en la bitácora.
      if (body.override) {
        request.requirePermission('classes:booking:override');
        request.authorize('classes:booking:override', { reason: body.reason ?? '', branchId: sede });
      }

      const r = await service.cancel(ctx.tenant.organizationId, {
        bookingId: id, byMember: false, override: body.override,
      });

      // Quitar a alguien de la clase queda en la bitácora, con el motivo si
      // quien la quita lo dice (11-02); fuera de tiempo, el motivo es obligatorio.
      await audit.record(ctx, {
        action: body.override ? 'class.booking.override_cancel' : 'class.booking.cancel',
        resourceType: 'class_booking',
        resourceId: id,
        branchId: sede,
        reason: body.reason?.trim() || null,
        afterState: { chargeVoided: r.chargeVoided, lateChargeKept: r.lateChargeKept },
      });
      return { ok: true, ...r };
    },
  });

  route(app, {
    method: 'POST',
    url: '/classes/bookings/:id/checkin',
    security: { kind: 'permission', permission: 'classes:book_for_member' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { sede, sesion } = await sesionDeReserva(request, id);
      request.requirePermission('classes:book_for_member', sede);
      // D-28: el coach pasa lista en la sesión que imparte, no en la de otro.
      soloEnLaSuya(request, sesion);
      await service.checkIn(request.ctx!.tenant.organizationId, id);
      return { ok: true };
    },
  });

  // ── Portal del socio ──────────────────────────────────────────────────────

  /**
   * ¿Da clases el gimnasio? El portal esconde la pestaña de Clases si no:
   * una pestaña que siempre dice "no hay clases" es ruido.
   */
  route(app, {
    method: 'GET',
    url: '/portal/classes/offered',
    module: 'core',
    security: { kind: 'member' },
    handler: async (request) => {
      const { organizationId } = await requireMemberSession(request);
      // Con el módulo apagado la respuesta es "no", no un error: es la
      // pregunta que el portal hace para decidir si muestra la pestaña.
      if (!(await isModuleOn(organizationId, 'classes'))) return { offered: false };
      return { offered: await new ClassRepository(organizationId).offersClasses() };
    },
  });

  route(app, {
    method: 'GET',
    url: '/portal/classes',
    security: { kind: 'member' },
    handler: async (request) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const q = rangeQuery.parse(request.query);
      const { from, to } = defaultRange(q);

      const repo = new ClassRepository(organizationId);
      const schedules = await repo.listSchedules({ branchId: q.branchId, from, to });
      const tipos = new Map((await repo.listTypes(true)).map((t) => [t.id, t]));
      // Cada clase es de UNA sucursal: el socio tiene que saber dónde es.
      const sedes = new Map((await new BranchRepository(organizationId).list()).map((b) => [b.id, b.name]));
      // Lo que ya estaba generado en una sede que dejó de dar clases no se ofrece (19-04).
      const daClases = await sedesConClases(organizationId);
      const now = new Date();

      // Una sola lectura del socio para toda la semana: evaluar clase por
      // clase multiplicaba por cuatro las consultas de cada fila.
      const ctx = await service.bulkContext(organizationId, memberId, now, from);
      // Quién imparte cada clase (2026-10-09).
      const coaches = await new UserRepository(organizationId).namesById(schedules.map((s) => s.coachUserId).filter((x): x is string => !!x));

      const out = [];
      for (const s of schedules) {
        if (s.status !== 'SCHEDULED' || !daClases(s.branchId)) continue;
        const bookingId = ctx.bookingByScheduleId.get(s.id) ?? null;
        const { decision } = await service.evaluate(organizationId, memberId, s, now, ctx);
        const tipo = tipos.get(s.classTypeId);

        out.push({
          id: s.id,
          className: tipo?.name ?? null,
          coachName: s.coachUserId ? coaches.get(s.coachUserId) ?? null : null,
          room: s.room,
          branchId: s.branchId,
          branchName: sedes.get(s.branchId) ?? null,
          startsAt: iso(s.startsAt),
          endsAt: iso(s.endsAt),
          spotsLeft: s.capacity - s.bookedCount,
          booked: bookingId !== null,
          bookingId,
          canBook: bookingId === null && decision.outcome === 'ALLOW',
          // El motivo viaja al portal: "no puedes reservar" sin decir por qué
          // manda al socio al mostrador, que es lo contrario de lo que busca
          // este sprint.
          reason: decision.outcome === 'DENY' ? decision.reason : null,
          requiresPayment: decision.outcome === 'ALLOW' ? decision.requiresPayment : false,
          priceLabel: decision.outcome === 'ALLOW' && decision.requiresPayment
            ? formatMoney(money(decision.priceCents)) : null,
          warnings: decision.outcome === 'ALLOW' ? decision.warnings : [],
        });
      }
      // Si está bloqueado por faltas, hasta cuándo (11-08): el portal puede decirlo.
      return { classes: out, blockedUntil: ctx.subject.blockedUntil ? iso(ctx.subject.blockedUntil) : null };
    },
  });

  route(app, {
    method: 'POST',
    url: '/portal/classes/:id/book',
    security: { kind: 'member' },
    handler: async (request, reply) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const { id } = idParam.parse(request.params);
      const r = await service.book(organizationId, { scheduleId: id, memberId, source: 'PORTAL' });
      return reply.status(201).send(serializeBooking(r));
    },
  });

  route(app, {
    method: 'POST',
    url: '/portal/bookings/:id/cancel',
    security: { kind: 'member' },
    handler: async (request) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const { id } = idParam.parse(request.params);

      // Un socio solo cancela LO SUYO. La comprobación es de pertenencia, no
      // de permiso: en el portal no hay permisos que consultar.
      const booking = await new ClassRepository(organizationId).findBooking(id);
      if (!booking || booking.memberId !== memberId) {
        const { notFound } = await import('@gymflow/core');
        throw notFound('Reserva no encontrada');
      }

      const r = await service.cancel(organizationId, { bookingId: id, byMember: true });
      return {
        ok: true,
        ...r,
        note: r.late
          ? 'Cancelaste fuera de plazo: cuenta como falta, pero tu lugar queda libre para alguien más'
          : null,
      };
    },
  });

  route(app, {
    method: 'GET',
    url: '/portal/bookings',
    security: { kind: 'member' },
    handler: async (request) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const desde = new Date(Date.now() - 30 * 86_400_000);
      const repo = new ClassRepository(organizationId);
      const bookings = await repo.listBookingsForMember(memberId, desde);
      const tipos = new Map((await repo.listTypes(true)).map((t) => [t.id, t.name]));
      const coaches = await new UserRepository(organizationId).namesById(bookings.map((b) => b.coachUserId).filter((x): x is string => !!x));
      const sedes = new Map((await new BranchRepository(organizationId).list()).map((b) => [b.id, b.name]));

      return {
        bookings: bookings
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
          .map((b) => ({
            id: b.id,
            classScheduleId: b.classScheduleId,
            className: tipos.get(b.classTypeId) ?? null,
            // Quién la imparte y dónde (2026-10-09).
            coachName: b.coachUserId ? coaches.get(b.coachUserId) ?? null : null,
            branchName: sedes.get(b.branchId) ?? null,
            room: b.room,
            startsAt: iso(b.startsAt),
            endsAt: iso(b.endsAt),
            status: b.status,
            lateCancel: b.lateCancel,
            // Incluida en su plan, pagada o por pagar en recepción.
            payment: !b.chargeId ? 'INCLUDED' : b.chargeStatus === 'PAID' ? 'PAID' : 'PENDING',
          })),
      };
    },
  });
}

function serializeBooking(r: {
  booking: { id: string; classScheduleId: string; status: string };
  chargeId: string | null; priceCents: bigint; warnings: readonly string[];
  holdUntil?: Date | null; paymentId?: string | null;
}) {
  return {
    id: r.booking.id,
    classScheduleId: r.booking.classScheduleId,
    status: r.booking.status,
    chargeId: r.chargeId,
    // D-16 (bloque 3.5): hasta cuándo se guarda el lugar sin pagar, y el cobro si se hizo al apartar.
    holdUntil: r.holdUntil ? r.holdUntil.toISOString() : null,
    paymentId: r.paymentId ?? null,
    priceCents: r.priceCents.toString(),
    priceLabel: r.priceCents > 0n ? formatMoney(money(r.priceCents)) : null,
    warnings: r.warnings,
  };
}
