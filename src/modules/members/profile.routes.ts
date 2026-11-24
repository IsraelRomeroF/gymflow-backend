import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nombrePersona } from '../../platform/http/person-name.js';
import { telefonoMx } from '../../platform/http/phone.js';
import { z, ZodError } from 'zod';
import { forbidden, notFound, type ErrorReason } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import type { RequestContext } from '../../platform/context.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { IdentityCheck } from '@gymflow/core/contracts';
import { buscarIdentidad } from './identity-search.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { MemberRepository } from './member.repository.js';
import { MemberService, antiguedadDeclarada, diaDeNegocio, type CreateMemberResult } from './member.service.js';
import { consentSchema, idParam, serializeMember, vista } from './members.serializers.js';
import { asentarResponsable, guardianSchema, prepararResponsable, responsibleSchema, ResponsibleRepository } from './responsible.js';

/** Lo que `serializeMember` oculta a quien no tiene alcance sobre la sede del socio (`vista().contacto`). */
const CONTACTO = ['phoneE164', 'email', 'emergencyContactName', 'emergencyContactPhone'] as const;

const createMemberSchema = z.object({
  firstName: nombrePersona(80),
  lastName: nombrePersona(80),
  phoneE164: telefonoMx().optional(),
  email: z.string().optional(),
  birthDate: z.string().date().optional(),
  curp: z.string().optional(),
  homeBranchId: z.string().uuid().optional(),
  notes: z.string().max(500).optional(),
  emergencyContactName: nombrePersona(120).or(z.literal('')).optional(),
  emergencyContactPhone: telefonoMx().optional(),
  /**
   * «¿Desde cuándo viene?» (ADR-029, D-11; 2-01): un día de calendario, nunca
   * futuro. Sin él, es hoy. Antes el alta del mostrador no lo preguntaba y
   * todo socio decía "socio desde hace 1 día".
   */
  joinedAt: z.string().date('Escribe la fecha como año-mes-día').optional(),
  consents: z.array(consentSchema).min(1),
  /** Continuar pese a los posibles duplicados. Queda auditado. */
  force: z.boolean().optional(),
  /** D-09: su celular ya es el de otro socio; quién responde por el número. */
  responsible: responsibleSchema.optional(),
  /** D-10: es menor y su tutor firma aquí, en el mostrador; la aceptación queda a nombre del tutor. */
  guardian: guardianSchema.optional(),
  /** D-29: el coach que recepción elige al alta. Después solo lo cambia la gerencia (`PUT /members/:id/coach`). */
  coachUserId: z.string().uuid().nullish(),
  // D-11: «celular o correo» lo exige la pantalla («Nuevo socio» no deja dar de alta sin uno). La API no lo
  // rechaza todavía: la importación y varias pruebas de otros módulos crean socios sin contacto (pendientes/3.4.md).
});

/**
 * EL ALTA EN EL MOSTRADOR, fuera de su ruta (bloque 2.4) para que «Inscribir»
 * desde un interesado (`POST /prospects/:id/enroll`) dé de alta con las mismas
 * reglas y convierta al interesado en la misma unidad de trabajo. Tres pasos,
 * los mismos en las dos rutas: `leerAlta` valida el cuerpo, la RUTA comprueba
 * el alcance sobre la sucursal de alta (`request.authorize`) y
 * `altaEnMostrador` crea al socio o devuelve los posibles duplicados.
 */
export type CuerpoDeAlta = z.infer<typeof createMemberSchema>;
export const leerAlta = (cuerpo: unknown): CuerpoDeAlta => createMemberSchema.parse(cuerpo);

