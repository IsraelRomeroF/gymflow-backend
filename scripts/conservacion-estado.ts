/**
 * CONSERVACIÓN DE DATOS: QUÉ HARÍA EL CIERRE DIARIO, SIN TOCAR NADA
 * (auditoría 8, fase 3, bloque 3.9; D-32).
 *
 * Solo lee. Para cada gimnasio dice:
 *   · si los plazos ya arrancaron (y desde qué día) o si la próxima pasada
 *     del cierre diario los arranca;
 *   · qué rostros de exsocios siguen guardados, cuándo se borra cada uno y si
 *     la pasada de hoy ya borraría alguno;
 *   · quién entraría a la lista del mes (nadie se anonimiza sin la firma del
 *     dueño) y si ya hay una lista en espera.
 *
 * Imprime códigos de socio, nunca nombres. Es lo que hay que mirar en una
 * base ya en uso ANTES de dejar correr `privacy.conservation` por primera vez.
 *
 * Uso (desde ~/gymflow-backend; usa DATABASE_URL, el rol gymflow_app):
 *   pnpm exec tsx scripts/conservacion-estado.ts
 *   pnpm exec tsx scripts/conservacion-estado.ts --org <uuid>
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
const { ConservacionService } = await import('../src/modules/privacy/index.js');

console.log(`Base: ${destino}`);
console.log('Solo lectura: este guion no borra, no anonimiza y no fija ningún arranque.');

const servicio = new ConservacionService();
const gimnasios = await getDb().organization.findMany({
  where: soloOrg ? { id: soloOrg } : {}, select: { id: true, tradeName: true }, orderBy: { tradeName: 'asc' },
});
if (gimnasios.length === 0) console.log('No hay gimnasios que revisar.');

for (const g of gimnasios) {
  const v = await servicio.vistaPrevia(g.id);
  console.log(`\n── ${g.tradeName} · hoy ${v.hoy} ──`);
  console.log(v.arranque
    ? `Los plazos corren desde el ${v.arranque}.`
    : `Los plazos todavía no arrancan: la primera pasada del cierre diario los arranca (sería el ${v.hoy}) y NO borra nada.`);
  const hoy = v.rostros.filter((r) => r.hoy);
  console.log(`Rostros de exsocios guardados: ${v.rostros.length}. La pasada de hoy borraría: ${v.arranque ? hoy.length : 0}.`);
  for (const r of v.rostros) console.log(`   ${r.memberCode} · baja ${r.bajaEl} · se borra el ${r.seBorraEl}${v.arranque && r.hoy ? ' (hoy)' : ''}`);
  console.log(`Anonimización: ${v.meses} meses tras la baja (bajas del ${v.corte} o antes).`);
  if (v.lista.yaExiste) {
    console.log(`La lista de ${v.lista.periodo} ya existe${v.lista.enEspera === v.lista.periodo ? ' y espera la firma del dueño' : ''}: no se arma otra este mes.`);
  } else {
    console.log(`La pasada de hoy armaría la lista de ${v.lista.periodo} con ${v.lista.exsocios.length} exsocio(s)`
      + `${v.lista.enEspera ? ` y cerraría sin firma la de ${v.lista.enEspera}` : ''}. Ninguno se anonimiza hasta que el dueño la firme.`);
    for (const e of v.lista.exsocios) console.log(`   ${e.memberCode} · baja ${e.bajaEl}`);
  }
}
await closeDb();
