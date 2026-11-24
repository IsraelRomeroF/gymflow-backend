import {
  classifyEngagement, enRecuperar, rankOutreach, recuperarHasta, sumarDias, sumarMeses,
  type EngagementState, type EngagementVerdict, type OutreachCandidate, type PlazosDelSocio,
} from '@gymflow/core';
import type { WinbackCause } from '@gymflow/core/contracts';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { plazosDe } from '../../platform/plazos/plazos-del-socio.repository.js';
import { BajaRepository } from '../memberships/index.js';
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
  /** Los plazos del gimnasio con que se clasificó (D-18). */
  terms: PlazosDelSocio;
  /** Todos los clasificados: lo usa «Recuperar» para sacar a los perdidos sin repetir la consulta. */
  todos: MemberEngagement[];
};

/** Una persona en «Recuperar» (D-18): se perdió o está de baja, y todavía se le busca. */
export type PorRecuperar = {
  memberId: string; memberCode: string; fullName: string; homeBranchId: string | null; phoneE164: string | null;
  cause: WinbackCause; since: string; until: string; lastVisitOn: string | null;
  planName: string | null; reason: string | null; archived: boolean;
};

export type WinbackReport = {
  asOf: string;
  terms: PlazosDelSocio;
  total: number;
  counts: Record<WinbackCause, number>;
  members: PorRecuperar[];
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
    // Los plazos son del gimnasio (D-18, bloque 4.4): «dejó de venir» y «perdido» ya no son números de aquí.
    const terms = await plazosDe(orgId);

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
        plazos: terms,
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
      terms,
      todos: conVeredicto,
    };
  }

  /**
   * «RECUPERAR» (D-18, 15-10): a quién se le sigue buscando. Son dos grupos,
   * con la misma ventana (los meses del gimnasio, de fábrica 6):
   *  - PERDIDOS: tienen membresía pero llevan el plazo de «perdido» sin venir
   *    (de fábrica 60 días). Se cuentan desde el día en que cumplieron ese plazo.
   *  - DE BAJA: cancelaron, su membresía terminó hace el plazo de baja sin
   *    renovar, o los dieron de baja en su ficha. Desde el día de su baja.
   * Cada persona sale una vez, con su ficha de siempre (una persona, un
   * registro: no se copia a Interesados). Los anonimizados no salen. Los más
   * recientes primero: son los que más fácil regresan.
   */
  async winback(ctx: RequestContext, opts: { branchId?: string | null; limit?: number } = {}): Promise<WinbackReport> {
    const orgId = ctx.tenant.organizationId;
    const sede = opts.branchId ?? null;
    const r = await this.report(ctx, { branchId: sede, limit: 1 });
    const hoyIso = r.asOf;
    const hoy = new Date(`${hoyIso}T00:00:00.000Z`);
    const { lostDays, churnDays, winbackMonths } = r.terms;
    const dia = (d: Date) => d.toISOString().slice(0, 10);

    const perdidos: PorRecuperar[] = r.todos.filter((m) => m.verdict.state === 'LOST').map((m) => {
      // Desde cuándo se cuenta sin venir: su última visita, el día en que descongeló si fue después, o su alta si nunca vino.
      const pausado = m.resumedAt !== null && (m.lastVisitAt === null || m.lastVisitAt.getTime() < m.resumedAt.getTime());
      const base = pausado ? m.resumedAt! : m.lastVisitAt ?? m.joinedAt;
      const since = sumarDias(dia(base), lostDays);
      return {
        memberId: m.memberId, memberCode: m.memberCode, fullName: m.fullName, homeBranchId: m.homeBranchId, phoneE164: m.phoneE164,
        cause: 'LOST' as const, since, until: recuperarHasta(since, winbackMonths),
        lastVisitOn: m.lastVisitAt ? dia(m.lastVisitAt) : null, planName: m.planName, reason: null, archived: false,
      };
    });

    const desde = new Date(`${sumarMeses(hoyIso, -winbackMonths)}T00:00:00.000Z`);
    const conBaja = (await new BajaRepository(orgId).conBaja({ desde, churnDays, branchId: sede, today: hoy }))
      .filter((s) => s.baja !== null && !s.anonymized);
    const visitas = await new RetentionRepository(orgId).ultimasVisitas(conBaja.map((s) => s.memberId));
    const bajas: PorRecuperar[] = conBaja.map((s) => ({
      memberId: s.memberId, memberCode: s.memberCode, fullName: s.fullName, homeBranchId: s.homeBranchId, phoneE164: s.phoneE164,
      cause: s.baja!.cause, since: s.baja!.since, until: recuperarHasta(s.baja!.since, winbackMonths),
      lastVisitOn: visitas.has(s.memberId) ? dia(visitas.get(s.memberId)!) : null,
      planName: s.lastPlanName, reason: s.baja!.cause === 'CANCELED' ? s.lastReason : null, archived: s.archivedOn !== null,
    }));

    const vistos = new Set<string>();
    const todos = [...bajas, ...perdidos]
      .filter((m) => enRecuperar(m.since, hoyIso, winbackMonths))
      .filter((m) => (vistos.has(m.memberId) ? false : (vistos.add(m.memberId), true)))
      .sort((a, b) => (a.since === b.since ? a.fullName.localeCompare(b.fullName, 'es') || a.memberId.localeCompare(b.memberId) : a.since < b.since ? 1 : -1));
    const counts: Record<WinbackCause, number> = { LOST: 0, ARCHIVED: 0, CANCELED: 0, EXPIRED: 0 };
    for (const m of todos) counts[m.cause]++;
    return { asOf: hoyIso, terms: r.terms, total: todos.length, counts, members: todos.slice(0, opts.limit ?? 200) };
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
