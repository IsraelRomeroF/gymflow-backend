import {
  matchIdentity, normalizedNameKey, normalizeEmail, normalizePhoneMx, rankMatches, REVIEW_THRESHOLD,
  type IdentityCandidate, type IdentityKind, type MatchResult,
} from '@gymflow/core';
import type { IdentityMatch } from '@gymflow/core/contracts';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { MemberRepository } from './member.repository.js';

/**
 * EL BUSCADOR DE IDENTIDAD ÚNICO (auditoría 8, fase 2, bloque 2.4).
 *
 * «¿Ya existe?» se preguntaba en cuatro puertas (Nuevo prospecto, Nuevo socio,
 * aprobar un alta y la clase suelta a un visitante) y cada una miraba solo su
 * tabla: recepción registraba como interesado a quien ya era socio, y daba de
 * alta en el mostrador a quien acababa de llenar el QR. Una sola búsqueda por
 * celular, correo y nombre sobre socios, exsocios, interesados abiertos y
 * altas por revisar, con la misma regla de parecido (`matchIdentity`):
 *
 *  - el celular solo nunca une: celular + mismo nombre = la misma persona;
 *    celular + otro nombre = comparten celular (`sharedPhone`);
 *  - de un interesado o un alta de otra sede solo se avisa (`id: null`).
 *
 * Vive en `members` porque amplía `POST /members/check-duplicates`. Lee
 * `prospects` y `member_intakes` SOLO PARA BUSCAR (no escribe en ellas):
 * esos módulos ya consumen a `members`, y pedírselo a ellos cerraría un círculo.
 */

type Fila = { id: string; firstName: string; lastName: string; phoneE164: string | null; email: string | null; branchId: string; status: string };

class IdentitySearchRepository extends TenantRepository {
  /** Interesados abiertos con ese celular, ese correo o un nombre parecido. */
  async interesados(nameKey: string, phone: string | null, email: string | null): Promise<Fila[]> {
    return this.db.$queryRaw<Fila[]>`
      SELECT id, "firstName", "lastName", "phoneE164", email, "branchId", status::text AS status
        FROM prospects
       WHERE "organizationId" = ${this.organizationId}::uuid
         AND status NOT IN ('CONVERTED', 'LOST')
         AND (
           (${nameKey} <> '' AND "nameKey" % ${nameKey})
           OR (${phone}::text IS NOT NULL AND "phoneE164" = ${phone})
           OR (${email}::text IS NOT NULL AND lower(email) = ${email})
         )
       ORDER BY (${phone}::text IS NOT NULL AND "phoneE164" = ${phone}) DESC, "createdAt" DESC
       LIMIT 15`;
  }

  /** Altas digitales por revisar con ese celular, ese correo o un nombre parecido. */
  async altas(nameKey: string, phone: string | null, email: string | null, salvoId: string | null): Promise<Fila[]> {
    return this.db.$queryRaw<Fila[]>`
      SELECT id, "firstName", "lastName", "phoneE164", email, "branchId", status::text AS status
        FROM member_intakes
       WHERE "organizationId" = ${this.organizationId}::uuid
         AND status = 'SUBMITTED'
         AND (${salvoId}::uuid IS NULL OR id <> ${salvoId}::uuid)
         AND (
           (${nameKey} <> '' AND "nameKey" % ${nameKey})
           OR (${phone}::text IS NOT NULL AND "phoneE164" = ${phone})
           OR (${email}::text IS NOT NULL AND lower(email) = ${email})
         )
       ORDER BY (${phone}::text IS NOT NULL AND "phoneE164" = ${phone}) DESC, "submittedAt" DESC
       LIMIT 15`;
  }

  /** Código, estado y sede de los socios encontrados, en una consulta (también los dados de baja). */
  async socios(ids: readonly string[]): Promise<Map<string, { fullName: string; memberCode: string; status: string; homeBranchId: string | null; phoneE164: string | null }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.member.findMany({
      where: this.scope({ id: { in: [...ids] } }),
      select: { id: true, firstName: true, lastName: true, memberCode: true, status: true, homeBranchId: true, phoneE164: true },
    });
    return new Map(rows.map((r) => [r.id, { fullName: `${r.firstName} ${r.lastName}`, memberCode: r.memberCode, status: r.status, homeBranchId: r.homeBranchId, phoneE164: r.phoneE164 }]));
  }
}

export type IdentityInput = {
  firstName?: string | undefined; lastName?: string | undefined;
  phoneE164?: string | null | undefined; email?: string | null | undefined; curp?: string | null | undefined;
};

