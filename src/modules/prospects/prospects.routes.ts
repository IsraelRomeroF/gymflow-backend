import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nombrePersona } from '../../platform/http/person-name.js';
import { telefonoMx } from '../../platform/http/phone.js';
import { z } from 'zod';
import { conflict, notFound, validation, type ErrorReason } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { contar, registerModuleUsage } from '../../platform/modules/usage.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { MemberRepository, altaEnMostrador, leerAlta, responderAlta } from '../members/index.js';
import { FollowUpRepository, contactoDeInteresadoBody, contactoJson } from '../follow-ups/index.js';
import { ProspectRepository } from './prospect.repository.js';
import { ProspectService } from './prospects.service.js';
import {
  PAGINA_MAXIMA, PAGINA_POR_OMISION, PROSPECT_STATUSES, ProspectContactResult, ProspectList, ProspectPending, ProspectSources, leerCursor,
} from '@gymflow/core/contracts';

const idParam = z.object({ id: z.string().uuid() });
const diaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Escribe la fecha como año-mes-día');

/** Lo que recepción captura de un interesado, y lo que después puede corregir. */
const datos = {
  firstName: nombrePersona(80),
  lastName: nombrePersona(80),
  phoneE164: telefonoMx().optional(),
  email: z.string().optional(),
  source: z.string().trim().max(60).optional(),
  notes: z.string().max(500).optional(),
  /** «¿Quién lo recomendó?»: un socio, o solo su nombre. */
  referredByMemberId: z.string().uuid().optional(),
  referredByName: z.string().trim().max(120).optional(),
};

