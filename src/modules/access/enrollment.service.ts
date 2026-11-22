import {
  conflict, enrollmentGaps, notFound, templateDeletionDue, validation,
  type BiometricModality, type Enrollment, uuidv7,
} from '@gymflow/core';
import type { BiometricsSummary } from '@gymflow/core/contracts';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { ConsentRepository, MemberRepository, retirarBiometricoSinRegistro } from '../members/index.js';
import { ConsentDocumentRepository } from '../members/index.js';
import { EnrollmentRepository, type EnrollmentRecord } from './enrollment.repository.js';
import { FaceTemplateRepository, type MotivoHuerfana } from './face-template.repository.js';
import type { FaceEngine } from './face.engine.js';
import type { RequestContext } from '../../platform/context.js';

/** Lo que encontró (y, con `aplicar`, borró) la limpieza única de rostros. */
export type ResumenLimpiezaRostros = {
  aplicado: boolean;
  /** Plantillas de socios anonimizados: anonimizar no las borraba (A1-N1). */
  anonimizados: number;
  /** Plantillas de enrolamientos que ya estaban revocados. */
  revocados: number;
  /** Plantillas de bajas de más de N días sin regresar (D-32); solo si se pidió. */
  bajas: number;
  /** Enrolamientos de la cámara sin plantilla y con el borrado sin asentar. */
  sinConfirmar: number;
};

/** El motivo que queda en la bitácora de la limpieza única. */
const MOTIVO_LIMPIEZA: Record<MotivoHuerfana, string> = {
  ANONIMIZADO: 'Limpieza única: el socio fue anonimizado (ARCO) y su rostro seguía guardado',
  REVOCADO: 'Limpieza única: el enrolamiento ya estaba revocado y su plantilla seguía guardada',
  BAJA: 'Limpieza única: dado de baja hace más de 30 días sin regresar (D-32)',
};

/** Lo que hace falta para dar de alta un enrolamiento (la referencia, nunca la plantilla). */
type AltaDeEnrolamiento = {
  memberId: string;
  modality: BiometricModality;
  branchId: string;
  templateRef: string;
  algorithmVendor: string;
  algorithmVersion: string | null;
  reason: string;
};

/** Registrar un rostro no pide motivo (D6-06): este es el que queda en la bitácora. */
const MOTIVO_DE_REGISTRO = 'Registro de rostro en el mostrador';
/** El motivo, automático, con el que «Actualizar» revoca el rostro anterior (6-05). */
export const MOTIVO_DE_ACTUALIZACION = 'Actualización de rostro';
const ALGORITMO_DE_LA_CAMARA = 'insightface/buffalo_sc';

/**
 * Enrolamiento biométrico (ADR-032).
 *
 * Con el lector de la sucursal el servicio **nunca ve una plantilla**: recibe
 * la referencia que el equipo le da después de calcularla. Con la cámara de
 * recepción (2026-10-09, `enrollFace`) sí la ve: el motor facial propio
 * calcula el vector y el servicio lo guarda cifrado (`SENSITIVE_DATA_KEY`)
 * junto al enrolamiento, y lo borra en el acto al revocar. En los dos casos
 * guarda alrededor todo lo que hace falta para poder borrarla y para
 * demostrar que hubo permiso.
 *
 * El orden importa y es el mismo que en la domiciliación: **primero el
 * consentimiento, después el enrolamiento**. Al revés, un fallo en medio deja
 * biometría cobrable sin permiso — que es exactamente el pasivo heredado que
 * ADR-014 llama el riesgo principal, recreado a mano.
 */
export class EnrollmentService {
  private readonly audit = new AuditService();

  async enroll(ctx: RequestContext, input: AltaDeEnrolamiento): Promise<EnrollmentRecord> {
    // El consentimiento, el enrolamiento y su asiento, juntos (6-18): si ya
    // había uno vivo, la firma recién escrita no queda huérfana.
    return enUnaTransaccion(async () => {
      const { enrolled, consentId } = await this.crear(ctx, input);
      await this.asentarAlta(ctx, enrolled, consentId, input.reason);
      return enrolled;
    });
  }

