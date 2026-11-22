import {
  AUTO_MERGE_THRESHOLD, conflict, rankMatches, validation,
  type MatchResult, notFound } from '@gymflow/core';
import { ZodError } from 'zod';
import { BranchRepository } from '../organization/index.js';
import { ConsentRepository } from './consent.repository.js';
import { ConsentDocumentRepository } from './consent-document.repository.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { MemberRepository, type CreateMemberInput, type MemberRecord } from './member.repository.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { RequestContext } from '../../platform/context.js';

/** Lo más viejo que se acepta como antigüedad: un año mal tecleado ("0024", "1924") no pasa. */
const ANTIGUEDAD_MINIMA = '1950-01-01';

/** Un error de UN campo, con la forma de los de validación: el panel lo pone debajo de ese campo. */
function errorDeCampo(campo: string, mensaje: string): ZodError {
  return new ZodError([{ code: 'custom', path: [campo], message: mensaje, input: undefined }]);
}

/**
 * «¿Desde cuándo viene?» (ADR-029, D-11; 2-01 de la auditoría 8). El día de
 * calendario declarado se guarda como instante a las 18:00Z, mediodía en
 * CDMX, que cae en el mismo día en todo México (como el alta digital y la
 * importación). Nunca en el futuro: un "socio desde el mes que entra" no
 * significa nada, y si es hoy y aún no son las 18:00Z, se guarda ahora.
 */
export async function antiguedadDeclarada(organizationId: string, dia: string, branchId: string | null, campo = 'joinedAt', ahora = new Date()): Promise<Date> {
  const hoy = (await new BusinessCalendar(organizationId).today(branchId, ahora)).toISOString().slice(0, 10);
  if (dia > hoy) throw errorDeCampo(campo, 'No puede ser una fecha futura: ¿desde cuándo viene?');
  if (dia < ANTIGUEDAD_MINIMA) throw errorDeCampo(campo, 'Revisa el año: la antigüedad no puede ser anterior a 1950');
  const instante = new Date(`${dia}T18:00:00.000Z`);
  return instante.getTime() > ahora.getTime() ? ahora : instante;
}

/** El día de calendario de un instante en la zona de la sucursal (para comparar antigüedades). */
export async function diaDeNegocio(organizationId: string, instante: Date, branchId: string | null): Promise<string> {
  return (await new BusinessCalendar(organizationId).today(branchId, instante)).toISOString().slice(0, 10);
}

export type ConsentAtSignup = {
  consentType: string;
  documentVersion: string;
  documentText?: string | null | undefined;
  granted: boolean;
};

/**
 * De dónde viene la firma cuando NO se recogió en el mostrador.
 *
 * Lo usa el alta digital: el socio firmó en su teléfono, desde su IP y a su
 * hora. Registrar esa evidencia como si fuera asistida por recepción sería
 * falsear el único dato que importa el día de una reclamación.
 */
export type ExternalConsentEvidence = {
  channel: string;
  ip: string | null;
  userAgent: string | null;
  signedAt: Date;
};

export type CreateMemberResult =
  | { status: 'CREATED'; member: MemberRecord }
  | { status: 'DUPLICATES_FOUND'; candidates: MatchResult[] };

/** Consentimientos sin los cuales no se puede dar de alta a nadie. */
const REQUIRED_CONSENTS = ['PRIVACY_NOTICE', 'HOUSE_RULES'];

export class MemberService {
  private readonly audit = new AuditService();

