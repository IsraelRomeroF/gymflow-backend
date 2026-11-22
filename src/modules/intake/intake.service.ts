import {
  consentGaps, notFound, reviewIntake, validateIntake, validation,
  normalizeEmail, normalizedNameKey, normalizePhoneMx, rankMatches, revisarMotivo,
  INTAKE_CORRECTABLE_FIELDS, SIGNUP_OPTIONAL_CONSENTS, SIGNUP_REQUIRED_CONSENTS,
  type AcceptedConsent, type ConsentDocument, type ConsentGap,
  type IntakeDraft, type MatchResult, conflict } from '@gymflow/core';
import type { IntakeFlag } from '@gymflow/core/contracts';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { ConsentRepository, MemberRepository, MemberService, MemberNoticeRepository } from '../members/index.js';
import { BranchRepository, OrganizationRepository } from '../organization/index.js';
import { ConsentDocumentRepository, type ConsentDocumentRecord } from '../members/index.js';
import { MembershipRepository } from '../memberships/index.js';
import { ProspectRepository, ProspectService } from '../prospects/index.js';
import { FollowUpRepository } from '../follow-ups/index.js';
import { IntakeRepository, type IntakeRecord } from './intake.repository.js';
import type { RequestContext } from '../../platform/context.js';

/**
 * Alta digital.
 *
 * El formulario es PÚBLICO —lo abre quien escanea el QR del mostrador— y por
 * eso no escribe en el padrón: escribe un borrador. La distinción es lo que
 * separa "trasladar la digitación al socio" de "dejar que cualquiera inserte
 * filas en `members`".
 */

export type IntakeForm = {
  /** Nombre comercial: el socio se da de alta en SU gimnasio, no en "GymFlow". */
  gymName: string;
  branchName: string;
  documents: Array<{ consentType: string; version: string; title: string; bodyText: string; required: boolean }>;
  /** Qué falta para poder recoger firmas. Vacío = el alta está operativa. */
  blockedBy: ConsentGap[];
};

export type IntakeReviewView = {
  intake: IntakeRecord;
  /** Con el socio de cada coincidencia ya resuelto (una consulta para todas; 9-15). */
  matches: Array<MatchResult & {
    fullName: string | null; memberCode: string | null; phoneE164: string | null; status: string | null;
    sharedPhone: boolean; hasMembership: boolean;
  }>;
  suggestion: 'AUTO_LINK' | 'NEEDS_REVIEW' | 'NEW_MEMBER';
  pendingFields: string[];
  /** El interesado abierto que es esta misma persona (10-10). */
  prospect: { id: string; branchId: string; source: string | null; status: string; followUps: number } | null;
  flags: IntakeFlag[];
};

/** Mismo celular y otro nombre: comparten celular, no son la misma persona (9-02). */
const comparteCelular = (m: MatchResult): boolean => m.method === 'PHONE' && m.score < 85;

const toDomainDoc = (d: ConsentDocumentRecord): ConsentDocument => ({
  consentType: d.consentType as ConsentDocument['consentType'],
  version: d.version,
  status: d.status,
  bodyText: d.bodyText,
  required: (SIGNUP_REQUIRED_CONSENTS as readonly string[]).includes(d.consentType),
});

/**
 * Lo que recepción completa o corrige del alta: solo los campos que cambia,
 * como texto (las fechas `AAAA-MM-DD`); `null` borra el dato. Es lo que se
 * guarda en el borrador sin aprobar (9-21) y lo que viaja al aprobar o vincular.
 */
export type CorreccionesAlta = Partial<Record<(typeof INTAKE_CORRECTABLE_FIELDS)[number], string | null>>;

const diaDe = (x: Date | null | undefined): string | null => (x ? x.toISOString().slice(0, 10) : null);
const aFecha = (x: string | null): Date | null => (x ? new Date(`${x}T00:00:00.000Z`) : null);

/** Lo que el socio envió, campo por campo y como texto: contra esto se compara una corrección. */
function original(intake: IntakeRecord): Record<(typeof INTAKE_CORRECTABLE_FIELDS)[number], string | null> {
  return {
    firstName: intake.firstName, lastName: intake.lastName, phoneE164: intake.phoneE164, email: intake.email,
    birthDate: diaDe(intake.birthDate), memberSince: diaDe(intake.memberSince),
    emergencyContactName: intake.emergencyContactName, emergencyContactPhone: intake.emergencyContactPhone,
  };
}

