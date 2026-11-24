import { CONSECUENCIA_DE_RETIRAR, TIPO_DE_CONSENTIMIENTO_PERSONAL, conflict, notFound, validation, type ConsentType } from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import type { RequestContext } from '../../platform/context.js';
import { ConsentDocumentRepository } from './consent-document.repository.js';
import { ConsentRepository, type ConsentRecord } from './consent.repository.js';
import { MemberRepository } from './member.repository.js';

/**
 * FIRMAR Y RETIRAR CONSENTIMIENTOS: UN SOLO SERVICIO (auditoría 8, bloque
 * 1.10; 21-05, 21-06, 21-10, 21-11).
 *
 * Antes cada pantalla firmaba y retiraba a su manera: el mandato guardaba el
 * texto que mandaba el navegador, una firma podía quedar sin texto, retirar
 * la domiciliación desde la ficha no apagaba las tarjetas (desde el portal
 * sí) y quitar el rostro dejaba su permiso «Aceptado». Ahora:
 *
 *  · `firmarConsentimiento` toma SIEMPRE la versión vigente y su texto del
 *    servidor. Sin texto publicado, 409. Lo que diga el navegador solo sirve
 *    para comprobar que el socio leyó la que sigue vigente.
 *  · `retirarConsentimiento` es el mismo acto venga de la ficha, del portal o
 *    de una solicitud ARCO, con los mismos efectos: salud borra la nota, el
 *    cargo recurrente apaga las tarjetas y la biometría revoca el rostro.
 *
 * Los efectos que tocan tablas de otros módulos (tarjetas, rostros) se
 * INSCRIBEN aquí al arrancar (`registrarEfectoDeRetiro`), como los ganchos de
 * entrada: socios no conoce a pagos ni a acceso, que ya dependen de él.
 */

const nombre = (tipo: string) => TIPO_DE_CONSENTIMIENTO_PERSONAL[tipo] ?? tipo;

export type CanalDeFirma = 'ASSISTED' | 'SELF_SERVICE' | 'PAPER';

export type FirmaInput = {
  memberId: string;
  consentType: ConsentType;
  channel: CanalDeFirma;
  /** `false` deja constancia de que se le ofreció y dijo que no. */
  granted?: boolean;
  branchId?: string | null;
  /** La versión que el socio leyó en pantalla: si ya no es la vigente, no se firma otra en su lugar (409). */
  versionLeida?: string | undefined;
  /**
   * Lo que el SERVIDOR agrega al texto publicado y queda dentro de lo firmado
   * (el mandato: plan, importe y tarjeta). Nunca viene del navegador.
   */
  componer?: (textoPublicado: string) => string;
  ip?: string | null;
  userAgent?: string | null;
  /** Para la bitácora: por qué se firma (p. ej. «Domiciliación de su tarjeta»). */
  motivo?: string;
  /** Datos sin texto libre que acompañan el asiento. */
  detalle?: Record<string, unknown>;
};

/** Firma el texto VIGENTE del tipo, con su asiento, en una unidad. */
export async function firmarConsentimiento(ctx: RequestContext, input: FirmaInput): Promise<ConsentRecord> {
  const orgId = ctx.tenant.organizationId;
  const vigente = await new ConsentDocumentRepository(orgId).findPublished(input.consentType);
  if (!vigente) {
    throw conflict(`No hay texto publicado de «${nombre(input.consentType)}»: publícalo en Textos de consentimiento antes de que alguien lo firme.`, 'CONSENT_TEXT_MISSING');
  }
  if (input.versionLeida !== undefined && input.versionLeida !== vigente.version) {
    throw conflict(`El texto de «${nombre(input.consentType)}» cambió: la vigente es la versión ${vigente.version}. Ábrelo otra vez para que la lea.`, 'CONSENT_TEXT_CHANGED');
  }
  const granted = input.granted ?? true;
  const asistida = input.channel !== 'SELF_SERVICE';
  return enUnaTransaccion(async () => {
    const consent = await new ConsentRepository(orgId).record({
      memberId: input.memberId,
      branchId: input.branchId ?? null,
      consentType: input.consentType,
      documentVersion: vigente.version,
      documentText: input.componer ? input.componer(vigente.bodyText) : vigente.bodyText,
      granted,
      ip: input.ip ?? ctx.ip ?? null,
      userAgent: input.userAgent ?? ctx.userAgent ?? null,
      channel: input.channel,
      assistedByUserId: asistida ? ctx.tenant.actorUserId ?? null : null,
    });
    await new AuditService().record(ctx, {
      action: 'consent.record', resourceType: 'MemberConsent', resourceId: consent.id, branchId: input.branchId ?? null,
      ...(input.motivo ? { reason: input.motivo } : {}),
      afterState: { consentType: input.consentType, version: vigente.version, granted, channel: input.channel, ...(input.detalle ?? {}) },
    });
    return consent;
  });
}

// ── Retirar ──────────────────────────────────────────────────────────────────

/** Por dónde se retira: queda en la bitácora. */
export type ViaDeRetiro = 'ficha' | 'portal' | 'arco' | 'biometria';

/** Lo que otro módulo hace cuando se retira un permiso; devuelve cifras para el asiento. */
export type EfectoDeRetiro = (ctx: RequestContext, memberId: string, motivo: string) => Promise<Record<string, number | string | boolean> | void>;

const efectos = new Map<string, EfectoDeRetiro[]>();

/** Lo llama, al arrancar, quien depende de socios Y del módulo que ejecuta el efecto (hoy: privacidad). */
export function registrarEfectoDeRetiro(consentType: ConsentType, efecto: EfectoDeRetiro): void {
  efectos.set(consentType, [...(efectos.get(consentType) ?? []), efecto]);
}

