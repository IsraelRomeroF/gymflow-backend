import { writeFileSync } from 'node:fs';
import { it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures } from '../test/helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * MEDICIÓN DE RUTAS CALIENTES: consultas a la base y milisegundos por ruta.
 *
 *   pnpm perf                                    contra la base de DATABASE_URL (una gymflow_test*)
 *   DATABASE_URL=...gymflow_pruebas pnpm perf    contra la de los recorridos (datos realistas)
 *
 * Escribe la tabla en `perf/medicion.txt` (o `MEDIR_SALIDA`). Registra un
 * cobro de $1.00 en la primera sede: por eso no forma parte de `pnpm test`.
 * Las cifras de referencia del 2026-10-03 están en
 * gymflow-docs/auditoria/2026-10-03-optimizacion.md.
 *
 * DESDE 1.17b (28-19) LA MEDICIÓN FALLA cuando mide un error o cuando una
 * ruta se pasa de su tope:
 *  · toda ruta medida tiene que responder 2xx. Antes se medían dos 422 sin
 *    que nadie lo notara: `/reports/daily` sin fechas y `/cash-sessions/current`,
 *    que no existe (caía en `/cash-sessions/:id` con «current» como id);
 *  · cada ruta tiene un tope de CONSULTAS (`TOPES`). Los milisegundos se
 *    anotan pero no se afirman: dependen de la máquina y de qué más corre.
 *    Las consultas no: si una ruta pasa de 3 a 30 es un N+1, aquí y en
 *    producción. El tope es la medición del 2026-11-21 con holgura; subirlo
 *    es una decisión que se escribe aquí.
 */
const TOPES: Record<string, number> = {
  'GET /auth/me': 8,
  'GET /members/search?q=mar': 4,
  'GET /members?limit=50': 5,
  'GET /members/:id': 5,
  'GET /members/:id/statement': 18,
  'GET /members/:id/memberships': 8,
  'GET /members/access-summary (10 ids)': 12,
  'GET /dashboard?days=1': 30,
  'GET /dashboard?days=30': 30,
  'GET /reports/pulse': 60,
  'GET /reports/daily (mes en curso)': 12,
  'GET /approvals/inbox': 5,
  'GET /audit?limit=200': 16,
  'GET /classes/schedules (7 días)': 6,
  'GET /cash-sessions/open-lite': 6,
  'GET /cash-sessions/:id (corte)': 12,
  'GET /branches': 4,
  'GET /cash-registers': 4,
  'GET /organization/setup': 16,
  // Tope FIJO desde el bloque 2.11 (22-15): antes hacía de 2 a 6 consultas por marca
  // (de 59 a 143 con 24 marcas) y su tope era por marca. Ahora carga todo de una vez.
  // De 22 a 24 en el bloque 4.9 (D-39): la mensualidad de cada marca necesita además el IVA con su fecha y los descuentos
  // vivos. Son DOS consultas para todas las marcas (se cargan junto con los precios), no por marca: sigue siendo fijo.
  'GET /platform/organizations': 24,
  'GET /platform/organizations/:id': 14,
  'POST /members/:id/payments (CASH 100)': 32,
};
const SALIDA = process.env.MEDIR_SALIDA ?? new URL('./medicion.txt', import.meta.url).pathname;
let app: FastifyInstance;
let consultas = 0;
beforeAll(async () => {
  process.env.DB_LOG_QUERIES = '1';
  app = await makeApp();
  (getDb() as unknown as { $on: (e: string, f: () => void) => void }).$on('query', () => { consultas++; });
});
afterAll(async () => { await app.close(); await closeDb(); });