/**
 * Las correcciones que de verdad cambian algo: normalizadas (teléfono a
 * E.164, correo en minúsculas, vacío = `null`) y sin las que dejan el dato
 * igual que lo envió el socio. Nombre y apellidos no se pueden borrar.
 */
export function correccionesVigentes(intake: IntakeRecord, ...capas: Array<CorreccionesAlta | null | undefined>): CorreccionesAlta {
  const antes = original(intake);
  const juntas: CorreccionesAlta = Object.assign({}, ...capas.map((c) => c ?? {}));
  const out: CorreccionesAlta = {};
  for (const k of INTAKE_CORRECTABLE_FIELDS) {
    if (!(k in juntas)) continue;
    const crudo = juntas[k];
    let v: string | null = typeof crudo === 'string' ? crudo.trim() || null : null;
    if (v && (k === 'phoneE164' || k === 'emergencyContactPhone')) v = normalizePhoneMx(v);
    if (v && k === 'email') v = normalizeEmail(v);
    if ((k === 'firstName' || k === 'lastName') && !v) continue;
    if (v !== antes[k]) out[k] = v;
  }
  return out;
}

/** El alta como quedaría: lo que el socio envió con las correcciones encima. */
export function conCorrecciones(intake: IntakeRecord, c: CorreccionesAlta): {
  firstName: string; lastName: string; phoneE164: string | null; email: string | null; birthDate: Date | null;
  emergencyContactName: string | null; emergencyContactPhone: string | null; memberSince: Date | null;
} {
  const t = { ...original(intake), ...c };
  return {
    firstName: t.firstName ?? intake.firstName, lastName: t.lastName ?? intake.lastName, phoneE164: t.phoneE164, email: t.email,
    birthDate: aFecha(t.birthDate), emergencyContactName: t.emergencyContactName, emergencyContactPhone: t.emergencyContactPhone,
    memberSince: aFecha(t.memberSince),
  };
}

/** El antes y el después de cada corrección, para la bitácora. */
function antesYDespues(intake: IntakeRecord, c: CorreccionesAlta): Record<string, { antes: string | null; despues: string | null }> {
  const antes = original(intake);
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { antes: antes[k as keyof typeof antes], despues: v ?? null }]));
}

/** Las insignias de un alta (9-04), con lo que ya se sabe de socios e interesados con su mismo contacto. */
export function insignias(
  intake: IntakeRecord,
  conocidos: { socios: ReadonlyArray<{ phoneE164: string | null; email: string | null; nameKey: string }>; interesados: ReadonlyArray<{ phoneE164: string | null; email: string | null; nameKey: string }> },
): IntakeFlag[] {
  const c = correccionesVigentes(intake, intake.corrections);
  const d = conCorrecciones(intake, c);
  const nombre = normalizedNameKey(`${d.firstName} ${d.lastName}`);
  const mismoContacto = (x: { phoneE164: string | null; email: string | null }) =>
    (!!d.phoneE164 && x.phoneE164 === d.phoneE164) || (!!d.email && !!x.email && x.email.toLowerCase() === d.email);
  const socios = conocidos.socios.filter(mismoContacto);
  const flags: IntakeFlag[] = [];
  if (!d.birthDate) flags.push('MISSING_BIRTHDATE');
  if (!d.emergencyContactName) flags.push('MISSING_EMERGENCY');
  if (intake.healthNotes) flags.push('HEALTH_NOTE');
  if (socios.some((x) => x.nameKey === nombre)) flags.push('POSSIBLE_DUPLICATE');
  else if (socios.some((x) => !!d.phoneE164 && x.phoneE164 === d.phoneE164)) flags.push('SHARED_PHONE');
  if (conocidos.interesados.some((x) => mismoContacto(x) && x.nameKey === nombre)) flags.push('WAS_PROSPECT');
  if (d.memberSince) flags.push('RETURNING');
  if (Object.keys(c).length > 0) flags.push('CORRECTED');
  return flags;
}

export class IntakeService {
  private readonly audit = new AuditService();

