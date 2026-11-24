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

/**
 * LO QUE APAGAR UN MÓDULO BORRA pasado un plazo (3.12; D-32). Hoy solo
 * Biometría: sus rostros. Como el uso, cada módulo cuenta lo suyo y lo
 * registra aquí; un módulo sin proveedor no borra nada al apagarse.
 * Con `branchId`, lo de ESA sucursal.
 */
type ErasureProvider = (organizationId: string, branchId?: string) => Promise<number>;
const erasures = new Map<string, ErasureProvider>();

export function registerModuleErasure(key: ModuleKey, provider: ErasureProvider): void {
  erasures.set(key, provider);
}

/** Cuántos se borrarían; `null` si apagar ese módulo no borra nada (no es lo mismo que cero). */
export async function erasureOf(key: string, organizationId: string, branchId?: string): Promise<number | null> {
  const provider = erasures.get(key);
  return provider ? provider(organizationId, branchId) : null;
}

/** "1 producto" / "7 productos"; nada si es cero. */
export function contar(n: number, singular: string, plural: string): string[] {
  return n > 0 ? [`${n.toLocaleString('es-MX')} ${n === 1 ? singular : plural}`] : [];
}
