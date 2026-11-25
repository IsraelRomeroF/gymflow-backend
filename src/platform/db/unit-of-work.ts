import { AsyncLocalStorage } from 'node:async_hooks';
import { conflict } from '@gymflow/core';
import { getDb, type Db } from './client.js';

const actual = new AsyncLocalStorage<Db>();

/**
 * UNIDAD DE TRABAJO: la operación y su asiento en la bitácora se confirman
 * JUNTOS (OPT2-14). Antes la bitácora se escribía después, en su propia
 * transacción: si esa escritura fallaba, el dinero ya se había movido sin
 * rastro.
 *
 * Dentro de `enUnaTransaccion`, todo repositorio usa la misma transacción sin
 * recibirla por parámetro, y un `$transaction` anidado se ejecuta en ella.
 * La bitácora toma su candado por organización al final y lo suelta al
 * confirmar: por eso, dentro de una unidad, la bitácora va al ÚLTIMO.
 */
export async function enUnaTransaccion<T>(fn: () => Promise<T>): Promise<T> {
  if (actual.getStore()) return fn();
  return getDb().$transaction(
    (tx) => actual.run(anidable(tx as unknown as Db), fn),
    { timeout: 15_000, maxWait: 10_000 },
  ) as Promise<T>;
}

/** El cliente vigente: la transacción de la unidad en curso, o el compartido. */
export function dbActual(): Db {
  return actual.getStore() ?? getDb();
}

/**
 * PUNTO DE RETORNO dentro de la unidad en curso (bloque 4.16): si `fn` falla, se deshace SOLO lo que
 * hizo `fn` y lo anterior de la unidad se confirma igual. Devuelve el error en vez de lanzarlo, para
 * que quien llama lo lance DESPUÉS de confirmar. Lo usa el corte: el conteo queda aunque el cierre se rechace.
 */
export async function conPuntoDeRetorno<T>(fn: () => Promise<T>): Promise<{ ok: true; valor: T } | { ok: false; error: unknown }> {
  const db = actual.getStore();
  if (!db) throw new Error('conPuntoDeRetorno: solo dentro de una unidad de trabajo');
  await db.$executeRawUnsafe('SAVEPOINT punto_de_retorno');
  try {
    const valor = await fn();
    await db.$executeRawUnsafe('RELEASE SAVEPOINT punto_de_retorno');
    return { ok: true, valor };
  } catch (error) {
    await db.$executeRawUnsafe('ROLLBACK TO SAVEPOINT punto_de_retorno');
    return { ok: false, error };
  }
}

/** Un cliente de transacción al que se le puede volver a pedir `$transaction`. */
function anidable(tx: Db): Db {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return async (arg: unknown) => {
          if (typeof arg === 'function') return (arg as (t: Db) => unknown)(receiver as Db);
          const out: unknown[] = [];
          for (const p of arg as Array<Promise<unknown>>) out.push(await p);
          return out;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** El mismo número que usa la bitácora (`platform/audit/audit.repository.ts`) para su candado por organización. */
const CANDADO_DE_BITACORA = 42;
/** Lo más que una operación de dinero espera su turno antes de rendirse sin haber tocado nada. */
const ESPERA_DE_TURNO_MS = 10_000;

/**
 * UNIDAD DE DINERO (fase 1, bloque 1.3): una unidad de trabajo que, antes de
 * leer o escribir nada, toma el candado de la organización —el mismo que toma
 * la bitácora al asentar— y lo conserva hasta confirmar.
 *
 * Por qué: un cobro reservaba el folio (candado de la caja) y después pedía
 * el candado de la bitácora; una venta o una decisión de adeudo asentaban
 * primero la bitácora y después pedían el folio. Dos peticiones a la vez, en
 * dos cajas o en la misma, se esperaban una a la otra hasta que la base
 * cortaba a una de las dos (500 «deadlock detected»). Con el candado de la
 * organización al principio el orden es uno solo: bitácora → caja → cargos →
 * membresía. Las operaciones de dinero de un gimnasio pasan de una en una
 * (cada una dura décimas de segundo); las lecturas no esperan a nadie.
 *
 * Como todo se lee DESPUÉS de tener el turno, un doble envío ya encuentra
 * hecho lo que hizo el primero (su pago por llave, su membresía ya movida).
 *
 * Dentro de otra unidad de trabajo se suma a ella: toma el candado en ese
 * momento. Si la de afuera ya reservó un folio antes, el orden vuelve a ser
 * el viejo: quien envuelva dinero debe abrir la unidad con esta función.
 */
export async function enUnidadDeDinero<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
  return enUnaTransaccion(async () => {
    const db = dbActual();
    try {
      // El turno se espera más que cualquier otro candado (5 s por omisión): en
      // una ráfaga es normal hacer fila; lo que no es normal es esperar dentro.
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = ${ESPERA_DE_TURNO_MS}`);
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, ${CANDADO_DE_BITACORA}))`;
      await db.$executeRawUnsafe('SET LOCAL lock_timeout = DEFAULT');
    } catch (err) {
      if (/55P03|lock timeout|lock_not_available/i.test(String((err as { message?: unknown })?.message ?? err))) {
        // 409: no se registró nada y se puede reintentar tal cual.
        throw conflict('Hay otra operación de dinero en curso en este gimnasio. No se registró nada: espera unos segundos y vuelve a intentarlo', 'MONEY_OPERATION_IN_PROGRESS');
      }
      throw err;
    }
    return fn();
  });
}