  /**
   * Lo que ve el teléfono del socio.
   *
   * `blockedBy` no es decoración: mientras los textos sigan en borrador, esto
   * lo dice en voz alta en vez de dejar que alguien recoja 1,500 firmas sobre
   * documentos que todavía pueden cambiar.
   */
  async form(orgId: string, branchId: string): Promise<IntakeForm> {
    const branch = await new BranchRepository(orgId).findById(branchId);
    if (!branch) throw notFound('Sucursal no encontrada');

    const docs = await new ConsentDocumentRepository(orgId).listPublished();
    const visibles = docs.filter(
      (d) => (SIGNUP_REQUIRED_CONSENTS as readonly string[]).includes(d.consentType)
        || (SIGNUP_OPTIONAL_CONSENTS as readonly string[]).includes(d.consentType),
    );

    const org = await new OrganizationRepository(orgId).current();
    return {
      gymName: org?.tradeName ?? '',
      branchName: branch.name,
      documents: visibles.map((d) => ({
        consentType: d.consentType,
        version: d.version,
        title: d.title,
        bodyText: d.bodyText,
        required: (SIGNUP_REQUIRED_CONSENTS as readonly string[]).includes(d.consentType),
      })),
      blockedBy: consentGaps(
        visibles.map(toDomainDoc),
        SIGNUP_REQUIRED_CONSENTS.map((t) => ({ consentType: t, version: '', granted: true })),
      ).filter((g) => g.kind !== 'STALE_VERSION'),
    };
  }

  async submit(
    orgId: string,
    input: {
      branchId: string;
      draft: IntakeDraft;
      accepted: readonly AcceptedConsent[];
      ip: string | null;
      userAgent: string | null;
      /** Altas sin revisar que admite la sucursal antes de cerrar el formulario (PS-09). */
      maxPendientes: number;
    },
  ): Promise<IntakeRecord> {
    const branch = await new BranchRepository(orgId).findById(input.branchId);
    if (!branch) throw notFound('Sucursal no encontrada');

    // El formulario es público: con el enlace cualquiera puede mandar altas.
    // El límite por teléfono frena a uno; este tope frena a muchos (PS-09). La
    // bandeja que no se revisa no crece sin fin. Va antes que todo lo demás, y
    // solo cuenta para un alta NUEVA: quien reenvía la suya (9-18) no suma otra.
    const bandeja = new IntakeRepository(orgId);
    if (await bandeja.pendingCount([input.branchId]) >= input.maxPendientes) {
      const laSuya = await bandeja.findPendingOfSamePerson(input.branchId, {
        firstName: String(input.draft.firstName ?? ''), lastName: String(input.draft.lastName ?? ''),
        phoneE164: normalizePhoneMx(input.draft.phone), email: normalizeEmail(input.draft.email),
      });
      if (!laSuya) throw conflict('Esta sucursal tiene demasiadas altas por revisar. Pasa a recepción y te dan de alta ahí');
    }

    const hoy = await new BusinessCalendar(orgId).today(input.branchId);
    const errors = validateIntake(input.draft, hoy);
    if (errors.length > 0) {
      throw validation(errors[0]!.message, JSON.stringify(errors));
    }

    const docs = await new ConsentDocumentRepository(orgId).listAll();
    const gaps = consentGaps(docs.map(toDomainDoc), input.accepted);
    if (gaps.length > 0) {
      throw validation('Faltan consentimientos obligatorios', JSON.stringify(gaps));
    }

    const byKey = new Map(docs.map((d) => [`${d.consentType}:${d.version}`, d.id]));
    // También los opcionales (salud, marketing): una versión que no existe
    // dejaría la firma sin texto (PS-06).
    const desconocidos = input.accepted.filter((a) => a.granted && !byKey.has(`${a.consentType}:${a.version}`));
    if (desconocidos.length > 0) {
      throw validation(`Versión desconocida del texto ${desconocidos[0]!.consentType} (${desconocidos[0]!.version})`);
    }

    const repo = new IntakeRepository(orgId);
    const datos = {
      firstName: input.draft.firstName.trim(),
      lastName: input.draft.lastName.trim(),
      phoneE164: normalizePhoneMx(input.draft.phone),
      email: normalizeEmail(input.draft.email),
      birthDate: input.draft.birthDate,
      emergencyContactName: input.draft.emergencyContactName,
      emergencyContactPhone: normalizePhoneMx(input.draft.emergencyContactPhone),
      memberSince: input.draft.memberSince,
      // Sin consentimiento HEALTH_DATA la nota de salud NO se guarda: se
      // pidió permiso para ese dato y no se dio.
      healthNotes: input.accepted.some((c) => c.consentType === 'HEALTH_DATA' && c.granted)
        ? input.draft.healthNotes : null,
      acceptedConsents: input.accepted.map((a) => ({
        consentType: a.consentType,
        version: a.version,
        granted: a.granted,
        documentId: byKey.get(`${a.consentType}:${a.version}`) ?? '',
      })),
      ip: input.ip,
      userAgent: input.userAgent,
    };
    // El mismo celular Y el mismo nombre con un borrador sin revisar en esta sede: se actualiza ese (9-18).
    const suyo = await repo.findPendingOfSamePerson(input.branchId, datos);
    if (suyo) {
      const actualizado = await repo.resubmit(suyo, datos);
      // Si alguien la revisó en ese instante, lo que llega es un alta nueva.
      if (actualizado) return actualizado;
    }
    return repo.create({ branchId: input.branchId, ...datos });
  }

