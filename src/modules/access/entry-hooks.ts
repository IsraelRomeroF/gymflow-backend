/**
 * Entrada registrada: otros módulos reaccionan (hoy: clases marca la llegada).
 * Acceso no conoce a quién avisa; cada módulo se inscribe al arrancar, como
 * los ganchos de caja y de membresías. Un gancho que falla no cierra la puerta.
 */
export type EntryEvent = { organizationId: string; memberId: string; branchId: string; at: Date };
type EntryHook = (e: EntryEvent) => Promise<void>;
const hooks: EntryHook[] = [];

export function registerEntryHook(fn: EntryHook): void { hooks.push(fn); }

export async function emitEntry(e: EntryEvent): Promise<void> {
  for (const h of hooks) {
    try { await h(e); } catch { /* la entrada ya quedó; lo demás es cortesía */ }
  }
}
