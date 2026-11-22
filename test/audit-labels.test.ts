import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hasAuditLabel } from '@gymflow/core';

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? archivos(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Una acción nueva sin frase se nota aquí, no en la pantalla del dueño (DP-05). */
describe('bitácora en palabras', () => {
  it('toda acción que escribe el servidor tiene frase en el núcleo', () => {
    const sinFrase = new Set<string>();
    for (const f of archivos(join(process.cwd(), 'src'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/action: '([a-z_.-]+)'/g)) {
        if (!hasAuditLabel(m[1]!)) sinFrase.add(m[1]!);
      }
    }
    expect([...sinFrase].sort()).toEqual([]);
  });
});
