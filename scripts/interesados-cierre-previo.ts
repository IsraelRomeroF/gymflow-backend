/**
 * INTERESADOS: A QUIÉN CERRARÍA EL CIERRE SOLO, SIN TOCAR NADA
 * (auditoría 8, fase 4, bloque 4.7; D-31).
 *
 * Solo lee. Para cada gimnasio y cada sucursal dice:
 *   · si el cierre solo ya tiene fecha de arranque (y cuál) o si la próxima
 *     corrida del cierre diario la fija (esa primera corrida NO cierra a nadie);
 *   · cuántos interesados abiertos ya llevan el plazo sin contacto ni fecha
 *     pendiente (son los que se cerrarían al llegar el arranque);
 *   · cuántos lo cumplen en los próximos días.
 *
 * No imprime nombres ni teléfonos: solo cuentas. Es lo que hay que mirar en
 * una base ya en uso ANTES de dejar correr `prospects.auto-close` por primera
 * vez, y otra vez antes del día de arranque.
 *
 * Uso (desde ~/gymflow-backend; usa DATABASE_URL, el rol gymflow_app):
 *   bash scripts/perfil.sh uso-real ./node_modules/.bin/tsx scripts/interesados-cierre-previo.ts
 *   bash scripts/perfil.sh uso-real ./node_modules/.bin/tsx scripts/interesados-cierre-previo.ts --org <uuid>
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
const { ProspectAutoCloseService } = await import('../src/modules/prospects/auto-close.service.js');

console.log(`Base: ${destino}`);
console.log('Solo lectura: este guion no cierra a nadie y no fija ningún arranque.');

const servicio = new ProspectAutoCloseService();
const gimnasios = await getDb().organization.findMany({
  where: soloOrg ? { id: soloOrg } : {}, select: { id: true, tradeName: true }, orderBy: { tradeName: 'asc' },
});
if (gimnasios.length === 0) console.log('No hay gimnasios que revisar.');

for (const g of gimnasios) {
  const total = await servicio.vistaPrevia(g.id, null);
  console.log(`\n── ${g.tradeName} ──`);
  console.log(total.startsOn
    ? `El cierre solo ${total.active ? 'cierra desde' : 'empieza a cerrar'} el ${total.startsOn}.`
    : total.due > 0
      ? `Todavía no tiene fecha: la primera corrida del cierre diario la fija ${total.noticeDays} días adelante y NO cierra a nadie.`
      : 'Todavía no tiene fecha: la primera corrida del cierre diario la fija ese mismo día (no hay a quién cerrar).');
  console.log(`Abiertos con ${total.days} días o más sin contacto ni fecha pendiente: ${total.due}${total.active ? ' (se cierran en la próxima corrida)' : total.startsOn ? ` (se cierran el ${total.startsOn} si nadie los contacta)` : ''}.`);
  console.log(`Lo cumplen en los próximos ${total.noticeDays} días: ${total.soon}.`);
  const sedes = await getDb().branch.findMany({ where: { organizationId: g.id }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  if (sedes.length > 1) {
    for (const s of sedes) {
      const v = await servicio.vistaPrevia(g.id, [s.id]);
      if (v.due + v.soon > 0) console.log(`   ${s.name}: ${v.due} ya cumplieron · ${v.soon} en los próximos ${v.noticeDays} días`);
    }
  }
}

await closeDb();