  /** La pantalla de revisión: el borrador, lo corregido encima y sus posibles duplicados, juntos. */
  async review(orgId: string, id: string): Promise<IntakeReviewView> {
    const repo = new IntakeRepository(orgId);
    const intake = await repo.findById(id);
    if (!intake) throw notFound('Alta no encontrada');

    // Todo se calcula sobre lo que se va a aprobar: lo enviado con lo corregido encima (9-21).
    const d = conCorrecciones(intake, correccionesVigentes(intake, intake.corrections));
    const candidates = await new MemberRepository(orgId).findDuplicateCandidates({
      firstName: d.firstName, lastName: d.lastName, phoneE164: d.phoneE164, email: d.email,
    });

    const draft: IntakeDraft = { ...toDraft(intake), firstName: d.firstName, lastName: d.lastName, phone: d.phoneE164, email: d.email, birthDate: d.birthDate };
    const r = reviewIntake(draft, candidates);
    const encontrados = r.matches.length > 0
      ? [...r.matches]
      : rankMatches(
        { id: 'intake', firstName: d.firstName, lastName: d.lastName, phoneE164: d.phoneE164, email: d.email, curp: null },
        candidates,
      );
    const ids = encontrados.map((m) => m.candidateId);
    const [socios, membresias] = await Promise.all([repo.sociosPorId(ids), new MembershipRepository(orgId).findLiveForMembers(ids)]);
    const matches = encontrados.map((m) => {
      const socio = socios.get(m.candidateId);
      return {
        ...m, fullName: socio?.fullName ?? null, memberCode: socio?.memberCode ?? null, phoneE164: socio?.phoneE164 ?? null, status: socio?.status ?? null,
        sharedPhone: comparteCelular(m), hasMembership: membresias.has(m.candidateId),
      };
    });

    const pendingFields: string[] = [];
    if (!d.birthDate) pendingFields.push('birthDate');
    if (!d.memberSince) pendingFields.push('memberSince');
    if (!d.emergencyContactName) pendingFields.push('emergencyContactName');

    // ¿Era un interesado? Mismo celular o correo y mismo nombre (10-10).
    const nombre = normalizedNameKey(`${d.firstName} ${d.lastName}`);
    const abierto = intake.status === 'SUBMITTED'
      ? (await new ProspectRepository(orgId).findOpenByContact(d.phoneE164, d.email)).find((p) => p.nameKey === nombre) : undefined;
    const prospect = abierto ? {
      id: abierto.id, branchId: abierto.branchId, source: abierto.source, status: abierto.status,
      followUps: (await new FollowUpRepository(orgId).latest('prospect', [abierto.id])).get(abierto.id)?.count ?? 0,
    } : null;

    const conocidos = await repo.contactosConocidos(d.phoneE164 ? [d.phoneE164] : [], d.email ? [d.email] : []);
    return { intake, matches, suggestion: r.outcome, pendingFields, prospect, flags: insignias(intake, conocidos) };
  }

  /** Las insignias de toda una página de la bandeja, con dos consultas (no una por alta). */
  async flagsFor(orgId: string, intakes: readonly IntakeRecord[]): Promise<Map<string, IntakeFlag[]>> {
    const efectivos = intakes.map((i) => conCorrecciones(i, correccionesVigentes(i, i.corrections)));
    const conocidos = await new IntakeRepository(orgId).contactosConocidos(
      [...new Set(efectivos.map((d) => d.phoneE164).filter((x): x is string => !!x))],
      [...new Set(efectivos.map((d) => d.email).filter((x): x is string => !!x))],
    );
    return new Map(intakes.map((i) => [i.id, insignias(i, conocidos)]));
  }

