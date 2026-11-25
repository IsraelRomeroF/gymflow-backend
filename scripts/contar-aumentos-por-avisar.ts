/**
 * AUMENTOS DE PRECIO YA GUARDADOS Y SU AVISO DE 15 DÍAS, SIN TOCAR NADA
 * (auditoría 8, fase 4, bloque 4.20; P-14).
 *
 * Solo lee. Para cada gimnasio dice:
 *   · cuántos cambios de precio de planes hay (aumentos y bajadas) y a cuántas
 *     membresías tocaron;
 *   · ANTES de aplicar `20261125090200_aviso_de_aumento_de_precio`: cuántas
 *     filas tocaría su paso 4 (aumentos que todavía no llegan a su primer
 *     cobro y cuyo plazo anunciado quedó en menos de 15 días), con el día
 *     desde el que regirían y cuánto suman por periodo;
 *   · DESPUÉS de aplicarla: cuántos aumentos siguen «por llegar», cuántos ya
 *     llegaron con su cuota, y el más próximo en regir.
 *
 * No imprime nombres de personas ni del gimnasio: el id del gimnasio, del plan
 * y las cifras. La consulta del paso 4 es la misma de la migración.
 *
 * Uso (desde ~/gymflow-backend; usa DATABASE_URL, el rol gymflow_app):
 *   pnpm exec tsx scripts/contar-aumentos-por-avisar.ts
 *   pnpm exec tsx scripts/contar-aumentos-por-avisar.ts --org <uuid>
 * En el uso real, con su perfil:
 *   bash scripts/perfil.sh uso-real ./node_modules/.bin/tsx scripts/contar-aumentos-por-avisar.ts
 */
import { loadDotenvFromRepoRoot } from '../src/platform/load-env.js';

loadDotenvFromRepoRoot();

const args = process.argv.slice(2);
const iOrg = args.indexOf('--org');
const soloOrg = iOrg >= 0 ? args[iOrg + 1] ?? '' : null;
const conocidos = new Set(['--org', ...(soloOrg ? [soloOrg] : [])]);
const raros = args.filter((a) => !conocidos.has(a));
if (raros.length > 0 || (soloOrg !== null && !/^[0-9a-f-]{36}$/i.test(soloOrg))) {
  console.error(`Opción no reconocida: ${raros.join(' ') || '--org sin uuid'}. Solo se acepta --org <uuid>.`);
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) { console.error('Falta DATABASE_URL.'); process.exit(2); }
const destino = (() => { try { const u = new URL(url); return `${u.pathname.replace(/^\//, '')} (${u.hostname}:${u.port || '5432'})`; } catch { return '(no se pudo leer DATABASE_URL)'; } })();

const { getDb, closeDb } = await import('../src/platform/db/client.js');
const { Prisma } = await import('@gymflow/db');

