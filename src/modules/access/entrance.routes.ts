import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound } from '@gymflow/core';
import { AccessAttemptPreview, AccessAttemptResult, AccessGrantResult, AccessResolution, ManualEntryPolicy } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { sedeDeConsulta } from '../../platform/http/branch-scope.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { AccessRepository } from './access.repository.js';
import { AccessService, type FaceAuthorization } from './access.service.js';
import { idParam, respuesta, resueltosDe, serializeDecision } from './access.serializers.js';

/**
 * D-06 · ¿QUIÉN AUTORIZA la entrada de quien no tiene su rostro registrado?
 *
 *   · La gerencia, en su propia sesión (`access:entry:authorize`): el permiso
 *     no viene con el mostrador ni se le puede liberar a recepción.
 *   · O la dueña con su firma (`approvalToken`), en el mostrador o desde su
 *     teléfono, atada a ESE socio: es el camino cuando la gerencia no está.
 *
 * `null` = nadie con autoridad: la entrada no se registra.
 */
async function quienAutoriza(request: FastifyRequest, op: { branchId: string; memberId: string; reason: string; approvalToken?: string | undefined }): Promise<FaceAuthorization | null> {
  const actor = request.ctx!.tenant.actorUserId;
  if (actor && request.holds('access:entry:authorize', op.branchId)) {
    request.authorize('access:entry:authorize', { branchId: op.branchId, reason: op.reason });
    return { byUserId: actor, reason: op.reason, signature: false };
  }
  const firmante = await request.verifyApprover(op.approvalToken, 'access:entry:authorize', { branchId: op.branchId, resourceType: 'Member', resourceId: op.memberId });
  return firmante ? { byUserId: firmante, reason: op.reason, signature: true } : null;
}

