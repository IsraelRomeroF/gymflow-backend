import type { ModuleKey, PermissionKey, ResourceScope } from '@gymflow/core';
import type { RequestContext } from '../context.js';

/**
 * Contrato HTTP de la plataforma.
 *
 * La FORMA la define plataforma; la IMPLEMENTACIÓN la aporta el módulo de
 * identidad (`modules/identity/auth.plugin.ts`). Separarlos es lo que permite
 * que `platform/http/registry.ts` exija un permiso sin conocer al módulo que
 * resuelve la sesión — y, por tanto, que identidad se pueda extraer a un
 * servicio propio sin tocar la plataforma.
 */
declare module 'fastify' {
  interface FastifyRequest {
    ctx?: RequestContext | undefined;
    /** El módulo de producto de la ruta que atiende (lo pone el registro, ADR-036). */
    routeModule?: ModuleKey | undefined;
    /**
     * Quien opera la PLATAFORMA: una cuenta que no pertenece a ningún
     * gimnasio. Da de alta marcas nuevas y las administra. No tiene `ctx`:
     * nunca actúa dentro de un gimnasio como si fuera su personal.
     */
    platform?: {
      userId: string; fullName: string | null; email: string | null;
      /** La sesión de plataforma: reconfirmación, cierre y "tus sesiones". */
      sessionId: string; stepUpUntil: Date | null; mustChangePassword: boolean;
    } | undefined;
    /**
     * Llegó una cookie de sesión que ya no sirve: por qué (`reason`, estable)
     * y qué decirle a la persona. Lo pone identidad al resolver la cookie; el
     * registro lo manda en el 401 (24-06). Sin cookie, queda vacío.
     */
    sessionEnd?: { reason: string; message: string } | undefined;
    /**
     * Comprueba un permiso contra un recurso concreto. Lanza si no procede.
     *
     * `branchId` es OBLIGATORIO (SEC2-02): la sede del recurso, o `null` para
     * una acción de toda la organización, que exige alcance organizacional.
     * Omitirlo se saltaba el alcance por sucursal sin que nadie lo notara.
     */
    authorize(permission: PermissionKey, resource: Omit<ResourceScope, 'organizationId' | 'branchId'> & { branchId: string | null }): void;
    /**
     * Sucursales sobre las que el usuario tiene ESE permiso, o `null` si lo
     * tiene sobre toda la organización. Es lo que filtra un listado: la puerta
     * del registro solo exige tener el permiso en ALGUNA sucursal.
     */
    branchScope(permission: PermissionKey): string[] | null;
    /** ¿Lo tiene sobre esa sucursal? Como `authorize`, pero sin lanzar. */
    holds(permission: PermissionKey, branchId: string | null): boolean;
    /** Solo tenencia y alcance. Es la puerta de entrada del registro de rutas. */
    requirePermission(permission: PermissionKey, branchId?: string | null | undefined): void;
    /**
     * Comprueba contra la BASE que el segundo usuario del maker-checker
     * existe, está activo, es de esta organización y **tiene el permiso que
     * aprueba**. Devuelve su id, o `null` si no se envió ninguno.
     *
     * Es asíncrona y por eso no vive dentro de `authorize`: el dominio es
     * puro y no ve la base. Toda ruta cuyo permiso exija aprobación tiene que
     * llamarla ANTES de autorizar, y una prueba lo verifica.
     */
    verifyApprover(
      approvalToken: string | null | undefined,
      permission: PermissionKey,
      scope?: { branchId?: string | null; resourceType?: string; resourceId?: string; amountCents?: bigint; percent?: number },
    ): Promise<string | null>;
  }
}
