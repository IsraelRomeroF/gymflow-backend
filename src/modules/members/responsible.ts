import { z } from 'zod';
import { conflict, normalizePhoneMx, validation, type ResponsibleKind } from '@gymflow/core';
import type { MemberResponsible, MemberSharedPhone } from '@gymflow/core/contracts';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { nombrePersona } from '../../platform/http/person-name.js';
import { telefonoMx } from '../../platform/http/phone.js';

/**
 * EL RESPONSABLE (auditoría 8, fase 3, bloque 3.4; D-09 y D-10).
 *
 * Dos socios pueden tener el mismo celular (mamá e hija, hermanos). La base ya
 * no lo impide; lo que se exige es ANOTAR quién responde por ese número: el
 * propio socio (`SELF`), otro socio (`MEMBER`) o un adulto que no es socio
 * (`ADULT`, con su nombre). El mismo lugar guarda al tutor de un menor, que
 * firmó en el mostrador (`guardianSignedAt`).
 *
 * Compartir celular NO une a dos personas: cada quien tiene su ficha, su
 * código, su portal (que se activa con un código por socio, no con el
 * celular), sus cargos y sus avisos. La regla de identidad sigue siendo la de
 * `core/identity.ts`: celular + mismo nombre = la misma persona; celular +
 * otro nombre = comparten celular.
 */

export const responsibleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('SELF') }),
  z.object({ kind: z.literal('MEMBER'), memberId: z.string().uuid() }),
  z.object({ kind: z.literal('ADULT'), name: nombrePersona(120), phoneE164: telefonoMx().nullish() }),
]);
export type ResponsibleInput = z.infer<typeof responsibleSchema>;

/** El tutor que firma en el mostrador por un menor (D-10). */
export const guardianSchema = z.object({ name: nombrePersona(120), phoneE164: telefonoMx().nullish() });
export type GuardianInput = z.infer<typeof guardianSchema>;

/** Las columnas del responsable, listas para escribirse en `members`. */
export type ResponsibleColumns = {
  responsibleKind: ResponsibleKind | null;
  responsibleMemberId: string | null;
  responsibleName: string | null;
  responsiblePhoneE164: string | null;
  guardianSignedAt?: Date | null;
};

type Titular = { id: string; firstName: string; lastName: string; memberCode: string; status: string; responsibleKind: string | null; responsibleMemberId: string | null };

export class ResponsibleRepository extends TenantRepository {
  /** Los socios VIVOS que tienen ese celular (los dados de baja no cuentan: su número pudo cambiar de dueño). */
  async titulares(phoneE164: string, salvoId?: string | null): Promise<Titular[]> {
    return this.db.member.findMany({
      where: this.scope({ phoneE164, deletedAt: null, ...(salvoId ? { id: { not: salvoId } } : {}) }),
      select: { id: true, firstName: true, lastName: true, memberCode: true, status: true, responsibleKind: true, responsibleMemberId: true },
      orderBy: { createdAt: 'asc' }, take: 20,
    });
  }

  async de(memberId: string): Promise<(ResponsibleColumns & { phoneE164: string | null; guardianSignedAt: Date | null }) | null> {
    const r = await this.db.member.findFirst({
      where: this.scope({ id: memberId }),
      select: { phoneE164: true, responsibleKind: true, responsibleMemberId: true, responsibleName: true, responsiblePhoneE164: true, guardianSignedAt: true },
    });
    return r ? { ...r, responsibleKind: r.responsibleKind as ResponsibleKind | null } : null;
  }

  async escribir(memberId: string, c: ResponsibleColumns): Promise<void> {
    await this.db.member.updateMany({ where: this.scope({ id: memberId }), data: c });
  }

  /**
   * Un número, un responsable: a quienes comparten ese celular y todavía no
   * tienen a nadie anotado se les anota el mismo. Nunca pisa lo ya anotado.
   */
  async propagar(phoneE164: string, responsableId: string): Promise<void> {
    await this.db.member.updateMany({
      where: this.scope({ phoneE164, deletedAt: null, responsibleKind: null, id: { not: responsableId } }),
      data: { responsibleKind: 'MEMBER', responsibleMemberId: responsableId },
    });
    await this.db.member.updateMany({
      where: this.scope({ id: responsableId, responsibleKind: null }), data: { responsibleKind: 'SELF' },
    });
  }

  async nombres(ids: readonly string[]): Promise<Map<string, { fullName: string; memberCode: string; anonymized: boolean }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.member.findMany({
      where: this.scope({ id: { in: [...ids] } }), select: { id: true, firstName: true, lastName: true, memberCode: true, anonymizedAt: true },
    });
    return new Map(rows.map((r) => [r.id, { fullName: `${r.firstName} ${r.lastName}`, memberCode: r.memberCode, anonymized: !!r.anonymizedAt }]));
  }
}

