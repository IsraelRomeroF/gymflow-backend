/**
 * «POR COBRAR» Y LOS SOCIOS DADOS DE BAJA: CUÁNTO CAMBIA LA CIFRA, SIN TOCAR NADA
 * (auditoría 8, fase 4, bloque 4.11; D-12).
 *
 * Solo lee. Hasta la fase 4 la cartera («Por cobrar» del Tablero, «Lo que te
 * deben» del Inicio de la dueña, tramos, reparto por sede y deudores) dejaba
 * fuera lo que debía un socio en cuanto se le daba de baja en su ficha. Desde
 * el bloque 4.11 esa deuda sigue contando hasta que se cobre, se condone con
 * monto o se dé por perdida por plazo (D-18).
 *
 * Para cada gimnasio dice:
 *   1. «Por cobrar» con la regla anterior (sin los dados de baja) y con la
 *      nueva, y la diferencia: es lo que SUBE la cifra al aplicar el cambio.
 *   2. De esa diferencia, cuánto es de fichas ya anonimizadas (deuda que ya no
 *      dice de quién es).
 *   3. Lo dado por perdido de socios dados de baja, que ahora se suma a «Dada
 *      por perdida».
 *
 * Imprime códigos de socio, nunca nombres ni teléfonos. No depende del día:
 * no hay migración ni marca; la cifra cambia al arrancar con el código nuevo.
 *
 * Uso (desde ~/gymflow-backend; usa DATABASE_URL):
 *   pnpm exec tsx scripts/cartera-bajas-estado.ts
 *   pnpm exec tsx scripts/cartera-bajas-estado.ts --org <uuid> --detalle
 * Contra el uso real, con su perfil:
 *   bash scripts/perfil.sh uso-real ./node_modules/.bin/tsx scripts/cartera-bajas-estado.ts
 */
import { loadDotenvFromRepoRoot } from '../src/platform/load-env.js';

loadDotenvFromRepoRoot();

const args = process.argv.slice(2);
const iOrg = args.indexOf('--org');
const soloOrg = iOrg >= 0 ? args[iOrg + 1] ?? '' : null;
const detalle = args.includes('--detalle');
const conocidos = new Set(['--org', '--detalle', ...(soloOrg ? [soloOrg] : [])]);
const raros = args.filter((a) => !conocidos.has(a));
if (raros.length > 0 || (soloOrg !== null && !/^[0-9a-f-]{36}$/i.test(soloOrg))) {
  console.error(`Opción no reconocida: ${raros.join(' ') || '--org sin uuid'}. Se aceptan --org <uuid> y --detalle.`);
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) { console.error('Falta DATABASE_URL.'); process.exit(2); }
const destino = (() => { try { const u = new URL(url); return `${u.pathname.replace(/^\//, '')} (${u.hostname}:${u.port || '5432'})`; } catch { return '(no se pudo leer DATABASE_URL)'; } })();

const { formatMoney, money } = await import('@gymflow/core');
const { getDb, closeDb } = await import('../src/platform/db/client.js');
const { BusinessCalendar } = await import('../src/platform/time/business-calendar.js');
const { PortfolioRepository } = await import('../src/modules/billing/index.js');

const pesos = (c: bigint) => formatMoney(money(c));
const dia = (d: Date) => d.toISOString().slice(0, 10);

console.log(`Base: ${destino}`);
console.log('Solo lectura: este guion no cobra, no condona y no marca nada.');

const db = getDb();
const gimnasios = await db.organization.findMany({
  where: soloOrg ? { id: soloOrg } : {}, select: { id: true, tradeName: true }, orderBy: { tradeName: 'asc' },
});
if (gimnasios.length === 0) console.log('No hay gimnasios que revisar.');

type Fila = { memberCode: string; anonymized: boolean; lost: boolean; cents: bigint; overdue: bigint; charges: number; oldest: Date };

for (const g of gimnasios) {
  const hoy = await new BusinessCalendar(g.id).today(null);
  const filas = await db.$queryRawUnsafe<Fila[]>(`
    SELECT m."memberCode", (m."anonymizedAt" IS NOT NULL) AS "anonymized", (c."lostOn" IS NOT NULL) AS "lost",
           SUM(c."amountCents" - c."allocatedCents" - c."adjustedCents")::bigint AS "cents",
           COALESCE(SUM(c."amountCents" - c."allocatedCents" - c."adjustedCents") FILTER (WHERE c."dueDate" < $2::date), 0)::bigint AS "overdue",
           COUNT(*)::int AS "charges", MIN(c."dueDate") AS "oldest"
      FROM "charges" c
      JOIN "members" m ON m."id" = c."memberId" AND m."deletedAt" IS NOT NULL
     WHERE c."organizationId" = $1::uuid AND c."status" IN ('OPEN','PARTIALLY_PAID','OVERDUE')
     GROUP BY m."id", m."memberCode", m."anonymizedAt", (c."lostOn" IS NOT NULL)
     ORDER BY "cents" DESC`, g.id, hoy);

  const cobrable = filas.filter((f) => !f.lost);
  const perdida = filas.filter((f) => f.lost);
  const suma = (l: Fila[], k: 'cents' | 'overdue') => l.reduce((a, f) => a + f[k], 0n);
  const sube = suma(cobrable, 'cents');
  const ahora = await new PortfolioRepository(g.id).snapshot(hoy);

  console.log(`\n── ${g.tradeName} · hoy ${dia(hoy)} ──`);
  console.log(`1. «Por cobrar» con la regla anterior (sin socios dados de baja): ${pesos(ahora.totalOutstandingCents - sube)}.`);
  console.log(`   «Por cobrar» con la regla nueva (D-12): ${pesos(ahora.totalOutstandingCents)} (${ahora.membersWithDebt} socios).`);
  console.log(`   SUBE ${pesos(sube)}: ${cobrable.reduce((a, f) => a + f.charges, 0)} cargo(s) de ${cobrable.length} socio(s) dados de baja; de eso, vencido ${pesos(suma(cobrable, 'overdue'))}.`);
  const anon = cobrable.filter((f) => f.anonymized);
  console.log(`2. De lo que sube, de fichas ya anonimizadas: ${pesos(suma(anon, 'cents'))} en ${anon.length} ficha(s).`);
  console.log(`3. Dada por perdida de socios dados de baja (se suma a «Dada por perdida», no a «Por cobrar»): ${pesos(suma(perdida, 'cents'))} de ${perdida.length} socio(s).`);
  if (detalle) {
    for (const f of filas) console.log(`   ${f.memberCode}${f.anonymized ? ' (anonimizado)' : ''} · ${pesos(f.cents)} en ${f.charges} cargo(s) · el más antiguo vence ${dia(f.oldest)}${f.lost ? ' · dada por perdida' : ''}`);
  }
}
await closeDb();
