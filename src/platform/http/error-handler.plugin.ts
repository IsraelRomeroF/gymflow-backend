import type { FastifyInstance } from 'fastify';
import { DomainError, isErrorReason, type ErrorReason } from '@gymflow/core';
import { ZodError } from 'zod';
import { DemasiadosIntentos, tiempoParaReintentar } from './rate-limit.js';
import { RespuestaFueraDeContrato } from './respuesta.js';
import { mensajeDeValidacion, problemasDe, usarZodEnEspanol } from './zod-es.js';

/**
 * Traduce errores de dominio a HTTP sin filtrar detalles internos.
 *
 * Regla importante: un recurso de otro tenant produce 404, NUNCA 403.
 * Un 403 confirmaría que el recurso existe, que es exactamente lo que no
 * queremos revelar (ADR-001).
 *
 * LA FORMA DE TODO ERROR (contrato `ErrorDeLaApi` del núcleo; bloque 1.2):
 *
 *   { error, message, reason?, detail?, issues?, retryAfterSeconds?, requestId }
 *
 * - `error`: la familia (`CONFLICT`, `VALIDATION`…); decide el código HTTP.
 * - `message`: en español, para quien lo lee. Nunca un texto de librería.
 * - `reason`: el porqué ESTABLE, cuando existe (28-13): una clave de
 *   `ERROR_REASONS` del núcleo o, en un 401 de sesión, de `SESSION_END_REASONS`.
 *   Un 401 de credenciales (la contraseña de quien firma, la actual al
 *   cambiarla) NO lleva `reason`: el panel saca al login a quien reciba uno
 *   de sesión.
 * - `issues`: solo el 422 de Zod; cada uno con su campo (`path`) y qué le
 *   pasa, en español (`zod-es.ts`). El `message` los resume con la palabra de
 *   la pantalla: «Celular: Escribe al menos 10 caracteres».
 */
export function registerErrorHandler(app: FastifyInstance): void {
  usarZodEnEspanol();
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (error instanceof DomainError) {
      request.log.info({ code: error.code, detail: error.detail }, 'error de dominio');
      // El 429 dice cuánto esperar, en el cuerpo y en `Retry-After`: el panel
      // y el portal lo usan para la cuenta regresiva (24-02, 28-02).
      const espera = error instanceof DemasiadosIntentos ? error.retryAfterSeconds : undefined;
      if (espera !== undefined) reply.header('retry-after', String(espera));
      const reason = porqueDe(error);
      return reply.status(error.httpStatus).send({
        error: error.code,
        message: error.message,
        ...(reason ? { reason } : {}),
        ...(error.detail ? { detail: error.detail } : {}),
        ...(espera !== undefined ? { retryAfterSeconds: espera } : {}),
        requestId,
      });
    }

    if (error instanceof ZodError) {
      // Qué campo y por qué, en español y con la palabra de la pantalla. Antes:
      // «Datos de entrada inválidos» y, debajo del campo, el inglés de la librería.
      const issues = problemasDe(error);
      return reply.status(422).send({
        error: 'VALIDATION',
        message: mensajeDeValidacion(issues),
        issues,
        requestId,
      });
    }

    // Solo en las pruebas: la respuesta de una ruta no dice lo que su contrato
    // (`respuesta()`). Se contesta con la lista para que la prueba la muestre.
    if (error instanceof RespuestaFueraDeContrato) {
      return reply.status(500).send({
        error: 'CONTRACT_MISMATCH',
        message: error.message,
        requestId,
      });
    }

    // Lo que la BASE rechaza por concurrencia o integridad es un conflicto
    // esperable (dos ventas a la vez, una doble reversa), no un 500: antes
    // quedaba en el log como incidente y el usuario leía "Error interno".
    const db = clasificarErrorDeBase(error);
    if (db) {
      request.log.warn({ err: error, kind: db.error }, 'la base rechazó la operación');
      return reply.status(db.status).send({ ...db, requestId });
    }

    const maybeHttp = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    // Un 429 que no armó `rate-limit.ts` tampoco sale en inglés ni como BAD_REQUEST.
    if (maybeHttp.statusCode === 429) {
      const espera = Math.max(1, Number(reply.getHeader('retry-after')) || 60);
      reply.header('retry-after', String(espera));
      return reply.status(429).send({
        error: 'RATE_LIMITED',
        message: `Demasiados intentos. Espera ${tiempoParaReintentar(espera)} y vuelve a intentar.`,
        reason: 'RATE_LIMITED' satisfies ErrorReason,
        retryAfterSeconds: espera,
        requestId,
      });
    }
    if (typeof maybeHttp.statusCode === 'number' && maybeHttp.statusCode < 500) {
      const codigo = typeof maybeHttp.code === 'string' ? maybeHttp.code : 'BAD_REQUEST';
      return reply.status(maybeHttp.statusCode).send({
        error: codigo,
        // Lo que rechaza Fastify antes de llegar a la ruta llega en inglés: se dice en español.
        message: DE_FASTIFY[codigo] ?? (typeof maybeHttp.message === 'string' ? maybeHttp.message : 'Solicitud inválida'),
        requestId,
      });
    }

    request.log.error({ err: error }, 'error no controlado');
    return reply.status(500).send({
      error: 'INTERNAL',
      message: 'Error interno',
      requestId,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: 'NOT_FOUND', message: 'Ruta no encontrada', requestId: request.id });
  });
}