  /**
   * «Guardar sin aprobar» (9-21): lo corregido queda en el borrador, con
   * quién y cuándo, y otra persona puede terminar la revisión. El envío
   * original no se toca. Sin cambios reales (o con `null`) se descarta lo guardado.
   */
  async saveCorrections(ctx: RequestContext, id: string, corrections: CorreccionesAlta | null): Promise<IntakeRecord> {
    const orgId = ctx.tenant.organizationId;
    const repo = new IntakeRepository(orgId);
    const intake = await repo.findById(id);
    if (!intake) throw notFound('Alta no encontrada');
    if (intake.status !== 'SUBMITTED') throw await this.yaRevisada(repo, intake);
    const c = corrections ? correccionesVigentes(intake, corrections) : {};
    await this.validarCorregido(orgId, intake, c);
    return enUnaTransaccion(async () => {
      if (!await repo.saveCorrections(id, Object.keys(c).length > 0 ? c as Record<string, string | null> : null, ctx.tenant.actorUserId ?? null)) {
        throw await this.yaRevisada(repo, (await repo.findById(id)) ?? intake);
      }
      // Qué campos, sin sus valores: la bitácora no se borra y esto todavía no es un socio (SEC-08).
      await this.audit.record(ctx, {
        action: 'intake.correct', resourceType: 'member_intake', resourceId: id, branchId: intake.branchId,
        afterState: { campos: Object.keys(c) },
      });
      return (await repo.findById(id))!;
    });
  }

  /** Lo corregido tiene que seguir siendo un alta válida: con contacto, con edad y sin fechas futuras. */
  private async validarCorregido(orgId: string, intake: IntakeRecord, c: CorreccionesAlta): Promise<void> {
    if (Object.keys(c).length === 0) return;
    const d = conCorrecciones(intake, c);
    const hoy = await new BusinessCalendar(orgId).today(intake.branchId);
    const errores = validateIntake({ ...toDraft(intake), firstName: d.firstName, lastName: d.lastName, phone: d.phoneE164, email: d.email, birthDate: d.birthDate, emergencyContactPhone: d.emergencyContactPhone, memberSince: d.memberSince }, hoy)
      // La edad mínima es del formulario en línea; en el mostrador decide recepción con la persona delante.
      .filter((e) => !(e.field === 'birthDate' && /mayores de/.test(e.message)));
    if (errores.length > 0) throw validation(errores[0]!.message.replace('para contactarte', 'para contactarle'), JSON.stringify(errores));
  }

  /** Otra persona ya la decidió: se dice quién (9-20). */
  private async yaRevisada(repo: IntakeRepository, intake: IntakeRecord) {
    const quien = intake.reviewedByUserId ? (await repo.staffNames([intake.reviewedByUserId])).get(intake.reviewedByUserId) : null;
    const que = intake.status === 'APPROVED' ? 'aprobó' : 'rechazó';
    return conflict(quien ? `${quien.split(' ')[0]} ya ${que} esta alta` : intake.status === 'REJECTED' ? 'Esa alta ya se cerró sin aprobar' : 'Esa alta ya fue revisada', 'INTAKE_ALREADY_REVIEWED');
  }

  /**
   * Celular compartido (9-02). Dos socios activos todavía no pueden tener el
   * mismo celular (lo decide D-09, fase 3): en vez del 409 genérico de la
   * base, se dice de quién es y qué hacer.
   */
  private async exigirCelularLibre(orgId: string, phoneE164: string | null, salvoMemberId?: string): Promise<void> {
    if (!phoneE164) return;
    const socios = new MemberRepository(orgId);
    if (!await socios.isPhoneTaken(phoneE164)) return;
    for (const c of await socios.findDuplicateCandidates({ firstName: '', lastName: '', phoneE164 })) {
      if (c.phoneE164 !== phoneE164 || c.id === salvoMemberId) continue;
      const socio = await socios.findById(c.id);
      if (!socio) continue;
      throw conflict(
        `Ese celular ya es el de ${socio.firstName} ${socio.lastName} (${socio.memberCode}). Dos socios todavía no pueden compartir celular: en «Corregir o completar» pon otro celular o déjalo vacío y usa su correo`,
        'PHONE_IN_USE',
      );
    }
  }

