import { hkdfSync } from 'node:crypto';
import { decryptSecret, encryptSecret } from './crypto.js';

/**
 * Datos SENSIBLES en reposo (LFPDPPP art. 3 fr. VI).
 *
 * Cada instalación tiene UNA llave de datos sensibles, `SENSITIVE_DATA_KEY`
 * (32 bytes en base64). De ella se DERIVAN (HKDF), con una etiqueta por uso,
 * las llaves que cifran en la columna con AES-256-GCM (SEC-08); una no sirve
 * para la otra:
 *  - `gymflow/health-notes/v1` (aquí): las notas de salud del socio y del alta
 *    digital, y el token que entrega una firma a distancia mientras se recoge.
 *  - `gymflow/biometria/rostro`: las plantillas del rostro (`access/face.engine.ts`).
 *
 * Antes se llamaba `MFA_ENCRYPTION_KEY` porque nació para los secretos del 2FA,
 * que se retiró el 2026-10-09 (ADR-008). Con ese nombre, alguien podía quitarla
 * «porque ya no se usa» y dejar ilegibles la salud y todos los rostros (21-17).
 * El nombre anterior se acepta UNA versión más, con aviso al arrancar. Cambia el
 * nombre, no el valor: la derivación es la misma y lo cifrado sigue legible.
 * Perderla o reemplazarla es perder esos datos: se respalda aparte del volcado
 * (doc 16 §6).
 *
 * Lo guardado lleva prefijo de versión. Lo que no lo lleva es de antes del
 * cifrado y se devuelve tal cual; `scripts/cifrar-salud.ts` lo pone al día.
 */
export const LLAVE_DATOS = 'SENSITIVE_DATA_KEY';
/** El nombre de antes: se deja de aceptar en la versión siguiente. */
export const LLAVE_DATOS_ANTERIOR = 'MFA_ENCRYPTION_KEY';

/** Etiquetas de derivación. Cambiar una deja ilegible lo que cifró. */
export const ETIQUETA_SALUD = 'gymflow/health-notes/v1';
export const ETIQUETA_ROSTRO = 'gymflow/biometria/rostro';

export type LlaveDeDatos = { valor: string; nombre: typeof LLAVE_DATOS | typeof LLAVE_DATOS_ANTERIOR };

/**
 * La llave de datos sensibles de la configuración: la de nombre propio y, si
 * falta, la del nombre anterior. Con las dos y distintas no se adivina, porque
 * cualquiera de ellas podría ser la que cifró los datos: se pide dejar una.
 */
export function llaveDeDatos(fuente: NodeJS.ProcessEnv = process.env): LlaveDeDatos | null {
  const nueva = fuente[LLAVE_DATOS];
  const anterior = fuente[LLAVE_DATOS_ANTERIOR];
  const hay = (v: string | undefined): v is string => !!v && v.trim().length > 0;
  if (hay(nueva) && hay(anterior) && !Buffer.from(nueva, 'base64').equals(Buffer.from(anterior, 'base64'))) {
    throw new Error(`${LLAVE_DATOS} y ${LLAVE_DATOS_ANTERIOR} tienen valores distintos: deja solo ${LLAVE_DATOS}, con el valor que cifró los datos (el del respaldo)`);
  }
  if (hay(nueva)) return { valor: nueva, nombre: LLAVE_DATOS };
  if (hay(anterior)) return { valor: anterior, nombre: LLAVE_DATOS_ANTERIOR };
  return null;
}

let avisado = false;

/**
 * Con el nombre anterior la API arranca, pero lo dice (una vez por proceso;
 * en las pruebas no, que corren con el `.env` de desarrollo).
 */
export function avisarSiNombreAnterior(llave: LlaveDeDatos, nodeEnv: string): void {
  if (llave.nombre !== LLAVE_DATOS_ANTERIOR || avisado || nodeEnv === 'test') return;
  avisado = true;
  console.warn(`AVISO · ${LLAVE_DATOS_ANTERIOR} es el nombre anterior de ${LLAVE_DATOS}, la llave de los datos sensibles. `
    + `En el .env cambia el nombre y deja el MISMO valor (no generes una llave nueva: dejaría ilegibles la salud y los rostros). `
    + 'La siguiente versión ya no acepta el nombre anterior. Ver doc 16 §6.');
}

/** La llave de UN uso, derivada de la de datos sensibles con su etiqueta. */
export function derivarLlave(etiqueta: string, fuente: NodeJS.ProcessEnv = process.env): Buffer {
  const llave = llaveDeDatos(fuente);
  if (!llave) throw new Error(`Falta ${LLAVE_DATOS}: es la llave de los datos sensibles (notas de salud y rostros)`);
  return Buffer.from(hkdfSync('sha256', Buffer.from(llave.valor, 'base64'), Buffer.alloc(0), etiqueta, 32));
}

const PREFIJO = 'enc:v1:';
let llave: Buffer | null = null;

function llaveSalud(): Buffer {
  llave ??= derivarLlave(ETIQUETA_SALUD);
  return llave;
}

export function cifrarSensible(texto: string | null | undefined): string | null {
  const limpio = texto?.trim();
  if (!limpio) return null;
  return PREFIJO + encryptSecret(limpio, llaveSalud());
}

export function descifrarSensible(guardado: string | null | undefined): string | null {
  if (!guardado) return null;
  if (!guardado.startsWith(PREFIJO)) return guardado;
  return decryptSecret(guardado.slice(PREFIJO.length), llaveSalud());
}

export const estaCifrado = (v: string | null | undefined) => !!v && v.startsWith(PREFIJO);
