import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound, conflict } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { contar, registerModuleErasure, registerModuleUsage } from '../../platform/modules/usage.js';
import { rostrosQueBorraApagar } from './rostros-al-apagar.js';
import { MemberRepository } from '../members/index.js';
import { EnrollmentRepository } from './enrollment.repository.js';
import { EnrollmentService } from './enrollment.service.js';
import { BiometricsSummary } from '@gymflow/core/contracts';
import { idParam, respuesta } from './access.serializers.js';

/** Enrolamiento biométrico (ADR-032): registrar, consultar, revocar y comprobar el borrado. */
export function registerBiometricRoutes(app: FastifyInstance): void {
  registerModuleUsage('biometrics', async (orgId) => ({
    inUse: contar(await new EnrollmentRepository(orgId).activeCount(), 'enrolamiento vigente', 'enrolamientos vigentes'),
    blockers: [],
  }));
  // Apagar Biometría borra los rostros a los 30 días (D-32; 3.12): cuántos hay guardados, para el aviso.
  registerModuleErasure('biometrics', async (orgId, branchId) => (await rostrosQueBorraApagar(orgId, branchId ?? null)).length);
  /** La plantilla vive en UNA sucursal (ADR-014): se opera desde ahí. */
  async function sedeDeEnrolamiento(request: FastifyRequest, id: string): Promise<string> {
    const sede = await new EnrollmentRepository(request.ctx!.tenant.organizationId).branchOf(id);
    if (!sede) throw notFound('Enrolamiento no encontrado');
    return sede;
  }

  const enrollments = new EnrollmentService();

  // ── Enrolamiento biométrico (ADR-032) ─────────────────────────────────────

  /**
   * Enrola un rostro o una huella.
   *
   * **Lo que entra aquí es una REFERENCIA, no una plantilla.** El vector lo
   * calcula y lo guarda el equipo de la sucursal; la nube nunca lo ve
   * (ADR-014). Si algún día este endpoint aceptara un vector, sería el día en
   * que GymFlow empezó a custodiar biometría central sin decidirlo.
   */
  route(app, {
    method: 'POST',
    url: '/members/:id/biometric-enrollments',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'access:biometric:enroll' },
    handler: async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({
        modality: z.enum(['FACE', 'FINGERPRINT']),
        branchId: z.string().uuid(),
        templateRef: z.string().min(4).max(200),
        algorithmVendor: z.string().min(2).max(80),
        algorithmVersion: z.string().max(40).nullish().transform((v) => v ?? null),
        reason: z.string().min(3).max(300),
      }).parse(request.body);

      request.authorize('access:biometric:enroll', {
        branchId: body.branchId, reason: body.reason,
      });

      // Una captura SIMULADA (la que genera el navegador mientras el equipo de
      // la sucursal no está conectado) no puede llegar a producción: el socio
      // creería que entra con su rostro y la puerta no lo reconocería.
      if (process.env.NODE_ENV === 'production' && /^(demo|simulado)-/.test(body.templateRef)) {
        throw conflict('El equipo de captura de esta sucursal todavía no está conectado. El registro se hace en cuanto se instale.');
      }

      const enrolled = await enrollments.enroll(request.ctx!, { ...body, memberId: id });
      return reply.status(201).send({
        id: enrolled.id,
        modality: enrolled.modality,
        branchId: enrolled.branchId,
        algorithmVendor: enrolled.algorithmVendor,
        enrolledAt: enrolled.enrolledAt.toISOString(),
      });
    },
  });

  route(app, {
    method: 'GET',
    url: '/members/:id/biometric-enrollments',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'members:consent:read' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const orgId = request.ctx!.tenant.organizationId;

      const { MemberRepository } = await import('../members/index.js');
      if (!await new MemberRepository(orgId).findById(id)) throw notFound('Socio no encontrado');

      const rows = await new EnrollmentRepository(orgId).listForMemberConFirma(id);
      return {
        enrollments: rows.map((e) => ({
          id: e.id,
          modality: e.modality,
          branchId: e.branchId,
          algorithmVendor: e.algorithmVendor,
          consentId: e.consentId,
          enrolledAt: e.enrolledAt.toISOString(),
          revokedAt: e.revokedAt ? e.revokedAt.toISOString() : null,
          templateDeletedAt: e.templateDeletedAt ? e.templateDeletedAt.toISOString() : null,
          // Lo que le falta para servir. Vacío = utilizable.
          gaps: enrollments.gapsOf(e),
          // Bloque 2.3: dónde vive la plantilla (la de la cámara se puede «Actualizar») y qué texto firmó.
          templateKind: e.templateRef.startsWith('servidor:') ? 'server' as const : 'device' as const,
          consentVersion: e.consentVersion,
        })),
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/biometric-enrollments/:id/revoke',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'access:biometric:enroll' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(request.body);
      request.authorize('access:biometric:enroll', { reason, branchId: await sedeDeEnrolamiento(request, id) });
      await enrollments.revoke(request.ctx!, id, reason);
      return { ok: true };
    },
  });

  /**
   * La sucursal confirma que borró la plantilla.
   *
   * Es la PRUEBA de haber cumplido la supresión que exige ADR-014, no la
   * orden de borrar. Sin esta confirmación, el enrolamiento revocado sigue
   * contando como obligación incumplida.
   */
  route(app, {
    method: 'POST',
    url: '/biometric-enrollments/:id/template-deleted',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'access:device:manage' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      request.requirePermission('access:device:manage', await sedeDeEnrolamiento(request, id));
      await enrollments.confirmDeleted(request.ctx!, id);
      return { ok: true };
    },
  });

  /** Las cifras reales de la pantalla Biometría (6-06; bloque 2.3): cuántos rostros hay, sin nombres. */
  route(app, {
    method: 'GET',
    url: '/biometric-enrollments/summary',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'audit:read' },
    schema: respuesta(200, BiometricsSummary),
    handler: async (request) => enrollments.summary(request.ctx!.tenant.organizationId, request.branchScope('audit:read')),
  });

  /** Obligaciones de supresión: vencidas aparte de las que aún están en plazo. */
  route(app, {
    method: 'GET',
    url: '/biometric-enrollments/pending-deletion',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'audit:read' },
    handler: async (request) => {
      const r = await enrollments.pendingDeletions(request.ctx!.tenant.organizationId);
      // Nombre y código viajan aquí (UX 2026-10-08): quien vigila el borrado (el dueño) no lee expedientes, pero sí tiene que saber de quién es.
      const nombres = await new MemberRepository(request.ctx!.tenant.organizationId).namesByIds([...r.overdue, ...r.waiting].map((e) => e.memberId));
      const serializar = (e: { id: string; memberId: string; branchId: string; revokedAt: Date | null }) => ({
        id: e.id, memberId: e.memberId, branchId: e.branchId,
        memberName: nombres.get(e.memberId)?.fullName ?? null, memberCode: nombres.get(e.memberId)?.memberCode ?? null,
        revokedAt: e.revokedAt ? e.revokedAt.toISOString() : null,
      });
      const sedes = request.branchScope('audit:read');
      const mias = <T extends { branchId: string }>(xs: T[]) => (sedes ? xs.filter((e) => sedes.includes(e.branchId)) : xs);
      return {
        overdue: mias(r.overdue).map(serializar),
        waiting: mias(r.waiting).map(serializar),
      };
    },
  });
}
