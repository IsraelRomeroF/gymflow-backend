import type { FastifyInstance } from 'fastify';
import { GymflowAccount, GymflowAccountSeen } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { DIAS_PARA_SUSPENDER } from './cobranza-reglas.js';
import { PlatformCollectionsService } from './cobranza.service.js';
import { PlatformBillingService } from './platform-billing.service.js';
import { PlatformNoticeRepository } from './platform-notice.repository.js';

/**
 * LA CUENTA DEL GIMNASIO CON GYMFLOW, vista desde el panel (D-37, bloque 3.11;
 * 23-11). Solo consulta y solo para el DUEÑO: lo que debe, cuándo vence, si
 * el servicio se va a suspender y los avisos que GymFlow le ha dado. Desde
 * aquí no se paga ni se cambia nada.
 *
 * Son rutas de sesión (no de plataforma): leen SOLO la marca de quien entra.
 * A quien no es dueño le responden `visible: false`, sin cifras: el panel
 * puede preguntar siempre sin que salte un error.
 */
export function registerGymAccountRoutes(app: FastifyInstance): void {
  const cobro = new PlatformBillingService();
  const cobranza = new PlatformCollectionsService();
  const avisos = new PlatformNoticeRepository();

  const vacia = (): GymflowAccount => ({
    visible: false, serviceStatus: 'ACTIVE', status: { code: 'SIN_COBRO', overdueDays: 0, pendingCents: '0' }, suspendsOn: null, suspendsAfterDays: DIAS_PARA_SUSPENDER,
    monthly: { lines: [], totalCents: '0' }, upcoming: null, invoices: [], notices: [],
  });

  route(app, {
    method: 'GET',
    url: '/gymflow-account',
    security: { kind: 'session' },
    schema: respuesta(200, GymflowAccount),
    handler: async (request): Promise<GymflowAccount> => {
      const { organizationId, actorUserId } = request.ctx!.tenant;
      if (!actorUserId || !(await avisos.esDueno(organizationId, actorUserId))) return vacia();
      const [resumen, suya, abiertos] = await Promise.all([cobro.resumen(organizationId), cobranza.deMarca(organizationId), avisos.abiertosDeMarca(organizationId)]);
      return {
        visible: true,
        serviceStatus: resumen.serviceStatus as GymflowAccount['serviceStatus'],
        status: resumen.status,
        suspendsOn: suya.collections.suspendsOn, suspendsAfterDays: DIAS_PARA_SUSPENDER,
        monthly: { lines: resumen.monthly.lines, totalCents: resumen.monthly.totalCents },
        upcoming: resumen.upcoming ? { effectiveFrom: resumen.upcoming.effectiveFrom, totalCents: resumen.upcoming.totalCents } : null,
        // Las anuladas no son cosa del dueño: solo lo que se le cobró o se le cobra.
        invoices: resumen.invoices.filter((f) => f.state !== 'ANULADA').slice(0, 12).map((f) => ({
          id: f.id, folio: f.folio, periodStart: f.periodStart, dueDate: f.dueDate, totalCents: f.totalCents, balanceCents: f.balanceCents, state: f.state, overdueDays: f.overdueDays,
        })),
        notices: abiertos.map((a) => ({ id: a.id, kind: a.kind as GymflowAccount['notices'][number]['kind'], title: a.title, body: a.body, noticeOn: a.noticeOn.toISOString().slice(0, 10), seen: a.seenAt !== null })),
      };
    },
  });

  /**
   * El panel avisa que el dueño TIENE A LA VISTA los avisos abiertos. Es la
   * constancia de entrega que cuenta para la suspensión automática: queda con
   * quién y cuándo, en la bitácora de la marca.
   */
  route(app, {
    method: 'POST',
    url: '/gymflow-account/seen',
    security: { kind: 'session' },
    schema: respuesta(200, GymflowAccountSeen),
    handler: async (request): Promise<GymflowAccountSeen> => {
      const { organizationId, actorUserId } = request.ctx!.tenant;
      if (!actorUserId || !(await avisos.esDueno(organizationId, actorUserId))) return { seen: 0 };
      return { seen: await cobranza.marcarVistos(organizationId, actorUserId) };
    },
  });
}
