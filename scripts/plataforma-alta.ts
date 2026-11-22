/**
 * ALTA DE UNA CUENTA DE PLATAFORMA — la que opera la consola de mayor rango
 * (da de alta, libera, suspende y cobra a todos los gimnasios).
 *
 *   pnpm plataforma:alta tu@correo.com "Tu nombre"
 *
 * Se hace desde el servidor y no desde la consola a propósito: una sesión
 * robada no puede crearse otra cuenta de plataforma. La contraseña es
 * temporal, se muestra UNA vez y se cambia al entrar.
 *
 * La base la fija el perfil (scripts/perfil.sh): `pnpm plataforma:alta` corre
 * con el de uso real (gymflow_local); para las pruebas,
 * `bash scripts/perfil.sh pruebas tsx scripts/plataforma-alta.ts …`. Sin perfil
 * no se adivina ninguna base: antes caía en gymflow_local, que es el uso real.
 */
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';

const [correo, ...resto] = process.argv.slice(2);
const nombre = resto.join(' ').trim();
if (!correo || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo) || nombre.length < 3) {
  console.error('Uso: pnpm plataforma:alta tu@correo.com "Tu nombre"');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Falta el perfil. Uso real: pnpm plataforma:alta tu@correo.com "Tu nombre" · Pruebas: bash scripts/perfil.sh pruebas tsx scripts/plataforma-alta.ts tu@correo.com "Tu nombre"');
  process.exit(1);
}
const { uuidv7 } = await import('@gymflow/core');
const { getDb, closeDb } = await import('../src/platform/db/client.js');
const db = getDb();

const ya = await db.user.findFirst({ where: { email: { equals: correo, mode: 'insensitive' }, deletedAt: null } });
if (ya) {
  console.error(`Ya existe una cuenta con ${correo}${ya.organizationId ? ' (es de un gimnasio)' : ''}.`);
  await closeDb();
  process.exit(1);
}
// 16 caracteres sin ambiguos (sin 0/O, 1/l/I): se dicta y se teclea bien.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const temporal = [...randomBytes(16)].map((b) => ALFABETO[b % ALFABETO.length]).join('');
await db.user.create({
  data: {
    id: uuidv7(), organizationId: null, email: correo.toLowerCase(), fullName: nombre,
    passwordHash: await hash(temporal, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
    mustChangePassword: true, mfaEnabled: false,
  },
});
const base = new URL(process.env.DATABASE_URL).pathname.slice(1);
// El panel del perfil: el primer origen permitido (4003 en pruebas, 3003 o el túnel en uso real).
const panel = process.env.CORS_ORIGINS?.split(',')[0]?.trim() || (base === 'gymflow_pruebas' ? 'http://localhost:4003' : 'http://localhost:3003');
console.log(`
Cuenta de plataforma creada en ${base}

  Correo:               ${correo.toLowerCase()}
  Contraseña temporal:  ${temporal}

Esta contraseña se muestra solo esta vez. Al entrar en ${panel}/login
te pedirá elegir tu propia contraseña, de al menos 12 caracteres.
`);
await closeDb();
