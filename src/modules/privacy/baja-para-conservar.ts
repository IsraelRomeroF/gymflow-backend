import { arranqueDeLaBaja, bajaParaConservar, businessDateIn, isoDate, rostroSeBorraEl, type BajaParaConservar, type CausaDeBaja } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { plazosDe } from '../../platform/plazos/plazos-del-socio.repository.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { FaceTemplateRepository } from '../access/index.js';
import { BajaRepository, bajaDeLosHechos, type HechosDeBaja } from '../memberships/index.js';

/**
 * LA BAJA PARA LA CONSERVACIÓN (P-01, Israel 2026-11-25; fase 4, bloque 4.18).
 *
 * Hasta 4.18 la conservación (D-32) solo contaba el acto «Dar de baja». Desde
 * aquí cuenta también la baja calculada de D-18 (`BajaRepository`): canceló
 * su membresía, o la tiene terminada el plazo del gimnasio sin renovar. La
 * regla, con su excepción (quien sigue viniendo sin membresía), es del núcleo:
 * `bajaParaConservar`. Aquí solo se juntan los hechos:
 *
 *  · la baja de D-18 de cada socio (`BajaRepository.hechos`);
 *  · su última ENTRADA REGISTRADA, sea como sea que haya entrado: una
 *    asistencia en la puerta (`attendance_events`, que cubre la visita
 *    suelta, el pase del día y el paquete), un pase del día cobrado, un
 *    paquete comprado o una clase a la que llegó;
 *  · si tiene un paquete de visitas vivo (activo o congelado, sin caducar); y
 *    el día en que caducó su último paquete cuenta como su última visita.
 *
 * Solo LEE. Las tablas de otros módulos se leen aquí con SQL de solo lectura,
 * como la descarga ARCO de `privacy.service.ts`.
 */

type FilaDeActividad = { memberId: string; ultimaEntrada: Date | null; paqueteSinCaducidad: boolean; paqueteHasta: Date | null; paqueteVencio: Date | null };

export type Actividad = {
  ultimaEntrada: string | null;
  /** Hasta cuándo vale su paquete vivo (activo o congelado), o `SIN_CADUCIDAD`, o null si no tiene. */
  paqueteVivoHasta: string | 'SIN_CADUCIDAD' | null;
  /** El último día de caducidad de un paquete (vivo o ya caducado): mientras valió, pudo venir. */
  paqueteVencio: string | null;
};

export class BajaParaConservarRepository extends TenantRepository {
  // ── El arranque de la baja calculada ──────────────────────────────────────

  async arranqueCalculada(): Promise<Date | null> {
    const fila = await this.db.privacyCalculatedBajaStart.findFirst({ where: this.scope({}), select: { startedOn: true } });
    return fila?.startedOn ?? null;
  }

  /** Fija el día de arranque de la baja calculada si no lo había. `true` solo la vez que lo fijó. */
  async fijarArranqueCalculada(dia: Date): Promise<boolean> {
    const { count } = await this.db.privacyCalculatedBajaStart.createMany({
      data: [{ organizationId: this.organizationId, startedOn: dia }], skipDuplicates: true,
    });
    return count > 0;
  }

  // ── La actividad sin membresía ────────────────────────────────────────────

