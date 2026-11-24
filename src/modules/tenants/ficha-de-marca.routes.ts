import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forbidden } from '@gymflow/core';
import { GYM_DATA_FIELDS, GymChangeRequest, GymChangeRequestList, GymChangeRequestsSeen, PlatformBrand, PlatformChangeRequest, PlatformChangeRequestList } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { GymBrandService } from './ficha-de-marca.service.js';

/** Un logo de 200 KB en base64 más el resto del cuerpo. */
const CUERPO_CON_LOGO = 400 * 1024;
const idParam = z.object({ id: z.string().uuid() });
const motivo = z.string().trim().min(3, 'Escribe el motivo: queda en la bitácora').max(300);
/** Un dato de texto (o el logo como `data:` URL); `null` o vacío = quitarlo. La regla de cada dato la aplica el servicio. */
const valor = z.string().max(CUERPO_CON_LOGO).nullable();

/**
 * Quién pide cambios desde el panel: la dueña (lleva la llave) y la gerencia
 * que configura el gimnasio o alguna sucursal. Es la misma puerta que la de
 * «Mi gimnasio · Datos» (`GET /organization/profile`); recepción y coach, no.
 */
export function puedePedirCambios(request: FastifyRequest): boolean {
  return request.holds('settings:org', null) || request.branchScope('settings:branch')?.length !== 0 || request.holds('staff:unlock', null);
}

/**
 * DATOS Y MARCA DEL GIMNASIO (D-27, opción d · bloque 4.6).
 *
 *  - PANEL (rutas de sesión, solo la marca de quien entra): mandar «Pedir un
 *    cambio a GymFlow», ver las solicitudes del gimnasio y marcar como visto
 *    el resultado de las propias. Desde aquí NO se cambia ningún dato.
 *  - CONSOLA (rutas de plataforma): la ficha de marca, editarla con motivo, y
 *    aplicar o rechazar cada solicitud con respuesta.
 */