  /**
   * Aprobar: el borrador se convierte en socio y la firma se archiva con SU
   * sello de tiempo, no con el de la aprobación.
   *
   * Es UNA operación (9-20): se toma el alta (bloqueo de su fila), se crea al
   * socio, se marca aprobada, se convierte al interesado que era la misma
   * persona (10-10) y se asienta; o no pasa nada de eso.
   *
   * Si entretanto se publicó una versión nueva de algún documento, el alta NO
   * se bloquea: el socio firmó lo que se le enseñó, y eso es un hecho. Lo que
   * se devuelve es qué habrá que volver a pedirle.
   */
  async approve(
    ctx: RequestContext,
    id: string,
    opts: { force?: boolean; corrections?: CorreccionesAlta } = {},
  ): Promise<{ memberId: string; memberCode: string; pendingReconsent: string[]; convertedProspectId: string | null }> {
    const orgId = ctx.tenant.organizationId;
    const repo = new IntakeRepository(orgId);
    const docs = await new ConsentDocumentRepository(orgId).listAll();
    const byId = new Map(docs.map((d) => [d.id, d]));

    return enUnaTransaccion(async () => {
      const intake = await repo.claim(id);
      if (!intake) throw notFound('Alta no encontrada');
      if (intake.status !== 'SUBMITTED') throw await this.yaRevisada(repo, intake);

      // Recepción completa o corrige lo que el socio escribió (2026-10-09). El
      // alta original NO se toca: es la evidencia de lo que el socio envió; las
      // correcciones (las guardadas y las de este momento) van a la ficha y
      // quedan en la bitácora con su antes y después.
      const c = correccionesVigentes(intake, intake.corrections, opts.corrections);
      await this.validarCorregido(orgId, intake, c);
      const d = conCorrecciones(intake, c);
      const corregido = antesYDespues(intake, c);
      // «Es otra persona»: si el celular es de otro socio activo, se explica (9-02).
      if (opts.force) await this.exigirCelularLibre(orgId, d.phoneE164);

      const result = await new MemberService().create(ctx, {
        firstName: d.firstName,
        lastName: d.lastName,
        phoneE164: d.phoneE164,
        email: d.email,
        birthDate: d.birthDate,
        homeBranchId: intake.branchId,
        // Antes se perdían: la antigüedad declarada (ADR-029) y el contacto de
        // emergencia se capturaban y no llegaban al socio; la nota de salud
        // acababa en `notes`, sin el permiso que la protege.
        emergencyContactName: d.emergencyContactName,
        emergencyContactPhone: d.emergencyContactPhone,
        // `memberSince` es un día de calendario y `joinedAt` un instante: a
        // medianoche UTC sería el día anterior en México. Mediodía en CDMX cae
        // en el mismo día en todas las zonas del país.
        joinedAt: d.memberSince
          ? new Date(`${d.memberSince.toISOString().slice(0, 10)}T18:00:00.000Z`) : null,
        healthNotes: intake.acceptedConsents.some((x) => x.consentType === 'HEALTH_DATA' && x.granted)
          ? intake.healthNotes : null,
        createdByUserId: ctx.tenant.actorUserId ?? '',
        force: opts.force ?? false,
        consents: intake.acceptedConsents.map((x) => ({
          consentType: x.consentType,
          documentVersion: x.version,
          // El TEXTO exacto que vio. Sin él la evidencia es una afirmación.
          documentText: byId.get(x.documentId)?.bodyText ?? null,
          granted: x.granted,
        })),
        consentEvidence: {
          channel: 'SELF_SERVICE',
          ip: intake.ip,
          userAgent: intake.userAgent,
          signedAt: intake.submittedAt,
        },
      });

      if (result.status === 'DUPLICATES_FOUND') {
        throw validation(
          'El alta coincide con socios existentes. Revisa y confirma antes de aprobar.',
          JSON.stringify(result.candidates),
        );
      }

      if (!await repo.approve(id, result.member.id, ctx.tenant.actorUserId ?? null)) throw await this.yaRevisada(repo, (await repo.findById(id)) ?? intake);

      const convertedProspectId = await new ProspectService().convertirPorIdentidad(ctx, {
        memberId: result.member.id, firstName: d.firstName, lastName: d.lastName, phoneE164: d.phoneE164, email: d.email,
      });

      const pendingReconsent = consentGaps(
        docs.map(toDomainDoc),
        intake.acceptedConsents.map((x) => ({
          consentType: x.consentType as AcceptedConsent['consentType'],
          version: x.version,
          granted: x.granted,
        })),
      ).filter((g) => g.kind === 'STALE_VERSION').map((g) => g.consentType);

      // El socio sabe que su alta quedó (PS-03): lo verá en cuanto active el portal.
      await new MemberNoticeRepository(orgId).emit({
        memberId: result.member.id, kind: 'INTAKE_APPROVED', dedupeKey: `INTAKE_APPROVED:${id}`,
        title: 'Tu alta quedó aprobada', body: `Ya eres socio con el número ${result.member.memberCode}. Bienvenido.`,
      });

      // La bitácora, al final de la unidad (OPT2-14).
      await this.audit.record(ctx, {
        action: 'intake.approve',
        resourceType: 'member_intake',
        resourceId: id,
        branchId: intake.branchId,
        afterState: {
          memberId: result.member.id, memberCode: result.member.memberCode,
          ...(Object.keys(corregido).length ? { corregido } : {}), ...(convertedProspectId ? { prospectId: convertedProspectId } : {}),
        },
      });

      return { memberId: result.member.id, memberCode: result.member.memberCode, pendingReconsent, convertedProspectId };
    });
  }

