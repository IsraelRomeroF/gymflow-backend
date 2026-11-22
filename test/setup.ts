import { loadDotenvFromRepoRoot } from '../src/platform/load-env.js';

loadDotenvFromRepoRoot();
process.env.NODE_ENV = 'test';

/**
 * LO QUE LA SUITE SUPONE Y LO QUE DEJA (bloque 1.17b).
 *
 * Base: una `gymflow_test*` con `seed`, `seed:demo` y `seed:volume`. Pasa
 * recién sembrada y también vuelta a correr sobre la misma base.
 *
 * Orden: ningún archivo depende de que otro haya corrido antes. Lo que varios
 * necesitan del Gimnasio Demo se deja listo AQUÍ, antes de cada archivo
 * (módulo de accesos encendido, textos vigentes). Se comprueba con
 * `BARAJAR=1 pnpm test` (ver `vitest.config.ts`).
 *
 * Datos que quedan en la base, a propósito (el libro es de solo agregar:
 * cobros, cargos y asientos no se borran ni con el rol dueño):
 *  · en el Gimnasio Demo y en Otro Gimnasio: los socios, cobros, turnos y
 *    sedes archivadas que crean los archivos de cada módulo. Por eso sus
 *    pruebas comparan pertenencias y diferencias, no conteos exactos;
 *  · un gimnasio «Registro de Rutas vN» por base (`rutas-fixtures.ts`): se
 *    crea una vez y se reutiliza;
 *  · un gimnasio «Propio …» por archivo y por corrida (`gimnasio-propio.ts`):
 *    reloj, concurrencia, cierre diario y listas. Nada de lo suyo lo ve otro
 *    archivo: todo cuelga de su `organizationId`, y sus sedes se archivan.
 * Las tablas `job_runs` y `job_run_steps` son de `jobs.test.ts`, que las vacía;
 * quien corra el cierre de verdad pasa `soloGimnasios` y borra lo suyo.
 */

/**
 * El monitor de accesos nace APAGADO en todo gimnasio (ADR-036). Las pruebas
 * del torniquete, el padrón firmado y los gateways lo necesitan encendido en
 * el gimnasio de demostración; que nace apagado se prueba en `modules.test.ts`
 * con la otra organización.
 */
const { beforeAll } = await import('vitest');
beforeAll(async () => {
  const { getDb } = await import('../src/platform/db/client.js');
  const { ModuleStateRepository } = await import('../src/platform/modules/module-state.repository.js');
  const { forgetModules } = await import('../src/platform/modules/module-state.js');
  const demo = await getDb().organization.findFirst({ where: { tradeName: 'Gimnasio Demo' }, select: { id: true } });
  if (!demo) return;
  await new ModuleStateRepository(demo.id).set('turnstile', true, null, null);
  forgetModules(demo.id);
  // Los consentimientos de prueba (`CONSENTIMIENTOS`) firman la versión v1.0:
  // el servidor exige que exista publicada o retirada (PS-06). MARKETING lo
  // necesitan las pruebas del portal (PS-07/PS-08): en una base recién armada
  // no existe hasta que alguien lo publica.
  const { ConsentDocumentRepository } = await import('../src/modules/members/index.js');
  const textos = new ConsentDocumentRepository(demo.id);
  //
  // Desde el bloque 1.10 (21-06) una versión RETIRADA ya no se puede firmar y
  // solo se publica un borrador: aquí se garantiza que haya un texto VIGENTE
  // de cada tipo y `CONSENTIMIENTOS` (helpers) firma esa versión. En una base
  // recién armada es la v1.0; si una corrida vieja la dejó retirada, se
  // publica otra (las pruebas que escriben 'v1.0' a mano piden base rearmada).
  const { CONSENTIMIENTOS } = await import('./helpers.js');
  for (const tipo of ['PRIVACY_NOTICE', 'HOUSE_RULES', 'MARKETING']) {
    let vigente = await textos.findPublished(tipo);
    const v10 = await textos.findByTypeAndVersion(tipo, 'v1.0');
    // La v1.0 de prueba reemplaza al texto sembrado («demo-1»), como siempre;
    // si una corrida vieja la dejó retirada, se publica otra versión.
    if (vigente?.version !== 'v1.0' && (!v10 || v10.status === 'DRAFT' || !vigente)) {
      const borrador = v10?.status === 'DRAFT' ? v10
        : await textos.create({ consentType: tipo, version: v10 ? `v1.${Date.now()}` : 'v1.0', title: `${tipo} de prueba`, bodyText: `Texto de prueba ${tipo} v1.0` });
      vigente = await textos.publish(borrador.id, null);
    }
    const firma = CONSENTIMIENTOS.find((c) => c.consentType === tipo);
    if (firma && vigente) firma.documentVersion = vigente.version;
  }
  // Los textos OPCIONALES del gimnasio de pruebas, vigentes desde el primer
  // archivo (1.17b). Antes solo los publicaba `privacidad-ciclo.test.ts`: en una
  // base recién sembrada, `payments.test.ts` corre antes (vitest ordena por
  // tamaño) y sus 29 pruebas de domiciliación respondían 409 «No hay texto
  // publicado de Cargo recurrente». Ningún archivo debe depender de que otro
  // haya corrido antes.
  for (const tipo of ['RECURRING_CHARGE', 'BIOMETRIC', 'HEALTH_DATA']) {
    if (await textos.findPublished(tipo)) continue;
    const borrador = await textos.create({ consentType: tipo, version: `p${Date.now()}`, title: `${tipo} de prueba`, bodyText: `Texto de prueba ${tipo} para la suite.` });
    await textos.publish(borrador.id, null);
  }
  // El otro gimnasio sembrado también da de alta socios en varias pruebas.
  const otro = await getDb().organization.findFirst({ where: { tradeName: 'Otro Gimnasio' }, select: { id: true } });
  if (otro) await (await import('./helpers.js')).publicarTextosDePrueba(otro.id);
});
