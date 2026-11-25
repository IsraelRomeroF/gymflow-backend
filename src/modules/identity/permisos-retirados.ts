import { NEVER_ADJUSTABLE_BY_ROLE } from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { systemContext } from '../../platform/jobs/types.js';
import { StaffRepository } from './staff.repository.js';

/**
 * LO QUE YA NO SE LE ENCIENDE A RECEPCIÓN Y ALGUIEN TIENE ENCENDIDO
 * (bloque 4.19; respuestas de Israel del 2026-11-25, P-09 y P-10).
 *
 * Desde este bloque `pos:sale:void` (anular ventas y descartar «por corregir»)
 * y `members:health:read` (la nota de salud) ya no están en la lista de lo que
 * se enciende a recepción. La sesión ya ignora un ajuste guardado que no le
 * toca al puesto (`normalizeOverrides` con el puesto), así que desde el
 * despliegue nadie de recepción los USA. Lo que queda es el dato guardado en
 * `users.permissionOverrides`: aquí se lista (solo lectura) y se retira con su
 * asiento en la bitácora (`staff.permissions`, como acto del sistema).
 *
 * Repetible: la segunda corrida no encuentra nada. Solo toca esas dos claves
 * en lo que la persona tiene AGREGADO; lo demás de sus excepciones queda igual,
 * tal como está guardado. No cierra sesiones: no hace falta, la sesión ya no
 * las daba.
 */
export const RETIRADOS_DE_RECEPCION: readonly string[] = NEVER_ADJUSTABLE_BY_ROLE.RECEPTION.map((n) => n.permission);

export type ExcepcionRetirable = { userId: string; isActive: boolean; retirar: string[]; antes: { add: unknown[]; remove: unknown[] }; despues: { add: unknown[]; remove: unknown[] } };

const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** SOLO LEE: quién de recepción tiene guardada alguna de las dos, y cómo quedaría. */
export async function excepcionesPorRetirar(organizationId: string): Promise<ExcepcionRetirable[]> {
  const filas = await new StaffRepository(organizationId).excepcionesGuardadasDeRecepcion();
  const out: ExcepcionRetirable[] = [];
  for (const f of filas) {
    const o = (f.permissionOverrides && typeof f.permissionOverrides === 'object' ? f.permissionOverrides : {}) as { add?: unknown; remove?: unknown };
    const antes = { add: lista(o.add), remove: lista(o.remove) };
    const retirar = RETIRADOS_DE_RECEPCION.filter((k) => antes.add.includes(k));
    if (retirar.length === 0) continue;
    out.push({ userId: f.id, isActive: f.isActive, retirar, antes, despues: { add: antes.add.filter((k) => !retirar.includes(k as string)), remove: antes.remove } });
  }
  return out;
}

/** APLICA: retira las dos claves a cada quien y deja un asiento por persona. */
export async function retirarExcepciones(organizationId: string, reason: string): Promise<ExcepcionRetirable[]> {
  const repo = new StaffRepository(organizationId);
  const audit = new AuditService();
  const ctx = systemContext(organizationId);
  const hechas: ExcepcionRetirable[] = [];
  for (const e of await excepcionesPorRetirar(organizationId)) {
    await enUnaTransaccion(async () => {
      if (!await repo.guardarExcepciones(e.userId, e.despues)) return;
      await audit.record(ctx, {
        action: 'staff.permissions', resourceType: 'User', resourceId: e.userId, reason,
        beforeState: e.antes, afterState: { ...e.despues, retired: e.retirar, migration: '4.19' },
      });
      hechas.push(e);
    });
  }
  return hechas;
}