/**
 * El porqué estable de un error de dominio:
 *  - el que trae (`conflict(texto, 'NO_OPEN_REGISTER')`, `ErrorConMotivo`);
 *  - si no, su `detail` cuando es una clave del catálogo: así se escribían
 *    antes de existir `reason` (`ALREADY_RESOLVED`, `LAST_REGISTER`,
 *    `MODULE_BLOCKED`…) y el `detail` se sigue mandando igual;
 *  - el 429 siempre es `RATE_LIMITED`.
 * Cualquier otro error sale sin `reason`: no se inventa uno.
 */
function porqueDe(error: DomainError): string | undefined {
  if (typeof error.reason === 'string' && error.reason) return error.reason;
  if (isErrorReason(error.detail)) return error.detail;
  if (error.code === 'RATE_LIMITED') return 'RATE_LIMITED' satisfies ErrorReason;
  return undefined;
}

/** Los rechazos de Fastify que una pantalla o un integrador puede provocar, en español. */
const DE_FASTIFY: Readonly<Record<string, string>> = {
  FST_ERR_CTP_EMPTY_JSON_BODY: 'La petición dice llevar datos y llegó vacía',
  FST_ERR_CTP_INVALID_JSON_BODY: 'Los datos enviados no se pudieron leer: no son JSON válido',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'El tipo de contenido de la petición no se acepta: se espera JSON',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'El tamaño declarado de la petición no coincide con lo enviado',
  FST_ERR_CTP_BODY_TOO_LARGE: 'Lo que se envió es demasiado grande',
  FST_ERR_VALIDATION: 'Revisa los datos: hay algo que no es válido',
  FST_ERR_NOT_FOUND: 'Ruta no encontrada',
};

/**
 * Prisma P2002 (unicidad) y los SQLSTATE de CHECK (23514) y desbordamiento
 * numérico (22003), vengan como error conocido de Prisma o crudo del driver.
 * Cada caso con su porqué estable (28-13): «el turno ya se cerró» se
 * distingue de «choca con otra» sin leer el texto.
 */
function clasificarErrorDeBase(error: unknown): { status: number; error: string; message: string; reason: ErrorReason } | null {
  const e = error as { code?: unknown; meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } }; message?: unknown };
  const texto = typeof e.message === 'string' ? e.message : '';
  const sqlstate = [e.code, e.meta?.code, e.meta?.driverAdapterError?.cause?.originalCode]
    .find((c): c is string => typeof c === 'string' && /^\d{5}$/.test(c))
    ?? /\b(23514|22003|23505)\b/.exec(texto)?.[1];

  if (e.code === 'P2002' || sqlstate === '23505') {
    return { status: 409, error: 'CONFLICT', message: 'La operación choca con otra que ya existe o se hizo al mismo tiempo. Recarga y revisa', reason: 'CONCURRENT_CHANGE' };
  }
  if (sqlstate === '23514' && /ya no está abierto/.test(texto)) {
    // El trigger de turnos (BE2-13): el corte se hizo mientras se cobraba.
    return { status: 409, error: 'CONFLICT', message: 'Ese turno de caja ya se cerró. Abre otro turno y vuelve a cobrar', reason: 'CASH_SESSION_CLOSED' };
  }
  if (sqlstate === '23514') {
    return { status: 409, error: 'CONFLICT', message: 'La operación dejaría los datos en un estado no permitido', reason: 'INVALID_STATE' };
  }
  if (sqlstate === '22003') {
    return { status: 422, error: 'VALIDATION', message: 'Un importe o cantidad está fuera de rango', reason: 'VALUE_OUT_OF_RANGE' };
  }
  return null;
}
