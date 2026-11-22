import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  grantsAccess, notFound, visitBalance, type MembershipStatus, type VisitLedgerEntry } from '@gymflow/core';
import { AccessSummaryResponse, MemberMemberships, type Membership } from '@gymflow/core/contracts';
import { enUnidadDeDinero } from '../../platform/db/unit-of-work.js';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { OrganizationRepository } from '../organization/index.js';
import { AccessSummaryRepository } from './access-summary.repository.js';
import { MemberRepository } from '../members/index.js';
import { MembershipRepository } from './membership.repository.js';
import { VisitPackRepository } from './visitpack.repository.js';
import { MembershipService } from './membership.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';

const idParam = z.object({ id: z.string().uuid() });
const reasonBody = z.object({ reason: z.string().min(3).max(300) });

export function registerMembershipRoutes(app: FastifyInstance): void {
  const service = new MembershipService();
  const audit = new AuditService();

  /**
   * Las rutas de esta sección mueven una membresía SIN cobrarla. El mostrador
   * no las usa —vende, renueva y cambia de plan por billing, que cobra—, y
   * sin esta barrera cualquiera con permiso de vender podía activar o renovar
   * gratis llamando a la API. Quedan para correcciones del dueño, con motivo.
   */
  const override = z.object({ reason: z.string().min(3).max(300) });

  /**
   * La membresía es de la sucursal donde se vendió: congelarla, cancelarla o
   * descongelarla es operar ESA sede. Antes bastaba con tener el permiso en
   * cualquier sucursal.
   */
  async function sedeDe(request: FastifyRequest, membershipId: string): Promise<string | null> {
    const m = await new MembershipRepository(request.ctx!.tenant.organizationId).findById(membershipId);
    if (!m) throw notFound('Membresía no encontrada');
    return m.soldAtBranchId;
  }
  /**
   * Una CORRECCIÓN SIN COBRO: se autoriza, se hace y se asienta, y las tres
   * cosas quedan o no queda ninguna (A5-N5, 28-10). Antes el asiento
   * `membership.override.*` se escribía ANTES de hacerla: si la corrección
   * fallaba (estado que no lo admite, plan inexistente), «Para revisar»
   * mostraba una corrección que nunca ocurrió.
   */
  async function autorizarCorreccion<T>(
    request: FastifyRequest, accion: string, membershipId: string | null, reason: string,
    hacer: () => Promise<T>, idDe: (r: T) => string,
  ): Promise<T> {
    request.authorize('memberships:override', { reason, branchId: membershipId ? await sedeDe(request, membershipId) : null });
    const ctx = request.ctx!;
    return enUnidadDeDinero(ctx.tenant.organizationId, async () => {
      const r = await hacer();
      // Al final de la unidad, con la membresía ya movida; en un alta, el id es el de la que nació.
      await audit.record(ctx, {
        action: `membership.override.${accion}`,
        resourceType: 'Membership',
        resourceId: membershipId ?? idDe(r),
        reason,
      });
      return r;
    });
  }

  // ── Membresías ────────────────────────────────────────────────────────────
  route(app, {
    method: 'POST',
    url: '/members/:id/memberships',
    security: { kind: 'permission', permission: 'memberships:override' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        planId: z.string().uuid(),
        soldAtBranchId: z.string().uuid().optional(),
        startDate: z.string().date().optional(),
        billingAnchorDay: z.number().int().min(1).max(31).optional(),
        autoRenew: z.boolean().optional(),
        branchIds: z.array(z.string().uuid()).optional(),
        reason: z.string().min(3).max(300),
      }).parse(request.body);

      request.authorize('memberships:create', { branchId: body.soldAtBranchId ?? null });
      const membership = await autorizarCorreccion(request, 'create', null, body.reason, () => service.create(ctx, {
        memberId: id,
        planId: body.planId,
        soldAtBranchId: body.soldAtBranchId ?? null,
        ...(body.startDate ? { startDate: new Date(`${body.startDate}T00:00:00.000Z`) } : {}),
        ...(body.billingAnchorDay !== undefined ? { billingAnchorDay: body.billingAnchorDay } : {}),
        ...(body.autoRenew !== undefined ? { autoRenew: body.autoRenew } : {}),
        ...(body.branchIds ? { branchIds: body.branchIds } : {}),
      }), (m) => m.id);
      return reply.status(201).send(serialize(membership));
    },
  });

  route(app, {
    method: 'GET',
    url: '/members/:id/memberships',
    security: { kind: 'permission', permission: 'members:read' },
    schema: respuesta(200, MemberMemberships),
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const member = await new MemberRepository(ctx.tenant.organizationId).findById(id);
      if (!member) throw notFound('Socio no encontrado');
      const repo = new MembershipRepository(ctx.tenant.organizationId);
      const list = await repo.listForMember(id);
      // «Pagado hasta» de verdad (3-01) y, de una suspendida, cuántos periodos
      // lleva sin venir: «Decidir adeudo» solo tiene sentido con atrasos (4-08).
      const pagado = await repo.paidThroughFor(list.map((m) => m.id));
      const atrasos = new Map(await Promise.all(list.filter((m) => m.status === 'SUSPENDED')
        .map(async (m) => [m.id, await service.cuantosPeriodosAtrasados(ctx, m)] as const)));
      // El historial muestra los periodos Y SUS HUECOS: es lo que permite
      // medir retención por cohortes sin reconstruir nada.
      // Contrato `MemberMemberships` del núcleo: si el serializador cambia un campo, esto deja de compilar.
      return list.map((m) => ({
        ...serialize(m),
        paidThrough: ((p) => (p ? iso(p) : null))(pagado.get(m.id) ?? null),
        missedPeriods: atrasos.get(m.id) ?? null,
      })) satisfies MemberMemberships;
    },
  });

  route(app, {
    method: 'GET',
    url: '/memberships/:id',
    security: { kind: 'permission', permission: 'members:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const repo = new MembershipRepository(ctx.tenant.organizationId);
      const m = await repo.findById(id);
      if (!m) throw notFound('Membresía no encontrada');
      const pagado = (await repo.paidThroughFor([m.id])).get(m.id) ?? null;
      const atrasos = m.status === 'SUSPENDED' ? await service.cuantosPeriodosAtrasados(ctx, m) : null;
      return { ...serialize(m, { paidThrough: pagado, missedPeriods: atrasos }), branchAccess: await repo.branchAccess(id) };
    },
  });

  route(app, {
    method: 'GET',
    url: '/memberships/:id/events',
    security: { kind: 'permission', permission: 'members:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const repo = new MembershipRepository(ctx.tenant.organizationId);
      if (!(await repo.findById(id))) throw notFound('Membresía no encontrada');
      return repo.events(id);
    },
  });

  route(app, {
    method: 'POST',
    url: '/memberships/:id/activate',
    security: { kind: 'permission', permission: 'memberships:override' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = override.parse(request.body ?? {});
      return serialize(await autorizarCorreccion(request, 'activate', id, reason, () => service.activate(request.ctx!, id), (m) => m.id));
    },
  });

  route(app, {
    method: 'POST',
    url: '/memberships/:id/freeze',
    security: { kind: 'permission', permission: 'memberships:freeze' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ days: z.number().int().min(1).max(365), reason: z.string().min(3).max(300) })
        .parse(request.body);
      request.authorize('memberships:freeze', { reason: body.reason, branchId: await sedeDe(request, id) });
      return serialize(await service.freeze(request.ctx!, id, body.days, body.reason));
    },
  });

  route(app, {
    method: 'POST',
    url: '/memberships/:id/unfreeze',
    security: { kind: 'permission', permission: 'memberships:freeze' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      request.requirePermission('memberships:freeze', await sedeDe(request, id));
      return serialize(await service.unfreeze(request.ctx!, id));
    },
  });

  route(app, {
    method: 'POST',
    url: '/memberships/:id/change-plan',
    security: { kind: 'permission', permission: 'memberships:override' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ planId: z.string().uuid(), reason: z.string().min(3).max(300) }).parse(request.body);
      const result = await autorizarCorreccion(request, 'change-plan', id, body.reason,
        () => service.changePlan(request.ctx!, id, body.planId, body.reason), (r) => r.membership.id);
      return { membership: serialize(result.membership), proration: result.proration };
    },
  });

  route(app, {
    method: 'POST',
    url: '/memberships/:id/renew',
    security: { kind: 'permission', permission: 'memberships:override' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = override.parse(request.body ?? {});
      return serialize(await autorizarCorreccion(request, 'renew', id, reason, () => service.renew(request.ctx!, id), (m) => m.id));
    },
  });

  route(app, {
    method: 'POST',
    url: '/memberships/:id/cancel',
    security: { kind: 'permission', permission: 'memberships:cancel' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = reasonBody.parse(request.body);
      request.authorize('memberships:cancel', { reason, branchId: await sedeDe(request, id) });
      return serialize(await service.cancel(request.ctx!, id, reason));
    },
  });

  route(app, {
    method: 'POST',
    url: '/memberships/:id/reactivate',
    security: { kind: 'permission', permission: 'memberships:override' },
    handler: async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { planId, reason } = z.object({ planId: z.string().uuid(), reason: z.string().min(3).max(300) }).parse(request.body);
      // Crea una membresía NUEVA: la antigüedad vive en el socio, no aquí.
      const nueva = await autorizarCorreccion(request, 'reactivate', id, reason, () => service.reactivate(request.ctx!, id, planId), (m) => m.id);
      return reply.status(201).send(serialize(nueva));
    },
  });

  // ── Paquetes de visitas ───────────────────────────────────────────────────
  // La VENTA vive en el módulo de facturación: crea el cargo que la financia.
  // Aquí quedan consulta, consumo y ajuste, que son de membresía.

  /**
   * Resumen de acceso de VARIOS socios: lo que pinta la insignia única de
   * búsqueda, padrón y ficha. `canEnter` es la misma regla que la puerta,
   * para que la lista nunca diga "activo" a quien la puerta va a rechazar.
   */
  route(app, {
    method: 'GET',
    url: '/members/access-summary',
    security: { kind: 'permission', permission: 'members:read' },
    schema: respuesta(200, AccessSummaryResponse),
    handler: async (request) => {
      const { ids } = z.object({
        ids: z.string().transform((v) => v.split(',').filter(Boolean)).pipe(z.array(z.string().uuid()).max(100)),
      }).parse(request.query);
      const hoy = new Date();
      const orgId = request.ctx!.tenant.organizationId;
      const [filas, politica, pagado] = await Promise.all([
        new AccessSummaryRepository(orgId).forMembers(ids),
        new OrganizationRepository(orgId).accessSettings(),
        // «Pagado hasta» de verdad (3-01): la vigencia del periodo no dice si se pagó.
        new MembershipRepository(orgId).paidThroughForMembers(ids),
      ]);
      // La misma regla que la puerta (UX4-01): si el gimnasio no deja pasar en
      // mora, la fila no puede decir "entra".
      const entraLaMembresia = (status: string) => grantsAccess(status as MembershipStatus) && (status !== 'PAST_DUE' || politica.allowAccessWhilePastDue);
      // El pase del día (1.8) vale el día de operación de SU sede: se pregunta una vez por sede.
      const calendario = new BusinessCalendar(orgId);
      const hoyEnSede = new Map<string, number>();
      for (const b of new Set(filas.flatMap((f) => f.dayPasses.map((p) => p.branchId)))) hoyEnSede.set(b, (await calendario.today(b, hoy)).getTime());
      return {
        allowAccessWhilePastDue: politica.allowAccessWhilePastDue,
        members: filas.map((f) => {
          const pack = f.pack && {
            status: f.pack.status, visitsLeft: f.pack.visitsLeft,
            expiresOn: f.pack.expiresOn ? f.pack.expiresOn.toISOString().slice(0, 10) : null,
          };
          const packSirve = !!f.pack && f.pack.status === 'ACTIVE' && f.pack.visitsLeft > 0
            && (!f.pack.expiresOn || f.pack.expiresOn.getTime() > hoy.getTime());
          const pase = f.dayPasses.find((p) => p.validOn.getTime() === hoyEnSede.get(p.branchId)) ?? null;
          return {
            memberId: f.memberId,
            membership: f.membership && {
              status: f.membership.status, planName: f.membership.planName,
              coveredThrough: new Date(f.membership.currentPeriodEnd.getTime() - 86_400_000).toISOString().slice(0, 10),
              paidThrough: ((p) => (p ? p.toISOString().slice(0, 10) : null))(pagado.get(f.memberId) ?? null),
              graceUntil: f.membership.graceUntil ? f.membership.graceUntil.toISOString().slice(0, 10) : null,
            },
            pack,
            dayPass: pase && { branchId: pase.branchId, validOn: pase.validOn.toISOString().slice(0, 10) },
            canEnter: (!!f.membership && entraLaMembresia(f.membership.status)) || packSirve || !!pase,
          };
        }),
      };
    },
  });

  route(app, {
    method: 'GET',
    url: '/members/:id/visit-packs',
    security: { kind: 'permission', permission: 'members:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const repo = new VisitPackRepository(ctx.tenant.organizationId);
      const packs = await repo.listForMember(id);
      return Promise.all(packs.map(async (p) => serializePack(p, await repo.balance(p.id))));
    },
  });

  route(app, {
    method: 'GET',
    url: '/visit-packs/:id',
    security: { kind: 'permission', permission: 'members:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const repo = new VisitPackRepository(ctx.tenant.organizationId);
      const pack = await repo.findById(id);
      if (!pack) throw notFound('Paquete no encontrado');
      const entries = await repo.entries(id);
      // Se devuelve el LIBRO completo: el socio puede reclamar "me faltan
      // visitas" y hay una respuesta con fecha, sucursal y origen.
      return { ...serializePack(pack, visitBalance(entries as readonly VisitLedgerEntry[])), entries };
    },
  });

  route(app, {
    method: 'POST',
    url: '/visit-packs/:id/consume',
    security: { kind: 'permission', permission: 'memberships:visitpack:manage' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        branchId: z.string().uuid().optional(),
        /** Clave de idempotencia. Desde el Sprint 7 la aporta el torniquete. */
        attendanceEventId: z.string().uuid().optional(),
      }).parse(request.body);

      const repo = new VisitPackRepository(ctx.tenant.organizationId);
      const pack = await repo.findById(id);
      if (!pack) throw notFound('Paquete no encontrado');
      // La visita se descuenta en la sede donde ocurre.
      request.requirePermission('memberships:visitpack:manage', body.branchId ?? pack.soldAtBranchId);

      const day = await new BusinessCalendar(ctx.tenant.organizationId).today(body.branchId ?? null);
      const { entry, balance } = await repo.consume({
        visitPackId: id, businessDate: day, branchId: body.branchId ?? null,
        attendanceEventId: body.attendanceEventId ?? null, createdByUserId: ctx.tenant.actorUserId ?? null,
      });
      return reply.status(201).send({ entry, balance });
    },
  });

  route(app, {
    method: 'POST',
    url: '/visit-packs/:id/adjust',
    security: { kind: 'permission', permission: 'memberships:visitpack:adjust' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        delta: z.number().int().refine((n) => n !== 0, 'El ajuste no puede ser cero'),
        reason: z.string().min(3).max(300),
        approvalToken: z.string().min(20).max(200).optional(),
      }).parse(request.body);

      const repo = new VisitPackRepository(ctx.tenant.organizationId);
      const pack = await repo.findById(id);
      if (!pack) throw notFound('Paquete no encontrado');

      // Ajustar visitas mueve dinero del socio: exige motivo y aprobación.
      const aprobador = await request.verifyApprover(body.approvalToken, 'memberships:visitpack:adjust', { branchId: pack.soldAtBranchId, resourceType: 'VisitPack', resourceId: pack.id });
      request.authorize('memberships:visitpack:adjust', {
        reason: body.reason,
        branchId: pack.soldAtBranchId,
        ...(aprobador ? { approvedByUserId: aprobador } : {}),
      });

      // El día de operación de la sede donde se vendió el paquete (2.13).
      const hoy = await new BusinessCalendar(ctx.tenant.organizationId).today(pack.soldAtBranchId);
      // El ajuste de visitas (dinero del socio) y su asiento, juntos (28-10).
      const { entry, balance } = await enUnidadDeDinero(ctx.tenant.organizationId, async () => {
      const entry = await repo.addEntry({
        visitPackId: id, entryType: 'ADJUST', delta: body.delta,
        reason: body.reason, createdByUserId: ctx.tenant.actorUserId ?? null,
        businessDate: hoy,
      });

      await audit.record(ctx, {
        action: 'visitpack.adjust',
        resourceType: 'VisitPack',
        resourceId: id,
        afterState: { delta: body.delta, balance: await repo.balance(id) },
        reason: body.reason,
        approvedByUserId: aprobador,
      });
      return { entry, balance: await repo.balance(id) };
      });
      return reply.status(201).send({ entry, balance });
    },
  });
}

