import type { FastifyInstance } from 'fastify';
import { contar, registerModuleUsage } from '../../platform/modules/usage.js';
import { TrainingRepository } from './training.repository.js';
import { registerExerciseRoutes } from './exercises.routes.js';
import { registerRoutineRoutes } from './routines.routes.js';
import { registerAssignmentRoutes } from './assignments.routes.js';
import { registerPortalRoutineRoutes } from './portal-routine.routes.js';
import { registerCoachRoutes } from './coach.routes.js';
import { registerCoachLinkRoutes } from './coach-link.routes.js';

/**
 * RUTINAS — el coach las arma con el catálogo (diez ejercicios precargados
 * por bloque muscular, más los del gimnasio), las asigna y el socio las ve
 * en su teléfono. Son de la organización, no de una sede: el socio entrena
 * en cualquier sucursal con la misma rutina.
 *
 * En seis archivos por lo que hacen (auditoría 8, bloques 1.7, 2.6 y 3.8): ejercicios,
 * rutinas, asignación al socio, el portal, el día del coach y «Hacerme su coach».
 */
export function registerTrainingRoutes(app: FastifyInstance): void {
  registerModuleUsage('training', async (orgId) => ({
    inUse: contar(await new TrainingRepository(orgId).activeAssignments(), 'socio con rutina asignada', 'socios con rutina asignada'),
    blockers: [],
  }));
  registerExerciseRoutes(app);
  registerRoutineRoutes(app);
  registerAssignmentRoutes(app);
  registerPortalRoutineRoutes(app);
  registerCoachRoutes(app);
  registerCoachLinkRoutes(app);
}
