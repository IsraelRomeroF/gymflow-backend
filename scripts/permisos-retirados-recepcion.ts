/**
 * LO QUE YA NO SE LE ENCIENDE A RECEPCIÓN (auditoría 8, fase 4, bloque 4.19;
 * respuestas de Israel del 2026-11-25, P-09 y P-10).
 *
 * Anular ventas de la tienda (`pos:sale:void`, que también descarta la marca
 * «por corregir») y leer o teclear la nota de salud (`members:health:read`)
 * ya no se le encienden por persona a nadie de recepción. Desde el despliegue
 * la sesión ya no se los da aunque estén guardados; este guion retira el dato
 * guardado y lo deja en la bitácora.
 *
 * SIN `--aplicar` SOLO LEE: por gimnasio, cuántas personas de recepción tienen
 * guardada alguna de las dos, cuál, y si la cuenta está activa. Imprime el id
 * de la cuenta, nunca nombres ni correos.
 *
 * CON `--aplicar` las quita de lo AGREGADO de cada persona (lo demás de sus
 * excepciones queda igual) y deja un asiento `staff.permissions` por persona,
 * como acto del sistema, con el antes y el después. Se puede correr dos
 * veces: la segunda no encuentra nada.
 *
 * Uso (desde ~/gymflow-backend; usa DATABASE_URL, el rol gymflow_app):
 *   pnpm exec tsx scripts/permisos-retirados-recepcion.ts
 *   pnpm exec tsx scripts/permisos-retirados-recepcion.ts --org <uuid>
 *   pnpm exec tsx scripts/permisos-retirados-recepcion.ts --aplicar --motivo "Lo decidió el dueño el 25 de noviembre"
 * Contra el uso real, solo para contar antes:
 *   bash scripts/perfil.sh uso-real ./node_modules/.bin/tsx scripts/permisos-retirados-recepcion.ts
 */
import { loadDotenvFromRepoRoot } from '../src/platform/load-env.js';

loadDotenvFromRepoRoot();

const UUID = /^[0-9a-f-]{36}$/i;
const args = process.argv.slice(2);
const valor = (nombre: string): string | null => { const i = args.indexOf(nombre); return i >= 0 ? args[i + 1] ?? '' : null; };
const aplicar = args.includes('--aplicar');
const soloOrg = valor('--org');
const motivo = valor('--motivo') ?? 'P-09 y P-10 (2026-11-25): anular ventas y la nota de salud ya no se encienden a recepción';

const conValor = ['--org', '--motivo'];
const conocidos = new Set(['--aplicar', ...conValor, ...conValor.map((n) => valor(n)).filter((v): v is string => v !== null)]);
const raros = args.filter((a) => !conocidos.has(a));
const mal = raros.length > 0 ? `Opción no reconocida: ${raros.join(' ')}`
  : soloOrg !== null && !UUID.test(soloOrg) ? '--org pide un uuid'
    : motivo.trim().length < 3 ? '--motivo pide un texto' : null;
if (mal) { console.error(`${mal}. Opciones: --aplicar, --org <uuid>, --motivo "texto".`); process.exit(2); }

const url = process.env.DATABASE_URL;
if (!url) { console.error('Falta DATABASE_URL.'); process.exit(2); }
const destino = (() => { try { const u = new URL(url); return `${u.pathname.replace(/^\//, '')} (${u.hostname}:${u.port || '5432'})`; } catch { return '(no se pudo leer DATABASE_URL)'; } })();

const { getDb, closeDb } = await import('../src/platform/db/client.js');
const { excepcionesPorRetirar, retirarExcepciones } = await import('../src/modules/identity/index.js');

const NOMBRE: Record<string, string> = { 'pos:sale:void': 'anular ventas de la tienda', 'members:health:read': 'la nota de salud' };

try {
  console.log(`Base: ${destino}`);
  console.log(aplicar ? 'MODO: APLICAR (cambia datos).' : 'MODO: SOLO LECTURA (no cambia nada). Con --aplicar se hace.');
  const gimnasios = await getDb().organization.findMany({ where: soloOrg ? { id: soloOrg } : {}, select: { id: true, tradeName: true }, orderBy: { tradeName: 'asc' } });
  if (gimnasios.length === 0) { console.log('No hay gimnasios que revisar.'); process.exit(0); }
  let total = 0; let hechas = 0;
  const porClave = new Map<string, number>();
  for (const g of gimnasios) {
    const lista = await excepcionesPorRetirar(g.id);
    if (lista.length === 0) continue;
    total += lista.length;
    console.log(`\n── ${g.tradeName} (${g.id}) · ${lista.length} ${lista.length === 1 ? 'persona de recepción' : 'personas de recepción'} ──`);
    for (const e of lista) {
      for (const k of e.retirar) porClave.set(k, (porClave.get(k) ?? 0) + 1);
      console.log(`  ${e.userId} · ${e.isActive ? 'activa' : 'dada de baja'} · tiene encendido: ${e.retirar.map((k) => NOMBRE[k] ?? k).join(' y ')}`);
    }
    if (aplicar) hechas += (await retirarExcepciones(g.id, motivo.trim())).length;
  }
  console.log('');
  if (total === 0) console.log('Nadie de recepción tiene encendida ninguna de las dos. No hay nada que retirar.');
  else {
    console.log(`En total: ${total} ${total === 1 ? 'persona' : 'personas'}. ${[...porClave].map(([k, n]) => `${NOMBRE[k] ?? k}: ${n}`).join(' · ')}.`);
    console.log(aplicar ? `Retiradas, con su asiento en la bitácora: ${hechas}.` : 'Nada cambió. Con --aplicar se retiran, una por persona, con su asiento en la bitácora.');
  }
} finally {
  await closeDb();
}
