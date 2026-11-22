import { Prisma } from '@gymflow/db';
import type { SedesDelDia } from '../time/business-calendar.js';

/**
 * Filtros «las sedes que hoy comparten fecha» (2.13) para las consultas de los
 * jobs. Los grupos los arma `BusinessCalendar.dias()`; `null` son todas las
 * sedes y la consulta sale sin filtro.
 */

/** Filtro de Prisma para un grupo de sedes: va dentro de `AND`. Vacío si son todas. */
export function dondeSede<K extends string>(campo: K, sedes: SedesDelDia | null): Array<{ OR: Array<Record<K, { in: string[] } | null>> }> {
  if (!sedes) return [];
  const alguna: Array<Record<K, { in: string[] } | null>> = [{ [campo]: { in: [...sedes.branchIds] } } as Record<K, { in: string[] }>];
  if (sedes.sinSede) alguna.push({ [campo]: null } as Record<K, null>);
  return [{ OR: alguna }];
}

/** Las columnas de sede que se filtran en SQL a mano. Lista cerrada: el nombre va tal cual a la consulta. */
export type ColumnaDeSede = 'm."soldAtBranchId"' | 'c."branchId"' | 's."branchId"';

/**
 * Lo mismo para SQL a mano: `AND ${sqlDeSede('m."soldAtBranchId"', sedes)}`. Un
 * repositorio (que sí puede importar `Prisma`) puede pasar otra columna como
 * `Prisma.sql`; fuera de un repositorio solo valen las de la lista.
 */
export function sqlDeSede(nombre: ColumnaDeSede | Prisma.Sql, sedes: SedesDelDia | null): Prisma.Sql {
  if (!sedes) return Prisma.sql`TRUE`;
  const columna = typeof nombre === 'string' ? Prisma.raw(nombre) : nombre;
  const ids = [...sedes.branchIds];
  return sedes.sinSede
    ? Prisma.sql`(${columna} = ANY(${ids}::uuid[]) OR ${columna} IS NULL)`
    : Prisma.sql`${columna} = ANY(${ids}::uuid[])`;
}
