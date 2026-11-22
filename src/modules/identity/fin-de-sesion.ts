/**
 * POR QUÉ TERMINÓ UNA SESIÓN DEL PERSONAL O DE LA PLATAFORMA (24-06, 24-07, 24-13).
 *
 * Antes todo 401 decía «Sesión requerida»: la recepcionista dada de baja, la
 * que tenía la sesión vencida y la del gimnasio suspendido veían lo mismo y
 * nadie sabía qué hacer. Ahora el 401 lleva `reason`, estable, y un texto. El
 * panel convierte `reason` en el aviso del login; el texto es para quien lea
 * la API directo (y para el aviso flotante mientras el panel redirige).
 *
 * `reason` es un código, no un texto: no cambia aunque cambie la redacción.
 *
 * La lista y sus textos viven en el NÚCLEO (`SESSION_END_REASONS` y
 * `TEXTO_DE_FIN_DE_SESION`, en `@gymflow/core/vocabulario`; bloque 1.2): la
 * misma que lee el panel para decidir que la sesión terminó. Aquí queda lo
 * que solo sabe la API: de qué causa guardada sale cada motivo.
 *
 * OJO: un 401 de CREDENCIALES (la contraseña de quien firma, la actual al
 * cambiarla, la reconfirmación mal tecleada) no lleva ningún `reason` de esta
 * lista: el panel saca al login a quien reciba uno. Lo fija `test/errores.test.ts`.
 */
import { TEXTO_DE_FIN_DE_SESION, type SessionEndReason } from '@gymflow/core';

export type MotivoDeFin = SessionEndReason;

export type FinDeSesion = { reason: MotivoDeFin; message: string };

export function finDeSesion(reason: MotivoDeFin, message: string = TEXTO_DE_FIN_DE_SESION[reason]): FinDeSesion {
  return { reason, message };
}

export function textoDeFin(reason: MotivoDeFin): string {
  return TEXTO_DE_FIN_DE_SESION[reason];
}

/**
 * De la causa que guardó quien cerró la sesión (`sessions.revokedReason`) al
 * porqué que se le dice a la persona. Las causas viejas o desconocidas dicen
 * solo que se cerró.
 */
const DE_LA_REVOCACION: Record<string, MotivoDeFin> = {
  logout: 'SESSION_LOGGED_OUT',
  replaced: 'SESSION_LOGGED_OUT',
  logout_others: 'SESSION_CLOSED_ELSEWHERE',
  logout_all: 'SESSION_CLOSED_EVERYWHERE',
  password_changed: 'PASSWORD_CHANGED',
  password_reset: 'PASSWORD_RESET',
  deactivated: 'ACCOUNT_DEACTIVATED',
  staff_deactivated: 'ACCOUNT_DEACTIVATED',
  platform_suspend: 'ACCOUNT_DEACTIVATED',
  role_changed: 'ACCESS_CHANGED',
  permissions_changed: 'ACCESS_CHANGED',
  sections_changed: 'ACCESS_CHANGED',
  locked: 'ACCOUNT_LOCKED',
  temporal_vencida: 'TEMPORARY_PASSWORD_EXPIRED',
  idle: 'SESSION_IDLE',
};

export function motivoDeRevocacion(revokedReason: string | null): MotivoDeFin {
  return (revokedReason && DE_LA_REVOCACION[revokedReason]) || 'SESSION_REVOKED';
}
