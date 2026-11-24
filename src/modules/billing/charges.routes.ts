import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { ChargeRepository } from './charge.repository.js';
import { BillingService, codigosDeAjuste } from './billing.service.js';
import { idParam, cents, iso, serializeCharge, serializeAdjustment, serializeEstadoParaCobro, sedeDeMembresia } from './billing.serializers.js';
import { notFound, formatMoney, money, discountPercentOf } from '@gymflow/core';
import { MemberStatement, PAGINA_MAXIMA, PAGINA_POR_OMISION, StatementChargesPage, StatementPaymentsPage } from '@gymflow/core/contracts';
import { StatementService, cursorDe } from './statement.service.js';
import { perdonDisponible } from './perdon.js';

/** `?cursor=&limit=` de una lista por páginas. */
const paginaQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(PAGINA_MAXIMA).default(PAGINA_POR_OMISION),
});

/** Cargos: estado de cuenta, cargos, ajustes y anulaciones. */
export function registerChargesRoutes(app: FastifyInstance): void {
  const service = new BillingService();
  const estadoDeCuenta = new StatementService();
  // ── Estado de cuenta ──────────────────────────────────────────────────────
  route(app, {
    method: 'GET',
    url: '/members/:id/statement',
    security: { kind: 'permission', permission: 'billing:statement:read' },
    schema: respuesta(200, MemberStatement),
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const { limit } = paginaQuery.parse(request.query);
      const st = await estadoDeCuenta.statement(ctx, id, limit);
      // Contrato: `MemberStatement` (`@gymflow/core/contracts`).
      return {
        memberId: st.memberId,
        outstandingCents: cents(st.outstandingCents),
        creditCents: cents(st.creditCents),
        netBalanceCents: cents(st.netBalanceCents),
        netBalanceLabel: formatMoney(money(st.netBalanceCents)),
        /** Lo más reciente, más todo lo que deba aunque sea viejo; cada cargo con cómo quedó saldado y sus ajustes (3-06). */
        charges: st.charges,
        /** Lo más reciente; cada pago con quién lo cobró y qué cubrió (3-05). */
        payments: st.payments,
        /** Cuántos hay en total y cómo pedir los demás: ya no se corta en 50 sin avisar (3-04, 4-15). */
        pages: st.pages,
        /** Fecha de negocio de su sede, para decir «hoy le toca pagar» sin el reloj de la computadora. */
        today: iso(st.today),
        /** Si entra y cuánto le falta para entrar, con el saldo a favor descontado (4-09, 4-18). */
        // `findCurrentForMember` nunca da una cancelada o vencida; el tipo de `EstadoParaCobro` es más ancho que el contrato.
        cobro: serializeEstadoParaCobro(st.cobro) as MemberStatement['cobro'],
      } satisfies MemberStatement;
    },
  });
  /** La página siguiente de cargos del estado de cuenta («Cargar más»). Contrato: `StatementChargesPage`. */
  route(app, {
    method: 'GET',
    url: '/members/:id/statement/charges',
    security: { kind: 'permission', permission: 'billing:statement:read' },
    schema: respuesta(200, StatementChargesPage),
    handler: async (request): Promise<StatementChargesPage> => {
      const orgId = request.ctx!.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const q = paginaQuery.parse(request.query);
      await estadoDeCuenta.assertMember(orgId, id);
      return estadoDeCuenta.chargesPage(orgId, id, q.limit, cursorDe(q.cursor));
    },
  });
  /** La página siguiente de pagos del estado de cuenta. Contrato: `StatementPaymentsPage`. */
  route(app, {
    method: 'GET',
    url: '/members/:id/statement/payments',
    security: { kind: 'permission', permission: 'billing:statement:read' },
    schema: respuesta(200, StatementPaymentsPage),
    handler: async (request): Promise<StatementPaymentsPage> => {
      const orgId = request.ctx!.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const q = paginaQuery.parse(request.query);
      await estadoDeCuenta.assertMember(orgId, id);
      return estadoDeCuenta.paymentsPage(orgId, id, q.limit, cursorDe(q.cursor));
    },
  });
  // ── Cargos ────────────────────────────────────────────────────────────────
  // `GET /members/:id/charges` se retiró (2.13): cortaba en 100 sin avisar y
  // ninguna pantalla la usaba. La lista de cargos de un socio es
  // `GET /members/:id/statement/charges`, por páginas.
  route(app, {
    method: 'POST',
    url: '/members/:id/charges',
    security: { kind: 'permission', permission: 'billing:charge:manual' }, // fuera del catálogo, importe a mano: solo la gerencia (28-05)
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        /**
         * Lo que nace en su propio flujo (venta de membresía, paquete,
         * clase, punto de venta, inscripción) ya no se teclea a mano: así
         * un pase de visita no se cobra a $1 a espaldas del catálogo
         * (SEC2-14). El saldo inicial es de migración: permiso aparte.
         */
        chargeType: z.enum(['DAY_PASS', 'NO_SHOW_PENALTY', 'MANUAL_ADJUSTMENT', 'OPENING_BALANCE']),
        concept: z.string().min(3).max(200),
        subtotalCents: z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos'),
        taxCents: z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos').optional(),
        discountCents: z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos').optional(),
        membershipId: z.string().uuid().optional(),
        branchId: z.string().uuid().optional(),
        dueDate: z.string().date().optional(),
        reason: z.string().min(3).max(300),
        /** Llave del envío (fase 1.3): repetir la petición con la misma llave devuelve el mismo cargo. */
        requestKey: z.string().min(8).max(80).optional(),
      }).parse(request.body);

      // El mismo permiso que la ruta, ahora con su sede y su motivo (28-05).
      request.authorize('billing:charge:manual', {
        branchId: body.branchId ?? null,
        reason: body.reason,
      });
      if (body.chargeType === 'OPENING_BALANCE') {
        // El tope de ajuste de saldo se mide contra el importe: sin él, el rol con tope nunca podía.
        request.authorize('members:balance:adjust', { branchId: body.branchId ?? null, reason: body.reason, amountCents: BigInt(body.subtotalCents) });
      }
      // Un descuento en un cargo manual es un descuento: pasa por su permiso
      // y por el tope del rol, como cualquier otro.
      const descuento = body.discountCents ? BigInt(body.discountCents) : 0n;
      if (descuento > 0n) {
        const subtotal = BigInt(body.subtotalCents);
        request.authorize('billing:discount:apply', {
          branchId: body.branchId ?? null, reason: body.reason, amountCents: descuento,
          ...(subtotal > 0n ? { percent: discountPercentOf(money(descuento), money(subtotal)) } : {}),
        });
      }

      const charge = await service.createManualCharge(ctx, {
        memberId: id,
        chargeType: body.chargeType,
        concept: body.concept,
        subtotalCents: BigInt(body.subtotalCents),
        ...(body.taxCents ? { taxCents: BigInt(body.taxCents) } : {}),
        ...(body.discountCents ? { discountCents: BigInt(body.discountCents) } : {}),
        ...(body.membershipId ? { membershipId: body.membershipId } : {}),
        ...(body.branchId ? { branchId: body.branchId } : {}),
        ...(body.dueDate ? { dueDate: new Date(`${body.dueDate}T00:00:00.000Z`) } : {}),
        reason: body.reason,
        ...(body.requestKey ? { requestKey: body.requestKey } : {}),
      });
      return reply.status(201).send(serializeCharge(charge));
    },
  });
  /**
   * Genera (o devuelve) el cargo del periodo en curso de una membresía.
   * Idempotente: repetir la llamada NO crea un segundo cargo.
   */
  route(app, {
    method: 'POST',
    url: '/memberships/:id/period-charge',
    security: { kind: 'permission', permission: 'billing:charge:create' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      request.requirePermission('billing:charge:create', await sedeDeMembresia(ctx.tenant.organizationId, id));
      const { charge, created } = await service.createPeriodCharge(ctx, { membershipId: id });
      return reply.status(created ? 201 : 200).send({ ...serializeCharge(charge), created });
    },
  });
  route(app, {
    method: 'POST',
    url: '/charges/:id/adjustments',
    security: { kind: 'permission', permission: 'billing:discount:apply' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        // Un ajuste solo REBAJA la deuda y siempre es positivo (DM-12): un
        // "recargo" es un cargo nuevo, y un ajuste negativo deshacía una
        // condonación firmada por el dueño sin segunda firma.
        adjustmentType: z.enum(['DISCOUNT', 'WAIVER', 'CORRECTION']),
        amountCents: z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos').refine((v) => BigInt(v) > 0n, 'El ajuste debe ser mayor que cero'),
        // El código del motivo se valida abajo contra el catálogo de SU acción (descontar o condonar).
        reasonCode: z.string().min(1).max(40).optional(),
        reason: z.string().min(3).max(300),
        approvalToken: z.string().min(20).max(200).optional(),
      }).superRefine((b, problemas) => {
        if (b.reasonCode !== undefined && !codigosDeAjuste(b.adjustmentType).includes(b.reasonCode)) {
          problemas.addIssue({ code: 'custom', path: ['reasonCode'], message: 'Elige un motivo de la lista' });
        }
      }).parse(request.body);

      const charge = await new ChargeRepository(ctx.tenant.organizationId).findById(id);
      if (!charge) throw notFound('Cargo no encontrado');

      const amount = BigInt(body.amountCents);

      // Condonar NO es descontar: exige su propio permiso y aprobación.
      const permission = body.adjustmentType === 'WAIVER' ? 'billing:waiver:apply' : 'billing:discount:apply';

      /**
       * El límite de descuento del rol es PORCENTUAL, así que hay que
       * calcularlo contra el importe del cargo. Pasar solo los centavos
       * dejaba el límite sin evaluar y cualquier recepcionista podía
       * descontar el 100%.
       */
      const percent = body.adjustmentType === 'DISCOUNT' && amount > 0n
        ? discountPercentOf(money(amount), money(charge.amountCents))
        : undefined;

      // D-12: condonar pasa sin firma mientras quepa en lo que a ESE socio se le puede perdonar
      // (una mensualidad suya menos lo ya perdonado sin firma en 30 días); arriba firma la dueña.
      const tope = body.adjustmentType === 'WAIVER' ? await perdonDisponible(ctx.tenant.organizationId, charge.memberId) : null;

      const aprobador = await request.verifyApprover(body.approvalToken, permission, { branchId: charge.branchId, resourceType: 'Charge', resourceId: charge.id, amountCents: amount, ...(percent === undefined ? {} : { percent }) });
      request.authorize(permission, {
        branchId: charge.branchId,
        reason: body.reason,
        ...(aprobador ? { approvedByUserId: aprobador } : {}),
        amountCents: amount,
        ...(percent === undefined ? {} : { percent }),
        ...(tope ? { waiverAllowanceCents: tope.disponibleCents } : {}),
      });

      const updated = await service.adjustCharge(ctx, {
        chargeId: id,
        adjustmentType: body.adjustmentType,
        amountCents: amount,
        reason: body.reason,
        reasonCode: body.reasonCode ?? null,
        approvedByUserId: aprobador,
      });
      return reply.status(201).send(serializeCharge(updated));
    },
  });
  route(app, {
    method: 'GET',
    url: '/charges/:id/adjustments',
    security: { kind: 'permission', permission: 'billing:statement:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const repo = new ChargeRepository(ctx.tenant.organizationId);
      const charge = await repo.findById(id);
      if (!charge) throw notFound('Cargo no encontrado');
      return { adjustments: (await repo.listAdjustments(id)).map(serializeAdjustment) };
    },
  });
  route(app, {
    method: 'POST',
    url: '/charges/:id/void',
    security: { kind: 'permission', permission: 'billing:charge:void' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        reason: z.string().min(3).max(300),
        approvalToken: z.string().min(20).max(200).optional(),
      }).parse(request.body);

      const charge = await new ChargeRepository(ctx.tenant.organizationId).findById(id);
      if (!charge) throw notFound('Cargo no encontrado');

      const aprobador = await request.verifyApprover(body.approvalToken, 'billing:charge:void', { branchId: charge.branchId, resourceType: 'Charge', resourceId: charge.id });
      request.authorize('billing:charge:void', {
        branchId: charge.branchId,
        reason: body.reason,
        ...(aprobador ? { approvedByUserId: aprobador } : {}),
      });

      return serializeCharge(await service.voidCharge(ctx, {
        chargeId: id,
        reason: body.reason,
        approvedByUserId: aprobador,
      }));
    },
  });
}