/** La puerta: registrar la entrada, la política del mostrador, el paso concedido y lo que pasó. */
export function registerEntranceRoutes(app: FastifyInstance): void {
  const service = new AccessService();

  /**
   * Intento de acceso.
   *
   * En producción lo resuelve el gateway LOCALMENTE (< 10 ms) y esto es el
   * camino de respaldo y el de la pantalla de recepción. La política que se
   * ejecuta aquí es exactamente la misma función.
   */
  route(app, {
    method: 'POST',
    url: '/access/attempts',
    security: { kind: 'permission', permission: 'access:monitor' },
    schema: respuesta(201, AccessAttemptResult),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = z.object({
        branchId: z.string().uuid(),
        memberId: z.string().uuid().nullable().optional(),
        // Sin 'QR' (ADR-032). El valor sigue en la base para leer el historial.
        // Desde una sesión de persona solo se registra la entrada por el
        // mostrador (5-08): huella, PIN y tarjeta los manda el equipo de la
        // puerta y el rostro entra por `/access/face`. Si no, cualquiera con la
        // API registraba «entró con huella» sin lector, sin motivo ni bitácora.
        credentialKind: z.literal('MANUAL', { message: 'Desde el panel solo se registra la entrada por el mostrador: huella, PIN y tarjeta los registra el equipo de la puerta' }),
        gatewayId: z.string().uuid().optional(),
        credentialRevoked: z.boolean().optional(),
        /** Una por intento (un clic, un paso): el repetido devuelve la misma decisión. */
        requestKey: z.string().min(8).max(80).optional(),
        /** Entrada por el mostrador donde hay biometría: el motivo de la excepción. */
        reason: z.string().max(300).optional(),
        /**
         * «Renovar y abrir» (5-25): el rechazo por «sin membresía» que esta
         * entrada resuelve después de venderle su plan. Solo liga si la puerta
         * ahora dice que sí; un rechazo se resuelve una vez (409 si ya lo está).
         */
        resolvesDecisionId: z.string().uuid().optional(),
      }).parse(request.body);

      request.authorize('access:monitor', { branchId: body.branchId });

      const r = await service.attempt(ctx, {
        branchId: body.branchId,
        memberId: body.memberId ?? null,
        credentialKind: body.credentialKind,
        ...(body.gatewayId ? { gatewayId: body.gatewayId } : {}),
        ...(body.credentialRevoked !== undefined ? { credentialRevoked: body.credentialRevoked } : {}),
        ...(body.requestKey ? { requestKey: body.requestKey } : {}),
        ...(body.reason ? { manualReason: body.reason } : {}),
        ...(body.resolvesDecisionId ? { resolvesDecisionId: body.resolvesDecisionId } : {}),
      });

      return reply.status(201).send({
        outcome: r.decision.outcome,
        reason: r.decision.reason,
        warning: r.decision.warning,
        consumedVisit: r.decision.consumesVisit,
        reentry: r.decision.reentry,
        policyVersion: r.decision.policyVersion,
        decisionId: r.record.id,
        attendanceId: r.attendanceId,
        /** ¿Puede recepción levantar este rechazo? (principio 8) */
        overridable: r.decision.overridable,
        /** Cuánto debe. Convierte la puerta cerrada en un cobro posible. */
        outstandingCents: r.outstandingCents?.toString() ?? null,
        minimumCents: r.minimumCents?.toString() ?? null,
        periodsOwed: r.periodsOwed,
      } satisfies AccessAttemptResult);
    },
  });

  /**
   * Lo que PASARÍA (5-03): la misma regla de la puerta sin registrar nada. El
   * diálogo de entrada la llama al abrir; así el veredicto va antes que el
   * motivo y nadie escribe por qué entra por el mostrador quien no entra.
   */
  route(app, {
    method: 'POST',
    url: '/access/attempts/preview',
    security: { kind: 'permission', permission: 'access:monitor' },
    schema: respuesta(200, AccessAttemptPreview),
    handler: async (request, reply) => {
      const body = z.object({ branchId: z.string().uuid(), memberId: z.string().uuid() }).parse(request.body);
      request.authorize('access:monitor', { branchId: body.branchId });
      const r = await service.preview(request.ctx!, body);
      return reply.status(200).send({
        outcome: r.decision.outcome,
        reason: r.decision.reason,
        warning: r.decision.warning,
        wouldConsumeVisit: r.decision.consumesVisit,
        reentry: r.decision.reentry,
        overridable: r.decision.overridable,
        policyVersion: r.decision.policyVersion,
        outstandingCents: r.outstandingCents?.toString() ?? null,
        minimumCents: r.minimumCents?.toString() ?? null,
        periodsOwed: r.periodsOwed,
        creditCents: r.creditCents.toString(),
        policy: r.policy,
      } satisfies AccessAttemptPreview);
    },
  });

  /** Antes de registrar una entrada por el mostrador: ¿es una excepción con motivo? ¿ya tiene biometría? */
  route(app, {
    method: 'GET',
    url: '/access/manual-policy',
    security: { kind: 'permission', permission: 'access:monitor' },
    schema: respuesta(200, ManualEntryPolicy),
    handler: async (request) => {
      const q = z.object({ branchId: z.string().uuid(), memberId: z.string().uuid() }).parse(request.query);
      request.authorize('access:monitor', { branchId: q.branchId });
      return service.politicaManual(request.ctx!, q.branchId, q.memberId);
    },
  });

  /**
   * Concesión manual de recepción.
   *
   * El principio 8 de la visión: si el sistema impidiera dejar pasar a un
   * moroso, el personal encontraría un atajo por fuera y el dato se perdería.
   * Con nombre y motivo, queda registrado. Visibilidad, no prohibición.
   *
   * LA EXCEPCIÓN ES EL ROSTRO (D-06, fase 3): a quien no lo tiene registrado
   * no lo deja pasar recepción con un motivo. Sobre su rechazo
   * `BIOMETRIC_REQUIRED` —o sobre cualquier otro, si le falta el rostro— el
   * paso es la AUTORIZACIÓN de la gerencia para esa visita: la da quien tiene
   * `access:entry:authorize`, o la dueña con su firma (`approvalToken`).
   */
  route(app, {
    method: 'POST',
    url: '/access/decisions/:id/grant',
    security: { kind: 'permission', permission: 'access:manual_grant' },
    schema: respuesta(201, AccessGrantResult),
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        reason: z.string().min(3).max(300),
        /** La firma de la dueña, cuando quien registra no es la gerencia (D-06). */
        approvalToken: z.string().min(20).max(200).optional(),
      }).parse(request.body);

      const original = await new AccessRepository(ctx.tenant.organizationId).findDecision(id);
      if (!original) throw notFound('Decisión no encontrada');

      // El límite de concesiones por turno ALERTA, no bloquea (ADR-009): si
      // bloqueara, volveríamos a empujar al personal fuera del sistema.
      const delDia = await new AccessRepository(ctx.tenant.organizationId).listDecisions({
        branchId: original.branchId, limit: 200,
      });
      request.authorize('access:manual_grant', {
        branchId: original.branchId,
        reason: body.reason,
        shiftUsageCount: delDia.filter((d) => d.overrideReason !== null).length,
      });

      // D-06: sin rostro, el paso lo autoriza la gerencia (o la dueña con su firma). La firma
      // solo se consume si hace falta; si no hay quien autorice, el servicio lo rechaza.
      const sinRostro = original.memberId !== null
        && (original.denialReason === 'BIOMETRIC_REQUIRED' || await service.faltaElRostro(ctx, original.branchId, original.memberId));
      const faceAuthorization = sinRostro && original.memberId
        ? await quienAutoriza(request, { branchId: original.branchId, memberId: original.memberId, reason: body.reason, approvalToken: body.approvalToken })
        : null;

      const r = await service.grantManually(ctx, { decisionId: id, reason: body.reason, faceAuthorization });
      const autorizo = faceAuthorization && r.record.overriddenByUserId === faceAuthorization.byUserId
        ? (await new AccessRepository(ctx.tenant.organizationId).nombresDePersonal([faceAuthorization.byUserId])).get(faceAuthorization.byUserId) ?? null
        : null;
      return reply.status(201).send({
        outcome: r.decision.outcome,
        // Solo si, autorizado y todo, la política dijo que no por otra cosa (p. ej. se suspendió mientras tanto).
        reason: r.decision.reason,
        decisionId: r.record.id,
        attendanceId: r.attendanceId,
        reentry: r.decision.reentry,
        consumedVisit: r.decision.consumesVisit,
        overriddenFrom: id,
        authorizedByName: autorizo,
      } satisfies AccessGrantResult);
    },
  });

  /**
   * ¿Ya se resolvió ese rechazo? Quien espera en el mostrador la autorización
   * de la gerencia (D-06) lo pregunta cada pocos segundos y sigue solo.
   */
  route(app, {
    method: 'GET',
    url: '/access/decisions/:id/resolution',
    security: { kind: 'permission', permission: 'access:monitor' },
    schema: respuesta(200, AccessResolution),
    handler: async (request): Promise<AccessResolution> => {
      const { id } = idParam.parse(request.params);
      const repo = new AccessRepository(request.ctx!.tenant.organizationId);
      const original = await repo.findDecision(id);
      if (!original) throw notFound('Decisión no encontrada');
      request.requirePermission('access:monitor', original.branchId);
      const resolucion = await repo.resolucionDe(id);
      const quien = resolucion?.overriddenByUserId ? (await repo.nombresDePersonal([resolucion.overriddenByUserId])).get(resolucion.overriddenByUserId) ?? null : null;
      return { resolved: resolucion !== null, byName: quien, at: resolucion?.at.toISOString() ?? null };
    },
  });

  route(app, {
    method: 'GET',
    url: '/access/decisions',
    security: { kind: 'permission', permission: 'access:attendance:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const q = z.object({
        branchId: z.string().uuid().optional(),
        memberId: z.string().uuid().optional(),
        outcome: z.enum(['GRANTED', 'DENIED']).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }).parse(request.query);

      const repo = new AccessRepository(ctx.tenant.organizationId);
      const rows = await repo.listDecisions({
        ...q, branchId: sedeDeConsulta(request, 'access:attendance:read', q.branchId) ?? undefined,
      });
      // Quién registró cada excepción (entrada por el mostrador o paso concedido).
      const [nombres, resueltos] = await Promise.all([repo.nombresDePersonal(rows.map((r) => r.overriddenByUserId ?? '')), resueltosDe(repo, rows)]);
      return { decisions: rows.map((r) => ({ ...serializeDecision(r, resueltos), recordedByName: r.overriddenByUserId ? nombres.get(r.overriddenByUserId) ?? null : null })) };
    },
  });

  /** Motivos de rechazo agrupados: la materia prima de la retención (§9). */
  route(app, {
    method: 'GET',
    url: '/access/denials',
    security: { kind: 'permission', permission: 'access:attendance:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const q = z.object({
        days: z.coerce.number().int().min(1).max(90).default(7),
        branchId: z.string().uuid().optional(),
      }).parse(request.query);
      const orgId = ctx.tenant.organizationId;
      const sede = sedeDeConsulta(request, 'access:attendance:read', q.branchId);

      // El día de la sede consultada; sin sede (todo el gimnasio), el del gimnasio (2.13).
      const hoy = await new BusinessCalendar(orgId).today(sede);
      const hasta = new Date(hoy.getTime() + 86_400_000);
      const desde = new Date(hasta.getTime() - q.days * 86_400_000);

      const rows = await new AccessRepository(orgId).denialBreakdown(desde, hasta, sede);
      return {
        from: desde.toISOString().slice(0, 10),
        to: hasta.toISOString().slice(0, 10),
        denials: rows,
        total: rows.reduce((a, r) => a + r.total, 0),
      };
    },
  });
}
