import type { FastifyInstance } from 'fastify';
import { notFound } from '@gymflow/core';
import { MemberContactChanges, MemberContactChangesReviewed } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { ContactChangeRepository } from './contact-change.repository.js';
import { MemberRepository } from './member.repository.js';
import { idParam, vista } from './members.serializers.js';

/**
 * LO QUE EL SOCIO CAMBIÓ DESDE SU TELÉFONO, VISTO EN EL MOSTRADOR (auditoría
 * 8, fase 4, bloque 4.8; D-36: «se avisa a recepción»).
 *
 * El cambio ya está hecho: aquí nadie lo aprueba. El mostrador lo VE (en su
 * Inicio y en la ficha) y, cuando el socio viene, confirma con él que fue él.
 * Si no fue él, la gerencia regresa el dato con «Editar datos» y le cierra el
 * portal en sus teléfonos: las dos cosas ya existían.
 *
 * Permiso: el de dar acceso al portal (`members:portal:invite`), que tienen
 * recepción en su sede y la gerencia; no hay permiso nuevo. Los valores solo
 * los ve quien ya ve teléfonos (`vista().contacto`).
 */
export function registerContactChangeRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  route(app, {
    method: 'GET',
    url: '/members/:id/contact-changes',
    security: { kind: 'permission', permission: 'members:portal:invite' },
    schema: respuesta(200, MemberContactChanges),
    handler: async (request): Promise<MemberContactChanges> => {
      const orgId = request.ctx!.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const socio = await new MemberRepository(orgId).findById(id);
      if (!socio) throw notFound('Socio no encontrado');
      request.requirePermission('members:portal:invite', socio.homeBranchId);
      const repo = new ContactChangeRepository(orgId);
      const [filas, pending] = await Promise.all([repo.deSocio(id), repo.pendientesDe(id)]);
      const ve = vista(request, socio.homeBranchId).contacto;
      const quien = await repo.nombresDePersonal([...new Set(filas.map((f) => f.reviewedByUserId).filter((u): u is string => !!u))]);
      return {
        hidden: !ve, pending,
        changes: filas.map((f) => ({
          id: f.id, field: f.field, oldValue: ve ? f.oldValue : null, newValue: ve ? f.newValue : null,
          sharedPhone: f.sharedPhone, responsibleKind: f.responsibleKind, at: f.createdAt.toISOString(),
          reviewedAt: f.reviewedAt ? f.reviewedAt.toISOString() : null,
          reviewedByName: f.reviewedByUserId ? quien.get(f.reviewedByUserId) ?? null : null,
        })),
      };
    },
  });

  /** «Ya lo confirmé con el socio»: deja de salir en el Inicio. Repetirlo no hace nada (0). */
  route(app, {
    method: 'POST',
    url: '/members/:id/contact-changes/review',
    security: { kind: 'permission', permission: 'members:portal:invite' },
    schema: respuesta(200, MemberContactChangesReviewed),
    handler: async (request): Promise<MemberContactChangesReviewed> => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const socio = await new MemberRepository(orgId).findById(id);
      if (!socio) throw notFound('Socio no encontrado');
      request.requirePermission('members:portal:invite', socio.homeBranchId);
      return enUnaTransaccion(async () => {
        const reviewed = await new ContactChangeRepository(orgId).confirmar(id, ctx.tenant.actorUserId ?? null, new Date());
        if (reviewed > 0) {
          await audit.record(ctx, {
            action: 'member.contact.review', resourceType: 'Member', resourceId: id, branchId: socio.homeBranchId, afterState: { reviewed },
          });
        }
        return { reviewed };
      });
    },
  });
}
