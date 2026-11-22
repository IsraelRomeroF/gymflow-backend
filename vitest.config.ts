import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `pnpm perf` corre solo la medición de rutas calientes; `pnpm test`, solo las pruebas.
    include: process.env.PERF ? ['perf/**/*.test.ts'] : ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Una vez, antes del primer archivo: pone al día el volumen sembrado (ver el archivo).
    globalSetup: ['./test/preparar-base.ts'],
    // Las pruebas comparten una sola base de datos de desarrollo: ejecutarlas
    // en paralelo produciría interferencias entre sesiones y bitácora.
    fileParallelism: false,
    // 60 s y no 30 (1.17b): con la máquina cargada (varias suites a la vez) pruebas que tardan uno o dos
    // segundos pasaban de 30 y fallaban sin tener nada malo (`firmas`, `memberships`, el cierre de verdad).
    // Una prueba colgada de verdad tarda ahora un minuto en decirlo; a cambio una corrida lenta no miente.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    // NINGÚN ARCHIVO DEPENDE DE QUE OTRO HAYA CORRIDO ANTES (1.17b). Sin esto el
    // orden lo pone vitest (por tamaño y por lo que tardó la corrida anterior) y
    // una dependencia escondida solo se nota en una base recién sembrada: así
    // pasó con `payments.test.ts`, que necesitaba un texto que publicaba
    // `privacidad-ciclo.test.ts`. `BARAJAR=1 pnpm test` corre los archivos en
    // orden al azar (la semilla sale en la consola; `SEMILLA=n` la repite).
    sequence: {
      shuffle: { files: !!process.env.BARAJAR, tests: false },
      ...(process.env.SEMILLA ? { seed: Number(process.env.SEMILLA) } : {}),
    },
  },
});
