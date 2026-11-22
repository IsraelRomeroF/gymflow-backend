import { systemContext, type JobHandler, type JobResult } from '../../platform/jobs/types.js';
import { IntakeRepository } from '../intake/index.js';
import { PortalAuthRepository } from '../portal/index.js';
import { ConsentRepository, MemberNoticeRepository, retirarBiometricoSinRegistro } from '../members/index.js';
import { SessionRepository } from '../identity/index.js';
import { WebhookRepository } from '../payments/index.js';

/** Plazos de conservación. Cortos a propósito: lo que no se guarda no se filtra. */
export const RETENCION = {
  /** Alta digital ya revisada: sus datos viven en la ficha, o se rechazó. */
  altaRevisadaDias: 90,
  /** Alta que nadie revisó: se cierra y se borra. */
  altaSinRevisarDias: 180,
  /** Sesiones del socio cerradas o caducadas. */
  sesionSocioDias: 30,
  /** Invitaciones al portal caducadas: su hash ya no abre nada (PS-08). */
  invitacionDias: 30,
  /** Avisos del portal ya leídos. */
  avisoLeidoDias: 90,
  /** Webhooks con firma inválida: solo sirven para investigar un ataque. */
  webhookInvalidoDias: 7,
} as const;

const dias = (n: number) => new Date(Date.now() - n * 86_400_000);

/**
 * RETENCIÓN DE DATOS PERSONALES (LFPDPPP, principio de proporcionalidad;
 * SEC-08). Cada módulo borra lo suyo; aquí solo se decide CUÁNDO. Es
 * idempotente: lo ya borrado no vuelve a contar.
 */
const retention: JobHandler = async (organizationId) => {
  const result: JobResult = {
    job: 'privacy.retention', processed: 0, skipped: 0, batches: 1, truncated: false, errors: [],
  };
  const pasos: Array<[string, () => Promise<number>]> = [
    ['intakes.scrub', () => new IntakeRepository(organizationId).scrubReviewedBefore(dias(RETENCION.altaRevisadaDias))],
    ['intakes.expire', () => new IntakeRepository(organizationId).expireUnreviewedBefore(dias(RETENCION.altaSinRevisarDias))],
    ['member-sessions', () => new PortalAuthRepository().purgeSessionsBefore(dias(RETENCION.sesionSocioDias))],
    ['portal-invites', () => new PortalAuthRepository().purgeInvitesBefore(dias(RETENCION.invitacionDias))],
    ['member-notices', () => new MemberNoticeRepository(organizationId).purgeReadBefore(dias(RETENCION.avisoLeidoDias))],
    ['staff-sessions', () => new SessionRepository().purgeExpired()],
    ['webhooks.invalid', () => new WebhookRepository().purgeInvalidBefore(dias(RETENCION.webhookInvalidoDias))],
    // A quien ya no tiene rostro ni huella se le retira el permiso biométrico
    // (21-10). Acceso lo hace en el acto al revocar; esto repasa lo que hubiera
    // quedado de antes o de un camino que no pasó por ahí. Idempotente.
    ['consents.biometric-without-enrollment', async () => {
      let retirados = 0;
      for (const memberId of await new ConsentRepository(organizationId).biometricosSinRegistro()) {
        retirados += await retirarBiometricoSinRegistro(systemContext(organizationId), memberId, 'Ya no tiene rostro ni huella registrados');
      }
      return retirados;
    }],
  ];
  for (const [paso, fn] of pasos) {
    try {
      result.processed += await fn();
    } catch (error) {
      result.errors.push({ entityId: paso, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
};

export const PRIVACY_JOBS: ReadonlyArray<{ name: string; handler: JobHandler }> = [
  { name: 'privacy.retention', handler: retention },
];
