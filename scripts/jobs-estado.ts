/**
 * ESTADO DE LOS JOBS (auditoría 8, fase 1, bloque 1.16; 28-15). Solo lee.
 *
 * Responde, sin abrir la base a mano: ¿está corriendo algo ahora?, ¿cuándo
 * corrió por última vez el cierre diario y el corredor de 15 minutos y cómo
 * terminaron?, ¿qué corrió hoy en cada gimnasio? y ¿qué falló o se quedó a
 * medias en los últimos días?
 *
 * Uso (desde ~/gymflow-backend):
 *   pnpm jobs:local:estado            # el uso real
 *   pnpm jobs:pruebas:estado          # la base de los recorridos
 *   pnpm jobs:estado [--dias 7]       # la base de DATABASE_URL
 *
 * Sale con 1 si hay algo que mirar (una corrida cortada, un job que falló y
 * no se ha vuelto a correr bien, o un cierre diario que no corre desde ayer).
 */
import { loadDotenvFromRepoRoot } from '../src/platform/load-env.js';

loadDotenvFromRepoRoot();

const args = process.argv.slice(2);
const iDias = args.indexOf('--dias');
const dias = iDias >= 0 ? Number(args[iDias + 1]) : 7;
if (!Number.isInteger(dias) || dias < 1 || dias > 365) { console.error('Uso: jobs-estado.ts [--dias N] (N entre 1 y 365)'); process.exit(2); }

const url = process.env.DATABASE_URL;
if (!url) { console.error('Falta DATABASE_URL.'); process.exit(2); }
const destino = (() => { try { const u = new URL(url); return `${u.pathname.replace(/^\//, '')} (${u.hostname}:${u.port || '5432'})`; } catch { return '(no se pudo leer DATABASE_URL)'; } })();

const { hoyEn } = await import('@gymflow/core');
const { closeDb } = await import('../src/platform/db/client.js');
const { BACKEND_MODULES } = await import('../src/modules.js');
const { armarPlanes } = await import('../src/platform/jobs/plan.js');
const { JobRunRepository } = await import('../src/platform/jobs/job-runs.repository.js');
const { BusinessCalendar } = await import('../src/platform/time/business-calendar.js');
const { SIN_SENAL_MS } = await import('../src/platform/jobs/runner.js');
const { ZONA_PLATAFORMA } = await import('../src/platform/jobs/bitacora.js');

const repo = new JobRunRepository();
const NOMBRE = { DAILY: 'Cierre diario', FREQUENT: 'Corredor de 15 minutos' } as const;
const ESTADO: Record<string, string> = {
  RUNNING: 'CORRIENDO', OK: 'bien', WITH_ERRORS: 'CON ERRORES', FAILED: 'FALLÓ', ABANDONED: 'SE CORTÓ A MEDIAS',
};
const cuando = (d: Date) => d.toLocaleString('es-MX', { timeZone: ZONA_PLATAFORMA, dateStyle: 'short', timeStyle: 'short' });
const hace = (d: Date) => {
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  return min < 1 ? 'hace menos de un minuto' : min < 90 ? `hace ${min} min` : min < 48 * 60 ? `hace ${Math.round(min / 60)} h` : `hace ${Math.round(min / 1440)} días`;
};

let atencion = 0;
console.log(`Base: ${destino}`);

for (const runner of ['DAILY', 'FREQUENT'] as const) {
  console.log(`\n── ${NOMBRE[runner]} ──`);
  const viva = await repo.running(runner);
  if (viva) {
    const sinSenal = Date.now() - viva.heartbeatAt.getTime() > SIN_SENAL_MS;
    console.log(`  Ahora: CORRIENDO desde ${cuando(viva.startedAt)} en ${viva.host} (última señal de vida ${hace(viva.heartbeatAt)})` +
      (sinSenal ? ' ⚠ sin señal de vida: se cortó; la siguiente corrida la dará por abandonada' : ''));
    if (sinSenal) atencion += 1;
  } else {
    console.log('  Ahora: no está corriendo.');
  }
  const ultimas = (await repo.recent(6, runner)).filter((r) => r.status !== 'RUNNING');
  if (ultimas.length === 0) console.log('  Nunca ha corrido en esta base.');
  for (const r of ultimas) {
    const s = (r.summary ?? {}) as { gimnasios?: number; corrieron?: number; yaCorrieronHoy?: number; fallidos?: string[]; conErrores?: string[] };
    const cifras = r.summary
      ? ` · ${s.gimnasios ?? 0} gimnasio(s) · corrieron ${s.corrieron ?? 0}` + (runner === 'DAILY' ? ` · ya habían corrido ${s.yaCorrieronHoy ?? 0}` : '') +
        ((s.fallidos?.length ?? 0) ? ` · fallaron ${s.fallidos!.length}` : '') + ((s.conErrores?.length ?? 0) ? ` · con errores ${s.conErrores!.length}` : '')
      : '';
    console.log(`  ${cuando(r.startedAt)} (${hace(r.startedAt)})  ${ESTADO[r.status] ?? r.status}${cifras}  [${r.host}${r.perfil ? ` · ${r.perfil}` : ''}]${r.note ? `\n      ${r.note}` : ''}`);
  }
  const ultimaBuena = (await repo.recent(50, runner)).find((r) => r.status === 'OK' || r.status === 'WITH_ERRORS');
  const tope = runner === 'DAILY' ? 36 * 3_600_000 : 60 * 60_000;
  if (!viva && (!ultimaBuena || Date.now() - ultimaBuena.startedAt.getTime() > tope)) {
    atencion += 1;
    console.log(`  ⚠ ${ultimaBuena ? `No termina una corrida desde ${cuando(ultimaBuena.startedAt)}` : 'Ninguna corrida ha terminado'}: revisa que el ciclo esté encendido (scripts/jobs-ciclo.sh).`);
  }
}

