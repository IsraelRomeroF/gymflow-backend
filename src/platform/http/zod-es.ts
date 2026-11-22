import { CAMPO, campoDeRuta } from '@gymflow/core';
import { z } from 'zod';

/**
 * ZOD EN ESPAÑOL, EN UN SOLO LUGAR (auditoría 8, 28-13; bloque 1.2).
 *
 * Las rutas validan su entrada con Zod y casi ninguna escribe un mensaje
 * propio: lo que salía en el 422 era el texto de la librería, en inglés
 * («Too small: expected string to have >=3 characters»), y la pantalla lo
 * mostraba tal cual debajo del campo. Aquí se le dice a Zod cómo hablar, una
 * vez, para todos los esquemas (los de hoy y los que vengan):
 *
 *  - un esquema con mensaje propio lo conserva: Zod consulta este mapa solo
 *    cuando el esquema no dice nada («Zona horaria desconocida», «solo se
 *    registra la entrada por el mostrador» siguen igual);
 *  - el mensaje NO nombra el campo: va debajo de él en el formulario. El
 *    nombre lo pone `mensajeDeValidacion` para el `message` de la respuesta,
 *    con la palabra que ve la pantalla (`CAMPO`, del vocabulario del núcleo);
 *  - voz de mostrador: «Falta este dato», no «se esperaba texto, recibido
 *    indefinido».
 *
 * Un esquema escribe su propio mensaje solo cuando la regla es de negocio y
 * este mapa no puede saberla («Un precio distinto al de lista necesita motivo»).
 */

type Asunto = z.core.$ZodRawIssue;

const plural = (n: number | bigint, uno: string, varios: string) => `${n} ${Number(n) === 1 ? uno : varios}`;

/** El texto de un problema de validación, sin el nombre del campo. */
export function textoDeZod(issue: Asunto): string {
  switch (issue.code) {
    case 'invalid_type': {
      // Lo más común con mucho: el campo no vino.
      if (issue.input === undefined || issue.input === null) return 'Falta este dato';
      switch (issue.expected) {
        case 'string': return 'Debe ser un texto';
        case 'number': case 'int': case 'bigint': return 'Debe ser un número';
        case 'boolean': return 'Debe ser sí o no';
        case 'array': return 'Debe ser una lista';
        case 'object': case 'record': return 'Debe ser un grupo de datos';
        case 'date': return 'Debe ser una fecha';
        default: return 'No tiene el tipo de dato esperado';
      }
    }
    case 'invalid_value': {
      const valores = (issue.values as unknown[] | undefined) ?? [];
      if (valores.length === 1) return `Debe ser ${String(valores[0])}`;
      // Las claves son de la API: la pantalla siempre manda una válida; esto lo lee quien integra.
      return valores.length > 0 && valores.length <= 12
        ? `No es una de las opciones permitidas (${valores.map(String).join(', ')})`
        : 'No es una de las opciones permitidas';
    }
    case 'too_small': {
      const min = issue.minimum as number | bigint;
      const incluye = issue.inclusive !== false;
      switch (issue.origin) {
        case 'string':
          // Vacío (o solo espacios) es que falta, pida uno o pida tres.
          if (typeof issue.input === 'string' && issue.input.trim() === '') return 'Falta este dato';
          return Number(min) <= 1 && incluye ? 'Falta este dato' : `Escribe al menos ${plural(min, 'carácter', 'caracteres')}`;
        case 'array': case 'set':
          return `Agrega al menos ${plural(min, 'elemento', 'elementos')}`;
        case 'date': return 'La fecha es demasiado antigua';
        case 'file': return 'El archivo es demasiado pequeño';
        default:
          if (!incluye && Number(min) === 0) return 'Debe ser mayor que cero';
          return incluye ? `Debe ser al menos ${min}` : `Debe ser mayor que ${min}`;
      }
    }
    case 'too_big': {
      const max = issue.maximum as number | bigint;
      const incluye = issue.inclusive !== false;
      switch (issue.origin) {
        case 'string': return `Es demasiado largo: máximo ${plural(max, 'carácter', 'caracteres')}`;
        case 'array': case 'set': return `Son demasiados: máximo ${plural(max, 'elemento', 'elementos')}`;
        case 'date': return 'La fecha es demasiado lejana';
        case 'file': return 'El archivo es demasiado grande';
        default: return incluye ? `Debe ser como máximo ${max}` : `Debe ser menor que ${max}`;
      }
    }
    case 'invalid_format':
      switch (issue.format) {
        case 'email': return 'No es un correo válido';
        case 'uuid': case 'guid': case 'uuidv4': case 'uuidv6': case 'uuidv7': case 'cuid': case 'cuid2': case 'ulid': case 'nanoid':
          return 'No es un identificador válido';
        case 'date': return 'Debe ser una fecha con la forma AAAA-MM-DD';
        case 'datetime': return 'Debe ser una fecha con hora';
        case 'time': return 'Debe ser una hora con la forma HH:MM';
        case 'url': return 'No es una dirección web válida';
        case 'e164': return 'Debe ser un celular con lada';
        case 'starts_with': return `Debe empezar con «${String(issue.prefix)}»`;
        case 'ends_with': return `Debe terminar con «${String(issue.suffix)}»`;
        case 'includes': return `Debe incluir «${String(issue.includes)}»`;
        default: return 'No tiene la forma esperada';
      }
    case 'not_multiple_of': return `Debe ser múltiplo de ${String(issue.divisor)}`;
    case 'unrecognized_keys': {
      const llaves = (issue.keys as string[] | undefined) ?? [];
      return `${llaves.length === 1 ? 'Sobra un dato' : 'Sobran datos'}: ${llaves.join(', ')}`;
    }
    case 'invalid_union': return 'No tiene ninguna de las formas esperadas';
    case 'invalid_key': return 'Tiene una clave que no es válida';
    case 'invalid_element': return 'Tiene un elemento que no es válido';
    default: return 'No es válido';
  }
}

/**
 * Le dice a Zod que hable así. La configuración de Zod es una sola por
 * proceso (vive en `globalThis`), así que también vale para los esquemas del
 * núcleo. Se llama al registrar el manejador de errores.
 */
export function usarZodEnEspanol(): void {
  z.config({ localeError: textoDeZod });
}

export type ProblemaDeCampo = { path: string; message: string };

/** Los `issues` de la respuesta: la ruta del campo y qué le pasa. */
export function problemasDe(error: z.ZodError): ProblemaDeCampo[] {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/**
 * El `message` del 422: qué campo y por qué, con la palabra de la pantalla
 * («Celular: Escribe al menos 10 caracteres · Motivo: Falta este dato»).
 * Un campo sin palabra en `CAMPO` se nombra con su clave: lo lee quien
 * integra, y es mejor que «Datos de entrada inválidos». Hasta tres; si hay
 * más, lo dice.
 */
export function mensajeDeValidacion(problemas: readonly ProblemaDeCampo[], max = 3): string {
  if (problemas.length === 0) return 'Revisa los datos: hay algo que no es válido';
  const frases = problemas.slice(0, max).map((p) => {
    const campo = campoDeRuta(p.path);
    const nombre = CAMPO[campo] ?? (campo || null);
    return nombre ? `${nombre}: ${p.message}` : p.message;
  });
  const resto = problemas.length - frases.length;
  return frases.join(' · ') + (resto > 0 ? ` · y ${resto} más` : '');
}