  /**
   * "Es la misma persona": el alta digital se ata a una ficha que YA existe.
   *
   * Es el caso del exsocio que vuelve. Antes la única salida segura era
   * rechazar el alta y recapturar todo en el mostrador, perdiendo las firmas
   * que hizo desde su teléfono. Ahora sus datos de contacto se actualizan con
   * lo que acaba de escribir y sus consentimientos se registran en la ficha
   * con la evidencia original (canal, IP y hora de la firma).
   *
   * En UNA operación (9-03): antes eran tres escrituras sueltas y, si la
   * última fallaba, la ficha ya había quedado tocada. Lleva también lo que
   * recepción corrigió y la nota de salud, si dio su consentimiento.
   */
  async link(
    ctx: RequestContext, id: string, memberId: string, opts: { corrections?: CorreccionesAlta } = {},
  ): Promise<{ memberId: string; memberCode: string; pendingReconsent: string[]; convertedProspectId: string | null }> {
    const orgId = ctx.tenant.organizationId;
    const repo = new IntakeRepository(orgId);
    const members = new MemberRepository(orgId);

    return enUnaTransaccion(async () => {
      const intake = await repo.claim(id);
      if (!intake) throw notFound('Alta no encontrada');
      if (intake.status !== 'SUBMITTED') throw await this.yaRevisada(repo, intake);

      let socio = await members.findByIdIncludingArchived(memberId);
      if (!socio) throw notFound('Socio no encontrado');
      // Un exsocio que llena el alta digital vuelve con su ficha (PS-04).
      if (socio.status === 'ARCHIVED') {
        socio = await new MemberService().reactivate(ctx, memberId, 'Volvió por el alta digital');
      }

      const c = correccionesVigentes(intake, intake.corrections, opts.corrections);
      await this.validarCorregido(orgId, intake, c);
      const d = conCorrecciones(intake, c);
      const corregido = antesYDespues(intake, c);
      if (d.phoneE164 && d.phoneE164 !== socio.phoneE164) await this.exigirCelularLibre(orgId, d.phoneE164, memberId);
      const conSalud = intake.acceptedConsents.some((x) => x.consentType === 'HEALTH_DATA' && x.granted) && !!intake.healthNotes;

      // Lo que acaba de escribir es lo más reciente; lo que no dio, se conserva.
      // El nombre de la ficha no se cambia desde aquí: «es esta persona» ya lo dice.
      await members.update(memberId, {
        ...(d.phoneE164 ? { phoneE164: d.phoneE164 } : {}),
        ...(d.email ? { email: d.email } : {}),
        ...(d.birthDate && !socio.birthDate ? { birthDate: d.birthDate } : {}),
        ...(d.emergencyContactName ? { emergencyContactName: d.emergencyContactName } : {}),
        ...(d.emergencyContactPhone ? { emergencyContactPhone: d.emergencyContactPhone } : {}),
        // La nota de salud llega a la ficha con su consentimiento (antes se firmaba el permiso y la nota se perdía).
        ...(conSalud ? { healthNotes: intake.healthNotes } : {}),
      });

      const textos = new ConsentDocumentRepository(orgId);
      const consentimientos = new ConsentRepository(orgId);
      for (const x of intake.acceptedConsents) {
        await consentimientos.record({
          memberId,
          branchId: intake.branchId,
          consentType: x.consentType,
          documentVersion: x.version,
          // El texto lo pone el servidor, y una versión retirada solo vale si se firmó en su periodo (PS-06, 21-06).
          documentText: await textos.textoParaFirmar(x.consentType, x.version, intake.submittedAt),
          granted: x.granted,
          ip: intake.ip,
          userAgent: intake.userAgent,
          channel: 'SELF_SERVICE',
          grantedAt: intake.submittedAt,
        });
      }

      if (!await repo.approve(id, memberId, ctx.tenant.actorUserId ?? null)) throw await this.yaRevisada(repo, (await repo.findById(id)) ?? intake);
      // Era un interesado: con el nombre del alta o con el de la ficha (10-07, 10-10).
      const prospectos = new ProspectService();
      const convertedProspectId = await prospectos.convertirPorIdentidad(ctx, { memberId, firstName: d.firstName, lastName: d.lastName, phoneE164: d.phoneE164, email: d.email })
        ?? await prospectos.convertirPorIdentidad(ctx, { memberId, firstName: socio.firstName, lastName: socio.lastName, phoneE164: d.phoneE164 ?? socio.phoneE164, email: d.email ?? socio.email });

      const docs = await textos.listAll();
      const pendingReconsent = consentGaps(
        docs.map(toDomainDoc),
        intake.acceptedConsents.map((x) => ({ consentType: x.consentType as AcceptedConsent['consentType'], version: x.version, granted: x.granted })),
      ).filter((g) => g.kind === 'STALE_VERSION').map((g) => g.consentType);

      await this.audit.record(ctx, {
        action: 'intake.link',
        resourceType: 'member_intake',
        resourceId: id,
        branchId: intake.branchId,
        afterState: {
          memberId, memberCode: socio.memberCode, ...(conSalud ? { healthNotes: true } : {}),
          ...(Object.keys(corregido).length ? { corregido } : {}), ...(convertedProspectId ? { prospectId: convertedProspectId } : {}),
        },
      });
      return { memberId, memberCode: socio.memberCode, pendingReconsent, convertedProspectId };
    });
  }

