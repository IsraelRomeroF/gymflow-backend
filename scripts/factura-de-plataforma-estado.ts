/**
 * LA FACTURA DE GYMFLOW A LOS GIMNASIOS: CÓMO ESTÁ HOY Y QUÉ CAMBIARÍA, SIN
 * TOCAR NADA (auditoría 8, fase 4, bloque 4.9; decisión D-39).
 *
 * Solo lee. Dice:
 *   · si la migración de D-39 ya está aplicada y si hay algún IVA anunciado
 *     (sin anuncio, el IVA está APAGADO y nada cambia para nadie);
 *   · por cada gimnasio: estado del servicio, mes en que se liberó, si tiene
 *     RFC en su ficha, cuántas facturas tiene por estado y cuánto debe;
 *   · LO QUE IMPORTA PARA DECIDIR EL IVA: el total de su última factura viva
 *     y cuánto sería la siguiente con «IVA aparte» (16 % más) y con «IVA
 *     incluido en los precios» (mismo total, desglosado);
 *   · cuántos descuentos vivos hay y cuántos módulos tienen fecha de
 *     contratación (los que se cobrarían por días).
 *
 * No imprime nombres de gimnasios ni de personas, ni razones sociales, ni RFC:
 * el id del gimnasio y cifras. Sirve ANTES de aplicar
 * `20261125063900_factura_de_plataforma` (lo dice y cuenta con lo que hay) y
 * después.
 *
 * Uso (desde ~/gymflow-backend; usa DATABASE_URL, el rol gymflow_app):
 *   pnpm exec tsx scripts/factura-de-plataforma-estado.ts
 * En el uso real, con su perfil:
 *   bash scripts/perfil.sh uso-real ./node_modules/.bin/tsx scripts/factura-de-plataforma-estado.ts
 */
import { loadDotenvFromRepoRoot } from '../src/platform/load-env.js';

loadDotenvFromRepoRoot();

if (process.argv.length > 2) { console.error('Este guion no recibe opciones.'); process.exit(2); }
const url = process.env.DATABASE_URL;
if (!url) { console.error('Falta DATABASE_URL.'); process.exit(2); }
const destino = (() => { try { const u = new URL(url); return `${u.pathname.replace(/^\//, '')} (${u.hostname}:${u.port || '5432'})`; } catch { return '(no se pudo leer DATABASE_URL)'; } })();

const { getDb, closeDb } = await import('../src/platform/db/client.js');
const { IVA_BPS, desglosar } = await import('../src/modules/tenants/factura-reglas.js');
const { emisor } = await import('../src/modules/tenants/emisor.js');