  /** La firma y el enrolamiento, SIN su asiento: quien lo llama abre la unidad y asienta al final (OPT2-14). */
  private async crear(ctx: RequestContext, input: AltaDeEnrolamiento): Promise<{ enrolled: EnrollmentRecord; consentId: string; consentVersion: string }> {
    const orgId = ctx.tenant.organizationId;

    const member = await new MemberRepository(orgId).findById(input.memberId);
    if (!member) throw notFound('Socio no encontrado');

    // El texto lo pone el servidor, no el cliente: es el BIOMETRIC que el
    // dueño publicó. Si el mostrador pudiera mandar su propio texto, la
    // constancia diría lo que alguien escribió ese día, no lo que se publicó.
    const texto = await new ConsentDocumentRepository(orgId).findPublished('BIOMETRIC');
    if (!texto) {
      throw conflict(
        'No hay texto de consentimiento biométrico publicado. ' +
        'Publícalo en Configuración → Consentimientos antes de enrolar.',
      );
    }

    // El consentimiento PRIMERO, y es de tipo BIOMETRIC: aceptar el aviso de
    // privacidad no autoriza a tomar biometría. ADR-014 exige consentimiento
    // expreso y por escrito, separado.
    const consent = await new ConsentRepository(orgId).record({
      memberId: input.memberId,
      branchId: input.branchId,
      consentType: 'BIOMETRIC',
      documentVersion: texto.version,
      documentText: texto.bodyText,
      granted: true,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      channel: 'ASSISTED',
      assistedByUserId: ctx.tenant.actorUserId ?? null,
    });

    const enrolled = await new EnrollmentRepository(orgId).enroll({
      memberId: input.memberId,
      modality: input.modality,
      branchId: input.branchId,
      templateRef: input.templateRef,
      algorithmVendor: input.algorithmVendor,
      algorithmVersion: input.algorithmVersion,
      consentId: consent.id,
      enrolledByUserId: ctx.tenant.actorUserId ?? '',
    });

    if (!enrolled) {
      throw conflict(
        'Ese socio ya tiene un enrolamiento vivo en esta sucursal para esa modalidad. ' +
        'Revócalo antes de crear otro: dos plantillas del mismo socio en el mismo equipo ' +
        'significan que nadie sabe cuál está en uso.',
      );
    }
    return { enrolled, consentId: consent.id, consentVersion: texto.version };
  }

  private async asentarAlta(ctx: RequestContext, enrolled: EnrollmentRecord, consentId: string, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.audit.record(ctx, {
      action: 'access.biometric.enroll',
      resourceType: 'biometric_enrollment',
      resourceId: enrolled.id,
      branchId: enrolled.branchId,
      reason,
      // Ni la plantilla ni su referencia entran a la bitácora: lo que importa
      // es quién, a quién, de qué tipo y con qué consentimiento.
      afterState: {
        memberId: enrolled.memberId,
        modality: enrolled.modality,
        algorithmVendor: enrolled.algorithmVendor,
        consentId,
        ...extra,
      },
    });
  }