/** Interesados: quien preguntó y todavía no se inscribe, con su seguimiento y su conversión. */
export function registerProspectRoutes(app: FastifyInstance): void {
  registerModuleUsage('prospects', async (orgId) => ({
    inUse: contar(await new ProspectRepository(orgId).openCount(), 'prospecto en seguimiento', 'prospectos en seguimiento'),
    blockers: [],
  }));
  const audit = new AuditService();
  const service = new ProspectService();

  /** El interesado de la ruta, ya con el permiso comprobado sobre SU sede (`requirePermission(permiso, sede)`). */
  async function sedeDelInteresado(request: FastifyRequest, permiso: 'members:create' | 'members:read') {
    const { id } = idParam.parse(request.params);
    const p = await new ProspectRepository(request.ctx!.tenant.organizationId).findById(id);
    if (!p) throw notFound('Prospecto no encontrado');
    request.requirePermission(permiso, p.branchId);
    return p;
  }

  // ── La bandeja ────────────────────────────────────────────────────────────
  route(app, {
    method: 'GET',
    url: '/prospects',
    module: 'prospects',
    security: { kind: 'permission', permission: 'members:read' },
    schema: respuesta(200, ProspectList),
    handler: async (request): Promise<ProspectList> => {
      const ctx = request.ctx!;
      const query = z.object({
        branchId: z.string().uuid().optional(),
        status: z.enum(PROSPECT_STATUSES).optional(),
        /** `true`: en seguimiento; `false`: cerrados (se inscribió o se perdió). */
        open: z.enum(['true', 'false']).optional(),
        /** Un grupo de la bandeja, en el orden en que se atiende (10-16); `closed`: los cerrados. */
        view: z.enum(['today', 'uncontacted', 'waiting', 'closed']).optional(),
        /** Nombre, teléfono o correo. */
        q: z.string().trim().max(80).optional(),
        cursor: z.string().max(400).optional(),
        limit: z.coerce.number().int().min(1).max(PAGINA_MAXIMA).default(PAGINA_POR_OMISION),
      }).parse(request.query);
      if (query.branchId) request.requirePermission('members:create', query.branchId);
      const cursor = query.cursor === undefined ? null : leerCursor(query.cursor);
      if (query.cursor !== undefined && !cursor) throw validation('Esa página ya no existe. Vuelve a abrir la lista.');
      const hoy = await service.hoy(ctx.tenant.organizationId);
      // Los prospectos son de la sede que los atiende.
      const pagina = await new ProspectRepository(ctx.tenant.organizationId).page({
        branchId: query.branchId, branchIds: request.branchScope('members:create'),
        status: query.status, open: query.open === undefined ? undefined : query.open === 'true', view: query.view, q: query.q,
        limit: query.limit, cursor, today: hoy,
      });
      // Con su último contacto (UX7): la lista refleja el trabajo de recepción.
      const ultimos = await new FollowUpRepository(ctx.tenant.organizationId).latest('prospect', pagina.items.map((p) => p.id));
      // Contrato: `ProspectList` (`@gymflow/core/contracts`). Ya no se corta en 50 sin avisar (10-01).
      return { ...pagina, items: pagina.items.map((p) => service.serialize(p, ultimos.get(p.id), hoy)) };
    },
  });

  /**
   * El pendiente del Inicio (10-08): «4 sin contactar · 2 te tocan hoy», de
   * las sedes de quien pregunta. Lo pinta el Inicio (bloque 2.1).
   */
  route(app, {
    method: 'GET',
    url: '/prospects/pending',
    module: 'prospects',
    security: { kind: 'permission', permission: 'members:read' },
    schema: respuesta(200, ProspectPending),
    handler: async (request): Promise<ProspectPending> => {
      const orgId = request.ctx!.tenant.organizationId;
      const p = await new ProspectRepository(orgId).pending(request.branchScope('members:create'), await service.hoy(orgId));
      const cuantos = p.today + p.uncontacted;
      return {
        clave: 'prospects', cuantos, masAntiguo: cuantos > 0 && p.oldest ? p.oldest.toISOString() : null, href: '/prospectos',
        tono: p.today > 0 ? 'warn' : cuantos > 0 ? 'info' : 'neutral', today: p.today, uncontacted: p.uncontacted,
      };
    },
  });

  // ── «¿Cómo se enteró?»: catálogo de la gerencia (10-17) ────────────────────
  route(app, {
    method: 'GET',
    url: '/prospects/sources',
    module: 'prospects',
    security: { kind: 'permission', permission: 'members:read' },
    schema: respuesta(200, ProspectSources),
    handler: async (request): Promise<ProspectSources> => new ProspectRepository(request.ctx!.tenant.organizationId).sources(),
  });

  route(app, {
    method: 'PUT',
    url: '/prospects/sources',
    module: 'prospects',
    security: { kind: 'permission', permission: 'settings:org' },
    schema: respuesta(200, ProspectSources),
    handler: async (request): Promise<ProspectSources> => {
      const ctx = request.ctx!;
      const { sources } = z.object({
        sources: z.array(z.string().trim().min(2, 'Cada fuente lleva al menos 2 letras').max(60)).min(1, 'Deja al menos una fuente').max(30),
      }).parse(request.body);
      const vistos = new Set<string>();
      const lista = sources.filter((n) => { const k = n.toLocaleLowerCase('es-MX'); if (vistos.has(k)) return false; vistos.add(k); return true; });
      const repo = new ProspectRepository(ctx.tenant.organizationId);
      const antes = await repo.sources();
      return enUnaTransaccion(async () => {
        await repo.setSources(lista);
        await audit.record(ctx, { action: 'prospect.sources.update', resourceType: 'Organization', resourceId: ctx.tenant.organizationId, beforeState: { sources: antes.sources }, afterState: { sources: lista } });
        return { sources: lista, defaults: false };
      });
    },
  });

  // ── Registrar ─────────────────────────────────────────────────────────────
  route(app, {
    method: 'POST',
    url: '/prospects',
    module: 'prospects',
    security: { kind: 'permission', permission: 'members:create' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = z.object({
        ...datos,
        branchId: z.string().uuid(),
        /** «¿Qué sigue?»: el primer próximo paso, con fecha (10-17). */
        nextStepOn: diaIso.optional(),
        /** Ya se vio que existe alguien parecido y se decidió que es otra persona. */
        force: z.boolean().optional(),
      }).parse(request.body);

      request.authorize('members:create', { branchId: body.branchId });
      if (!body.phoneE164 && !body.email) {
        throw validation('Un prospecto sin teléfono ni correo no se puede contactar');
      }
      const orgId = ctx.tenant.organizationId;
      // Una persona, un registro (10-07): si ya es socio o ya está en seguimiento, se dice a quién se encontró.
      if (!body.force) {
        const ya = await service.yaExiste(orgId, body);
        if (ya) {
          const abre = ya.kind === 'PROSPECT' ? request.holds('members:create', ya.branchId) : request.holds('members:read', ya.branchId);
          return reply.status(409).send({
            error: 'CONFLICT',
            reason: (ya.kind === 'PROSPECT' ? 'PROSPECT_ALREADY_OPEN' : 'ALREADY_MEMBER') satisfies ErrorReason,
            message: ya.kind === 'PROSPECT' ? `${ya.fullName} ya está en seguimiento` : ya.kind === 'MEMBER' ? `${ya.fullName} ya es socio` : `${ya.fullName} fue socio: se reactiva su ficha, no se registra como interesado`,
            // De otra sede solo se avisa: sin id no hay a dónde abrir.
            existing: { kind: ya.kind, id: abre ? ya.id : null, fullName: ya.fullName, branchId: ya.branchId },
          });
        }
      }
      if (body.referredByMemberId && !await new MemberRepository(orgId).findByIdIncludingArchived(body.referredByMemberId)) throw notFound('Socio no encontrado');

      const prospect = await enUnaTransaccion(async () => {
        const p = await new ProspectRepository(orgId).create({
          ...body,
          nextStepOn: body.nextStepOn ? new Date(`${body.nextStepOn}T00:00:00.000Z`) : null,
          assignedToUserId: ctx.tenant.actorUserId ?? null,
        });
        // Quién lo registró y de dónde viene (10-11); sin el nombre: la bitácora no se borra.
        await audit.record(ctx, {
          action: 'prospect.create', resourceType: 'Prospect', resourceId: p.id, branchId: body.branchId,
          afterState: { source: body.source ?? null, nextStepOn: body.nextStepOn ?? null, referred: !!(body.referredByMemberId || body.referredByName) },
        });
        return p;
      });
      return reply.status(201).send(prospect);
    },
  });

  /**
   * Corregir lo capturado: nombre, contacto, fuente, quién lo recomendó y la
   * nota (10-12). La etapa ya no se cambia aquí: se deriva de los contactos
   * (10-05). Cerrar y reabrir tienen su propia ruta, con motivo.
   */
  route(app, {
    method: 'PATCH',
    url: '/prospects/:id',
    module: 'prospects',
    security: { kind: 'permission', permission: 'members:create' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const cuerpo = (request.body ?? {}) as Record<string, unknown>;
      if ('status' in cuerpo) {
        throw validation('La etapa ya no se cambia a mano: sale de los contactos. Para cerrarlo usa «Ya no se va a inscribir»; para devolverlo, «Reabrir»');
      }
      const body = z.object({
        firstName: datos.firstName.optional(),
        lastName: datos.lastName.optional(),
        phoneE164: telefonoMx().nullish(),
        email: z.string().nullish(),
        source: z.string().trim().max(60).nullish(),
        notes: z.string().max(500).nullish(),
        referredByMemberId: z.string().uuid().nullish(),
        referredByName: z.string().trim().max(120).nullish(),
      }).parse(cuerpo);
      const p = await sedeDelInteresado(request, 'members:create');
      if (p.convertedMemberId) throw conflict('Ese prospecto ya es socio', 'PROSPECT_CLOSED');
      const telefono = body.phoneE164 === undefined ? p.phoneE164 : body.phoneE164 || null;
      const correo = body.email === undefined ? p.email : body.email?.trim() || null;
      if (!telefono && !correo) throw validation('Un prospecto sin teléfono ni correo no se puede contactar');
      const repo = new ProspectRepository(ctx.tenant.organizationId);
      const patch = {
        ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
        ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
        ...(body.phoneE164 !== undefined ? { phoneE164: telefono } : {}),
        ...(body.email !== undefined ? { email: correo } : {}),
        ...(body.source !== undefined ? { source: body.source || null } : {}),
        ...(body.notes !== undefined ? { notes: body.notes?.trim() || null } : {}),
        ...(body.referredByMemberId !== undefined ? { referredByMemberId: body.referredByMemberId ?? null } : {}),
        ...(body.referredByName !== undefined ? { referredByName: body.referredByName || null } : {}),
      };
      await enUnaTransaccion(async () => {
        await repo.update(p.id, patch);
        // Qué campos cambiaron, sin sus valores: la bitácora no guarda nombres ni teléfonos (SEC-08).
        await audit.record(ctx, { action: 'prospect.update', resourceType: 'Prospect', resourceId: p.id, branchId: p.branchId, afterState: { campos: Object.keys(patch) } });
      });
      return { ok: true };
    },
  });

  /**
   * «Contacto con {nombre}» (UX7), con resultado y próximo paso. La etapa
   * sale de aquí: «Vino a probar» lo pasa a En prueba; «No le interesa» lo
   * cierra con su motivo en el mismo paso (10-05).
   */
  route(app, {
    method: 'POST',
    url: '/prospects/:id/follow-ups',
    module: 'prospects',
    security: { kind: 'permission', permission: 'members:create' },
    schema: respuesta(201, ProspectContactResult),
    handler: async (request, reply) => {
      const body = contactoDeInteresadoBody.parse(request.body);
      const p = await sedeDelInteresado(request, 'members:create');
      return reply.status(201).send(await service.registrarContacto(request.ctx!, p, body));
    },
  });

  route(app, {
    method: 'GET',
    url: '/prospects/:id/follow-ups',
    module: 'prospects',
    security: { kind: 'permission', permission: 'members:read' },
    handler: async (request) => {
      const p = await sedeDelInteresado(request, 'members:read');
      return { followUps: (await new FollowUpRepository(request.ctx!.tenant.organizationId).listFor('prospect', p.id)).map(contactoJson) };
    },
  });

  /** «Ya no se va a inscribir»: sale de seguimiento con su motivo de la lista corta (10-09). */
  route(app, {
    method: 'POST',
    url: '/prospects/:id/close',
    module: 'prospects',
    security: { kind: 'permission', permission: 'members:create' },
    handler: async (request) => {
      const body = z.object({ reasonCode: z.string().min(1, 'Elige un motivo de la lista').max(40), note: z.string().trim().max(300).optional() }).parse(request.body);
      const p = await sedeDelInteresado(request, 'members:create');
      return { ok: true, ...(await service.cerrar(request.ctx!, p, body)) };
    },
  });

  /** «Reabrir»: vuelve a seguimiento con la etapa de sus contactos, no a «Nuevo» (10-09). */
  route(app, {
    method: 'POST',
    url: '/prospects/:id/reopen',
    module: 'prospects',
    security: { kind: 'permission', permission: 'members:create' },
    handler: async (request) => {
      const p = await sedeDelInteresado(request, 'members:create');
      return { ok: true, ...(await service.reabrir(request.ctx!, p)) };
    },
  });

  /**
   * «Inscribir»: el alta del mostrador y la conversión del interesado en UNA
   * operación (10-07). Recibe lo mismo que `POST /members` y contesta lo
   * mismo (201 con el socio, 409 con los posibles duplicados). Antes el panel
   * creaba al socio y después pedía convertir; si esa segunda llamada
   * fallaba, el interesado seguía «en seguimiento» y lo volvían a llamar.
   */
  route(app, {
    method: 'POST',
    url: '/prospects/:id/enroll',
    module: 'prospects',
    security: { kind: 'permission', permission: 'members:create' },
    handler: async (request, reply) => {
      const p = await sedeDelInteresado(request, 'members:create');
      if (p.convertedMemberId) throw conflict('Ese prospecto ya es socio', 'PROSPECT_CLOSED');
      const result = await enUnaTransaccion(async () => {
        const body = leerAlta(request.body);
        // El alcance se comprueba contra la sucursal de alta, igual que en `POST /members`.
        request.authorize('members:create', { branchId: body.homeBranchId ?? null });
        const r = await altaEnMostrador(request.ctx!, body);
        if (r.status === 'CREATED' && !await service.convertir(request.ctx!, p, r.member.id, 'inscribir')) throw conflict('Ese prospecto ya es socio', 'PROSPECT_CLOSED');
        return r;
      });
      return responderAlta(request, reply, result);
    },
  });

  /**
   * «Ya era socio»: el interesado queda ligado a una ficha que ya existía
   * (10-07). Para el alta nueva está `enroll`, que hace las dos cosas juntas.
   */
  route(app, {
    method: 'POST',
    url: '/prospects/:id/convert',
    module: 'prospects',
    security: { kind: 'permission', permission: 'members:create' },
    handler: async (request) => {
      const { memberId } = z.object({ memberId: z.string().uuid() }).parse(request.body);
      const p = await sedeDelInteresado(request, 'members:create');
      if (!await new MemberRepository(request.ctx!.tenant.organizationId).findById(memberId)) throw notFound('Socio no encontrado');
      const ok = await enUnaTransaccion(() => service.convertir(request.ctx!, p, memberId, 'manual'));
      if (!ok) throw conflict('Ese prospecto ya es socio', 'PROSPECT_CLOSED');
      return { ok: true };
    },
  });
}
