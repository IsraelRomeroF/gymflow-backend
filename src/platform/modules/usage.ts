import type { ModuleKey } from '@gymflow/core';

/**
 * Qué tiene vivo un módulo en un gimnasio, para decirlo ANTES de apagarlo.
 *
 * `inUse` es lo que se conserva ("13 prospectos en seguimiento"); `blockers`
 * es lo que impide apagar hasta resolverlo, porque hay socios esperando algo
 * ("5 altas por revisar"). Cada módulo cuenta lo suyo y se registra aquí: la
 * pantalla de Módulos no consulta tablas ajenas.
 */
export type ModuleUsage = { inUse: string[]; blockers: string[] };
/** Con `branchId`, lo vivo en ESA sucursal (para apagarlo solo ahí). */
type Provider = (organizationId: string, branchId?: string) => Promise<ModuleUsage>;

const providers = new Map<string, Provider>();

export function registerModuleUsage(key: ModuleKey, provider: Provider): void {
  providers.set(key, provider);
}

export async function usageOf(key: string, organizationId: string, branchId?: string): Promise<ModuleUsage> {
  const provider = providers.get(key);
  return provider ? provider(organizationId, branchId) : { inUse: [], blockers: [] };
}

/** "1 producto" / "7 productos"; nada si es cero. */
export function contar(n: number, singular: string, plural: string): string[] {
  return n > 0 ? [`${n.toLocaleString('es-MX')} ${n === 1 ? singular : plural}`] : [];
}
