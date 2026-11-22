import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hoyEn } from '@gymflow/core';

/**
 * BITÁCORA DE CORRIDAS POR FECHA (28-15). Antes el ciclo del uso real
 * redirigía todo a un solo `cierre-diario.log` que se pisaba en cada arranque:
 * si algo falló ayer y GymFlow se reinició, el rastro ya no existía.
 *
 * Cada línea va a la salida estándar (para quien corre a mano o para el
 * `cron`) y se APPENDEA a un archivo por día y por corredor:
 *   `$GYMFLOW_LOGS/jobs/<perfil>/<corredor>-AAAA-MM-DD.log`
 * con `GYMFLOW_LOGS` = `~/.gymflow-logs` por omisión (el mismo directorio que
 * usa `gymflow.sh`). `GYMFLOW_JOBS_SIN_ARCHIVO=1` apaga el archivo (pruebas).
 */
export const ZONA_PLATAFORMA = 'America/Mexico_City';

export type Bitacora = {
  linea(texto: string): void;
  /** Ruta del archivo del día, o null si no se escribe archivo. */
  readonly archivo: string | null;
};

export function abrirBitacora(corredor: 'cierre-diario' | 'cada-15-minutos', perfil: string | null, opts: { silencio?: boolean } = {}): Bitacora {
  const sinArchivo = process.env.GYMFLOW_JOBS_SIN_ARCHIVO === '1';
  let archivo: string | null = null;
  if (!sinArchivo) {
    const raiz = process.env.GYMFLOW_LOGS?.trim() || join(homedir(), '.gymflow-logs');
    const dir = join(raiz, 'jobs', perfil ?? 'sin-perfil');
    try {
      mkdirSync(dir, { recursive: true });
      archivo = join(dir, `${corredor}-${hoyEn(ZONA_PLATAFORMA)}.log`);
    } catch (e) {
      console.log(`(no se pudo abrir la bitácora en ${dir}: ${e instanceof Error ? e.message : String(e)}; solo salida estándar)`);
      archivo = null;
    }
  }
  return {
    archivo,
    linea(texto: string) {
      if (!opts.silencio) console.log(texto);
      if (!archivo) return;
      try {
        appendFileSync(archivo, `${new Date().toISOString()} ${texto}\n`);
      } catch {
        // La bitácora en disco nunca tira la corrida: lo importante ya quedó en `job_runs`.
      }
    },
  };
}

/** Una bitácora que no escribe nada: para pruebas o para quien ya lee `job_runs`. */
export const bitacoraMuda: Bitacora = { archivo: null, linea() {} };