// Qué corrió hoy: los jobs diarios de cada gimnasio contra su fecha de negocio.
const planes = armarPlanes(BACKEND_MODULES);
console.log('\n── Hoy, por gimnasio (jobs diarios) ──');
const filaDe = async (organizationId: string | null, nombre: string, fecha: string, jobs: readonly string[]) => {
  const pasos = await repo.stepsOn(new Date(`${fecha}T00:00:00.000Z`), organizationId);
  // De cada job cuenta su último paso; si alguno terminó OK hoy, ya corrió.
  const ultimo = new Map<string, string>();
  for (const p of pasos) if (ultimo.get(p.job) !== 'OK') ultimo.set(p.job, p.status);
  const bien = jobs.filter((j) => ultimo.get(j) === 'OK');
  const mal = jobs.filter((j) => ultimo.has(j) && ultimo.get(j) !== 'OK');
  const faltan = jobs.filter((j) => !ultimo.has(j));
  console.log(`  ${nombre} · ${fecha}: ${bien.length} de ${jobs.length} bien` +
    (mal.length ? ` · ⚠ ${mal.map((j) => `${j} (${ESTADO[ultimo.get(j)!] ?? ultimo.get(j)})`).join(', ')}` : '') +
    (faltan.length ? ` · sin correr hoy: ${faltan.length === jobs.length ? 'todos' : faltan.join(', ')}` : ''));
};
await filaDe(null, 'Plataforma', hoyEn(ZONA_PLATAFORMA), planes.plataforma.map((j) => j.name));
// La fecha del cierre de un gimnasio es la que ya empezó en todas sus sedes (2.13).
for (const org of await repo.organizations()) await filaDe(org.id, org.tradeName, (await new BusinessCalendar(org.id).dias()).cierre.toISOString().slice(0, 10), planes.diario.map((j) => j.name));
console.log('  (los de un módulo apagado en el gimnasio aparecen como «sin correr hoy»)');

// Lo que alguien tiene que mirar: falló o se quedó a medias y no hay un OK posterior.
const desde = new Date(Date.now() - dias * 86_400_000);
const nombres = new Map((await repo.organizations()).map((o) => [o.id, o.tradeName]));
const pendientes = [] as Array<{ job: string; organizationId: string | null; status: string; startedAt: Date; error: string | null; errors: unknown }>;
// Resuelto: un diario que terminó OK en esa misma fecha de negocio (el cierre ya no lo
// repite), o un frecuente con una corrida posterior que terminó (los frecuentes
// sin novedad no dejan paso, así que cuenta la corrida).
const frecuentes = new Set(planes.frecuente.map((j) => j.name));
const ultimaTerminada = (await repo.recent(50)).find((r) => r.status === 'OK' || r.status === 'WITH_ERRORS')?.startedAt ?? null;
for (const p of await repo.pendingAttention(desde)) {
  const bienEseDia = (await repo.stepsOn(p.businessDate, p.organizationId)).some((q) => q.job === p.job && q.status === 'OK');
  const corridaPosterior = frecuentes.has(p.job) && p.status !== 'WITH_ERRORS' && ultimaTerminada !== null && ultimaTerminada > p.startedAt;
  if (!bienEseDia && !corridaPosterior) pendientes.push(p);
}
console.log(`\n── Para revisar (últimos ${dias} días) ──`);
if (pendientes.length === 0) console.log('  Nada: ningún job falló ni se quedó a medias sin haberse corrido bien después.');
for (const p of pendientes.slice(0, 40)) {
  atencion += 1;
  const errores = Array.isArray(p.errors) ? p.errors.length : 0;
  console.log(`  ⚠ ${cuando(p.startedAt)}  ${(p.organizationId ? nombres.get(p.organizationId) : 'Plataforma') ?? p.organizationId} · ${p.job}: ${ESTADO[p.status] ?? p.status}` +
    (p.error ? ` · ${p.error}` : '') + (errores ? ` · ${errores} errores por entidad` : ''));
}
if (pendientes.length > 40) console.log(`  … y ${pendientes.length - 40} más.`);

await closeDb();
process.exit(atencion > 0 ? 1 : 0);
