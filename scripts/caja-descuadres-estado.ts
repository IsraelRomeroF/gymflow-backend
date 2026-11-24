/**
 * CAJA: CORTES CON DIFERENCIA Y CAJAS ABIERTAS, SIN TOCAR NADA
 * (auditoría 8, fase 4, bloque 4.3; decisión D-17).
 *
 * Solo lee. Para cada gimnasio dice:
 *   · cuántos turnos cortados tiene y cuántos cerraron con diferencia;
 *   · cuántos de esos pasan de $20 y cómo están: «por revisar», «revisados» o
 *     SIN ESTADO (cortes anteriores a la regla: la migración no los marca, así
 *     que no le aparecen a la gerencia como pendientes);
 *   · qué cajas siguen abiertas y cuáles son de un día de negocio anterior al
 *     de hoy de su sede (amanecieron sin cortar).
 *
 * No imprime nombres de personas ni del gimnasio: el id del gimnasio, el
 * código de la caja y la fecha. Es lo que hay que mirar en una base ya en uso
 * ANTES y DESPUÉS de aplicar `20261125043300_caja_descuadre_por_revisar`
 * (antes de aplicarla las columnas no existen: el guion lo dice y cuenta solo
 * por la diferencia).
 *
 * Uso (desde ~/gymflow-backend; usa DATABASE_URL, el rol gymflow_app):
 *   pnpm exec tsx scripts/caja-descuadres-estado.ts
 *   pnpm exec tsx scripts/caja-descuadres-estado.ts --org <uuid>
 * En el uso real, con su perfil:
 *   bash scripts/perfil.sh uso-real ./node_modules/.bin/tsx scripts/caja-descuadres-estado.ts
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

const { TOLERANCIA_DE_DESCUADRE_CENTS } = await import('@gymflow/core');
const { getDb, closeDb } = await import('../src/platform/db/client.js');
const { BusinessCalendar } = await import('../src/platform/time/business-calendar.js');

const db = getDb();
const pesos = (c: bigint) => `$${(Number(c) / 100).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
const dia = (d: Date) => d.toISOString().slice(0, 10);

console.log(`Base: ${destino}. Solo lectura.`);
const [{ hay }] = await db.$queryRaw<Array<{ hay: boolean }>>`
  SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cash_sessions' AND column_name = 'varianceStatus') AS "hay"`;
if (!hay) console.log('La migración de D-17 todavía NO está aplicada: se cuenta solo por la diferencia de cada corte.');

const gimnasios = await db.$queryRaw<Array<{ id: string }>>`SELECT "id"::text AS "id" FROM "organizations" ORDER BY "createdAt"`;
for (const g of gimnasios.filter((x) => !soloOrg || x.id === soloOrg)) {
  const [c] = await db.$queryRaw<Array<{ cortados: number; conDiferencia: number; mayores: number; faltan: bigint; sobran: bigint }>>`
    SELECT COUNT(*)::int AS "cortados",
           COUNT(*) FILTER (WHERE COALESCE("varianceCents", 0) <> 0)::int AS "conDiferencia",
           COUNT(*) FILTER (WHERE abs(COALESCE("varianceCents", 0)) > ${TOLERANCIA_DE_DESCUADRE_CENTS}::bigint)::int AS "mayores",
           COALESCE(SUM(abs("varianceCents")) FILTER (WHERE "varianceCents" < 0 AND abs("varianceCents") > ${TOLERANCIA_DE_DESCUADRE_CENTS}::bigint), 0)::bigint AS "faltan",
           COALESCE(SUM("varianceCents") FILTER (WHERE "varianceCents" > ${TOLERANCIA_DE_DESCUADRE_CENTS}::bigint), 0)::bigint AS "sobran"
      FROM "cash_sessions" WHERE "organizationId" = ${g.id}::uuid AND "status" <> 'OPEN'`;
  console.log(`\nGimnasio ${g.id}`);
  console.log(`  Turnos cortados: ${c!.cortados}; con diferencia: ${c!.conDiferencia}; de más de ${pesos(TOLERANCIA_DE_DESCUADRE_CENTS)}: ${c!.mayores} (faltan ${pesos(c!.faltan)}, sobran ${pesos(c!.sobran)}).`);
  if (hay) {
    const estados = await db.$queryRaw<Array<{ estado: string | null; total: number }>>`
      SELECT "varianceStatus" AS "estado", COUNT(*)::int AS "total"
        FROM "cash_sessions"
       WHERE "organizationId" = ${g.id}::uuid AND "status" <> 'OPEN' AND abs(COALESCE("varianceCents", 0)) > ${TOLERANCIA_DE_DESCUADRE_CENTS}::bigint
       GROUP BY 1 ORDER BY 1 NULLS LAST`;
    const de = (e: string | null) => estados.find((x) => x.estado === e)?.total ?? 0;
    console.log(`  De esos: por revisar ${de('PENDING')}, revisados ${de('REVIEWED')}, sin estado (anteriores a la regla) ${de(null)}.`);
  }
  const abiertas = await db.$queryRaw<Array<{ caja: string; sede: string; dia: Date; desde: Date }>>`
    SELECT r."code" AS "caja", s."branchId"::text AS "sede", s."businessDate" AS "dia", s."openedAt" AS "desde"
      FROM "cash_sessions" s JOIN "cash_registers" r ON r."id" = s."cashRegisterId"
     WHERE s."organizationId" = ${g.id}::uuid AND s."status" = 'OPEN' ORDER BY s."openedAt"`;
  if (abiertas.length === 0) { console.log('  Cajas abiertas: ninguna.'); continue; }
  const calendario = new BusinessCalendar(g.id);
  for (const a of abiertas) {
    const hoy = await calendario.today(a.sede);
    console.log(`  Caja ${a.caja} abierta con fecha ${dia(a.dia)}${a.dia.getTime() < hoy.getTime() ? ' · AMANECIÓ SIN CORTAR (hoy es ' + dia(hoy) + ' en su sede)' : ''}.`);
  }
}

await closeDb();
