/**
 * NÓMINA ANOTADA COMO UN TOTAL DEL MES, SIN TOCAR NADA
 * (auditoría 8, fase 4, bloque 4.5; decisión D-26).
 *
 * Desde D-26 la nómina se anota por pago (fecha, a quién, cuánto). Los gastos
 * de nómina que ya estaban anotados como un total («Nómina $40,000
 * noviembre») NO se reparten solos: se quedan como están y siguen contando
 * igual. Este guion solo lee y dice, por gimnasio, cuántos hay y de qué
 * meses, para saber qué va a ver la gente en Movimientos con la leyenda
 * «anotada como un total, sin persona ni fecha».
 *
 * No imprime nombres de personas ni del gimnasio, ni la descripción de ningún
 * gasto: el id del gimnasio, el mes, cuántos y cuánto suman.
 *
 * Vale antes y después de aplicar
 * `20261125045000_nomina_por_pago_y_gastos_que_se_repiten` (antes, toda la
 * nómina es «en total»: las columnas de fecha y persona todavía no existen).
 *
 * Uso (desde ~/gymflow-backend; usa DATABASE_URL, el rol gymflow_app):
 *   pnpm exec tsx scripts/nomina-en-total-estado.ts
 * En el uso real, con su perfil:
 *   bash scripts/perfil.sh uso-real ./node_modules/.bin/tsx scripts/nomina-en-total-estado.ts
 */
import { loadDotenvFromRepoRoot } from '../src/platform/load-env.js';

loadDotenvFromRepoRoot();

if (process.argv.length > 2) { console.error('Este guion no recibe opciones.'); process.exit(2); }
const url = process.env.DATABASE_URL;
if (!url) { console.error('Falta DATABASE_URL.'); process.exit(2); }
const destino = (() => { try { const u = new URL(url); return `${u.pathname.replace(/^\//, '')} (${u.hostname}:${u.port || '5432'})`; } catch { return '(no se pudo leer DATABASE_URL)'; } })();

const { getDb, closeDb } = await import('../src/platform/db/client.js');
const db = getDb();
const pesos = (c: bigint) => `$${(Number(c) / 100).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;

console.log(`Base: ${destino}. Solo lectura.`);
const [{ hay }] = await db.$queryRaw<Array<{ hay: boolean }>>`
  SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'operating_expenses' AND column_name = 'payeeName') AS "hay"`;
if (!hay) console.log('La migración de D-26 todavía NO está aplicada: toda la nómina anotada es «en total».');

type Fila = { org: string; mes: string; enTotal: number; centavos: bigint; porPago: number };
const filas = hay
  ? await db.$queryRaw<Fila[]>`
      SELECT "organizationId"::text AS "org", to_char("periodMonth", 'YYYY-MM') AS "mes",
             COUNT(*) FILTER (WHERE "payeeName" IS NULL)::int AS "enTotal",
             COALESCE(SUM("amountCents") FILTER (WHERE "payeeName" IS NULL), 0)::bigint AS "centavos",
             COUNT(*) FILTER (WHERE "payeeName" IS NOT NULL)::int AS "porPago"
        FROM "operating_expenses"
       WHERE "category" = 'PAYROLL' AND "voidedAt" IS NULL
       GROUP BY 1, 2 ORDER BY 1, 2`
  : await db.$queryRaw<Fila[]>`
      SELECT "organizationId"::text AS "org", to_char("periodMonth", 'YYYY-MM') AS "mes",
             COUNT(*)::int AS "enTotal", COALESCE(SUM("amountCents"), 0)::bigint AS "centavos", 0::int AS "porPago"
        FROM "operating_expenses"
       WHERE "category" = 'PAYROLL' AND "voidedAt" IS NULL
       GROUP BY 1, 2 ORDER BY 1, 2`;

if (filas.length === 0) console.log('Ningún gimnasio tiene nómina anotada.');
let gimnasio = '';
for (const f of filas) {
  if (f.org !== gimnasio) { gimnasio = f.org; console.log(`\nGimnasio ${f.org}`); }
  console.log(`  ${f.mes}: ${f.enTotal} en total (${pesos(f.centavos)}), ${f.porPago} por pago.`);
}
const total = filas.reduce((a, f) => a + f.enTotal, 0);
console.log(`\nNómina anotada como un total: ${total} gasto(s). Se quedan como están y siguen contando; nadie los reparte.`);
await closeDb();
