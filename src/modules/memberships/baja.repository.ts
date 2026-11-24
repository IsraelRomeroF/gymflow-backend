import { bajaDelSocio, type BajaDelSocio } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * «ESTÁ DE BAJA DESDE» (D-18; fase 4, bloque 4.4).
 *
 * D-18: es baja quien canceló su membresía, o quien lleva el plazo del
 * gimnasio (30 días) con la membresía terminada sin renovar; y, como siempre,
 * a quien dieron de baja en su ficha. Nadie guarda ese dato: se CALCULA aquí,
 * con la regla del núcleo (`bajaDelSocio`), para que el Inicio, Retención y la
 * ficha cuenten lo mismo.
 *
 * Esta consulta solo trae los HECHOS de cada socio (cuándo lo dieron de baja
 * en su ficha, si tiene una membresía sin terminar y cuál fue la última que
 * terminó); la regla no está escrita en SQL.
 *
 * Qué membresías cuentan como «la última que terminó»:
 *  - Las canceladas o terminadas, menos las de visita suelta (un pase del día
 *    que venció no es una baja).
 *  - Menos la venta que NUNCA se cobró (pasó de «por activar» a cancelada):
 *    por ella no fue socio.
 * El día en que terminó es el día de operación de su evento (`businessDate`);
 * si no hay evento (membresías importadas), el de `endedAt` en la zona de su
 * sede.
 */
export type HechosDeBaja = {
  memberId: string;
  memberCode: string;
  fullName: string;
  phoneE164: string | null;
  homeBranchId: string | null;
  anonymized: boolean;
  /** `AAAA-MM-DD`, o null si nadie lo dio de baja en su ficha. */
  archivedOn: string | null;
  hasLive: boolean;
  lastStatus: 'CANCELED' | 'EXPIRED' | null;
  lastEndedOn: string | null;
  lastPlanName: string | null;
  lastReason: string | null;
};

export type SocioConBaja = HechosDeBaja & { baja: BajaDelSocio | null };

/** Las membresías «sin terminar»: mientras tenga una, no es baja (aunque deba o esté suspendida). */
const SIN_TERMINAR = `('PENDING','TRIALING','ACTIVE','PAST_DUE','FROZEN','SUSPENDED')`;

const dia = (d: Date): string => d.toISOString().slice(0, 10);

type Fila = Omit<HechosDeBaja, 'archivedOn' | 'lastEndedOn' | 'lastStatus'> & { archivedOn: Date | null; lastEndedOn: Date | null; lastStatus: string | null };

export class BajaRepository extends TenantRepository {
  /**
   * Los hechos de baja de los socios pedidos (`memberIds`) o de los
   * candidatos a haber quedado de baja desde `desde` (día de calendario): los
   * dados de baja en su ficha desde entonces y los que tienen una membresía
   * terminada desde `desde − churnDays`. Con `branchId`, solo los de esa sede
   * de casa.
   */
  async hechos(opts: { memberIds?: readonly string[]; desde?: Date; churnDays: number; branchId?: string | null }): Promise<HechosDeBaja[]> {
    if (opts.memberIds && opts.memberIds.length === 0) return [];
    const params: unknown[] = [this.organizationId];
    let candidatos: string;
    if (opts.memberIds) {
      params.push([...opts.memberIds]);
      candidatos = 'SELECT unnest($2::uuid[]) AS "id"';
    } else {
      // Dos días de margen por la zona horaria; la regla exacta se aplica después, con el día de la sede.
      params.push(opts.desde ?? new Date(0), opts.churnDays + 2);
      candidatos = `
        SELECT m0."id" FROM "members" m0
         WHERE m0."organizationId" = $1::uuid AND m0."deletedAt" >= $2::date - 2
        UNION
        SELECT ms0."memberId" FROM "memberships" ms0
         WHERE ms0."organizationId" = $1::uuid AND ms0."status" IN ('CANCELED','EXPIRED')
           AND COALESCE(ms0."endedAt", ms0."canceledAt", ms0."updatedAt") >= $2::date - $3::int`;
    }
    let filtroSede = '';
    if (opts.branchId) { params.push(opts.branchId); filtroSede = `AND m."homeBranchId" = $${params.length}::uuid`; }

    const filas = await this.db.$queryRawUnsafe<Fila[]>(`
      WITH cand AS (${candidatos})
      SELECT m."id" AS "memberId", m."memberCode", m."firstName" || ' ' || m."lastName" AS "fullName",
             m."phoneE164", m."homeBranchId", (m."anonymizedAt" IS NOT NULL) AS "anonymized",
             (m."deletedAt" AT TIME ZONE COALESCE(hb."timezone", o."timezone"))::date AS "archivedOn",
             EXISTS (SELECT 1 FROM "memberships" v WHERE v."organizationId" = $1::uuid AND v."memberId" = m."id" AND v."status" IN ${SIN_TERMINAR}) AS "hasLive",
             u."status"::text AS "lastStatus", u."endedOn" AS "lastEndedOn", u."planName" AS "lastPlanName", u."cancellationReason" AS "lastReason"
        FROM cand
        JOIN "members" m ON m."id" = cand."id" AND m."organizationId" = $1::uuid
        JOIN "organizations" o ON o."id" = m."organizationId"
        LEFT JOIN "branches" hb ON hb."id" = m."homeBranchId"
        LEFT JOIN LATERAL (
          SELECT ms."status", ms."cancellationReason", p."name" AS "planName", ms."createdAt",
                 COALESCE(
                   (SELECT e."businessDate" FROM "membership_events" e
                     WHERE e."organizationId" = $1::uuid AND e."membershipId" = ms."id" AND e."toStatus" = ms."status"
                     ORDER BY e."at" DESC LIMIT 1),
                   (COALESCE(ms."endedAt", ms."canceledAt", ms."updatedAt") AT TIME ZONE COALESCE(hb."timezone", o."timezone"))::date
                 ) AS "endedOn"
            FROM "memberships" ms
            JOIN "plans" p ON p."id" = ms."planId"
           WHERE ms."organizationId" = $1::uuid AND ms."memberId" = m."id"
             AND ms."status" IN ('CANCELED','EXPIRED') AND p."billingModel" <> 'DAY_PASS'
             AND NOT EXISTS (SELECT 1 FROM "membership_events" e0
                              WHERE e0."organizationId" = $1::uuid AND e0."membershipId" = ms."id"
                                AND e0."fromStatus" = 'PENDING' AND e0."toStatus" = 'CANCELED')
           ORDER BY 5 DESC, ms."createdAt" DESC
           LIMIT 1
        ) u ON true
       WHERE true ${filtroSede}
       ORDER BY m."id"`, ...params);

    return filas.map((f) => ({
      ...f,
      lastStatus: f.lastStatus as HechosDeBaja['lastStatus'],
      archivedOn: f.archivedOn ? dia(f.archivedOn) : null,
      lastEndedOn: f.lastEndedOn ? dia(f.lastEndedOn) : null,
    }));
  }

