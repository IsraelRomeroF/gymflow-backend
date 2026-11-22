import type { FastifyRequest } from 'fastify';
import { validation, type PermissionKey } from '@gymflow/core';

/**
 * La sucursal de un reporte o listado con `branchId` opcional.
 *
 * El registro de rutas solo exige tener el permiso en ALGUNA sucursal; sin
 * esto, omitir `branchId` devolvía la organización entera a quien solo opera
 * una sede. Reglas:
 *  · con `branchId`, se autoriza contra esa sede;
 *  · sin él, alcance de toda la organización → `null` (todo);
 *  · sin él y una sola sede → esa;
 *  · sin él y varias → hay que elegir.
 */
export function sedeDeConsulta(
  request: FastifyRequest, permission: PermissionKey, branchId: string | null | undefined,
): string | null {
  if (branchId) {
    request.requirePermission(permission, branchId);
    return branchId;
  }
  const sedes = request.branchScope(permission);
  if (sedes === null) return null;
  if (sedes.length === 1) return sedes[0]!;
  throw validation('Indica la sucursal: tu acceso no cubre toda la organización');
}
