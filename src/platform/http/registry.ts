import type { FastifyInstance, RouteHandlerMethod, HTTPMethods } from 'fastify';
import { MODULE_BY_KEY, PERMISSION_BY_KEY, moduleDisabled, type ModuleKey, type PermissionKey } from '@gymflow/core';
import type { Env } from '../env.js';
import { isModuleOn, moduleViewOf } from '../modules/module-state.js';
import type { BackendModule } from '../modules/types.js';
import { memberOrganizationOf } from './member-session.js';
import { contratosDe, diferenciasDeLaRespuesta, esquemaParaFastify, RespuestaFueraDeContrato } from './respuesta.js';
import { sesionRequerida } from './sesion.js';

export type RouteSecurity =
  | { kind: 'public'; why: string }
  /** Solo exige sesión válida y elevada; la autorización fina va en el handler. */
  | { kind: 'session' }
  /**
   * Exige sesión de SOCIO, que no es la del personal (ADR-023).
   *
   * Tiene categoría propia y no `public`: marcar como pública una ruta que en
   * realidad valida en el handler es exactamente el atajo que erosiona el
   * control, porque la próxima que se marque igual puede no validar nada y
   * nadie lo notará. Un socio solo ve LO SUYO, así que la comprobación es de
   * pertenencia, no de permiso.
   */
  | { kind: 'member' }
  /** Solo para quien opera la plataforma (sin gimnasio). */
  /**
   * Consola de plataforma. Toda ruta que modifica (no GET) exige reconfirmar
   * con la contraseña en los últimos minutos; `reconfirm: false` la exime
   * (solo la propia reconfirmación, la contraseña y salir). `temporal: true`
   * deja usarla con la contraseña temporal (para poder cambiarla).
   */
  | { kind: 'platform'; reconfirm?: false; temporal?: true }
  /**
   * `anyOf`: también basta con tener ALGUNO de estos (12-20: la lista de
   * rutinas la ve quien las arma y quien solo las asigna). Úsese para lecturas;
   * una escritura dice con un solo permiso lo que autoriza.
   */
  | { kind: 'permission'; permission: PermissionKey; anyOf?: readonly PermissionKey[] };

export type RouteSpec = {
  method: HTTPMethods;
  url: string;
  security: RouteSecurity;
  /**
   * El módulo de PRODUCTO de esta ruta, cuando no es el de su carpeta
   * (ADR-036): los seguimientos viven en `follow-ups` y son de Retención. Si
   * el gimnasio lo tiene apagado, la ruta responde `MODULE_DISABLED`.
   */
  module?: ModuleKey;
  handler: RouteHandlerMethod;
  /**
   * Lo que la ruta responde se declara con `respuesta(codigo, Contrato)`
   * (`./respuesta.ts`, la regla está ahí): fuera de producción se comprueba
   * que el handler devuelva lo que el contrato dice.
   */
  schema?: object;
  /**
   * Configuración de Fastify para ESTA ruta, hoy solo el límite de peticiones.
   *
   * El límite global está desactivado a propósito: una ruta de mostrador que
   * recepción usa cien veces por turno no puede compartir cupo con una pública.
   * Las públicas que aceptan un secreto —canjear un código, por ejemplo— sí lo
   * necesitan, porque ahí no hay cuenta que bloquear.
   */
  config?: { rateLimit?: { max: number; timeWindow: string } };
  /** Tope del cuerpo en bytes, si esta ruta necesita más que el de 1 MB (p. ej. una importación). */
  bodyLimit?: number;
};

/** Registro global de rutas: lo consume la prueba de cobertura de permisos. */
type Registered = {
  method: HTTPMethods; url: string; security: RouteSecurity; hasRateLimit: boolean;
  /** El módulo de producto que el gimnasio enciende o apaga. */
  module: ModuleKey;
  /** La carpeta de código que la registró. */
  source: string;
};
const registered: Registered[] = [];

export function registeredRoutes(): ReadonlyArray<Registered> {
  return registered;
}

/**
 * El módulo de código que se está montando. Los `register*` son síncronos,
 * así que basta una variable: cada ruta se etiqueta sola con el módulo que
 * la registra, sin tocar las doscientas declaraciones una por una.
 */
let montando: BackendModule | null = null;

/** ÚNICA forma de montar un módulo: fuera de aquí, `route()` se niega. */
export function mountModule(app: FastifyInstance, mod: BackendModule, env: Env): void {
  if (!MODULE_BY_KEY.has(mod.module)) throw new Error(`El módulo ${mod.name} declara un módulo de producto inexistente: ${mod.module}`);
  if (!app.hasRequestDecorator('routeModule')) app.decorateRequest('routeModule', undefined);
  montando = mod;
  try { mod.register(app, env); } finally { montando = null; }
}

/**
 * Para la ruta que se registra MÁS TARDE, dentro de un plugin de Fastify
 * (el webhook, que necesita su propio lector del cuerpo): recuerda el módulo
 * que se estaba montando y lo repone mientras corre `fn`.
 */
export function keepModule(): <T>(fn: () => T) => T {
  const mod = montando;
  if (!mod) throw new Error('keepModule() solo se llama mientras se monta un módulo');
  return (fn) => {
    const previo = montando;
    montando = mod;
    try { return fn(); } finally { montando = previo; }
  };
}

/**
 * ÚNICA forma de registrar una ruta.
 *
 * Declarar la seguridad es OBLIGATORIO: una ruta sin declaración hace fallar
 * el arranque, no pasa silenciosamente. Es lo que impide que un endpoint
 * nuevo nazca sin control de acceso (§27, docs/06-roles-permisos.md §7).
 */
