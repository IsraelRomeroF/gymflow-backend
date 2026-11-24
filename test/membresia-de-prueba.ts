import type { FastifyInstance } from 'fastify';
import { DomainError } from '@gymflow/core';
import type { RequestContext } from '../src/platform/context.js';
import { systemContext } from '../src/platform/jobs/types.js';
import { MembershipService } from '../src/modules/memberships/index.js';
import { serializeMembership } from '../src/modules/memberships/membership.routes.js';

/**
 * MEMBRESÍAS DE PRUEBA SIN COBRO (fase 3, bloque 3.5 · D-12).
 *
 * La API ya no tiene camino sin cobro: `POST /members/:id/memberships` y
 * `/memberships/:id/activate|renew|change-plan|reactivate` se quitaron (una
 * cortesía es ahora una venta más un descuento o una condonación con monto).
 * Muchas pruebas los usaban solo para PREPARAR una membresía activa sin pasar
 * por la caja. Estos ayudantes hacen lo mismo llamando al servicio del
 * dominio, que sigue existiendo (lo usan la venta, el cobro y la importación),
 * y responden con la forma de una respuesta de `app.inject` para que la
 * prueba que los usa no cambie más que la llamada.
 */
export type Respuesta = { statusCode: number; body: string; json: () => any };

async function contextoDe(app: FastifyInstance, cookie: string): Promise<RequestContext> {
  const yo = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
  if (yo.statusCode !== 200) throw new Error(`membresía de prueba: la sesión no sirve (${yo.statusCode})`);
  const { organizationId, userId } = yo.json() as { organizationId: string; userId: string };
  const base = systemContext(organizationId);
  return { ...base, tenant: { ...base.tenant, actorType: 'USER', actorUserId: userId } };
}

async function responder(codigo: number, hacer: () => Promise<unknown>): Promise<Respuesta> {
  try {
    const cuerpo = await hacer();
    return { statusCode: codigo, body: JSON.stringify(cuerpo), json: () => JSON.parse(JSON.stringify(cuerpo)) };
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    const cuerpo = { code: e.code, message: e.message, detail: e.detail, reason: e.reason };
    return { statusCode: e.httpStatus, body: JSON.stringify(cuerpo), json: () => cuerpo };
  }
}

const dia = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** Lo que hacía `POST /members/:id/memberships`: una membresía «por activar», sin cargo ni cobro. */
export async function altaSinCobro(app: FastifyInstance, cookie: string, memberId: string, payload: {
  planId: string; soldAtBranchId?: string; startDate?: string; billingAnchorDay?: number; autoRenew?: boolean; branchIds?: string[]; reason?: string;
}): Promise<Respuesta> {
  const ctx = await contextoDe(app, cookie);
  return responder(201, async () => serializeMembership(await new MembershipService().create(ctx, {
    memberId, planId: payload.planId, soldAtBranchId: payload.soldAtBranchId ?? null,
    ...(payload.startDate ? { startDate: dia(payload.startDate) } : {}),
    ...(payload.billingAnchorDay !== undefined ? { billingAnchorDay: payload.billingAnchorDay } : {}),
    ...(payload.autoRenew !== undefined ? { autoRenew: payload.autoRenew } : {}),
    ...(payload.branchIds ? { branchIds: payload.branchIds } : {}),
  })));
}

/** Lo que hacía `POST /memberships/:id/activate`. */
export async function activarSinCobro(app: FastifyInstance, cookie: string, membershipId: string): Promise<Respuesta> {
  const ctx = await contextoDe(app, cookie);
  return responder(200, async () => serializeMembership(await new MembershipService().activate(ctx, membershipId)));
}

/** Lo que hacía `POST /memberships/:id/renew`. */
export async function renovarSinCobro(app: FastifyInstance, cookie: string, membershipId: string): Promise<Respuesta> {
  const ctx = await contextoDe(app, cookie);
  return responder(200, async () => serializeMembership(await new MembershipService().renew(ctx, membershipId)));
}

/** Lo que hacía `POST /memberships/:id/change-plan`. */
export async function cambiarPlanSinCobro(app: FastifyInstance, cookie: string, membershipId: string, planId: string, reason = 'Preparación de la prueba'): Promise<Respuesta> {
  const ctx = await contextoDe(app, cookie);
  return responder(200, async () => {
    const r = await new MembershipService().changePlan(ctx, membershipId, planId, reason);
    return { membership: serializeMembership(r.membership), proration: r.proration };
  });
}

/** Lo que hacía `POST /memberships/:id/reactivate`. */
export async function reactivarSinCobro(app: FastifyInstance, cookie: string, membershipId: string, planId: string): Promise<Respuesta> {
  const ctx = await contextoDe(app, cookie);
  return responder(201, async () => serializeMembership(await new MembershipService().reactivate(ctx, membershipId, planId)));
}
