import { PrismaChargeStatus, PrismaChargeType } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * PASE DEL DÍA (bloque 1.8; auditoría 8, 4-01).
 *
 * El pase no tiene tabla: ES su cargo. Un cargo `DAY_PASS` sin membresía, con
 * sede y con el día de operación que cubre en `periodStart` (y el siguiente en
 * `periodEnd`, semiabierto como todo periodo). Vale cuando está PAGADO y es de
 * hoy. Así un pase anulado o con el cobro revertido deja de abrir sin que
 * nadie tenga que acordarse de apagar otra cosa, y los ingresos lo cuentan
 * por su tipo de cargo, que ya existía.
 *
 * Un cargo `DAY_PASS` creado a mano fuera del catálogo (`POST /members/:id/charges`)
 * no trae día ni sede: no es un pase y no abre.
 */
export type DayPassRecord = {
  id: string;
  memberId: string;
  branchId: string;
  /** El día de operación que cubre. */
  validOn: Date;
  concept: string;
  amountCents: bigint;
  status: string;
  idempotencyKey: string | null;
};

const SELECT = {
  id: true, memberId: true, branchId: true, periodStart: true, concept: true,
  amountCents: true, status: true, idempotencyKey: true,
} as const;

type Fila = { id: string; memberId: string; branchId: string | null; periodStart: Date | null; concept: string; amountCents: bigint; status: string; idempotencyKey: string | null };

const aPase = (f: Fila): DayPassRecord => ({
  id: f.id, memberId: f.memberId, branchId: f.branchId!, validOn: f.periodStart!, concept: f.concept,
  amountCents: f.amountCents, status: f.status, idempotencyKey: f.idempotencyKey,
});

/** Lo que hace de un cargo un pase: tipo, sin membresía, con sede y con su día. */
const ES_PASE = {
  chargeType: PrismaChargeType.DAY_PASS, membershipId: null,
  branchId: { not: null }, periodStart: { not: null },
} as const;

/** Cómo se llama el cargo en el estado de cuenta y en la cotización (un plan que ya se llama «Pase del día» no lo repite). */
export const conceptoDelPase = (nombreDelPlan: string): string =>
  /^pase del d[ií]a/i.test(nombreDelPlan.trim()) ? nombreDelPlan.trim() : `Pase del día · ${nombreDelPlan.trim()}`;

export class DayPassRepository extends TenantRepository {
  async findById(id: string): Promise<DayPassRecord | null> {
    const f = await this.db.charge.findFirst({ where: this.scope({ ...ES_PASE, id }), select: SELECT });
    return f ? aPase(f) : null;
  }

  /**
   * Los pases PAGADOS del socio para ese día de operación. La puerta pregunta
   * por el día de SU sede; el pase de otra sede se devuelve también (la
   * política dice «no es de esta sede», no «no trae nada»).
   */
  async pagadosDelDia(memberId: string, dia: Date): Promise<DayPassRecord[]> {
    const filas = await this.db.charge.findMany({
      where: this.scope({ ...ES_PASE, memberId, status: PrismaChargeStatus.PAID, periodStart: dia }),
      select: SELECT, orderBy: { createdAt: 'desc' },
    });
    return filas.map(aPase);
  }

  /** El pase de ese día en esa sede que sigue en pie (pagado o por pagar): no se vende otro. */
  async vivoDelDia(memberId: string, branchId: string, dia: Date): Promise<DayPassRecord | null> {
    const f = await this.db.charge.findFirst({
      where: this.scope({
        ...ES_PASE, memberId, branchId, periodStart: dia,
        status: { notIn: [PrismaChargeStatus.VOID, PrismaChargeStatus.WRITTEN_OFF] },
      }),
      select: SELECT,
    });
    return f ? aPase(f) : null;
  }

  /** Los más recientes primero, sin los anulados ni castigados. */
  async recientes(memberId: string, limit: number): Promise<DayPassRecord[]> {
    const filas = await this.db.charge.findMany({
      where: this.scope({ ...ES_PASE, memberId, status: { notIn: [PrismaChargeStatus.VOID, PrismaChargeStatus.WRITTEN_OFF] } }),
      select: SELECT, orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }], take: limit,
    });
    return filas.map(aPase);
  }

  /** Cuántos pases pagados lleva: las visitas sueltas se cuentan en la ficha. */
  async totalPagados(memberId: string): Promise<number> {
    return this.db.charge.count({ where: this.scope({ ...ES_PASE, memberId, status: PrismaChargeStatus.PAID }) });
  }
}