/** Los tipos que tienen efecto inscrito (para la prueba de que el arranque los inscribe). */
export function efectosDeRetiroInscritos(): string[] {
  return [...efectos.keys()].sort();
}

export type RetiroInput = {
  memberId: string;
  /** El permiso que se retira. Se da el tipo o una de sus firmas (`consentId`). */
  consentType?: ConsentType | undefined;
  consentId?: string | undefined;
  motivo: string;
  via: ViaDeRetiro;
  /** Qué tipos puede retirar quien lo pide (el socio solo lo opcional; recepción, además la biometría). */
  permitidos: readonly ConsentType[];
  /** Para el asiento (la solicitud ARCO que lo originó, p. ej.). */
  detalle?: Record<string, unknown>;
};

export type RetiroHecho = { consentType: ConsentType; consentIds: string[]; versiones: string[]; efectos: Record<string, number | string | boolean> };

/**
 * Retira el permiso ENTERO (todas sus firmas vivas) y ejecuta sus efectos, con
 * su asiento, en una unidad. La firma no se borra: queda con la fecha del retiro.
 */
export async function retirarConsentimiento(ctx: RequestContext, input: RetiroInput): Promise<RetiroHecho> {
  const orgId = ctx.tenant.organizationId;
  const consents = new ConsentRepository(orgId);
  const members = new MemberRepository(orgId);
  const member = await members.findByIdIncludingArchived(input.memberId);
  if (!member) throw notFound('Socio no encontrado');

  let tipo = input.consentType;
  if (input.consentId) {
    const firma = (await consents.listForMember(input.memberId)).find((c) => c.id === input.consentId);
    if (!firma) throw notFound('Consentimiento no encontrado');
    if (firma.revokedAt || !firma.granted) throw conflict('Ese consentimiento ya estaba retirado');
    tipo = firma.consentType as ConsentType;
  }
  if (!tipo) throw validation('Falta decir qué permiso se retira');
  if (!input.permitidos.includes(tipo)) {
    const porque = CONSECUENCIA_DE_RETIRAR[tipo];
    throw validation(input.via === 'portal'
      ? 'Ese permiso es obligatorio para ser socio: para retirarlo hay que darte de baja en recepción.'
      : `«${nombre(tipo)}» no se retira por separado. ${porque?.personal ?? ''}`.trim());
  }
  const vivos = await consents.vivosDeTipo(input.memberId, tipo);
  if (vivos.length === 0) throw conflict(input.via === 'portal' ? 'No tienes ese permiso activo' : 'Ese consentimiento ya estaba retirado');

  const tipoFinal = tipo;
  return enUnaTransaccion(async () => {
    await consents.revokeMany(vivos.map((v) => v.id));
    const hecho: Record<string, number | string | boolean> = {};
    // Sin permiso para datos de salud, la nota de salud no se conserva.
    if (tipoFinal === 'HEALTH_DATA') { await members.update(input.memberId, { healthNotes: null }); hecho.healthNotesDeleted = true; }
    for (const efecto of efectos.get(tipoFinal) ?? []) Object.assign(hecho, (await efecto(ctx, input.memberId, input.motivo)) ?? {});
    // La bitácora, al final de la unidad (OPT2-14).
    await new AuditService().record(ctx, {
      action: 'consent.revoke', resourceType: 'MemberConsent', resourceId: vivos[0]!.id, branchId: member.homeBranchId, reason: input.motivo,
      afterState: {
        consentType: tipoFinal, version: vivos[0]!.documentVersion, via: input.via, memberCode: member.memberCode,
        ...(vivos.length > 1 ? { signaturesRevoked: vivos.length } : {}), ...hecho, ...(input.detalle ?? {}),
      },
    });
    return { consentType: tipoFinal, consentIds: vivos.map((v) => v.id), versiones: vivos.map((v) => v.documentVersion), efectos: hecho };
  });
}

/**
 * El sentido inverso (21-10): al socio se le quitó su último rostro o huella y
 * su permiso biométrico seguía «Aceptado». Si ya no tiene ninguno vivo, el
 * permiso se retira con la misma fecha. No ejecuta efectos: la biometría ya se
 * quitó. Devuelve cuántas firmas retiró (0 si aún tiene alguno vivo o no había).
 *
 * Lo llama acceso justo después de revocar un enrolamiento; además el job
 * nocturno de privacidad repasa lo que hubiera quedado (`privacy.retention`).
 */
export async function retirarBiometricoSinRegistro(ctx: RequestContext, memberId: string, motivo: string): Promise<number> {
  const orgId = ctx.tenant.organizationId;
  const consents = new ConsentRepository(orgId);
  if ((await consents.biometricosSinRegistro(memberId)).length === 0) return 0;
  const vivos = await consents.vivosDeTipo(memberId, 'BIOMETRIC');
  if (vivos.length === 0) return 0;
  const member = await new MemberRepository(orgId).findByIdIncludingArchived(memberId);
  return enUnaTransaccion(async () => {
    const n = await consents.revokeMany(vivos.map((v) => v.id));
    if (n === 0) return 0;
    await new AuditService().record(ctx, {
      action: 'consent.revoke', resourceType: 'MemberConsent', resourceId: vivos[0]!.id, branchId: member?.homeBranchId ?? null,
      reason: motivo,
      afterState: { consentType: 'BIOMETRIC', version: vivos[0]!.documentVersion, via: 'biometria', ...(member ? { memberCode: member.memberCode } : {}), ...(n > 1 ? { signaturesRevoked: n } : {}) },
    });
    return n;
  });
}
