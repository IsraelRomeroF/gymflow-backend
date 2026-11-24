import { masDias, semanaDelResumen, textoDelResumen } from '@gymflow/core';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { WeeklyService } from '../analytics/index.js';
import { OwnerAlertRepository } from './owner-alert.repository.js';
import { OwnerAlertsService } from './owner-alerts.service.js';

export type PasadaDelResumen = {
  /** `sent`: se armó y se mandó. Lo demás dice por qué no (`first-run`: el escaneo todavía no ha corrido en este gimnasio). */
  estado: 'sent' | 'already' | 'before-start' | 'first-run';
  /** El lunes al que corresponde. */
  monday: string;
  equipos: number;
};

/**
 * `alerts.weekly-summary` · EL RESUMEN DEL LUNES A LAS 7:00 (bloque 4.2; D-05 c).
 *
 * Corre con el corredor de 15 minutos y casi siempre no hace nada: solo actúa
 * la primera vez que lo encuentra pasado el lunes a las 7:00, HORA DEL
 * GIMNASIO (la zona de la organización), y resume la semana anterior de lunes
 * a domingo. Uno por lunes: la llave es el lunes, así que repetir la corrida
 * no lo manda otra vez. Si la computadora estaba apagada el lunes a las 7, sale
 * al encenderla (el título dice de qué semana es).
 *
 * EN UNA BASE EN USO no manda de golpe un resumen viejo: el primero es el del
 * primer lunes a las 7:00 que llegue DESPUÉS de que los avisos arrancaron en
 * ese gimnasio (`owner_alert_starts`).
 */
export class WeeklySummaryService {
  constructor(private readonly avisos: OwnerAlertsService = new OwnerAlertsService()) {}

  async pasada(organizationId: string, ahora: Date = new Date()): Promise<PasadaDelResumen> {
    const repo = new OwnerAlertRepository(organizationId);
    const zona = await new BusinessCalendar(organizationId).timezoneFor(null);
    const semana = semanaDelResumen(zona, ahora);
    // El arranque lo fija SOLO el escaneo (que corre antes): si lo fijara el resumen, el escaneo
    // siguiente ya no sería «la primera corrida» y haría sonar de golpe lo que estaba pendiente.
    const startedAt = await repo.arranque();
    if (!startedAt) return { estado: 'first-run', monday: semana.monday, equipos: 0 };
    if (semana.dueAt.getTime() < startedAt.getTime()) return { estado: 'before-start', monday: semana.monday, equipos: 0 };
    const llave = `weekly:${semana.monday}`;
    if ((await repo.yaAvisadas([llave])).has(llave)) return { estado: 'already', monday: semana.monday, equipos: 0 };

    const { figures, people } = await new WeeklyService().semana(organizationId, semana, zona, ahora);
    const dado = await this.avisos.dar(organizationId, {
      kind: 'WEEKLY_SUMMARY', dedupeKey: llave, occurredAt: semana.dueAt, silent: false,
      ...textoDelResumen(semana, figures),
      detail: { from: semana.from, to: masDias(semana.to, -1), figures, people },
    }, ahora);
    return { estado: dado.creado ? 'sent' : 'already', monday: semana.monday, equipos: dado.equipos };
  }
}
