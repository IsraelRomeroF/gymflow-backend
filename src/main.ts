import { loadDotenvFromRepoRoot } from './platform/load-env.js';

loadDotenvFromRepoRoot();

const { loadEnv } = await import('./platform/env.js');

// Con una configuración inválida (una variable que falta, o una combinación
// de base, puerto y pagos que no vale: `platform/perfiles.ts`) la API NO
// arranca. Se dice qué está mal en español y sin rastro de pila: quien lo lee
// es quien arranca GymFlow, no quien lo programa.
let env: ReturnType<typeof loadEnv>;
try {
  env = loadEnv();
} catch (e) {
  console.error(`\nGymFlow API no arrancó.\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

const { buildApp } = await import('./app.js');
const { closeDb } = await import('./platform/db/client.js');
const app = await buildApp(env);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'apagando');
  await app.close();
  await closeDb();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
app.log.info({ port: env.API_PORT, perfil: env.perfil }, 'GymFlow API lista');
