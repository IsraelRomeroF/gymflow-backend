import { hostname } from 'node:os';
import { hoyEn } from '@gymflow/core';
import type { BackendModule } from '../modules/types.js';
import { modulesOf } from '../modules/module-state.js';
import { AuditService } from '../audit/audit.service.js';
import { BusinessCalendar } from '../time/business-calendar.js';
import { armarPlanes, runsFor, type Ordenes } from './plan.js';
import { JobRunRepository, type JobRunRow, type Runner } from './job-runs.repository.js';
import { bitacoraMuda, ZONA_PLATAFORMA, type Bitacora } from './bitacora.js';
import { systemContext, type JobCadence, type JobResult } from './types.js';

/**
 * EL CORREDOR DE LOS JOBS (auditoría 8, bloque 1.16; 28-15, 11-09, 23-12).
 *
 * Una sola función para los dos corredores:
 *  - `DAILY`, el cierre diario: los jobs de plataforma (una vez por corrida,
 *    fuera del bucle por gimnasio) y, por gimnasio, los diarios en su orden y
 *    después los frecuentes. Un job diario que ya terminó OK en la fecha de
 *    negocio del gimnasio (la que ya empezó en todas sus sedes) NO se repite: correr el cierre cada hora cuesta lo
 *    mismo que correrlo una vez, y lo que falló o se quedó a medias se
 *    reintenta en la siguiente corrida.
 *  - `FREQUENT`, el corredor de 15 minutos: solo los jobs frecuentes, que
 *    dependen de la hora y nunca se saltan por «ya corrió hoy».
 *
 * TRES CANDADOS, todos en la base (sirven entre procesos y entre máquinas):
 *  1. Por corredor: a lo más una corrida RUNNING de cada uno (índice único
 *     parcial de `job_runs`). La segunda que llega se retira sin hacer nada.
 *  2. Por job y gimnasio: el mismo job no corre a la vez desde el cierre y
 *     desde el corredor (índice único parcial de `job_run_steps`).
 *  3. Señal de vida: la corrida refresca `heartbeatAt` cada 30 s. Una corrida
 *     RUNNING sin señal desde hace 5 minutos se cortó (la máquina se apagó, el
 *     proceso murió): la siguiente, de cualquier corredor, la marca ABANDONED
 *     con sus pasos a medias, lo dice en la bitácora y sigue. Nada se queda a
 *     medias sin que se sepa.
 *
 * Un job que revienta no detiene a los demás ni a los otros gimnasios (DM-06).
 */
export const LATIDO_MS = 30_000;
export const SIN_SENAL_MS = 5 * 60_000;
/** Las corridas frecuentes vacías se purgan pasada una semana. */
const DIAS_DE_CORRIDAS_VACIAS = 7;

const NOMBRE: Record<Runner, string> = { DAILY: 'cierre diario', FREQUENT: 'corredor de 15 minutos' };

export type OpcionesDeCorrida = {
  runner: Runner;
  modules: readonly BackendModule[];
  bitacora?: Bitacora;
  perfil?: string | null;
  /** Quién corre, para distinguir el ciclo de una corrida a mano. Por omisión `host#pid`. */
  host?: string;
  /** Repite también los jobs diarios que ya corrieron OK hoy. */
  forzar?: boolean;
  /** Solo estos gimnasios (pruebas, o una corrida a mano para uno). */
  soloGimnasios?: readonly string[];
  /** Avisa el id de la corrida en cuanto se toma el candado (para cortarla con una señal). */
  alEmpezar?: (runId: string) => void;
  // Lo de abajo solo lo cambian las pruebas.
  ordenes?: Ordenes;
  ahora?: () => Date;
  latidoMs?: number;
  sinSenalMs?: number;
};

export type ResumenDeCorrida = {
  gimnasios: number;
  /** Jobs que corrieron (con o sin errores por entidad). */
  corrieron: number;
  /** Diarios saltados porque ya habían terminado OK en la fecha de negocio. */
  yaCorrieronHoy: number;
  /** Saltados porque el gimnasio tiene el módulo apagado. */
  moduloApagado: number;
  /** Saltados porque otra corrida tenía ese mismo job abierto. */
  enOtraCorrida: number;
  /** `gimnasio · job` que terminaron con errores por entidad. */
  conErrores: string[];
  /** `gimnasio · job: mensaje` de los que reventaron. */
  fallidos: string[];
  /** Corridas anteriores que se encontraron cortadas a medias. */
  abandonadas: Array<{ runId: string; runner: Runner; startedAt: string; host: string; pasosAMedias: string[] }>;
};

