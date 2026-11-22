import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { route } from '../../platform/http/registry.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { TrainingRepository } from './training.repository.js';
import { grupo } from './training.serializers.js';

/** El catálogo de ejercicios: los precargados por bloque muscular y los del gimnasio. */
export function registerExerciseRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  route(app, {
    method: 'GET', url: '/exercises',
    security: { kind: 'permission', permission: 'training:template:manage' },
    handler: async (request) => {
      const q = z.object({ muscleGroup: grupo.optional() }).parse(request.query);
      const rows = await new TrainingRepository(request.ctx!.tenant.organizationId).exercises(q.muscleGroup);
      return { exercises: rows.map((e) => ({ ...e, custom: e.organizationId !== null })) };
    },
  });

  route(app, {
    method: 'POST', url: '/exercises',
    security: { kind: 'permission', permission: 'training:template:manage' },
    handler: async (request, reply) => {
      const body = z.object({
        name: z.string().trim().min(2).max(80), muscleGroup: grupo,
        equipment: z.string().max(40).nullish().transform((v) => v?.trim() || null),
        instructions: z.string().max(300).nullish().transform((v) => v?.trim() || null),
      }).parse(request.body);
      const e = await new TrainingRepository(request.ctx!.tenant.organizationId).createExercise(body);
      await audit.record(request.ctx!, { action: 'training.exercise.create', resourceType: 'exercise', resourceId: e.id, afterState: { name: e.name, muscleGroup: e.muscleGroup } });
      return reply.status(201).send({ ...e, custom: true });
    },
  });
}
