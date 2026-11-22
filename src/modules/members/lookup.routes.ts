import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forbidden, notFound, validation } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { MemberRepository } from './member.repository.js';
import { idParam, serializeMember, vista } from './members.serializers.js';

/** Búsqueda de recepción, padrón por cursor y ficha del socio. */
export function registerLookupRoutes(app: FastifyInstance): void {
  // ── Búsqueda de recepción ─────────────────────────────────────────────────
  route(app, {
    method: 'GET',
    url: '/members/search',
    security: { kind: 'permission', permission: 'members:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { q, limit } = z.object({
        q: z.string().min(2),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }).parse(request.query);

      const started = process.hrtime.bigint();
      const repo = new MemberRepository(ctx.tenant.organizationId);
      // El coach solo encuentra a sus socios asignados (2026-10-09).
      const suyos = ctx.coachOf ? new Set(await repo.assignedTo(ctx.coachOf)) : null;
      const results = (await repo.search(q, suyos ? 50 : limit)).filter((m) => !suyos || suyos.has(m.id)).slice(0, limit);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

      return {
        query: q,
        elapsedMs: Math.round(elapsedMs * 100) / 100,
        results: results.map((m) => serializeMember(m, vista(request, m.homeBranchId))),
      };
    },
  });

  route(app, {
    method: 'GET',
    url: '/members',
    security: { kind: 'permission', permission: 'members:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const query = z.object({
        status: z.enum(['PROSPECT', 'ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
        branchId: z.string().uuid().optional(),
        withDebt: z.enum(['true', 'false']).optional(),
        q: z.string().trim().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().max(400).optional(),
      }).parse(request.query);
      // La lista de deudores es dinero: solo quien ve estados de cuenta, y
      // solo de las sedes donde los ve (SEC2-06).
      const sedesDinero = query.withDebt === 'true' ? request.branchScope('billing:statement:read') : null;
      if (sedesDinero?.length === 0) throw forbidden('Ver deudores requiere permiso de estado de cuenta');
      if (query.branchId && sedesDinero && !sedesDinero.includes(query.branchId)) throw forbidden('No ves los saldos de esa sucursal');
      const repo = new MemberRepository(ctx.tenant.organizationId);
      const { members, total } = await repo.list({
        status: query.status, branchId: query.branchId, withDebt: query.withDebt === 'true',
        branchIds: sedesDinero ?? undefined,
        // El coach solo ve a sus socios asignados (2026-10-09).
        ids: ctx.coachOf ? await repo.assignedTo(ctx.coachOf) : undefined,
        q: query.q, limit: query.limit, after: query.cursor ? leerCursor(query.cursor) : undefined,
      });
      const ultimo = members.length === query.limit ? members.at(-1) : undefined;
      return {
        members: members.map((m) => serializeMember(m, vista(request, m.homeBranchId))),
        total,
        nextCursor: ultimo
          ? Buffer.from(JSON.stringify([ultimo.lastName, ultimo.firstName, ultimo.id])).toString('base64url')
          : null,
      };
    },
  });

  route(app, {
    method: 'GET',
    url: '/members/:id',
    security: { kind: 'permission', permission: 'members:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      // La ficha también de quien se dio de baja: su historia sigue ahí, y es
      // desde donde se atiende una solicitud ARCO. La API la marca ARCHIVED.
      const repo = new MemberRepository(ctx.tenant.organizationId);
      const member = await repo.findByIdIncludingArchived(id);
      if (!member) throw notFound('Socio no encontrado');
      return { ...serializeMember(member, vista(request, member.homeBranchId)), coachUserId: await repo.coachOf(id) };
    },
  });
}

/** El cursor del padrón: (apellido, nombre, id) del último socio visto. */
function leerCursor(raw: string): { lastName: string; firstName: string; id: string } {
  try {
    const [lastName, firstName, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown[];
    if (typeof lastName === 'string' && typeof firstName === 'string' && typeof id === 'string'
      && z.string().uuid().safeParse(id).success) {
      return { lastName, firstName, id };
    }
  } catch { /* cae al error de abajo */ }
  throw validation('Cursor de paginación inválido');
}
