import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { formatMoney, money, DISCOUNT_REASONS, forbidden, validation } from '@gymflow/core';
import { PAGINA_MAXIMA, PAGINA_POR_OMISION, PortfolioDebtors } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { sedeDeConsulta } from '../../platform/http/branch-scope.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { PortfolioRepository } from './portfolio.repository.js';
import { cents, iso } from './billing.serializers.js';

/**
 * Quién debe con nombre (D-25, bloque 4.15): además de la cartera, ver los
 * estados de cuenta en esa sede. La dueña ve la cartera sin nombres; recepción
 * no ve la cartera. Queda la gerencia (con la llave del Tablero).
 */
function exigirNombres(request: FastifyRequest, sede: string | null): void {
  if (!request.holds('billing:statement:read', sede)) {
    throw forbidden('Quién debe, con nombre, lo ve la gerencia: la cartera de tu puesto va sin nombres.');
  }
}

/** El cursor de `GET /portfolio/debtors`: lo que debía en total el último renglón y su id. */
function leerCursorDeDeudores(texto: string): { owedCents: bigint; memberId: string } {
  try {
    const partes: unknown = JSON.parse(Buffer.from(texto, 'base64url').toString('utf8'));
    const [owed, id] = z.tuple([z.string().regex(/^-?\d{1,18}$/), z.string().uuid()]).parse(partes);
    return { owedCents: BigInt(owed), memberId: id };
  } catch {
    throw validation('Esa página ya no existe. Vuelve a abrir la lista.');
  }
}

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

      // Los nombres de quien debe no son para la dueña (D-25, bloque 4.15).
      if (q.topDebtors) exigirNombres(request, sede);

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
          // Dado de baja en su ficha: sigue debiendo y sigue en la cartera (D-12; bloque 4.11).
          archived: d.archived,
          outstandingCents: cents(d.outstandingCents),
          oldestDueDate: iso(d.oldestDueDate),
        })),
      };
    },
  });

  // ── Quién debe (bloque 4.15) ────────────────────────────────────────────────
  // La lista que abre «Ver quién debe» del Tablero: por socio, con los dados de
  // baja (D-12) y lo dado por perdido (D-18); las fichas anonimizadas solo en
  // cifra. Suma exactamente lo que dice «Por cobrar» con la misma sede.
  route(app, {
    method: 'GET',
    url: '/portfolio/debtors',
    security: { kind: 'permission', permission: 'billing:portfolio:read' },
    schema: respuesta(200, PortfolioDebtors),
    handler: async (request): Promise<PortfolioDebtors> => {
      const ctx = request.ctx!;
      const q = z.object({
        branchId: z.string().uuid().optional(),
        includeArchived: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(PAGINA_MAXIMA).optional(),
        cursor: z.string().max(400).optional(),
      }).parse(request.query);
      const despuesDe = q.cursor ? leerCursorDeDeudores(q.cursor) : undefined;
      const orgId = ctx.tenant.organizationId;
      const sede = sedeDeConsulta(request, 'billing:portfolio:read', q.branchId);
      exigirNombres(request, sede);
      const hoy = await new BusinessCalendar(orgId).today(sede);
      const incluirBajas = q.includeArchived !== 'false';
      const limite = q.limit ?? PAGINA_POR_OMISION;

      const { resumen, filas } = await new PortfolioRepository(orgId).debtors({
        today: hoy, branchId: sede, incluirBajas, limit: limite + 1, ...(despuesDe ? { despuesDe } : {}),
      });
      const items = filas.slice(0, limite);
      const ultimo = filas.length > limite ? items.at(-1) : undefined;
      const cifra = (c: typeof resumen.all) => ({ outstandingCents: cents(c.outstandingCents), lostCents: cents(c.lostCents), members: c.members });
      return {
        asOf: iso(hoy),
        scope: sede ?? 'ORGANIZACION',
        includeArchived: incluirBajas,
        summary: { all: cifra(resumen.all), archived: cifra(resumen.archived), anonymized: cifra(resumen.anonymized), listed: cifra(resumen.listed) },
        items: items.map((d) => ({
          memberId: d.memberId,
          memberCode: d.memberCode,
          fullName: d.fullName,
          homeBranchId: d.homeBranchId,
          archived: d.archived,
          outstandingCents: cents(d.outstandingCents),
          overdueCents: cents(d.overdueCents),
          lostCents: cents(d.lostCents),
          oldestDueDate: iso(d.oldestDueDate),
        })),
        total: resumen.listed.members,
        nextCursor: ultimo ? Buffer.from(JSON.stringify([ultimo.owedCents.toString(), ultimo.memberId])).toString('base64url') : null,
        hasMore: ultimo !== undefined,
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
