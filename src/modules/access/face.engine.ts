import { unavailable } from '@gymflow/core';
import { decryptSecret, encryptSecret } from '../../platform/crypto.js';
import type { Env } from '../../platform/env.js';
import { derivarLlave, ETIQUETA_ROSTRO, LLAVE_DATOS, LLAVE_DATOS_ANTERIOR } from '../../platform/sensitive.js';

/** `conRostro` y `deFrente`: en cuántos cuadros se vio un rostro y en cuántos de frente (`null` si el motor no lo dice). */
export type Extraccion =
  | { ok: true; embedding: number[]; conRostro: number | null; deFrente: number | null }
  | { ok: false; error: string; livenessFailed?: boolean; conRostro: number | null; deFrente: number | null };

/** Dónde vale un rostro: en la sucursal donde se tomó (hoy) o en todo el gimnasio (5-16, 6-13). */
export type AlcanceDelRostro = 'branch' | 'organization';

/**
 * MOTOR FACIAL (2026-10-09): la cámara de recepción como lector, igual que las
 * estaciones de HRFlow. El motor de InsightFace saca el embedding y verifica
 * que sea una persona (reto de movimiento); aquí se cifra, se guarda y se
 * compara. La imagen nunca se guarda: solo viaja al motor y se descarta.
 *
 * El motor es de GymFlow desde la auditoría 8 (`motor-facial/`, bloque 0.4):
 * escucha solo en 127.0.0.1 y exige el token compartido en la cabecera
 * `X-Face-Token` (`FACE_SIDECAR_TOKEN`, el mismo en la API y en el motor; lo
 * pasa gymflow.sh). Si no responde o rechaza el token, se dice así: un motor
 * apagado nunca se disfraza de «no vi tu rostro».
 */
export class FaceEngine {
  private readonly clave: Buffer;
  constructor(private readonly env: Env) {
    // Llave propia de la biometría, derivada de la de datos sensibles
    // (`SENSITIVE_DATA_KEY`; el nombre anterior, `MFA_ENCRYPTION_KEY`, se
    // acepta una versión más): un mismo secreto de despliegue, una llave por
    // uso que no se cruzan. La derivación es la misma de siempre (HKDF con la
    // etiqueta del rostro), así que los rostros ya guardados siguen legibles.
    this.clave = derivarLlave(ETIQUETA_ROSTRO, { [LLAVE_DATOS]: env.SENSITIVE_DATA_KEY, [LLAVE_DATOS_ANTERIOR]: env.MFA_ENCRYPTION_KEY });
  }

  /** ¿Se puede usar el motor? La pantalla lo pregunta antes de pedir la cámara. `/health` también pide el token: un token equivocado se sabe aquí. */
  async disponible(): Promise<{ disponible: boolean; motivo: string | null; modelo: string | null }> {
    let r: Response;
    try {
      r = await fetch(`${this.env.FACE_SIDECAR_URL}/health`, { headers: this.conToken(), signal: AbortSignal.timeout(2000) });
    } catch (e) {
      return { disponible: false, motivo: sinRespuesta(e), modelo: null };
    }
    if (r.status === 401) return { disponible: false, motivo: this.tokenRechazado(), modelo: null };
    const j = await r.json().catch(() => null) as { model_loaded?: boolean; model_error?: string | null; modelo?: string } | null;
    if (!r.ok || !j) return { disponible: false, motivo: `El motor facial respondió con error (${r.status}).`, modelo: null };
    const modelo = typeof j.modelo === 'string' ? j.modelo : null;
    return j.model_loaded === false && j.model_error ? { disponible: false, motivo: `El motor facial no cargó su modelo: ${j.model_error}`, modelo } : { disponible: true, motivo: null, modelo };
  }

  /** Con qué decide hoy la Estación: el umbral y la ventaja del entorno, y dónde vale un rostro. */
  get umbral(): number { return this.env.FACE_MATCH_THRESHOLD; }
  get margen(): number { return this.env.FACE_MATCH_MARGIN; }
  get alcance(): AlcanceDelRostro { return this.env.FACE_RECOGNITION_SCOPE; }

