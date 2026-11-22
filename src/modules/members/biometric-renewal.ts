import { conflict } from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import type { RequestContext } from '../../platform/context.js';
import { ConsentDocumentRepository } from './consent-document.repository.js';
import { ConsentRepository, type ConsentRecord } from './consent.repository.js';

/**
 * RECONSENTIMIENTO BIOMÉTRICO (auditoría 8, 6-03 y 21-09).
 *
 * El texto biométrico que firmaron los primeros socios decía que la plantilla
 * vivía «solo en el equipo de la sucursal». Con la cámara de recepción
 * (ADR-040) vive cifrada en el servidor del gimnasio: la firma describía otro
 * tratamiento. El texto corregido se publica como versión NUEVA (lo publicado
 * no se edita), y quien tiene un rostro o huella vivos con una firma de un
 * texto anterior queda «por renovar» hasta que firme el vigente en recepción.
 *
 * No bloquea la entrada: que sin firma vigente no se entre es D-06 (fase 3).
 */
export type FirmaBiometricaPorRenovar = {
  consentId: string;
  memberId: string;
  signedVersion: string;
  signedAt: Date;
  currentVersion: string;
  /** Sucursales donde tiene hoy un rostro o huella vivos. */
  branchIds: string[];
  member: { memberCode: string; firstName: string; lastName: string; homeBranchId: string | null };
};

/** Quién firmó un texto biométrico que ya no es el publicado y hoy tiene rostro o huella. Sin texto publicado, nadie. */
export async function firmasBiometricasPorRenovar(organizationId: string, memberId?: string): Promise<FirmaBiometricaPorRenovar[]> {
  const vigente = await new ConsentDocumentRepository(organizationId).findPublished('BIOMETRIC');
  if (!vigente) return [];
  const firmas = await new ConsentRepository(organizationId).biometricasVigentesConRegistro(memberId);
  return firmas
    .filter((f) => f.documentVersion !== vigente.version)
    .map((f) => ({
      consentId: f.id, memberId: f.memberId, signedVersion: f.documentVersion, signedAt: f.grantedAt,
      currentVersion: vigente.version, branchIds: f.branchIds, member: f.member,
    }));
}

/** La firma por renovar de UN socio, o el 409 que dice por qué no hay nada que firmar. */
export async function firmaBiometricaPorRenovarDe(organizationId: string, memberId: string): Promise<FirmaBiometricaPorRenovar> {
  const [porRenovar] = await firmasBiometricasPorRenovar(organizationId, memberId);
  if (!porRenovar) {
    throw conflict('No hay nada que volver a firmar: no tiene rostro ni huella registrados, o ya firmó la versión vigente.');
  }
  return porRenovar;
}

/**
 * El socio firma, delante de recepción, el texto biométrico VIGENTE. El texto
 * lo pone el servidor (PS-06), como al enrolar. La firma anterior se conserva
 * tal cual: es la evidencia de lo que aceptó entonces.
 */
export async function renovarFirmaBiometrica(
  ctx: RequestContext, porRenovar: FirmaBiometricaPorRenovar, branchId: string | null,
  /** La versión que el socio leyó en pantalla: si ya no es la vigente, no se firma otra en su lugar. */
  versionLeida?: string,
): Promise<{ consent: ConsentRecord; previousVersion: string }> {
  const orgId = ctx.tenant.organizationId;
  const vigente = await new ConsentDocumentRepository(orgId).findPublished('BIOMETRIC');
  if (!vigente) throw conflict('No hay texto de consentimiento biométrico publicado: publícalo en Textos de consentimiento.', 'CONSENT_TEXT_MISSING');
  if (versionLeida !== undefined && versionLeida !== vigente.version) {
    throw conflict(`El texto biométrico cambió mientras lo leía: la vigente es la versión ${vigente.version}. Ábrelo otra vez para que la lea.`, 'CONSENT_TEXT_CHANGED');
  }
  const memberId = porRenovar.memberId;
  // La firma y su asiento en la bitácora, juntos (OPT2-14).
  return enUnaTransaccion(async () => {
    const consent = await new ConsentRepository(orgId).record({
      memberId,
      branchId,
      consentType: 'BIOMETRIC',
      documentVersion: vigente.version,
      documentText: vigente.bodyText,
      granted: true,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      channel: 'ASSISTED',
      assistedByUserId: ctx.tenant.actorUserId ?? null,
    });
    await new AuditService().record(ctx, {
      action: 'consent.record',
      resourceType: 'MemberConsent',
      resourceId: consent.id,
      branchId,
      reason: `Firmó la versión ${vigente.version} del texto biométrico; antes tenía la ${porRenovar.signedVersion}`,
      afterState: { consentType: 'BIOMETRIC', version: vigente.version, granted: true, renews: porRenovar.consentId, previousVersion: porRenovar.signedVersion },
    });
    return { consent, previousVersion: porRenovar.signedVersion };
  });
}