  /**
   * ALTA FACIAL CON LA CÁMARA DE RECEPCIÓN (2026-10-09; asistente nuevo en el
   * bloque 2.3). Primero el rostro, y solo si sirve, la firma, el enrolamiento,
   * la plantilla cifrada y el asiento EN UNA UNIDAD: si algo falla, no queda
   * nada (antes se revocaba a mano lo que ya se había escrito).
   *
   * Sin `reto` (lo normal desde 2.3): captura DE FRENTE. Recepción tiene a la
   * persona delante, así que la prueba de vida no protege de nada y el giro
   * mezclaba perfiles en la plantilla (6-09). El motor promedia solo los
   * cuadros de frente. Con `reto`, como antes (prueba de vida y promedio).
   * Sin `reason`: registrar un rostro no pide motivo (D6-06); la firma lo es.
   */
  async enrollFace(
    ctx: RequestContext, engine: FaceEngine,
    input: { memberId: string; branchId: string; frames: string[]; reto?: string | null; reason?: string | undefined },
  ): Promise<EnrollmentRecord & { consentVersion: string }> {
    const orgId = ctx.tenant.organizationId;
    const reto = input.reto ?? null;
    const r = await engine.extraer(input.frames, reto, true, { soloDeFrente: reto === null });
    if (!r.ok) throw validation(r.error);
    // 6-05: quien ya tiene su rostro aquí no «se enrola otra vez»: se actualiza.
    if (await new EnrollmentRepository(orgId).findLive(input.memberId, input.branchId, 'FACE')) {
      throw conflict('Ya tiene su rostro registrado en esta sucursal. Para cambiarlo usa «Actualizar» en su ficha: sustituye el anterior sin revocarlo aparte.');
    }
    const reason = input.reason?.trim() || MOTIVO_DE_REGISTRO;
    return enUnaTransaccion(async () => {
      const { enrolled, consentId, consentVersion } = await this.crear(ctx, {
        memberId: input.memberId, modality: 'FACE', branchId: input.branchId,
        templateRef: `servidor:${uuidv7()}`, algorithmVendor: ALGORITMO_DE_LA_CAMARA, algorithmVersion: '1', reason,
      });
      await new FaceTemplateRepository(orgId).save({
        enrollmentId: enrolled.id, branchId: input.branchId, memberId: input.memberId, embeddingEncrypted: engine.cifrar(r.embedding),
      });
      await this.asentarAlta(ctx, enrolled, consentId, reason, { capture: reto === null ? 'frontal' : 'challenge' });
      return { ...enrolled, consentVersion };
    });
  }

  /**
   * «ACTUALIZAR» UN ROSTRO (6-05; bloque 2.3): cambio de look, lentes nuevos o
   * una plantilla que salió mal. Un gesto en lugar de revocar (con motivo) y
   * volver a registrar (con firma): el rostro nuevo sustituye al anterior en
   * UNA unidad, la plantilla vieja se borra en el acto y el permiso biométrico
   * NO se retira (no es un retiro: sigue teniendo rostro).
   *
   * La firma se reutiliza si ya firmó el texto VIGENTE. Si el texto cambió,
   * tiene que leer y aceptar el nuevo (`versionLeida`): sin eso, 409
   * `CONSENT_TEXT_CHANGED` y no se toca nada.
   */
  async renewFace(
    ctx: RequestContext, engine: FaceEngine,
    input: { enrollmentId: string; frames: string[]; versionLeida?: string | undefined },
  ): Promise<{ enrolled: EnrollmentRecord; replacedId: string; consentVersion: string }> {
    const orgId = ctx.tenant.organizationId;
    const enrolamientos = new EnrollmentRepository(orgId);
    const actual = await enrolamientos.findById(input.enrollmentId);
    if (!actual) throw notFound('Enrolamiento no encontrado');
    if (actual.revokedAt) throw conflict('Ese rostro ya estaba revocado: regístralo de nuevo.');
    if (actual.modality !== 'FACE' || !actual.templateRef.startsWith('servidor:')) {
      throw conflict('Solo se actualiza un rostro tomado con la cámara de recepción.');
    }
    if (!await new MemberRepository(orgId).findById(actual.memberId)) throw notFound('Socio no encontrado');

    const texto = await new ConsentDocumentRepository(orgId).findPublished('BIOMETRIC');
    if (!texto) throw conflict('No hay texto de consentimiento biométrico publicado: publícalo en Textos de consentimiento.', 'CONSENT_TEXT_MISSING');
    const consents = new ConsentRepository(orgId);
    const firmaVigente = (await consents.vivosDeTipo(actual.memberId, 'BIOMETRIC')).find((c) => c.documentVersion === texto.version);
    if (!firmaVigente && input.versionLeida !== texto.version) {
      throw conflict(
        `El texto biométrico cambió: la vigente es la versión ${texto.version}. Tiene que leerla y aceptarla antes de actualizar su rostro.`,
        'CONSENT_TEXT_CHANGED',
      );
    }

    const r = await engine.extraer(input.frames, null, true, { soloDeFrente: true });
    if (!r.ok) throw validation(r.error);

    return enUnaTransaccion(async () => {
      const firmaNueva = firmaVigente ? null : await consents.record({
        memberId: actual.memberId, branchId: actual.branchId, consentType: 'BIOMETRIC',
        documentVersion: texto.version, documentText: texto.bodyText, granted: true,
        ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, channel: 'ASSISTED', assistedByUserId: ctx.tenant.actorUserId ?? null,
      });
      const consentId = firmaVigente?.id ?? firmaNueva!.id;

      const revocado = await enrolamientos.revoke(actual.id, MOTIVO_DE_ACTUALIZACION);
      if (!revocado) throw conflict('Ese rostro ya estaba revocado: regístralo de nuevo.');
      const plantillas = new FaceTemplateRepository(orgId);
      await plantillas.deleteForEnrollment(actual.id);
      await enrolamientos.confirmTemplateDeleted(actual.id);

      const enrolled = await enrolamientos.enroll({
        memberId: actual.memberId, modality: 'FACE', branchId: actual.branchId,
        templateRef: `servidor:${uuidv7()}`, algorithmVendor: ALGORITMO_DE_LA_CAMARA, algorithmVersion: '1',
        consentId, enrolledByUserId: ctx.tenant.actorUserId ?? '',
      });
      if (!enrolled) throw conflict('No se pudo sustituir el rostro: alguien más lo cambió al mismo tiempo. Abre su ficha otra vez.');
      await plantillas.save({ enrollmentId: enrolled.id, branchId: enrolled.branchId, memberId: enrolled.memberId, embeddingEncrypted: engine.cifrar(r.embedding) });

      // La bitácora, al final de la unidad (OPT2-14).
      if (firmaNueva) {
        await this.audit.record(ctx, {
          action: 'consent.record', resourceType: 'MemberConsent', resourceId: firmaNueva.id, branchId: actual.branchId,
          reason: `Firmó la versión ${texto.version} del texto biométrico al actualizar su rostro`,
          afterState: { consentType: 'BIOMETRIC', version: texto.version, granted: true, channel: 'ASSISTED' },
        });
      }
      await this.audit.record(ctx, {
        action: 'access.biometric.revoke', resourceType: 'biometric_enrollment', resourceId: actual.id, branchId: actual.branchId,
        reason: MOTIVO_DE_ACTUALIZACION,
        afterState: { memberId: actual.memberId, modality: actual.modality, templateDeleted: true, replacedBy: enrolled.id },
      });
      await this.asentarAlta(ctx, enrolled, consentId, MOTIVO_DE_ACTUALIZACION, { capture: 'frontal', replaces: actual.id });
      return { enrolled, replacedId: actual.id, consentVersion: texto.version };
    });
  }

