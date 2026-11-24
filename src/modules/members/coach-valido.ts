import { validation } from '@gymflow/core';

/**
 * ¿Esa persona puede ser el coach de un socio? Tiene que ser coach ACTIVO del
 * gimnasio. La usan el alta (D-29: recepción lo elige ahí), la gerencia al
 * cambiarlo y «Hacerme su coach».
 *
 * `identity` se importa al vuelo: `identity` ya depende de `members`.
 */
export async function esCoachActivo(orgId: string, userId: string): Promise<boolean> {
  const { StaffRepository } = await import('../identity/index.js');
  const persona = await new StaffRepository(orgId).find(userId);
  return !!persona && persona.isActive && persona.assignments.some((a) => a.roleKey === 'COACH');
}

export async function exigirCoachActivo(orgId: string, userId: string): Promise<void> {
  if (!await esCoachActivo(orgId, userId)) throw validation('Esa persona no es coach activo del gimnasio');
}
