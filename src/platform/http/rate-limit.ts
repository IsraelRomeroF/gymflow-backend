import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import { DomainError } from '@gymflow/core';
import type { Env } from '../env.js';

/**
 * LÍMITES DE INTENTOS: el único lugar que decide a quién se cuenta y qué se
 * le dice cuando se pasa (24-01, 24-02, 28-01, 28-02, 9-05).
 *
 * Antes la llave era la IP, y detrás del proxy del panel todo el gimnasio era
 * 127.0.0.1: 30 inicios de sesión cada 5 minutos para todos, y un intruso en
 * el túnel dejaba fuera a recepción. El aviso salía en inglés y como
 * `BAD_REQUEST`. Ahora:
 *
 * - **Entrar** cuenta por PERSONA: el mismo correo desde la misma IP real
 *   (`AUTH_ATTEMPTS_PER_IP` cada 5 minutos). Encima, un tope por IP real de
 *   cualquier correo (`AUTH_ATTEMPTS_PER_NETWORK`): frena a quien prueba una
 *   contraseña contra muchos correos. El bloqueo por cuenta (5 fallos) sigue
 *   aparte, en `identity`.
 * - **Alta por QR** cuenta por TELÉFONO capturado (`INTAKE_SUBMIT_ATTEMPTS`
 *   cada 10 minutos) y por SUCURSAL (`INTAKE_SUBMIT_PER_BRANCH` por hora,
 *   D28-01). La red no sirve de llave: en una promoción, veinte teléfonos
 *   salen por la misma IP del gimnasio.
 * - Lo demás que tiene límite cuenta por sesión (personal o plataforma) y, sin
 *   sesión, por IP real.
 *
 * La IP real la da Fastify con `trustProxy` = `TRUSTED_PROXIES`: solo se cree
 * a `X-Forwarded-For` cuando la conexión viene de un proxy de confianza.
 *
 * Todo 429 sale igual: `{ error: 'RATE_LIMITED', message, retryAfterSeconds }`
 * con la cabecera `Retry-After`, para que el panel y el portal muestren la
 * cuenta regresiva. Los contadores viven en memoria: con una sola API basta;
 * con más de una réplica van a Redis (SEC-07).
 */

/** El 429 de GymFlow: dice cuánto esperar, en segundos, para la cuenta regresiva. */
export class DemasiadosIntentos extends DomainError {
  readonly retryAfterSeconds: number;

  constructor(segundos: number, mensaje: string) {
    super('RATE_LIMITED', mensaje);
    this.retryAfterSeconds = Math.max(1, Math.ceil(segundos));
  }
}

/** «45 segundos», «1 minuto», «12 minutos», «1 hora»: lo que falta, redondeado hacia arriba. */
export function tiempoParaReintentar(segundos: number): string {
  const s = Math.max(1, Math.ceil(segundos));
  if (s < 60) return s === 1 ? '1 segundo' : `${s} segundos`;
  const min = Math.ceil(s / 60);
  if (min === 60) return '1 hora';
  // Hasta hora y media se cuenta en minutos: «2 horas» por 61 minutos asusta de más.
  if (min <= 90) return min === 1 ? '1 minuto' : `${min} minutos`;
  return `${Math.ceil(min / 60)} horas`;
}

const MENSAJE: Record<string, (t: string) => string> = {
  'POST /auth/login': (t) => `Demasiados intentos para entrar con este correo. Espera ${t} y vuelve a intentar.`,
  'POST /intake/:id': (t) => `Ya recibimos varios envíos con este teléfono. Espera ${t} o pasa a recepción y te damos de alta ahí.`,
  'POST /portal/enroll': (t) => `Demasiados intentos de activación. Espera ${t} y vuelve a intentar, o pide en recepción un código nuevo.`,
};
const MENSAJE_GENERAL = (t: string) => `Demasiados intentos. Espera ${t} y vuelve a intentar.`;

export const MENSAJE_POR_RED = (t: string) => `Demasiados intentos desde esta red. Espera ${t} y vuelve a intentar.`;
export const MENSAJE_POR_SUCURSAL = (t: string) =>
  `En la última hora se registraron muchas personas en esta sucursal. Pasa a recepción y te damos de alta ahí, o vuelve a intentar en ${t}.`;

const rutaDe = (request: FastifyRequest) => `${request.method} ${request.routeOptions.url ?? ''}`;

/** El 429 de una ruta, con su texto propio si lo tiene. */
export function demasiadosIntentosEn(request: FastifyRequest, segundos: number): DemasiadosIntentos {
  const texto = MENSAJE[rutaDe(request)] ?? MENSAJE_GENERAL;
  return new DemasiadosIntentos(segundos, texto(tiempoParaReintentar(segundos)));
}

/** La IP real (ya resuelta con los proxies de confianza), agrupando IPv6 por /64 como el plugin. */
export function ipReal(request: FastifyRequest): string {
  return normalizeIP(request.ip ?? '');
}

const campo = (body: unknown, nombre: string): unknown =>
  (body && typeof body === 'object' ? (body as Record<string, unknown>)[nombre] : undefined);

function correoDe(body: unknown): string | null {
  const v = campo(body, 'email');
  if (typeof v !== 'string') return null;
  const correo = v.trim().toLowerCase();
  return correo.length > 0 && correo.length <= 254 ? correo : null;
}

