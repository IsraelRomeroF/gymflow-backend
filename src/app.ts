import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { redactPanLike, uuidv7 } from '@gymflow/core';
import type { Env } from './platform/env.js';

import { registerErrorHandler } from './platform/http/error-handler.plugin.js';
import { registerRateLimit } from './platform/http/rate-limit.js';
import { panGuardPlugin } from './platform/http/pan-guard.plugin.js';
import { authPlugin } from './modules/identity/index.js';
import { registerCoachScope } from './modules/members/coach-scope.js';
import { mountModule } from './platform/http/registry.js';
import { BACKEND_MODULES } from './modules.js';



export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    // Correlation ID propagado a logs, auditoría y (más adelante) a los jobs.
    // Solo si parece un id: el valor viaja a los logs y a la bitácora, y un
    // cliente podía meter ahí lo que quisiera (SEC-13).
    genReqId: (req) => {
      const propio = req.headers['x-request-id'];
      return typeof propio === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(propio) ? propio : uuidv7();
    },
    // Solo los proxies declarados. Con `true` se confiaba en cualquiera que
    // mandara una cabecera, que es lo mismo que no tener límites por IP.
    trustProxy: env.trustedProxies.length > 0 ? env.trustedProxies : false,
    logger: {
    level: env.NODE_ENV === 'test' ? 'silent' : 'info',
    redact: {
      paths: [
        'req.headers.cookie', 'req.headers.authorization',
        'req.body.password', 'req.body.code', 'req.body.secret',
        // Datos de tarjeta: no deberían llegar nunca —`panGuardPlugin` los
        // rechaza en el borde— y aun así se redactan.
        'req.body.cardNumber', 'req.body.pan', 'req.body.cvv', 'req.body.cvc',
        /**
         * SEGUNDA barrera contra el PAN, la que exige docs/07 §4.1 regla 3.
         *
         * El resto de esta lista filtra por NOMBRE de campo, que es otra
         * cosa: no ve una secuencia de tarjeta DENTRO de una URL. La query
         * de `/members/search` sí la lleva, y el guard del borde la rechaza,
         * pero esto existe "por si acaso" — el coste de equivocarse aquí es
         * quedar fuera de SAQ A.
         */
        'req.url',
        'res.headers["set-cookie"]',
      ],
      // La URL no se tacha entera: se le quita solo lo que parece tarjeta,
      // porque un log sin rutas no sirve para diagnosticar nada.
      censor: (value: unknown, path: string[]) =>
        (path.at(-1) === 'url' && typeof value === 'string'
          ? redactarQuery(redactPanLike(value))
          : '[redactado]'),
    },
    },
  });

  registerErrorHandler(app);

  // Rutas lentas (OPT2-03): el día que algo tarde, el log dice qué fue. Se
  // registra la PLANTILLA de la ruta, no la URL, para que no lleve datos.
  const LENTA_MS = Number(process.env.SLOW_ROUTE_MS ?? 300);
  app.addHook('onResponse', async (request, reply) => {
    const ms = reply.elapsedTime;
    if (ms >= LENTA_MS) {
      request.log.warn({ route: request.routeOptions.url ?? 'desconocida', method: request.method, status: reply.statusCode, ms: Math.round(ms) }, 'ruta lenta');
    }
  });

  await app.register(helmet, { contentSecurityPolicy: env.NODE_ENV === 'production' });
  await app.register(cors, {
    origin: env.corsOrigins, // allowlist explícita, NUNCA '*'
    credentials: true,
  });
  await app.register(cookie);
  // A quién se cuenta y qué se le dice al pasarse: un solo lugar (24-01, 28-01).
  await registerRateLimit(app, env);
  // El perfil de arranque (uso real o pruebas): lo dice `/health` para que los
  // guiones comprueben contra qué API van a correr.
  app.decorate('perfilDeArranque', env.perfil);

  // ANTES de autenticar: un PAN no debe llegar ni al log de la petición.
  await app.register(panGuardPlugin);
  await app.register(authPlugin, { env });
  // El coach solo ve a sus socios asignados (2026-10-09): antes de cualquier ruta de socio.
  registerCoachScope(app);

  // ── Módulos ───────────────────────────────────────────────────────────────
  // La composición es EXPLÍCITA y vive en `src/modules.ts`, el único archivo
  // que conoce a todos. Montarlos por aquí es lo que etiqueta cada ruta con
  // su módulo: una ruta registrada por fuera hace fallar el arranque.
  for (const mod of BACKEND_MODULES) mountModule(app, mod, env);

  return app;
}

/**
 * Parámetros de la URL que llevan datos personales: `/members/search?q=` es
 * un nombre o un teléfono, y quedaba entero en cada línea de log (SEC-13).
 */
const QUERY_PERSONAL = new Set(['q', 'email', 'phone', 'phoneE164', 'name', 'code', 'token', 'returnUrl']);
export function redactarQuery(url: string): string {
  const i = url.indexOf('?');
  if (i < 0) return url;
  const params = new URLSearchParams(url.slice(i + 1));
  for (const k of [...params.keys()]) if (QUERY_PERSONAL.has(k)) params.set(k, '[redactado]');
  return `${url.slice(0, i)}?${params.toString()}`;
}
