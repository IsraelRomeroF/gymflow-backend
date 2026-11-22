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