  /** Última entrada registrada (día de su sede) y paquete vivo, de cada socio pedido. */
  async actividad(memberIds: readonly string[]): Promise<Map<string, Actividad>> {
    if (memberIds.length === 0) return new Map();
    const filas = await this.db.$queryRawUnsafe<FilaDeActividad[]>(`
      SELECT m."id" AS "memberId",
             GREATEST(
               (SELECT max(a."businessDate") FROM "attendance_events" a
                 WHERE a."organizationId" = $1::uuid AND a."memberId" = m."id"),
               (SELECT max(c."periodStart") FROM "charges" c
                 WHERE c."organizationId" = $1::uuid AND c."memberId" = m."id"
                   AND c."chargeType" = 'DAY_PASS' AND c."status" = 'PAID' AND c."periodStart" IS NOT NULL),
               (SELECT max(v."purchasedOn") FROM "visit_packs" v
                 WHERE v."organizationId" = $1::uuid AND v."memberId" = m."id" AND v."status" <> 'PENDING_PAYMENT'),
               (SELECT max((b."checkedInAt" AT TIME ZONE COALESCE(hb."timezone", o."timezone"))::date) FROM "class_bookings" b
                 WHERE b."organizationId" = $1::uuid AND b."memberId" = m."id" AND b."checkedInAt" IS NOT NULL)
             ) AS "ultimaEntrada",
             EXISTS (SELECT 1 FROM "visit_packs" v
                      WHERE v."organizationId" = $1::uuid AND v."memberId" = m."id"
                        AND v."status" IN ('ACTIVE','FROZEN') AND v."expiresOn" IS NULL) AS "paqueteSinCaducidad",
             (SELECT max(v."expiresOn") FROM "visit_packs" v
               WHERE v."organizationId" = $1::uuid AND v."memberId" = m."id" AND v."status" IN ('ACTIVE','FROZEN')) AS "paqueteHasta",
             (SELECT max(v."expiresOn") FROM "visit_packs" v
               WHERE v."organizationId" = $1::uuid AND v."memberId" = m."id" AND v."status" IN ('ACTIVE','FROZEN','EXPIRED')) AS "paqueteVencio"
        FROM "members" m
        JOIN "organizations" o ON o."id" = m."organizationId"
        LEFT JOIN "branches" hb ON hb."id" = m."homeBranchId"
       WHERE m."organizationId" = $1::uuid AND m."id" = ANY($2::uuid[])`, this.organizationId, [...new Set(memberIds)]);
    return new Map(filas.map((f) => [f.memberId, {
      ultimaEntrada: f.ultimaEntrada ? isoDate(f.ultimaEntrada) : null,
      paqueteVivoHasta: f.paqueteSinCaducidad ? 'SIN_CADUCIDAD' : f.paqueteHasta ? isoDate(f.paqueteHasta) : null,
      paqueteVencio: f.paqueteVencio ? isoDate(f.paqueteVencio) : null,
    }]));
  }

  /** ¿Tiene un rostro guardado (un enrolamiento sin revocar con su plantilla)? */
  async rostroGuardado(memberId: string): Promise<boolean> {
    return (await this.db.faceTemplate.count({ where: this.scope({ memberId, enrollment: { revokedAt: null } }) })) > 0;
  }

  /** Datos mínimos de las fichas (código y nombre), para la vista previa y la pantalla. */
  async fichas(memberIds: readonly string[]): Promise<Map<string, { memberCode: string; fullName: string; homeBranchId: string | null; deletedAt: Date | null; anonymizedAt: Date | null }>> {
    if (memberIds.length === 0) return new Map();
    const filas = await this.db.member.findMany({
      where: this.scope({ id: { in: [...new Set(memberIds)] } }),
      select: { id: true, memberCode: true, firstName: true, lastName: true, homeBranchId: true, deletedAt: true, anonymizedAt: true },
    });
    return new Map(filas.map((f) => [f.id, { memberCode: f.memberCode, fullName: `${f.firstName} ${f.lastName}`, homeBranchId: f.homeBranchId, deletedAt: f.deletedAt, anonymizedAt: f.anonymizedAt }]));
  }
}

/** Lo que la conservación sabe de un socio, ya con la regla aplicada. */
export type SocioParaConservar = {
  memberId: string;
  memberCode: string;
  homeBranchId: string | null;
  /** Hoy en su sede. */
  hoy: string;
  hechos: HechosDeBaja;
  actividad: Actividad;
  /** La regla del núcleo; null = no es baja ni para D-18 (o ya está anonimizado). */
  conservar: BajaParaConservar | null;
};

/** Un rostro guardado y lo que le toca. */
export type RostroParaConservar = {
  enrollmentId: string; memberId: string; memberCode: string; branchId: string;
  cause: CausaDeBaja; since: string;
  /** Null mientras no haya arranque para su clase de baja. */
  seBorraEl: string | null;
  /** ¿La pasada de hoy ya lo borra? */
  hoyToca: boolean;
};

/**
 * Junta los hechos y aplica la regla. Una instancia por pasada o por
 * petición: lee los plazos y los arranques una vez.
 */
export class BajasParaConservar {
  private readonly repo: BajaParaConservarRepository;
  private readonly calendario: BusinessCalendar;
  private zonas = new Map<string, string>();

  constructor(private readonly organizationId: string, private readonly ahora: Date = new Date()) {
    this.repo = new BajaParaConservarRepository(organizationId);
    this.calendario = new BusinessCalendar(organizationId);
  }

  async churnDays(): Promise<number> {
    return (await plazosDe(this.organizationId)).churnDays;
  }

  /** Hoy en la sede (`AAAA-MM-DD`), con el «ahora» de la instancia. */
  async hoyEn(sede: string | null): Promise<string> {
    const clave = sede ?? '';
    let zona = this.zonas.get(clave);
    if (!zona) { zona = await this.calendario.timezoneFor(sede); this.zonas.set(clave, zona); }
    return isoDate(businessDateIn(zona, this.ahora));
  }

