/**
 * LA DEUDA DE FICHAS YA ANONIMIZADAS (auditoría 8, fase 4, bloque 4.18; P-11,
 * Israel 2026-11-25).
 *
 * Desde 4.18, al anonimizar una ficha su deuda pendiente se da por perdida en
 * ese momento: sale de «Por cobrar» y se suma a «Dada por perdida» (no se
 * borra ni se condona). Las fichas anonimizadas ANTES de 4.18 siguen con su
 * deuda en «Por cobrar»; este guion las cuenta y, con `--aplicar`, la marca.
 * El cierre diario (`billing.mark-lost-debt`) hace lo mismo cada noche, así
 * que lo que este guion cuenta sin `--aplicar` es lo que pasará la primera
 * noche con el código de 4.18.
 *
 * Sin `--aplicar` SOLO LEE: por gimnasio, cuántas fichas anonimizadas deben
 * algo, cuántos cargos, cuánto, y en cuánto quedaría «Por cobrar». Con
 * `--detalle`, los códigos de socio (nunca nombres: ya no los tienen).
 *
 * Con `--aplicar` marca (`charges.lostOn` = hoy del gimnasio), un asiento
 * `billing.debt.lost` por ficha y un resumen `billing.debt.lost.anonymized`
 * por gimnasio que va a «Para revisar». Se puede correr dos veces sin daño:
 * solo marca lo que no tiene marca.
 *
 * Uso (desde ~/gymflow-backend; usa DATABASE_URL):
 *   pnpm exec tsx scripts/deuda-de-anonimizados.ts [--org <uuid>] [--detalle] [--aplicar]
 * Contra el uso real, con su perfil (solo lee):
 *   bash scripts/perfil.sh uso-real ./node_modules/.bin/tsx scripts/deuda-de-anonimizados.ts --detalle
 */
import { loadDotenvFromRepoRoot } from '../src/platform/load-env.js';

loadDotenvFromRepoRoot();

const args = process.argv.slice(2);
const iOrg = args.indexOf('--org');
const soloOrg = iOrg >= 0 ? args[iOrg + 1] ?? '' : null;
const detalle = args.includes('--detalle');
const aplicar = args.includes('--aplicar');
const conocidos = new Set(['--org', '--detalle', '--aplicar', ...(soloOrg ? [soloOrg] : [])]);
const raros = args.filter((a) => !conocidos.has(a));
if (raros.length > 0 || (soloOrg !== null && !/^[0-9a-f-]{36}$/i.test(soloOrg))) {
  console.error(`Opción no reconocida: ${raros.join(' ') || '--org sin uuid'}. Se aceptan --org <uuid>, --detalle y --aplicar.`);
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) { console.error('Falta DATABASE_URL.'); process.exit(2); }
const destino = (() => { try { const u = new URL(url); return `${u.pathname.replace(/^\//, '')} (${u.hostname}:${u.port || '5432'})`; } catch { return '(no se pudo leer DATABASE_URL)'; } })();

const { getDb, closeDb } = await import('../src/platform/db/client.js');
const { DeudaPerdidaRepository, marcarDeudaDeAnonimizados } = await import('../src/modules/billing/index.js');
const { BusinessCalendar } = await import('../src/platform/time/business-calendar.js');

const pesos = (c: bigint) => `$${(Number(c) / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

console.log(`Base: ${destino}`);
console.log(aplicar ? 'APLICA: marca como dada por perdida la deuda de fichas ya anonimizadas.' : 'Solo lectura: no marca nada (para marcar: --aplicar).');

const gimnasios = await getDb().organization.findMany({
  where: soloOrg ? { id: soloOrg } : {}, select: { id: true, tradeName: true }, orderBy: { tradeName: 'asc' },
});
if (gimnasios.length === 0) console.log('No hay gimnasios que revisar.');

let total = 0n;
let conDeuda = 0;
for (const g of gimnasios) {
  const cargos = await new DeudaPerdidaRepository(g.id).deAnonimizados(100_000);
  if (cargos.length === 0 && !soloOrg) continue;
  conDeuda += 1;
  const importe = cargos.reduce((a, c) => a + c.balanceCents, 0n);
  const fichas = new Map<string, bigint>();
  for (const c of cargos) fichas.set(c.memberId, (fichas.get(c.memberId) ?? 0n) + c.balanceCents);
  total += importe;
  console.log(`\n── ${g.tradeName} ──`);
  console.log(`Fichas anonimizadas con deuda en «Por cobrar»: ${fichas.size}; cargos: ${cargos.length}; importe: ${pesos(importe)}. «Por cobrar» bajaría en ${pesos(importe)} y «Dada por perdida» subiría en lo mismo.`);
  if (detalle && fichas.size > 0) {
    const codigos = await getDb().member.findMany({ where: { organizationId: g.id, id: { in: [...fichas.keys()] } }, select: { id: true, memberCode: true } });
    const cod = new Map(codigos.map((m) => [m.id, m.memberCode]));
    for (const [id, c] of fichas) console.log(`   ${cod.get(id) ?? id} · ${pesos(c)}`);
  }
  if (aplicar && cargos.length > 0) {
    const dia = (await new BusinessCalendar(g.id).dias()).gimnasio;
    const r = await marcarDeudaDeAnonimizados(g.id, dia);
    console.log(`Marcado el ${dia.toISOString().slice(0, 10)}: ${r.members} ficha(s), ${r.charges} cargo(s), ${pesos(r.amountCents)}${r.errores.length ? `; errores: ${r.errores.length}` : ''}.`);
  }
}
if (conDeuda === 0) console.log('\nNingún gimnasio tiene fichas anonimizadas con deuda en «Por cobrar».');
console.log(`\nTotal de todos los gimnasios: ${pesos(total)}${aplicar ? ' (marcado)' : ' (se marcaría)'}.`);
await closeDb();
