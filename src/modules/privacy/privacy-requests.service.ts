import {
  ACCION_POR_SOLICITUD, PLAZOS_ARCO, REVOCABLES_EN_RECEPCION, SOLICITUDES_CON_PERMISO, TIPO_DE_CONSENTIMIENTO_SOCIO, TIPO_DE_SOLICITUD_ARCO_SOCIO,
  DomainError, conflict, estadoDeSolicitud, folioDeSolicitud, notFound, plazoVigente, solicitudVencida,
  type ConsentType, type ResultadoDeSolicitudArco,
} from '@gymflow/core';
import { ZodError } from 'zod';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import type { RequestContext } from '../../platform/context.js';
import { MemberNoticeRepository, MemberRepository, retirarConsentimiento } from '../members/index.js';
import { OrganizationRepository } from '../organization/index.js';
import { fecha } from './etiquetas.js';
import { PrivacyRequestRepository, type PrivacyRequestChannel, type PrivacyRequestKind, type PrivacyRequestRecord } from './privacy-request.repository.js';

/**
 * EL CICLO DE UNA SOLICITUD ARCO (auditoría 8, bloque 1.10; 21-01 a 21-04, 21-18).
 *
 *   1. ENTRA (recepción, portal, correo o escrito) con su folio y su fecha.
 *   2. IDENTIDAD: en el mostrador la acredita quien la registra; desde el
 *      portal, la sesión del socio. Por correo o por escrito queda «falta
 *      acreditar identidad» y el plazo NO corre hasta que alguien la acredita:
 *      cualquiera puede escribir pidiendo los datos de otra persona.
 *   3. RESPUESTA en 20 días hábiles: «procede» o «no procede», con el motivo
 *      que lee el socio. El socio recibe el aviso en su portal.
 *   4. HACERLA EFECTIVA en 15 días hábiles más, si procede. Retirar un permiso
 *      se hace en el mismo acto; la descarga cierra un acceso; anonimizar, una
 *      cancelación; corregir un dato lo marca quien lo corrigió.
 *
 * Cada paso deja su asiento en la bitácora y su aviso al socio. Los plazos en
 * días naturales los pone el núcleo (`PLAZOS_ARCO`).
 */
export class PrivacyRequestsService {
  private readonly audit = new AuditService();

  /** Registrar la solicitud: queda la fecha de entrada y, si se acreditó la identidad, corre el plazo. */
  async abrir(ctx: RequestContext, memberId: string, input: {
    kind: PrivacyRequestKind; channel: PrivacyRequestChannel; note: string | null; consentType?: ConsentType | null | undefined;
    /** Quien registra dice que comprobó que la pide el titular (INE o lo conoce en persona). */
    identityVerified?: boolean | undefined; identityNote?: string | null | undefined;
  }): Promise<PrivacyRequestRecord> {
    const orgId = ctx.tenant.organizationId;
    const m = await new MemberRepository(orgId).findByIdIncludingArchived(memberId);
    if (!m) throw notFound('Socio no encontrado');

    const consentType = SOLICITUDES_CON_PERMISO.includes(input.kind) ? input.consentType ?? null : null;
    if (input.kind === 'REVOCATION' && !consentType) throw campo('consentType', 'Di qué permiso quiere retirar');
    if (consentType && !REVOCABLES_EN_RECEPCION.includes(consentType)) {
      throw campo('consentType', 'El aviso de privacidad y el reglamento solo se retiran con la baja: regístralo como cancelación');
    }

    // Quién es: el portal lo sabe por la sesión; el mostrador lo comprueba al
    // registrar; lo que llega por correo o por escrito espera a que alguien lo acredite.
    let identidad: { byUserId: string | null; note: string } | null = null;
    if (input.channel === 'PORTAL') identidad = { byUserId: null, note: 'Sesión de su portal' };
    else if (input.identityVerified) identidad = { byUserId: ctx.tenant.actorUserId ?? null, note: input.identityNote?.trim() || 'En persona' };
    else if (input.channel === 'FRONT_DESK') throw campo('identityVerified', 'Confirma que verificaste su identidad (INE o lo conoces en persona)');

    return enUnaTransaccion(async () => {
      const r = await new PrivacyRequestRepository(orgId).create({
        memberId, kind: input.kind, channel: input.channel, note: input.note, consentType, createdByUserId: ctx.tenant.actorUserId ?? null, identidad,
      });
      // La constancia, en su portal: folio y hasta cuándo se le responde.
      await this.avisar(orgId, r, 'PRIVACY_REQUEST_RECEIVED', 'Recibimos tu solicitud', identidad
        ? `${pedido(r)} · folio ${folio(r)}. Te respondemos a más tardar el ${fecha(r.dueAt)}.`
        : `${pedido(r)} · folio ${folio(r)}. Falta que acredites tu identidad en recepción para que corra el plazo de respuesta.`);
      await this.audit.record(ctx, {
        action: 'privacy.request.open', resourceType: 'PrivacyRequest', resourceId: r.id, branchId: m.homeBranchId,
        afterState: {
          memberCode: m.memberCode, folio: folio(r), kind: input.kind, channel: input.channel, ...(consentType ? { consentType } : {}),
          identityVerified: !!identidad, ...(identidad ? { dueAt: r.dueAt.toISOString() } : {}),
        },
      });
      return r;
    });
  }

