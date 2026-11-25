import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ONBOARDING_DAYS, nextOnboardingStep, notFound, onboardingSteps } from '@gymflow/core';
import { MemberOnboarding } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { isModuleOnAt } from '../../platform/modules/module-state.js';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { MemberRepository } from '../members/index.js';
import { MembershipRepository } from '../memberships/index.js';
import { ChargeRepository } from '../billing/index.js';
import { PlanRepository } from '../catalog/index.js';
import { EnrollmentRepository } from '../access/index.js';
import { PortalAuthRepository } from '../portal/index.js';

const idParam = z.object({ id: z.string().uuid() });
const MS_DIA = 86_400_000;

/** Cuándo se creó la ficha (no su antigüedad declarada, que puede ser de hace años). Solo lectura. */
class FichaCreada extends TenantRepository {
  async cuando(memberId: string): Promise<Date | null> {
    return (await this.db.member.findFirst({ where: this.scope({ id: memberId }), select: { createdAt: true } }))?.createdAt ?? null;
  }
}

/**
 * EL CIERRE DEL ALTA, ÚNICO (auditoría 8, bloque 2.4; 9-01, 9-17).
 *
 * Qué le falta a un socio para terminar su alta, por su ESTADO y no por la
 * puerta por la que entró (QR, interesado o mostrador): vender, cobrar, darle
 * su código del portal, registrar su rostro y completar sus datos. Lo leen el
 * cierre de «Alta aprobada» y «Alta vinculada», el de «Nuevo socio» y, cuando
 * la ficha la sume (bloque 2.2), la franja «Para terminar su alta», que se
 * pinta mientras `show` sea verdadero (`ONBOARDING_DAYS` días desde que nació
 * la ficha). El rostro al final del alta (bloque 2.3) es el paso `FACE`.
 */
export function registerOnboardingRoutes(app: FastifyInstance): void {
  route(app, {
    method: 'GET',
    url: '/members/:id/onboarding',
    module: 'core',
    security: { kind: 'permission', permission: 'members:create' },
    schema: respuesta(200, MemberOnboarding),
    handler: async (request): Promise<MemberOnboarding> => {
      const orgId = request.ctx!.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const socio = await new MemberRepository(orgId).findById(id);
      if (!socio) throw notFound('Socio no encontrado');
      const sede = socio.homeBranchId ?? null;
      // El dinero lo ve quien puede cobrar en la sede del socio: a los demás no se les dice cuánto debe.
      const veDinero = request.holds('billing:statement:read', sede);

      const [creada, membresia, debe, portal, rostros, biometria, portalEncendido] = await Promise.all([
        new FichaCreada(orgId).cuando(id),
        // La vigente o, si no hay, la SUSPENDIDA: quien debe sí tiene plan, y decirle «todavía no tiene plan» mandaba a venderle otro.
        new MembershipRepository(orgId).findCurrentForMember(id),
        veDinero ? new ChargeRepository(orgId).outstandingTotalCents(id) : Promise.resolve(0n),
        new PortalAuthRepository().activeForMember(orgId, id),
        new EnrollmentRepository(orgId).listForMember(id),
        isModuleOnAt(orgId, sede, 'biometrics'),
        isModuleOnAt(orgId, sede, 'member_portal'),
      ]);
      const plan = membresia ? await new PlanRepository(orgId).findById(membresia.planId) : null;
      // Bloque 4.16: quien ya tuvo plan (lo canceló o le venció) ya pasó por la venta de su alta. Antes la franja
      // le volvía a pedir «Vender su membresía · Todavía no tiene plan» como si nunca hubiera comprado.
      const yaTuvoPlan = !membresia && (await new MembershipRepository(orgId).listForMember(id)).length > 0;

      const missingFields: string[] = [];
      if (!socio.birthDate) missingFields.push('birthDate');
      if (!socio.emergencyContactName) missingFields.push('emergencyContactName');
      if (!socio.phoneE164 && !socio.email) missingFields.push('phoneE164');

      const steps = onboardingSteps({
        hasMembership: !!membresia || yaTuvoPlan, owesCents: debe, portalOn: portalEncendido, portalActive: portal.active > 0,
        biometricsOn: biometria, enrolled: rostros.some((r) => r.revokedAt === null), missingFields,
      });
      const next = nextOnboardingStep(steps);
      const daysSinceCreated = creada ? Math.max(0, Math.floor((Date.now() - creada.getTime()) / MS_DIA)) : ONBOARDING_DAYS + 1;
      return {
        memberId: socio.id, memberCode: socio.memberCode, firstName: socio.firstName,
        daysSinceCreated, show: !!next && daysSinceCreated <= ONBOARDING_DAYS,
        steps, next: next?.key ?? null,
        membership: membresia ? { planName: plan?.name ?? null, currentPeriodEnd: membresia.currentPeriodEnd.toISOString().slice(0, 10) } : null,
        owesCents: debe.toString(), missingFields,
      };
    },
  });
}