function serialize(m: {
  id: string; memberId: string; planId: string; soldAtBranchId: string | null;
  status: string; startDate: Date; currentPeriodStart: Date; currentPeriodEnd: Date;
  billingAnchorDay: number; graceUntil: Date | null; autoRenew: boolean;
  frozenDaysUsedThisYear: number; frozenSince: Date | null; frozenUntil: Date | null;
  replacesMembershipId: string | null; cancellationReason: string | null;
}, extra?: { paidThrough: Date | null; missedPeriods: number | null }): Membership {
  return {
    id: m.id,
    memberId: m.memberId,
    planId: m.planId,
    soldAtBranchId: m.soldAtBranchId,
    status: m.status as MembershipStatus,
    startDate: iso(m.startDate),
    currentPeriodStart: iso(m.currentPeriodStart),
    /** Intervalo SEMIABIERTO: este día YA NO está cubierto. */
    currentPeriodEnd: iso(m.currentPeriodEnd),
    /** Último día del periodo en curso, PAGADO O NO: es la vigencia que mira la puerta. */
    coveredThrough: iso(new Date(m.currentPeriodEnd.getTime() - 86_400_000)),
    /**
     * Último día que cubren sus cuotas SALDADAS (3-01, 4-03). Es lo que se le
     * dice al socio sobre su dinero: «pagado hasta». Nulo si nada está pagado.
     */
    ...(extra ? { paidThrough: extra.paidThrough ? iso(extra.paidThrough) : null } : {}),
    /** De una suspendida: periodos que no recorrió. Sin atrasos no hay adeudo por decidir (4-08). */
    ...(extra ? { missedPeriods: extra.missedPeriods } : {}),
    billingAnchorDay: m.billingAnchorDay,
    graceUntil: m.graceUntil ? iso(m.graceUntil) : null,
    autoRenew: m.autoRenew,
    frozenDaysUsedThisYear: m.frozenDaysUsedThisYear,
    frozenSince: m.frozenSince ? iso(m.frozenSince) : null,
    frozenUntil: m.frozenUntil ? iso(m.frozenUntil) : null,
    replacesMembershipId: m.replacesMembershipId,
    cancellationReason: m.cancellationReason,
    /** El acceso se DERIVA del estado, nunca se almacena (docs/05 §12). */
    grantsAccess: grantsAccess(m.status as MembershipStatus),
  };
}

function serializePack(p: {
  id: string; memberId: string; planId: string | null; visitsPurchased: number;
  purchasedOn: Date; expiresOn: Date | null; status: string; expiredAt: Date | null;
}, balance: number) {
  return {
    id: p.id,
    memberId: p.memberId,
    planId: p.planId,
    visitsPurchased: p.visitsPurchased,
    balance,
    purchasedOn: iso(p.purchasedOn),
    expiresOn: p.expiresOn ? iso(p.expiresOn) : null,
    status: p.status,
    expiredAt: p.expiredAt ? p.expiredAt.toISOString() : null,
  };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