  /** Acreditar que la pide el titular: desde aquí corre el plazo de respuesta. */
  async acreditarIdentidad(ctx: RequestContext, id: string, note: string): Promise<PrivacyRequestRecord> {
    const orgId = ctx.tenant.organizationId;
    const repo = new PrivacyRequestRepository(orgId);
    const r = await repo.findById(id);
    if (!r) throw notFound('Solicitud no encontrada');
    if (r.identityVerifiedAt) throw conflict('La identidad ya estaba acreditada');
    if (r.resolvedAt) throw conflict('Esa solicitud ya estaba resuelta');
    const m = await new MemberRepository(orgId).findByIdIncludingArchived(r.memberId);
    return enUnaTransaccion(async () => {
      if (!await repo.verifyIdentity(id, { byUserId: ctx.tenant.actorUserId ?? null, note })) throw conflict('La identidad ya estaba acreditada');
      const nueva = (await repo.findById(id))!;
      await this.avisar(orgId, nueva, 'PRIVACY_REQUEST_RECEIVED', 'Ya corre el plazo de tu solicitud',
        `${pedido(nueva)} · folio ${folio(nueva)}. Te respondemos a más tardar el ${fecha(nueva.dueAt)}.`, 'identidad');
      await this.audit.record(ctx, {
        action: 'privacy.request.identity', resourceType: 'PrivacyRequest', resourceId: id, branchId: m?.homeBranchId ?? null, reason: note,
        afterState: { ...(m ? { memberCode: m.memberCode } : {}), folio: folio(nueva), kind: nueva.kind, dueAt: nueva.dueAt.toISOString() },
      });
      return nueva;
    });
  }

