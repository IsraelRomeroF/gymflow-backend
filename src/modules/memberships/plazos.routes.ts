import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PLAZOS_DEL_SOCIO, erroresDePlazos, notFound, plazosCambiados, plazosDelGrupo, sumarDias, validation,
  type GrupoDePlazo, type PlazoKey,
} from '@gymflow/core';
import { MemberStanding, MemberTerms } from '@gymflow/core/contracts';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { PlazosDelSocioRepository, type PlazosDelGimnasio } from '../../platform/plazos/plazos-del-socio.repository.js';
import { MemberRepository } from '../members/index.js';
import { BajaRepository } from './baja.repository.js';

/**
 * LOS PLAZOS DEL SOCIO (D-18; fase 4, bloque 4.4).
 *
 * Una sola definición en el núcleo (`plazos-del-socio.ts`) y un solo lugar
 * donde el gimnasio guarda sus ajustes (`member_term_settings`). Estas rutas
 * los enseñan y los cambian:
 *  - los de RETENCIÓN (dejó de venir, perdido, baja, Recuperar): la gerencia,
 *    con motivo (`retention:terms:set`, bajo la llave de Retención);
 *  - los de la DEUDA (venta sin cobrar, deuda que se da por perdida): la
 *    gerencia, SIEMPRE con la firma de la dueña (`billing:debt-terms:set`,
 *    bajo la llave del Tablero).
 * Un cambio rige desde la siguiente consulta y el siguiente cierre diario; no
 * reescribe nada hacia atrás (una deuda ya dada por perdida no «regresa»).
 */

const serializar = (p: PlazosDelGimnasio): MemberTerms => ({
  terms: { ...p.terms },
  defaults: { ...PLAZOS_DEL_SOCIO },
  customized: [...p.customized],
  updatedAt: p.updatedAt ? p.updatedAt.toISOString() : null,
  updatedByName: p.updatedByName,
});

/** El cuerpo de un ajuste: solo las llaves de ese grupo, todas opcionales, más el motivo. */
function cuerpoDe(group: GrupoDePlazo) {
  const llaves = Object.fromEntries(plazosDelGrupo(group).map((d) => [d.key, z.number().int().optional()])) as Record<PlazoKey, z.ZodOptional<z.ZodNumber>>;
  return z.object({ ...llaves, reason: z.string().trim().min(3).max(300), approvalToken: z.string().min(20).max(200).optional() }).strict();
}

