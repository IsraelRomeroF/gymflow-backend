import type { FastifyRequest } from 'fastify';

/**
 * Lo que comparten el Tablero, Movimientos y el pulso: el permiso que los abre,
 * cuánto se sirven de memoria y a qué sedes se acota cada consulta.
 */
export const MS_DIA = 86_400_000;
/**
 * El tablero y el pulso se sirven de memoria durante medio minuto: son 20 y
 * 46 consultas por apertura, y la dueña, la gerencia y cada pestaña abierta
 * piden lo mismo. Un dato de 30 s le sirve igual (OPT3-04); `fresh=1` lo salta.
 */
export const VIGENCIA_TABLERO_MS = 30_000;
export const PERM = 'reports:financial:read' as const;
/** Sede pedida (comprobando que la cubra) o todas las del alcance; null = organización. */
export const sedeDeReporte = (request: FastifyRequest, branchId?: string) => {
  if (branchId) { request.requirePermission(PERM, branchId); return [branchId]; }
  return request.branchScope(PERM);
};
