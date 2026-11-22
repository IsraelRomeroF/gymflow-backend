import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Carga el `.env` de la RAÍZ DEL REPOSITORIO.
 *
 * `dotenv/config` solo mira el directorio de trabajo, así que sin esto la API
 * arranca bien desde la raíz y falla al arrancar desde un subdirectorio — un
 * fallo que aparece en el momento más molesto. Se sube buscando el
 * `package.json` del propio repositorio.
 *
 * En producción no hay `.env`: las variables llegan del entorno y este
 * cargador no hace nada, que es lo correcto.
 */
export function loadDotenvFromRepoRoot(startDir = import.meta.dirname): void {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth++) {
    const pkg = resolve(dir, 'package.json');
    // Se ignora cualquier package.json que esté dentro de node_modules: es de
    // una dependencia, no del repositorio.
    if (existsSync(pkg) && !dir.includes(`${resolve('/')}node_modules`) && !dir.includes('node_modules')) {
      const envPath = resolve(dir, '.env');
      if (existsSync(envPath)) config({ path: envPath, quiet: true });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  config({ quiet: true });
}
