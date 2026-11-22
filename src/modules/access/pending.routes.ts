import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessPending } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { BranchRepository } from '../organization/index.js';
import { MemberRepository } from '../members/index.js';

/**
 * POR RESOLVER EN LA PUERTA (auditoría 8, bloque 2.1; 5-05, 5-12).
 *
 * La estación y el mostrador dejan rechazos; hasta hoy solo se veían en el
 * monitor, que nace apagado. Aquí está la lista que recepción necesita en su
 * inicio: los rechazos de HOY que siguen sin resolver.
 *
 * Qué es «pendiente» (una sola definición, la usan esta ruta y el Inicio):
 *  - el ÚLTIMO rechazo de cada socio en cada sede, en el día de negocio de esa
 *    sede (los intentos repetidos no hacen tres renglones: hacen uno con «3
 *    intentos»);
 *  - que no sea un doble paso (ese socio ya entró);
 *  - sin una entrada concedida DESPUÉS en esa sede (si ya pasó —por cobro,
 *    renovación, paso concedido o porque volvió y la puerta dijo que sí— ya no
 *    hay nada que resolver), y sin decisión que lo resuelva.
 *
 * Solo lee. No cambia qué decide la puerta.
 */
export type PendienteDeLaPuerta = {
  decisionId: string; branchId: string; memberId: string; reason: string | null; at: Date; attempts: number;
};

export class PuertaPendienteRepository extends TenantRepository {
  /** `dias`: el día de negocio de cada sede, en el mismo orden que `sedes`. */
  async pendientes(sedes: readonly string[], dias: readonly Date[]): Promise<PendienteDeLaPuerta[]> {
    if (sedes.length === 0) return [];
    const fechas = dias.map((d) => d.toISOString().slice(0, 10));
    return this.db.$queryRaw<PendienteDeLaPuerta[]>`
      WITH hoy AS (
        SELECT * FROM unnest(${sedes as string[]}::uuid[], ${fechas}::date[]) AS t("branchId", "dia")
      ), rechazos AS (
        SELECT d."id", d."branchId", d."memberId", d."denialReason", d."at",
               ROW_NUMBER() OVER (PARTITION BY d."branchId", d."memberId" ORDER BY d."at" DESC) AS "orden",
               COUNT(*) OVER (PARTITION BY d."branchId", d."memberId")::int AS "attempts"
          FROM "access_decisions" d JOIN hoy h ON h."branchId" = d."branchId" AND h."dia" = d."businessDate"
         WHERE d."organizationId" = ${this.organizationId}::uuid AND d."outcome" = 'DENIED'
           AND d."memberId" IS NOT NULL AND COALESCE(d."denialReason", '') <> 'DUPLICATE_SCAN'
      )
      SELECT r."id" AS "decisionId", r."branchId", r."memberId", r."denialReason" AS "reason", r."at", r."attempts"
        FROM rechazos r
       WHERE r."orden" = 1
         AND NOT EXISTS (
           SELECT 1 FROM "access_decisions" g
            WHERE g."organizationId" = ${this.organizationId}::uuid AND g."memberId" = r."memberId" AND g."branchId" = r."branchId"
              AND g."outcome" = 'GRANTED' AND g."at" > r."at")
         AND NOT EXISTS (
           SELECT 1 FROM "access_decisions" x
            WHERE x."organizationId" = ${this.organizationId}::uuid AND x."resolvesDecisionId" = r."id")
       ORDER BY r."at" DESC`;
  }
}

/**
 * Los pendientes de la puerta de quien pregunta: en las sedes donde tiene
 * `access:monitor` (o en una sola, si la pide). Lo usan `GET /access/pending`
 * y la bandeja del Inicio (`analytics`), para que digan lo mismo.
 */
export async function pendientesDeLaPuerta(request: FastifyRequest, branchId?: string): Promise<PendienteDeLaPuerta[]> {
  const orgId = request.ctx!.tenant.organizationId;
  if (branchId) request.requirePermission('access:monitor', branchId);
  const alcance = request.branchScope('access:monitor');
  const sedes = (await new BranchRepository(orgId).list())
    .filter((b) => b.isActive && (branchId ? b.id === branchId : alcance === null || alcance.includes(b.id)))
    .map((b) => b.id);
  const calendario = new BusinessCalendar(orgId);
  const dias = await Promise.all(sedes.map((s) => calendario.today(s)));
  return new PuertaPendienteRepository(orgId).pendientes(sedes, dias);
}

export function registerPendingRoutes(app: FastifyInstance): void {
  route(app, {
    method: 'GET',
    url: '/access/pending',
    security: { kind: 'permission', permission: 'access:monitor' },
    schema: respuesta(200, AccessPending),
    handler: async (request): Promise<AccessPending> => {
      const q = z.object({
        branchId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }).parse(request.query);
      // La sede se comprueba aquí y dentro de `pendientesDeLaPuerta` (que además acota a las sedes de quien pregunta).
      if (q.branchId) request.requirePermission('access:monitor', q.branchId);
      const todos = await pendientesDeLaPuerta(request, q.branchId);
      const visibles = todos.slice(0, q.limit);
      const nombres = await new MemberRepository(request.ctx!.tenant.organizationId).namesByIds(visibles.map((p) => p.memberId));
      return {
        asOf: new Date().toISOString(),
        total: todos.length,
        pending: visibles.map((p) => ({
          decisionId: p.decisionId, branchId: p.branchId, memberId: p.memberId,
          memberName: nombres.get(p.memberId)?.fullName ?? 'Socio', memberCode: nombres.get(p.memberId)?.memberCode ?? '',
          reason: p.reason, at: p.at.toISOString(), attempts: p.attempts,
        })),
      };
    },
  });
}
