import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { monthlyCloseResourceId, uuidv7 } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import type { BackendModule, ModuleJob } from '../src/platform/modules/types.js';
import type { JobResult } from '../src/platform/jobs/types.js';
import { armarPlanes, ORDEN_DIARIO, ORDEN_FRECUENTE, ORDEN_PLATAFORMA, type Ordenes } from '../src/platform/jobs/plan.js';
import { JobRunRepository } from '../src/platform/jobs/job-runs.repository.js';
import { BusinessCalendar } from '../src/platform/time/business-calendar.js';
import { correr, codigoDeSalida, leerArgumentos, type Corrida } from '../src/platform/jobs/runner.js';
import { BACKEND_MODULES } from '../src/modules.js';
import { APPROVAL_JOBS } from '../src/modules/approvals/index.js';

/**
 * BLOQUE 1.16 (auditoría 8): cómo corren los jobs. El cierre diario y el
 * corredor de 15 minutos con candado en `job_runs` (28-15, 11-09), un job de
 * plataforma por corrida (23-12) y la pasada de las firmas vencidas.
 *
 * Los jobs de estas pruebas son de mentira (cuentan sus llamadas): lo que se
 * prueba es el corredor, no la lógica de ningún módulo.
 */
describe('jobs · bloque 1.16', () => {
  const db = () => getDb();
  const repo = new JobRunRepository();
  let demo: string; let otro: string;

  const resultado = (job: string, processed = 1): JobResult => ({ job, processed, skipped: 0, batches: 1, truncated: false, errors: [] });
  /** Un módulo de mentira con sus jobs, y los órdenes que les tocan. */
  const modulo = (jobs: ModuleJob[]): { modules: BackendModule[]; ordenes: Ordenes } => ({
    modules: [{ name: 'prueba', module: 'core', register: () => {}, jobs }],
    ordenes: {
      diario: jobs.filter((j) => j.scope !== 'platform' && (j.cadence ?? 'daily') === 'daily').map((j) => j.name),
      frecuente: jobs.filter((j) => j.scope !== 'platform' && j.cadence === 'frequent').map((j) => j.name),
      plataforma: jobs.filter((j) => j.scope === 'platform').map((j) => j.name),
    },
  });
  const pasos = (runId: string) => db().jobRunStep.findMany({ where: { runId }, orderBy: { startedAt: 'asc' } });
  const terminada = (c: Corrida) => { if (c.estado === 'OCUPADO') throw new Error('La corrida no tomó el candado'); return c; };
  /** La fecha del cierre (2.13): la que ya empezó en todas las sedes del gimnasio, que tiene una en Tijuana. */
  const hoy = async () => (await new BusinessCalendar(demo).dias()).cierre;
  /** Espera a que se cumpla algo que depende de otra promesa en curso. */
  const hasta = async (cond: () => boolean) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); expect(cond()).toBe(true); };

  beforeAll(async () => {
    const f = await orgFixtures();
    demo = f.demo.id; otro = f.other.id;
  });
  // La tabla es de estas pruebas: en `gymflow_test` nadie más corre jobs con candado.
  beforeEach(async () => { await db().jobRunStep.deleteMany({}); await db().jobRun.deleteMany({}); });
  afterAll(async () => { await db().jobRunStep.deleteMany({}); await db().jobRun.deleteMany({}); await closeDb(); });

  describe('el plan', () => {
    it('cada job de verdad tiene su lugar: diarios, frecuentes y de plataforma', () => {
      const p = armarPlanes(BACKEND_MODULES);
      expect(p.diario.map((j) => j.name)).toEqual(ORDEN_DIARIO);
      expect(p.frecuente.map((j) => j.name)).toEqual(ORDEN_FRECUENTE);
      expect(p.plataforma.map((j) => j.name)).toEqual(ORDEN_PLATAFORMA);
      // 11-09: cerrar las clases terminadas y el dinero en tránsito no esperan al cierre.
      // D-16 (bloque 3.5): los lugares apartados sin pagar se liberan antes de cerrar clases.
      expect(ORDEN_FRECUENTE).toEqual(['payments.process-webhooks', 'payments.resolve-unknown', 'class.release-unpaid-holds', 'class.close-finished', 'approvals.expire-forgotten']);
      // 23-12: la factura a las marcas es de plataforma, no de cada gimnasio.
      expect(ORDEN_PLATAFORMA).toEqual(['platform.prices.apply', 'platform.invoices.issue', 'platform.collections', 'audit.verify-platform-chain']);
      // La verificación de la bitácora va al final de los diarios: después de todo lo que escribe en ella.
      expect(ORDEN_DIARIO.at(-1)).toBe('audit.verify-hash-chain');
      // Apagar Clases no deja clases «en curso» para siempre.
      expect(p.frecuente.find((j) => j.name === 'class.close-finished')?.whenDisabled).toBe('run');
    });

    it('un job sin lugar, repetido o en el orden equivocado no deja arrancar', () => {
      const a = { name: 'prueba.a', handler: async () => resultado('prueba.a') };
      const m = (jobs: ModuleJob[]): BackendModule[] => [{ name: 'prueba', module: 'core', register: () => {}, jobs }];
      expect(() => armarPlanes(m([a]), { diario: [], frecuente: [], plataforma: [] })).toThrow(/sin lugar en su orden: prueba\.a \(diario\)/);
      expect(() => armarPlanes(m([{ ...a, cadence: 'frequent' }]), { diario: ['prueba.a'], frecuente: [], plataforma: [] })).toThrow(/sin lugar en su orden: prueba\.a \(frecuente\)/);
      expect(() => armarPlanes(m([a]), { diario: ['prueba.a', 'prueba.fantasma'], frecuente: [], plataforma: [] })).toThrow(/Job desconocido en el orden: prueba\.fantasma/);
      expect(() => armarPlanes([...m([a]), ...m([a])], { diario: ['prueba.a'], frecuente: [], plataforma: [] })).toThrow(/Dos módulos declaran el job prueba\.a/);
    });

    it('los argumentos de los ejecutables', () => {
      expect(leerArgumentos([])).toEqual({ forzar: false });
      expect(leerArgumentos(['--forzar', '--gimnasio', demo])).toEqual({ forzar: true, soloGimnasios: [demo] });
    });
  });

  describe('el cierre diario', () => {
    it('corre el de plataforma UNA vez y cada job una vez por gimnasio, en orden; el mismo día no repite los diarios (23-12, 28-15)', async () => {
      const llamadas: string[] = [];
      const { modules, ordenes } = modulo([
        { name: 'prueba.diario-a', handler: async (org) => { llamadas.push(`a:${org}`); return resultado('prueba.diario-a'); } },
        { name: 'prueba.diario-b', handler: async (org) => { llamadas.push(`b:${org}`); return resultado('prueba.diario-b', 0); } },
        { name: 'prueba.frecuente', cadence: 'frequent', handler: async (org) => { llamadas.push(`f:${org}`); return resultado('prueba.frecuente'); } },
        { name: 'prueba.plataforma', scope: 'platform', handler: async () => { llamadas.push('plataforma'); return resultado('prueba.plataforma', 3); } },
      ]);
      const gimnasios = (await repo.organizations()).length;
      expect(gimnasios).toBeGreaterThanOrEqual(2);

      const primera = terminada(await correr({ runner: 'DAILY', modules, ordenes, perfil: null, host: 'prueba#1' }));
      expect(primera.estado).toBe('OK');
      expect(codigoDeSalida(primera)).toBe(0);
      // Plataforma: una sola vez, antes que cualquier gimnasio, aunque haya varios.
      expect(llamadas.filter((l) => l === 'plataforma')).toHaveLength(1);
      expect(llamadas[0]).toBe('plataforma');
      // Por gimnasio: a, b y el frecuente, en ese orden.
      expect(llamadas.filter((l) => l.endsWith(demo))).toEqual([`a:${demo}`, `b:${demo}`, `f:${demo}`]);
      expect(llamadas).toHaveLength(1 + gimnasios * 3);
      expect(primera.resumen).toMatchObject({ gimnasios, corrieron: 1 + gimnasios * 3, yaCorrieronHoy: 0, fallidos: [], conErrores: [] });

      // Lo que quedó en la base: la corrida cerrada y un paso por job, con la fecha de negocio.
      const fila = await db().jobRun.findUniqueOrThrow({ where: { id: primera.runId } });
      expect(fila).toMatchObject({ runner: 'DAILY', status: 'OK', host: 'prueba#1' });
      expect(fila.finishedAt).not.toBeNull();
      const fechaDeCierre = await hoy();
      const deDemo = (await pasos(primera.runId)).filter((p) => p.organizationId === demo);
      expect(deDemo.map((p) => [p.job, p.status, p.processed])).toEqual([['prueba.diario-a', 'OK', 1], ['prueba.diario-b', 'OK', 0], ['prueba.frecuente', 'OK', 1]]);
      expect(deDemo.every((p) => p.businessDate.getTime() === fechaDeCierre.getTime())).toBe(true);
      const dePlataforma = (await pasos(primera.runId)).filter((p) => p.organizationId === null);
      expect(dePlataforma.map((p) => [p.job, p.processed])).toEqual([['prueba.plataforma', 3]]);
      // Y el asiento del cierre en la bitácora del gimnasio, con la corrida.
      const deEstaPrueba = [primera.runId];
      const asientos = async () => (await db().auditLog.findMany({ where: { organizationId: demo, action: 'system.daily_run' }, orderBy: { at: 'desc' }, take: 5 }))
        .filter((a) => deEstaPrueba.includes((a.afterState as { runId?: string }).runId ?? ''));
      expect((await asientos()).map((a) => a.afterState)).toEqual([{ jobs: 3, failed: [], chain: 'skipped', runId: primera.runId }]);

      // Segunda corrida el mismo día: los diarios y el de plataforma ya corrieron; el frecuente corre siempre.
      llamadas.length = 0;
      const segunda = terminada(await correr({ runner: 'DAILY', modules, ordenes }));
      deEstaPrueba.push(segunda.runId);
      expect(segunda.estado).toBe('OK');
      expect(llamadas.sort()).toEqual((await repo.organizations()).map((o) => `f:${o.id}`).sort());
      expect(segunda.resumen).toMatchObject({ corrieron: gimnasios, yaCorrieronHoy: 1 + gimnasios * 2 });
      // No corrió ningún diario: no vuelve a asentar el cierre.
      expect(await asientos()).toHaveLength(1);

      // Forzada: repite todo.
      llamadas.length = 0;
      const forzada = terminada(await correr({ runner: 'DAILY', modules, ordenes, forzar: true }));
      deEstaPrueba.push(forzada.runId);
      expect(llamadas).toHaveLength(1 + gimnasios * 3);
      expect(await asientos()).toHaveLength(2);

      // Al día siguiente del gimnasio vuelven a correr los diarios.
      llamadas.length = 0;
      const manana = () => new Date(Date.now() + 24 * 3_600_000);
      const siguiente = terminada(await correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [demo], ahora: manana }));
      expect(llamadas).toEqual([`a:${demo}`, `b:${demo}`, `f:${demo}`]);
      expect(siguiente.resumen.yaCorrieronHoy).toBe(0);
    });

    it('un job que revienta no detiene a los demás, queda FAILED y la siguiente corrida solo repite ese', async () => {
      let falla = true;
      const llamadas: string[] = [];
      const { modules, ordenes } = modulo([
        { name: 'prueba.diario-a', handler: async () => { llamadas.push('a'); return resultado('prueba.diario-a'); } },
        { name: 'prueba.diario-b', handler: async () => { llamadas.push('b'); if (falla) throw new Error('se cayó la base'); return resultado('prueba.diario-b'); } },
        { name: 'prueba.diario-c', handler: async () => { llamadas.push('c'); return { ...resultado('prueba.diario-c'), errors: [{ entityId: 'x', error: 'no cuadra' }] }; } },
        { name: 'prueba.diario-d', handler: async () => { llamadas.push('d'); return resultado('prueba.diario-d'); } },
      ]);
      const c = terminada(await correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [demo] }));
      expect(llamadas).toEqual(['a', 'b', 'c', 'd']);
      expect(c.estado).toBe('FAILED');
      expect(codigoDeSalida(c)).toBe(1);
      expect(c.resumen.fallidos).toEqual(['Gimnasio Demo · prueba.diario-b: se cayó la base']);
      expect(c.resumen.conErrores).toEqual(['Gimnasio Demo · prueba.diario-c']);
      expect((await pasos(c.runId)).map((p) => [p.job, p.status, p.error])).toEqual([
        ['prueba.diario-a', 'OK', null], ['prueba.diario-b', 'FAILED', 'se cayó la base'], ['prueba.diario-c', 'WITH_ERRORS', null], ['prueba.diario-d', 'OK', null],
      ]);
      expect((await db().jobRun.findUniqueOrThrow({ where: { id: c.runId } })).status).toBe('FAILED');
      // El asiento del gimnasio dice cuáles fallaron (lo lee la bandeja de la plataforma).
      const asiento = (await db().auditLog.findMany({ where: { organizationId: demo, action: 'system.daily_run' }, orderBy: { at: 'desc' }, take: 3 }))
        .find((a) => (a.afterState as { runId?: string }).runId === c.runId);
      expect(asiento?.afterState).toMatchObject({ jobs: 3, failed: ['prueba.diario-b', 'prueba.diario-c'] });

      // La siguiente: lo que terminó OK no se repite; lo que falló o tuvo errores, sí.
      falla = false; llamadas.length = 0;
      const d = terminada(await correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [demo] }));
      expect(llamadas).toEqual(['b', 'c']);
      expect(d.estado).toBe('WITH_ERRORS');
      expect(d.resumen.yaCorrieronHoy).toBe(2);
    });
  });

  describe('el candado', () => {
    it('dos corridas simultáneas del cierre: la segunda se retira sin correr nada', async () => {
      let soltar!: () => void;
      const espera = new Promise<void>((r) => { soltar = r; });
      let llamadas = 0;
      const { modules, ordenes } = modulo([{ name: 'prueba.lento', handler: async () => { llamadas += 1; await espera; return resultado('prueba.lento'); } }]);

      const primera = correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [demo], host: 'ciclo#1' });
      await hasta(() => llamadas === 1);
      // La primera sigue dentro del job: una segunda, a mano, encuentra el candado.
      const segunda = await correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [demo], host: 'a-mano#2' });
      expect(segunda).toMatchObject({ estado: 'OCUPADO', host: 'ciclo#1' });
      expect(codigoDeSalida(segunda)).toBe(0);
      expect(llamadas).toBe(1);
      expect(await db().jobRun.count()).toBe(1);
      expect(await db().jobRun.count({ where: { status: 'RUNNING' } })).toBe(1);

      soltar();
      expect(terminada(await primera).estado).toBe('OK');
      expect(llamadas).toBe(1);
      // Suelto el candado, la siguiente sí corre (y encuentra el diario hecho).
      const tercera = terminada(await correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [demo] }));
      expect(tercera.resumen.yaCorrieronHoy).toBe(1);
      expect(llamadas).toBe(1);
    });

    it('dos que arrancan en el mismo instante: el índice único deja pasar a una sola', async () => {
      // Las dos pasan por la consulta previa; solo una inserta la fila RUNNING.
      const [a, b] = await Promise.all([
        repo.start({ runner: 'DAILY', host: 'a', perfil: null }), repo.start({ runner: 'DAILY', host: 'b', perfil: null }),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      // El corredor de 15 minutos es otro candado: puede coincidir con el cierre.
      expect(await repo.start({ runner: 'FREQUENT', host: 'c', perfil: null })).not.toBeNull();
      expect(await repo.start({ runner: 'FREQUENT', host: 'd', perfil: null })).toBeNull();
      await db().jobRun.deleteMany({});

      // Y con el corredor completo, lanzadas juntas muchas veces: cada job corre una sola vez.
      let llamadas = 0;
      const { modules, ordenes } = modulo([{ name: 'prueba.una-vez', handler: async () => { llamadas += 1; await new Promise((r) => setTimeout(r, 30)); return resultado('prueba.una-vez'); } }]);
      const juntas = await Promise.all([1, 2, 3, 4].map((n) => correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [demo], host: `junta#${n}` })));
      expect(juntas.filter((c) => c.estado === 'OK')).toHaveLength(1);
      expect(juntas.filter((c) => c.estado === 'OCUPADO')).toHaveLength(3);
      expect(llamadas).toBe(1);
    });

    it('el mismo job no corre a la vez para el mismo gimnasio desde el cierre y desde el corredor', async () => {
      let soltar!: () => void;
      const espera = new Promise<void>((r) => { soltar = r; });
      const llamadas: string[] = [];
      const { modules, ordenes } = modulo([{
        name: 'prueba.frecuente', cadence: 'frequent',
        handler: async (org) => { llamadas.push(org); if (llamadas.length === 1) await espera; return resultado('prueba.frecuente'); },
      }]);
      const cierre = correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [demo] });
      await hasta(() => llamadas.length === 1);
      // El corredor de 15 minutos arranca (su candado es otro), pero ese job de ese gimnasio lo tiene el cierre.
      const corredor = terminada(await correr({ runner: 'FREQUENT', modules, ordenes, soloGimnasios: [demo, otro] }));
      expect(corredor.estado).toBe('OK');
      expect(corredor.resumen).toMatchObject({ enOtraCorrida: 1, corrieron: 1 });
      expect(llamadas).toEqual([demo, otro]);
      soltar();
      expect(terminada(await cierre).estado).toBe('OK');
    });
  });

  describe('una corrida cortada a medias', () => {
    it('queda a la vista: la siguiente la marca ABANDONED con su job a medias, y lo vuelve a correr', async () => {
      const llamadas: string[] = [];
      const { modules, ordenes } = modulo([
        { name: 'prueba.diario-a', handler: async () => { llamadas.push('a'); return resultado('prueba.diario-a'); } },
        { name: 'prueba.diario-b', handler: async () => { llamadas.push('b'); return resultado('prueba.diario-b'); } },
        { name: 'prueba.diario-c', handler: async () => { llamadas.push('c'); return resultado('prueba.diario-c'); } },
      ]);
      // Un cierre que se cortó hace diez minutos (se apagó la computadora): terminó `a`, iba en `b`.
      const hace = (min: number) => new Date(Date.now() - min * 60_000);
      const cortada = uuidv7();
      await db().jobRun.create({ data: { id: cortada, runner: 'DAILY', status: 'RUNNING', host: 'ciclo#77', startedAt: hace(12), heartbeatAt: hace(10) } });
      await db().jobRunStep.create({ data: { id: uuidv7(), runId: cortada, organizationId: demo, job: 'prueba.diario-a', businessDate: await hoy(), status: 'OK', startedAt: hace(12), finishedAt: hace(11), processed: 4 } });
      const aMedias = uuidv7();
      await db().jobRunStep.create({ data: { id: aMedias, runId: cortada, organizationId: demo, job: 'prueba.diario-b', businessDate: await hoy(), status: 'RUNNING', startedAt: hace(11) } });

      const lineas: string[] = [];
      const c = terminada(await correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [demo], host: 'ciclo#78', bitacora: { archivo: null, linea: (t) => { lineas.push(t); } } }));
      expect(c.estado).toBe('OK');
      // Se sabe: en el resumen, en la bitácora y en la base.
      expect(c.resumen.abandonadas).toEqual([expect.objectContaining({ runId: cortada, runner: 'DAILY', host: 'ciclo#77', pasosAMedias: ['prueba.diario-b'] })]);
      expect(lineas.some((l) => /se cortó a medias/.test(l) && /Quedó a medias: prueba\.diario-b/.test(l))).toBe(true);
      const vieja = await db().jobRun.findUniqueOrThrow({ where: { id: cortada } });
      expect(vieja.status).toBe('ABANDONED');
      expect(vieja.note).toMatch(/Sin señal de vida.*ciclo#78/);
      expect(await db().jobRunStep.findUniqueOrThrow({ where: { id: aMedias } })).toMatchObject({ status: 'ABANDONED', error: expect.stringMatching(/a medias/) });
      // Y se retoma: `a` ya había terminado hoy; `b` (a medias) y `c` (no llegó) corren.
      expect(llamadas).toEqual(['b', 'c']);
      expect(c.resumen.yaCorrieronHoy).toBe(1);
      expect((await repo.pendingAttention(hace(60))).map((p) => [p.job, p.status])).toEqual([['prueba.diario-b', 'ABANDONED']]);
    });

    it('una corrida con señal de vida reciente NO se da por cortada; sin señal, la libera también el otro corredor', async () => {
      const { modules, ordenes } = modulo([{ name: 'prueba.frecuente', cadence: 'frequent', handler: async () => resultado('prueba.frecuente', 0) }]);
      const viva = uuidv7();
      await db().jobRun.create({ data: { id: viva, runner: 'DAILY', status: 'RUNNING', host: 'ciclo#5', heartbeatAt: new Date(Date.now() - 60_000) } });
      expect((await correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [demo] })).estado).toBe('OCUPADO');
      expect((await db().jobRun.findUniqueOrThrow({ where: { id: viva } })).status).toBe('RUNNING');

      // Pasan los cinco minutos sin señal: el corredor de 15 minutos la encuentra y la suelta.
      await db().jobRun.update({ where: { id: viva }, data: { heartbeatAt: new Date(Date.now() - 6 * 60_000) } });
      const c = terminada(await correr({ runner: 'FREQUENT', modules, ordenes, soloGimnasios: [demo] }));
      expect(c.resumen.abandonadas.map((a) => a.runId)).toEqual([viva]);
      expect((await db().jobRun.findUniqueOrThrow({ where: { id: viva } })).status).toBe('ABANDONED');
      expect(terminada(await correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [demo] })).estado).toBe('OK');
    });

    it('una corrida que estuvo detenida y fue dada por cortada deja de trabajar al volver', async () => {
      let soltar!: () => void;
      const espera = new Promise<void>((r) => { soltar = r; });
      const llamadas: string[] = [];
      const { modules, ordenes } = modulo([
        { name: 'prueba.diario-a', handler: async () => { llamadas.push('a'); await espera; return resultado('prueba.diario-a'); } },
        { name: 'prueba.diario-b', handler: async () => { llamadas.push('b'); return resultado('prueba.diario-b'); } },
      ]);
      let runId = '';
      const detenida = correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [demo], latidoMs: 20, alEmpezar: (id) => { runId = id; } });
      await hasta(() => llamadas.length === 1);
      // Otra la da por cortada mientras sigue dentro de `a`.
      expect(await repo.abandon(runId, 'Sin señal de vida (prueba)')).toBe(true);
      await new Promise((r) => setTimeout(r, 80));
      soltar();
      const c = terminada(await detenida);
      expect(c.estado).toBe('ABANDONED');
      expect(codigoDeSalida(c)).toBe(1);
      expect(llamadas).toEqual(['a']);
      expect((await db().jobRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('ABANDONED');
    });
  });

  describe('el corredor de 15 minutos', () => {
    it('corre solo los frecuentes, nunca se salta por «ya corrió hoy» y no deja pasos cuando no hubo nada (11-09)', async () => {
      const llamadas: string[] = [];
      let pendientes = 2;
      const { modules, ordenes } = modulo([
        { name: 'prueba.diario', handler: async () => { llamadas.push('diario'); return resultado('prueba.diario'); } },
        { name: 'prueba.plataforma', scope: 'platform', handler: async () => { llamadas.push('plataforma'); return resultado('prueba.plataforma'); } },
        { name: 'prueba.cierra-clases', cadence: 'frequent', handler: async () => { llamadas.push('clases'); const n = pendientes; pendientes = 0; return resultado('prueba.cierra-clases', n); } },
        { name: 'prueba.sin-novedad', cadence: 'frequent', handler: async () => { llamadas.push('nada'); return resultado('prueba.sin-novedad', 0); } },
      ]);
      const primera = terminada(await correr({ runner: 'FREQUENT', modules, ordenes, soloGimnasios: [demo], host: 'ciclo#9' }));
      expect(primera.estado).toBe('OK');
      // Ni los diarios ni el de plataforma (que es diario): solo lo que depende de la hora.
      expect(llamadas).toEqual(['clases', 'nada']);
      expect(await db().jobRun.findUniqueOrThrow({ where: { id: primera.runId } })).toMatchObject({ runner: 'FREQUENT', status: 'OK' });
      // Queda el paso del que hizo algo; el que no encontró nada no deja rastro.
      expect((await pasos(primera.runId)).map((p) => [p.job, p.processed])).toEqual([['prueba.cierra-clases', 2]]);
      // No escribe el asiento del cierre diario.
      const asientos = await db().auditLog.findMany({ where: { organizationId: demo, action: 'system.daily_run' }, orderBy: { at: 'desc' }, take: 3 });
      expect(asientos.some((a) => (a.afterState as { runId?: string }).runId === primera.runId)).toBe(false);

      // Quince minutos después: vuelve a correr los dos, aunque ya corrieron hoy.
      llamadas.length = 0;
      const segunda = terminada(await correr({ runner: 'FREQUENT', modules, ordenes, soloGimnasios: [demo] }));
      expect(llamadas).toEqual(['clases', 'nada']);
      expect(segunda.resumen).toMatchObject({ corrieron: 2, yaCorrieronHoy: 0 });
      // Sin novedad: la corrida queda (dice que el corredor sigue vivo), sin pasos.
      expect(await pasos(segunda.runId)).toEqual([]);
      expect((await repo.recent(5, 'FREQUENT')).map((r) => r.id)).toEqual([segunda.runId, primera.runId]);

      // El cierre diario purga las corridas frecuentes vacías de más de una semana; las demás se quedan.
      await db().jobRun.update({ where: { id: segunda.runId }, data: { startedAt: new Date(Date.now() - 8 * 86_400_000) } });
      await db().jobRun.update({ where: { id: primera.runId }, data: { startedAt: new Date(Date.now() - 9 * 86_400_000) } });
      terminada(await correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [demo] }));
      expect((await repo.recent(5, 'FREQUENT')).map((r) => r.id)).toEqual([primera.runId]);
    });

    it('con su propio candado: si la corrida anterior no ha terminado, la siguiente se retira', async () => {
      let soltar!: () => void;
      const espera = new Promise<void>((r) => { soltar = r; });
      let llamadas = 0;
      const { modules, ordenes } = modulo([{ name: 'prueba.frecuente', cadence: 'frequent', handler: async () => { llamadas += 1; await espera; return resultado('prueba.frecuente'); } }]);
      const lenta = correr({ runner: 'FREQUENT', modules, ordenes, soloGimnasios: [demo] });
      await hasta(() => llamadas === 1);
      expect((await correr({ runner: 'FREQUENT', modules, ordenes, soloGimnasios: [demo] })).estado).toBe('OCUPADO');
      soltar();
      expect(terminada(await lenta).estado).toBe('OK');
      expect(llamadas).toBe(1);
    });
  });

  describe('la pasada de las firmas vencidas (pendiente de 0.9)', () => {
    let app: FastifyInstance;
    beforeAll(async () => { app = await makeApp(); await app.ready(); });
    afterAll(async () => { await app.close(); });

    it('una solicitud a distancia que venció y nadie volvió a leer la cierra el job, con su asiento del sistema, una sola vez', async () => {
      const gerencia = await loginAs(app, 'gerencia@demo.mx');
      // D-03 (bloque 3.2): la misma operación se pide 3 veces por hora. Las de corridas anteriores de esta prueba ya pasaron.
      await db().approvalRequest.updateMany({ where: { organizationId: demo, resourceId: monthlyCloseResourceId('2022-03') }, data: { createdAt: new Date(Date.now() - 48 * 3_600_000) } });
      const pedida = await app.inject({
        method: 'POST', url: '/approvals/requests', headers: { cookie: gerencia },
        payload: { permission: 'reports:month:close', resourceType: 'MonthlyClose', resourceId: monthlyCloseResourceId('2022-03'), summary: 'El cierre de marzo' },
      });
      expect(pedida.statusCode, pedida.body).toBe(201);
      const id = pedida.json().id as string;
      const modules: BackendModule[] = [{ name: 'approvals', module: 'core', register: () => {}, jobs: APPROVAL_JOBS }];
      const ordenes: Ordenes = { diario: [], frecuente: ['approvals.expire-forgotten'], plataforma: [] };
      const asientos = () => db().auditLog.findMany({ where: { organizationId: demo, action: 'approval.remote.expire', resourceId: id } });

      // Todavía vigente: el job no la toca.
      terminada(await correr({ runner: 'FREQUENT', modules, ordenes, soloGimnasios: [demo] }));
      expect((await db().approvalRequest.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');

      // Venció y nadie la leyó ni abrió la bandeja.
      await db().approvalRequest.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const c = terminada(await correr({ runner: 'FREQUENT', modules, ordenes, soloGimnasios: [demo] }));
      expect(c.estado).toBe('OK');
      expect((await db().approvalRequest.findUniqueOrThrow({ where: { id } })).status).toBe('EXPIRED');
      expect((await asientos()).map((a) => [a.actorType, a.actorUserId])).toEqual([['SYSTEM', null]]);
      const paso = (await pasos(c.runId)).find((p) => p.job === 'approvals.expire-forgotten');
      expect(paso?.processed).toBeGreaterThanOrEqual(1);

      // También corre dentro del cierre diario, y no la asienta dos veces.
      terminada(await correr({ runner: 'DAILY', modules, ordenes, soloGimnasios: [demo] }));
      expect(await asientos()).toHaveLength(1);
    });
  });
});