  /**
   * Alta con deduplicación EN LÍNEA.
   *
   * Por defecto se detiene si encuentra un candidato: consolidar mal produce
   * dos fallos igual de graves —fusionar a dos personas distintas es un
   * incidente de privacidad; no fusionar a la misma persona le hace pagar
   * dos veces o perder su antigüedad (docs/09 §4).
   *
   * `force` permite continuar cuando una persona ya revisó y decidió que son
   * distintas; queda registrado en la auditoría.
   */
  async create(
    ctx: RequestContext,
    input: CreateMemberInput & {
      consents: ConsentAtSignup[];
      force?: boolean;
      consentEvidence?: ExternalConsentEvidence | undefined;
    },
  ): Promise<CreateMemberResult> {
    const orgId = ctx.tenant.organizationId;

    const missing = REQUIRED_CONSENTS.filter(
      (type) => !input.consents.some((c) => c.consentType === type && c.granted),
    );
    if (missing.length > 0) {
      throw validation(`Faltan consentimientos obligatorios: ${missing.join(', ')}`);
    }

    const members = new MemberRepository(orgId);

    if (!input.force) {
      const candidates = await members.findDuplicateCandidates(input);
      const matches = rankMatches(
        { id: 'nuevo', firstName: input.firstName, lastName: input.lastName,
          phoneE164: input.phoneE164 ?? null, email: input.email ?? null, curp: input.curp ?? null },
        candidates,
      );
      if (matches.length > 0) {
        return { status: 'DUPLICATES_FOUND', candidates: matches };
      }
    }

    // El código legible se numera por la sucursal habitual.
    let branchCode = 'GEN';
    if (input.homeBranchId) {
      const branch = await new BranchRepository(orgId).findById(input.homeBranchId);
      if (!branch) throw validation('La sucursal indicada no existe en esta organización');
      branchCode = branch.code;
    }

    // Una unidad: el socio, sus consentimientos y la bitácora se confirman
    // juntos. Un socio sin su aviso de privacidad firmado no debe existir ni
    // un instante (OPT3-05).
    return enUnaTransaccion(async () => {
    const member = await members.create(input, branchCode);

    const consents = new ConsentRepository(orgId);
    const textos = new ConsentDocumentRepository(orgId);
    for (const consent of input.consents) {
      await consents.record({
        memberId: member.id,
        branchId: input.homeBranchId ?? null,
        consentType: consent.consentType,
        documentVersion: consent.documentVersion,
        // El texto lo pone el servidor (PS-06): lo que mandó el cliente no es evidencia.
        // Una versión ya retirada solo vale si se firmó mientras estaba vigente (alta digital aprobada tarde; 21-06).
        documentText: await textos.textoParaFirmar(consent.consentType, consent.documentVersion, input.consentEvidence?.signedAt ?? null),
        granted: consent.granted,
        ip: input.consentEvidence?.ip ?? ctx.ip ?? null,
        userAgent: input.consentEvidence?.userAgent ?? ctx.userAgent ?? null,
        channel: input.consentEvidence?.channel ?? 'ASSISTED',
        grantedAt: input.consentEvidence?.signedAt ?? null,
        assistedByUserId: ctx.tenant.actorUserId ?? null,
      });
    }

    await this.audit.record(ctx, {
      action: 'member.create',
      resourceType: 'Member',
      resourceId: member.id,
      branchId: input.homeBranchId ?? null,
      afterState: {
        // Sin el nombre (SEC-08): la bitácora no se puede borrar, y un nombre
        // aquí sobreviviría a la anonimización. El código basta para rastrear.
        memberCode: member.memberCode,
        consents: input.consents.map((c) => `${c.consentType}@${c.documentVersion}`),
        forcedDespiteDuplicates: input.force === true,
      },
    });

    return { status: 'CREATED', member };
    });
  }

  async archive(ctx: RequestContext, memberId: string, reason: string): Promise<boolean> {
    const orgId = ctx.tenant.organizationId;
    const members = new MemberRepository(orgId);
    const before = await members.findById(memberId);
    if (!before) return false;

    const ok = await members.archive(memberId, ctx.tenant.actorUserId!, reason);
    if (ok) {
      await this.audit.record(ctx, {
        action: 'member.archive',
        resourceType: 'Member',
        resourceId: memberId,
        beforeState: { status: before.status },
        afterState: { status: 'ARCHIVED' },
        reason,
      });
    }
    return ok;
  }

  /** Un exsocio vuelve (PS-04): misma ficha, mismo código, misma historia. */
  async reactivate(ctx: RequestContext, memberId: string, reason: string): Promise<MemberRecord> {
    const orgId = ctx.tenant.organizationId;
    const members = new MemberRepository(orgId);
    const before = await members.findByIdIncludingArchived(memberId);
    if (!before) throw notFound('Socio no encontrado');
    if (before.status !== 'ARCHIVED') throw conflict('Ese socio no está dado de baja');
    if (before.anonymizedAt) throw conflict('Esa ficha fue anonimizada: ya no dice quién era. Hay que darlo de alta como socio nuevo');
    if (!await members.reactivate(memberId)) throw conflict('Ese socio ya estaba activo');

    await this.audit.record(ctx, {
      action: 'member.reactivate', resourceType: 'Member', resourceId: memberId,
      branchId: before.homeBranchId,
      beforeState: { status: 'ARCHIVED' }, afterState: { status: 'INACTIVE', memberCode: before.memberCode },
      reason,
    });
    return (await members.findById(memberId))!;
  }

  /** Solo informa; no crea nada. La usa el formulario de alta mientras se teclea. */
  async checkDuplicates(
    organizationId: string,
    input: {
      firstName: string; lastName: string;
      phoneE164?: string | null | undefined;
      email?: string | null | undefined;
      curp?: string | null | undefined;
    },
  ): Promise<MatchResult[]> {
    const candidates = await new MemberRepository(organizationId).findDuplicateCandidates(input);
    return rankMatches({ id: 'nuevo', ...input }, candidates);
  }

  static isBlocking(matches: MatchResult[]): boolean {
    return matches.some((m) => m.score >= AUTO_MERGE_THRESHOLD);
  }
}

export { conflict };
