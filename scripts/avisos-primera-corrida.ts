/**
 * AVISOS A LA DUEÑA: QUÉ HARÍA LA PRÓXIMA CORRIDA, SIN TOCAR NADA
 * (auditoría 8, fase 4, bloque 4.2; D-05).
 *
 * Solo lee. Para cada gimnasio dice:
 *   · si el servidor tiene llaves para avisar al teléfono (sin ellas todo
 *     queda solo dentro del panel);
 *   · cuántas personas tienen el puesto Dueño y en cuántos equipos tienen
 *     activados los avisos;
 *   · si `audit.anomaly-scan` ya corrió aquí (y desde cuándo avisa) o si la
 *     próxima será su PRIMERA corrida, la que no hace sonar ningún teléfono;
 *   · cuántos avisos daría esa corrida, por tipo;
 *   · cuándo tocaría el primer resumen del lunes.
 *
 * No imprime nombres de socios ni de personal: solo cuentas. No fija el
 * arranque, no crea avisos y no manda nada.
 *
 * Uso (desde ~/gymflow-backend; usa DATABASE_URL, el rol gymflow_app):
 *   bash scripts/perfil.sh uso-real ./node_modules/.bin/tsx scripts/avisos-primera-corrida.ts
 *   bash scripts/perfil.sh uso-real ./node_modules/.bin/tsx scripts/avisos-primera-corrida.ts --org <uuid>
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

const { OWNER_ALERT_CATALOG, esOwnerAlertKind, semanaDelResumen } = await import('@gymflow/core');
const { getDb, closeDb } = await import('../src/platform/db/client.js');
const { AnomalyScanService } = await import('../src/modules/alerts/anomaly-scan.service.js');

const ahora = new Date();
const conLlaves = !!process.env.VAPID_PUBLIC_KEY && !!process.env.VAPID_PRIVATE_KEY;
const hora = (d: Date, zona: string) => d.toLocaleString('es-MX', { timeZone: zona, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

console.log(`Base: ${destino}`);
console.log('Solo lectura: este guion no fija ningún arranque, no crea avisos y no manda nada.');
console.log(conLlaves
  ? 'Llaves de avisos al teléfono: SÍ hay. Lo que no sea de la primera corrida suena en los equipos activados.'
  : 'Llaves de avisos al teléfono: NO hay. Ningún teléfono suena; todo queda dentro del panel (se crean con `gymflow.sh avisos`).');

const escaneo = new AnomalyScanService();
const gimnasios = await getDb().organization.findMany({
  where: soloOrg ? { id: soloOrg } : {}, select: { id: true, tradeName: true, timezone: true }, orderBy: { tradeName: 'asc' },
});
if (gimnasios.length === 0) console.log('No hay gimnasios que revisar.');

for (const g of gimnasios) {
  console.log(`\n── ${g.tradeName} ──`);
  const duenos = await getDb().user.findMany({
    where: { organizationId: g.id, isActive: true, deletedAt: null, roleAssignments: { some: { revokedAt: null, role: { key: 'OWNER' } } } }, select: { id: true },
  });
  const equipos = duenos.length ? await getDb().pushSubscription.count({ where: { organizationId: g.id, userId: { in: duenos.map((d) => d.id) }, failedAt: null } }) : 0;
  const apagados = duenos.length ? await getDb().pushPreference.count({ where: { organizationId: g.id, userId: { in: duenos.map((d) => d.id) }, enabled: false } }) : 0;
  console.log(`Con el puesto Dueño: ${duenos.length}. Equipos con avisos activados: ${equipos}. Tipos de aviso apagados: ${apagados}.`);

  const v = await escaneo.vistaPrevia(g.id, ahora);
  const total = Object.values(v.porTipo).reduce((a, n) => a + n, 0);
  console.log(v.primera
    ? 'El escaneo NUNCA ha corrido aquí: la próxima corrida es la primera. No suena ningún teléfono; lo de abajo queda anotado en el panel y lo anterior a ese momento no se avisa.'
    : `El escaneo avisa desde el ${hora(v.startedAt!, g.timezone)}. Lo de abajo SÍ sonaría en la próxima corrida.`);
  if (total === 0) console.log('Avisos nuevos que daría la próxima corrida: ninguno.');
  else {
    console.log(`Avisos nuevos que daría la próxima corrida: ${total}.`);
    for (const [tipo, n] of Object.entries(v.porTipo).sort(([a], [b]) => a.localeCompare(b))) console.log(`  · ${esOwnerAlertKind(tipo) ? OWNER_ALERT_CATALOG[tipo].label : tipo}: ${n}`);
  }
  for (const e of v.errores) console.log(`  (una fuente no se pudo leer: ${e.entityId}: ${e.error})`);

  // El primer resumen: el del primer lunes a las 7:00 del gimnasio que llegue DESPUÉS del arranque.
  const arranque = v.startedAt ?? ahora;
  let s = semanaDelResumen(g.timezone, arranque);
  if (s.dueAt.getTime() < arranque.getTime()) s = semanaDelResumen(g.timezone, new Date(s.dueAt.getTime() + 7 * 86_400_000 + 3_600_000));
  const yaHay = await getDb().ownerAlert.count({ where: { organizationId: g.id, kind: 'WEEKLY_SUMMARY' } });
  console.log(yaHay > 0
    ? `Resúmenes del lunes ya guardados: ${yaHay}.`
    : `Primer resumen del lunes: el ${hora(s.dueAt, g.timezone)}${v.primera ? ' (si el escaneo corre hoy)' : ''}, con la semana del ${s.from} al día anterior al ${s.to}.`);
}

await closeDb();