const db = getDb();
const pesos = (c: bigint) => `$${(Number(c) / 100).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
const existe = async (tabla: string, columna?: string): Promise<boolean> => {
  const [r] = columna
    ? await db.$queryRaw<Array<{ hay: boolean }>>`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = ${tabla} AND column_name = ${columna}) AS "hay"`
    : await db.$queryRaw<Array<{ hay: boolean }>>`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = ${tabla}) AS "hay"`;
  return r!.hay;
};

console.log(`Base: ${destino}. Solo lectura.`);
const migrada = await existe('platform_tax_changes');
const conRfc = await existe('organizations', 'rfc');
if (!migrada) console.log('La migración de D-39 todavía NO está aplicada. Al aplicarla no cambia ninguna factura ni ningún importe: el IVA nace apagado.');
else {
  const iva = await db.$queryRaw<Array<{ tasa: number; incluido: boolean; desde: Date }>>`
    SELECT "rateBps" AS "tasa", "included" AS "incluido", "effectiveFrom" AS "desde" FROM "platform_tax_changes" WHERE "canceledAt" IS NULL ORDER BY "effectiveFrom"`;
  if (iva.length === 0) console.log('IVA: APAGADO (nadie lo ha anunciado). Las facturas salen por el total de siempre.');
  for (const c of iva) console.log(`IVA: ${c.tasa / 100} % ${c.tasa === 0 ? '(apagado)' : c.incluido ? 'incluido en los precios' : 'aparte'} desde la factura de ${c.desde.toISOString().slice(0, 7)}.`);
  const [a] = await db.$queryRaw<Array<{ vivos: number }>>`SELECT COUNT(*)::int AS "vivos" FROM "organization_billing_adjustments" WHERE "canceledAt" IS NULL`;
  const [m] = await db.$queryRaw<Array<{ fechados: number }>>`SELECT COUNT(*)::int AS "fechados" FROM "organization_entitlements" WHERE "granted" AND "contractedOn" IS NOT NULL`;
  console.log(`Descuentos o precios especiales sin cancelar: ${a!.vivos}. Módulos con fecha de contratación (se cobran por días): ${m!.fechados}.`);
}
console.log(`GymFlow como emisor (configuración del servidor): ${emisor() ? 'configurado' : 'SIN CONFIGURAR: las facturas salen a nombre de «GymFlow», sin RFC ni datos de pago'}.`);

const gimnasios = await db.$queryRaw<Array<{ id: string; servicio: string; liberada: string | null }>>`
  SELECT "id"::text AS "id", "serviceStatus" AS "servicio",
         to_char(COALESCE("activatedAt", "createdAt") AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS "liberada"
    FROM "organizations" WHERE "deletedAt" IS NULL ORDER BY "createdAt"`;
let sinDesglose = 0;
for (const g of gimnasios) {
  const facturas = await db.$queryRaw<Array<{ estado: string; n: number; total: bigint; debe: bigint }>>`
    SELECT "status" AS "estado", COUNT(*)::int AS "n", COALESCE(SUM("totalCents"), 0)::bigint AS "total", COALESCE(SUM("totalCents" - "paidCents"), 0)::bigint AS "debe"
      FROM "platform_invoices" WHERE "organizationId" = ${g.id}::uuid GROUP BY 1 ORDER BY 1`;
  const de = (e: string) => facturas.find((f) => f.estado === e);
  const ultima = await db.$queryRaw<Array<{ mes: Date; total: bigint }>>`
    SELECT "periodStart" AS "mes", "totalCents" AS "total" FROM "platform_invoices"
     WHERE "organizationId" = ${g.id}::uuid AND "status" <> 'VOID' ORDER BY "periodStart" DESC LIMIT 1`;
  let rfc = 'no se sabe (falta la migración de datos y marca)';
  if (conRfc) {
    const [r] = await db.$queryRaw<Array<{ tiene: boolean }>>`SELECT ("rfc" IS NOT NULL AND "rfc" <> '') AS "tiene" FROM "organizations" WHERE "id" = ${g.id}::uuid`;
    rfc = r!.tiene ? 'sí' : 'NO (la factura saldría sin RFC)';
  }
  console.log(`\nGimnasio ${g.id}`);
  console.log(`  Servicio: ${g.servicio}. Liberado el ${g.liberada}. RFC en su ficha: ${rfc}.`);
  console.log(`  Facturas: ${de('PENDING')?.n ?? 0} pendientes (debe ${pesos(de('PENDING')?.debe ?? 0n)}), ${de('PAID')?.n ?? 0} pagadas, ${de('VOID')?.n ?? 0} anuladas. Ninguna cambia.`);
  if (migrada) {
    const [s] = await db.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS "n" FROM "platform_invoices" WHERE "organizationId" = ${g.id}::uuid AND "subtotalCents" IS NULL`;
    sinDesglose += s!.n;
  }
  const u = ultima[0];
  if (!u) { console.log('  Sin facturas vivas: no hay total de referencia.'); continue; }
  const aparte = desglosar(u.total, { rateBps: IVA_BPS, included: false });
  const incluido = desglosar(u.total, { rateBps: IVA_BPS, included: true });
  console.log(`  Su última factura viva (${u.mes.toISOString().slice(0, 7)}): ${pesos(u.total)}.`);
  console.log(`    · IVA apagado (como hoy): la siguiente sale igual, ${pesos(u.total)}, si no cambian sus precios ni lo contratado.`);
  console.log(`    · IVA aparte: ${pesos(aparte.subtotalCents)} + IVA ${pesos(aparte.taxCents)} = ${pesos(aparte.totalCents)} (paga ${pesos(aparte.taxCents)} más al mes).`);
  console.log(`    · IVA incluido en los precios: paga lo mismo, ${pesos(incluido.totalCents)}; se desglosa ${pesos(incluido.subtotalCents)} + IVA ${pesos(incluido.taxCents)}.`);
}
if (migrada) console.log(`\nFacturas emitidas antes de D-39 (sin desglose; se quedan como están): ${sinDesglose}.`);

await closeDb();
