import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isoDate } from '@gymflow/core';
import { SignatureBrief, StoreSummary } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { ConsultaRepository } from './consulta.repository.js';
import { MS_DIA, PERM, sedeDeReporte } from './report-scope.js';

const texto = (v: bigint): string => BigInt(v).toString();

/**
 * LO QUE LA DUEÑA CONSULTA SIN OPERAR (fase 3, bloque 3.7 · D-25).
 *
 * - `GET /reports/store`: ventas y existencias de la tienda, en cifras. La ve
 *   quien ve el dinero del gimnasio (`reports:financial:read`), sin necesidad
 *   de los permisos del punto de venta.
 * - `GET /reports/signature-brief?resourceType=&resourceId=`: al firmar, un
 *   resumen de a quién toca la operación —desde cuándo es socio, cuánto debe,
 *   cuántas correcciones lleva— sin abrir su expediente ni decir su nombre (el
 *   nombre ya lo trae la solicitud de firma). Lo ve quien firma (`approvals:grant`).
 *
 * La deuda por sucursal va en `GET /reports/pulse` (`owed.byBranch`); los
 * textos legales, las solicitudes de privacidad en cifras y el plazo de
 * conservación ya tenían ruta (`/consent-documents`, `/privacy/requests/summary`,
 * `/organization/profile`).
 */
export function registerConsultaRoutes(app: FastifyInstance): void {
  route(app, {
    method: 'GET',
    url: '/reports/store',
    module: 'pos',
    security: { kind: 'permission', permission: PERM },
    schema: respuesta(200, StoreSummary),
    handler: async (request): Promise<StoreSummary> => {
      const q = z.object({ branchId: z.string().uuid().optional() }).parse(request.query);
      const orgId = request.ctx!.tenant.organizationId;
      const sedes = sedeDeReporte(request, q.branchId);
      const hoy = await new BusinessCalendar(orgId).today(q.branchId ?? null);
      const manana = new Date(hoy.getTime() + MS_DIA);
      const inicioMes = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1));
      const repo = new ConsultaRepository(orgId);
      const [delDia, delMes, top, stock, productos] = await Promise.all([
        repo.ventas(hoy, manana, sedes), repo.ventas(inicioMes, manana, sedes), repo.masVendido(inicioMes, manana, sedes),
        repo.existencias(sedes), repo.productos(sedes),
      ]);
      return {
        asOf: new Date().toISOString(),
        today: { sales: delDia.sales, totalCents: texto(delDia.totalCents) },
        month: { from: isoDate(inicioMes), to: isoDate(hoy), sales: delMes.sales, totalCents: texto(delMes.totalCents), voided: delMes.voided },
        top: top.map((t) => ({ productId: t.productId, name: t.name, quantity: t.quantity, totalCents: texto(t.totalCents) })),
        stock: stock.map((s) => ({ productId: s.productId, branchId: s.branchId, name: s.name, stock: s.stock })),
        products: productos,
      };
    },
  });

  route(app, {
    method: 'GET',
    url: '/reports/signature-brief',
    security: { kind: 'permission', permission: 'approvals:grant' },
    schema: respuesta(200, SignatureBrief),
    handler: async (request): Promise<SignatureBrief> => {
      const q = z.object({ resourceType: z.string().min(1).max(40), resourceId: z.string().uuid() }).parse(request.query);
      const orgId = request.ctx!.tenant.organizationId;
      const repo = new ConsultaRepository(orgId);
      const socio = await repo.socioDeLaOperacion(q.resourceType, q.resourceId);
      // Un retiro de caja o el cierre de mes no tocan a un socio; un registro ajeno tampoco dice nada.
      if (!socio) return { member: null };
      // Firma sobre la sede de casa del socio (o todo el gimnasio): la misma regla que la firma.
      request.requirePermission('approvals:grant', socio.homeBranchId);
      const hoy = await new BusinessCalendar(orgId).today(socio.homeBranchId);
      const [deuda, correcciones] = await Promise.all([repo.deudaDelSocio(socio.id, hoy), repo.correccionesDelSocio(socio.id, new Date(Date.now() - 90 * MS_DIA))]);
      return {
        member: {
          memberSince: socio.createdAt.toISOString().slice(0, 10),
          outstandingCents: texto(deuda.outstandingCents), overdueCents: texto(deuda.overdueCents),
          corrections: { last90Days: correcciones.recientes, total: correcciones.total },
        },
      };
    },
  });
}