const db = getDb();
const pesos = (c: bigint) => `$${(Number(c) / 100).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
const dia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');

console.log(`Base: ${destino}. Solo lectura.`);
const [{ aplicada }] = await db.$queryRaw<Array<{ aplicada: boolean }>>`
  SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'membership_price_changes' AND column_name = 'appliesFrom') AS "aplicada"`;
console.log(aplicada
  ? 'La migración de 4.20 YA está aplicada: se cuenta lo que espera y lo que llegó.'
  : 'La migración de 4.20 todavía NO está aplicada: se cuenta lo que tocaría su paso 4.');

const gimnasios = await db.$queryRaw<Array<{ id: string }>>`SELECT "id"::text AS "id" FROM "organizations" ORDER BY "createdAt"`;
let total = 0;
for (const g of gimnasios.filter((x) => !soloOrg || x.id === soloOrg)) {
  const [c] = await db.$queryRaw<Array<{ actos: number; aumentos: number; bajadas: number; filas: number }>>`
    SELECT COUNT(DISTINCT a."id")::int AS "actos",
           COUNT(DISTINCT a."id") FILTER (WHERE a."toPriceCents" > a."fromPriceCents")::int AS "aumentos",
           COUNT(DISTINCT a."id") FILTER (WHERE a."toPriceCents" < a."fromPriceCents")::int AS "bajadas",
           COUNT(pc."id")::int AS "filas"
      FROM "plan_price_changes" a LEFT JOIN "membership_price_changes" pc ON pc."planPriceChangeId" = a."id"
     WHERE a."organizationId" = ${g.id}::uuid`;
  if (!c || c.actos === 0) continue;
  console.log(`\nGimnasio ${g.id}: ${c.actos} cambios de precio (${c.aumentos} aumentos, ${c.bajadas} bajadas), ${c.filas} membresías tocadas.`);

  if (!aplicada) {
    // La misma selección que el paso 4 de la migración.
    const filas = await db.$queryRaw<Array<{ planId: string; n: number; suma: bigint; rige: Date }>>(Prisma.sql`
      SELECT a."planId"::text AS "planId", COUNT(*)::int AS "n", SUM(pc."toPriceCents" - pc."fromPriceCents")::bigint AS "suma",
             MAX((pc."createdAt" AT TIME ZONE COALESCE(o."timezone", 'America/Mexico_City'))::date + 15) AS "rige"
        FROM "membership_price_changes" pc
        JOIN "plan_price_changes" a ON a."id" = pc."planPriceChangeId"
        JOIN "memberships" ms ON ms."id" = pc."membershipId"
        JOIN "organizations" o ON o."id" = pc."organizationId"
       WHERE pc."organizationId" = ${g.id}::uuid
         AND pc."toPriceCents" > pc."fromPriceCents"
         AND ms."status" NOT IN ('CANCELED', 'EXPIRED')
         AND ms."planId" = a."planId"
         AND NOT EXISTS (SELECT 1 FROM "charges" ch
                          WHERE ch."membershipId" = pc."membershipId" AND ch."organizationId" = pc."organizationId"
                            AND ch."chargeType" = 'MEMBERSHIP_PERIOD' AND ch."createdAt" > pc."createdAt")
         AND ms."currentPeriodEnd" < ((pc."createdAt" AT TIME ZONE COALESCE(o."timezone", 'America/Mexico_City'))::date + 15)
       GROUP BY 1 ORDER BY 1`);
    if (filas.length === 0) console.log('  El paso 4 no tocaría a nadie: ningún aumento guardado deja menos de 15 días antes de su primer cobro.');
    for (const f of filas) {
      total += f.n;
      console.log(`  Plan ${f.planId}: ${f.n} membresías volverían a su precio de antes hasta su primera cuota desde el ${dia(f.rige)} (suman ${pesos(f.suma)} por periodo).`);
    }
    continue;
  }

  const [e] = await db.$queryRaw<Array<{ esperan: number; llegaron: number; proximo: Date | null; suma: bigint }>>`
    SELECT COUNT(*) FILTER (WHERE ap."id" IS NULL)::int AS "esperan",
           COUNT(*) FILTER (WHERE ap."id" IS NOT NULL)::int AS "llegaron",
           MIN(pc."appliesFrom") FILTER (WHERE ap."id" IS NULL) AS "proximo",
           COALESCE(SUM(pc."toPriceCents" - pc."fromPriceCents") FILTER (WHERE ap."id" IS NULL), 0)::bigint AS "suma"
      FROM "membership_price_changes" pc
      LEFT JOIN "membership_price_applications" ap ON ap."membershipPriceChangeId" = pc."id"
     WHERE pc."organizationId" = ${g.id}::uuid AND pc."appliesFrom" IS NOT NULL AND pc."toPriceCents" > pc."fromPriceCents"`;
  total += e?.esperan ?? 0;
  console.log(`  Aumentos con 15 días de aviso: ${e?.esperan ?? 0} por llegar (el más próximo rige el ${dia(e?.proximo ?? null)}; suman ${pesos(e?.suma ?? 0n)} por periodo), ${e?.llegaron ?? 0} ya llegaron con su cuota.`);
}
console.log(`\n${aplicada ? 'Por llegar' : 'Filas que tocaría el paso 4'}: ${total}.`);
await closeDb();
