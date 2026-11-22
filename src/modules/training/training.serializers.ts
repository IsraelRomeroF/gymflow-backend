import { z } from 'zod';
import { isoDate } from '@gymflow/core';
import type { Routine, RoutineProgress } from '@gymflow/core/contracts';
import { MUSCLE_GROUPS, type MuscleGroup, type RoutineRecord } from './training.repository.js';

/** Lo que comparten las rutas de entrenamiento: parámetros, el cuerpo de una rutina y cómo se pinta. */
export const idParam = z.object({ id: z.string().uuid() });
export const grupo = z.enum(MUSCLE_GROUPS as [MuscleGroup, ...MuscleGroup[]]);

export const rutinaBody = z.object({
  name: z.string().trim().min(2).max(80),
  goal: z.string().max(40).nullish().transform((v) => v ?? null),
  level: z.string().max(40).nullish().transform((v) => v ?? null),
  notes: z.string().max(1000).nullish().transform((v) => v?.trim() || null),
  days: z.array(z.object({
    name: z.string().trim().min(1).max(60),
    items: z.array(z.object({
      exerciseId: z.string().uuid(),
      sets: z.number().int().min(1).max(20),
      reps: z.string().trim().min(1).max(20),
      restSeconds: z.number().int().min(0).max(900).nullish().transform((v) => v ?? null),
      notes: z.string().max(200).nullish().transform((v) => v?.trim() || null),
    })).max(20),
  })).min(1, 'La rutina necesita al menos un día').max(7, 'Una rutina tiene como máximo 7 días'),
});

type Rutina = RoutineRecord;

/**
 * La rutina como la ve cualquiera: por días, cada uno con sus ejercicios en
 * orden. `personalForName`: el socio de una copia personal, solo donde quien
 * mira puede verlo.
 */
export function serializeRoutine(r: Rutina, personalForName: string | null = null): Routine {
  return {
    id: r.id, name: r.name, goal: r.goal, level: r.level, notes: r.notes,
    updatedAt: r.updatedAt.toISOString(), archived: r.archivedAt !== null,
    activeMembers: r._count.assignments,
    personalFor: r.personalForMemberId ? { memberId: r.personalForMemberId, name: personalForName } : null,
    days: r.dayNames.map((name, i) => ({
      name,
      items: r.items.filter((it) => it.dayIndex === i + 1).map((it) => ({
        exerciseId: it.exerciseId, sets: it.sets, reps: it.reps, restSeconds: it.restSeconds, notes: it.notes,
        exercise: { name: it.exercise.name, muscleGroup: it.exercise.muscleGroup, equipment: it.exercise.equipment, instructions: it.exercise.instructions },
      })),
    })),
  };
}

/**
 * EL AVANCE («Hoy toca», 12-02). `logs` viene con el más reciente primero.
 *  - Si hoy ya marcó un día, ese es el de hoy (y está hecho).
 *  - Si no, toca el siguiente al último que marcó; el 1 si nunca ha marcado
 *    o si el último era el final (o la rutina hoy tiene menos días).
 * La semana va de lunes a domingo.
 */
export function avance(logs: ReadonlyArray<{ dayIndex: number; doneOn: Date }>, dias: number, hoy: Date): RoutineProgress {
  const n = Math.max(1, dias);
  const hoyIso = isoDate(hoy);
  const lunes = new Date(hoy.getTime() - ((hoy.getUTCDay() + 6) % 7) * 86_400_000);
  const validos = logs.filter((l) => l.dayIndex <= n);
  const ultimo = validos[0] ?? null;
  const deHoy = validos.find((l) => isoDate(l.doneOn) === hoyIso) ?? null;
  const semana = [...new Set(validos.filter((l) => l.doneOn.getTime() >= lunes.getTime()).map((l) => l.dayIndex))].sort((a, b) => a - b);
  return {
    today: hoyIso,
    nextDay: deHoy ? deHoy.dayIndex : ultimo ? (ultimo.dayIndex >= n ? 1 : ultimo.dayIndex + 1) : 1,
    doneToday: deHoy ? deHoy.dayIndex : null,
    doneThisWeek: semana,
    lastDone: ultimo ? { day: ultimo.dayIndex, on: isoDate(ultimo.doneOn) } : null,
  };
}
