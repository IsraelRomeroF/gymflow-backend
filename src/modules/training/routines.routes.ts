import type { FastifyInstance } from 'fastify';
import { notFound, validation } from '@gymflow/core';
import { Routine, RoutineList } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { MemberRepository } from '../members/index.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { TrainingRepository, type RoutineInput } from './training.repository.js';
import { idParam, rutinaBody, serializeRoutine } from './training.serializers.js';

/** Las rutinas del gimnasio: verlas, armarlas, editarlas y archivarlas. */
export function registerRoutineRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  async function validarEjercicios(repo: TrainingRepository, body: RoutineInput) {
    const ids = [...new Set(body.days.flatMap((d) => d.items.map((i) => i.exerciseId)))];
    const usables = await repo.usableExerciseIds(ids);
    const ajenos = ids.filter((i) => !usables.has(i));
    if (ajenos.length) throw validation('La rutina usa ejercicios que no existen en el catálogo');
  }

  // Ver la lista basta para asignar: quien solo asigna (sin armar el
  // catálogo) veía «No hay rutinas» al abrir «Asignar rutina» (12-20).
  route(app, {
    method: 'GET', url: '/routines',
    security: { kind: 'permission', permission: 'training:template:manage', anyOf: ['training:assign'] },
    schema: respuesta(200, RoutineList),
    handler: async (request): Promise<RoutineList> => {
      // Sin las copias personales: son de un socio y se abren desde su ficha.
      const rows = await new TrainingRepository(request.ctx!.tenant.organizationId).routines();
      return {
        routines: rows.map((r) => ({
          id: r.id, name: r.name, goal: r.goal, level: r.level, days: r.dayNames.length, dayNames: r.dayNames,
          exercises: r._count.items, activeMembers: r._count.assignments, updatedAt: r.updatedAt.toISOString(),
        })),
      };
    },
  });

  route(app, {
    method: 'GET', url: '/routines/:id',
    security: { kind: 'permission', permission: 'training:template:manage', anyOf: ['training:assign'] },
    schema: respuesta(200, Routine),
    handler: async (request): Promise<Routine> => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const r = await new TrainingRepository(orgId).routine(id);
      if (!r) throw notFound('Rutina no encontrada');
      // De quién es la copia personal: el coach solo lo lee si el socio es suyo.
      let de: string | null = null;
      if (r.personalForMemberId) {
        const socios = new MemberRepository(orgId);
        const loVe = !ctx.coachOf || (await socios.assignedTo(ctx.coachOf)).includes(r.personalForMemberId);
        de = loVe ? (await socios.namesByIds([r.personalForMemberId])).get(r.personalForMemberId)?.fullName ?? null : null;
      }
      return serializeRoutine(r, de);
    },
  });

  route(app, {
    method: 'POST', url: '/routines',
    security: { kind: 'permission', permission: 'training:template:manage' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = rutinaBody.parse(request.body);
      const repo = new TrainingRepository(ctx.tenant.organizationId);
      await validarEjercicios(repo, body);
      const r = await repo.saveRoutine(null, body, ctx.tenant.actorUserId!);
      if (!r) throw notFound('Rutina no encontrada');
      await audit.record(ctx, { action: 'training.routine.create', resourceType: 'workout_template', resourceId: r.id, afterState: { name: r.name, days: r.dayNames.length, items: r.items.length } });
      return reply.status(201).send(serializeRoutine(r));
    },
  });

  route(app, {
    method: 'PUT', url: '/routines/:id',
    security: { kind: 'permission', permission: 'training:template:manage' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = rutinaBody.parse(request.body);
      const repo = new TrainingRepository(ctx.tenant.organizationId);
      await validarEjercicios(repo, body);
      const r = await repo.saveRoutine(id, body, ctx.tenant.actorUserId!);
      if (!r) throw notFound('Rutina no encontrada o archivada');
      await audit.record(ctx, { action: 'training.routine.update', resourceType: 'workout_template', resourceId: id, afterState: { name: r.name, days: r.dayNames.length, items: r.items.length } });
      return serializeRoutine(r);
    },
  });

  route(app, {
    method: 'POST', url: '/routines/:id/archive',
    security: { kind: 'permission', permission: 'training:template:manage' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const ok = await new TrainingRepository(request.ctx!.tenant.organizationId).archiveRoutine(id);
      if (!ok) throw notFound('Rutina no encontrada');
      await audit.record(request.ctx!, { action: 'training.routine.archive', resourceType: 'workout_template', resourceId: id });
      return { ok: true };
    },
  });
}
