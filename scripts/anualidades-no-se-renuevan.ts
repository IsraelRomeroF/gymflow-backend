/**
 * ANUALIDADES VIVAS: «SE RENUEVA SOLA» → «NO SE RENUEVA»
 * (auditoría 8, fase 3, bloque 3.5; decisión D-14).
 *
 * Los planes pagados por adelantado nacían «se renueva sola» sin que nadie lo
 * eligiera: al cumplirse el periodo se emitía otra anualidad y, si no se
 * pagaba, el socio quedaba suspendido debiendo algo que no pidió. Desde la
 * fase 0 la venta ya pregunta; faltaban las que YA existen.
 *
 * SIN `--aplicar` SOLO LEE: lista, por gimnasio, cada membresía viva de un plan
 * pagado por adelantado que hoy se renueva sola (código de socio, plan, hasta
 * cuándo está vigente, cuándo se vendió y cuánto se le cobraría al renovarse),
 * y dice cuáles cambiaría y cuáles se conservan. Imprime códigos de socio,
 * nunca nombres.
 *
 * CON `--aplicar` cambia las que no se conservan a «no se renueva» y deja un
 * asiento por cada una en la bitácora. No toca cargos, periodos ni estados: lo
 * único que cambia es qué pasa el día en que su periodo termine (vence y se
 * vuelve a vender, en vez de emitirse otra anualidad). Se puede correr dos
 * veces: la segunda no encuentra nada.
 *
 * Qué se CONSERVA (sigue renovándose sola):
 *   --conservar <id,id,…>        las membresías que se digan (su id sale en la lista)
 *   --elegidas-desde AAAA-MM-DD  las vendidas desde ese día (ya se preguntaba en la venta)
 *
 * Uso (desde ~/gymflow-backend; usa DATABASE_URL, el rol gymflow_app):
 *   pnpm exec tsx scripts/anualidades-no-se-renuevan.ts
 *   pnpm exec tsx scripts/anualidades-no-se-renuevan.ts --org <uuid> --elegidas-desde 2026-11-19
 *   pnpm exec tsx scripts/anualidades-no-se-renuevan.ts --aplicar --conservar <id>,<id> --motivo "Lo decidió la dueña el 24 de noviembre"
 */
import { loadDotenvFromRepoRoot } from '../src/platform/load-env.js';

loadDotenvFromRepoRoot();

const UUID = /^[0-9a-f-]{36}$/i;
const args = process.argv.slice(2);
const valor = (nombre: string): string | null => { const i = args.indexOf(nombre); return i >= 0 ? args[i + 1] ?? '' : null; };
const aplicar = args.includes('--aplicar');
const soloOrg = valor('--org');
const conservarTxt = valor('--conservar');
const desdeTxt = valor('--elegidas-desde');
const motivo = valor('--motivo') ?? 'D-14: el plan pagado por adelantado vence y se vuelve a vender; la anualidad nació «se renueva sola» sin que nadie lo eligiera';

const conValor = ['--org', '--conservar', '--elegidas-desde', '--motivo'];
const conocidos = new Set(['--aplicar', ...conValor, ...conValor.map((n) => valor(n)).filter((v): v is string => v !== null)]);
const raros = args.filter((a) => !conocidos.has(a));
const conservar = new Set((conservarTxt ?? '').split(',').map((x) => x.trim()).filter(Boolean));
const mal = raros.length > 0 ? `Opción no reconocida: ${raros.join(' ')}`
  : soloOrg !== null && !UUID.test(soloOrg) ? '--org pide un uuid'
    : [...conservar].some((id) => !UUID.test(id)) ? '--conservar pide ids de membresía separados por comas'
      : desdeTxt !== null && !/^\d{4}-\d{2}-\d{2}$/.test(desdeTxt) ? '--elegidas-desde pide una fecha AAAA-MM-DD'
        : motivo.trim().length < 3 ? '--motivo pide un texto' : null;