  /** `GET /biometric-enrollments/summary`: lo que hay hoy, sin nombres. */
  async summary(orgId: string, branchIds?: readonly string[] | null, ahora = new Date()): Promise<BiometricsSummary> {
    const r = await new EnrollmentRepository(orgId).resumen(new Date(ahora.getTime() - 30 * 86_400_000), branchIds);
    const porSede = new Map<string, { facesLive: number; deviceLive: number }>();
    for (const e of r.vivos) {
      const s = porSede.get(e.branchId) ?? { facesLive: 0, deviceLive: 0 };
      if (e.servidor) s.facesLive += 1; else s.deviceLive += 1;
      porSede.set(e.branchId, s);
    }
    const conRostro = r.vivos.filter((e) => e.servidor);
    return {
      facesLive: conRostro.length,
      membersWithFace: new Set(conRostro.map((e) => e.memberId)).size,
      enrolledLast30Days: r.registrados,
      revokedLast30Days: r.revocados,
      deviceLive: r.vivos.length - conRostro.length,
      byBranch: [...porSede].map(([branchId, s]) => ({ branchId, ...s })),
    };
  }

  async revoke(ctx: RequestContext, id: string, reason: string): Promise<void> {
    if (!reason.trim()) throw validation('Revocar un enrolamiento exige un motivo');
    const orgId = ctx.tenant.organizationId;

    const revoked = await new EnrollmentRepository(orgId).revoke(id, reason);
    if (!revoked) throw conflict('Ese enrolamiento ya estaba revocado');
    // La plantilla de la cámara vive en el servidor: se borra en el acto y el
    // borrado queda confirmado (no espera a ningún equipo de la sucursal).
    if (revoked.templateRef.startsWith('servidor:')) {
      await new FaceTemplateRepository(orgId).deleteForEnrollment(id);
      await new EnrollmentRepository(orgId).confirmTemplateDeleted(id);
    }

    await this.audit.record(ctx, {
      action: 'access.biometric.revoke',
      resourceType: 'biometric_enrollment',
      resourceId: id,
      branchId: revoked.branchId,
      reason,
      afterState: { memberId: revoked.memberId, modality: revoked.modality },
    });
    // Sin rostro ni huella vivos, su permiso biométrico se retira en el acto
    // (21-10); antes esperaba al job de la noche. No hace nada si le queda otro.
    await retirarBiometricoSinRegistro(ctx, revoked.memberId, reason);
  }

