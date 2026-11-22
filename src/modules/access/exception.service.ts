import {
  exceptionOptions, formatMoney, money, notFound, validation,
  type ExceptionOption, type PaymentMethodType, type DenialReason } from '@gymflow/core';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { enUnidadDeDinero } from '../../platform/db/unit-of-work.js';
import { BillingService, ChargeRepository, PaymentRepository } from '../billing/index.js';
import { MemberRepository } from '../members/index.js';
import { MembershipRepository } from '../memberships/index.js';
import { AccessRepository, type DecisionRecord } from './access.repository.js';
import { AttendanceRepository } from './attendance.repository.js';
import { AccessService, deudaEnPuerta } from './access.service.js';
import { emitEntry } from './entry-hooks.js';
import type { RequestContext } from '../../platform/context.js';

/**
 * Pantalla de excepción (§9 del roadmap).
 *
 * Convierte el rechazo del torniquete de conflicto en transacción. Todo lo que
 * recepción necesita viene en UNA llamada: con un socio delante y una cola
 * detrás, tres peticiones encadenadas son tres oportunidades de que la
 * pantalla se quede a medias. El criterio del sprint —resolver en veinte
 * segundos— se pierde ahí.
 */

export type ExceptionView = {
  decision: DecisionRecord;
  member: {
    id: string;
    memberCode: string;
    fullName: string;
    photoUrl: string | null;
    /**
     * Antigüedad. Es el dato que cambia la decisión: un socio de tres años que
     * debe $650 no es el mismo caso que uno de dos meses que debe $650, y sin
     * verlo recepción trata igual dos situaciones distintas.
     */
    joinedAt: Date;
    tenureDays: number;
  };
  membershipStatus: string | null;
  planName: string | null;
  outstandingCents: bigint;
  /** Saldo a favor sin aplicar: se aplica primero al cobrar, así que se propone la deuda menos esto (4-18). */
  creditCents: bigint;
  /** Lo mínimo para abrir hoy (la cuota más antigua, bruto) y cuántas cuotas debe; `null` si no debe cuotas de periodo. */
  minimumCents: bigint | null;
  periodsOwed: number | null;
  recentVisits: Array<{ at: Date; branchId: string }>;
  options: ExceptionOption[];
  /** Si ya se resolvió (5-10): con qué concesión, cuándo y quién. Un rechazo se resuelve una vez. */
  resolution: { decisionId: string; at: Date; byName: string | null } | null;
};

export class ExceptionService {
  private readonly access = new AccessService();

  async view(ctx: RequestContext, decisionId: string): Promise<ExceptionView> {
    const orgId = ctx.tenant.organizationId;

    const accesos = new AccessRepository(orgId);
    const decision = await accesos.findDecision(decisionId);
    if (!decision) throw notFound('Decisión no encontrada');
    if (!decision.memberId) throw validation('Ese rechazo no corresponde a un socio identificado');
    const resolucion = await accesos.resolucionDe(decision.id);
    const quien = resolucion?.overriddenByUserId ? (await accesos.nombresDePersonal([resolucion.overriddenByUserId])).get(resolucion.overriddenByUserId) ?? null : null;

    const member = await new MemberRepository(orgId).findByIdIncludingArchived(decision.memberId);
    if (!member) throw notFound('Socio no encontrado');

    const membership = await new MembershipRepository(orgId).findLiveForMember(decision.memberId);
    const cargos = new ChargeRepository(orgId);
    const [outstanding, periodo, credito] = await Promise.all([
      cargos.outstandingTotalCents(decision.memberId), cargos.oldestOpenPeriod(decision.memberId),
      new PaymentRepository(orgId).creditBalanceCents(decision.memberId),
    ]);

    const recentVisits = await new AttendanceRepository(orgId).recentVisits(decision.memberId, 5);

    const hoy = await new BusinessCalendar(orgId).today(decision.branchId);
    const tenureDays = Math.floor((hoy.getTime() - member.joinedAt.getTime()) / 86_400_000);

    const { isOverridable } = await import('@gymflow/core');
    const overridable = decision.denialReason !== null
      && isOverridable(decision.denialReason as DenialReason);

    return {
      decision,
      member: {
        id: member.id,
        memberCode: member.memberCode,
        fullName: `${member.firstName} ${member.lastName}`,
        photoUrl: null,
        joinedAt: member.joinedAt,
        tenureDays,
      },
      membershipStatus: membership?.status ?? null,
      planName: null,
      outstandingCents: outstanding,
      creditCents: credito,
      minimumCents: periodo?.minimumCents ?? null,
      periodsOwed: periodo?.periodsOwed ?? null,
      recentVisits,
      options: exceptionOptions({
        reason: decision.denialReason ?? '',
        overridable,
        outstandingCents: outstanding,
      }),
      resolution: resolucion ? { decisionId: resolucion.id, at: resolucion.at, byName: quien } : null,
    };
  }

