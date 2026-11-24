import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '@gymflow/core';
import { FaceAccessResult, FaceCheck, FaceEngineStatus, FaceEnrollmentResult, FaceMeasurementReport } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { firmasBiometricasPorRenovar } from '../members/index.js';
import { AccessService } from './access.service.js';
import { EnrollmentRepository } from './enrollment.repository.js';
import { EnrollmentService } from './enrollment.service.js';
import { FaceMeasurementRepository, FaceMeasurementService } from './face-measure.js';
import { FaceEngine } from './face.engine.js';
import { idParam, respuesta } from './access.serializers.js';
import type { Env } from '../../platform/env.js';

/** La cámara de recepción como lector facial: el motor, el alta del rostro y la estación. */
export function registerFaceRoutes(app: FastifyInstance, env: Env): void {
  const enrollments = new EnrollmentService();
  const service = new AccessService();

  // ── Cámara de recepción como lector (2026-10-09) ─────────────────────────
  // DECISIÓN DEL DUEÑO DEL PRODUCTO, documentada en gymflow-docs (ADR-040): el
  // gimnasio usa la cámara de su PC de recepción como lector facial, igual que
  // las estaciones de HRFlow. La plantilla (no la imagen) vive CIFRADA en el
  // servidor del gimnasio, ligada a su consentimiento, y se borra al revocar.
  const motor = new FaceEngine(env);
  const cuadros = z.array(z.string().min(100).max(600_000)).min(1).max(12);
  const reto = z.enum(['turn_left', 'turn_right', 'move_closer']);

  /** ¿Está encendido el motor facial en este equipo? La pantalla lo dice antes de pedir la cámara. */
  route(app, {
    method: 'GET',
    url: '/access/face/status',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'access:monitor' },
    schema: respuesta(200, FaceEngineStatus),
    // Con qué decide hoy la Estación (bloque 2.3): la pantalla Biometría lo enseña junto al estado del motor.
    handler: async () => ({ ...await motor.disponible(), umbral: motor.umbral, margen: motor.margen, alcance: motor.alcance }),
  });

  /**
   * ¿Sirve esta captura? (6-14; bloque 2.3). El asistente lo pregunta ANTES de
   * habilitar «Registrar»: si no se ve un rostro o no está de frente, se dice
   * con el socio todavía ante la cámara. No guarda nada ni firma nada.
   */
  route(app, {
    method: 'POST',
    url: '/access/face/check',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'access:biometric:enroll' },
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: respuesta(200, FaceCheck),
    handler: async (request) => {
      const body = z.object({ branchId: z.string().uuid(), frames: cuadros }).parse(request.body);
      request.authorize('access:biometric:enroll', { branchId: body.branchId, reason: 'Comprobar la captura antes de registrar' });
      const r = await motor.extraer(body.frames, null, true, { soloDeFrente: true });
      return { ok: r.ok, problema: r.ok ? null : PROBLEMA[r.error] ?? r.error, cuadrosConRostro: r.conRostro, cuadrosDeFrente: r.deFrente } satisfies FaceCheck;
    },
  });

  /** Alta del rostro con la cámara: consentimiento, prueba de vida y plantilla cifrada. */
  route(app, {
    method: 'POST',
    url: '/members/:id/biometric-enrollments/face',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'access:biometric:enroll' },
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: respuesta(201, FaceEnrollmentResult),
    handler: async (request, reply) => {
      const { id } = idParam.parse(request.params);
      // Bloque 2.3: sin `reto` es la captura de frente (6-09) y sin `reason`
      // queda el motivo de oficio (D6-06). Con los dos, como antes.
      const body = z.object({ branchId: z.string().uuid(), frames: cuadros, reto: reto.nullish(), reason: z.string().min(3).max(300).optional() }).parse(request.body);
      request.authorize('access:biometric:enroll', { branchId: body.branchId, reason: body.reason ?? 'Registro de rostro en el mostrador' });
      const enrolled = await enrollments.enrollFace(request.ctx!, motor, { memberId: id, branchId: body.branchId, frames: body.frames, reto: body.reto ?? null, reason: body.reason });
      return reply.status(201).send({
        id: enrolled.id, modality: enrolled.modality, branchId: enrolled.branchId, algorithmVendor: enrolled.algorithmVendor,
        enrolledAt: enrolled.enrolledAt.toISOString(), consentVersion: enrolled.consentVersion,
      } satisfies FaceEnrollmentResult);
    },
  });

  /**
   * «Actualizar» un rostro ya registrado (6-05): el nuevo sustituye al
   * anterior en una operación, sin revocar aparte ni volver a firmar si ya
   * firmó el texto vigente (`documentVersion` es la que leyó, si cambió).
   */
  route(app, {
    method: 'POST',
    url: '/biometric-enrollments/:id/renew',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'access:biometric:enroll' },
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: respuesta(201, FaceEnrollmentResult),
    handler: async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ frames: cuadros, documentVersion: z.string().min(1).max(40).optional() }).parse(request.body);
      const sede = await new EnrollmentRepository(request.ctx!.tenant.organizationId).branchOf(id);
      if (!sede) throw notFound('Enrolamiento no encontrado');
      request.authorize('access:biometric:enroll', { branchId: sede, reason: 'Actualización de rostro' });
      const r = await enrollments.renewFace(request.ctx!, motor, { enrollmentId: id, frames: body.frames, versionLeida: body.documentVersion });
      return reply.status(201).send({
        id: r.enrolled.id, modality: r.enrolled.modality, branchId: r.enrolled.branchId, algorithmVendor: r.enrolled.algorithmVendor,
        enrolledAt: r.enrolled.enrolledAt.toISOString(), consentVersion: r.consentVersion, replacedEnrollmentId: r.replacedId,
      } satisfies FaceEnrollmentResult);
    },
  });

  /** Estación de acceso: la cámara reconoce y se aplica la regla de la puerta. */
  route(app, {
    method: 'POST',
    url: '/access/face',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'access:monitor' },
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: respuesta(200, FaceAccessResult),
    handler: async (request) => {
      const body = z.object({ branchId: z.string().uuid(), frames: cuadros, reto }).parse(request.body);
      request.authorize('access:monitor', { branchId: body.branchId });
      const r = await service.reconocerRostro(request.ctx!, motor, body);
      // Para calibrar con datos reales: qué pasó en cada lectura (sin imágenes ni plantillas).
      request.log.info({ evento: 'lectura_facial', reto: body.reto, cuadros: body.frames.length, reconocido: r.reconocido, ...(r.reconocido ? { outcome: r.resultado.decision.outcome } : { motivo: r.motivo, sinRostro: r.sinRostro }) }, 'lectura facial');
      if (!r.reconocido) return r;
      const d = r.resultado;
      // «Debe volver a firmar» (6-03, 21-09): firmó un texto biométrico anterior
      // al vigente. La Estación se lo avisa; NO cambia si entra (D-06 es fase 3).
      // Si la consulta falla, la puerta no se cae por un aviso: se registra y sigue.
      const debeVolverAFirmar = await firmasBiometricasPorRenovar(request.ctx!.tenant.organizationId, r.memberId)
        .then((x) => x.length > 0)
        .catch((e: unknown) => { request.log.warn({ err: e, memberId: r.memberId }, 'no se pudo revisar la firma biométrica'); return false; });
      return {
        reconocido: true, memberId: r.memberId, memberName: r.memberName,
        outcome: d.decision.outcome, reason: d.decision.reason, warning: d.decision.warning,
        consumedVisit: d.decision.consumesVisit, reentry: d.decision.reentry, decisionId: d.record.id,
        outstandingCents: d.outstandingCents?.toString() ?? null,
        debeVolverAFirmar,
      } satisfies FaceAccessResult;
    },
  });

  // ── Medición del umbral (6-10; bloque 2.3) ────────────────────────────────
  // Mide y propone; NO cambia el umbral ni registra entradas. Lo opera la
  // gerencia (registra rostros y lee la bitácora); la dueña solo consulta.
  const medicion = new FaceMeasurementService();

  route(app, {
    method: 'GET',
    url: '/access/face/measurements',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'audit:read' },
    schema: respuesta(200, FaceMeasurementReport),
    handler: async (request) => medicion.informe(request.ctx!.tenant.organizationId, motor, request.branchScope('audit:read')),
  });

  route(app, {
    method: 'POST',
    url: '/access/face/measurements',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'access:biometric:enroll' },
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request) => {
      const body = z.object({
        branchId: z.string().uuid(), frames: cuadros, reto: reto.nullish(),
        kind: z.enum(['MEMBER', 'STRANGER']), memberId: z.string().uuid().nullish(),
      }).parse(request.body);
      request.authorize('access:biometric:enroll', { branchId: body.branchId, reason: 'Medición del reconocimiento' });
      request.requirePermission('audit:read', body.branchId);
      return medicion.medir(request.ctx!, motor, { branchId: body.branchId, frames: body.frames, reto: body.reto ?? null, kind: body.kind, memberId: body.memberId ?? null });
    },
  });

  /** Descarta un intento mal tomado (se eligió a otro socio, se movió) o, sin `id`, todos: empezar de nuevo. */
  route(app, {
    method: 'POST',
    url: '/access/face/measurements/discard',
    module: 'biometrics',
    security: { kind: 'permission', permission: 'access:biometric:enroll' },
    handler: async (request) => {
      const body = z.object({ attemptId: z.string().uuid().optional(), all: z.literal(true).optional() }).refine((b) => !!b.attemptId !== !!b.all, 'Indica un intento o todos').parse(request.body);
      const repo = new FaceMeasurementRepository(request.ctx!.tenant.organizationId);
      if (body.attemptId) {
        const sede = await repo.sedeDe(body.attemptId);
        if (!sede) throw notFound('Intento no encontrado');
        request.requirePermission('access:biometric:enroll', sede);
        request.requirePermission('audit:read', sede);
        await repo.borrar(body.attemptId);
        return { discarded: 1 };
      }
      request.requirePermission('audit:read');
      return { discarded: await repo.borrarTodos(request.branchScope('audit:read')) };
    },
  });
}

/** Lo que dice el motor, en palabras de mostrador. Lo que no esté aquí sale tal cual. */
const PROBLEMA: Record<string, string> = {
  'No se detectó ningún rostro': 'No se vio su rostro. Que se coloque dentro del óvalo, con la luz de frente y sin gorra ni lentes oscuros.',
  'No se detectó ningún rostro.': 'No se vio su rostro. Que se coloque dentro del óvalo, con la luz de frente y sin gorra ni lentes oscuros.',
  'Sin cuadros': 'La cámara no mandó imagen. Revisa que esté encendida y vuelve a capturar.',
};
