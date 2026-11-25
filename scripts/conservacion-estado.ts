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
 * Desde P-01 (fase 4, bloque 4.18) cuenta también la BAJA CALCULADA de D-18
 * (canceló, o su membresía terminó hace el plazo del gimnasio sin renovar),
 * con su propio arranque (arranque suave: a quien ya lo era, los 30 días del
 * rostro le cuentan desde ese día), y dice a quién NO toca la excepción
 * (sigue viniendo sin membresía, o tiene un paquete vivo).
 *
 * Imprime códigos de socio, nunca nombres. Es lo que hay que mirar en una
 * base ya en uso ANTES de dejar correr `privacy.conservation` por primera vez
 * con el código de 4.18: dice a quién tocaría la primera noche y después.
 *
 * Uso (desde ~/gymflow-backend; usa DATABASE_URL, el rol gymflow_app):
 *   pnpm exec tsx scripts/conservacion-estado.ts
 *   pnpm exec tsx scripts/conservacion-estado.ts --org <uuid>
 * Contra el uso real, con su perfil (necesita la migración de 4.18 aplicada):
 *   bash scripts/perfil.sh uso-real ./node_modules/.bin/tsx scripts/conservacion-estado.ts
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

const CAUSA = { ARCHIVED: 'dado de baja en su ficha', CANCELED: 'canceló su membresía', EXPIRED: 'terminó y no renovó' } as const;
const PORQUE: Record<string, string> = { ENTRADA_RECIENTE: 'sigue viniendo sin membresía', PAQUETE_VIVO: 'tiene un paquete de visitas vivo' };

for (const g of gimnasios) {
  const v = await servicio.vistaPrevia(g.id);
  console.log(`\n── ${g.tradeName} · hoy ${v.hoy} ──`);
  console.log(v.arranque
    ? `Los plazos del acto «Dar de baja» corren desde el ${v.arranque}.`
    : `Los plazos todavía no arrancan: la primera pasada del cierre diario los arranca (sería el ${v.hoy}) y NO borra nada.`);
  console.log(v.arranqueCalculada
    ? `La baja calculada (P-01) cuenta desde el ${v.arranqueCalculada}.`
    : `La baja calculada (P-01) todavía no cuenta: la próxima pasada la arranca (sería el ${v.hoy}); a quien ya lo es, los 30 días del rostro le cuentan desde ese día.`);
  console.log(`Plazo de baja del gimnasio (D-18): ${v.churnDays} días; una visita protege ese mismo plazo.`);
  const hoy = v.rostros.filter((r) => r.hoy);
  const calculadas = v.rostros.filter((r) => r.causa !== 'ARCHIVED');
  console.log(`Rostros de exsocios guardados: ${v.rostros.length} (${calculadas.length} por la baja calculada). La pasada de hoy borraría: ${hoy.length}.`);
  for (const r of v.rostros) console.log(`   ${r.memberCode} · ${CAUSA[r.causa]} · baja ${r.bajaEl} · se borra el ${r.seBorraEl}${r.hoy ? ' (hoy)' : ''}`);
  console.log(`Con rostro y de baja para D-18, pero exceptuados (no se tocan): ${v.exceptuados.length}.`);
  for (const e of v.exceptuados) console.log(`   ${e.memberCode} · ${CAUSA[e.causa]} · ${PORQUE[e.porque] ?? e.porque}${e.contaraDesde ? ` · contaría desde el ${e.contaraDesde} si no vuelve` : ''}`);
  console.log(`Anonimización: ${v.meses} meses tras la baja (bajas del ${v.corte} o antes).`);
  if (v.lista.yaExiste) {
    console.log(`La lista de ${v.lista.periodo} ya existe${v.lista.enEspera === v.lista.periodo ? ' y espera la firma del dueño' : ''}: no se arma otra este mes.`);
  } else {
    const nuevos = v.lista.exsocios.filter((e) => e.causa !== 'ARCHIVED').length;
    console.log(`La pasada de hoy armaría la lista de ${v.lista.periodo} con ${v.lista.exsocios.length} exsocio(s) (${nuevos} por la baja calculada)`
      + `${v.lista.enEspera ? ` y cerraría sin firma la de ${v.lista.enEspera}` : ''}. Ninguno se anonimiza hasta que el dueño la firme.`);
    for (const e of v.lista.exsocios) console.log(`   ${e.memberCode} · ${CAUSA[e.causa]} · baja ${e.bajaEl}`);
  }
}
await closeDb();