  /**
   * Rechazar, con motivo. `reasonCode` es uno de `rechazarAlta` (los chips);
   * sin código, vale el texto escrito, como antes.
   */
  async reject(ctx: RequestContext, id: string, reason: string, reasonCode?: string): Promise<void> {
    let motivo = reason.trim();
    if (reasonCode) {
      const r = revisarMotivo('rechazarAlta', { codigo: reasonCode, nota: reason });
      if (!r.ok) throw validation(r.error);
      motivo = r.texto;
    }
    if (!motivo) throw validation('Rechazar un alta exige un motivo');
    const orgId = ctx.tenant.organizationId;
    const repo = new IntakeRepository(orgId);
    const intake = await repo.findById(id);
    if (!intake) throw notFound('Alta no encontrada');
    await enUnaTransaccion(async () => {
      if (!await repo.reject(id, ctx.tenant.actorUserId ?? null, motivo)) throw await this.yaRevisada(repo, (await repo.findById(id)) ?? intake);
      // Con su sucursal: el filtro por sede de la Bitácora ya encuentra los rechazos (9-15).
      await this.audit.record(ctx, {
        action: 'intake.reject',
        resourceType: 'member_intake',
        resourceId: id,
        branchId: intake.branchId,
        reason: motivo,
        ...(reasonCode ? { afterState: { reasonCode } } : {}),
      });
    });
  }
}

function toDraft(intake: IntakeRecord): IntakeDraft {
  return {
    firstName: intake.firstName,
    lastName: intake.lastName,
    phone: intake.phoneE164,
    email: intake.email,
    birthDate: intake.birthDate,
    emergencyContactName: intake.emergencyContactName,
    emergencyContactPhone: intake.emergencyContactPhone,
    memberSince: intake.memberSince,
    healthNotes: intake.healthNotes,
  };
}
