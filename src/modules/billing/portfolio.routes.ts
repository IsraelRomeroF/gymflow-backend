import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatMoney, money, DISCOUNT_REASONS } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { sedeDeConsulta } from '../../platform/http/branch-scope.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { PortfolioRepository } from './portfolio.repository.js';
import { cents, iso } from './billing.serializers.js';

/**
 * Cartera y motivos de descuento. Son datos de COBRANZA, no de caja (28-07):
 * vivían en `cash/cash.routes.ts` y, si un gimnasio apagaba Caja (ADR-036),
 * `GET /portfolio` respondía «módulo apagado». Las URL y las respuestas no
 * cambian; con el traslado se deshace el círculo `billing ↔ cash`.
 */
export function registerPortfolioRoutes(app: FastifyInstance): void {
  // ── Cartera consolidada ───────────────────────────────────────────────────
  route(app, {
    method: 'GET',
    url: '/portfolio',
    security: { kind: 'permission', permission: 'billing:portfolio:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const q = z.object({
        branchId: z.string().uuid().optional(),
        topDebtors: z.coerce.number().int().min(0).max(100).optional(),
      }).parse(request.query);

      const orgId = ctx.tenant.organizationId;
      const sede = sedeDeConsulta(request, 'billing:portfolio:read', q.branchId);
      const hoy = await new BusinessCalendar(orgId).today(sede);

      const repo = new PortfolioRepository(orgId);
      const snapshot = await repo.snapshot(hoy, sede);
      const deudores = q.topDebtors
        ? await repo.topDebtors(q.topDebtors, sede)
        : [];

      return {
        asOf: iso(hoy),
        scope: sede ?? 'ORGANIZACION',
        totalOutstandingCents: cents(snapshot.totalOutstandingCents),
        totalOutstandingLabel: formatMoney(money(snapshot.totalOutstandingCents)),
        overdueCents: cents(snapshot.overdueCents),
        membersWithDebt: snapshot.membersWithDebt,
        // D-18 (4.4): dada por perdida; no está en ninguna de las cifras de arriba.
        lostCents: cents(snapshot.lostCents),
        lostMembers: snapshot.lostMembers,
        creditBalanceCents: cents(snapshot.creditBalanceCents),
        byAging: snapshot.byAging.map((r) => ({
          bucket: r.bucket,
          amountCents: cents(r.amountCents),
          charges: r.charges,
          members: r.members,
        })),
        byBranch: snapshot.byBranch.map((r) => ({
          branchId: r.branchId,
          amountCents: cents(r.amountCents),
          members: r.members,
        })),
        topDebtors: deudores.map((d) => ({
          memberId: d.memberId,
          memberCode: d.memberCode,
          fullName: d.fullName,
          branchId: d.branchId,
          outstandingCents: cents(d.outstandingCents),
          oldestDueDate: iso(d.oldestDueDate),
        })),
      };
    },
  });

  /** Catálogo de motivos de descuento. La pantalla lo consume como lista. */
  route(app, {
    method: 'GET',
    url: '/discount-reasons',
    security: { kind: 'permission', permission: 'billing:discount:apply' },
    handler: async () => ({ reasons: DISCOUNT_REASONS }),
  });
}
