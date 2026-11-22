import type { FastifyRequest } from 'fastify';

/**
 * De qué gimnasio es el SOCIO que hace la petición.
 *
 * La sesión del socio la resuelve el módulo del portal, no la plataforma
 * (ADR-023). Pero la puerta de módulos del registro de rutas necesita saber
 * el gimnasio para decidir si una ruta de socio está encendida. El portal se
 * registra aquí —mismo patrón que los contribuyentes del corte de caja— y la
 * plataforma pregunta sin conocerlo.
 */
type Resolver = (request: FastifyRequest) => Promise<string | null>;

let resolver: Resolver | null = null;

export function registerMemberOrganizationResolver(fn: Resolver): void {
  resolver = fn;
}

/** null si no hay sesión de socio: la ruta responderá "sesión requerida" por su cuenta. */
export async function memberOrganizationOf(request: FastifyRequest): Promise<string | null> {
  return resolver ? resolver(request) : null;
}
