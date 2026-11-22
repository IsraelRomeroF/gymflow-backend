import type { FastifyRequest } from 'fastify';
import { DomainError, type DomainErrorCode } from '@gymflow/core';
import type { Env } from '../env.js';

/**
 * Un error de dominio con su porqué ESTABLE (`reason`), además del texto.
 *
 * El texto es para quien lo lee; el porqué, para el programa que decide qué
 * hacer: el panel ve `reason` en un 401 y sabe que la sesión terminó y por
 * qué, sin adivinar por el mensaje (24-06). El manejador de errores lo manda
 * tal cual en la respuesta (`{ error, message, reason, requestId }`).
 */
export class ErrorConMotivo extends DomainError {
  declare readonly reason: string;
  constructor(code: DomainErrorCode, message: string, reason: string) {
    // El porqué vive en `DomainError` desde el bloque 1.2 (catálogo `ERROR_REASONS`
    // del núcleo para los de negocio; `SESSION_END_REASONS` para los de sesión).
    super(code, message, undefined, reason);
  }
}

/**
 * El 401 de una ruta que exige sesión, con el porqué que dejó quien resolvió
 * la cookie (`request.sessionEnd`, lo pone el módulo de identidad). Sin
 * cookie no hay nada que contar: `NO_SESSION`.
 */
export function sesionRequerida(request: FastifyRequest): ErrorConMotivo {
  // La sesión sirve, pero es de la consola de plataforma: no tiene panel de gimnasio.
  if (request.platform) return new ErrorConMotivo('UNAUTHENTICATED', 'Esta cuenta es de la plataforma: entra a la consola de GymFlow.', 'PLATFORM_ACCOUNT');
  const fin = request.sessionEnd;
  return new ErrorConMotivo('UNAUTHENTICATED', fin?.message ?? 'Sesión requerida', fin?.reason ?? 'NO_SESSION');
}

/**
 * ¿La petición llegó por https? Detrás del túnel o de un balanceador, la
 * conexión con la API es http y lo dice `X-Forwarded-Proto`. Fastify solo
 * cree esa cabecera si quien conecta está en `TRUSTED_PROXIES`.
 */
export function llegoPorHttps(request: FastifyRequest): boolean {
  return request.protocol === 'https';
}

/**
 * Atributos de las cookies de sesión (personal, plataforma y socio).
 *
 * `secure` en producción y también cuando la petición llega por https: el
 * modo remoto (túnel) es internet aunque el arranque sea de desarrollo, y ahí
 * una cookie sin `Secure` se podía mandar por http (24-03). En la PC del
 * gimnasio, por http, sigue sin `Secure`: si no, el navegador no la guarda.
 *
 * Borrar una cookie exige los mismos `path` y `domain` con que se puso: por
 * eso salir usa esta misma función, sin `expires`.
 */
export function opcionesDeCookie(request: FastifyRequest, env: Env, expires?: Date) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production' || llegoPorHttps(request),
    sameSite: 'lax' as const,
    path: '/',
    // `Max-Age` además de `Expires`: el navegador la cuenta con SU reloj desde
    // que la recibe, así un reloj adelantado no la tira antes de tiempo.
    ...(expires ? { expires, maxAge: Math.max(0, Math.round((expires.getTime() - Date.now()) / 1000)) } : {}),
    ...(env.SESSION_COOKIE_DOMAIN ? { domain: env.SESSION_COOKIE_DOMAIN } : {}),
  };
}