/** Quién de quien pregunta puede abrir qué: lo decide la ruta, con sus permisos. */
export type PuedeAbrir = (kind: IdentityKind, branchId: string | null) => boolean;

/**
 * Sin nombre todavía (en «Nuevo prospecto» el celular va primero): el parecido
 * no puede decir «nombres distintos»; solo se sabe que el contacto coincide.
 */
function soloContacto(entrante: IdentityCandidate, existente: IdentityCandidate): MatchResult {
  const base = { candidateId: existente.id };
  if (entrante.phoneE164 && existente.phoneE164 === entrante.phoneE164) return { ...base, score: 70, method: 'PHONE', action: 'REVIEW', explanation: 'Mismo celular' };
  if (entrante.email && existente.email && existente.email.toLowerCase() === entrante.email) return { ...base, score: 70, method: 'EMAIL', action: 'REVIEW', explanation: 'Mismo correo' };
  return { ...base, score: 0, method: 'NONE', action: 'DISTINCT', explanation: 'Sin coincidencia' };
}

export async function buscarIdentidad(
  organizationId: string, input: IdentityInput, opts: { puedeAbrir: PuedeAbrir; excludeIntakeId?: string | null | undefined },
): Promise<{ candidates: MatchResult[]; people: IdentityMatch[] }> {
  const firstName = input.firstName?.trim() ?? '';
  const lastName = input.lastName?.trim() ?? '';
  const conNombre = `${firstName}${lastName}`.length >= 2;
  const phone = normalizePhoneMx(input.phoneE164);
  const email = normalizeEmail(input.email);
  const nameKey = conNombre ? normalizedNameKey(`${firstName} ${lastName}`) : '';
  const entrante: IdentityCandidate = { id: 'nuevo', firstName, lastName, phoneE164: phone, email, curp: input.curp ?? null };
  const comparar = (c: IdentityCandidate): MatchResult => (conNombre ? matchIdentity(entrante, c) : soloContacto(entrante, c));
  const mismoCelular = (m: MatchResult) => conNombre && m.method === 'PHONE' && m.score < 85;

  const repo = new IdentitySearchRepository(organizationId);
  const [deSocios, interesados, altas] = await Promise.all([
    new MemberRepository(organizationId).findDuplicateCandidates({ firstName, lastName, phoneE164: phone, email, curp: input.curp }),
    repo.interesados(nameKey, phone, email),
    repo.altas(nameKey, phone, email, opts.excludeIntakeId ?? null),
  ]);

  // Socios: con nombre, la misma lista que bloquea un alta (`candidates`); sin él, solo por contacto.
  const candidates = conNombre ? rankMatches(entrante, deSocios) : [];
  const delPadron = (conNombre ? candidates : deSocios.map(comparar)).filter((m) => m.score >= REVIEW_THRESHOLD);
  const fichas = await repo.socios(delPadron.map((m) => m.candidateId));

  const people: IdentityMatch[] = [];
  for (const m of delPadron) {
    const s = fichas.get(m.candidateId);
    if (!s) continue;
    const kind: IdentityKind = s.status === 'ARCHIVED' ? 'FORMER_MEMBER' : 'MEMBER';
    people.push({
      kind, id: opts.puedeAbrir(kind, s.homeBranchId) ? m.candidateId : null, fullName: s.fullName, memberCode: s.memberCode,
      // El celular solo se repite si es el que se escribió: no se enseña el de nadie más.
      phoneE164: phone && s.phoneE164 === phone ? phone : null,
      status: s.status, branchId: s.homeBranchId, score: m.score, explanation: m.explanation, sharedPhone: mismoCelular(m),
    });
  }
  const deOtraTabla = (filas: Fila[], kind: 'PROSPECT' | 'INTAKE') => {
    for (const f of filas) {
      const m = comparar({ id: f.id, firstName: f.firstName, lastName: f.lastName, phoneE164: f.phoneE164, email: f.email, curp: null });
      if (m.score < REVIEW_THRESHOLD) continue;
      people.push({
        kind, id: opts.puedeAbrir(kind, f.branchId) ? f.id : null, fullName: `${f.firstName} ${f.lastName}`, memberCode: null,
        phoneE164: phone && f.phoneE164 === phone ? phone : null,
        status: f.status, branchId: f.branchId, score: m.score, explanation: m.explanation, sharedPhone: mismoCelular(m),
      });
    }
  };
  deOtraTabla(interesados, 'PROSPECT');
  deOtraTabla(altas, 'INTAKE');
  people.sort((a, b) => b.score - a.score);
  return { candidates, people };
}