  /**
   * Responder. «No procede» exige el motivo que leerá el socio. «Procede»
   * abre el segundo plazo; si lo que pide es retirar un permiso, se retira en
   * este mismo acto (con sus efectos) y queda hecha.
   */
  async resolver(ctx: RequestContext, id: string, input: { outcome: ResultadoDeSolicitudArco; resolution: string; consentType?: ConsentType | null | undefined }): Promise<PrivacyRequestRecord> {
    const orgId = ctx.tenant.organizationId;
    const repo = new PrivacyRequestRepository(orgId);
    const r = await repo.findById(id);
    if (!r) throw notFound('Solicitud no encontrada');
    if (r.resolvedAt) throw conflict('Esa solicitud ya estaba resuelta');
    if (!r.identityVerifiedAt) throw conflict('Primero acredita la identidad de quien la pide: sin eso no se responde ni corre el plazo');
    const m = await new MemberRepository(orgId).findByIdIncludingArchived(r.memberId);
    if (!m) throw notFound('Socio no encontrado');

    const consentType = SOLICITUDES_CON_PERMISO.includes(r.kind) ? input.consentType ?? r.consentType : null;
    if (input.outcome === 'GRANTED' && r.kind === 'REVOCATION' && !consentType) throw campo('consentType', 'Di qué permiso se retira');
    if (consentType && !REVOCABLES_EN_RECEPCION.includes(consentType)) {
      throw campo('consentType', 'El aviso de privacidad y el reglamento solo se retiran con la baja');
    }
    const aTiempo = !solicitudVencida(r);

    return enUnaTransaccion(async () => {
      // Lo inmediato: retirar el permiso que pide dejar de usar.
      let hecha: { note: string } | null = null;
      let efectos: Record<string, unknown> = {};
      if (input.outcome === 'GRANTED') {
        if (consentType && ACCION_POR_SOLICITUD[r.kind].inmediata) {
          try {
            const retiro = await retirarConsentimiento(ctx, {
              memberId: r.memberId, consentType, motivo: `Solicitud ARCO ${folio(r)}`, via: 'arco', permitidos: REVOCABLES_EN_RECEPCION,
              detalle: { privacyRequestId: r.id },
            });
            efectos = retiro.efectos;
            hecha = { note: `Se retiró «${TIPO_DE_CONSENTIMIENTO_SOCIO[consentType] ?? consentType}»` };
          } catch (e) {
            // Ya no tenía ese permiso activo: no hay nada más que hacer.
            if (!(e instanceof DomainError) || e.code !== 'CONFLICT') throw e;
            hecha = { note: `«${TIPO_DE_CONSENTIMIENTO_SOCIO[consentType] ?? consentType}» ya no estaba activo` };
          }
        } else if (r.kind === 'CANCELLATION' && m.anonymizedAt) {
          hecha = { note: 'Sus datos ya estaban anonimizados' };
        }
      }
      if (!await repo.resolve(id, { resolvedByUserId: ctx.tenant.actorUserId!, outcome: input.outcome, resolution: input.resolution, consentType, hecha })) {
        throw conflict('Esa solicitud ya estaba resuelta');
      }
      const nueva = (await repo.findById(id))!;
      // La respuesta llega al socio (21-02): antes era una nota interna.
      await this.avisar(orgId, nueva, 'PRIVACY_REQUEST_RESOLVED', input.outcome === 'GRANTED' ? 'Tu solicitud sí procede' : 'Tu solicitud no procede',
        `${pedido(nueva)} · folio ${folio(nueva)}. ${input.resolution}${input.outcome === 'GRANTED' ? (hecha ? ` ${hecha.note}.` : ` Queda hecho a más tardar el ${fecha(nueva.effectiveDueAt)}.`) : ''}`);
      await this.audit.record(ctx, {
        action: 'privacy.request.resolve', resourceType: 'PrivacyRequest', resourceId: id, branchId: m.homeBranchId, reason: input.resolution,
        afterState: {
          memberCode: m.memberCode, folio: folio(nueva), kind: r.kind, outcome: input.outcome, onTime: aTiempo,
          ...(consentType ? { consentType } : {}), effected: !!hecha, ...efectos,
          ...(input.outcome === 'GRANTED' && !hecha ? { effectiveDueAt: nueva.effectiveDueAt?.toISOString() } : {}),
        },
      });
      return nueva;
    });
  }

  /** «Ya quedó hecho»: lo que procede se hizo efectivo. Una cancelación solo se cierra con el socio ya anonimizado. */
  async hacerEfectiva(ctx: RequestContext, id: string, note: string): Promise<PrivacyRequestRecord> {
    const orgId = ctx.tenant.organizationId;
    const repo = new PrivacyRequestRepository(orgId);
    const r = await repo.findById(id);
    if (!r) throw notFound('Solicitud no encontrada');
    if (estadoDeSolicitud(r) !== 'EFFECT_PENDING') throw conflict(r.effectedAt ? 'Esa solicitud ya estaba hecha' : 'Solo se marca hecha una solicitud que procede');
    const m = await new MemberRepository(orgId).findByIdIncludingArchived(r.memberId);
    if (r.kind === 'CANCELLATION' && !m?.anonymizedAt) {
      throw conflict('Sus datos siguen en la ficha: dalo de baja y anonimízalo (con la firma del dueño) y la solicitud se cierra sola');
    }
    return enUnaTransaccion(() => this.cerrar(ctx, repo, r, note, m?.homeBranchId ?? null, m?.memberCode ?? null));
  }

  /**
   * Lo que cierra una solicitud sin que nadie la marque: la descarga de datos
   * (ACCESS) y la anonimización (CANCELLATION). Devuelve cuántas cerró.
   */
  async alHacerse(ctx: RequestContext, memberId: string, kind: 'ACCESS' | 'CANCELLATION', note: string, soloId?: string): Promise<number> {
    const orgId = ctx.tenant.organizationId;
    const repo = new PrivacyRequestRepository(orgId);
    const pendientes = (await repo.porHacerEfectivas(memberId, kind)).filter((r) => !soloId || r.id === soloId);
    if (pendientes.length === 0) return 0;
    const m = await new MemberRepository(orgId).findByIdIncludingArchived(memberId);
    for (const r of pendientes) await enUnaTransaccion(() => this.cerrar(ctx, repo, r, note, m?.homeBranchId ?? null, m?.memberCode ?? null));
    return pendientes.length;
  }