export function route(app: FastifyInstance, spec: RouteSpec): void {
  if (!spec.security) {
    throw new Error(`Ruta ${spec.method} ${spec.url} sin declaración de seguridad`);
  }
  if (spec.security.kind === 'permission') {
    for (const p of [spec.security.permission, ...(spec.security.anyOf ?? [])]) {
      if (!PERMISSION_BY_KEY.has(p)) throw new Error(`Ruta ${spec.method} ${spec.url} declara un permiso inexistente: ${p}`);
    }
  }
  if (spec.security.kind === 'public' && !spec.security.why.trim()) {
    throw new Error(`Ruta ${spec.method} ${spec.url} es pública sin justificación escrita`);
  }
  // Una ruta sin módulo no se podría apagar nunca, y nadie lo notaría.
  if (!montando) {
    throw new Error(`Ruta ${spec.method} ${spec.url} registrada fuera de un módulo: móntala con mountModule (src/modules.ts)`);
  }
  const moduleKey = spec.module ?? montando.module;
  const modulo = MODULE_BY_KEY.get(moduleKey);
  if (!modulo) throw new Error(`Ruta ${spec.method} ${spec.url} declara un módulo inexistente: ${moduleKey}`);
  const apagable = modulo.kind === 'optional';

  registered.push({
    method: spec.method, url: spec.url, security: spec.security,
    hasRateLimit: spec.config?.rateLimit !== undefined,
    module: moduleKey, source: montando.name,
  });

  // El contrato declarado con `respuesta()`: fuera de producción se compara
  // con lo que el handler devuelve. En las pruebas, una diferencia es un 500
  // con la lista; en desarrollo, una línea en el log. Producción no comprueba
  // ni recorta: sale lo que el handler devolvió.
  const contratos = process.env.NODE_ENV === 'production' ? null : contratosDe(spec.schema);
  const estricto = process.env.NODE_ENV === 'test';
  const schema = esquemaParaFastify(spec.schema);

  app.route({
    method: spec.method,
    url: spec.url,
    ...(schema ? { schema } : {}),
    ...(contratos ? {
      preSerialization: async (request, reply, payload) => {
        const contrato = contratos.get(reply.statusCode);
        if (!contrato) return payload;
        const diferencias = diferenciasDeLaRespuesta(contrato, payload);
        if (diferencias.length > 0) {
          const fallo = new RespuestaFueraDeContrato(`${spec.method} ${spec.url}`, diferencias);
          if (estricto) throw fallo;
          request.log.warn({ diferencias: diferencias.slice(0, 20) }, fallo.message);
        }
        return payload;
      },
    } : {}),
    ...(spec.config ? { config: spec.config } : {}),
    ...(spec.bodyLimit ? { bodyLimit: spec.bodyLimit } : {}),
    preHandler: async (request, reply) => {
      // La ruta sabe de qué módulo es: `requirePermission(permiso, sede)`
      // comprueba con eso si la sede lo usa.
      request.routeModule = moduleKey;
      // Las públicas no traen gimnasio: las de un módulo opcional lo
      // comprueban en su handler, donde ya saben de quién es la petición.
      if (spec.security.kind === 'public') return;
      // La sesión de SOCIO la resuelve el propio módulo del portal: no pasa
      // por `request.ctx`, que es el contexto del PERSONAL. Mezclarlos
      // significaría que un fallo aquí podría conceder permisos de personal,
      // y un fallo así no revienta: autoriza.
      if (spec.security.kind === 'member') {
        // Lo del socio no se guarda en ninguna caché de paso (fase 2, bloque 2.8): ni la del navegador ni la del túnel.
        reply.header('cache-control', 'no-store');
        if (apagable) {
          const org = await memberOrganizationOf(request);
          if (org && !(await isModuleOn(org, moduleKey))) throw moduleDisabled(modulo.name);
        }
        return;
      }
      if (spec.security.kind === 'platform') {
        const { DomainError } = await import('@gymflow/core');
        if (!request.platform) {
          // El personal de un gimnasio no entra aquí ni por error: 404, como
          // cualquier recurso que no le pertenece.
          // Sin sesión de plataforma, el 401 dice por qué (24-06, 24-13).
          throw request.ctx ? new DomainError('NOT_FOUND', 'Recurso no encontrado') : sesionRequerida(request);
        }
        if (request.platform.mustChangePassword && !spec.security.temporal) {
          throw new DomainError('FORBIDDEN', 'Cambia tu contraseña temporal antes de operar la plataforma');
        }
        const modifica = spec.method !== 'GET' && spec.method !== 'HEAD';
        if (modifica && spec.security.reconfirm !== false
          && !(request.platform.stepUpUntil && request.platform.stepUpUntil.getTime() > Date.now())) {
          throw new DomainError('REAUTH_REQUIRED', 'Confirma con tu contraseña para continuar');
        }
        return;
      }
      // Sin sesión: el 401 dice por qué terminó, si llegó una cookie (24-06).
      if (!request.ctx) throw sesionRequerida(request);
      // Antes que el permiso: "este gimnasio no usa Clases" se entiende
      // mejor que "no tienes permiso" cuando la sección está apagada.
      if (apagable) {
        const vista = request.ctx.modules ?? await moduleViewOf(request.ctx.tenant.organizationId);
        if (!vista.org.has(moduleKey)) throw moduleDisabled(modulo.name);
      }
      if (spec.security.kind === 'permission') {
        // Solo TENENCIA y ALCANCE. El motivo, la aprobación y los límites
        // los evalúa el handler con request.authorize() sobre el recurso real.
        const tiene = (p: PermissionKey) => { const sedes = request.branchScope(p); return sedes === null || sedes.length > 0; };
        if ((spec.security.anyOf ?? []).some(tiene)) return;
        request.requirePermission(spec.security.permission);
      }
    },
    handler: spec.handler,
  });
}