  /**
   * Revoca TODO lo biométrico de un socio y BORRA en el acto las plantillas
   * que viven en el servidor, también las de enrolamientos ya revocados
   * (A1-N1). Es lo que hace anonimizar: antes solo marcaba los enrolamientos
   * y el rostro cifrado seguía guardado, ligado a su id, mientras `/biometria`
   * pedía confirmar un borrado que no había ocurrido. Las plantillas de un
   * lector de la sucursal (cuando exista) quedan como obligación de borrado,
   * como al revocar una por una.
   */
  async revokeAllForMember(ctx: RequestContext, memberId: string, reason: string): Promise<{ revocados: number; plantillasBorradas: number }> {
    if (!reason.trim()) throw validation('Revocar un enrolamiento exige un motivo');
    const orgId = ctx.tenant.organizationId;
    const enrolamientos = new EnrollmentRepository(orgId);
    return enUnaTransaccion(async () => {
      const revocados: EnrollmentRecord[] = [];
      for (const e of await enrolamientos.listForMember(memberId)) {
        if (e.revokedAt) continue;
        const r = await enrolamientos.revoke(e.id, reason);
        if (r) revocados.push(r);
      }
      const borradas = await new FaceTemplateRepository(orgId).deleteForMember(memberId);
      // La plantilla de la cámara ya no existe: el borrado es un hecho y queda asentado.
      const asentados = await enrolamientos.servidorSinConfirmar(memberId);
      for (const e of asentados) await enrolamientos.confirmTemplateDeleted(e.id);

      // La bitácora, al final de la unidad (OPT2-14).
      for (const e of revocados) {
        await this.audit.record(ctx, {
          action: 'access.biometric.revoke', resourceType: 'biometric_enrollment', resourceId: e.id, branchId: e.branchId, reason,
          afterState: { memberId, modality: e.modality, templateDeleted: borradas.includes(e.id) },
        });
      }
      for (const e of asentados.filter((x) => !revocados.some((r) => r.id === x.id))) {
        await this.audit.record(ctx, {
          action: 'access.biometric.template_deleted', resourceType: 'biometric_enrollment', resourceId: e.id, branchId: e.branchId, reason,
          afterState: { memberId },
        });
      }
      return { revocados: revocados.length, plantillasBorradas: borradas.length };
    });
  }