  private async cerrar(ctx: RequestContext, repo: PrivacyRequestRepository, r: PrivacyRequestRecord, note: string, branchId: string | null, memberCode: string | null): Promise<PrivacyRequestRecord> {
    const orgId = ctx.tenant.organizationId;
    const aTiempo = !solicitudVencida(r);
    if (!await repo.markEffected(r.id, { byUserId: ctx.tenant.actorUserId ?? null, note })) throw conflict('Esa solicitud ya estaba hecha');
    const nueva = (await repo.findById(r.id))!;
    // A quien pidió borrar sus datos ya no hay a quién avisarle: su portal se cerró con la baja.
    if (r.kind !== 'CANCELLATION') {
      await this.avisar(orgId, nueva, 'PRIVACY_REQUEST_DONE', 'Ya quedó hecho lo que pediste', `${pedido(nueva)} · folio ${folio(nueva)}. ${note}`);
    }
    await this.audit.record(ctx, {
      action: 'privacy.request.effect', resourceType: 'PrivacyRequest', resourceId: r.id, branchId, reason: note,
      afterState: { ...(memberCode ? { memberCode } : {}), folio: folio(nueva), kind: r.kind, onTime: aTiempo },
    });
    return nueva;
  }

  /** La bandeja: lo vivo, primero lo vencido y lo que vence antes; lo que espera identidad, al final. */
  async bandeja(organizationId: string) {
    const filas = await new PrivacyRequestRepository(organizationId).listLive();
    const orden = (r: PrivacyRequestRecord) => plazoVigente(r)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return filas.sort((a, b) => orden(a) - orden(b) || a.receivedAt.getTime() - b.receivedAt.getTime());
  }

  /** Cifras sin nombres (D-25): lo que ve Inicio y lo que consulta la dueña. */
  async resumen(organizationId: string) {
    const filas = await new PrivacyRequestRepository(organizationId).liveDates();
    const ahora = new Date();
    const plazos = filas.map((r) => plazoVigente(r)).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime());
    const cuenta = (estado: string) => filas.filter((r) => estadoDeSolicitud(r) === estado).length;
    return {
      open: filas.length, identityPending: cuenta('IDENTITY_PENDING'), toAnswer: cuenta('OPEN'), toEffect: cuenta('EFFECT_PENDING'),
      overdue: filas.filter((r) => solicitudVencida(r, ahora)).length,
      nextDeadlineAt: plazos[0]?.toISOString() ?? null,
    };
  }

  /** La constancia: lo que se le entrega (o se le dicta) al socio como prueba de que pidió algo y cuándo. */
  async constancia(organizationId: string, id: string) {
    const r = await new PrivacyRequestRepository(organizationId).findById(id);
    if (!r) throw notFound('Solicitud no encontrada');
    const [m, org] = await Promise.all([
      new MemberRepository(organizationId).findByIdIncludingArchived(r.memberId),
      new OrganizationRepository(organizationId).current(),
    ]);
    if (!m) throw notFound('Socio no encontrado');
    return {
      solicitud: r, socio: m,
      gym: { legalName: org?.legalName ?? '', tradeName: org?.tradeName ?? '' },
      deadlines: { answerBusinessDays: PLAZOS_ARCO.responder.habiles, effectBusinessDays: PLAZOS_ARCO.hacerEfectiva.habiles },
    };
  }

  /** El aviso al socio en su portal. `paso` distingue dos avisos del mismo tipo para la misma solicitud. */
  private async avisar(organizationId: string, r: PrivacyRequestRecord, kind: 'PRIVACY_REQUEST_RECEIVED' | 'PRIVACY_REQUEST_RESOLVED' | 'PRIVACY_REQUEST_DONE', title: string, body: string, paso = ''): Promise<void> {
    await new MemberNoticeRepository(organizationId).emit({
      memberId: r.memberId, kind, title, body: body.slice(0, 600), dedupeKey: `${kind}:${r.id}${paso ? `:${paso}` : ''}`,
    });
  }
}

const folio = (r: PrivacyRequestRecord) => folioDeSolicitud(r.id, r.receivedAt);
const pedido = (r: PrivacyRequestRecord) => TIPO_DE_SOLICITUD_ARCO_SOCIO[r.kind] ?? r.kind;

/** Un 422 que dice en qué campo, con la forma de los de validación: el formulario lo pinta donde toca. */
function campo(nombre: string, mensaje: string): ZodError {
  return new ZodError([{ code: 'custom', path: [nombre], message: mensaje, input: undefined }]);
}
