import {
  classifyEngagement, rankOutreach,
  type EngagementState, type EngagementVerdict, type OutreachCandidate,
} from '@gymflow/core';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { RetentionRepository, type EngagementRow } from './retention.repository.js';
import type { RequestContext } from '../../platform/context.js';

export type MemberEngagement = EngagementRow & { verdict: EngagementVerdict };

export type RetentionReport = {
  asOf: string;
  counts: Record<EngagementState, number>;
  /** Cuántos hay que llamar ANTES del recorte por `limit`. */
  total: number;
  /** Ordenada por dónde está el retorno, no por fecha. */
  outreach: MemberEngagement[];
};

/** Las cifras sin nombres: lo que ve la dueña (D15-01, ADR-039). */
export type RetentionFigures = {
  asOf: string;
  counts: Record<EngagementState, number>;
  /** No arrancaron + aflojando + dejaron de venir: los que se llaman. */
  atRisk: number;
};

/**
 * Alertas de onboarding fallido e inactividad (F-22).
 *
 * El hecho que las justifica: **el socio deja de venir semanas antes de dejar
 * de pagar**. Contactarlo dentro de esa ventana es retención; después del
 * corte, ya es cobranza — y la cobranza recupera mucho menos.
 */
export class RetentionService {
  async report(ctx: RequestContext, opts: {
    branchId?: string | null; limit?: number;
  } = {}): Promise<RetentionReport> {
    const orgId = ctx.tenant.organizationId;
    const hoy = await new BusinessCalendar(orgId).today(opts.branchId ?? null);

    const filas = await new RetentionRepository(orgId).engagement(hoy, opts.branchId ?? null);

    const counts: Record<EngagementState, number> = {
      NEW: 0, ONBOARDING_AT_RISK: 0, REGULAR: 0, SLIPPING: 0, DORMANT: 0, LOST: 0,
    };

    const conVeredicto: MemberEngagement[] = filas.map((f) => {
      const verdict = classifyEngagement({
        joinedAt: f.joinedAt,
        lastVisitAt: f.lastVisitAt,
        totalVisits: f.totalVisits,
        baselineVisitsPerWeek: f.baselineVisitsPerWeek,
        // Congelados fuera mientras dure la pausa; al descongelar, los días
        // sin venir se cuentan desde ahí, con una semana de gracia (D15-07).
        resumedAt: f.resumedAt,
        now: hoy,
      });
      counts[verdict.state]++;
      return { ...f, verdict };
    });

    const candidatos: OutreachCandidate[] = conVeredicto.map((m) => ({
      memberId: m.memberId,
      state: m.verdict.state,
      missedVisits: m.verdict.missedVisits,
      tenureDays: m.verdict.daysSinceJoined,
      monthlyValueCents: m.monthlyValueCents,
    }));

    const orden = new Map(rankOutreach(candidatos).map((c, i) => [c.memberId, i]));

    const porLlamar = conVeredicto
      .filter((m) => orden.has(m.memberId))
      .sort((a, b) => orden.get(a.memberId)! - orden.get(b.memberId)!);

    return {
      asOf: hoy.toISOString().slice(0, 10),
      counts,
      // El total REAL: la pantalla dice «120 de 640» en vez de callar el recorte.
      total: porLlamar.length,
      // Priorizar primero y recortar después.
      outreach: porLlamar.slice(0, opts.limit ?? 500),
    };
  }

  /**
   * Las cifras sin nombres, para la dueña, el Inicio y el Tablero. Sale del
   * MISMO cálculo que la lista (una sola regla): `atRisk` es exactamente
   * cuántas filas tendría la lista sin recorte.
   */
  async figures(ctx: RequestContext, opts: { branchId?: string | null } = {}): Promise<RetentionFigures> {
    const r = await this.report(ctx, { branchId: opts.branchId ?? null, limit: 1 });
    return { asOf: r.asOf, counts: r.counts, atRisk: r.total };
  }
}