  /** La regla aplicada a los socios pedidos (solo los que existen y no están anonimizados). */
  async de(memberIds: readonly string[]): Promise<Map<string, SocioParaConservar>> {
    const churnDays = await this.churnDays();
    return this.armar(await new BajaRepository(this.organizationId).hechos({ memberIds, churnDays }), churnDays);
  }

  /**
   * Todos los socios SIN dar de baja en su ficha y sin anonimizar cuya baja
   * calculada ya cuenta para la conservación (para la lista del mes). Los
   * dados de baja en su ficha los lista la regla de siempre (3.9).
   */
  async calculadas(): Promise<SocioParaConservar[]> {
    const churnDays = await this.churnDays();
    const hechos = (await new BajaRepository(this.organizationId).hechos({ desde: new Date(0), churnDays }))
      .filter((h) => !h.anonymized && !h.archivedOn && !h.hasLive && h.lastStatus);
    const salida: SocioParaConservar[] = [];
    for (const s of (await this.armar(hechos, churnDays)).values()) if (s.conservar?.cuenta && s.conservar.cause !== 'ARCHIVED') salida.push(s);
    return salida;
  }

  private async armar(hechos: readonly HechosDeBaja[], churnDays: number): Promise<Map<string, SocioParaConservar>> {
    const vivos = hechos.filter((h) => !h.anonymized);
    const actividad = await this.repo.actividad(vivos.map((h) => h.memberId));
    const salida = new Map<string, SocioParaConservar>();
    for (const h of vivos) {
      const hoy = await this.hoyEn(h.homeBranchId);
      const leida = actividad.get(h.memberId) ?? { ultimaEntrada: null, paqueteVivoHasta: null, paqueteVencio: null };
      const paqueteVivo = leida.paqueteVivoHasta === 'SIN_CADUCIDAD' || (leida.paqueteVivoHasta !== null && leida.paqueteVivoHasta >= hoy);
      // El día en que caducó su paquete cuenta como su última visita: mientras valió, pudo venir (decisión menor de 4.18).
      const vencio = leida.paqueteVencio !== null && leida.paqueteVencio < hoy ? leida.paqueteVencio : null;
      const ultima = [leida.ultimaEntrada, vencio].filter((d): d is string => d !== null).sort().pop() ?? null;
      const a: Actividad = { ...leida, ultimaEntrada: ultima };
      salida.set(h.memberId, {
        memberId: h.memberId, memberCode: h.memberCode, homeBranchId: h.homeBranchId, hoy, hechos: h, actividad: a,
        conservar: bajaParaConservar({ baja: bajaDeLosHechos(h, hoy, churnDays), ultimaEntrada: ultima, paqueteVivo, churnDays, today: hoy }),
      });
    }
    return salida;
  }

  /**
   * Los rostros guardados (enrolamientos sin revocar) cuyo socio es baja para
   * la conservación, con el día en que se borra cada uno. `arranques`: el de
   * 3.9 (acto de la ficha) y el de 4.18 (baja calculada). Un socio vigente,
   * o uno que sigue viniendo, no sale.
   */
  async rostros(arranques: { ficha: Date | null; calculada: Date | null }): Promise<RostroParaConservar[]> {
    const plantillas = await new FaceTemplateRepository(this.organizationId).guardadas();
    if (plantillas.length === 0) return [];
    const socios = await this.de(plantillas.map((p) => p.memberId));
    const salida: RostroParaConservar[] = [];
    for (const p of plantillas) {
      const s = socios.get(p.memberId);
      if (!s?.conservar?.cuenta) continue;
      const arranque = arranqueDeLaBaja(s.conservar.cause, arranques);
      const seBorraEl = arranque ? isoDate(rostroSeBorraEl(new Date(`${s.conservar.since}T00:00:00.000Z`), arranque)) : null;
      salida.push({
        enrollmentId: p.enrollmentId, memberId: p.memberId, memberCode: s.memberCode, branchId: p.branchId,
        cause: s.conservar.cause, since: s.conservar.since, seBorraEl, hoyToca: seBorraEl !== null && seBorraEl <= s.hoy,
      });
    }
    return salida.sort((a, b) => (a.seBorraEl ?? '9999').localeCompare(b.seBorraEl ?? '9999') || a.enrollmentId.localeCompare(b.enrollmentId));
  }
}