if (mal) { console.error(`${mal}. Opciones: --aplicar, --org <uuid>, --conservar <id,id>, --elegidas-desde AAAA-MM-DD, --motivo "texto".`); process.exit(2); }
const elegidasDesde = desdeTxt ? new Date(`${desdeTxt}T00:00:00.000Z`) : null;

const url = process.env.DATABASE_URL;
if (!url) { console.error('Falta DATABASE_URL.'); process.exit(2); }
const destino = (() => { try { const u = new URL(url); return `${u.pathname.replace(/^\//, '')} (${u.hostname}:${u.port || '5432'})`; } catch { return '(no se pudo leer DATABASE_URL)'; } })();

const { getDb, closeDb } = await import('../src/platform/db/client.js');
const { prepagosQueSeRenuevan, apagarRenovacionDePrepagos } = await import('../src/modules/memberships/index.js');

const dia = (d: Date) => d.toISOString().slice(0, 10);
const pesos = (c: bigint) => `$${(Number(c) / 100).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;

try {
  console.log(`Base: ${destino}`);
  console.log(aplicar ? 'MODO: APLICAR (cambia datos).' : 'MODO: SOLO LECTURA (no cambia nada). Con --aplicar se hace.');
  if (elegidasDesde) console.log(`Se conservan las vendidas desde el ${dia(elegidasDesde)}.`);
  if (conservar.size > 0) console.log(`Se conservan por id: ${[...conservar].join(', ')}`);

  const gimnasios = await getDb().organization.findMany({ where: soloOrg ? { id: soloOrg } : {}, select: { id: true, tradeName: true }, orderBy: { tradeName: 'asc' } });
  if (gimnasios.length === 0) { console.log('No hay gimnasios que revisar.'); process.exit(0); }
  let total = 0; let cambiarian = 0; let cambiadas = 0;
  const sinEncontrar = new Set(conservar);
  for (const g of gimnasios) {
    const lista = await prepagosQueSeRenuevan(g.id, { conservar, elegidasDesde });
    if (lista.length === 0) continue;
    total += lista.length;
    console.log(`\n── ${g.tradeName} (${g.id}) · ${lista.length} ${lista.length === 1 ? 'plan pagado por adelantado se renueva solo' : 'planes pagados por adelantado se renuevan solos'} ──`);
    for (const f of lista) {
      sinEncontrar.delete(f.id);
      console.log(`  ${f.seConserva ? 'SE CONSERVA   ' : 'NO SE RENUEVA '} ${f.memberCode.padEnd(14)} ${f.planName.padEnd(24)} ${f.status.padEnd(9)} vigente hasta ${dia(new Date(f.currentPeriodEnd.getTime() - 86_400_000))} · vendida ${dia(f.createdAt)} · al renovarse cobraría ${pesos(f.priceCents)} · ${f.id}`);
    }
    const porCambiar = lista.filter((f) => !f.seConserva).length;
    cambiarian += porCambiar;
    if (aplicar && porCambiar > 0) {
      const r = await apagarRenovacionDePrepagos(g.id, { conservar, elegidasDesde, reason: motivo });
      cambiadas += r.cambiadas.length;
      console.log(`  → ${r.cambiadas.length} pasaron a «no se renueva»; ${r.conservadas.length} se conservan.`);
    }
  }
  if (sinEncontrar.size > 0) console.log(`\nOjo: estos ids de --conservar no están en la lista (no son planes pagados por adelantado vivos que se renueven solos): ${[...sinEncontrar].join(', ')}`);
  console.log(`\nTotal: ${total} en la lista; ${aplicar ? `${cambiadas} cambiadas a «no se renueva»` : `${cambiarian} cambiarían a «no se renueva»`}, ${total - cambiarian} se conservan.`);
  if (!aplicar && cambiarian > 0) console.log('Nada cambió. Para aplicarlo: la misma orden con --aplicar.');
} finally {
  await closeDb();
}
