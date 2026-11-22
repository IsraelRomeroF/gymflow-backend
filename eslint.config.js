import { readdirSync, statSync } from 'node:fs';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Reglas de arquitectura verificadas por el linter.
 *
 * Son dos, y las dos existen porque la alternativa es confiar en que nadie se
 * olvide:
 *
 *  1. El cliente de base de datos SOLO se importa desde un repositorio
 *     (control nº2 de ADR-001). Sin ella, el aislamiento entre gimnasios
 *     depende de recordar poner `organizationId` en cada `where`.
 *
 *  2. Un módulo NO puede importar las tripas de otro: solo su `index.ts`.
 *     Esta es la que convierte "backend modular" en algo real. Mientras se
 *     respete, extraer un módulo a servicio propio es cambiar lo que hay
 *     detrás de esa puerta; en cuanto se viole una vez, deja de serlo.
 *     La prueba `test/module-boundaries.test.ts` la verifica también, con un
 *     mensaje que dice qué frontera se cruzó y por dónde debería pasar.
 */
const nodeGlobals = {
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  __dirname: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', URL: 'readonly',
  URLSearchParams: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
  fetch: 'readonly', NodeJS: 'readonly', crypto: 'readonly',
};

/**
 * Se listan explícitamente en vez de usar un comodín: un patrón de dos niveles
 * también atrapaba los imports a `platform`, que son legítimos. La lista se duplica en
 * `test/module-boundaries.test.ts`, pero esa prueba descubre los módulos
 * leyendo el directorio, así que un módulo nuevo que se olvide de esta lista
 * sigue quedando cubierto por la prueba.
 */
// Los módulos se LEEN del disco, no se enumeran a mano.
// La lista escrita a mano se quedó atrás siete módulos —pos, analytics,
// access, portal y los nuevos no estaban— así que la regla no los vigilaba y
// nadie lo notó, porque el único aviso habría sido su ausencia. Solo la prueba
// de fronteras, que sí recorre el disco, seguía cubriéndolos.
const MODULOS = readdirSync(new URL('./src/modules', import.meta.url))
  .filter((d) => statSync(new URL(`./src/modules/${d}`, import.meta.url)).isDirectory());

const FRONTERA =
  'Frontera de módulo cruzada. Un módulo solo puede importar el `index.js` de otro, ' +
  'nunca sus archivos internos. Si te falta algo, expórtalo en el index del módulo ' +
  'dueño y documenta por qué forma parte de su superficie.';

const SOLO_REPOSITORIOS = [
  {
    name: '@gymflow/db',
    message:
      'El cliente de base de datos solo se importa desde un repositorio ' +
      '(`*.repository.ts`) o desde `platform/db/`. Toda consulta debe pasar ' +
      'por un repositorio que inyecte organizationId (ADR-001).',
  },
  {
    name: '@prisma/client',
    message: 'Prohibido importar Prisma directamente. Usa un repositorio.',
  },
];

/** `getDb()` es el mismo cliente por la puerta de atrás (EST-02). */
const CLIENTE = {
  group: ['**/db/client.js', '**/db/client'],
  message:
    'El cliente compartido (`getDb`) solo lo usan los repositorios: fuera de ' +
    'ellos se salta el filtro por organización y la unidad de trabajo. Mueve ' +
    'la consulta a un `*.repository.ts`.',
};

/** Un nivel y dos: también vigila las subcarpetas de un módulo. */
const FRONTERAS = MODULOS.flatMap((m) => [
  { group: [`../${m}/*`, `!../${m}/index.js`], message: FRONTERA },
  { group: [`../../${m}/*`, `!../../${m}/index.js`], message: FRONTERA },
]);

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  { languageOptions: { globals: nodeGlobals } },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // OJO: en la configuración plana, dos bloques con la misma regla NO se
  // suman: el último que aplica a un archivo reemplaza al anterior. Así se
  // apagó una vez "solo los repositorios tocan la base" dentro de los módulos
  // (EST-01). Por eso cada bloque lleva la regla COMPLETA para sus archivos,
  // y `test/module-boundaries.test.ts` comprueba que siguen encendidas.
  {
    files: ['src/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: SOLO_REPOSITORIOS, patterns: [CLIENTE] }] },
  },
  {
    files: ['src/modules/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: SOLO_REPOSITORIOS, patterns: [CLIENTE, ...FRONTERAS] }] },
  },
  {
    // Un repositorio SÍ toca el cliente, pero no el interior de otro módulo.
    files: ['src/modules/**/*.repository.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: FRONTERAS }] },
  },
  {
    // La plataforma de datos y el repositorio de la bitácora.
    files: ['src/platform/db/**/*.ts', 'src/platform/audit/*.repository.ts', 'src/platform/modules/*.repository.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  { files: ['test/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
);
