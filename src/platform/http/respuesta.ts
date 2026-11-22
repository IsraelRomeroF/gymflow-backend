import { z } from 'zod';
import { diferenciasConElContrato, type DiferenciaConElContrato } from '@gymflow/core/contracts';

/**
 * UNA SOLA FORMA DE DECLARAR LO QUE RESPONDE UNA RUTA (bloque 1.2).
 *
 *   route(app, { …, schema: respuesta(200, MemberStatement), handler })
 *
 * LA REGLA. Una ruta que adopta un contrato del núcleo lo declara con
 * `respuesta(codigo, Contrato)` y con nada más. El contrato se COMPRUEBA, no
 * se usa para recortar:
 *
 *  - en las pruebas (`NODE_ENV=test`), `route()` compara lo que el handler
 *    devolvió con su contrato (`diferenciasConElContrato`: lo que falta, lo
 *    que cambió de tipo y lo que viene de más). Con una sola diferencia la
 *    ruta responde 500 `CONTRACT_MISMATCH` con la lista: cualquier prueba que
 *    toque esa ruta falla, sin tener que acordarse de mirar el contrato;
 *  - en desarrollo, la diferencia queda en el log y la respuesta sale;
 *  - en producción no se comprueba ni se toca nada: sale lo que el handler
 *    devolvió, que es lo que las pruebas vieron.
 *
 * POR QUÉ ASÍ. En la oleada B hubo dos maneras:
 *  a) `z.toJSONSchema(Contrato)` como `schema.response` de Fastify. Fastify
 *     serializa con ese esquema: quita EN SILENCIO lo que el contrato no
 *     declara (la prueba deja de ver el campo de más), convierte lo que no
 *     cuadra (un `null` donde va texto sale como `""`, un número como texto)
 *     y, si falta un campo obligatorio, responde 500 DESPUÉS de que la
 *     operación ya se hizo (un cobro registrado que la caja ve como error).
 *  b) el tipo de retorno del handler más `diferenciasConElContrato` en la
 *     prueba: no protege a ninguna ruta cuya prueba olvide la comparación.
 * Esta regla se queda con la comprobación de (b), hecha por la plataforma
 * para toda ruta declarada, y no deja que el serializador disfrace nada.
 * Lo que sale de una ruta lo decide su serializador (`serialize*`), que arma
 * el objeto campo por campo; el contrato vigila que no se desvíe.
 *
 * Si algún día se quiere además el recorte de Fastify como defensa, es
 * `SERIALIZAR_CON_EL_CONTRATO = true` aquí: `route()` le pasa entonces el JSON
 * Schema. La comprobación de las pruebas sigue ocurriendo antes del recorte.
 *
 * El tipo de retorno del handler (`Promise<MemberStatement>`) se puede dejar:
 * avisa al compilar. No sustituye a `respuesta()`.
 */
export const SERIALIZAR_CON_EL_CONTRATO = false;

const CONTRATOS = new WeakMap<object, ReadonlyMap<number, z.ZodType>>();

type Codigo = 200 | 201;

/** `codigo`: el de la respuesta buena; una lista si la ruta contesta lo mismo con dos (201 al crear y 200 al repetir). */
export function respuesta(codigo: Codigo | readonly Codigo[], contrato: z.ZodType): { response: Record<number, unknown> } {
  const codigos = typeof codigo === 'number' ? [codigo] : codigo;
  // El objeto es la marca: `route()` lo reconoce y no se lo pasa tal cual a Fastify.
  const response: Record<number, unknown> = Object.fromEntries(codigos.map((c) => [c, contrato]));
  CONTRATOS.set(response, new Map(codigos.map((c) => [c, contrato])));
  return { response };
}

/** Los contratos que una ruta declaró con `respuesta()` (por código HTTP), o null. Lo usa `route()`. */
export function contratosDe(schema: unknown): ReadonlyMap<number, z.ZodType> | null {
  const response = (schema as { response?: unknown } | null | undefined)?.response;
  return response && typeof response === 'object' ? CONTRATOS.get(response) ?? null : null;
}

/**
 * El `schema` que sí se le da a Fastify: el de la ruta sin la marca de
 * `respuesta()` (Fastify no sabe leer un esquema de Zod y rompería el
 * arranque). Con `SERIALIZAR_CON_EL_CONTRATO`, la marca se cambia por su
 * JSON Schema. Una ruta sin `respuesta()` pasa su `schema` intacto.
 */
export function esquemaParaFastify(schema: object | undefined): object | undefined {
  const contratos = contratosDe(schema);
  if (!schema || !contratos) return schema;
  const { response: _marca, ...resto } = schema as { response?: unknown } & Record<string, unknown>;
  if (SERIALIZAR_CON_EL_CONTRATO) {
    return { ...resto, response: Object.fromEntries([...contratos].map(([codigo, contrato]) => [codigo, z.toJSONSchema(contrato)])) };
  }
  return Object.keys(resto).length > 0 ? resto : undefined;
}

/** La respuesta de una ruta no dice lo que su contrato: solo se lanza en las pruebas. */
export class RespuestaFueraDeContrato extends Error {
  constructor(readonly ruta: string, readonly diferencias: readonly DiferenciaConElContrato[]) {
    super(`La respuesta de ${ruta} no cumple su contrato: ${diferencias.slice(0, 8).map((d) => `${d.ruta || '(raíz)'}: ${d.problema}`).join('; ')}`);
    this.name = 'RespuestaFueraDeContrato';
  }
}

/**
 * Lo que el handler devolvió contra su contrato. Se compara como JSON, que es
 * como sale: una fecha es su texto. Lo que no se puede pasar a JSON no se
 * comprueba aquí (fallará al responder, a la vista).
 */
export function diferenciasDeLaRespuesta(contrato: z.ZodType, payload: unknown): DiferenciaConElContrato[] {
  let plano: unknown;
  try { plano = JSON.parse(JSON.stringify(payload)); } catch { return []; }
  return diferenciasConElContrato(contrato, plano);
}
