import { effectiveModules, effectiveModulesAt, type ModuleKey, type ModuleState } from '@gymflow/core';
import { ModuleStateRepository } from './module-state.repository.js';

/**
 * Los módulos activos de un gimnasio y de cada una de sus sucursales, con
 * memoria corta.
 *
 * La puerta de las rutas pregunta en cada petición a un módulo opcional;
 * sin memoria sería una consulta más por petición. Diez segundos bastan: el
 * proceso que cambia un módulo borra su memoria en el acto, y otra réplica
 * de la API se entera, como mucho, diez segundos después.
 */
const VIGENCIA_MS = 10_000;

/** Lo que una petición necesita saber de los módulos, ya resuelto. */
export type ServiceStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED';

export type ModuleView = {
  /** Lo que la gerencia eligió. */
  readonly state: ModuleState;
  /** Lo que la plataforma marcó como no contratado (sin entrada = contratado). */
  readonly entitlements: ReadonlyMap<string, boolean>;
  /** Si la marca puede usar el software hoy. */
  readonly serviceStatus: ServiceStatus;
  /** Lo que cada sucursal dejó de usar. */
  readonly branchDisabled: ReadonlyMap<string, ReadonlySet<string>>;
  /** ¿Está contratado? Lo fijo siempre. */
  contracted(key: string): boolean;
  /** Activos en el gimnasio. */
  readonly org: ReadonlySet<ModuleKey>;
  /** Activos en una sucursal (`null` = en el gimnasio). */
  at(branchId: string | null | undefined): ReadonlySet<ModuleKey>;
};

const memoria = new Map<string, { view: ModuleView; hasta: number }>();

/** Lo no contratado cuenta como apagado, elija lo que elija la gerencia. */
export function withEntitlements(state: ModuleState, entitlements: ReadonlyMap<string, boolean>): ModuleState {
  const combinado: Record<string, boolean | undefined> = { ...state };
  for (const [key, granted] of entitlements) if (!granted) combinado[key] = false;
  return combinado;
}

function armar(state: ModuleState, entitlements: ReadonlyMap<string, boolean>, serviceStatus: ServiceStatus, branchDisabled: ReadonlyMap<string, ReadonlySet<string>>): ModuleView {
  const base = withEntitlements(state, entitlements);
  const org = effectiveModules(base);
  const porSede = new Map<string, ReadonlySet<ModuleKey>>();
  return {
    state, entitlements, serviceStatus, branchDisabled, org,
    contracted: (key) => entitlements.get(key) !== false,
    at(branchId) {
      if (!branchId) return org;
      const apagados = branchDisabled.get(branchId);
      if (!apagados || apagados.size === 0) return org;
      let r = porSede.get(branchId);
      if (!r) { r = effectiveModulesAt(base, apagados); porSede.set(branchId, r); }
      return r;
    },
  };
}

export async function moduleViewOf(organizationId: string): Promise<ModuleView> {
  const guardado = memoria.get(organizationId);
  if (guardado && guardado.hasta > Date.now()) return guardado.view;
  const repo = new ModuleStateRepository(organizationId);
  const [state, entitlements, serviceStatus, branchDisabled] = await Promise.all([repo.state(), repo.entitlements(), repo.serviceStatus(), repo.branchDisabled()]);
  const view = armar(state, entitlements, serviceStatus, branchDisabled);
  memoria.set(organizationId, { view, hasta: Date.now() + VIGENCIA_MS });
  return view;
}

export async function modulesOf(organizationId: string): Promise<ReadonlySet<ModuleKey>> {
  return (await moduleViewOf(organizationId)).org;
}

export async function isModuleOn(organizationId: string, key: ModuleKey): Promise<boolean> {
  return (await modulesOf(organizationId)).has(key);
}

/** ¿Está activo en esa sucursal? Sin sucursal, en el gimnasio. */
export async function isModuleOnAt(organizationId: string, branchId: string | null | undefined, key: ModuleKey): Promise<boolean> {
  return (await moduleViewOf(organizationId)).at(branchId).has(key);
}

/** Tras cambiar un módulo (o en pruebas que escriben la tabla directamente). */
export function forgetModules(organizationId?: string): void {
  if (organizationId) memoria.delete(organizationId); else memoria.clear();
}