export function registerPlazosRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  /** Los plazos que rigen: los lee cualquier pantalla que diga un plazo (ninguna escribe su número). */
  route(app, {
    method: 'GET',
    url: '/member-terms',
    security: { kind: 'permission', permission: 'members:read', anyOf: ['reports:branch:read', 'reports:financial:read', 'billing:portfolio:read'] },
    schema: respuesta(200, MemberTerms),
    handler: async (request): Promise<MemberTerms> => serializar(await new PlazosDelSocioRepository(request.ctx!.tenant.organizationId).get()),
  });

  async function cambiar(
    request: FastifyRequest,
    group: GrupoDePlazo, permiso: 'retention:terms:set' | 'billing:debt-terms:set', accion: string,
  ): Promise<MemberTerms> {
    const ctx = request.ctx!;
    const orgId = ctx.tenant.organizationId;
    const { reason, approvalToken, ...resto } = cuerpoDe(group).parse(request.body);
    const propuesto = Object.fromEntries(Object.entries(resto).filter(([, v]) => v !== undefined)) as Partial<Record<PlazoKey, number>>;
    if (Object.keys(propuesto).length === 0) throw validation('Indica al menos un plazo que cambiar');

    // La firma, si el permiso la pide (los de la deuda): se ata al gimnasio, como los topes del cajón.
    const aprobador = permiso === 'billing:debt-terms:set'
      ? await request.verifyApprover(approvalToken, permiso, { branchId: null, resourceType: 'MemberTerms', resourceId: orgId })
      : null;
    request.authorize(permiso, { branchId: null, reason, ...(aprobador ? { approvedByUserId: aprobador } : {}) });

    const repo = new PlazosDelSocioRepository(orgId);
    return enUnaTransaccion(async () => {
      const antes = await repo.get();
      const errores = erroresDePlazos(propuesto, antes.terms);
      if (errores.length > 0) throw validation(errores.join(' '));
      const despues = await repo.set(propuesto, ctx.tenant.actorUserId ?? null);
      const cambiaron = plazosCambiados(antes.terms, despues.terms);
      // Guardar lo mismo no es un cambio: no se asienta.
      if (cambiaron.length > 0) {
        const solo = (t: Record<PlazoKey, number>) => Object.fromEntries(cambiaron.map((k) => [k, t[k]]));
        await audit.record(ctx, {
          action: accion, resourceType: 'Organization', resourceId: orgId,
          beforeState: solo(antes.terms), afterState: solo(despues.terms), reason,
          ...(aprobador ? { approvedByUserId: aprobador } : {}),
        });
      }
      return serializar(despues);
    });
  }

  /** Los plazos de retención: la gerencia, con motivo. Recepción y el coach no; la dueña tampoco (no opera). */
  route(app, {
    method: 'PUT',
    url: '/member-terms/retention',
    security: { kind: 'permission', permission: 'retention:terms:set' },
    schema: respuesta(200, MemberTerms),
    handler: (request) => cambiar(request, 'retention', 'retention:terms:set', 'settings.retention_terms.update'),
  });

  /** Los plazos de la deuda: la gerencia, SIEMPRE con la firma de la dueña (dar dinero por perdido es control). */
  route(app, {
    method: 'PUT',
    url: '/member-terms/debt',
    security: { kind: 'permission', permission: 'billing:debt-terms:set' },
    schema: respuesta(200, MemberTerms),
    handler: (request) => cambiar(request, 'debt', 'billing:debt-terms:set', 'billing.debt_terms.update'),
  });

  /**
   * «Está de baja desde» (D-18), calculado: baja por el acto de la ficha, por
   * cancelación o por membresía terminada hace el plazo del gimnasio. Lo lee
   * la ficha. Ninguna regla de conservación (D-32) lo usa todavía: el rostro y
   * la lista de anonimización siguen contando desde el acto «Dar de baja».
   */
  route(app, {
    method: 'GET',
    url: '/members/:id/standing',
    security: { kind: 'permission', permission: 'members:read' },
    schema: respuesta(200, MemberStanding),
    handler: async (request): Promise<MemberStanding> => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      // También el dado de baja en su ficha: de él es justo de quien se pregunta.
      const socio = await new MemberRepository(orgId).findByIdIncludingArchived(id);
      if (!socio) throw notFound('Socio no encontrado');
      const { churnDays } = await new PlazosDelSocioRepository(orgId).terms();
      const hoy = await new BusinessCalendar(orgId).today(socio.homeBranchId ?? null);
      const repo = new BajaRepository(orgId);
      // La deuda solo se le dice a quien ve el estado de cuenta (el coach no: ve a su socio, no su dinero).
      const veDinero = (request.branchScope('billing:statement:read') ?? ['*']).length > 0;
      const [[s], perdida] = await Promise.all([repo.conBaja({ memberIds: [id], churnDays, today: hoy }), veDinero ? repo.deudaPerdidaDe(id) : 0n]);
      const baja = s?.baja ?? null;
      // Terminó y aún no cumple el plazo: el día en que contará como baja.
      const cuenta = !baja && s && !s.hasLive && s.lastStatus === 'EXPIRED' && s.lastEndedOn ? sumarDias(s.lastEndedOn, churnDays) : null;
      return {
        memberId: id, asOf: hoy.toISOString().slice(0, 10),
        churn: baja ? { cause: baja.cause, since: baja.since, endedOn: baja.endedOn } : null,
        churnsOn: cuenta, lostDebtCents: perdida.toString(),
      };
    },
  });
}