it('mide', async () => {
  const { demo, demoBranches } = await orgFixtures();
  const gerencia = await loginAs(app, 'gerencia@demo.mx');
  const recepcion = await loginAs(app, 'recepcion@demo.mx');
  const duena = await loginAs(app, 'owner@demo.mx');
  const plataforma = await loginAs(app, 'plataforma@gymflow.mx');
  const db = getDb();
  const socio = await db.member.findFirstOrThrow({ where: { organizationId: demo.id, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  const branchId = demoBranches[0]!.id;
  const register = await db.cashRegister.findFirstOrThrow({ where: { organizationId: demo.id, branchId, code: 'C1', deletedAt: null } });
  let sesion = await db.cashSession.findFirst({ where: { organizationId: demo.id, cashRegisterId: register.id, status: 'OPEN' } });
  if (!sesion) {
    const r = await app.inject({ method: 'POST', url: '/cash-sessions', headers: { cookie: gerencia }, payload: { cashRegisterId: register.id, openingFloatCents: '150000' } });
    sesion = await db.cashSession.findUniqueOrThrow({ where: { id: r.json().id as string } });
  }
  const auditoria = await app.inject({ method: 'GET', url: '/audit?limit=200', headers: { cookie: gerencia } });

  const lineas: string[] = [];
  const medidas: Array<{ nombre: string; status: number; max: number; cuerpo: string }> = [];
  const medir = async (nombre: string, fn: () => Promise<{ statusCode: number; body: string }>, veces = 5) => {
    const tiempos: number[] = []; const cuentas: number[] = []; let status = 0; let bytes = 0; let cuerpo = '';
    for (let i = 0; i < veces; i++) {
      consultas = 0; const t0 = performance.now();
      const r = await fn();
      tiempos.push(performance.now() - t0); cuentas.push(consultas); status = r.statusCode; bytes = Buffer.byteLength(r.body); cuerpo = r.body.slice(0, 200);
    }
    tiempos.sort((a, b) => a - b);
    medidas.push({ nombre, status, max: Math.max(...cuentas), cuerpo });
    lineas.push(`${nombre.padEnd(48)} ${String(status).padStart(3)}  consultas ${String(Math.min(...cuentas)).padStart(3)}-${String(Math.max(...cuentas)).padEnd(3)} p50 ${tiempos[Math.floor(veces / 2)]!.toFixed(1).padStart(6)} ms  ${(bytes / 1024).toFixed(1)} KB`);
  };
  const get = (url: string, cookie: string) => () => app.inject({ method: 'GET', url, headers: { cookie } });

  await medir('GET /auth/me', get('/auth/me', recepcion));
  await medir('GET /members/search?q=mar', get('/members/search?q=mar', recepcion));
  await medir('GET /members?limit=50', get('/members?limit=50', recepcion));
  await medir(`GET /members/:id`, get(`/members/${socio.id}`, recepcion));
  await medir(`GET /members/:id/statement`, get(`/members/${socio.id}/statement`, recepcion));
  await medir(`GET /members/:id/memberships`, get(`/members/${socio.id}/memberships`, recepcion));
  await medir('GET /members/access-summary (10 ids)', get(`/members/access-summary?ids=${(await db.member.findMany({ where: { organizationId: demo.id }, take: 10, select: { id: true } })).map((m) => m.id).join(',')}`, recepcion));
  await medir('GET /dashboard?days=1', get('/dashboard?days=1', gerencia));
  await medir('GET /dashboard?days=30', get('/dashboard?days=30', gerencia));
  await medir('GET /reports/pulse', get('/reports/pulse', duena));
  const hoy = new Date().toISOString().slice(0, 10);
  await medir('GET /reports/daily (mes en curso)', get(`/reports/daily?from=${hoy.slice(0, 8)}01&to=${hoy}`, gerencia));
  await medir('GET /approvals/inbox', get('/approvals/inbox', gerencia));
  await medir('GET /audit?limit=200', get('/audit?limit=200', gerencia));
  await medir('GET /classes/schedules (7 días)', get('/classes/schedules', gerencia));
  await medir('GET /cash-sessions/open-lite', get(`/cash-sessions/open-lite?branchId=${branchId}`, recepcion));
  await medir('GET /cash-sessions/:id (corte)', get(`/cash-sessions/${sesion!.id}`, gerencia));
  await medir('GET /branches', get('/branches', recepcion));
  await medir('GET /cash-registers', get('/cash-registers', gerencia));
  await medir('GET /organization/setup', get('/organization/setup', gerencia));
  await medir('GET /platform/organizations', get('/platform/organizations', plataforma));
  await medir(`GET /platform/organizations/:id`, get(`/platform/organizations/${demo.id}`, plataforma));
  await medir('POST /members/:id/payments (CASH 100)', () => app.inject({
    method: 'POST', url: `/members/${socio.id}/payments`, headers: { cookie: recepcion },
    payload: { idempotencyKey: crypto.randomUUID(), method: 'CASH', amountCents: '100', branchId, cashSessionId: sesion!.id },
  }), 5);
  lineas.push(`(auditoría ${auditoria.statusCode}: ${(Buffer.byteLength(auditoria.body) / 1024).toFixed(1)} KB)`);
  const marcas = await db.organization.count({ where: { deletedAt: null } });
  lineas.push(`(marcas en la base: ${marcas}; medido el ${hoy})`);
  writeFileSync(SALIDA, lineas.join('\n') + '\n');

  // Lo que se midió tiene que ser una respuesta buena, no un error rápido.
  expect(medidas.filter((m) => m.status >= 300).map((m) => `${m.nombre} → ${m.status} ${m.cuerpo}`), 'rutas medidas que respondieron error').toEqual([]);
  // Y ninguna ruta se pasa de su tope de consultas.
  const sinTope = medidas.filter((m) => TOPES[m.nombre] === undefined).map((m) => m.nombre);
  expect(sinTope, 'rutas medidas sin tope en TOPES').toEqual([]);
  const pasadas = medidas
    .filter((m) => m.max > TOPES[m.nombre]!)
    .map((m) => `${m.nombre}: ${m.max} consultas (tope ${TOPES[m.nombre]})`);
  expect(pasadas, 'rutas que se pasaron de su tope de consultas').toEqual([]);
});
