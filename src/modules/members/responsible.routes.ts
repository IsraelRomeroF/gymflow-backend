import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MEMBER_COMPLETABLE_FIELDS, normalizeEmail, normalizePhoneMx, notFound, validation } from '@gymflow/core';
import { MemberCompleted, MemberSharedPhone } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { nombrePersona } from '../../platform/http/person-name.js';
import { telefonoMx } from '../../platform/http/phone.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { MemberRepository } from './member.repository.js';
import { idParam, vista } from './members.serializers.js';
import { asentarResponsable, celularCompartido, prepararResponsable, responsibleSchema, ResponsibleRepository } from './responsible.js';

/** Lo que le falta a una ficha (lo mismo que cuenta el cierre del alta). */
function loQueFalta(m: { phoneE164: string | null; email: string | null; birthDate: Date | null; emergencyContactName: string | null }): string[] {
  const f: string[] = [];
  if (!m.birthDate) f.push('birthDate');
  if (!m.emergencyContactName) f.push('emergencyContactName');
  if (!m.phoneE164 && !m.email) f.push('phoneE164');
  return f;
}

/**
 * Celular compartido, responsable y «completar lo vacío» (auditoría 8, fase 3,
 * bloque 3.4; D-09 y D-11).
 */
export function registerResponsibleRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  /** La ficha dice «Comparte celular con…» y quién responde por el número (D-09). */
  route(app, {
    method: 'GET',
    url: '/members/:id/shared-phone',
    security: { kind: 'permission', permission: 'members:read' },
    schema: respuesta(200, MemberSharedPhone),
    handler: async (request): Promise<MemberSharedPhone> => {
      const orgId = request.ctx!.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const socio = await new MemberRepository(orgId).findById(id);
      if (!socio) throw notFound('Socio no encontrado');
      // Quien no ve teléfonos (el coach, D-30) tampoco se entera de con quién se comparte uno.
      if (!vista(request, socio.homeBranchId).contacto) return { hidden: true, sharedWith: [], responsible: null, missingResponsible: false };
      const r = await celularCompartido(orgId, id);
      if (!r) throw notFound('Socio no encontrado');
      return { hidden: false, ...r };
    },
  });

  /** Anotar o cambiar al responsable del número (D-09). `null` lo quita. Lo hace quien edita la ficha. */
  route(app, {
    method: 'PUT',
    url: '/members/:id/responsible',
    security: { kind: 'permission', permission: 'members:update' },
    schema: respuesta(200, MemberSharedPhone),
    handler: async (request): Promise<MemberSharedPhone> => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      // Primero de quién es y si le toca (404 y 403), después qué mandó (422).
      const socio = await new MemberRepository(orgId).findById(id);
      if (!socio) throw notFound('Socio no encontrado');
      request.requirePermission('members:update', socio.homeBranchId);
      const { responsible } = z.object({ responsible: responsibleSchema.nullable() }).parse(request.body);

      const repo = new ResponsibleRepository(orgId);
      const antes = await repo.de(id);
      await enUnaTransaccion(async () => {
        if (responsible === null) {
          // La firma del tutor (D-10) es un hecho: quitar al responsable no la borra de sus consentimientos.
          await repo.escribir(id, { responsibleKind: null, responsibleMemberId: null, responsibleName: null, responsiblePhoneE164: null });
        } else {
          const c = await prepararResponsable(orgId, { phoneE164: socio.phoneE164, responsible, memberId: id });
          if (c) {
            await repo.escribir(id, c);
            await asentarResponsable(orgId, id, socio.phoneE164, c);
          }
        }
        // Qué clase de responsable, sin su nombre (SEC-08).
        await audit.record(ctx, {
          action: 'member.responsible', resourceType: 'Member', resourceId: id, branchId: socio.homeBranchId,
          beforeState: { responsable: antes?.responsibleKind ?? null }, afterState: { responsable: responsible?.kind ?? null },
        });
      });
      return { hidden: false, ...(await celularCompartido(orgId, id))! };
    },
  });

  /**
   * COMPLETAR LO VACÍO (D-11). El alta mínima del mostrador deja para después
   * el nacimiento, el contacto de emergencia y lo demás; recepción los llena
   * cuando la persona vuelve. Con el permiso de dar de alta (`members:create`),
   * no con el de editar: solo escribe en un campo que está VACÍO y nunca cambia
   * lo ya capturado (eso es de la gerencia, `PATCH /members/:id`).
   */
  route(app, {
    method: 'POST',
    url: '/members/:id/complete',
    security: { kind: 'permission', permission: 'members:create' },
    schema: respuesta(200, MemberCompleted),
    handler: async (request): Promise<MemberCompleted> => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const members = new MemberRepository(orgId);
      const socio = await members.findById(id);
      if (!socio) throw notFound('Socio no encontrado');
      request.requirePermission('members:create', socio.homeBranchId);
      const body = z.object({
        phoneE164: telefonoMx().optional(),
        email: z.string().trim().email('Correo inválido').max(160).optional(),
        birthDate: z.string().date('Escribe la fecha como año-mes-día').optional(),
        emergencyContactName: nombrePersona(120).optional(),
        emergencyContactPhone: telefonoMx().optional(),
        /** Si el celular que se completa ya es el de otro socio (D-09), o para anotar al que faltaba. */
        responsible: responsibleSchema.optional(),
      } satisfies Record<(typeof MEMBER_COMPLETABLE_FIELDS)[number] | 'responsible', z.ZodType>).parse(request.body);

      const dado: Record<(typeof MEMBER_COMPLETABLE_FIELDS)[number], string | null> = {
        phoneE164: normalizePhoneMx(body.phoneE164), email: normalizeEmail(body.email), birthDate: body.birthDate ?? null,
        emergencyContactName: body.emergencyContactName?.trim() || null, emergencyContactPhone: normalizePhoneMx(body.emergencyContactPhone),
      };
      if (body.email && !dado.email) throw validation('El correo no parece válido');
      const tiene: Record<(typeof MEMBER_COMPLETABLE_FIELDS)[number], unknown> = {
        phoneE164: socio.phoneE164, email: socio.email, birthDate: socio.birthDate,
        emergencyContactName: socio.emergencyContactName, emergencyContactPhone: socio.emergencyContactPhone,
      };
      const filled: string[] = [];
      const skipped: string[] = [];
      for (const k of MEMBER_COMPLETABLE_FIELDS) {
        if (dado[k] === null) continue;
        (tiene[k] ? skipped : filled).push(k);
      }

      const repo = new ResponsibleRepository(orgId);
      const actual = await repo.de(id);
      const celular = filled.includes('phoneE164') ? dado.phoneE164 : socio.phoneE164;
      // El responsable también es un dato que solo se llena si falta.
      const responsable = filled.includes('phoneE164') || (body.responsible && !actual?.responsibleKind)
        ? await prepararResponsable(orgId, { phoneE164: celular, responsible: actual?.responsibleKind ? undefined : body.responsible, memberId: id, yaTiene: !!actual?.responsibleKind })
        : undefined;
      if (body.responsible && actual?.responsibleKind) skipped.push('responsible');

      const despues = await enUnaTransaccion(async () => {
        const m = filled.length > 0 ? await members.update(id, {
          ...(filled.includes('phoneE164') ? { phoneE164: dado.phoneE164 } : {}),
          ...(filled.includes('email') ? { email: dado.email } : {}),
          ...(filled.includes('birthDate') ? { birthDate: new Date(`${dado.birthDate}T00:00:00.000Z`) } : {}),
          ...(filled.includes('emergencyContactName') ? { emergencyContactName: dado.emergencyContactName } : {}),
          ...(filled.includes('emergencyContactPhone') ? { emergencyContactPhone: dado.emergencyContactPhone } : {}),
        }) : socio;
        if (!m) throw notFound('Socio no encontrado');
        if (responsable) {
          await repo.escribir(id, responsable);
          await asentarResponsable(orgId, id, m.phoneE164, responsable);
          filled.push('responsible');
        }
        if (filled.length > 0) {
          // Qué campos, sin sus valores (SEC-08).
          await audit.record(ctx, {
            action: 'member.complete', resourceType: 'Member', resourceId: id, branchId: socio.homeBranchId,
            afterState: { campos: filled, ...(skipped.length ? { yaTenia: skipped } : {}) },
          });
        }
        return m;
      });
      return { filled, skipped, missingFields: loQueFalta(despues) };
    },
  });
}
