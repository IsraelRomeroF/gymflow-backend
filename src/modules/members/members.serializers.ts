import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MemberHiddenPart } from '@gymflow/core/contracts';

/**
 * Lo que comparten las rutas del socio: el parámetro `:id`, el consentimiento
 * que se firma (en el alta y después) y cómo se pinta un socio según quién
 * pregunta (SEC2-06).
 */
export const idParam = z.object({ id: z.string().uuid() });

export const consentSchema = z.object({
  consentType: z.enum(['PRIVACY_NOTICE', 'BIOMETRIC', 'RECURRING_CHARGE', 'MARKETING', 'HOUSE_RULES', 'HEALTH_DATA']),
  documentVersion: z.string().min(1),
  /** Se acepta por compatibilidad y se IGNORA: el texto lo resuelve el servidor (PS-06). */
  documentText: z.string().optional(),
  granted: z.boolean(),
});

export type Vista = { dinero: boolean; contacto: boolean };

/**
 * Qué parte del socio ve quien pregunta (SEC2-06): el saldo, con permiso de
 * estado de cuenta; teléfono, correo y contacto de emergencia, con permiso de
 * editar socios. El coach ve a quién atiende, no la cartera ni los teléfonos.
 */
export function vista(request: FastifyRequest, sede: string | null): Vista {
  return {
    dinero: request.holds('billing:statement:read', sede),
    // Teléfono, correo y contacto de emergencia: quien atiende el mostrador
    // (recepción da de alta y consulta sin editar) y quien administra. El
    // coach no los necesita.
    contacto: request.holds('members:update', sede) || request.holds('members:create', sede),
  };
}

export function serializeMember(m: {
  id: string; memberCode: string; firstName: string; lastName: string;
  phoneE164: string | null; email: string | null; birthDate: Date | null;
  status: string; homeBranchId: string | null; joinedAt: Date; balanceCentsCached: bigint;
  emergencyContactName?: string | null; emergencyContactPhone?: string | null;
  anonymizedAt?: Date | null;
  similarity?: number;
}, ver: Vista) {
  // «Oculto por permiso» no es «no tiene» (2.13; 1.1 §7-6): el `null` de abajo
  // va acompañado de qué parte se ocultó, para que la pantalla no lo pinte
  // como un campo vacío en el que escribir da 403.
  const hidden: MemberHiddenPart[] = [...(ver.contacto ? [] : ['contact' as const]), ...(ver.dinero ? [] : ['balance' as const])];
  return {
    id: m.id,
    memberCode: m.memberCode,
    firstName: m.firstName,
    lastName: m.lastName,
    phoneE164: ver.contacto ? m.phoneE164 : null,
    email: ver.contacto ? m.email : null,
    birthDate: m.birthDate ? m.birthDate.toISOString().slice(0, 10) : null,
    status: m.status,
    homeBranchId: m.homeBranchId,
    joinedAt: m.joinedAt.toISOString(),
    emergencyContactName: ver.contacto ? m.emergencyContactName ?? null : null,
    emergencyContactPhone: ver.contacto ? m.emergencyContactPhone ?? null : null,
    anonymizedAt: m.anonymizedAt ? m.anonymizedAt.toISOString() : null,
    // Dinero a JSON como STRING, nunca como number (ADR-005).
    balanceCents: ver.dinero ? m.balanceCentsCached.toString() : null,
    hidden,
    ...(m.similarity !== undefined ? { similarity: Math.round(m.similarity * 1000) / 1000 } : {}),
  };
}