  /**
   * `reto`: movimiento pedido (turn_left, turn_right, move_closer). `promediar`: para el alta.
   * Devuelve `ok: false` cuando el motor contestó y no hubo rostro o no pasó la
   * prueba de vida. Si el motor no contesta, rechaza el token o falla, LANZA un
   * error con el motivo: la estación y el alta lo muestran tal cual, en lugar
   * de «No vi tu rostro». Es un 503 con `reason: FACE_ENGINE_DOWN` (bloque 1.2;
   * antes un 422): lo que se mandó está bien, es el motor el que no está, y
   * quien llama puede reintentar o pasar al lector sin leer el texto.
   */
  async extraer(cuadros: string[], reto: string | null, promediar: boolean, opciones: { soloDeFrente?: boolean } = {}): Promise<Extraccion> {
    let r: Response;
    try {
      r = await fetch(`${this.env.FACE_SIDECAR_URL}/extract`, {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/json', ...this.conToken() },
        // `frontal_only` (bloque 2.3, 6-09): el alta promedia solo cuadros de frente.
        // Un motor anterior al 1.1.0 lo ignora y promedia todos, como antes.
        body: JSON.stringify({ frames: cuadros, action: reto, aggregate: promediar, ...(opciones.soloDeFrente ? { frontal_only: true } : {}) }),
      });
    } catch (e) {
      throw motorCaido(sinRespuesta(e));
    }
    if (r.status === 401) throw motorCaido(this.tokenRechazado());
    const j = await r.json().catch(() => ({})) as { ok?: boolean; embedding?: number[] | null; error?: string | null; liveness_checked?: boolean; liveness_ok?: boolean; liveness_reason?: string; detail?: unknown; faces_detected?: number; frontal_frames?: number };
    if (r.status === 503) throw motorCaido(`El motor facial no tiene su modelo cargado${typeof j.detail === 'string' ? `: ${j.detail}` : ''}.`);
    if (!r.ok) throw motorCaido(`El motor facial no pudo procesar la imagen (respondió ${r.status}).`);
    const vistos = { conRostro: typeof j.faces_detected === 'number' ? j.faces_detected : null, deFrente: typeof j.frontal_frames === 'number' ? j.frontal_frames : null };
    if (j.liveness_checked && !j.liveness_ok) return { ok: false, error: j.liveness_reason || 'No se comprobó que sea una persona frente a la cámara.', livenessFailed: true, ...vistos };
    if (!j.ok || !j.embedding) return { ok: false, error: j.error || 'No se detectó ningún rostro.', ...vistos };
    return { ok: true, embedding: j.embedding, ...vistos };
  }

  private conToken(): Record<string, string> {
    return this.env.FACE_SIDECAR_TOKEN ? { 'x-face-token': this.env.FACE_SIDECAR_TOKEN } : {};
  }

  private tokenRechazado(): string {
    return this.env.FACE_SIDECAR_TOKEN
      ? 'El motor facial rechazó el token de esta API: FACE_SIDECAR_TOKEN no es el mismo que el del motor.'
      : 'El motor facial pide su token y esta API no lo tiene (falta FACE_SIDECAR_TOKEN).';
  }

  cifrar(embedding: number[]): string { return encryptSecret(JSON.stringify(embedding), this.clave); }
  descifrar(guardado: string): number[] { return JSON.parse(decryptSecret(guardado, this.clave)) as number[]; }

  /**
   * El parecido (coseno) con cada persona. Si una persona tiene más de un
   * rostro en el padrón (uno por sucursal, cuando el rostro vale en todo el
   * gimnasio), cuenta el mejor de los suyos: dos plantillas de la MISMA
   * persona no son «dos que se parecen» y no deben quitarle la ventaja.
   */
  parecidos(objetivo: number[], candidatos: Array<{ id: string; embedding: number[] }>): Map<string, number> {
    const porPersona = new Map<string, number>();
    for (const c of candidatos) {
      let s = 0; let na = 0; let nb = 0;
      for (let i = 0; i < objetivo.length; i++) { s += objetivo[i]! * c.embedding[i]!; na += objetivo[i]! ** 2; nb += c.embedding[i]! ** 2; }
      const score = s / (Math.sqrt(na) * Math.sqrt(nb) || 1);
      const previo = porPersona.get(c.id);
      if (previo === undefined || score > previo) porPersona.set(c.id, score);
    }
    return porPersona;
  }

  /** El más parecido y su ventaja sobre el segundo. Embeddings normalizados: el coseno es el producto punto. */
  mejor(objetivo: number[], candidatos: Array<{ id: string; embedding: number[] }>): { id: string; score: number; margin: number } | null {
    let a: { id: string; score: number } | null = null; let segundo = -1;
    for (const [id, score] of this.parecidos(objetivo, candidatos)) {
      if (!a || score > a.score) { if (a) segundo = Math.max(segundo, a.score); a = { id, score }; } else segundo = Math.max(segundo, score);
    }
    return a ? { ...a, margin: segundo < 0 ? 1 : a.score - segundo } : null;
  }

  reconoce(m: { score: number; margin: number } | null): boolean {
    return !!m && m.score >= this.env.FACE_MATCH_THRESHOLD && m.margin >= this.env.FACE_MATCH_MARGIN;
  }
}

/** El motor no está para atender: 503 con su porqué estable. */
const motorCaido = (mensaje: string) => unavailable(mensaje, 'FACE_ENGINE_DOWN');

/** Por qué no contestó: tardó demasiado (arrancando u ocupado) o no hay nadie escuchando. */
function sinRespuesta(e: unknown): string {
  return (e as { name?: string } | null)?.name === 'TimeoutError'
    ? 'El motor facial no respondió a tiempo.'
    : 'El motor facial no está encendido en este equipo.';
}
