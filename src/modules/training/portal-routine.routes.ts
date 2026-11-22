import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isoDate, notFound, validation } from '@gymflow/core';
import { PortalRoutine, PortalRoutineProgress } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { UserRepository } from '../identity/index.js';
import { MemberRepository } from '../members/index.js';
import { requireMemberSession } from '../portal/index.js';
import { TrainingRepository } from './training.repository.js';
import { avance, serializeRoutine } from './training.serializers.js';

/** El socio ve su rutina en el teléfono, sabe qué le toca hoy y marca lo hecho. */
export function registerPortalRoutineRoutes(app: FastifyInstance): void {
  // ── Portal del socio ──────────────────────────────────────────────────────

  /** La rutina vigente del socio de la sesión, con lo que hace falta para marcar. */
  async function laSuya(request: FastifyRequest) {
    const { organizationId, memberId } = await requireMemberSession(request);
    const repo = new TrainingRepository(organizationId);
    const a = await repo.activeAssignment(memberId);
    const r = a ? await repo.routine(a.workoutTemplateId) : null;
    if (!a || !r) throw notFound('Aún no tienes rutina');
    const hoy = await new BusinessCalendar(organizationId).today(null);
    return { repo, a, r, hoy, memberId };
  }

  /** Su rutina, en su teléfono. Nula si su coach aún no le asigna una. */
  route(app, {
    method: 'GET', url: '/portal/routine',
    security: { kind: 'member' },
    schema: respuesta(200, PortalRoutine),
    handler: async (request): Promise<PortalRoutine> => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const repo = new TrainingRepository(organizationId);
      const a = await repo.activeAssignment(memberId);
      if (!a) return { routine: null };
      const r = await repo.routine(a.workoutTemplateId);
      if (!r) return { routine: null };
      // «Tu coach» es el de su ficha; si no tiene, quien le asignó la rutina (12-12).
      const deLaFicha = await new MemberRepository(organizationId).coachOf(memberId);
      const quien = deLaFicha ?? a.assignedByUserId;
      const [nombres, hoy, logs] = await Promise.all([
        new UserRepository(organizationId).namesById([quien]),
        new BusinessCalendar(organizationId).today(null),
        repo.logs(a.id),
      ]);
      return {
        routine: serializeRoutine(r), assignedAt: a.assignedAt.toISOString(), coach: nombres.get(quien) ?? null, notes: a.notes,
        reviewDue: a.reviewOn !== null && isoDate(a.reviewOn) <= isoDate(hoy),
        progress: avance(logs, r.dayNames.length, hoy),
      };
    },
  });

  /** «Marcar día hecho» (12-02): el día de la rutina que hizo HOY. Repetirlo no duplica. */
  route(app, {
    method: 'POST', url: '/portal/routine/done',
    security: { kind: 'member' },
    schema: respuesta(201, PortalRoutineProgress),
    handler: async (request, reply) => {
      // Primero la sesión y su rutina; después lo que manda.
      const { repo, a, r, hoy, memberId } = await laSuya(request);
      const { dayIndex } = z.object({ dayIndex: z.number().int().min(1).max(7) }).parse(request.body);
      if (dayIndex > r.dayNames.length) throw validation('Tu rutina no tiene ese día');
      await repo.markDone({ assignmentId: a.id, memberId, dayIndex, doneOn: hoy, source: 'PORTAL' });
      const hecho: PortalRoutineProgress = { progress: avance(await repo.logs(a.id), r.dayNames.length, hoy) };
      return reply.status(201).send(hecho);
    },
  });

  /** «Deshacer»: solo lo que marcó hoy. */
  route(app, {
    method: 'POST', url: '/portal/routine/undo',
    security: { kind: 'member' },
    schema: respuesta(200, PortalRoutineProgress),
    handler: async (request): Promise<PortalRoutineProgress> => {
      const { repo, a, r, hoy } = await laSuya(request);
      const { dayIndex } = z.object({ dayIndex: z.number().int().min(1).max(7).optional() }).parse(request.body ?? {});
      await repo.undoDone(a.id, hoy, dayIndex);
      return { progress: avance(await repo.logs(a.id), r.dayNames.length, hoy) };
    },
  });
}