export async function altaEnMostrador(ctx: RequestContext, body: CuerpoDeAlta, service: MemberService = new MemberService()): Promise<CreateMemberResult> {
  const joinedAt = body.joinedAt
    ? await antiguedadDeclarada(ctx.tenant.organizationId, body.joinedAt, body.homeBranchId ?? null) : null;

  return service.create(ctx, {
    firstName: body.firstName,
    lastName: body.lastName,
    phoneE164: body.phoneE164 ?? null,
    email: body.email ?? null,
    birthDate: body.birthDate ? new Date(`${body.birthDate}T00:00:00.000Z`) : null,
    curp: body.curp ?? null,
    homeBranchId: body.homeBranchId ?? null,
    notes: body.notes ?? null,
    emergencyContactName: body.emergencyContactName?.trim() || null,
    emergencyContactPhone: body.emergencyContactPhone?.trim() || null,
    joinedAt,
    createdByUserId: ctx.tenant.actorUserId!,
    consents: body.consents,
    ...(body.force === undefined ? {} : { force: body.force }),
    responsible: body.responsible, guardian: body.guardian,
    coachUserId: body.coachUserId ?? null,
  });
}

/** Lo que contesta un alta: 201 con el socio, o 409 con los posibles duplicados (una decisión que toma una persona). */
export function responderAlta(request: FastifyRequest, reply: FastifyReply, result: CreateMemberResult): FastifyReply {
  if (result.status === 'DUPLICATES_FOUND') {
    // 409: no es un error del cliente ni del servidor, es una decisión
    // que una persona tiene que tomar.
    return reply.status(409).send({
      error: 'DUPLICATES_FOUND',
      reason: 'DUPLICATE_MEMBER' satisfies ErrorReason,
      message: 'Se encontraron socios que podrían ser la misma persona',
      candidates: result.candidates,
    });
  }
  return reply.status(201).send(serializeMember(result.member, vista(request, result.member.homeBranchId)));
}

