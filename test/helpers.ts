import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/platform/env.js';
import { getDb } from '../src/platform/db/client.js';

export const PASSWORD = 'GymFlow.dev.2026';

export async function makeApp(overrides: Record<string, string> = {}): Promise<FastifyInstance> {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    // La suite activa decenas de dispositivos. Bajar el límite REAL para que
    // quepan sería debilitar el control por comodidad; se sube aquí y una
    // prueba comprueba que el valor por defecto sigue siendo estricto.
    PORTAL_ENROLL_ATTEMPTS: '1000',
    INTAKE_SUBMIT_ATTEMPTS: '1000',
    INTAKE_SUBMIT_PER_BRANCH: '100000',
    AUTH_ATTEMPTS_PER_IP: '10000',
    AUTH_ATTEMPTS_PER_NETWORK: '100000',
    ...overrides,
  });
  return buildApp(env);
}

export async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  if (res.statusCode !== 200) throw new Error(`login falló para ${email}: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'gf_session');
  if (!cookie) throw new Error('no se emitió cookie de sesión');
  return `gf_session=${cookie.value}`;
}

/**
 * CUENTA DE PLATAFORMA PARA PRUEBAS: una desechable por llamada, con la
 * sesión ya reconfirmada con su contraseña para las acciones críticas.
 */
export async function loginPlataforma(app: FastifyInstance): Promise<string> {
  const { uuidv7 } = await import('@gymflow/core');
  const { hash } = await import('@node-rs/argon2');
  const db = getDb();
  const email = `plataforma.${randomUUID().slice(0, 8)}@gymflow.mx`;
  await db.user.create({ data: { id: uuidv7(), organizationId: null, email, fullName: 'Soporte de pruebas',
    passwordHash: await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 }) } });
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
  if (login.json().status !== 'AUTHENTICATED') throw new Error(`login de plataforma: ${login.body}`);
  const cookie = `gf_session=${login.cookies.find((c) => c.name === 'gf_session')!.value}`;
  const r = await app.inject({ method: 'POST', url: '/platform/reauth', headers: { cookie }, payload: { password: PASSWORD } });
  if (r.statusCode !== 200) throw new Error(`reconfirmación de plataforma: ${r.body}`);
  return cookie;
}

export async function orgFixtures() {
  const db = getDb();
  const demo = await db.organization.findFirst({ where: { tradeName: 'Gimnasio Demo' } });
  const other = await db.organization.findFirst({ where: { tradeName: 'Otro Gimnasio' } });
  if (!demo || !other) throw new Error('Faltan datos de demo: corre `pnpm --filter @gymflow/db seed:demo`');

  // `deletedAt: null` a propósito: las pruebas crean sucursales desechables y
  // las archivan. Un fixture que incluyera las archivadas dejaría de reflejar
  // lo que la API considera una sucursal, y las comparaciones fallarían por
  // ruido de las pruebas en vez de por un defecto.
  const demoBranches = await db.branch.findMany({
    where: { organizationId: demo.id, deletedAt: null }, orderBy: { code: 'asc' },
  });
  const otherBranches = await db.branch.findMany({
    where: { organizationId: other.id, deletedAt: null },
  });
  const demoUsers = await db.user.findMany({ where: { organizationId: demo.id } });
  const otherUsers = await db.user.findMany({ where: { organizationId: other.id } });

  return { demo, other, demoBranches, otherBranches, demoUsers, otherUsers };
}

/**
 * Datos de prueba ÚNICOS.
 *
 * Vive aquí, en un solo sitio, porque tres copias en tres archivos derivaron
 * hasta colisionar: cada una llevaba su propia semilla y dos podían coincidir.
 *
 * Los nombres son SOLO LETRAS a propósito: la normalización elimina los
 * dígitos, así que un sufijo numérico produce claves idénticas y dispara el
 * detector de duplicados.
 */
const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function nombreUnico(prefijo: string): string {
  // De un UUID: 122 bits de entropía, no una semilla por archivo.
  const hex = randomUUID().replace(/-/g, '');
  let salida = '';
  for (let i = 0; i < 10; i++) {
    salida += LETRAS[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 26];
  }
  return `${prefijo}${salida}`;
}

let telefonoSeq = Math.floor(Math.random() * 90_000_000);

/** Teléfono mexicano válido y único dentro del proceso. */
export function telefonoUnico(): string {
  telefonoSeq = (telefonoSeq + 1) % 100_000_000;
  // Lada 99, que ninguna semilla usa (todas generan 55…): un teléfono de
  // prueba chocaba al azar con uno del sembrado de volumen y el alta
  // respondía "posible duplicado".
  return `+5299${String(telefonoSeq).padStart(8, '0')}`;
}

/** La versión la pone `setup.ts` antes de cada archivo: la VIGENTE del gimnasio de pruebas (1.10, 21-06). */
export const CONSENTIMIENTOS: Array<{ consentType: 'PRIVACY_NOTICE' | 'HOUSE_RULES'; documentVersion: string; granted: true }> = [
  { consentType: 'PRIVACY_NOTICE', documentVersion: 'v1.0', granted: true },
  { consentType: 'HOUSE_RULES', documentVersion: 'v1.0', granted: true },
];

/**
 * Un gimnasio no da de alta a nadie sin su aviso y su reglamento PUBLICADOS
 * (bloque 1.10, 21-06: una firma sin texto no prueba nada). Las pruebas que
 * dan de alta socios en un gimnasio que no es el de demostración lo dejan
 * listo con esto: publica los dos textos con la versión que firma `CONSENTIMIENTOS`.
 */
export async function publicarTextosDePrueba(organizationId: string): Promise<void> {
  const { ConsentDocumentRepository } = await import('../src/modules/members/index.js');
  const textos = new ConsentDocumentRepository(organizationId);
  for (const { consentType, documentVersion } of CONSENTIMIENTOS) {
    const vigente = await textos.findPublished(consentType);
    if (vigente?.version === documentVersion) continue;
    const existente = await textos.findByTypeAndVersion(consentType, documentVersion);
    if (existente && existente.status !== 'DRAFT') {
      throw new Error(`La base de pruebas tiene retirada la versión ${documentVersion} de ${consentType} en ese gimnasio: rearma la base (bootstrap, migrate deploy, seed, seed:demo).`);
    }
    const borrador = existente ?? await textos.create({ consentType, version: documentVersion, title: `${consentType} de prueba`, bodyText: `Texto de prueba ${consentType}` });
    await textos.publish(borrador.id, null);
  }
}

/**
 * Autorización maker-checker como en el mostrador: el SEGUNDO usuario teclea
 * su contraseña y la operación recibe un token de un solo uso, atado al
 * permiso y a quien lo pide (`cookie`).
 */
export async function aprobacion(
  app: FastifyInstance, cookie: string, permission: string,
  email = 'owner@demo.mx', branchId?: string,
  /** A qué operación y hasta qué importe: la firma ya no vale para otra (SEC2-05). */
  op: { resourceId?: string; amountCents?: string | bigint } = {},
): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/approvals', headers: { cookie },
    payload: {
      email, password: PASSWORD, permission, ...(branchId ? { branchId } : {}),
      ...(op.resourceId ? { resourceId: op.resourceId } : {}),
      ...(op.amountCents !== undefined ? { amountCents: op.amountCents.toString() } : {}),
    },
  });
  if (res.statusCode !== 200) throw new Error(`aprobación falló: ${res.statusCode} ${res.body}`);
  return res.json().approvalToken as string;
}

/**
 * Sede desechable para una prueba. Las tres primeras letras del código son el
 * prefijo de los códigos de socio y la base las exige únicas entre sedes
 * activas: con un sufijo al azar de pocas letras, las sedes que dejan las
 * corridas anteriores terminaban chocando. Se reintenta con otro prefijo y
 * quien la crea debe archivarla al terminar (`archivarSede`).
 */
export async function sedeDesechable(organizationId: string, name = 'Sede de prueba'): Promise<{ id: string; code: string }> {
  const { uuidv7 } = await import('@gymflow/core');
  const { getDb } = await import('../src/platform/db/client.js');
  const letras = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let intento = 0; intento < 25; intento++) {
    const hex = randomUUID().replace(/-/g, '');
    const pref = Array.from({ length: 3 }, (_, i) => letras[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 26]).join('');
    const code = `${pref}${hex.slice(6, 11).toUpperCase()}`;
    try {
      const b = await getDb().branch.create({ data: { id: uuidv7(), organizationId, code, name } });
      return { id: b.id, code: b.code };
    } catch (e) {
      if (!String(e).includes('branches_member_code_prefix_key') && !String(e).includes('Unique constraint')) throw e;
    }
  }
  throw new Error('No se encontró un prefijo de sede libre');
}

export async function archivarSede(id: string): Promise<void> {
  const { getDb } = await import('../src/platform/db/client.js');
  await getDb().branch.update({ where: { id }, data: { deletedAt: new Date() } });
}

/**
 * Correo único SIN dígitos: `Date.now()` son 13 cifras y, a veces, pasan la
 * prueba de Luhn; el filtro de números de tarjeta rechaza la petición (422)
 * y la prueba falla al azar.
 */
export function correoUnico(prefijo: string): string {
  const letras = Array.from({ length: 12 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
  return `${prefijo}-${letras}@demo.mx`;
}

/**
 * Una cuenta de personal para una prueba, con el puesto y las sucursales que
 * se pidan y la contraseña de siempre. Sirve para probar alcances que las
 * cuentas sembradas no cubren (p. ej. una recepción de dos sedes).
 */
export async function cuentaDePrueba(organizationId: string, roleKey: string, branchIds: Array<string | null>): Promise<string> {
  const { hash } = await import('@node-rs/argon2');
  const { uuidv7 } = await import('@gymflow/core');
  const db = getDb();
  const role = await db.role.findFirstOrThrow({ where: { organizationId: null, key: roleKey } });
  const email = `${nombreUnico('cuenta').toLowerCase()}@prueba.mx`;
  const user = await db.user.create({
    data: { id: uuidv7(), organizationId, email, fullName: nombreUnico('Cuenta'), passwordHash: await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 }) },
  });
  for (const branchId of branchIds) {
    await db.roleAssignment.create({ data: { id: uuidv7(), organizationId, userId: user.id, roleId: role.id, branchId } });
  }
  return email;
}

/** El coach ve solo a sus socios (2026-10-09): para probar lo suyo, se le asigna el socio. */
export async function asignarAlCoach(memberId: string, coachEmail = 'coach@demo.mx'): Promise<void> {
  const db = getDb();
  const coach = await db.user.findFirstOrThrow({ where: { email: coachEmail }, select: { id: true } });
  await db.member.update({ where: { id: memberId }, data: { coachUserId: coach.id } });
}
