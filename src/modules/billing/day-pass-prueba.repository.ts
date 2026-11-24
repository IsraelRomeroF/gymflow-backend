import { createHash } from 'node:crypto';
import { uuidv7 } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * PASE DE PRUEBA (auditoría 8, fase 3, bloque 3.3; D-08).
 *
 * Gratis y UNO por persona, identificada por su celular. A diferencia del
 * pase del día, este sí tiene tabla (`trial_passes`): no es un cargo, porque
 * no mueve dinero, y «uno por celular» lo sostiene un índice único.
 *
 * El celular no se guarda: se guarda su huella y sus últimos cuatro dígitos.
 * Así el «uno por celular» sobrevive a que el socio cambie de número o a que
 * se anonimice, sin dejar aquí un dato personal que haya que borrar después.
 */
export type TrialPassRecord = {
  id: string;
  memberId: string;
  branchId: string;
  phoneLast4: string;
  /** El día de operación (de su sede) en que vale. */
  validOn: Date;
  grantedByUserId: string | null;
  createdAt: Date;
};

const SELECT = {
  id: true, memberId: true, branchId: true, phoneLast4: true, validOn: true, grantedByUserId: true, createdAt: true,
} as const;

/** Los diez dígitos del celular (sin lada de país), o `null` si no los trae. */
export function digitosDelCelular(phoneE164: string | null | undefined): string | null {
  const d = (phoneE164 ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

/** La huella de un celular dentro de UN gimnasio: el mismo número en otro gimnasio es otra huella. */
export function huellaDelCelular(organizationId: string, diezDigitos: string): string {
  return createHash('sha256').update(`${organizationId}:${diezDigitos}`).digest('hex');
}

export class TrialPassRepository extends TenantRepository {
  /** El pase de prueba de ese socio (solo puede tener uno, en todo el gimnasio). */
  async deSocio(memberId: string): Promise<TrialPassRecord | null> {
    return this.db.trialPass.findFirst({ where: this.scope({ memberId }), select: SELECT });
  }

  /** El pase que ya se dio con ese celular, sea de quien sea. */
  async deCelular(phoneKey: string): Promise<TrialPassRecord | null> {
    return this.db.trialPass.findFirst({ where: this.scope({ phoneKey }), select: SELECT });
  }

  /** Su pase si es de ese día de operación: es lo que la puerta pregunta. */
  async delDia(memberId: string, dia: Date): Promise<TrialPassRecord | null> {
    return this.db.trialPass.findFirst({ where: this.scope({ memberId, validOn: dia }), select: SELECT });
  }

  /**
   * Lo crea. Si otro mostrador lo dio en este mismo instante (al mismo socio o
   * con el mismo celular), la base lo rechaza por sus índices únicos.
   */
  async crear(input: { memberId: string; branchId: string; phoneKey: string; phoneLast4: string; validOn: Date; grantedByUserId: string | null }): Promise<TrialPassRecord> {
    return this.db.trialPass.create({
      data: { id: uuidv7(), organizationId: this.organizationId, ...input },
      select: SELECT,
    });
  }

  /** Quién lo dio y en qué sede, por nombre: la pantalla no enseña identificadores. */
  async nombres(pase: Pick<TrialPassRecord, 'branchId' | 'grantedByUserId'>): Promise<{ branchName: string; grantedByName: string | null }> {
    const [sede, quien] = await Promise.all([
      this.db.branch.findFirst({ where: { id: pase.branchId, organizationId: this.organizationId }, select: { name: true } }),
      pase.grantedByUserId ? this.db.user.findFirst({ where: { id: pase.grantedByUserId, organizationId: this.organizationId }, select: { fullName: true } }) : null,
    ]);
    return { branchName: sede?.name ?? 'Sucursal', grantedByName: quien?.fullName ?? null };
  }

  /** Cuántos pases de prueba se dieron en una sede en un rango de días (para Dirección). */
  async contar(branchId: string | null, desde: Date, hasta: Date): Promise<number> {
    return this.db.trialPass.count({ where: this.scope({ ...(branchId ? { branchId } : {}), validOn: { gte: desde, lt: hasta } }) });
  }
}
