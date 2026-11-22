import { loadDotenvFromRepoRoot } from '../load-env.js';

loadDotenvFromRepoRoot();

// El runner valida el perfil igual que la API (0.1): con una combinación
// inválida (base de pruebas en el puerto del uso real, caja de arena fuera de
// pruebas, uso real sin proxies...) no corre ningún job. Va ANTES de abrir la
// base y de tomar el candado.
const { loadEnv } = await import('../env.js');
loadEnv();

const { closeDb } = await import('../db/client.js');
const { BACKEND_MODULES } = await import('../../modules.js');
const { perfilDe } = await import('../perfiles.js');
const { abrirBitacora } = await import('./bitacora.js');
const { JobRunRepository } = await import('./job-runs.repository.js');
const { correr, codigoDeSalida, leerArgumentos } = await import('./runner.js');

/**
 * EL CIERRE DIARIO. Es un ejecutable, no un servidor: lo invoca el ciclo
 * (`scripts/jobs-ciclo.sh`), un cron o alguien a mano.
 *
 *   tsx src/platform/jobs/run-daily.ts [--forzar] [--gimnasio <id>]
 *
 * Qué corre, en qué orden y con qué candados: `runner.ts` y `plan.ts`. El
 * ORDEN entre módulos se decide ahí, no dentro de cada módulo: una membresía
 * que expira hoy no debe recibir la cuota del periodo siguiente. Es la misma
 * razón por la que la composición de rutas vive en `app.ts`.
 *
 * Se puede correr las veces que haga falta: lo que ya terminó OK hoy se salta
 * (`--forzar` lo repite) y, si otro cierre está corriendo, este se retira.
 * Sale con 1 si algún job falló o terminó con errores.
 */
const perfil = perfilDe(process.env.DATABASE_URL);
let enCurso: string | null = null;
for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(senal, () => {
    // Cortado a mano o por el apagado: se dice en `job_runs` en el acto, sin
    // esperar a que la siguiente corrida lo descubra por la señal de vida.
    const cerrar = enCurso ? new JobRunRepository().abandon(enCurso, `Cortada por ${senal}`) : Promise.resolve(false);
    void cerrar.catch(() => false).then(() => closeDb()).finally(() => process.exit(130));
  });
}

let salida = 1;
try {
  const corrida = await correr({
    runner: 'DAILY', modules: BACKEND_MODULES, perfil, bitacora: abrirBitacora('cierre-diario', perfil),
    alEmpezar: (id) => { enCurso = id; }, ...leerArgumentos(process.argv.slice(2)),
  });
  salida = codigoDeSalida(corrida);
} finally {
  await closeDb();
}
process.exit(salida);
