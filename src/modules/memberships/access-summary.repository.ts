import { PrismaChargeStatus, PrismaChargeType, PrismaMembershipStatus, PrismaVisitPackStatus } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

const S = PrismaMembershipStatus;
const VP = PrismaVisitPackStatus;

export type ResumenAcceso = {
  memberId: string;
  membership: { status: string; currentPeriodEnd: Date; graceUntil: Date | null; planName: string | null } | null;
  pack: { status: string; visitsLeft: number; expiresOn: Date | null } | null;
  /**
   * Sus pases del día PAGADOS de estos días (1.8): la sede y el día que cubre
   * cada uno. Cuál es «de hoy» lo decide quien llama con el día de operación
   * de cada sede; aquí solo se acota a ayer–mañana para no traer el historial.
   */
  dayPasses: Array<{ branchId: string; validOn: Date }>;
};

/**
 * Lo que recepción necesita ver de un vistazo, para MUCHOS socios a la vez:
 * la membresía viva (o suspendida) y el paquete vigente con sus visitas.
 *
 * Antes cada pantalla pintaba `member.status`, que es otra cosa: un socio
 * con la membresía suspendida salía "Activo" en verde (UXA-04, UXB-06,
 * UI2-06), y un paquete de visitas no aparecía en ninguna parte (UXA-03).
 * Tres consultas para toda la página, no tres por socio.
 */
export class AccessSummaryRepository extends TenantRepository {
  async forMembers(memberIds: readonly string[]): Promise<ResumenAcceso[]> {
    if (memberIds.length === 0) return [];
    const ids = [...memberIds];
    const cerca = (dias: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + dias));
    const [pases, membresias, paquetes] = await Promise.all([
      // El pase del día es su cargo (ver `billing/day-pass.repository.ts`): sin membresía, con sede y con su día.
      this.db.charge.findMany({
        where: this.scope({
          memberId: { in: ids }, chargeType: PrismaChargeType.DAY_PASS, status: PrismaChargeStatus.PAID,
          membershipId: null, branchId: { not: null }, periodStart: { gte: cerca(-1), lte: cerca(1) },
        }),
        select: { memberId: true, branchId: true, periodStart: true },
      }),
      this.db.membership.findMany({
        where: this.scope({ memberId: { in: ids }, status: { in: [S.PENDING, S.TRIALING, S.ACTIVE, S.PAST_DUE, S.FROZEN, S.SUSPENDED] } }),
        select: { memberId: true, planId: true, status: true, currentPeriodEnd: true, graceUntil: true, startDate: true },
        orderBy: { startDate: 'desc' },
      }),
      this.db.visitPack.findMany({
        where: this.scope({ memberId: { in: ids }, status: { in: [VP.ACTIVE, VP.PENDING_PAYMENT] } }),
        select: { id: true, memberId: true, status: true, expiresOn: true, purchasedOn: true },
        orderBy: { purchasedOn: 'desc' },
      }),
    ]);
    const saldos = paquetes.length === 0 ? [] : await this.db.visitLedgerEntry.groupBy({
      by: ['visitPackId'], where: { organizationId: this.organizationId, visitPackId: { in: paquetes.map((p) => p.id) } },
      _sum: { delta: true },
    });
    const saldo = new Map(saldos.map((x) => [x.visitPackId, x._sum.delta ?? 0]));
    // El nombre del plan: es lo que recepción confirma en voz alta al dejar pasar.
    const planes = membresias.length === 0 ? [] : await this.db.plan.findMany({
      where: this.scope({ id: { in: [...new Set(membresias.map((x) => x.planId))] } }), select: { id: true, name: true },
    });
    const nombrePlan = new Map(planes.map((x) => [x.id, x.name]));

    return ids.map((memberId) => {
      const m = membresias.find((x) => x.memberId === memberId);
      // Se prefiere el paquete que ya da acceso sobre uno sin pagar.
      const p = paquetes.find((x) => x.memberId === memberId && x.status === VP.ACTIVE)
        ?? paquetes.find((x) => x.memberId === memberId);
      return {
        memberId,
        membership: m ? { status: m.status, currentPeriodEnd: m.currentPeriodEnd, graceUntil: m.graceUntil, planName: nombrePlan.get(m.planId) ?? null } : null,
        pack: p ? { status: p.status, visitsLeft: saldo.get(p.id) ?? 0, expiresOn: p.expiresOn } : null,
        dayPasses: pases.filter((x) => x.memberId === memberId).map((x) => ({ branchId: x.branchId!, validOn: x.periodStart! })),
      };
    });
  }
}
