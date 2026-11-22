/**
 * Cifra las notas de salud que se guardaron EN CLARO antes de SEC-08.
 *
 * Idempotente: lo ya cifrado se salta. Se corre una vez por base después de
 * desplegar el cifrado: `pnpm exec tsx scripts/cifrar-salud.ts`.
 */
import { loadDotenvFromRepoRoot } from '../src/platform/load-env.js';

loadDotenvFromRepoRoot();

const { getDb, closeDb } = await import('../src/platform/db/client.js');
const { cifrarSensible, estaCifrado } = await import('../src/platform/sensitive.js');

const db = getDb();
let socios = 0;
let altas = 0;

for (const m of await db.member.findMany({ where: { healthNotes: { not: null } }, select: { id: true, healthNotes: true } })) {
  if (estaCifrado(m.healthNotes)) continue;
  await db.member.update({ where: { id: m.id }, data: { healthNotes: cifrarSensible(m.healthNotes) } });
  socios++;
}
for (const i of await db.memberIntake.findMany({ where: { healthNotes: { not: null } }, select: { id: true, healthNotes: true } })) {
  if (estaCifrado(i.healthNotes)) continue;
  await db.memberIntake.update({ where: { id: i.id }, data: { healthNotes: cifrarSensible(i.healthNotes) } });
  altas++;
}

console.log(`Notas de salud cifradas: ${socios} socios, ${altas} altas digitales.`);
await closeDb();
