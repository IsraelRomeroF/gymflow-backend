import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OWNER_ALERT_CATALOG, OWNER_ALERT_KINDS, OWNER_ALERTS_ALWAYS, esOwnerAlertKind, forbidden, semanaDelResumen } from '@gymflow/core';
import { OwnerAlertLine, OwnerAlertPreferenceSaved, OwnerAlerts, OwnerAlertsSeen, WeeklyFigures, WeeklyPerson, type OwnerAlert, type WeeklySummary } from '@gymflow/core/contracts';
import { AuditService } from '../../platform/audit/audit.service.js';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { OwnerAlertRepository, type OwnerAlertRecord } from './owner-alert.repository.js';
import { OwnerAlertsService } from './owner-alerts.service.js';

const DIA = 86_400_000;
/** Cuánto tiempo se queda en la lista un aviso ya visto. */
const DIAS_EN_LA_LISTA = 30;

const lineas = (detalle: unknown): OwnerAlert['lines'] => {
  const r = z.object({ lines: z.array(OwnerAlertLine) }).safeParse(detalle);
  return r.success ? r.data.lines : [];
};

function serializarAviso(a: OwnerAlertRecord): OwnerAlert | null {
  if (!esOwnerAlertKind(a.kind)) return null;
  return {
    id: a.id, kind: a.kind, title: a.title, body: a.body, url: a.url, branchId: a.branchId, lines: lineas(a.detail),
    occurredAt: a.occurredAt.toISOString(), pushDevices: a.pushDevices, seen: a.seenAt !== null,
  };
}

const DetalleDelResumen = z.object({ from: z.string(), to: z.string(), figures: WeeklyFigures, people: z.array(WeeklyPerson) });

function serializarResumen(a: OwnerAlertRecord): WeeklySummary | null {
  const d = DetalleDelResumen.safeParse(a.detail);
  if (!d.success) return null;
  return { id: a.id, from: d.data.from, to: d.data.to, title: a.title, body: a.body, figures: d.data.figures, people: d.data.people, createdAt: a.createdAt.toISOString(), seen: a.seenAt !== null };
}

/**
 * LOS AVISOS DE LA DUEÑA DENTRO DEL PANEL (bloque 4.2; D-05). Todo lo que
 * suena en su teléfono existe también aquí, porque sin llaves o sin dirección
 * fija el teléfono no suena.
 *
 * Son rutas de sesión y SOLO para el puesto Dueño (ni la gerencia ni el
 * apoderado: el apoderado solo da la segunda firma). No dependen de un
 * permiso que se pueda encender por persona: se pregunta por el puesto. A
 * quien no es dueña le responden `visible: false` y nada más, para que el
 * panel pueda preguntar siempre sin que salte un error.
 */
export function registerAlertRoutes(app: FastifyInstance): void {
  const servicio = new OwnerAlertsService();
  const audit = new AuditService();

  const vacia = (): OwnerAlerts => ({ visible: false, pushConfigured: false, devices: 0, unseen: 0, alerts: [], summaries: [], nextSummaryAt: null, preferences: [], always: [] });

  route(app, {
    method: 'GET',
    url: '/owner-alerts',
    security: { kind: 'session' },
    schema: respuesta(200, OwnerAlerts),
    handler: async (request): Promise<OwnerAlerts> => {
      const { organizationId, actorUserId } = request.ctx!.tenant;
      const repo = new OwnerAlertRepository(organizationId);
      if (!actorUserId || !(await repo.esDueno(actorUserId))) return vacia();
      const ahora = new Date();
      const [avisos, resumenes, sinVer, preferencias, telefono, zona] = await Promise.all([
        repo.recientes(new Date(ahora.getTime() - DIAS_EN_LA_LISTA * DIA)), repo.resumenes(), repo.sinVer(),
        servicio.preferencias(actorUserId), servicio.telefono(actorUserId), new BusinessCalendar(organizationId).timezoneFor(null),
      ]);
      // El próximo lunes a las 7:00 del gimnasio: el que toca ahora ya pasó, así que es el siguiente.
      const proximo = semanaDelResumen(zona, new Date(semanaDelResumen(zona, ahora).dueAt.getTime() + 7 * DIA + 6 * 3_600_000));
      return {
        visible: true, ...telefono, unseen: sinVer,
        alerts: avisos.map(serializarAviso).filter((a): a is OwnerAlert => a !== null),
        summaries: resumenes.map(serializarResumen).filter((s): s is WeeklySummary => s !== null),
        nextSummaryAt: proximo.dueAt.toISOString(),
        preferences: preferencias, always: OWNER_ALERTS_ALWAYS.map((a) => ({ ...a })),
      };
    },
  });

  /** La dueña tiene los avisos a la vista: dejan de contar como nuevos. */
  route(app, {
    method: 'POST',
    url: '/owner-alerts/seen',
    security: { kind: 'session' },
    schema: respuesta(200, OwnerAlertsSeen),
    handler: async (request): Promise<OwnerAlertsSeen> => {
      const { organizationId, actorUserId } = request.ctx!.tenant;
      const repo = new OwnerAlertRepository(organizationId);
      if (!actorUserId || !(await repo.esDueno(actorUserId))) return { seen: 0 };
      return { seen: await repo.marcarVistos(actorUserId, new Date()) };
    },
  });

  /**
   * Encender o apagar UN tipo de aviso en su teléfono (D-05: «cada aviso se
   * puede apagar»). Apagado, el aviso sigue saliendo dentro del panel. Queda
   * en la bitácora: que la dueña deje de enterarse de algo es un cambio que
   * debe poder verse después.
   */
  route(app, {
    method: 'PUT',
    url: '/owner-alerts/preferences',
    security: { kind: 'session' },
    schema: respuesta(200, OwnerAlertPreferenceSaved),
    handler: async (request): Promise<OwnerAlertPreferenceSaved> => {
      const ctx = request.ctx!;
      const { organizationId, actorUserId } = ctx.tenant;
      const body = z.object({ kind: z.enum(OWNER_ALERT_KINDS), enabled: z.boolean() }).parse(request.body);
      if (!actorUserId || !(await new OwnerAlertRepository(organizationId).esDueno(actorUserId))) {
        throw forbidden('Los avisos al teléfono de la dueña solo los ajusta la dueña.');
      }
      const cambio = await servicio.guardarPreferencia(organizationId, actorUserId, body.kind, body.enabled);
      if (cambio) {
        await audit.record(ctx, {
          action: body.enabled ? 'settings.owner_alert.on' : 'settings.owner_alert.off', resourceType: 'User', resourceId: actorUserId,
          afterState: { kind: body.kind, label: OWNER_ALERT_CATALOG[body.kind].label, enabled: body.enabled },
        });
      }
      return { kind: body.kind, enabled: body.enabled };
    },
  });
}
