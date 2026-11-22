/**
 * CADENA DE PLATAFORMA · importar lo anterior (auditoría 8, bloque 1.11).
 *
 * La cadena de plataforma (`platform_audit_logs`) nace vacía con su migración.
 * Lo que GymFlow ya había hecho sobre las marcas está en la cadena de cada una
 * (asientos `platform.*`); este script los encadena, en orden cronológico y
 * enlazados con su asiento de marca, y al final verifica la cadena y el enlace.
 * Es idempotente: lo ya importado no se repite. Se corre UNA vez por base,
 * después de `prisma migrate deploy`:
 *
 *   bash scripts/perfil.sh uso-real tsx scripts/plataforma-cadena-importar.ts
 *   bash scripts/perfil.sh pruebas  tsx scripts/plataforma-cadena-importar.ts
 *
 * Sin perfil no se adivina ninguna base.
 */
if (!process.env.DATABASE_URL) {
  console.error('Falta el perfil. Uso: bash scripts/perfil.sh <uso-real|pruebas> tsx scripts/plataforma-cadena-importar.ts');
  process.exit(1);
}
const { PlatformAuditService } = await import('../src/platform/audit/platform-audit.service.js');
const { closeDb } = await import('../src/platform/db/client.js');

const cadena = new PlatformAuditService();
const { imported } = await cadena.importPrevious();
const v = await cadena.verify();
console.log(`Asientos anteriores importados: ${imported}`);
console.log(`Cadena de plataforma: ${v.entries} asientos, ${v.links.linked} enlazados con la cadena de su marca.`);
console.log(v.ok ? 'Verificación: íntegra.' : `Verificación: FALLA · ${v.reason} (${v.brokenAtId ?? 'sin id'})`);
await closeDb();
process.exit(v.ok ? 0 : 1);