  /**
   * Cobrar y abrir, en una sola operación.
   *
   * Es el botón principal ante una deuda y el que justifica toda la pantalla:
   * el socio paga ahí mismo y entra. Si el cobro falla, NO se abre — sería
   * regalar el acceso y perder el cobro a la vez.
   */
  async collectAndOpen(ctx: RequestContext, input: {
    decisionId: string;
    method: PaymentMethodType;
    amountCents: bigint;
    cashSessionId?: string | null;
    externalRef?: string | null;
  }): Promise<{
    paymentId: string; folio: string | null; decisionId: string; attendanceId: string | null;
    creditAppliedCents: bigint; estado: Awaited<ReturnType<BillingService['estadoParaCobro']>>;
  }> {
    const orgId = ctx.tenant.organizationId;
    const billing = new BillingService();

    // Cobro y paso en UNA unidad (5-10): un rechazo ya resuelto no se cobra, y
    // si otra persona lo resuelve en este mismo instante, el cobro se deshace
    // en vez de quedar un pago sin entrada.
    const r = await enUnidadDeDinero(orgId, async () => {
      const decision = await new AccessRepository(orgId).findDecision(input.decisionId);
      if (!decision) throw notFound('Decisión no encontrada');
      if (!decision.memberId) throw validation('Ese rechazo no corresponde a un socio identificado');
      // Antes de tocar el dinero.
      await this.access.exigirSinResolver(ctx, decision.id);

      // Cobro parcial (MC-22): al menos la cuota más vieja; lo demás se decide
      // en la ficha. Y sobre el NETO (4-18): el saldo a favor se aplica primero
      // (lo hace `recordPayment`), así que ni el mínimo ni el tope se miden
      // contra una deuda que el crédito ya cubre. Antes la puerta pedía el
      // bruto y el crédito del socio se quedaba esperando al mes siguiente.
      const [deuda, credito] = await Promise.all([
        deudaEnPuerta(orgId, decision.memberId), new PaymentRepository(orgId).creditBalanceCents(decision.memberId),
      ]);
      const neto = (x: bigint) => (x > credito ? x - credito : 0n);
      const [debe, minimo] = [neto(deuda.outstandingCents), neto(deuda.minimumCents)];
      const conCredito = credito > 0n ? ` (ya descontados ${formatMoney(money(credito))} que tiene a favor)` : '';
      if (debe <= 0n) throw validation(`Su saldo a favor (${formatMoney(money(credito))}) cubre lo que debe: no hay nada que cobrar en la puerta. Aplícalo desde su ficha`);
      if (input.amountCents < minimo) throw validation(`Para abrir hoy hay que cobrar al menos ${formatMoney(money(minimo))} (la cuota más antigua)${conCredito}`);
      if (input.amountCents > debe) throw validation(`Debe ${formatMoney(money(debe))}${conCredito}: no se cobra de más en la puerta`);

      const cobro = await billing.recordPayment(ctx, {
        memberId: decision.memberId,
        method: input.method,
        amountCents: input.amountCents,
        branchId: decision.branchId,
        ...(input.cashSessionId ? { cashSessionId: input.cashSessionId } : {}),
        ...(input.externalRef ? { externalRef: input.externalRef } : {}),
      });

      // Solo tras cobrar se abre. El orden importa: al revés, un fallo del cobro
      // dejaría al socio dentro y la deuda fuera.
      const paso = await this.access.concederSobreRechazo(ctx, {
        decisionId: input.decisionId,
        reason: input.amountCents < debe
          ? `Pagó en el mostrador ${formatMoney(money(input.amountCents))} de ${formatMoney(money(debe))}; el resto se decide en su ficha`
          : `Pagó en el mostrador: ${formatMoney(money(input.amountCents))}`,
      });
      return { cobro, paso, memberId: decision.memberId, branchId: decision.branchId };
    });

    // Los ganchos de la entrada (la clase reservada queda con su llegada), ya confirmado todo.
    if (r.paso.attendanceId) await emitEntry({ organizationId: orgId, memberId: r.memberId, branchId: r.branchId, at: new Date() });

    return {
      paymentId: r.cobro.payment.id,
      folio: r.cobro.payment.folio,
      decisionId: r.paso.record.id,
      attendanceId: r.paso.attendanceId,
      creditAppliedCents: r.cobro.creditAppliedCents,
      // El veredicto, como en la ficha y en Caja (4-09): si con eso quedó al
      // corriente y hasta dónde, o cuánto le falta. La puerta ya se abrió por
      // esta vez; esto dice qué pasará mañana.
      estado: await billing.estadoParaCobro(ctx, r.memberId),
    };
  }
}