export function registerGymBrandRoutes(app: FastifyInstance): void {
  const servicio = new GymBrandService();

  // ── Panel del gimnasio ─────────────────────────────────────────────────────

  /**
   * Las solicitudes del gimnasio y cuántas de las MÍAS ya tienen respuesta sin
   * ver (el aviso de arriba del panel). A quien no puede pedir cambios le
   * responde vacío, sin error: el panel pregunta siempre.
   */
  route(app, {
    method: 'GET',
    url: '/gym-change-requests',
    security: { kind: 'session' },
    schema: respuesta(200, GymChangeRequestList),
    handler: async (request): Promise<GymChangeRequestList> => {
      const { organizationId, actorUserId } = request.ctx!.tenant;
      if (!puedePedirCambios(request)) return { requests: [], unseen: 0 };
      return servicio.deGimnasio(organizationId, actorUserId ?? null);
    },
  });

  route(app, {
    method: 'POST',
    url: '/gym-change-requests',
    security: { kind: 'session' },
    bodyLimit: CUERPO_CON_LOGO,
    schema: respuesta(201, GymChangeRequest),
    handler: async (request, reply) => {
      if (!puedePedirCambios(request)) throw forbidden('Los cambios a los datos del gimnasio los piden la dueña y la gerencia');
      const body = z.object({
        field: z.enum(GYM_DATA_FIELDS),
        branchId: z.string().uuid().nullish(),
        value: valor.optional(),
        reason: z.string().trim().min(3, 'Di por qué cambia: GymFlow lo lee antes de aplicarlo').max(300),
      }).parse(request.body);
      const creada = await servicio.pedir(request.ctx!, { field: body.field, branchId: body.branchId ?? null, value: body.value ?? null, reason: body.reason });
      return reply.status(201).send(creada);
    },
  });

  /** Quien pidió tiene a la vista la respuesta de GymFlow: se apaga su aviso. */
  route(app, {
    method: 'POST',
    url: '/gym-change-requests/seen',
    security: { kind: 'session' },
    schema: respuesta(200, GymChangeRequestsSeen),
    handler: async (request): Promise<GymChangeRequestsSeen> => {
      const { organizationId, actorUserId } = request.ctx!.tenant;
      if (!actorUserId) return { seen: 0 };
      return { seen: await servicio.vistas(organizationId, actorUserId) };
    },
  });

  // ── Consola de plataforma ──────────────────────────────────────────────────

  /** Lo que los gimnasios pidieron y espera respuesta, de todas las marcas. */
  route(app, {
    method: 'GET',
    url: '/platform/change-requests',
    security: { kind: 'platform' },
    schema: respuesta(200, PlatformChangeRequestList),
    handler: async (): Promise<PlatformChangeRequestList> => servicio.pendientes(),
  });

  /** La ficha de marca: RFC, logo, teléfonos, leyenda del recibo, teléfono y horario de cada sucursal, y sus solicitudes. */
  route(app, {
    method: 'GET',
    url: '/platform/organizations/:id/brand',
    security: { kind: 'platform' },
    schema: respuesta(200, PlatformBrand),
    handler: async (request): Promise<PlatformBrand> => servicio.ficha(idParam.parse(request.params).id),
  });

  /** Editar la ficha de marca (nombre comercial y razón social siguen en «Editar marca»). Solo lo que vino; con motivo. */
  route(app, {
    method: 'PUT',
    url: '/platform/organizations/:id/brand',
    security: { kind: 'platform' },
    bodyLimit: CUERPO_CON_LOGO,
    schema: respuesta(200, PlatformBrand),
    handler: async (request): Promise<PlatformBrand> => {
      const { id } = idParam.parse(request.params);
      const { reason, ...datos } = z.object({
        rfc: valor.optional(), phone: valor.optional(), whatsapp: valor.optional(), receiptLegend: valor.optional(), logo: valor.optional(), reason: motivo,
      }).parse(request.body);
      await servicio.editarMarca(id, datos, request.platform!.userId, reason);
      return servicio.ficha(id);
    },
  });

  /** Teléfono y horario de una sucursal. */
  route(app, {
    method: 'PUT',
    url: '/platform/organizations/:id/branches/:branchId/contact',
    security: { kind: 'platform' },
    schema: respuesta(200, PlatformBrand),
    handler: async (request): Promise<PlatformBrand> => {
      const { id, branchId } = z.object({ id: z.string().uuid(), branchId: z.string().uuid() }).parse(request.params);
      const { reason, ...datos } = z.object({ phone: valor.optional(), openingHours: valor.optional(), reason: motivo }).parse(request.body);
      await servicio.editarSede(id, branchId, datos, request.platform!.userId, reason);
      return servicio.ficha(id);
    },
  });

  /** Aplicar una solicitud: cambia el dato (tal cual se pidió, o ajustado con `value`) y le contesta a quien la pidió. */
  route(app, {
    method: 'POST',
    url: '/platform/change-requests/:id/apply',
    security: { kind: 'platform' },
    bodyLimit: CUERPO_CON_LOGO,
    schema: respuesta(200, PlatformChangeRequest),
    handler: async (request): Promise<PlatformChangeRequest> => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ value: valor.optional(), response: z.string().trim().max(500).nullish() }).parse(request.body ?? {});
      return servicio.aplicar(id, body, request.platform!.userId);
    },
  });

  /** Rechazar una solicitud: no cambia nada; la respuesta es obligatoria. */
  route(app, {
    method: 'POST',
    url: '/platform/change-requests/:id/reject',
    security: { kind: 'platform' },
    schema: respuesta(200, PlatformChangeRequest),
    handler: async (request): Promise<PlatformChangeRequest> => {
      const { id } = idParam.parse(request.params);
      const { response } = z.object({ response: z.string().trim().min(3, 'Di por qué no se aplica: quien la pidió lee tu respuesta').max(500) }).parse(request.body);
      return servicio.rechazar(id, response, request.platform!.userId);
    },
  });
}
