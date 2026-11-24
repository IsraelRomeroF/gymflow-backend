import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { systemContext, type JobHandler, type JobResult } from '../../platform/jobs/types.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { plazosDe } from '../../platform/plazos/plazos-del-socio.repository.js';

/**
 * LA DEUDA QUE SE DA POR PERDIDA (D-18; fase 4, bloque 4.4).
 *
 * D-18: «la deuda de una membresía suspendida sale de "por cobrar" a los 90
 * días». Cuando una membresía lleva suspendida el plazo del gimnasio,
 * `membership.expire-suspended` la termina; este job, que corre justo después,
 * marca lo que quedó debiendo con el día en que se dio por perdido
 * (`charges.lostOn`).
 *
 * Qué ES: una marca. La deuda deja de sumarse en «Por cobrar» (Tablero,
 * Inicio de la dueña, cartera) y se informa aparte como «dada por perdida».
 * Qué NO es (D-12, nada se borra solo): ni condonación ni anulación. El cargo
 * conserva su estado y su saldo, sigue en el estado de cuenta del socio y se
 * cobra como cualquier otro; al cobrarse deja de deberse y entra como ingreso
 * del día en que se cobra.
 *
 * A QUÉ CARGOS: los que siguen sin saldar de una membresía que terminó POR
 * llevar suspendida el plazo (pasó de suspendida a terminada). No toca la
 * deuda de una membresía cancelada por una persona, ni la de tienda o clases
 * sueltas, ni la de una suspendida que todavía no cumple el plazo.
 *
 * Se puede correr las veces que sea: solo marca lo que no tiene marca, y una
 * marca nunca se mueve ni se quita. La primera corrida en un gimnasio con
 * historia marca de golpe todo lo atrasado y lo deja dicho en la bitácora
 * (`firstRun`); `scripts/plazos-estado.ts` lo cuenta antes, sin escribir.
 */

export type DeudaPorMarcar = { chargeId: string; memberId: string; membershipId: string; branchId: string | null; balanceCents: bigint };

const ABIERTOS = `('OPEN','PARTIALLY_PAID','OVERDUE')`;

export class DeudaPerdidaRepository extends TenantRepository {
  /** Lo que la próxima corrida daría por perdido: de solo lectura. */
  async porMarcar(limit = 5000): Promise<DeudaPorMarcar[]> {
    return this.db.$queryRawUnsafe<DeudaPorMarcar[]>(`
      SELECT c."id" AS "chargeId", c."memberId", c."membershipId", c."branchId",
             (c."amountCents" - c."allocatedCents" - c."adjustedCents")::bigint AS "balanceCents"
        FROM "charges" c
        JOIN "memberships" ms ON ms."id" = c."membershipId" AND ms."organizationId" = c."organizationId"
       WHERE c."organizationId" = $1::uuid
         AND c."status" IN ${ABIERTOS} AND c."lostOn" IS NULL
         AND (c."amountCents" - c."allocatedCents" - c."adjustedCents") > 0
         AND ms."status" = 'EXPIRED'
         AND EXISTS (SELECT 1 FROM "membership_events" e
                      WHERE e."organizationId" = $1::uuid AND e."membershipId" = ms."id"
                        AND e."fromStatus" = 'SUSPENDED' AND e."toStatus" = 'EXPIRED')
       ORDER BY c."memberId", c."dueDate", c."id"
       LIMIT $2`, this.organizationId, limit);
  }

  /**
   * La deuda sin saldar de esas membresías (las suspendidas que el cierre de
   * esta noche terminaría): para el guion de estado, de solo lectura.
   */
  async abiertosDeMembresias(membershipIds: readonly string[]): Promise<DeudaPorMarcar[]> {
    if (membershipIds.length === 0) return [];
    return this.db.$queryRawUnsafe<DeudaPorMarcar[]>(`
      SELECT c."id" AS "chargeId", c."memberId", c."membershipId", c."branchId",
             (c."amountCents" - c."allocatedCents" - c."adjustedCents")::bigint AS "balanceCents"
        FROM "charges" c
       WHERE c."organizationId" = $1::uuid AND c."membershipId" = ANY($2::uuid[])
         AND c."status" IN ${ABIERTOS} AND c."lostOn" IS NULL
         AND (c."amountCents" - c."allocatedCents" - c."adjustedCents") > 0`, this.organizationId, [...membershipIds]);
  }

  /** Marca esos cargos con el día; los que ya tenían marca o ya se saldaron no cambian. Devuelve los que marcó. */
  async marcar(chargeIds: readonly string[], day: Date): Promise<string[]> {
    if (chargeIds.length === 0) return [];
    const filas = await this.db.$queryRawUnsafe<Array<{ id: string }>>(`
      UPDATE "charges" SET "lostOn" = $3::date, "updatedAt" = now()
       WHERE "organizationId" = $1::uuid AND "id" = ANY($2::uuid[])
         AND "lostOn" IS NULL AND "status" IN ${ABIERTOS}
      RETURNING "id"`, this.organizationId, [...chargeIds], day);
    return filas.map((f) => f.id);
  }

