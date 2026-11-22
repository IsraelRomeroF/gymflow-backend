import { ROLE_BY_KEY, validation, type RoleDef } from '@gymflow/core';

/**
 * Las reglas de un puesto al dar o cambiar una cuenta, iguales en el panel y
 * en la plataforma (ADR-039): existe, se puede dar a un gimnasio y el alcance
 * es el que el puesto admite. El dueño abarca todo; recepción trabaja en una
 * o varias sucursales; gerente y coach, en cualquiera de las dos.
 */
export function validarPuesto(roleKey: string, branchIds: readonly string[] | null): RoleDef {
  const def = ROLE_BY_KEY.get(roleKey);
  if (!def || !def.assignable) throw validation('Ese puesto no se puede dar a un gimnasio');
  const acotado = branchIds !== null && branchIds.length > 0;
  if (def.scope === 'org' && acotado) throw validation(`${def.name} abarca todo el gimnasio: no se acota a sucursales`);
  if (def.scope === 'branch' && !acotado) throw validation(`${def.name} trabaja en una o varias sucursales: elige cuáles`);
  return def;
}
