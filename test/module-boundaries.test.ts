import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import ts from 'typescript';
import { ESLint } from 'eslint';

/**
 * FRONTERAS DE MÓDULO.
 *
 * Esta prueba es la que convierte "backend modular" en una propiedad
 * verificable en vez de una intención. Mientras pase, cada módulo se puede
 * extraer a servicio propio cambiando lo que hay detrás de su `index.ts`;
 * en cuanto se viole una vez, esa promesa deja de ser cierta y hay que
 * rastrear a mano quién depende de qué.
 *
 * Se lee el código fuente, no los imports en runtime: un import de solo-tipo
 * desaparece al compilar pero sigue siendo acoplamiento de diseño.
 */

const SRC = resolve(import.meta.dirname, '../src');
const MODULES = join(SRC, 'modules');

function archivosTs(dir: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(dir)) {
    const p = join(dir, entrada);
    if (statSync(p).isDirectory()) salida.push(...archivosTs(p));
    else if (entrada.endsWith('.ts')) salida.push(p);
  }
  return salida;
}

/**
 * Se leen con el analizador de TypeScript, no con una expresión regular: la
 * que había solo veía comillas simples y no veía `import('...')`, así que
 * una importación dinámica al interior de otro módulo pasaba sin aviso
 * (EST-03). Esto ve `import`, `export … from`, `import type` e `import()`.
 */
function importsDe(archivo: string): string[] {
  return ts.preProcessFile(readFileSync(archivo, 'utf8'), true, true).importedFiles.map((f) => f.fileName);
}

/** Módulo al que apunta un import relativo, o null si sale de `modules/`. */
function moduloDestino(archivo: string, spec: string): { modulo: string; rel: string } | null {
  if (!spec.startsWith('.')) return null;
  const rel = relative(MODULES, resolve(dirname(archivo), spec));
  if (rel.startsWith('..')) return null;
  return { modulo: rel.split('/')[0]!, rel };
}

const esPuerta = (d: { modulo: string; rel: string }) => d.rel === join(d.modulo, 'index.js') || d.rel === join(d.modulo, 'index');

const modulos = readdirSync(MODULES).filter((d) => statSync(join(MODULES, d)).isDirectory());

/** El cierre diario y el corredor de 15 minutos (bloque 1.16). */
const EJECUTABLES_DE_JOBS = [join('platform', 'jobs', 'run-daily.ts'), join('platform', 'jobs', 'run-frequent.ts')];

