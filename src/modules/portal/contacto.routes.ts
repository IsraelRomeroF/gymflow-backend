import type { FastifyInstance, FastifyRequest } from 'fastify';
import { UNLIMITED_LIMITS, mascaraDeCorreo, ultimos4 } from '@gymflow/core';
import { PortalContact } from '@gymflow/core/contracts';
import type { RequestContext } from '../../platform/context.js';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { cambiarContactoPropio, contactoPropio, contactoPropioSchema, registerContactChangeRoutes, type ContactoCambiado } from '../members/index.js';
import { PortalNotificationsService } from './notificaciones.js';
import { requireMemberSession } from './portal.routes.js';
import { cuandoSeActivo } from './portal.service.js';

/**
 * «TUS DATOS» EN EL PORTAL (auditoría 8, fase 4, bloque 4.8; D-36 c).
 *
 * El socio cambia su celular, su correo y su contacto de emergencia, directo
 * y sin aprobación. La regla completa (confirmación, topes, celular
 * compartido, asiento) es de `members/contacto-propio.ts`; aquí va lo que es
 * del portal: su sesión y el aviso a SU campana de que el celular o el correo
 * cambió, que sale también a todos sus teléfonos con notificaciones
 * encendidas. Si no fue él, así se entera, y por eso el cambio no cierra sus
 * otras sesiones: cerrárselas dejaría fuera justo al titular.
 */

/** El socio como actor del asiento: «El socio actualizó…». */
function ctxDelSocio(request: FastifyRequest, organizationId: string): RequestContext {
  return {
    requestId: request.id, ip: request.ip, userAgent: request.headers['user-agent'],
    tenant: { organizationId, actorType: 'MEMBER', grants: [], limits: UNLIMITED_LIMITS, branchScopeHint: null, requestId: request.id },
  } as RequestContext;
}

/** El aviso al propio socio: qué cambió, dicho sin repetir el dato completo. */
export function avisoDeContactoCambiado(r: Pick<ContactoCambiado, 'changes'>, cuando: string): { title: string; body: string } | null {
  const celular = r.changes.find((c) => c.field === 'PHONE');
  const correo = r.changes.find((c) => c.field === 'EMAIL');
  if (!celular && !correo) return null;
  const partes: string[] = [];
  if (celular) partes.push(`Tu celular ahora termina en ${ultimos4(celular.newValue) ?? '····'}.`);
  if (correo) partes.push(correo.newValue ? `Tu correo ahora es ${mascaraDeCorreo(correo.newValue) ?? 'otro'}.` : 'Ya no tenemos un correo tuyo.');
  return {
    title: celular && correo ? 'Tu celular y tu correo cambiaron' : celular ? 'Tu celular cambió' : 'Tu correo cambió',
    body: `${cuando}, desde el portal. ${partes.join(' ')} Si no fuiste tú, cierra la sesión en todos tus teléfonos desde Cuenta y avisa en recepción.`,
  };
}

export function registerPortalContactRoutes(app: FastifyInstance): void {
  const notificaciones = new PortalNotificationsService();
  // Lo que ve el mostrador (`GET /members/:id/contact-changes` y su «ya lo confirmé»): se montan aquí, en el módulo
  // del portal, como la invitación; su permiso (`members:portal:invite`) es de este módulo.
  registerContactChangeRoutes(app);

  /** Sus datos de contacto, con el celular y el correo enmascarados, y cuántos cambios le quedan. Contrato: `PortalContact`. */
  route(app, {
    method: 'GET',
    url: '/portal/me/contact',
    security: { kind: 'member' },
    schema: respuesta(200, PortalContact),
    handler: async (request): Promise<PortalContact> => {
      const { organizationId, memberId } = await requireMemberSession(request);
      return contactoPropio(organizationId, memberId);
    },
  });

  /**
   * Cambia lo que venga en el cuerpo (celular, correo, contacto de emergencia):
   * directo. Nada más tiene ruta aquí: nombre, nacimiento, CURP, plan y coach
   * siguen en el mostrador. El límite por red es un freno de abuso; el tope de
   * verdad es por socio y por dato (`CONTACT_CHANGE_LIMITS`).
   */
  route(app, {
    method: 'PATCH',
    url: '/portal/me/contact',
    security: { kind: 'member' },
    config: { rateLimit: { max: 120, timeWindow: '1 hour' } },
    schema: respuesta(200, PortalContact),
    handler: async (request): Promise<PortalContact> => {
      const { organizationId, memberId, sessionId } = await requireMemberSession(request);
      const body = contactoPropioSchema.parse(request.body ?? {});
      const r = await cambiarContactoPropio(ctxDelSocio(request, organizationId), memberId, body, sessionId);
      if (r.batchId) {
        const zona = await new BusinessCalendar(organizationId).timezoneFor(r.homeBranchId);
        const aviso = avisoDeContactoCambiado(r, cuandoSeActivo(r.at, zona));
        // El cambio ya quedó guardado: un aviso que no nace no lo deshace.
        if (aviso) await notificaciones.avisar(organizationId, { memberId, kind: 'CONTACT_CHANGED', dedupeKey: `CONTACT_CHANGED:${r.batchId}`, ...aviso }).catch(() => 0);
      }
      return r.contact;
    },
  });
}
