import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { CashSessionRepository, type CajaAbierta, type DescuadresPorRevisar } from './cash.repository.js';

/** Una caja abierta y si amaneció sin cortar. */
export type CajaSinCortar = CajaAbierta & {
  /** Se abrió en un día de negocio ANTERIOR al de hoy de su sede: nadie la cortó al cerrar. */
  stale: boolean;
};

/**
 * LO QUE LA CAJA TIENE SIN RESOLVER (D-17; fase 4, bloque 4.3): cajas que
 * siguen abiertas —y cuáles amanecieron sin cortar— y cortes con más de $20 de
 * diferencia que la gerencia no ha revisado.
 *
 * Solo lee. Es el dato de tres avisos, que no vuelven a calcularlo:
 *  · la vista «Cortes» de la dueña y la pantalla de Caja (`GET /cash/alerts`);
 *  · «Hoy te toca» de la gerencia (`analytics/home.routes.ts`, asunto `variances`);
 *  · el aviso al teléfono de la dueña y el resumen del lunes (bloque 4.2), que
 *    llaman a estas dos funciones con `sedes = null` (todo el gimnasio).
 *
 * «Hoy» es el día de negocio de CADA sede (dos sedes en zonas distintas no
 * cambian de día a la misma hora), nunca la fecha del servidor.
 */
export class CashAlertsService {
  /** Las cajas abiertas, la más vieja primero. `sedes` nulo = todo el gimnasio. */
  async open(organizationId: string, sedes: readonly string[] | null): Promise<CajaSinCortar[]> {
    const abiertas = await new CashSessionRepository(organizationId).openWithNames(sedes);
    if (abiertas.length === 0) return [];
    const calendario = new BusinessCalendar(organizationId);
    const hoyPorSede = new Map<string, Date>();
    for (const id of new Set(abiertas.map((a) => a.branchId))) hoyPorSede.set(id, await calendario.today(id));
    return abiertas.map((a) => ({ ...a, stale: a.businessDate.getTime() < hoyPorSede.get(a.branchId)!.getTime() }));
  }

  /** Solo las que amanecieron sin cortar: lo que se avisa. */
  async unclosed(organizationId: string, sedes: readonly string[] | null): Promise<CajaSinCortar[]> {
    return (await this.open(organizationId, sedes)).filter((a) => a.stale);
  }

  /** Los cortes «por revisar»: cuántos, cuánto falta, cuánto sobra y desde cuándo. */
  async pendingVariances(organizationId: string, sedes: readonly string[] | null): Promise<DescuadresPorRevisar> {
    return new CashSessionRepository(organizationId).pendingVariances(sedes);
  }
}
