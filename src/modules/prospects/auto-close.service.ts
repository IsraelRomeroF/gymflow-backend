import {
  PROSPECT_AUTO_CLOSE_CODE, PROSPECT_AUTO_CLOSE_DAYS, PROSPECT_AUTO_CLOSE_NOTICE_DAYS, businessDateIn,
  prospectAutoCloseOn, prospectAutoCloseReason, prospectClosesSoon,
} from '@gymflow/core';
import type { ProspectAutoClose } from '@gymflow/core/contracts';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { systemContext } from '../../platform/jobs/types.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { ProspectRepository } from './prospect.repository.js';
import { actividadDe } from './prospects.service.js';

const MS_DIA = 86_400_000;
const dia = (d: Date): string => d.toISOString().slice(0, 10);

/** Cuántos interesados cierra una corrida como mucho; lo que no quepa queda para la siguiente noche. */
const LOTE = 500;
/** Cuántos candidatos lee la vista previa como mucho (cuenta, no cierra). */
const TOPE_DE_VISTA = 5000;

export type PasadaDeCierre = {
  /** Esta corrida fijó desde qué día cierra el gimnasio: no cerró a nadie. */
  arranco: boolean;
  startsOn: string;
  /** Cerrados en esta corrida. */
  cerrados: number;
  /** Ya cumplieron el plazo y siguen abiertos: el gimnasio aún no cierra, o alguien los tocó mientras corría. */
  enEspera: number;
  truncated: boolean;
  errores: Array<{ entityId: string; error: string }>;
};

/**
 * EL CIERRE SOLO DE INTERESADOS (D-31, bloque 4.7).
 *
 * Un interesado abierto que lleva 60 días sin contacto ni fecha pendiente se
 * cierra solo, y se puede reabrir. La regla es del núcleo
 * (`prospectAutoCloseOn`); aquí se decide con el «hoy» de la SEDE de cada
 * interesado y se asienta cada cierre en la bitácora, a nombre del sistema.
 *
 * NO EMPIEZA DE GOLPE. En una base en uso, la primera corrida encontraría a
 * todos los interesados viejos y recepción amanecería con la lista vacía. Por
 * eso la primera corrida en un gimnasio no cierra a nadie: guarda desde qué
 * día cierra (`PROSPECT_AUTO_CLOSE_NOTICE_DAYS` después; ese mismo día si no
 * hay nadie que cerrar) y lo asienta con la cuenta de cuántos serían. Mientras
 * tanto, Prospectos lo avisa arriba de la bandeja y cada fila dice cuándo se
 * cierra sola. Contactarlos o ponerles fecha los saca de la cuenta.
 */
export class ProspectAutoCloseService {
  private readonly audit = new AuditService();

  /** Los candidatos con su día de cierre y el «hoy» de su sede. */
  private async candidatos(organizationId: string, at: Date, opts: { margenDias: number; branchIds?: readonly string[] | null | undefined; limit: number }) {
    const repo = new ProspectRepository(organizationId);
    const calendario = new BusinessCalendar(organizationId);
    // Filtro grueso, con un día de holgura por las zonas: la regla exacta va abajo, por sede.
    const antes = new Date(at.getTime() - (PROSPECT_AUTO_CLOSE_DAYS - opts.margenDias - 1) * MS_DIA);
    const filas = await repo.autoCloseCandidates({ antes, branchIds: opts.branchIds, limit: opts.limit });
    const zonas = new Map<string, string>();
    for (const id of new Set(filas.map((f) => f.branchId))) zonas.set(id, await calendario.timezoneFor(id));
    return filas.map((p) => {
      const zona = zonas.get(p.branchId)!;
      return { p, hoy: dia(businessDateIn(zona, at)), cierraEl: prospectAutoCloseOn(actividadDe(p, zona)) };
    });
  }

