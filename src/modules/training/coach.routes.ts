import type { FastifyInstance } from 'fastify';
import { conflict, isoDate, notFound, validation } from '@gymflow/core';
import { CoachLoad, CoachToday, type CoachMember } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { registrarAntesDeLaBaja } from '../../platform/staff/baja.js';
import { MemberRepository } from '../members/index.js';
import { StaffRepository } from '../identity/index.js';
import { TrainingRepository } from './training.repository.js';
import { idParam } from './training.serializers.js';

/** Sin entrar al gimnasio en estos días o más, el coach lo ve en «Sin venir». */
const DIAS_SIN_VENIR = 7;
/** Cuántas rutinas suyas enseña el inicio. */
const RUTINAS_EN_EL_INICIO = 6;

/** El día del coach: su inicio y lo que pasa con sus socios cuando se da de baja. */
export function registerCoachRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  /**
   * `GET /coach/today` · EL INICIO DEL COACH (12-04). Sus socios (cuántos,
   * quién no tiene rutina, quién no ha venido, a quién toca revisarle la
   * rutina) y las rutinas que armó. Siempre de QUIEN PREGUNTA: no recibe un
   * id, así que nadie mira la cartera de otro. Nada de la afluencia del
   * gimnasio (1-05) ni teléfonos (D-30).
   */
  route(app, {
    method: 'GET', url: '/coach/today',
    security: { kind: 'permission', permission: 'members:read' },
    schema: respuesta(200, CoachToday),
    handler: async (request): Promise<CoachToday> => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const yo = ctx.tenant.actorUserId!;
      const repo = new TrainingRepository(orgId);
      const [socios, rutinas, hoy] = await Promise.all([
        repo.coachMembers(yo),
        repo.routines(false, { createdBy: yo, take: RUTINAS_EN_EL_INICIO }),
        new BusinessCalendar(orgId).today(null),
      ]);
      const hoyIso = isoDate(hoy);
      const limite = new Date(hoy.getTime() - DIAS_SIN_VENIR * 86_400_000);
      const pinta = (s: (typeof socios)[number]): CoachMember => ({
        id: s.id, name: `${s.firstName} ${s.lastName}`, memberCode: s.memberCode, routine: s.routine,
        reviewOn: s.reviewOn ? isoDate(s.reviewOn) : null, lastVisitOn: s.lastVisitOn ? isoDate(s.lastVisitOn) : null,
      });
      return {
        today: hoyIso,
        members: {
          total: socios.length,
          withoutRoutine: socios.filter((s) => s.routine === null).map(pinta),
          // Quien se inscribió esta semana y aún no entra no es alguien que «dejó de venir».
          away: socios.filter((s) => (s.lastVisitOn ? s.lastVisitOn.getTime() <= limite.getTime() : s.createdAt.getTime() <= limite.getTime())).map(pinta),
          toReview: socios.filter((s) => s.reviewOn !== null && isoDate(s.reviewOn) <= hoyIso).map(pinta),
        },
        routines: rutinas.map((r) => ({
          id: r.id, name: r.name, goal: r.goal, level: r.level, days: r.dayNames.length,
          activeMembers: r._count.assignments, updatedAt: r.updatedAt.toISOString(),
        })),
      };
    },
  });

  /** Cuántos socios tiene asignados un coach: Personal lo pregunta antes de darlo de baja (12-07). */
  route(app, {
    method: 'GET', url: '/coaches/:id/members',
    security: { kind: 'permission', permission: 'staff:manage' },
    schema: respuesta(200, CoachLoad),
    handler: async (request): Promise<CoachLoad> => {
      const orgId = request.ctx!.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      if (!await new StaffRepository(orgId).find(id)) throw notFound('Usuario no encontrado');
      return { count: await new MemberRepository(orgId).countCoachedBy(id) };
    },
  });

  /**
   * BAJA DE UN COACH CON SOCIOS (12-07): la baja dice a quién pasan (otro
   * coach activo, o nadie). Sin la respuesta, no hay baja: antes los socios
   * se quedaban apuntando a una cuenta dada de baja y nadie recibía la cartera.
   */
  registrarAntesDeLaBaja(async (ctx, userId, opciones) => {
    const orgId = ctx.tenant.organizationId;
    const socios = new MemberRepository(orgId);
    const cuantos = await socios.countCoachedBy(userId);
    if (cuantos === 0) return;
    const destino = opciones.coachHandover;
    if (!destino) {
      throw conflict(`Tiene ${cuantos} ${cuantos === 1 ? 'socio asignado' : 'socios asignados'}: di a quién ${cuantos === 1 ? 'pasa' : 'pasan'} antes de darle de baja`, 'COACH_HAS_MEMBERS');
    }
    if (destino.toUserId) {
      if (destino.toUserId === userId) throw validation('Sus socios no pueden quedarse con la persona que se da de baja');
      const coach = await new StaffRepository(orgId).find(destino.toUserId);
      if (!coach || !coach.isActive || !coach.assignments.some((a) => a.roleKey === 'COACH')) throw validation('Esa persona no es coach activo del gimnasio');
    }
    const movidos = await socios.handOverCoach(userId, destino.toUserId);
    await audit.record(ctx, {
      action: 'member.coach.handover', resourceType: 'User', resourceId: userId,
      beforeState: { coachUserId: userId, members: movidos }, afterState: { coachUserId: destino.toUserId, members: movidos },
    });
  });
}