  /** Lo que hoy está dado por perdido y sigue sin saldar (lo cobrado ya no cuenta). */
  async resumen(branchId?: string | null): Promise<{ lostCents: bigint; lostMembers: number; lostCharges: number }> {
    const params: unknown[] = [this.organizationId];
    if (branchId) params.push(branchId);
    const [r] = await this.db.$queryRawUnsafe<Array<{ cents: bigint; members: number; charges: number }>>(`
      SELECT COALESCE(SUM(c."amountCents" - c."allocatedCents" - c."adjustedCents"), 0)::bigint AS cents,
             COUNT(DISTINCT c."memberId")::int AS members, COUNT(*)::int AS charges
        FROM "charges" c
       WHERE c."organizationId" = $1::uuid AND c."status" IN ${ABIERTOS} AND c."lostOn" IS NOT NULL
         ${branchId ? 'AND c."branchId" = $2::uuid' : ''}`, ...params);
    return { lostCents: r?.cents ?? 0n, lostMembers: r?.members ?? 0, lostCharges: r?.charges ?? 0 };
  }

  /** El día en que se dio por perdido cada cargo de la lista (solo los que tienen marca). */
  async marcasDe(chargeIds: readonly string[]): Promise<Map<string, Date>> {
    if (chargeIds.length === 0) return new Map();
    const filas = await this.db.charge.findMany({
      where: this.scope({ id: { in: [...chargeIds] }, lostOn: { not: null } }), select: { id: true, lostOn: true },
    });
    return new Map(filas.map((f) => [f.id, f.lostOn!]));
  }

  /** ¿Ya hubo una corrida que marcara algo en este gimnasio? */
  async yaCorrio(): Promise<boolean> {
    return (await this.db.auditLog.count({ where: this.scope({ action: 'billing.debt.lost.summary' }) })) > 0;
  }
}

const LOTE = 500;
const MAX_LOTES = 200;

/**
 * El job del cierre diario. Un asiento por socio (queda en su historia) y un
 * resumen por corrida que marcó algo (ese va a «Para revisar»: cuánto dinero
 * salió de «Por cobrar» esa noche, de cuántos socios y con qué plazo).
 */
export const markLostDebt: JobHandler = async (organizationId) => {
  const result: JobResult = { job: 'billing.mark-lost-debt', processed: 0, skipped: 0, batches: 0, truncated: false, errors: [] };
  const repo = new DeudaPerdidaRepository(organizationId);
  const audit = new AuditService();
  const ctx = systemContext(organizationId);
  const { lostDebtDays } = await plazosDe(organizationId);
  const day = (await new BusinessCalendar(organizationId).dias()).gimnasio;
  const primera = !(await repo.yaCorrio());
  const motivo = `Su membresía llevó ${lostDebtDays} días suspendida sin pagar y terminó`;

  let total = 0n;
  const socios = new Set<string>();
  const vistos = new Set<string>();
  while (result.batches < MAX_LOTES) {
    const lote = (await repo.porMarcar(LOTE)).filter((c) => !vistos.has(c.chargeId));
    if (lote.length === 0) break;
    result.batches++;
    for (const c of lote) vistos.add(c.chargeId);
    // Por socio: sus cargos se marcan juntos y dejan un solo asiento.
    const porSocio = new Map<string, DeudaPorMarcar[]>();
    for (const c of lote) porSocio.set(c.memberId, [...(porSocio.get(c.memberId) ?? []), c]);
    for (const [memberId, cargos] of porSocio) {
      try {
        // La marca y su asiento, juntos: si la bitácora no se escribe, la deuda no se marca.
        const hechos = await enUnaTransaccion(async () => {
          const marcados = new Set(await repo.marcar(cargos.map((c) => c.chargeId), day));
          const suyos = cargos.filter((c) => marcados.has(c.chargeId));
          if (suyos.length === 0) return suyos;
          await audit.record(ctx, {
            action: 'billing.debt.lost', resourceType: 'Member', resourceId: memberId, branchId: suyos[0]!.branchId,
            afterState: {
              amountCents: suyos.reduce((a, c) => a + c.balanceCents, 0n).toString(), charges: suyos.map((c) => c.chargeId),
              lostOn: day.toISOString().slice(0, 10), lostDebtDays,
            },
            reason: motivo,
          });
          return suyos;
        });
        result.skipped += cargos.length - hechos.length;
        if (hechos.length === 0) continue;
        const importe = hechos.reduce((a, c) => a + c.balanceCents, 0n);
        result.processed += hechos.length;
        total += importe;
        socios.add(memberId);
      } catch (error) {
        result.errors.push({ entityId: memberId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  result.truncated = result.batches >= MAX_LOTES;

  if (result.processed > 0) {
    await audit.record(ctx, {
      action: 'billing.debt.lost.summary', resourceType: 'Organization', resourceId: organizationId,
      afterState: {
        amountCents: total.toString(), charges: result.processed, members: socios.size,
        lostOn: day.toISOString().slice(0, 10), lostDebtDays, firstRun: primera,
      },
      reason: primera
        ? `Primera corrida: toda la deuda de membresías que ya habían terminado tras ${lostDebtDays} días suspendidas sale de «Por cobrar». No se borra: sigue en el estado de cuenta de cada socio y se puede cobrar`
        : `Deuda de membresías que cumplieron ${lostDebtDays} días suspendidas: sale de «Por cobrar». No se borra: sigue en el estado de cuenta de cada socio y se puede cobrar`,
    });
  }
  return result;
};
