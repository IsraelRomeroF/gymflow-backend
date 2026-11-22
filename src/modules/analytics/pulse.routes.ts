import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { route } from '../../platform/http/registry.js';
import { claveDeSedes, recordar } from '../../platform/cache.js';
import { BranchRepository, OrganizationRepository } from '../organization/index.js';
import { PulseService, medianoche } from './pulse.service.js';
import { ShiftRepository } from './shift.repository.js';
import { PERM, VIGENCIA_TABLERO_MS, sedeDeReporte } from './report-scope.js';

export function registerPulseRoutes(app: FastifyInstance): void {
  // ── El pulso de la dueña ──────────────────────────────────────────────────
  /**
   * MI TURNO (UX5-M-02, UX5-G-02): el inicio de quien atiende. Sus sedes, su
   * caja, las entradas y las clases de hoy, y lo que le toca revisar. Sin
   * cifras del negocio: eso es de la dueña y la gerencia.
   */
  route(app, {
    method: 'GET',
    url: '/me/shift',
    security: { kind: 'session' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const todas = (await new BranchRepository(orgId).list()).filter((b) => b.isActive);
      const asignadas = ctx.tenant.grants.some((g) => g.branchId === null) ? null : new Set(ctx.tenant.grants.map((g) => g.branchId));
      const sedes = todas.filter((b) => asignadas === null || asignadas.has(b.id));
      const ids = sedes.map((b) => b.id);
      const zona = await new OrganizationRepository(orgId).effectiveTimezone(null);
      const ahora = new Date();
      const hoy = medianoche(zona, ahora);
      const finDelDia = new Date(hoy.getTime() + 86_400_000);
      const repo = new ShiftRepository(orgId);
      const verCaja = request.holds('cash:session:read', null) || ids.some((b) => request.holds('cash:session:read', b));
      const verAltas = ids.some((b) => request.holds('members:intake:read', b));
      const verClases = ids.some((b) => request.holds('classes:read', b));
      // Cuánta gente entró es dato del negocio: el coach no lo tiene en su puesto (1-05).
      const verEntradas = request.holds('access:attendance:read', null) || ids.some((b) => request.holds('access:attendance:read', b));
      const [cajas, abiertas, entradas, altas, clases] = await Promise.all([
        verCaja ? repo.cajas(ids) : Promise.resolve([]),
        verCaja ? repo.cajasAbiertas(ids) : Promise.resolve([]),
        verEntradas ? repo.entradas(ids, hoy) : Promise.resolve([]),
        verAltas ? repo.altasPorRevisar(ids) : Promise.resolve(0),
        verClases ? repo.clasesDeHoy(ids, ahora, finDelDia) : Promise.resolve([]),
      ]);
      const yo = ctx.tenant.actorUserId;
      return {
        asOf: ahora.toISOString(),
        branches: sedes.map((b) => {
          const e = entradas.find((x) => x.branchId === b.id);
          return {
            id: b.id, name: b.name,
            entriesToday: verEntradas ? e?.total ?? 0 : null, lastEntryAt: e?.ultima?.toISOString() ?? null,
            registers: cajas.filter((c) => c.branchId === b.id).map((c) => ({ id: c.id, name: c.name })),
            openSessions: abiertas.filter((s) => s.branchId === b.id).map((s) => ({
              id: s.id, registerName: s.registerName, openedByName: s.openedByName, openedAt: s.openedAt.toISOString(), mine: s.openedByUserId === yo,
            })),
          };
        }),
        canSeeCash: verCaja,
        canSeeEntries: verEntradas,
        pendingIntakes: verAltas ? altas : null,
        classesToday: clases.map((c) => ({ id: c.id, branchId: c.branchId, name: c.name, startsAt: c.startsAt.toISOString(), capacity: c.capacity, booked: c.booked })),
      };
    },
  });

  const pulso = new PulseService();
  /** Dinero a texto en toda la respuesta (ADR-005), fechas a ISO. */
  const plano = (v: unknown): unknown => (typeof v === 'bigint' ? v.toString()
    : v instanceof Date ? v.toISOString()
      : Array.isArray(v) ? v.map(plano)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plano(x)])) : v);

  /** Cómo va hoy, cuánto se lleva este mes y qué revisar, en una llamada (UXD-01). */
  route(app, {
    method: 'GET',
    url: '/reports/pulse',
    security: { kind: 'permission', permission: PERM },
    handler: async (request) => {
      const q = z.object({ branchId: z.string().uuid().optional(), fresh: z.coerce.boolean().optional() }).parse(request.query);
      const ctx = request.ctx!;
      const sedes = sedeDeReporte(request, q.branchId);
      return recordar(`pulse:${ctx.tenant.organizationId}:${claveDeSedes(sedes)}`, q.fresh ? 0 : VIGENCIA_TABLERO_MS, async () => plano(await pulso.pulso(ctx, sedes)));
    },
  });
}
