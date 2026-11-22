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
 * EL CORREDOR DE 15 MINUTOS (11-09). Lo que depende de la hora del día y no
 * puede esperar al cierre: avisos del procesador de pagos, cobros sin
 * respuesta, clases que ya terminaron (asistió / faltó) y solicitudes de
 * firma que vencieron sin respuesta. La lista vive en `plan.ts`
 * (`ORDEN_FRECUENTE`).
 *
 *   tsx src/platform/jobs/run-frequent.ts [--gimnasio <id>]
 *
 * Tiene su propio candado: si la corrida anterior no ha terminado, esta se
 * retira; y un job que el cierre diario tenga abierto para un gimnasio se
 * omite aquí. Sale con 1 si algún job falló o terminó con errores.
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
    runner: 'FREQUENT', modules: BACKEND_MODULES, perfil, bitacora: abrirBitacora('cada-15-minutos', perfil),
    alEmpezar: (id) => { enCurso = id; }, ...leerArgumentos(process.argv.slice(2)),
  });
  salida = codigoDeSalida(corrida);
} finally {
  await closeDb();
}
process.exit(salida);
