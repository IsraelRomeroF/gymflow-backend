/**
 * LA CADENA DE LA BITÁCORA · en qué estado está (auditoría 8, bloque 3.12). SOLO LEE.
 *
 * Verifica la cadena de cada marca y la de plataforma y dice, de cada una,
 * cuántos asientos son anteriores al número de eslabón (`chainSeq` NULL: se
 * verifican por hora, como siempre) y cuántos ya van numerados. Si una cadena
 * no verifica, mira el asiento donde se rompe y distingue dos casos:
 *
 *  - «desorden de reloj»: el asiento está entero (su hash corresponde a su
 *    contenido) y se enlaza con un asiento que SÍ existe en la cadena, solo que
 *    no con el anterior. Es la huella del defecto que cerró 3.12 (el reloj del
 *    servidor retrocedió): nadie editó ni borró nada.
 *  - «alteración o borrado»: el contenido no corresponde a su hash, o el asiento
 *    con el que se enlaza ya no está.
 *
 * Se puede correr las veces que haga falta, antes y después de
 * `prisma migrate deploy` (antes de la migración la columna no existe: correrlo después).
 *
 *   bash scripts/perfil.sh uso-real tsx scripts/bitacora-cadena-estado.ts
 *   bash scripts/perfil.sh pruebas  tsx scripts/bitacora-cadena-estado.ts
 *
 * Sin perfil no se adivina ninguna base. Sale con 1 si alguna cadena no verifica.
 */
if (!process.env.DATABASE_URL) {
  console.error('Falta el perfil. Uso: bash scripts/perfil.sh <uso-real|pruebas> tsx scripts/bitacora-cadena-estado.ts');
  process.exit(1);
}
const { computeAuditHash } = await import('@gymflow/core');
const { AuditService } = await import('../src/platform/audit/audit.service.js');
const { PlatformAuditService } = await import('../src/platform/audit/platform-audit.service.js');
const { closeDb, getDb } = await import('../src/platform/db/client.js');

const db = getDb();
const audit = new AuditService();
let rotas = 0;

for (const marca of await db.organization.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } })) {
  const [anteriores, numerados] = await Promise.all([
    db.auditLog.count({ where: { organizationId: marca.id, chainSeq: null } }),
    db.auditLog.count({ where: { organizationId: marca.id, chainSeq: { not: null } } }),
  ]);
  const v = await audit.verifyChain(marca.id);
  // El id de la marca basta para ubicarla; el nombre no se imprime (la salida puede acabar en un informe).
  const quien = `marca ${marca.id}`;
  if (v.ok) { console.log(`${quien}: íntegra · ${anteriores} anteriores al número + ${numerados} numerados`); continue; }
  rotas++;
  const fila = await db.auditLog.findUnique({ where: { id: v.brokenAtId } });
  let causa = 'alteración o borrado (el asiento ya no se encuentra)';
  if (fila) {
    const entero = computeAuditHash(fila.prevHash, {
      id: fila.id, organizationId: fila.organizationId, branchId: fila.branchId, actorUserId: fila.actorUserId, actorType: fila.actorType,
      action: fila.action, resourceType: fila.resourceType, resourceId: fila.resourceId, beforeState: fila.beforeState ?? null,
      afterState: fila.afterState ?? null, reason: fila.reason, approvedByUserId: fila.approvedByUserId, at: fila.at.toISOString(),
    }) === fila.hash;
    const enlazadoCon = fila.prevHash ? await db.auditLog.findFirst({ where: { organizationId: marca.id, hash: fila.prevHash }, select: { id: true, at: true } }) : null;
    causa = !entero ? 'alteración: el contenido del asiento no corresponde a su hash'
      : enlazadoCon ? `desorden de reloj: el asiento está entero y se enlaza con ${enlazadoCon.id} (${enlazadoCon.at.toISOString()}), que no es su anterior por hora; su propia hora es ${fila.at.toISOString()}`
        : 'alteración o borrado: el asiento con el que se enlaza ya no está';
  }
  console.log(`${quien}: NO VERIFICA en el asiento ${v.brokenAtId} (tras ${v.checked} correctos de ${anteriores + numerados}) · ${causa}`);
}

const plataforma = await new PlatformAuditService().verify();
if (!plataforma.ok) rotas++;
console.log(plataforma.ok
  ? `cadena de plataforma: íntegra · ${plataforma.entries} asientos, ${plataforma.links.linked} enlazados con la cadena de su marca`
  : `cadena de plataforma: NO VERIFICA · ${plataforma.reason} (${plataforma.brokenAtId ?? 'sin id'})`);

await closeDb();
process.exit(rotas === 0 ? 0 : 1);
