import type { FastifyInstance } from 'fastify';
import { forbidden, notFound } from '@gymflow/core';
import { MemberRepository } from './member.repository.js';

/**
 * EL COACH VE SOLO A SUS SOCIOS (2026-10-09).
 *
 * Toda ruta que cuelga de un socio (`/members/:id/...`: ficha, salud, rutina,
 * credenciales, membresías) responde "no encontrado" si el socio no es suyo,
 * igual que si no existiera. Las listas y la búsqueda ya filtran por su
 * cuenta. Lo de dinero y membresías sueltas no es suyo: se cierra entero.
 */
const DE_UN_SOCIO = /^\/members\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;
const CERRADO = [/^\/memberships(\/|$)/, /^\/visit-packs(\/|$)/, /^\/prospects(\/|$)/];

export function registerCoachScope(app: FastifyInstance): void {
  app.addHook('preHandler', async (request) => {
    const coach = request.ctx?.coachOf;
    if (!coach) return;
    const ruta = request.url.split('?')[0]!;
    if (CERRADO.some((r) => r.test(ruta))) throw forbidden('El coach ve solo rutinas, clases y a sus socios asignados');
    // El resumen de acceso (la insignia de la lista) solo de sus socios.
    const pedidos = ruta === '/members/access-summary'
      ? String((request.query as { ids?: string }).ids ?? '').split(',').filter(Boolean)
      : [DE_UN_SOCIO.exec(ruta)?.[1]].filter((x): x is string => !!x);
    if (pedidos.length === 0) return;
    const suyos = new Set(await new MemberRepository(request.ctx!.tenant.organizationId).assignedTo(coach));
    if (pedidos.some((id) => !suyos.has(id.toLowerCase()))) throw notFound('Socio no encontrado');
  });
}