  /** Los mismos socios, con la regla del núcleo aplicada al día `today`. */
  async conBaja(opts: { memberIds?: readonly string[]; desde?: Date; churnDays: number; branchId?: string | null; today: Date }): Promise<SocioConBaja[]> {
    const hoy = dia(opts.today);
    return (await this.hechos(opts)).map((h) => ({ ...h, baja: bajaDeLosHechos(h, hoy, opts.churnDays) }));
  }

  /**
   * Cuántos quedaron de baja en `[desde, hasta)` (días de calendario), por
   * sede de casa. Es la cifra «se dieron de baja» del Inicio: cuenta el acto
   * de la ficha, la cancelación y la membresía que cumplió el plazo sin
   * renovar, cada socio una vez y en el día en que empezó su baja.
   */
  async bajasEntre(desde: Date, hasta: Date, churnDays: number): Promise<Array<{ branchId: string | null; total: number }>> {
    // «Hoy» es el último día de la ventana: una membresía terminada cuyo plazo aún no llega no cuenta.
    const hoy = new Date(hasta.getTime() - 86_400_000);
    const socios = await this.conBaja({ desde, churnDays, today: hoy });
    const porSede = new Map<string | null, number>();
    for (const s of socios) {
      if (!s.baja || s.baja.since < dia(desde) || s.baja.since >= dia(hasta)) continue;
      porSede.set(s.homeBranchId, (porSede.get(s.homeBranchId) ?? 0) + 1);
    }
    return [...porSede].map(([branchId, total]) => ({ branchId, total }));
  }

  /** Lo que un socio debe y ya se dio por perdido (D-18): cobrable, fuera de «Por cobrar». */
  async deudaPerdidaDe(memberId: string): Promise<bigint> {
    const [r] = await this.db.$queryRaw<Array<{ total: bigint }>>`
      SELECT COALESCE(SUM(c."amountCents" - c."allocatedCents" - c."adjustedCents"), 0)::bigint AS total
        FROM "charges" c
       WHERE c."organizationId" = ${this.organizationId}::uuid AND c."memberId" = ${memberId}::uuid
         AND c."status" IN ('OPEN','PARTIALLY_PAID','OVERDUE') AND c."lostOn" IS NOT NULL`;
    return r?.total ?? 0n;
  }
}

/** La regla del núcleo sobre los hechos de la consulta. */
export function bajaDeLosHechos(h: Pick<HechosDeBaja, 'archivedOn' | 'hasLive' | 'lastStatus' | 'lastEndedOn'>, today: string, churnDays: number): BajaDelSocio | null {
  return bajaDelSocio({
    archivedOn: h.archivedOn,
    hasLiveMembership: h.hasLive,
    lastEnded: h.lastStatus && h.lastEndedOn ? { status: h.lastStatus, endedOn: h.lastEndedOn } : null,
    today, churnDays,
  });
}