/** Los 10 dígitos de un celular mexicano, se escriba como se escriba («55 1234 5678», «+52 55…»). */
function telefonoDe(body: unknown): string | null {
  const v = campo(body, 'phone');
  if (typeof v !== 'string') return null;
  const digitos = v.replace(/\D/g, '');
  return digitos.length >= 10 ? digitos.slice(-10) : null;
}

/**
 * La llave de cada ruta con límite propio. Lo que no está aquí cuenta por
 * sesión y, sin sesión, por IP real.
 */
const LLAVE_POR_RUTA: Record<string, (request: FastifyRequest) => string | null> = {
  // Por persona: otra persona del gimnasio, u otro equipo, tiene su propio cupo.
  'POST /auth/login': (r) => {
    const correo = correoDe(r.body);
    return correo ? `correo:${correo}|ip:${ipReal(r)}` : null;
  },
  'POST /intake/:id': (r) => {
    const tel = telefonoDe(r.body);
    if (tel) return `tel:${tel}`;
    const correo = correoDe(r.body);
    return correo ? `correo:${correo}` : null;
  },
};

export function llaveDeLimite(request: FastifyRequest): string {
  const propia = LLAVE_POR_RUTA[rutaDe(request)]?.(request);
  if (propia) return propia;
  if (request.ctx) return `sesion:${request.ctx.tenant.sessionId}`;
  if (request.platform) return `plataforma:${request.platform.sessionId}`;
  return `ip:${ipReal(request)}`;
}

/**
 * Cupos con ventana fija, para los límites que no son de una sola ruta o
 * que necesitan lo que la ruta resuelve (la sucursal real detrás de un
 * enlace corto). Misma semántica que el plugin: el intento `max + 1` dentro
 * de la ventana se rechaza.
 */
export class Cupos {
  private readonly cuentas = new Map<string, { usados: number; desde: number }>();

  constructor(
    readonly max: number,
    readonly ventanaMs: number,
    private readonly reloj: () => number = Date.now,
  ) {}

  /** Segundos que faltan para volver a tener cupo; 0 si lo hay. No gasta. */
  espera(llave: string): number {
    const c = this.vigente(llave);
    return c && c.usados >= this.max ? Math.max(1, Math.ceil((c.desde + this.ventanaMs - this.reloj()) / 1000)) : 0;
  }

  /** Gasta un intento. */
  gastar(llave: string): void {
    const c = this.vigente(llave);
    if (c) { c.usados += 1; return; }
    this.limpiar();
    this.cuentas.set(llave, { usados: 1, desde: this.reloj() });
  }

  /** Gasta un intento o, si ya no hay cupo, lanza el 429 con el mensaje dado. */
  consumir(llave: string, mensaje: (tiempo: string) => string): void {
    const espera = this.espera(llave);
    if (espera > 0) throw new DemasiadosIntentos(espera, mensaje(tiempoParaReintentar(espera)));
    this.gastar(llave);
  }

  private vigente(llave: string) {
    const c = this.cuentas.get(llave);
    if (!c) return null;
    if (c.desde + this.ventanaMs <= this.reloj()) { this.cuentas.delete(llave); return null; }
    return c;
  }

  /** Que una avalancha de llaves distintas no crezca sin fin. */
  private limpiar(): void {
    if (this.cuentas.size < 10_000) return;
    const ahora = this.reloj();
    for (const [llave, c] of this.cuentas) if (c.desde + this.ventanaMs <= ahora) this.cuentas.delete(llave);
  }
}

export type Topes = {
  /** Inicios de sesión desde una misma IP real, de cualquier correo, cada 5 minutos. */
  entrarPorRed: Cupos;
  /** Altas por QR aceptadas por sucursal en una hora (D28-01). */
  altasPorSucursal: Cupos;
};

declare module 'fastify' {
  interface FastifyInstance {
    /** Topes que no son de una sola ruta; los consulta quien sabe qué contar. */
    topes: Topes;
  }
}

const CINCO_MINUTOS = 5 * 60_000;
const UNA_HORA = 60 * 60_000;

export async function registerRateLimit(app: FastifyInstance, env: Env): Promise<void> {
  await app.register(rateLimit, {
    // El límite global está apagado a propósito: una ruta de mostrador que
    // recepción usa cien veces por turno no comparte cupo con una pública.
    global: false,
    max: 300,
    timeWindow: '1 minute',
    // En `preHandler` ya está el cuerpo (el correo, el teléfono) y la sesión.
    hook: 'preHandler',
    keyGenerator: llaveDeLimite,
    errorResponseBuilder: (request, contexto) => demasiadosIntentosEn(request, contexto.ttl / 1000),
  });

  const topes: Topes = {
    entrarPorRed: new Cupos(env.AUTH_ATTEMPTS_PER_NETWORK, CINCO_MINUTOS),
    altasPorSucursal: new Cupos(env.INTAKE_SUBMIT_PER_BRANCH, UNA_HORA),
  };
  app.decorate('topes', topes);

  app.addHook('preHandler', async (request) => {
    if (rutaDe(request) === 'POST /auth/login') topes.entrarPorRed.consumir(`ip:${ipReal(request)}`, MENSAJE_POR_RED);
  });
}
