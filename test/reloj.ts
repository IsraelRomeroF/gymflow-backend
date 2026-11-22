/**
 * UN RELOJ QUE SE PONE EN OTRA FECHA Y SIGUE CAMINANDO (bloque 1.17b).
 *
 * `vi.setSystemTime` deja el reloj CONGELADO en un instante: sirve para
 * preguntar «¿qué día es a las 05:59:59?» (`reloj.test.ts`), pero una prueba
 * larga que escribe en la bitácora no puede correr con él: la cadena de la
 * bitácora se ordena por la hora de cada asiento, y con el reloj detenido
 * todos los asientos caen en el mismo milisegundo (ver el defecto anotado en
 * `reloj.test.ts`).
 *
 * `ponerReloj('2026-06-10T18:00:00.000Z')` corre `Date` a ese instante y lo
 * deja avanzar al paso del reloj de verdad. Solo cambia `Date` en este
 * proceso: el `now()` de la base sigue siendo el real, así que conviene usar
 * fechas ya pasadas (una sesión «del futuro» no la reconoce la base).
 */
const DateReal = Date;

export function ponerReloj(instante: string): void {
  const desfase = new DateReal(instante).getTime() - DateReal.now();
  class DateCorrido extends DateReal {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(DateReal.now() + desfase);
      else super(...(args as [number]));
    }
    static override now(): number { return DateReal.now() + desfase; }
  }
  globalThis.Date = DateCorrido as unknown as DateConstructor;
}

export function relojReal(): void {
  globalThis.Date = DateReal;
}
