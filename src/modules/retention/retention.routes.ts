import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { validation, type PermissionKey } from '@gymflow/core';
import { RetentionAlerts, RetentionSummary } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { sedeDeConsulta } from '../../platform/http/branch-scope.js';
import { recordar } from '../../platform/cache.js';
import { RetentionService } from './retention.service.js';

/** Ver la LISTA (con nombres y teléfonos): gerencia y, con la llave, recepción en su sede. */
const VER_LISTA = 'reports:branch:read' as const;
/**
 * Ver las CIFRAS (sin nombres): además de quien ve la lista, quien ve el
 * dinero del gimnasio, es decir, la dueña (D15-01, ADR-039: cifras sí,
 * nombres no).
 */
const VER_CIFRAS = ['reports:financial:read', VER_LISTA] as const satisfies readonly PermissionKey[];

/** Las cifras se sirven de memoria medio minuto, como el Tablero: clasifican el padrón entero (`fresh=1` lo salta). */
const VIGENCIA_CIFRAS_MS = 30_000;

/**
 * La sede de las cifras: la pedida, si alguno de los dos permisos la cubre;
 * sin pedir ninguna, todo el gimnasio para quien tiene alcance completo, o su
 * única sede. Con varias sedes sueltas hay que elegir (misma regla que
 * `sedeDeConsulta`, con dos permisos que abren la misma puerta).
 */
function sedeDeCifras(request: FastifyRequest, branchId: string | undefined): string | null {
  if (branchId) {
    const con = VER_CIFRAS.find((p) => request.holds(p, branchId)) ?? VER_LISTA;
    request.requirePermission(con, branchId);
    return branchId;
  }
  const sedes = new Set<string>();
  for (const p of VER_CIFRAS) {
    const suyas = request.branchScope(p);
    if (suyas === null) return null;
    for (const s of suyas) sedes.add(s);
  }
  if (sedes.size === 1) return [...sedes][0]!;
  throw validation('Indica la sucursal: tu acceso no cubre toda la organización');
}

export function registerRetentionRoutes(app: FastifyInstance): void {
  const retention = new RetentionService();

  /**
   * Alertas de retención (F-22).
   *
   * El socio deja de venir SEMANAS antes de dejar de pagar, y esa ventana es
   * hoy invisible. La lista viene ordenada por dónde está el retorno, no por
   * fecha: recepción no puede llamar a doscientas personas.
   *
   * Contrato: `RetentionAlerts` (`@gymflow/core/contracts`).
   */
  route(app, {
    method: 'GET',
    url: '/retention/alerts',
    module: 'retention',
    security: { kind: 'permission', permission: VER_LISTA },
    schema: respuesta(200, RetentionAlerts),
    handler: async (request): Promise<RetentionAlerts> => {
      const ctx = request.ctx!;
      const q = z.object({
        branchId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }).parse(request.query);

      const r = await retention.report(ctx, {
        branchId: sedeDeConsulta(request, VER_LISTA, q.branchId),
        ...(q.limit ? { limit: q.limit } : {}),
      });

      return {
        asOf: r.asOf,
        counts: r.counts,
        // Cuántos hay que llamar ANTES del recorte: antes era `outreach.length`
        // y la pantalla no podía saber que faltaban.
        total: r.total,
        outreach: r.outreach.map((m) => ({
          memberId: m.memberId,
          memberCode: m.memberCode,
          fullName: m.fullName,
          homeBranchId: m.homeBranchId,
          phoneE164: m.phoneE164,
          state: m.verdict.state,
          daysSinceLastVisit: m.verdict.daysSinceLastVisit,
          /** Cuántas visitas SUYAS se ha saltado. La cifra que importa. */
          missedVisits: m.verdict.missedVisits,
          expectedGapDays: Math.round(m.verdict.expectedGapDays * 10) / 10,
          tenureDays: m.verdict.daysSinceJoined,
          detail: m.verdict.detail,
        })),
      };
    },
  });

  /**
   * Las cifras de retención SIN NOMBRES (15-01, 13-11): cuántos no arrancaron,
   * aflojan o dejaron de venir. Es lo que la dueña pregunta desde el teléfono
   * («¿cuántos se me están yendo?») y lo que el Inicio y el Tablero necesitan
   * sin pedir la lista entera. La dueña NO abre `/retention/alerts`: esa trae
   * nombres y teléfonos, que son de la operación (ADR-039).
   *
   * Contrato: `RetentionSummary` (`@gymflow/core/contracts`).
   */
  route(app, {
    method: 'GET',
    url: '/retention/summary',
    module: 'retention',
    security: { kind: 'permission', permission: VER_CIFRAS[0], anyOf: [VER_CIFRAS[1]] },
    schema: respuesta(200, RetentionSummary),
    handler: async (request): Promise<RetentionSummary> => {
      const ctx = request.ctx!;
      const q = z.object({
        branchId: z.string().uuid().optional(),
        fresh: z.string().optional(),
      }).parse(request.query);
      const sede = sedeDeCifras(request, q.branchId);
      const calcular = () => retention.figures(ctx, { branchId: sede });
      const r = q.fresh
        ? await calcular()
        : await recordar(`retention:${ctx.tenant.organizationId}:${sede ?? '*'}`, VIGENCIA_CIFRAS_MS, calcular);
      return { asOf: r.asOf, branchId: sede, counts: r.counts, atRisk: r.atRisk };
    },
  });
}