describe('fronteras de módulo', () => {
  it('hay módulos que verificar', () => {
    expect(modulos.length).toBeGreaterThanOrEqual(5);
  });

  it('cada módulo tiene una ÚNICA puerta pública', () => {
    for (const m of modulos) {
      expect(() => statSync(join(MODULES, m, 'index.ts')), `${m} sin index.ts`).not.toThrow();
    }
  });

  it('ningún módulo alcanza el INTERIOR de otro', () => {
    const violaciones: string[] = [];

    for (const m of modulos) {
      for (const archivo of archivosTs(join(MODULES, m))) {
        for (const spec of importsDe(archivo)) {
          const destino = moduloDestino(archivo, spec);
          if (!destino || destino.modulo === m) continue;   // fuera de modules/ o en su propio módulo
          if (!esPuerta(destino)) {
            violaciones.push(
              `${relative(SRC, archivo)} → '${spec}'  (usa '../${destino.modulo}/index.js')`,
            );
          }
        }
      }
    }

    expect(violaciones, `Fronteras cruzadas:\n  ${violaciones.join('\n  ')}`).toEqual([]);
  });

  it('el index de un módulo NO reexporta el interior de otro', () => {
    const fugas: string[] = [];
    for (const m of modulos) {
      for (const spec of importsDe(join(MODULES, m, 'index.ts'))) {
        if (spec.startsWith('.') && !spec.startsWith('./')) {
          fugas.push(`${m}/index.ts reexporta '${spec}'`);
        }
      }
    }
    expect(fugas, fugas.join('\n')).toEqual([]);
  });

  it('la plataforma NO depende de ningún módulo', () => {
    // La dirección de la dependencia es de módulo → plataforma, nunca al revés.
    // Si se invirtiera, la plataforma dejaría de poder arrancar sin todos los
    // módulos presentes y la extracción de cualquiera se volvería imposible.
    const violaciones: string[] = [];
    for (const archivo of archivosTs(join(SRC, 'platform'))) {
      const rel = relative(SRC, archivo);
      for (const spec of importsDe(archivo)) {
        const destino = moduloDestino(archivo, spec);
        if (!destino) continue;
        // Excepción única y consciente: los dos ejecutables de los jobs (el
        // cierre diario y el corredor de 15 minutos) componen el plan de
        // todos los módulos, igual que `app.ts` compone las rutas.
        // Pero entran por la puerta, como cualquiera.
        if (EJECUTABLES_DE_JOBS.includes(rel) && esPuerta(destino)) continue;
        violaciones.push(`${rel} → '${spec}'`);
      }
    }
    expect(violaciones, `La plataforma no puede depender de módulos:\n  ${violaciones.join('\n  ')}`).toEqual([]);
  });

  it('los módulos no dependen unos de otros EN CÍRCULO', () => {
    // Dos módulos que se necesitan mutuamente son, de hecho, uno solo: no se
    // puede extraer ni probar uno sin el otro. Cuentan también los `import()`.
    const grafo = new Map<string, Set<string>>(modulos.map((m) => [m, new Set<string>()]));
    for (const m of modulos) {
      for (const archivo of archivosTs(join(MODULES, m))) {
        for (const spec of importsDe(archivo)) {
          const destino = moduloDestino(archivo, spec);
          if (destino && destino.modulo !== m) grafo.get(m)!.add(destino.modulo);
        }
      }
    }
    const alcanza = (desde: string, hasta: string, vistos = new Set<string>()): boolean => {
      for (const sig of grafo.get(desde) ?? []) {
        if (sig === hasta) return true;
        if (!vistos.has(sig)) { vistos.add(sig); if (alcanza(sig, hasta, vistos)) return true; }
      }
      return false;
    };
    const enCirculo: string[] = [];
    for (const a of modulos) for (const b of modulos) {
      if (a < b && alcanza(a, b) && alcanza(b, a)) enCirculo.push(`${a} ↔ ${b}`);
    }
    // `billing` cobra contra el turno de caja; la cartera que `cash.routes`
    // leía de `billing` ya vive en `billing` (28-07, fase 1.3). Sin círculos.
    expect(enCirculo, `Módulos en círculo:\n  ${enCirculo.join('\n  ')}`).toEqual([]);
  });

  it('solo los repositorios y la plataforma de datos tocan la base', () => {
    // No basta con vigilar `@gymflow/db`: `getDb()` de la plataforma es el
    // mismo cliente por la puerta de atrás, sin `organizationId` obligatorio
    // y fuera de la unidad de trabajo (EST-02).
    const CLIENTE = join(SRC, 'platform', 'db', 'client');
    const esCliente = (archivo: string, spec: string) =>
      spec.startsWith('.') && resolve(dirname(archivo), spec).replace(/\.(js|ts)$/, '') === CLIENTE;
    const esPaquete = (spec: string) =>
      ['@gymflow/db', '@prisma/client'].some((p) => spec === p || spec.startsWith(`${p}/`));

    const violaciones: string[] = [];
    for (const archivo of archivosTs(SRC)) {
      const rel = relative(SRC, archivo);
      if (rel.endsWith('.repository.ts') || rel.startsWith(join('platform', 'db'))) continue;
      // Los arranques (la API y los dos ejecutables de los jobs) cierran la
      // conexión al terminar. Ninguno consulta por su cuenta: las corridas
      // pasan por `job-runs.repository.ts`.
      const arranque = rel === 'main.ts' || EJECUTABLES_DE_JOBS.includes(rel);
      for (const spec of importsDe(archivo)) {
        if (esPaquete(spec)) violaciones.push(`${rel} → '${spec}'`);
        if (esCliente(archivo, spec) && !arranque) violaciones.push(`${rel} → '${spec}'`);
      }
    }
    expect(violaciones, `Acceso a datos fuera de repositorio:\n  ${violaciones.join('\n  ')}`).toEqual([]);
  });
});

/**
 * La regla de lint se apagó una vez sin que nadie lo notara: dos bloques con
 * la misma regla y el segundo reemplazaba al primero (EST-01). Estas pruebas
 * le pasan a ESLint código prohibido y exigen el error, para que una
 * reorganización de `eslint.config.js` no vuelva a callarla.
 */
describe('las reglas de lint de arquitectura están encendidas', () => {
  const eslint = new ESLint({ cwd: resolve(import.meta.dirname, '..') });
  const errores = async (codigo: string, archivo: string) =>
    (await eslint.lintText(codigo, { filePath: resolve(import.meta.dirname, '..', archivo) }))[0]!.messages
      .filter((m) => m.ruleId === 'no-restricted-imports').length;

  it('un servicio no importa el cliente de base de datos', async () => {
    expect(await errores("import { createPrismaClient } from '@gymflow/db';\nexport const x = createPrismaClient;\n", 'src/modules/identity/ejemplo.service.ts')).toBe(1);
    expect(await errores("import { getDb } from '../../platform/db/client.js';\nexport const x = getDb;\n", 'src/modules/identity/ejemplo.service.ts')).toBe(1);
    expect(await errores("import { getDb } from '../db/client.js';\nexport const x = getDb;\n", 'src/platform/http/ejemplo.ts')).toBe(1);
  });

  it('un repositorio sí', async () => {
    expect(await errores("import type { Db } from '@gymflow/db';\nexport type X = Db;\n", 'src/modules/identity/ejemplo.repository.ts')).toBe(0);
  });

  it('nadie alcanza el interior de otro módulo, tampoco desde una subcarpeta ni un repositorio', async () => {
    expect(await errores("import { x } from '../billing/billing.service.js';\nexport const y = x;\n", 'src/modules/identity/ejemplo.service.ts')).toBe(1);
    expect(await errores("import { x } from '../billing/charge.repository.js';\nexport const y = x;\n", 'src/modules/identity/ejemplo.repository.ts')).toBe(1);
    expect(await errores("import { x } from '../../billing/charge.repository.js';\nexport const y = x;\n", 'src/modules/payments/provider/ejemplo.ts')).toBe(1);
    expect(await errores("import { x } from '../billing/index.js';\nexport const y = x;\n", 'src/modules/identity/ejemplo.service.ts')).toBe(0);
  });
});
