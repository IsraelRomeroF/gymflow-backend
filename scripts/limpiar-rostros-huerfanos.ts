/**
 * LIMPIEZA ÚNICA DE ROSTROS (auditoría 8, fase 0, bloque 0.7: A1-N1 y 6-07).
 *
 * Hasta la fase 0, anonimizar a un socio solo REVOCABA sus enrolamientos: el
 * rostro cifrado seguía en `face_templates`, ligado a su id, y `/biometria`
 * pedía confirmar un borrado que nunca ocurrió. Desde la fase 0 anonimizar
 * lo borra en el acto; este script borra, una sola vez, lo que ya había
 * quedado:
 *
 *   · plantillas de socios anonimizados;
 *   · plantillas de enrolamientos que ya estaban revocados;
 *   · con `--bajas-30-dias`, además, las de socios dados de baja hace más de
 *     30 días que no regresaron (D-32: "el rostro se borra a los 30 días si no
 *     regresa"). Va aparte porque el borrado automático a los 30 días es de
 *     una fase posterior; aquí solo se aplica, si se pide, a lo ya vencido;
 *   · y asienta el borrado de las plantillas de la cámara que ya no existen.
 *
 * Cada borrado queda en la bitácora como acción del sistema, con su motivo.
 * Es idempotente: lo ya borrado no vuelve a contar.
 *
 * Uso (desde ~/gymflow-backend; usa DATABASE_URL, el rol gymflow_app):
 *   pnpm exec tsx scripts/limpiar-rostros-huerfanos.ts                  # solo cuenta: no borra nada
 *   pnpm exec tsx scripts/limpiar-rostros-huerfanos.ts --aplicar        # borra y deja bitácora
 *   pnpm exec tsx scripts/limpiar-rostros-huerfanos.ts --aplicar --bajas-30-dias
 *   ... --org <uuid>                                                     # solo un gimnasio
 *
 * Antes de tocar nada dice a qué base apunta. En el uso real, respalda la
 * base antes de `--aplicar` (es un borrado de datos sensibles sin vuelta).
 */
import { loadDotenvFromRepoRoot } from '../src/platform/load-env.js';

loadDotenvFromRepoRoot();

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const bajas = args.includes('--bajas-30-dias');
const iOrg = args.indexOf('--org');
const soloOrg = iOrg >= 0 ? args[iOrg + 1] ?? '' : null;
const conocidos = new Set(['--aplicar', '--bajas-30-dias', '--org', ...(soloOrg ? [soloOrg] : [])]);
const raros = args.filter((a) => !conocidos.has(a));
if (raros.length > 0 || (soloOrg !== null && !/^[0-9a-f-]{36}$/i.test(soloOrg))) {
  console.error(`Opción no reconocida: ${raros.join(' ') || '--org sin uuid'}. Usa --aplicar, --bajas-30-dias y --org <uuid>.`);
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) { console.error('Falta DATABASE_URL.'); process.exit(2); }
const destino = (() => { try { const u = new URL(url); return `${u.pathname.replace(/^\//, '')} (${u.hostname}:${u.port || '5432'})`; } catch { return '(no se pudo leer DATABASE_URL)'; } })();

const { getDb, closeDb } = await import('../src/platform/db/client.js');
const { systemContext } = await import('../src/platform/jobs/types.js');
const { EnrollmentService } = await import('../src/modules/access/index.js');

console.log(`Base: ${destino}`);
console.log(aplicar ? 'Modo: BORRAR (--aplicar).' : 'Modo: solo contar. Nada se borra; para borrar, agrega --aplicar.');
if (bajas) console.log('Incluye bajas de más de 30 días sin regresar (D-32).');

const servicio = new EnrollmentService();
const gimnasios = await getDb().organization.findMany({
  where: soloOrg ? { id: soloOrg } : {}, select: { id: true, tradeName: true }, orderBy: { tradeName: 'asc' },
});
if (gimnasios.length === 0) console.log('No hay gimnasios que revisar.');

const total = { anonimizados: 0, revocados: 0, bajas: 0, sinConfirmar: 0 };
for (const g of gimnasios) {
  const r = await servicio.limpiarRostrosHuerfanos(systemContext(g.id), { aplicar, bajasDeMasDeDias: bajas ? 30 : null });
  total.anonimizados += r.anonimizados; total.revocados += r.revocados; total.bajas += r.bajas; total.sinConfirmar += r.sinConfirmar;
  const n = r.anonimizados + r.revocados + r.bajas + r.sinConfirmar;
  if (n > 0) {
    console.log(`· ${g.tradeName}: ${r.anonimizados} de anonimizados, ${r.revocados} de enrolamientos revocados`
      + `${bajas ? `, ${r.bajas} de bajas de más de 30 días` : ''}, ${r.sinConfirmar} borrados por asentar.`);
  }
}

const verbo = aplicar ? 'Borradas' : 'Por borrar';
console.log(`${verbo}: ${total.anonimizados + total.revocados + total.bajas} plantillas `
  + `(${total.anonimizados} de anonimizados, ${total.revocados} de revocados${bajas ? `, ${total.bajas} de bajas` : ''}); `
  + `${aplicar ? 'asentados' : 'por asentar'}: ${total.sinConfirmar} borrados.`);
await closeDb();
