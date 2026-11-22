import { registerEntryHook } from '../access/index.js';
import { ClassRepository } from './class.repository.js';
import { ClassService } from './class.service.js';

/** Puerta + clase en un registro: si entró y tenía clase reservada a esa hora, ya llegó. */
export function registerClassHooks(): void {
  registerEntryHook(async (e) => {
    const reservas = await new ClassRepository(e.organizationId).bookedAround(e.memberId, e.branchId, e.at);
    const servicio = new ClassService();
    for (const id of reservas) await servicio.checkIn(e.organizationId, id, e.at);
  });
}