/** El expediente: deduplicar, dar de alta, corregir, dar de baja y recibir de vuelta. */
export function registerProfileRoutes(app: FastifyInstance): void {
  const service = new MemberService();
  const audit = new AuditService();

  // ── Deduplicación ─────────────────────────────────────────────────────────
  route(app, {
    method: 'POST',
    url: '/members/check-duplicates',
    security: { kind: 'permission', permission: 'members:create' },
    schema: respuesta(200, IdentityCheck),
    /**
     * EL BUSCADOR DE IDENTIDAD ÚNICO (bloque 2.4; `identity-search.ts`).
     * `candidates` y `blocking` son los de siempre (socios, lo que bloquea un
     * alta). `people` suma interesados abiertos y altas por revisar, y dice
     * qué es cada quien. El nombre ya no es obligatorio: en «Nuevo prospecto»
     * el celular va primero; hace falta al menos nombre, celular o correo.
     */
    handler: async (request): Promise<IdentityCheck> => {
      const ctx = request.ctx!;
      const body = z.object({
        firstName: nombrePersona(80).or(z.literal('')).optional(),
        lastName: nombrePersona(80).or(z.literal('')).optional(),
        phoneE164: telefonoMx().optional(),
        email: z.string().optional(),
        curp: z.string().optional(),
        /** Al revisar un alta digital: ella misma no cuenta como coincidencia. */
        excludeIntakeId: z.string().uuid().optional(),
      }).refine((b) => !!(b.firstName || b.lastName || b.phoneE164 || b.email || b.curp), { message: 'Escribe un nombre, un celular o un correo', path: ['phoneE164'] })
        .parse(request.body);
      const r = await buscarIdentidad(ctx.tenant.organizationId, body, {
        excludeIntakeId: body.excludeIntakeId,
        // La ficha es un expediente único; un interesado o un alta, de la sede que los atiende.
        puedeAbrir: (kind, branchId) => (kind === 'PROSPECT' ? request.holds('members:create', branchId)
          : kind === 'INTAKE' ? request.holds('members:intake:read', branchId) : request.holds('members:read', null) || request.holds('members:read', branchId)),
      });
      return { candidates: r.candidates, blocking: MemberService.isBlocking(r.candidates), people: r.people };
    },
  });

  // ── Alta ──────────────────────────────────────────────────────────────────
  route(app, {
    method: 'POST',
    url: '/members',
    security: { kind: 'permission', permission: 'members:create' },
    handler: async (request, reply) => {
      const body = leerAlta(request.body);
      // El alcance de sucursal se comprueba contra la sucursal de alta.
      request.authorize('members:create', { branchId: body.homeBranchId ?? null });
      return responderAlta(request, reply, await altaEnMostrador(request.ctx!, body, service));
    },
  });

  route(app, {
    method: 'PATCH',
    url: '/members/:id',
    security: { kind: 'permission', permission: 'members:update' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        firstName: nombrePersona(80).optional(),
        lastName: nombrePersona(80).optional(),
        phoneE164: telefonoMx().nullable().optional(),
        email: z.string().nullable().optional(),
        homeBranchId: z.string().uuid().nullable().optional(),
        notes: z.string().max(500).nullable().optional(),
        birthDate: z.string().date().nullable().optional(),
        emergencyContactName: nombrePersona(120).or(z.literal('')).nullable().optional(),
        emergencyContactPhone: telefonoMx().nullable().optional(),
        /** Corregir la antigüedad (2-01): un día de calendario, con motivo. */
        joinedAt: z.string().date('Escribe la fecha como año-mes-día').optional(),
        /** Obligatorio si cambia la antigüedad: queda en la bitácora. */
        reason: z.string().trim().max(300).optional(),
        /** D-09: el celular nuevo ya es el de otro socio; quién responde por el número. */
        responsible: responsibleSchema.optional(),
      }).parse(request.body);
      const { birthDate, joinedAt: diaDeAlta, reason, responsible, ...resto } = body;

      const repo = new MemberRepository(ctx.tenant.organizationId);
      const before = await repo.findById(id);
      if (!before) throw notFound('Socio no encontrado');
      // LO QUE NO VIO NO LO PUEDE BORRAR (1.1 §7-6). A quien no tiene alcance
      // sobre la sede del socio, la ficha le llega con el contacto en `null`
      // («oculto», no «no tiene»). Si el formulario lo devuelve tal cual, ese
      // `null` no es una orden de borrar: se ignora. Y escribir a ciegas
      // encima de un dato que no puede ver no se permite.
      const ocultos = new Set<string>();
      if (!vista(request, before.homeBranchId).contacto) {
        for (const campo of CONTACTO) {
          const valor = resto[campo];
          if (valor === undefined) continue;
          if (valor !== null && valor !== '') throw forbidden('El contacto de este socio lo cambia el personal de su sucursal');
          delete resto[campo];
          ocultos.add(campo);
        }
      }
      // El expediente es de toda la organización (se cobra en cualquier sede),
      // pero MUDAR al socio de sede exige autoridad sobre las dos: la de
      // origen y la de destino. Antes se podía mandar a cualquier sucursal.
      if (body.homeBranchId !== undefined && body.homeBranchId !== before.homeBranchId) {
        request.requirePermission('members:update', before.homeBranchId);
        request.requirePermission('members:update', body.homeBranchId);
      }

      // La antigüedad decide la pantalla de excepción y Retención: se corrige
      // con motivo, y el antes y el después quedan en la bitácora (una fecha
      // de alta no dice quién es nadie, a diferencia de un nombre o un teléfono).
      const orgId = ctx.tenant.organizationId;
      const sede = body.homeBranchId !== undefined ? body.homeBranchId : before.homeBranchId;
      const antiguedadAntes = await diaDeNegocio(orgId, before.joinedAt, sede);
      const cambiaAntiguedad = diaDeAlta !== undefined && diaDeAlta !== antiguedadAntes;
      if (cambiaAntiguedad && (reason?.length ?? 0) < 3) {
        throw new ZodError([{ code: 'custom', path: ['reason'], message: 'Escribe por qué cambia la antigüedad: queda en la bitácora', input: undefined }]);
      }
      const joinedAt = cambiaAntiguedad ? await antiguedadDeclarada(orgId, diaDeAlta, sede) : undefined;

      // D-09: un celular que ya es de otro socio se comparte anotando al responsable (`PHONE_IN_USE` si falta).
      const celularNuevo = typeof resto.phoneE164 === 'string' && resto.phoneE164 !== before.phoneE164 ? resto.phoneE164 : null;
      const responsableNuevo = celularNuevo
        ? await prepararResponsable(orgId, { phoneE164: celularNuevo, responsible, memberId: id, yaTiene: !!(await new ResponsibleRepository(orgId).de(id))?.responsibleKind })
        : undefined;

      const updated = await repo.update(id, {
        ...resto,
        ...(birthDate !== undefined ? { birthDate: birthDate ? new Date(`${birthDate}T00:00:00.000Z`) : null } : {}),
        ...(joinedAt ? { joinedAt } : {}),
      } as Parameters<MemberRepository['update']>[1]);
      if (!updated) throw notFound('Socio no encontrado');
      if (responsableNuevo) {
        await new ResponsibleRepository(orgId).escribir(id, responsableNuevo);
        await asentarResponsable(orgId, id, updated.phoneE164, responsableNuevo);
      }
      // Bloque 4.11: igual que cuando el socio lo cambia desde el portal (4.8). Si su celular cambió (o se
      // quitó), quien lo tenía anotado como responsable del número ANTERIOR se queda sin responsable, y si
      // él tenía anotado a otro socio con quien ya no comparte número, también lo suelta. Lo demás (un
      // adulto o un tutor anotados a mano en el mostrador) no se toca.
      let dejaronDeTenerloDeResponsable = 0;
      let soltoASuResponsable = false;
      if (resto.phoneE164 !== undefined && updated.phoneE164 !== before.phoneE164) {
        const responsables = new ResponsibleRepository(orgId);
        dejaronDeTenerloDeResponsable = await responsables.soltarA(id);
        if (!responsableNuevo) soltoASuResponsable = await responsables.soltarSiYaNoComparte(id);
      }

      await audit.record(ctx, {
        action: 'member.update',
        resourceType: 'Member',
        resourceId: id,
        // QUÉ cambió, no los valores (SEC-08): la bitácora es inmutable y un
        // teléfono o un nombre aquí sobrevivirían a la anonimización. La sede
        // sí va con su valor: no es dato personal y explica un cambio de alcance.
        beforeState: { homeBranchId: before.homeBranchId, ...(cambiaAntiguedad ? { joinedAt: antiguedadAntes } : {}) },
        afterState: {
          changedFields: Object.keys(body).filter((k) => k !== 'reason' && k !== 'responsible' && !ocultos.has(k) && (k !== 'joinedAt' || cambiaAntiguedad)),
          ...(responsableNuevo ? { responsable: responsableNuevo.responsibleKind } : {}),
          ...(dejaronDeTenerloDeResponsable > 0 ? { dejaronDeTenerloDeResponsable } : {}),
          ...(soltoASuResponsable ? { soltoASuResponsable: true } : {}),
          homeBranchId: updated.homeBranchId,
          ...(cambiaAntiguedad ? { joinedAt: diaDeAlta } : {}),
        },
        ...(cambiaAntiguedad ? { reason: reason! } : {}),
      });
      return serializeMember(updated, vista(request, updated.homeBranchId));
    },
  });

  route(app, {
    method: 'POST',
    url: '/members/:id/archive',
    security: { kind: 'permission', permission: 'members:archive' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(request.body);
      // members:archive exige motivo: se evalúa con el recurso real.
      const socio = await new MemberRepository(ctx.tenant.organizationId).findById(id);
      if (!socio) throw notFound('Socio no encontrado');
      request.authorize('members:archive', { reason, branchId: socio.homeBranchId });

      const ok = await service.archive(ctx, id, reason);
      if (!ok) throw notFound('Socio no encontrado');
      return { status: 'ARCHIVED' };
    },
  });

  /** Un exsocio vuelve (PS-04): se reactiva su ficha en vez de duplicarla. */
  route(app, {
    method: 'POST',
    url: '/members/:id/reactivate',
    security: { kind: 'permission', permission: 'members:create' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(request.body);
      const socio = await new MemberRepository(ctx.tenant.organizationId).findByIdIncludingArchived(id);
      if (!socio) throw notFound('Socio no encontrado');
      request.authorize('members:create', { reason, branchId: socio.homeBranchId });
      const m = await service.reactivate(ctx, id, reason);
      return serializeMember(m, vista(request, m.homeBranchId));
    },
  });
}
