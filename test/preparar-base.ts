import { loadDotenvFromRepoRoot } from '../src/platform/load-env.js';

/**
 * LA BASE, AL DÍA, ANTES DEL PRIMER ARCHIVO (bloque 1.17b). Es el `globalSetup` de vitest.
 *
 * `seed:volume` deja unas 3,000 membresías en el Gimnasio Demo con periodos por
 * renovar, cuotas por emitir y cuotas vencidas. Varias pruebas llaman a los
 * jobs del gimnasio entero (`rollPeriods(orgId)`, `generateCycleCharges(orgId)`…)
 * para probar SU caso, y en una base recién sembrada la primera que lo hacía se
 * llevaba de regalo poner al día todo el volumen: 20, 27 y hasta más de 60
 * segundos dentro de una prueba con tope de 30 («AUTORRENOVACIÓN» en
 * `memberships`, «aplica» en `imports`, «el job de generación» en `billing`,
 * la visita suelta en `dinero-falso`, según cuál corriera primero). Eran las
 * pruebas que «agotan el tiempo con la máquina cargada».
 *
 * Aquí se hace una vez, fuera de toda prueba y sin tope: la cadena de
 * membresías y cobro, en el orden del cierre diario, sobre el Gimnasio Demo.
 * Es lo mismo que hace `scripts/pruebas-reset.sh` con la base de los
 * recorridos (siembra y corre el cierre). En una base que ya está al día no
 * encuentra nada y tarda un par de segundos.
 */
export default async function prepararBase(): Promise<void> {
  loadDotenvFromRepoRoot();
  process.env.NODE_ENV = 'test';
  // La medición (`pnpm perf`) no llama a los jobs: no lo necesita.
  if (process.env.PERF) return;

  await confirmarSinEsperarAlDisco();
  const { getDb, closeDb } = await import('../src/platform/db/client.js');
  try {
    const demo = await getDb().organization.findFirst({ where: { tradeName: 'Gimnasio Demo' }, select: { id: true } });
    if (!demo) return;
    const { expireMemberships, suspendExpiredGrace } = await import('../src/modules/memberships/membership.jobs.js');
    const { rollPeriods, generateCycleCharges, markOverdueCharges, markMembershipsPastDue } = await import('../src/modules/billing/billing.jobs.js');
    const empezo = Date.now();
    const hechos: string[] = [];
    // El orden del plan (`platform/jobs/plan.ts`): vencer, avanzar periodos, emitir cuotas, marcar vencidas, mora, suspender.
    for (const job of [expireMemberships, rollPeriods, generateCycleCharges, markOverdueCharges, markMembershipsPastDue, suspendExpiredGrace]) {
      const r = await job(demo.id);
      if (r.processed > 0) hechos.push(`${r.job} ${r.processed}`);
    }
    const segundos = Math.round((Date.now() - empezo) / 1000);
    if (hechos.length > 0) console.log(`[preparar-base] Gimnasio Demo puesto al día en ${segundos} s: ${hechos.join(', ')}`);
  } finally {
    await closeDb();
  }
}

/**
 * LA BASE DE PRUEBAS NO ESPERA AL DISCO PARA CONFIRMAR (bloque 4.17).
 *
 * En esta máquina (WSL2) escribir la bitácora de transacciones de Postgres al
 * disco tarda a ratos de 1 a 7 segundos (`IO/WALSync`, `LWLock/WALWrite` en
 * `pg_stat_activity`), y en esos ratos cada COMMIT espera lo mismo. Una prueba
 * que confirma cientos de veces seguidas pasaba de 60 s sin estar colgada, y
 * la que seguía en el archivo caía en cascada. `synchronous_commit = off`
 * solo cambia cuándo se ESCRIBE al disco, no lo que se ve ni el orden: cada
 * transacción confirmada es visible al instante y las reglas, candados y
 * restricciones son las mismas. Lo que se pierde es lo confirmado en el último
 * segundo si la máquina se apaga de golpe, que en una base de pruebas no importa.
 *
 * Solo en `gymflow_test*` (la de cada agente y la del orquestador). El uso real,
 * los recorridos y CI no pasan por aquí. Vale para las conexiones nuevas: las
 * de los archivos, que abren después de este `globalSetup`.
 */
async function confirmarSinEsperarAlDisco(): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRATOR;
  if (!url) return;
  const { createPrismaClient } = await import('@gymflow/db');
  const dueno = createPrismaClient(url);
  try {
    const base = (await dueno.$queryRaw<Array<{ base: string }>>`SELECT current_database() AS base`)[0]?.base ?? '';
    if (!/^gymflow_test(_[a-z0-9]+)?$/.test(base)) return;
    await dueno.$executeRawUnsafe(`ALTER DATABASE "${base}" SET synchronous_commit = off`);
  } finally {
    await dueno.$disconnect();
  }
}