const nombreDe = (t: { firstName: string; lastName: string; memberCode: string }) => `${t.firstName} ${t.lastName} (${t.memberCode})`.replace(/\s+\(/, ' (');

/**
 * Antes de escribir un celular en una ficha (alta, corrección, completar,
 * alta digital): si otro socio vivo ya lo tiene, se puede compartir, pero hay
 * que decir quién responde por el número. Devuelve las columnas a guardar, o
 * `undefined` si no hay nada que anotar (no comparte y no se dijo nada).
 *
 * `tutor`: un menor ya trae a su responsable (D-10); vale también para el celular.
 */
export async function prepararResponsable(
  organizationId: string,
  d: { phoneE164: string | null | undefined; responsible?: ResponsibleInput | null | undefined; guardian?: GuardianInput | null | undefined; memberId?: string | null; yaTiene?: boolean },
): Promise<ResponsibleColumns | undefined> {
  const phone = normalizePhoneMx(d.phoneE164);
  const repo = new ResponsibleRepository(organizationId);

  if (d.guardian) {
    const suTelefono = normalizePhoneMx(d.guardian.phoneE164);
    return {
      responsibleKind: 'ADULT', responsibleMemberId: null, responsibleName: d.guardian.name.trim(),
      // Si el tutor tiene el mismo celular que el menor, no se repite: es «el número que comparten».
      responsiblePhoneE164: suTelefono && suTelefono !== phone ? suTelefono : null,
      guardianSignedAt: new Date(),
    };
  }

  const otros = phone ? await repo.titulares(phone, d.memberId ?? null) : [];
  if (!d.responsible) {
    if (otros.length > 0 && !d.yaTiene) {
      throw conflict(
        `Ese celular ya es el de ${otros.map(nombreDe).join(' y ')}. Pueden compartirlo: anota quién es el responsable del número`,
        'PHONE_IN_USE',
      );
    }
    return undefined;
  }

  const r = d.responsible;
  if (r.kind === 'SELF') return { responsibleKind: 'SELF', responsibleMemberId: null, responsibleName: null, responsiblePhoneE164: null };
  if (r.kind === 'ADULT') {
    const suTelefono = normalizePhoneMx(r.phoneE164);
    return { responsibleKind: 'ADULT', responsibleMemberId: null, responsibleName: r.name.trim(), responsiblePhoneE164: suTelefono && suTelefono !== phone ? suTelefono : null };
  }
  // Otro socio: tiene que ser uno de los que comparten ese celular, no cualquiera del padrón.
  if (r.memberId === d.memberId) return { responsibleKind: 'SELF', responsibleMemberId: null, responsibleName: null, responsiblePhoneE164: null };
  if (!otros.some((t) => t.id === r.memberId)) {
    throw validation('El responsable tiene que ser un socio activo con ese mismo celular. Si es otra persona, anótala como adulto responsable');
  }
  return { responsibleKind: 'MEMBER', responsibleMemberId: r.memberId, responsibleName: null, responsiblePhoneE164: null };
}

/** Después de guardar: el número queda con un solo responsable para quienes no tenían ninguno. */
export async function asentarResponsable(organizationId: string, memberId: string, phoneE164: string | null | undefined, c: ResponsibleColumns | undefined): Promise<void> {
  const phone = normalizePhoneMx(phoneE164);
  if (!c || !phone) return;
  const repo = new ResponsibleRepository(organizationId);
  if (c.responsibleKind === 'SELF') await repo.propagar(phone, memberId);
  if (c.responsibleKind === 'MEMBER' && c.responsibleMemberId) await repo.propagar(phone, c.responsibleMemberId);
}

/** Lo que la ficha dice: «Comparte celular con…» y quién responde por el número. */
export async function celularCompartido(organizationId: string, memberId: string): Promise<Omit<MemberSharedPhone, 'hidden'> | null> {
  const repo = new ResponsibleRepository(organizationId);
  const yo = await repo.de(memberId);
  if (!yo) return null;
  const otros = yo.phoneE164 ? await repo.titulares(yo.phoneE164, memberId) : [];
  const sharedWith = otros.map((t) => ({ id: t.id, fullName: `${t.firstName} ${t.lastName}`.trim(), memberCode: t.memberCode, status: t.status }));

  let responsible: MemberResponsible | null = null;
  const firma = yo.guardianSignedAt ? yo.guardianSignedAt.toISOString() : null;
  if (yo.responsibleKind === 'MEMBER' && yo.responsibleMemberId) {
    const s = (await repo.nombres([yo.responsibleMemberId])).get(yo.responsibleMemberId);
    // Un responsable anonimizado ya no es nadie: vuelve a faltar.
    if (s && !s.anonymized) responsible = { kind: 'MEMBER', memberId: yo.responsibleMemberId, memberCode: s.memberCode, name: s.fullName, phoneE164: null, guardianSignedAt: firma };
  } else if (yo.responsibleKind === 'ADULT' && yo.responsibleName) {
    responsible = { kind: 'ADULT', memberId: null, memberCode: null, name: yo.responsibleName, phoneE164: yo.responsiblePhoneE164, guardianSignedAt: firma };
  } else if (yo.responsibleKind === 'SELF' || otros.some((t) => t.responsibleKind === 'MEMBER' && t.responsibleMemberId === memberId)) {
    responsible = { kind: 'SELF', memberId: null, memberCode: null, name: null, phoneE164: null, guardianSignedAt: null };
  }
  return { sharedWith, responsible, missingResponsible: sharedWith.length > 0 && !responsible };
}
