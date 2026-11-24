import type { FastifyInstance } from 'fastify';
import type { Env } from '../../platform/env.js';
import { registerEntranceRoutes } from './entrance.routes.js';
import { registerExceptionRoutes } from './exception.routes.js';
import { registerTurnstileRoutes } from './turnstile.routes.js';
import { registerCredentialRoutes } from './credentials.routes.js';
import { registerBiometricRoutes } from './biometrics.routes.js';
import { registerFaceRoutes } from './face.routes.js';
import { registerPendingRoutes } from './pending.routes.js';
import { registerFaceRuleRoutes } from './face-rule.routes.js';

/**
 * Las rutas de la entrada, en seis archivos por lo que hacen (auditoría 8,
 * bloque 1.7): la puerta, la pantalla de excepción, el torniquete,
 * credenciales, biometría y la cámara de recepción. Antes eran 730 líneas en
 * un archivo; ni las URL ni las respuestas cambian.
 */
export function registerAccessRoutes(app: FastifyInstance, env: Env): void {
  registerEntranceRoutes(app);
  registerExceptionRoutes(app);
  // Por resolver en la puerta (bloque 2.1): los rechazos de hoy sin resolver.
  registerPendingRoutes(app);
  registerTurnstileRoutes(app, env);
  registerCredentialRoutes(app, env);
  registerBiometricRoutes(app);
  registerFaceRoutes(app, env);
  // Entrar solo con rostro (fase 3, bloque 3.3; D-06): la regla del gimnasio y a quién le falta.
  registerFaceRuleRoutes(app);
}
