import { uuidv7 } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

export type MuscleGroup = 'CHEST' | 'BACK' | 'SHOULDERS' | 'BICEPS' | 'TRICEPS' | 'LEGS' | 'GLUTES' | 'ABS';
export const MUSCLE_GROUPS: readonly MuscleGroup[] = ['CHEST', 'BACK', 'SHOULDERS', 'BICEPS', 'TRICEPS', 'LEGS', 'GLUTES', 'ABS'];

export type ExerciseRecord = {
  id: string; organizationId: string | null; code: string | null; name: string;
  muscleGroup: MuscleGroup; equipment: string | null; instructions: string | null;
};

export type RoutineItemInput = { exerciseId: string; sets: number; reps: string; restSeconds: number | null; notes: string | null };
export type RoutineInput = {
  name: string; goal: string | null; level: string | null; notes: string | null;
  days: Array<{ name: string; items: RoutineItemInput[] }>;
};

export type RoutineRecord = {
  id: string; name: string; goal: string | null; level: string | null; notes: string | null;
  dayNames: string[]; createdByUserId: string; createdAt: Date; updatedAt: Date; archivedAt: Date | null;
  /** Copia personal de un socio («Personalizar para…»): no sale en el catálogo. */
  personalForMemberId: string | null;
  /** Cuántos socios la tienen hoy. */
  _count: { assignments: number };
  items: Array<{
    id: string; exerciseId: string; dayIndex: number; orderIndex: number; sets: number; reps: string;
    restSeconds: number | null; notes: string | null; exercise: ExerciseRecord;
  }>;
};

const EXERCISE_SELECT = {
  id: true, organizationId: true, code: true, name: true, muscleGroup: true, equipment: true, instructions: true,
} as const;

const ROUTINE_SELECT = {
  id: true, name: true, goal: true, level: true, notes: true, dayNames: true,
  createdByUserId: true, createdAt: true, updatedAt: true, archivedAt: true, personalForMemberId: true,
  _count: { select: { assignments: { where: { endedAt: null } } } },
  items: {
    select: { id: true, exerciseId: true, dayIndex: true, orderIndex: true, sets: true, reps: true, restSeconds: true, notes: true, exercise: { select: EXERCISE_SELECT } },
    orderBy: [{ dayIndex: 'asc' }, { orderIndex: 'asc' }] as Array<{ dayIndex?: 'asc'; orderIndex?: 'asc' }>,
  },
} as const;

export class TrainingRepository extends TenantRepository {
  /** Para la pantalla de Módulos: socios que hoy ven una rutina en su teléfono. */
  async activeAssignments(): Promise<number> {
    return this.db.workoutAssignment.count({ where: this.scope({ endedAt: null }) });
  }

  // ── Catálogo ──────────────────────────────────────────────────────────────

  /** Los del gimnasio y los globales (organizationId NULO). */
  async exercises(muscleGroup?: MuscleGroup): Promise<ExerciseRecord[]> {
    const rows = await this.db.exercise.findMany({
      where: {
        isActive: true,
        OR: [{ organizationId: this.organizationId }, { organizationId: null }],
        ...(muscleGroup ? { muscleGroup } : {}),
      },
      select: EXERCISE_SELECT,
      orderBy: [{ muscleGroup: 'asc' }, { code: 'asc' }, { name: 'asc' }],
    });
    return rows as ExerciseRecord[];
  }

