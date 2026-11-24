import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FaceRule, FaceRulePending } from '@gymflow/core/contracts';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { moduleViewOf } from '../../platform/modules/module-state.js';
import { BranchRepository, OrganizationRepository } from '../organization/index.js';
import { AccessRepository } from './access.repository.js';
import { FaceRuleRepository } from './face-rule.repository.js';

/**
 * ENTRAR SOLO CON ROSTRO (auditoría 8, fase 3, bloque 3.3; D-06).
 *
 * «Un socio sin rostro registrado nunca entra, salvo que la gerencia lo
 * autorice en cada visita.» La regla es del gimnasio y nace APAGADA: se
 * enciende aquí cuando ya se pueden registrar rostros en recepción, porque
 * encendida antes la gerencia tendría que autorizar una por una las entradas
 * de todos los que aún no lo tienen. Estas rutas dicen cómo está, a cuántos
 * socios les falta el rostro (y a quiénes) y la encienden o apagan con motivo.
 *
 * Solo pesa en las sucursales que usan Biometría.
 */
export function registerFaceRuleRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  /** Las sucursales que usan Biometría y que quien pregunta alcanza a ver, con sus cuentas. */
  async function sedesConBiometria(orgId: string, alcance: readonly string[] | null) {
    const [sedes, modulos] = await Promise.all([new BranchRepository(orgId).list(), moduleViewOf(orgId)]);
    const repo = new FaceRuleRepository(orgId);
    const visibles = sedes.filter((b) => b.isActive && modulos.at(b.id).has('biometrics') && (alcance === null || alcance.includes(b.id)));
    return Promise.all(visibles.map(async (b) => ({ branchId: b.id, name: b.name, ...(await repo.cuentas(b.id)) })));
  }

  async function estado(orgId: string, alcance: readonly string[] | null): Promise<FaceRule> {
    const org = new OrganizationRepository(orgId);
    const [settings, cambio, branches] = await Promise.all([org.accessSettings(), org.requireFaceLastChange(), sedesConBiometria(orgId, alcance)]);
    const quien = cambio?.byUserId ? (await new AccessRepository(orgId).nombresDePersonal([cambio.byUserId])).get(cambio.byUserId) ?? null : null;
    return { enabled: settings.requireFaceToEnter === true, branches, changedAt: cambio?.at.toISOString() ?? null, changedByName: quien };
  }

  route(app, {
    method: 'GET',
    url: '/access/face-rule',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'access:attendance:read' },
    schema: respuesta(200, FaceRule),
    handler: async (request): Promise<FaceRule> => estado(request.ctx!.tenant.organizationId, request.branchScope('access:attendance:read')),
  });

  /**
   * Enciende o apaga la regla. Es del gimnasio entero (`settings:org`), lleva
   * motivo y queda en la bitácora con cuántos socios se quedan sin entrar por
   * su cuenta en ese momento.
   */
  route(app, {
    method: 'PUT',
    url: '/access/face-rule',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'settings:org' },
    schema: respuesta(200, FaceRule),
    handler: async (request): Promise<FaceRule> => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const body = z.object({
        enabled: z.boolean({ error: 'Di si la regla queda encendida o apagada' }),
        reason: z.string({ error: 'Escribe el motivo del cambio' }).trim().min(3, 'Escribe el motivo del cambio').max(300),
      }).parse(request.body);
      request.requirePermission('settings:org', null);
      const org = new OrganizationRepository(orgId);
      const antes = (await org.accessSettings()).requireFaceToEnter === true;
      if (antes !== body.enabled) {
        const sedes = await sedesConBiometria(orgId, null);
        await enUnaTransaccion(async () => {
          await org.setRequireFaceToEnter(body.enabled, ctx.tenant.actorUserId ?? null);
          await audit.record(ctx, {
            action: 'access.face_rule.change', resourceType: 'Organization', resourceId: orgId, reason: body.reason,
            beforeState: { requireFaceToEnter: antes },
            afterState: {
              requireFaceToEnter: body.enabled,
              membersWithoutFace: sedes.reduce((a, s) => a + s.withoutFace, 0), membersWhoCanEnter: sedes.reduce((a, s) => a + s.canEnter, 0),
            },
          });
        });
      }
      return estado(orgId, null);
    },
  });

  /** A quién le falta el rostro en una sucursal: la lista para irlos registrando. */
  route(app, {
    method: 'GET',
    url: '/access/face-rule/pending',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'members:read' },
    schema: respuesta(200, FaceRulePending),
    handler: async (request): Promise<FaceRulePending> => {
      const q = z.object({ branchId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
      request.requirePermission('members:read', q.branchId);
      const repo = new FaceRuleRepository(request.ctx!.tenant.organizationId);
      const [cuentas, filas] = await Promise.all([repo.cuentas(q.branchId), repo.sinRostro(q.branchId, q.limit)]);
      return {
        total: cuentas.withoutFace,
        members: filas.map((f) => ({ memberId: f.memberId, memberCode: f.memberCode, fullName: f.fullName, lastVisitOn: f.lastVisitOn ? f.lastVisitOn.toISOString().slice(0, 10) : null })),
      };
    },
  });
}
