import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict, forbidden } from '@gymflow/core';
import { COACH_CODE, CoachClaimed, PortalCoach } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { DemasiadosIntentos, tiempoParaReintentar } from '../../platform/http/rate-limit.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { StaffRepository, UserRepository } from '../identity/index.js';
import { MemberRepository } from '../members/index.js';
import { requireMemberSession } from '../portal/index.js';
import { CoachLinkRepository } from './coach-link.repository.js';

const coachesActivos = async (orgId: string) =>
  (await new StaffRepository(orgId).list()).filter((u) => u.isActive && u.assignments.some((a) => a.roleKey === 'COACH'));

/**
 * «HACERME SU COACH» (D-29, opción b; fase 3, bloque 3.8).
 *
 * El coach solo ve a sus socios asignados, así que no puede buscar a uno
 * nuevo. El socio SIN coach genera un código en su teléfono y se lo dicta en
 * persona; el coach lo teclea y el socio pasa a ser suyo. Lo conservador:
 *
 *  - seis dígitos, UN solo uso y diez minutos; pedir otro anula el anterior;
 *  - el coach no dice de quién es el código: sin código no hay socio, y un
 *    código que no sirve contesta SIEMPRE lo mismo (no existe, caducó, ya se
 *    usó o el socio ya tiene coach), para que no sirva para averiguar nada;
 *  - cinco fallos en una hora dejan al coach en espera, y la gerencia lo ve en
 *    la bitácora;
 *  - nunca le quita un socio a otro coach: solo liga a quien no tiene.
 *
 * Son del núcleo (`module: 'core'`) y no de Rutinas: de qué coach es cada
 * socio existe aunque el gimnasio no use rutinas.
 */
export function registerCoachLinkRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  async function loDelSocio(organizationId: string, memberId: string): Promise<{ coach: string | null; canAskCode: boolean }> {
    const coachId = await new MemberRepository(organizationId).coachOf(memberId);
    if (coachId) return { coach: (await new UserRepository(organizationId).namesById([coachId])).get(coachId) ?? null, canAskCode: false };
    return { coach: null, canAskCode: (await coachesActivos(organizationId)).length > 0 };
  }

  /** Quién es su coach y si puede pedir un código (no tiene coach y el gimnasio tiene coaches). */
  route(app, {
    method: 'GET', url: '/portal/coach', module: 'core',
    security: { kind: 'member' },
    schema: respuesta(200, PortalCoach),
    handler: async (request): Promise<PortalCoach> => {
      const { organizationId, memberId } = await requireMemberSession(request);
      return { ...await loDelSocio(organizationId, memberId), code: null, expiresAt: null };
    },
  });

  /** El socio genera su código. Es la única vez que el código viaja en claro. */
  route(app, {
    method: 'POST', url: '/portal/coach/code', module: 'core',
    security: { kind: 'member' },
    // Cada código nuevo anula el anterior; el tope solo evita que se generen sin parar.
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    schema: respuesta(201, PortalCoach),
    handler: async (request, reply) => {
      const { organizationId, memberId } = await requireMemberSession(request);
      const suyo = await loDelSocio(organizationId, memberId);
      if (suyo.coach !== null || !suyo.canAskCode) {
        throw conflict(suyo.coach !== null
          ? `Ya tienes coach: ${suyo.coach}. Para cambiarlo, pídelo en recepción.`
          : 'Tu gimnasio todavía no tiene coaches dados de alta.');
      }
      const { code, expiresAt } = await new CoachLinkRepository(organizationId).issue(memberId, new Date());
      const creado: PortalCoach = { coach: null, canAskCode: true, code, expiresAt: expiresAt.toISOString() };
      return reply.status(201).send(creado);
    },
  });

  /** El coach teclea el código que el socio le dictó. */
  route(app, {
    method: 'POST', url: '/coach/claim', module: 'core',
    security: { kind: 'permission', permission: 'members:coach:claim' },
    schema: respuesta(200, CoachClaimed),
    handler: async (request): Promise<CoachClaimed> => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const yo = ctx.tenant.actorUserId!;
      const { code } = z.object({
        code: z.string().trim().regex(new RegExp(`^\\d{${COACH_CODE.digits}}$`), `El código son ${COACH_CODE.digits} números`),
      }).parse(request.body);
      // Se liga a QUIEN teclea, y tiene que ser coach activo: el permiso solo no basta.
      if (!(await coachesActivos(orgId)).some((u) => u.id === yo)) throw forbidden('Solo un coach se suma a un socio con su código');

      const repo = new CoachLinkRepository(orgId);
      const socios = new MemberRepository(orgId);
      const ventana = COACH_CODE.windowMinutes * 60_000;

      type Resultado =
        | { tipo: 'LIGADO'; memberId: string }
        | { tipo: 'EN_ESPERA'; segundos: number }
        | { tipo: 'NO_SIRVE'; quedan: number };

      const r = await enUnaTransaccion(async (): Promise<Resultado> => {
        await repo.lockAttempts(yo);
        const now = new Date();
        const fallos = await repo.recentFailures(yo, now);
        if (fallos.length >= COACH_CODE.maxFailures) {
          // Vuelve cuando el más viejo de los cinco salga de la ventana.
          return { tipo: 'EN_ESPERA', segundos: (fallos[fallos.length - 1]!.getTime() + ventana - now.getTime()) / 1000 };
        }
        const vivo = await repo.findLive(code, now);
        // Bien tecleado se quema siempre: si el socio ya tiene coach, tampoco sirve para otro intento.
        const ligado = vivo !== null && await repo.burn(vivo.id, yo, now) && await socios.setCoachIfNone(vivo.memberId, yo);
        await repo.recordAttempt(yo, ligado, now);
        if (ligado) {
          await audit.record(ctx, {
            action: 'member.coach.claim', resourceType: 'Member', resourceId: vivo.memberId,
            beforeState: { coachUserId: null }, afterState: { coachUserId: yo },
          });
          return { tipo: 'LIGADO', memberId: vivo.memberId };
        }
        const quedan = COACH_CODE.maxFailures - fallos.length - 1;
        // Sin el código ni el socio: la bitácora no guarda con qué se intentó.
        await audit.record(ctx, {
          action: quedan === 0 ? 'member.coach.claim.locked' : 'member.coach.claim.failed', resourceType: 'User', resourceId: yo,
          afterState: { fallosEnLaHora: fallos.length + 1 },
        });
        return { tipo: 'NO_SIRVE', quedan };
      });

      if (r.tipo === 'EN_ESPERA') {
        throw new DemasiadosIntentos(r.segundos, `Demasiados códigos equivocados. Espera ${tiempoParaReintentar(r.segundos)} o pide en recepción que la gerencia te asigne al socio.`);
      }
      if (r.tipo === 'NO_SIRVE') {
        throw conflict(
          `Ese código no sirve o ya caducó. Pídele al socio que genere otro en su teléfono. ${r.quedan === 0 ? 'Ya no te quedan intentos por ahora.' : r.quedan === 1 ? 'Te queda 1 intento.' : `Te quedan ${r.quedan} intentos.`}`,
          'COACH_CODE_INVALID',
        );
      }
      const socio = (await socios.namesByIds([r.memberId])).get(r.memberId);
      return { memberId: r.memberId, fullName: socio?.fullName ?? '', memberCode: socio?.memberCode ?? null };
    },
  });
}