  /** ¿Todos esos ejercicios son usables por este gimnasio? */
  async usableExerciseIds(ids: readonly string[]): Promise<Set<string>> {
    const rows = await this.db.exercise.findMany({
      where: { id: { in: [...ids] }, isActive: true, OR: [{ organizationId: this.organizationId }, { organizationId: null }] },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  async createExercise(input: { name: string; muscleGroup: MuscleGroup; equipment: string | null; instructions: string | null }): Promise<ExerciseRecord> {
    const row = await this.db.exercise.create({
      data: { id: uuidv7(), organizationId: this.organizationId, ...input },
      select: EXERCISE_SELECT,
    });
    return row as ExerciseRecord;
  }

  // ── Rutinas ───────────────────────────────────────────────────────────────

  /**
   * El catálogo del gimnasio. Las copias personales («Personalizar para…») no
   * salen: son de un socio. `createdBy`: solo las que armó esa persona.
   */
  async routines(includeArchived = false, opts: { createdBy?: string; take?: number } = {}) {
    return this.db.workoutTemplate.findMany({
      where: this.scope({
        personalForMemberId: null,
        ...(includeArchived ? {} : { archivedAt: null }),
        ...(opts.createdBy ? { createdByUserId: opts.createdBy } : {}),
      }),
      ...(opts.take ? { take: opts.take } : {}),
      select: {
        id: true, name: true, goal: true, level: true, dayNames: true, updatedAt: true, archivedAt: true,
        _count: { select: { items: true, assignments: { where: { endedAt: null } } } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async routine(id: string): Promise<RoutineRecord | null> {
    const r = await this.db.workoutTemplate.findFirst({ where: this.scope({ id }), select: ROUTINE_SELECT });
    return r as RoutineRecord | null;
  }

  /**
   * Crea o REEMPLAZA la rutina completa en una transacción: días y ejercicios
   * se guardan juntos o no se guarda nada. Editar una rutina asignada cambia
   * lo que ven sus socios, que es lo esperado: es la rutina viva del coach.
   */
  async saveRoutine(id: string | null, input: RoutineInput, userId: string): Promise<RoutineRecord | null> {
    return this.db.$transaction(async (tx): Promise<RoutineRecord | null> => {
      const datos = {
        name: input.name, goal: input.goal, level: input.level, notes: input.notes,
        dayNames: input.days.map((d) => d.name),
      };
      let routineId = id;
      if (routineId) {
        const { count } = await tx.workoutTemplate.updateMany({ where: this.scope({ id: routineId, archivedAt: null }), data: datos });
        if (count === 0) return null;
        await tx.workoutTemplateItem.deleteMany({ where: { workoutTemplateId: routineId } });
      } else {
        routineId = uuidv7();
        await tx.workoutTemplate.create({ data: { id: routineId, organizationId: this.organizationId, createdByUserId: userId, ...datos } });
      }
      const items = input.days.flatMap((d, di) => d.items.map((it, oi) => ({
        id: uuidv7(), workoutTemplateId: routineId!, exerciseId: it.exerciseId,
        dayIndex: di + 1, orderIndex: oi + 1, sets: it.sets, reps: it.reps,
        restSeconds: it.restSeconds, notes: it.notes,
      })));
      if (items.length) await tx.workoutTemplateItem.createMany({ data: items });
      return (await tx.workoutTemplate.findFirstOrThrow({ where: { id: routineId }, select: ROUTINE_SELECT })) as RoutineRecord;
    });
  }

  async archiveRoutine(id: string): Promise<boolean> {
    const { count } = await this.db.workoutTemplate.updateMany({ where: this.scope({ id, archivedAt: null }), data: { archivedAt: new Date() } });
    return count > 0;
  }

  // ── Asignación ────────────────────────────────────────────────────────────

  async activeAssignment(memberId: string) {
    return this.db.workoutAssignment.findFirst({
      where: this.scope({ memberId, endedAt: null }),
      select: { id: true, notes: true, assignedAt: true, assignedByUserId: true, workoutTemplateId: true, reviewOn: true },
    });
  }

  /** Cierra la activa (si hay) y abre la nueva, juntas. `reviewOn`: cuándo toca revisarla. */
  async assign(memberId: string, routineId: string, userId: string, notes: string | null, reviewOn: Date | null = null) {
    return this.db.$transaction(async (tx) => {
      await tx.workoutAssignment.updateMany({ where: this.scope({ memberId, endedAt: null }), data: { endedAt: new Date(), endedByUserId: userId } });
      return tx.workoutAssignment.create({
        data: { id: uuidv7(), organizationId: this.organizationId, memberId, workoutTemplateId: routineId, assignedByUserId: userId, notes, reviewOn },
        select: { id: true, assignedAt: true, reviewOn: true },
      });
    });
  }

  /**
   * «PERSONALIZAR PARA…» (12-05): la rutina que el socio tiene hoy se copia a
   * una suya (misma asignación: conserva fecha, nota, revisión y días hechos)
   * y deja de compartirla. Lo que el coach le cambie ya no le llega a nadie
   * más. Si ya era personal de ese socio, no se copia otra vez.
   */
  async personalize(memberId: string, userId: string): Promise<{ routineId: string; assignmentId: string; created: boolean } | null> {
    return this.db.$transaction(async (tx) => {
      const a = await tx.workoutAssignment.findFirst({ where: this.scope({ memberId, endedAt: null }), select: { id: true, workoutTemplateId: true } });
      if (!a) return null;
      const origen = await tx.workoutTemplate.findFirst({
        where: this.scope({ id: a.workoutTemplateId }),
        select: {
          id: true, name: true, goal: true, level: true, notes: true, dayNames: true, personalForMemberId: true,
          items: { select: { exerciseId: true, dayIndex: true, orderIndex: true, sets: true, reps: true, restSeconds: true, notes: true } },
        },
      });
      if (!origen) return null;
      if (origen.personalForMemberId === memberId) return { routineId: origen.id, assignmentId: a.id, created: false };
      const routineId = uuidv7();
      await tx.workoutTemplate.create({
        data: {
          id: routineId, organizationId: this.organizationId, createdByUserId: userId, personalForMemberId: memberId,
          name: origen.name, goal: origen.goal, level: origen.level, notes: origen.notes, dayNames: origen.dayNames,
        },
      });
      if (origen.items.length) await tx.workoutTemplateItem.createMany({ data: origen.items.map((it) => ({ ...it, id: uuidv7(), workoutTemplateId: routineId })) });
      await tx.workoutAssignment.updateMany({ where: this.scope({ id: a.id, endedAt: null }), data: { workoutTemplateId: routineId } });
      return { routineId, assignmentId: a.id, created: true };
    });
  }

  // ── Días hechos («Hoy toca») ──────────────────────────────────────────────

  /** Los últimos días marcados de una asignación, el más reciente primero. */
  async logs(assignmentId: string, take = 60): Promise<Array<{ dayIndex: number; doneOn: Date }>> {
    return this.db.workoutLog.findMany({
      where: this.scope({ assignmentId }),
      select: { dayIndex: true, doneOn: true },
      orderBy: [{ doneOn: 'desc' }, { createdAt: 'desc' }],
      take,
    });
  }

  /** Marca un día como hecho hoy. Repetirlo no duplica (índice único). */
  async markDone(input: { assignmentId: string; memberId: string; dayIndex: number; doneOn: Date; source: 'PORTAL' | 'COACH' }): Promise<void> {
    await this.db.workoutLog.createMany({
      data: [{ id: uuidv7(), organizationId: this.organizationId, ...input }],
      skipDuplicates: true,
    });
  }

  /** «Deshacer»: quita lo marcado ESE día (solo se deshace lo de hoy). */
  async undoDone(assignmentId: string, doneOn: Date, dayIndex?: number): Promise<number> {
    const { count } = await this.db.workoutLog.deleteMany({ where: this.scope({ assignmentId, doneOn, ...(dayIndex ? { dayIndex } : {}) }) });
    return count;
  }

  // ── El día del coach ──────────────────────────────────────────────────────

  /**
   * Los socios de un coach con lo que su inicio necesita: la rutina que
   * tienen, cuándo toca revisarla y su última entrada. «Sus socios» es la
   * misma regla que `MemberRepository.assignedTo` (su coach en la ficha o,
   * sin coach, quien le asignó la rutina vigente). Lee `members` y
   * `attendance_events` (de socios y acceso) solo para contar: no los escribe.
   */
  async coachMembers(coachUserId: string): Promise<Array<{
    id: string; firstName: string; lastName: string; memberCode: string; createdAt: Date;
    routine: string | null; reviewOn: Date | null; lastVisitOn: Date | null;
  }>> {
    return this.db.$queryRaw`
      SELECT m.id, m."firstName", m."lastName", m."memberCode", m."createdAt",
             wt.name AS routine, wa."reviewOn",
             (SELECT max(ae."businessDate") FROM attendance_events ae
               WHERE ae."organizationId" = m."organizationId" AND ae."memberId" = m.id) AS "lastVisitOn"
        FROM members m
        LEFT JOIN workout_assignments wa ON wa."organizationId" = m."organizationId" AND wa."memberId" = m.id AND wa."endedAt" IS NULL
        LEFT JOIN workout_templates wt ON wt.id = wa."workoutTemplateId"
       WHERE m."organizationId" = ${this.organizationId}::uuid AND m."deletedAt" IS NULL AND m."anonymizedAt" IS NULL
         AND (m."coachUserId" = ${coachUserId}::uuid
           OR (m."coachUserId" IS NULL AND wa."assignedByUserId" = ${coachUserId}::uuid))
       ORDER BY m."firstName", m."lastName"`;
  }

  /** ARCO (PS-08): las notas del coach son texto libre y a menudo hablan de salud. */
  async scrubNotesForMember(memberId: string): Promise<number> {
    const { count } = await this.db.workoutAssignment.updateMany({ where: this.scope({ memberId, notes: { not: null } }), data: { notes: null } });
    return count;
  }

  async endAssignment(memberId: string, userId: string | null = null): Promise<boolean> {
    const { count } = await this.db.workoutAssignment.updateMany({ where: this.scope({ memberId, endedAt: null }), data: { endedAt: new Date(), endedByUserId: userId } });
    return count > 0;
  }
}