  /**
   * Lo que el panel enseña ANTES de que pase: cuántos ya cumplieron el plazo
   * y cuántos lo cumplen en los próximos días, de las sedes de quien pregunta.
   * Solo lee.
   */
  async vistaPrevia(organizationId: string, branchIds: readonly string[] | null, at: Date = new Date()): Promise<ProspectAutoClose> {
    const inicio = await new ProspectRepository(organizationId).autoCloseStart();
    const hoyDelGimnasio = dia(await new BusinessCalendar(organizationId).today(null, at));
    let due = 0;
    let soon = 0;
    for (const c of await this.candidatos(organizationId, at, { margenDias: PROSPECT_AUTO_CLOSE_NOTICE_DAYS, branchIds, limit: TOPE_DE_VISTA })) {
      if (c.cierraEl <= c.hoy) due += 1;
      else if (prospectClosesSoon(c.cierraEl, c.hoy)) soon += 1;
    }
    const startsOn = inicio ? dia(inicio) : null;
    return {
      days: PROSPECT_AUTO_CLOSE_DAYS, noticeDays: PROSPECT_AUTO_CLOSE_NOTICE_DAYS,
      startsOn, active: startsOn !== null && startsOn <= hoyDelGimnasio, due, soon,
    };
  }

  /** Una pasada del cierre de la noche por un gimnasio. Se puede correr dos veces el mismo día sin daño. */
  async pasada(organizationId: string, at: Date = new Date()): Promise<PasadaDeCierre> {
    const repo = new ProspectRepository(organizationId);
    const ctx = systemContext(organizationId);
    const candidatos = await this.candidatos(organizationId, at, { margenDias: 0, limit: LOTE + 1 });
    const vencidos = candidatos.filter((c) => c.cierraEl <= c.hoy);

    // Primera corrida en este gimnasio: solo se fija el día de arranque.
    const inicio = await repo.autoCloseStart();
    if (!inicio) {
      const hoy = await new BusinessCalendar(organizationId).today(null, at);
      // Sin nadie que cerrar no hay a quién sorprender: empieza hoy mismo.
      const desde = vencidos.length > 0 ? new Date(hoy.getTime() + PROSPECT_AUTO_CLOSE_NOTICE_DAYS * MS_DIA) : hoy;
      const fijado = await enUnaTransaccion(async () => {
        if (!await repo.startAutoClose(desde)) return false;
        await this.audit.record(ctx, {
          action: 'prospect.auto_close.start', resourceType: 'Organization', resourceId: organizationId,
          afterState: { startsOn: dia(desde), days: PROSPECT_AUTO_CLOSE_DAYS, wouldClose: Math.min(vencidos.length, LOTE), more: vencidos.length > LOTE },
        });
        return true;
      });
      if (fijado) return { arranco: true, startsOn: dia(desde), cerrados: 0, enEspera: Math.min(vencidos.length, LOTE), truncated: false, errores: [] };
    }
    const startsOn = dia((await repo.autoCloseStart())!);

    const salida: PasadaDeCierre = { arranco: false, startsOn, cerrados: 0, enEspera: 0, truncated: vencidos.length > LOTE, errores: [] };
    const motivo = prospectAutoCloseReason();
    for (const { p, hoy } of vencidos.slice(0, LOTE)) {
      // El arranque se compara con el día de SU sede: una sede atrasada no cierra antes de tiempo.
      if (hoy < startsOn) { salida.enEspera += 1; continue; }
      try {
        const cerrado = await enUnaTransaccion(async () => {
          if (!await repo.closeByItself(p.id, { reasonCode: PROSPECT_AUTO_CLOSE_CODE, reason: motivo, updatedAt: p.updatedAt })) return false;
          await this.audit.record(ctx, {
            action: 'prospect.auto_close', resourceType: 'Prospect', resourceId: p.id, branchId: p.branchId,
            beforeState: { status: p.status }, afterState: { status: 'LOST', reasonCode: PROSPECT_AUTO_CLOSE_CODE, days: PROSPECT_AUTO_CLOSE_DAYS }, reason: motivo,
          });
          return true;
        });
        if (cerrado) salida.cerrados += 1; else salida.enEspera += 1;
      } catch (error) {
        salida.errores.push({ entityId: p.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return salida;
  }
}
