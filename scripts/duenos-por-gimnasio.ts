/**
 * UN SOLO DUEÑO POR GIMNASIO · cuántos tiene cada marca (auditoría 8, bloque 3.16). SOLO LEE.
 *
 * Desde 3.16 la consola de plataforma no da de alta un segundo dueño activo
 * (D-02). Lo que ya estuviera en la base no se toca: este guion solo cuenta
 * los dueños ACTIVOS de cada marca y avisa de las que tienen más de uno (o
 * ninguno), para decidir con calma a quién se suspende o se pasa a gerente.
 *
 *   bash scripts/perfil.sh uso-real tsx scripts/duenos-por-gimnasio.ts
 *   bash scripts/perfil.sh pruebas  tsx scripts/duenos-por-gimnasio.ts
 *
 * Sin perfil no se adivina ninguna base. No imprime nombres ni correos: el id
 * de la marca y de cada cuenta basta para ubicarlas en la consola. Sale con 1
 * si alguna marca tiene más de un dueño activo.
 */
if (!process.env.DATABASE_URL) {
  console.error('Falta el perfil. Uso: bash scripts/perfil.sh <uso-real|pruebas> tsx scripts/duenos-por-gimnasio.ts');
  process.exit(1);
}
const { closeDb, getDb } = await import('../src/platform/db/client.js');
const db = getDb();

const filas = await db.$queryRaw<Array<{ organizationId: string; activos: number; suspendidos: number; ids: string[] }>>`
  SELECT o.id AS "organizationId",
         COUNT(DISTINCT u.id) FILTER (WHERE u."isActive")::int AS activos,
         COUNT(DISTINCT u.id) FILTER (WHERE NOT u."isActive")::int AS suspendidos,
         COALESCE(ARRAY_AGG(DISTINCT u.id::text) FILTER (WHERE u."isActive"), '{}') AS ids
  FROM organizations o
  LEFT JOIN role_assignments ra ON ra."organizationId" = o.id AND ra."revokedAt" IS NULL
       AND ra."roleId" IN (SELECT id FROM roles WHERE "organizationId" IS NULL AND key = 'OWNER')
  LEFT JOIN users u ON u.id = ra."userId" AND u."deletedAt" IS NULL
  GROUP BY o.id, o."createdAt"
  ORDER BY o."createdAt"`;

let deMas = 0;
for (const f of filas) {
  const nota = f.activos > 1 ? '  ← MÁS DE UNO: no se tocó a nadie; decidir a quién se suspende' : f.activos === 0 ? '  ← sin dueño activo' : '';
  if (f.activos > 1) deMas++;
  console.log(`marca ${f.organizationId}: ${f.activos} dueño(s) activo(s), ${f.suspendidos} suspendido(s)${nota}`);
  if (f.activos > 1) for (const id of f.ids) console.log(`    cuenta ${id}`);
}
console.log(`\n${filas.length} marca(s); ${deMas} con más de un dueño activo.`);
await closeDb();
process.exit(deMas > 0 ? 1 : 0);