  /**
   * LIMPIEZA ÚNICA DE ROSTROS (auditoría 8, fase 0; A1-N1 y 6-07). Borra las
   * plantillas faciales que quedaron sin razón de existir: las de socios
   * anonimizados, las de enrolamientos ya revocados y, solo si se pide
   * `bajasDeMasDeDias`, las de quien se dio de baja hace más de ese plazo sin
   * regresar (D-32 fija 30 días). Además asienta el borrado de las plantillas
   * de la cámara que ya no existen. Con `aplicar: false` solo cuenta.
   *
   * Cada plantilla se trata en su propia unidad: si algo falla a la mitad,
   * volver a correrla sigue donde se quedó, y lo ya borrado no vuelve a contar.
   */
  async limpiarRostrosHuerfanos(ctx: RequestContext, opts: { aplicar: boolean; bajasDeMasDeDias?: number | null; ahora?: Date }): Promise<ResumenLimpiezaRostros> {
    const orgId = ctx.tenant.organizationId;
    const ahora = opts.ahora ?? new Date();
    const bajasAntesDe = opts.bajasDeMasDeDias ? new Date(ahora.getTime() - opts.bajasDeMasDeDias * 86_400_000) : null;
    const plantillas = new FaceTemplateRepository(orgId);
    const enrolamientos = new EnrollmentRepository(orgId);

    const huerfanas = await plantillas.huerfanas({ bajasAntesDe });
    const sinConfirmar = await enrolamientos.servidorSinConfirmar();
    const resumen: ResumenLimpiezaRostros = {
      aplicado: opts.aplicar,
      anonimizados: huerfanas.filter((h) => h.motivo === 'ANONIMIZADO').length,
      revocados: huerfanas.filter((h) => h.motivo === 'REVOCADO').length,
      bajas: huerfanas.filter((h) => h.motivo === 'BAJA').length,
      sinConfirmar: sinConfirmar.length,
    };
    if (!opts.aplicar) return resumen;

    for (const h of huerfanas) {
      const motivo = MOTIVO_LIMPIEZA[h.motivo];
      await enUnaTransaccion(async () => {
        const revocado = h.revocado ? null : await enrolamientos.revoke(h.enrollmentId, motivo);
        await plantillas.deleteForEnrollment(h.enrollmentId);
        await enrolamientos.confirmTemplateDeleted(h.enrollmentId);
        if (revocado) {
          await this.audit.record(ctx, {
            action: 'access.biometric.revoke', resourceType: 'biometric_enrollment', resourceId: h.enrollmentId, branchId: h.branchId, reason: motivo,
            afterState: { memberId: h.memberId, modality: revocado.modality, templateDeleted: true },
          });
        } else {
          await this.audit.record(ctx, {
            action: 'access.biometric.template_deleted', resourceType: 'biometric_enrollment', resourceId: h.enrollmentId, branchId: h.branchId, reason: motivo,
            afterState: { memberId: h.memberId },
          });
        }
      });
    }
    for (const e of sinConfirmar) {
      await enUnaTransaccion(async () => {
        if (!await enrolamientos.confirmTemplateDeleted(e.id)) return;
        await this.audit.record(ctx, {
          action: 'access.biometric.template_deleted', resourceType: 'biometric_enrollment', resourceId: e.id, branchId: e.branchId,
          reason: 'Limpieza única: la plantilla ya no existe en el servidor; se asienta su borrado',
          afterState: { memberId: e.memberId },
        });
      });
    }
    return resumen;
  }

  /**
   * Obligaciones de borrado pendientes.
   *
   * Devuelve las que ya VENCIERON el plazo, separadas de las que aún están
   * dentro: una lista que mezcla las dos no se puede usar para exigir nada.
   */
  async pendingDeletions(orgId: string, at = new Date()): Promise<{
    overdue: EnrollmentRecord[];
    waiting: EnrollmentRecord[];
  }> {
    const pendientes = await new EnrollmentRepository(orgId).pendingDeletion(500);
    const overdue: EnrollmentRecord[] = [];
    const waiting: EnrollmentRecord[] = [];

    for (const e of pendientes) {
      (templateDeletionDue(toDomain(e), at) ? overdue : waiting).push(e);
    }
    return { overdue, waiting };
  }

  /** La sucursal confirma que borró. Es la PRUEBA, no la orden. */
  async confirmDeleted(ctx: RequestContext, id: string): Promise<void> {
    const orgId = ctx.tenant.organizationId;
    const ok = await new EnrollmentRepository(orgId).confirmTemplateDeleted(id);
    if (!ok) throw conflict('Ese enrolamiento no está revocado, o ya se confirmó su borrado');

    await this.audit.record(ctx, {
      action: 'access.biometric.template_deleted',
      resourceType: 'biometric_enrollment',
      resourceId: id,
    });
  }

  /** Qué le falta a un enrolamiento para ser utilizable. Lo decide el dominio. */
  gapsOf(record: EnrollmentRecord): string[] {
    return enrollmentGaps(toDomain(record));
  }
}

function toDomain(r: EnrollmentRecord): Enrollment {
  return {
    memberId: r.memberId,
    modality: r.modality,
    branchId: r.branchId,
    algorithmVendor: r.algorithmVendor,
    consentId: r.consentId,
    enrolledByUserId: r.enrolledByUserId,
    enrolledAt: r.enrolledAt,
    revokedAt: r.revokedAt,
    templateDeletedAt: r.templateDeletedAt,
  };
}
