import { leerCursor, type PartesDelCursor, type StatementChargesPage, type StatementPaymentsPage } from '@gymflow/core/contracts';
import { notFound, validation } from '@gymflow/core';
import type { RequestContext } from '../../platform/context.js';
import { MemberRepository } from '../members/index.js';
import { BillingService, type EstadoParaCobro } from './billing.service.js';
import { ChargeRepository, type ChargeRecord } from './charge.repository.js';
import { PaymentRepository } from './payment.repository.js';
import { StatementRepository } from './statement.repository.js';
import { serializeStatementCharge, serializeStatementPayment } from './statement.serializers.js';

/**
 * EL ESTADO DE CUENTA QUE LEE EL PERSONAL (3-04, 3-05, 3-06, 4-15).
 *
 * Saldo, lo más reciente de cargos y pagos, y cuántos hay en total. Lo que se
 * debe viene SIEMPRE en la primera respuesta aunque sea viejo; lo demás se
 * pide por páginas. No mueve dinero: eso es `BillingService`.
 */
export type EstadoDeCuenta = {
  memberId: string;
  outstandingCents: bigint;
  creditCents: bigint;
  netBalanceCents: bigint;
  charges: StatementChargesPage['items'];
  payments: StatementPaymentsPage['items'];
  pages: {
    charges: { total: number; nextCursor: string | null; hasMore: boolean };
    payments: { total: number; nextCursor: string | null; hasMore: boolean };
  };
  today: Date;
  cobro: EstadoParaCobro;
};

/** El `?cursor=` de una lista: si no es uno de la API, 422 (nunca una página a medias). */
export function cursorDe(texto: string | undefined): PartesDelCursor | null {
  if (texto === undefined) return null;
  const partes = leerCursor(texto);
  if (!partes) throw validation('Esa página ya no existe. Vuelve a abrir la lista.');
  return partes;
}

export class StatementService {
  private readonly billing = new BillingService();

  async statement(ctx: RequestContext, memberId: string, limit: number): Promise<EstadoDeCuenta> {
    const orgId = ctx.tenant.organizationId;
    const member = await new MemberRepository(orgId).findById(memberId);
    if (!member) throw notFound('Socio no encontrado');

    const lectura = new StatementRepository(orgId);
    const [outstanding, credit, cargos, pagos, today, cobro] = await Promise.all([
      new ChargeRepository(orgId).outstandingTotalCents(memberId),
      new PaymentRepository(orgId).creditBalanceCents(memberId),
      this.chargesPage(orgId, memberId, limit, null),
      this.paymentsPage(orgId, memberId, limit, null),
      this.billing.businessDate(orgId, member.homeBranchId),
      this.billing.estadoParaCobro(ctx, memberId),
    ]);
    // Lo que debe y quedó más atrás que la primera página: viene también.
    const viejos = cargos.hasMore ? await this.conDetalle(lectura, await lectura.debtOutside(memberId, cargos.items.map((c) => c.id))) : [];

    return {
      memberId,
      outstandingCents: outstanding,
      creditCents: credit,
      netBalanceCents: outstanding - credit,
      charges: [...cargos.items, ...viejos],
      payments: pagos.items,
      pages: {
        charges: { total: cargos.total, nextCursor: cargos.nextCursor, hasMore: cargos.hasMore },
        payments: { total: pagos.total, nextCursor: pagos.nextCursor, hasMore: pagos.hasMore },
      },
      today,
      cobro,
    };
  }

  /** Una página de cargos con cómo quedó saldado cada uno y sus ajustes. */
  async chargesPage(orgId: string, memberId: string, limit: number, cursor: PartesDelCursor | null): Promise<StatementChargesPage> {
    const lectura = new StatementRepository(orgId);
    const pagina = await lectura.chargesPage(memberId, limit, cursor);
    return { ...pagina, items: await this.conDetalle(lectura, pagina.items) };
  }

  /** Una página de pagos con quién cobró y qué cubrió cada uno. */
  async paymentsPage(orgId: string, memberId: string, limit: number, cursor: PartesDelCursor | null): Promise<StatementPaymentsPage> {
    const lectura = new StatementRepository(orgId);
    const pagina = await lectura.paymentsPage(memberId, limit, cursor);
    const [cubre, nombres] = await Promise.all([
      lectura.coversFor(pagina.items.map((p) => p.id)),
      lectura.staffNames(pagina.items.map((p) => p.createdByUserId)),
    ]);
    return { ...pagina, items: pagina.items.map((p) => serializeStatementPayment(p, cubre.get(p.id) ?? [], nombres)) };
  }

  /** Para las páginas siguientes: el socio tiene que existir en ESTE gimnasio. */
  async assertMember(orgId: string, memberId: string): Promise<void> {
    if (!await new MemberRepository(orgId).findById(memberId)) throw notFound('Socio no encontrado');
  }

  private async conDetalle(lectura: StatementRepository, cargos: readonly ChargeRecord[]): Promise<StatementChargesPage['items']> {
    const ajustes = await lectura.adjustmentsFor(cargos.filter((c) => c.adjustedCents > 0n).map((c) => c.id));
    const nombres = await lectura.staffNames([...ajustes.values()].flat().map((a) => a.approvedByUserId));
    return cargos.map((c) => serializeStatementCharge(c, ajustes.get(c.id) ?? [], nombres));
  }
}
