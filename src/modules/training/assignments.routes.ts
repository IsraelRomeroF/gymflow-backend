import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forbidden, isoDate, notFound } from '@gymflow/core';
import { MemberRoutine, RoutineAssigned, RoutinePersonalized } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { MemberRepository } from '../members/index.js';
import { UserRepository } from '../identity/index.js';
import { TrainingRepository } from './training.repository.js';
import { avance, idParam, serializeRoutine } from './training.serializers.js';

/** «Revisar en»: las semanas que el coach elige al asignar (12-09). */
const SEMANAS_DE_REVISION = [4, 6, 8] as const;

/** La rutina asignada a cada socio: cuál tiene, asignarla, personalizarla y quitarla. */
export function registerAssignmentRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  // ── Asignación al socio ───────────────────────────────────────────────────

  // Recepción la ve (y la imprime) con `training:read`, sin poder cambiarla (12-17).
  route(app, {
    method: 'GET', url: '/members/:id/routine',
    security: { kind: 'permission', permission: 'training:assign', anyOf: ['training:read'] },
    schema: respuesta(200, MemberRoutine),
    handler: async (request): Promise<MemberRoutine> => {
      const orgId = request.ctx!.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      // Un socio de otra organización es 404, no "sin rutina".
      const socio = await new MemberRepository(orgId).findById(id);
      if (!socio) throw notFound('Socio no encontrado');
      const repo = new TrainingRepository(orgId);
      const a = await repo.activeAssignment(id);
      if (!a) return { assignment: null };
      const [r, nombres, hoy] = await Promise.all([
        repo.routine(a.workoutTemplateId),
        new UserRepository(orgId).namesById([a.assignedByUserId]),
        new BusinessCalendar(orgId).today(null),
      ]);
      const reviewOn = a.reviewOn ? isoDate(a.reviewOn) : null;
      return {
        assignment: {
          id: a.id, assignedAt: a.assignedAt.toISOString(), assignedBy: nombres.get(a.assignedByUserId) ?? null, notes: a.notes,
          reviewOn, reviewDue: reviewOn !== null && reviewOn <= isoDate(hoy),
          routine: r ? serializeRoutine(r, r.personalForMemberId === id ? `${socio.firstName} ${socio.lastName}` : null) : null,
          progress: r ? avance(await repo.logs(a.id), r.dayNames.length, hoy) : null,
        },
      };
    },
  });

  route(app, {
    method: 'POST', url: '/members/:id/routine',
    security: { kind: 'permission', permission: 'training:assign' },
    schema: respuesta(201, RoutineAssigned),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        routineId: z.string().uuid(),
        notes: z.string().max(300).nullish().transform((v) => v?.trim() || null),
        // «Revisar en»: 4, 6 u 8 semanas. Sin el dato, la rutina no tiene fecha de revisión.
        reviewWeeks: z.union([z.literal(4), z.literal(6), z.literal(8)], { error: `«Revisar en» es ${SEMANAS_DE_REVISION.join(', ')} semanas` }).nullish(),
      }).parse(request.body);
      const orgId = ctx.tenant.organizationId;
      if (!await new MemberRepository(orgId).findById(id)) throw notFound('Socio no encontrado');
      const repo = new TrainingRepository(orgId);
      const r = await repo.routine(body.routineId);
      if (!r || r.archivedAt) throw notFound('Rutina no encontrada');
      // La copia personal de un socio no se le da a otro.
      if (r.personalForMemberId && r.personalForMemberId !== id) throw notFound('Rutina no encontrada');
      const hoy = await new BusinessCalendar(orgId).today(null);
      const reviewOn = body.reviewWeeks ? new Date(hoy.getTime() + body.reviewWeeks * 7 * 86_400_000) : null;
      const a = await repo.assign(id, r.id, ctx.tenant.actorUserId!, body.notes, reviewOn);
      await audit.record(ctx, {
        action: 'training.routine.assign', resourceType: 'member', resourceId: id,
        afterState: { routineId: r.id, routine: r.name, ...(reviewOn ? { reviewOn: isoDate(reviewOn) } : {}) },
      });
      const hecho: RoutineAssigned = { assignmentId: a.id, assignedAt: a.assignedAt.toISOString(), reviewOn: a.reviewOn ? isoDate(a.reviewOn) : null };
      return reply.status(201).send(hecho);
    },
  });

  /**
   * «PERSONALIZAR PARA…» (12-05): la rutina que el socio tiene se vuelve una
   * copia suya. Editarla después ya no le cambia nada a los demás. Crea una
   * rutina: además de asignar, pide poder armar rutinas.
   */
  route(app, {
    method: 'POST', url: '/members/:id/routine/personalize',
    security: { kind: 'permission', permission: 'training:assign' },
    schema: respuesta([200, 201], RoutinePersonalized),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const orgId = ctx.tenant.organizationId;
      if (!await new MemberRepository(orgId).findById(id)) throw notFound('Socio no encontrado');
      if (!ctx.tenant.grants.some((g) => g.permission === 'training:template:manage')) throw forbidden('Personalizar crea una rutina: hace falta poder armar rutinas');
      const hecho = await new TrainingRepository(orgId).personalize(id, ctx.tenant.actorUserId!);
      if (!hecho) throw notFound('El socio no tiene rutina activa');
      if (hecho.created) {
        await audit.record(ctx, { action: 'training.routine.personalize', resourceType: 'member', resourceId: id, afterState: { routineId: hecho.routineId } });
      }
      return reply.status(hecho.created ? 201 : 200).send(hecho satisfies RoutinePersonalized);
    },
  });

  route(app, {
    method: 'POST', url: '/members/:id/routine/end',
    security: { kind: 'permission', permission: 'training:assign' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      // Por qué se quitó, si quien la quita lo dice: queda en la bitácora (12-08).
      const { reason } = z.object({ reason: z.string().trim().max(300).optional() }).parse(request.body ?? {});
      const ok = await new TrainingRepository(request.ctx!.tenant.organizationId).endAssignment(id, request.ctx!.tenant.actorUserId ?? null);
      if (!ok) throw notFound('El socio no tiene rutina activa');
      await audit.record(request.ctx!, { action: 'training.routine.end', resourceType: 'member', resourceId: id, reason: reason || null });
      return { ok: true };
    },
  });
}
