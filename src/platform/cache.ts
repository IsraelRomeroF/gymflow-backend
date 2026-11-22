/**
 * CACHÉ CORTA EN MEMORIA, con una sola llamada en vuelo por clave.
 *
 * Es para lecturas caras que muchas pantallas piden a la vez con los mismos
 * parámetros (el tablero, el pulso de la dueña): la primera petición calcula
 * y las demás esperan ESE resultado en vez de lanzar 20 consultas cada una y
 * acaparar el pool mientras recepción busca a un socio (OPT3-04).
 *
 * Vive en el proceso: con varias instancias cada una tiene la suya, lo que
 * solo cuesta repetir el cálculo una vez por instancia y por vigencia.
 */
type Entrada = { valor: Promise<unknown>; hasta: number };
const memoria = new Map<string, Entrada>();
const TOPE = 2_000;

export function recordar<T>(clave: string, vigenciaMs: number, calcular: () => Promise<T>): Promise<T> {
  const ahora = Date.now();
  const guardada = memoria.get(clave);
  if (guardada && guardada.hasta > ahora) return guardada.valor as Promise<T>;
  if (memoria.size >= TOPE) limpiar(ahora);
  const valor = calcular();
  memoria.set(clave, { valor, hasta: ahora + vigenciaMs });
  // Un cálculo fallido no se sirve a nadie más: la siguiente petición reintenta.
  valor.catch(() => { if (memoria.get(clave)?.valor === valor) memoria.delete(clave); });
  return valor;
}

/** Tira todo lo guardado bajo un prefijo (por ejemplo, lo de una organización). */
function olvidar(prefijo: string): void {
  for (const clave of memoria.keys()) if (clave.startsWith(prefijo)) memoria.delete(clave);
}

function limpiar(ahora: number): void {
  for (const [clave, e] of memoria) if (e.hasta <= ahora) memoria.delete(clave);
  // Si siguen siendo demasiadas, se tiran las más viejas.
  if (memoria.size >= TOPE) for (const clave of [...memoria.keys()].slice(0, memoria.size - TOPE / 2)) memoria.delete(clave);
}

/** Clave estable para un alcance de sedes (`null` = toda la organización). */
export function claveDeSedes(sedes: readonly string[] | null | undefined): string {
  return sedes ? [...sedes].sort().join(',') : '*';
}

/** Los tableros guardados de una organización: tablero y pulso (OPT3-04). */
export function olvidarTableros(organizationId: string): void {
  olvidar(`dashboard:${organizationId}:`);
  olvidar(`pulse:${organizationId}:`);
}