export type Corrida =
  /** Otra corrida del mismo corredor tiene el candado: esta no hizo nada. */
  | { estado: 'OCUPADO'; desde: Date; host: string; runId: string | null; resumen: ResumenDeCorrida }
  | { estado: 'OK' | 'WITH_ERRORS' | 'FAILED' | 'ABANDONED'; runId: string; resumen: ResumenDeCorrida };

const fechaDeNegocio = (zona: string, ahora: Date) => new Date(`${hoyEn(zona, ahora)}T00:00:00.000Z`);
const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Un paso que no encontró nada que hacer. */
const vacio = (r: JobResult) => r.processed === 0 && r.skipped === 0 && !r.truncated && r.errors.length === 0;

export async function correr(o: OpcionesDeCorrida): Promise<Corrida> {
  // Un job sin lugar en el orden revienta aquí, antes de tomar el candado.
  const planes = armarPlanes(o.modules, o.ordenes);
  const repo = new JobRunRepository();
  const log = o.bitacora ?? bitacoraMuda;
  const ahora = o.ahora ?? (() => new Date());
  const host = o.host ?? `${hostname()}#${process.pid}`;
  const resumen: ResumenDeCorrida = {
    gimnasios: 0, corrieron: 0, yaCorrieronHoy: 0, moduloApagado: 0, enOtraCorrida: 0, conErrores: [], fallidos: [], abandonadas: [],
  };

  // 1. Lo que se quedó a medias: se dice y se suelta su candado.
  for (const vieja of await repo.stale(new Date(Date.now() - (o.sinSenalMs ?? SIN_SENAL_MS)))) {
    const aMedias = (await repo.steps(vieja.id)).filter((p) => p.status === 'RUNNING').map((p) => p.job);
    const nota = `Sin señal de vida desde ${vieja.heartbeatAt.toISOString()}: la dio por cortada la corrida de ${host}`;
    if (!(await repo.abandon(vieja.id, nota))) continue;
    resumen.abandonadas.push({ runId: vieja.id, runner: vieja.runner, startedAt: vieja.startedAt.toISOString(), host: vieja.host, pasosAMedias: aMedias });
    log.linea(
      `⚠ Una corrida anterior del ${NOMBRE[vieja.runner]} se cortó a medias (empezó ${vieja.startedAt.toISOString()} en ${vieja.host}, ` +
      `sin señal de vida desde ${vieja.heartbeatAt.toISOString()}). ` +
      (aMedias.length ? `Quedó a medias: ${aMedias.join(', ')}. ` : 'No tenía ningún job abierto. ') +
      'Queda como ABANDONED en job_runs; lo que no terminó se vuelve a correr.',
    );
  }

  // 2. El candado del corredor.
  const ocupado = (viva: JobRunRow | null): Corrida => {
    log.linea(viva
      ? `Ya hay un ${NOMBRE[o.runner]} corriendo (desde ${viva.startedAt.toISOString()}, en ${viva.host}): esta corrida no hace nada.`
      : `Otro ${NOMBRE[o.runner]} tomó el candado en este instante: esta corrida no hace nada.`);
    return { estado: 'OCUPADO', desde: viva?.startedAt ?? new Date(), host: viva?.host ?? 'desconocido', runId: viva?.id ?? null, resumen };
  };
  const viva = await repo.running(o.runner);
  if (viva) return ocupado(viva);
  const run = await repo.start({ runner: o.runner, host, perfil: o.perfil ?? null });
  if (!run) return ocupado(await repo.running(o.runner));
  o.alEmpezar?.(run.id);

  // 3. Señal de vida. Si ya no somos RUNNING, otra corrida nos dio por
  //    cortados (el proceso estuvo detenido): se deja de trabajar.
  let perdida = false;
  const latido = setInterval(() => {
    repo.heartbeat(run.id).then((sigue) => { if (!sigue) perdida = true; }).catch(() => { /* la próxima señal lo reintenta */ });
  }, o.latidoMs ?? LATIDO_MS);
  latido.unref();

  /** Corre un job dentro de su paso. Devuelve si corrió y cómo. */
  const paso = async (
    org: { id: string; tradeName: string } | null, job: { name: string; cadence: JobCadence }, fecha: Date, handler: () => Promise<JobResult>,
    decir: (texto: string) => void = (t) => log.linea(t),
  ): Promise<{ estado: 'OK' | 'WITH_ERRORS' | 'FAILED' | 'OCUPADO'; result?: JobResult }> => {
    const etiqueta = `${org?.tradeName ?? 'Plataforma'} · ${job.name}`;
    const stepId = await repo.startStep({ runId: run.id, organizationId: org?.id ?? null, job: job.name, businessDate: fecha });
    if (!stepId) {
      resumen.enOtraCorrida += 1;
      decir(`  ${job.name.padEnd(34)} omitido: lo está corriendo otra corrida`);
      return { estado: 'OCUPADO' };
    }
    let result: JobResult;
    try {
      result = await handler();
    } catch (e) {
      await repo.failStep(stepId, mensaje(e));
      resumen.fallidos.push(`${etiqueta}: ${mensaje(e)}`);
      decir(`  ${job.name.padEnd(34)} ✗ FALLÓ: ${mensaje(e)}`);
      return { estado: 'FAILED' };
    }
    resumen.corrieron += 1;
    const conErrores = result.errors.length > 0;
    // Un job frecuente que no encontró nada no deja paso: la tabla cuenta lo que pasó.
    if (job.cadence === 'frequent' && vacio(result)) await repo.deleteStep(stepId);
    else await repo.finishStep(stepId, conErrores ? 'WITH_ERRORS' : 'OK', result);
    if (conErrores) resumen.conErrores.push(etiqueta);
    const errores = conErrores ? ` · ${result.errors.length} errores` : '';
    const truncado = result.truncated ? ' · ⚠ TRUNCADO: quedan candidatos' : '';
    decir(`  ${job.name.padEnd(34)} procesados: ${String(result.processed).padStart(5)}  lotes: ${result.batches}${errores}${truncado}`);
    for (const e of result.errors) decir(`      ✗ ${e.entityId}: ${e.error}`);
    return { estado: conErrores ? 'WITH_ERRORS' : 'OK', result };
  };

  const diaria = o.runner === 'DAILY';
  let estado: 'OK' | 'WITH_ERRORS' | 'FAILED' | 'ABANDONED' = 'OK';
  let nota: string | null = null;
  try {
    log.linea(`══ ${NOMBRE[o.runner]} · corrida ${run.id} · ${host}${o.perfil ? ` · perfil ${o.perfil}` : ''}${o.forzar ? ' · FORZADA' : ''}`);
    if (diaria) await repo.purgeEmptyFrequent(new Date(Date.now() - DIAS_DE_CORRIDAS_VACIAS * 86_400_000));

    // 4. Los de PLATAFORMA: una vez por corrida, fuera del bucle por gimnasio
    //    (23-12), y ANTES que los gimnasios: lo que asienten en la bitácora de
    //    un gimnasio queda cubierto por la verificación de la cadena de ese día.
    const dePlataforma = planes.plataforma.filter((j) => diaria || j.cadence === 'frequent');
    if (dePlataforma.length && !o.soloGimnasios) {
      const fecha = fechaDeNegocio(ZONA_PLATAFORMA, ahora());
      const hechos = diaria && !o.forzar ? await repo.okOn(null, fecha) : new Set<string>();
      log.linea('── Plataforma ──');
      for (const job of dePlataforma) {
        if (perdida) break;
        if (job.cadence === 'daily' && hechos.has(job.name)) {
          resumen.yaCorrieronHoy += 1;
          log.linea(`  ${job.name.padEnd(34)} ya corrió hoy`);
          continue;
        }
        await paso(null, job, fecha, () => job.handler());
      }
    }

    // 5. Por gimnasio.
    const orgs = await repo.organizations(o.soloGimnasios);
    resumen.gimnasios = orgs.length;
    for (const org of orgs) {
      if (perdida) break;
      // La fecha del cierre es la que ya empezó en TODAS las sedes abiertas
      // (2.13). En un gimnasio de una sola zona es su «hoy» de siempre. Con una
      // sede en otra zona, el cierre del día espera a que ese día empiece
      // también allá (una o dos horas): así corre UNA vez por fecha y a esa
      // hora cada job ya puede decidir lo de cada sede con el día de esa sede.
      const fecha = (await new BusinessCalendar(org.id).dias(ahora())).cierre;
      const activos = await modulesOf(org.id);
      const hechos = diaria && !o.forzar ? await repo.okOn(org.id, fecha) : new Set<string>();
      if (diaria) log.linea(`── ${org.tradeName} · ${fecha.toISOString().slice(0, 10)} ──`);
      // Lo que el cierre deja asentado en la bitácora del gimnasio (DP-04).
      const cierre = { jobs: 0, failed: [] as string[], chain: 'skipped' as 'ok' | 'broken' | 'skipped', runId: run.id };
      let diariosDeEstaCorrida = 0;
      for (const job of [...(diaria ? planes.diario : []), ...planes.frecuente]) {
        if (perdida) break;
        if (!runsFor(job, activos)) {
          resumen.moduloApagado += 1;
          if (diaria) log.linea(`  ${job.name.padEnd(34)} omitido: el módulo está apagado`);
          continue;
        }
        if (job.cadence === 'daily' && hechos.has(job.name)) {
          resumen.yaCorrieronHoy += 1;
          // La cadena que ya se verificó hoy sin errores sigue íntegra para el asiento.
          if (job.name === 'audit.verify-hash-chain') cierre.chain = 'ok';
          log.linea(`  ${job.name.padEnd(34)} ya corrió hoy`);
          continue;
        }
        if (!diaria) {
          // En el corredor de 15 minutos casi todo es «0 procesados»: esas
          // líneas no se escriben. Solo se nombra al gimnasio si hubo algo
          // que decir (procesó, falló o lo tenía otra corrida).
          const lineas: string[] = [];
          const r = await paso(org, job, fecha, () => job.handler(org.id), (t) => lineas.push(t));
          const sinNovedad = r.estado === 'OK' && r.result !== undefined && vacio(r.result);
          if (!sinNovedad) for (const l of lineas) log.linea(`${org.tradeName} ·${l}`);
          continue;
        }
        const r = await paso(org, job, fecha, () => job.handler(org.id));
        if (r.estado === 'OCUPADO') continue;
        if (job.cadence === 'daily') diariosDeEstaCorrida += 1;
        if (r.estado === 'FAILED') { cierre.failed.push(job.name); continue; }
        cierre.jobs += 1;
        if (r.estado === 'WITH_ERRORS') cierre.failed.push(job.name);
        if (job.name === 'audit.verify-hash-chain') cierre.chain = r.estado === 'OK' ? 'ok' : 'broken';
      }
      // Queda asentado que el día cerró (DP-04): soporte lo ve sin abrir la
      // base. Solo cuando esta corrida corrió algún job diario: las pasadas
      // que encuentran todo hecho no llenan la bitácora del gimnasio.
      if (diaria && diariosDeEstaCorrida > 0 && !perdida) {
        try {
          await new AuditService().record(systemContext(org.id), { action: 'system.daily_run', resourceType: 'Organization', resourceId: org.id, afterState: cierre });
        } catch (e) {
          log.linea(`  (no se pudo asentar la corrida: ${mensaje(e)})`);
        }
      }
    }

    if (perdida) {
      estado = 'ABANDONED';
      log.linea('⚠ Otra corrida dio a esta por cortada (estuvo sin señal de vida): se detiene aquí.');
    } else {
      estado = resumen.fallidos.length ? 'FAILED' : resumen.conErrores.length ? 'WITH_ERRORS' : 'OK';
    }
  } catch (e) {
    // Reventó el corredor mismo (la base se cayó, por ejemplo), no un job.
    estado = 'FAILED';
    nota = `El corredor se detuvo: ${mensaje(e)}`;
    resumen.fallidos.push(nota);
    log.linea(`✗ ${nota}`);
  } finally {
    clearInterval(latido);
  }

  if (estado !== 'ABANDONED') {
    try {
      const cerrada = await repo.finish(run.id, estado, resumen, nota);
      if (!cerrada) estado = 'ABANDONED';
    } catch (e) {
      log.linea(`✗ No se pudo cerrar la corrida ${run.id} en job_runs: ${mensaje(e)}. La siguiente la dará por cortada.`);
      estado = 'FAILED';
    }
  }

  if (resumen.fallidos.length) {
    log.linea(`${resumen.fallidos.length} job(s) fallaron:`);
    for (const c of resumen.fallidos) log.linea(`  ✗ ${c}`);
  }
  if (resumen.conErrores.length) log.linea(`${resumen.conErrores.length} job(s) terminaron con errores por entidad: ${resumen.conErrores.join('; ')}`);
  log.linea(
    `══ ${NOMBRE[o.runner]} ${estado} · ${resumen.gimnasios} gimnasio(s) · corrieron ${resumen.corrieron}` +
    (diaria ? ` · ya habían corrido hoy ${resumen.yaCorrieronHoy}` : '') +
    (resumen.enOtraCorrida ? ` · en otra corrida ${resumen.enOtraCorrida}` : '') +
    ` · fallaron ${resumen.fallidos.length} · con errores ${resumen.conErrores.length}`,
  );
  return { estado, runId: run.id, resumen };
}

/** Código de salida para el `cron` o el ciclo: 1 si algo falló o quedó con errores. */
export function codigoDeSalida(c: Corrida): number {
  return c.estado === 'FAILED' || c.estado === 'WITH_ERRORS' || c.estado === 'ABANDONED' ? 1 : 0;
}

/** Argumentos comunes de los dos ejecutables. */
export function leerArgumentos(argv: readonly string[]): { forzar: boolean; soloGimnasios?: string[] } {
  const forzar = argv.includes('--forzar');
  const i = argv.indexOf('--gimnasio');
  const id = i >= 0 ? argv[i + 1] : undefined;
  return id ? { forzar, soloGimnasios: [id] } : { forzar };
}
