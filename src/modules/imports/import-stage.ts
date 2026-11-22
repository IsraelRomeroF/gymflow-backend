import {
  fuenteDelArchivo, limpiarFila, uuidv7, matchIdentity, normalizedNameKey, rankMatches,
  AUTO_MERGE_THRESHOLD, type FilaCruda, type IdentityCandidate, type MatchResult,
} from '@gymflow/core';
import { LegacyCodeRepository, MemberRepository } from '../members/index.js';
import type { NewImportRow } from './import.repository.js';

export type FilaEntrante = { rowNumber: number; raw: Record<string, unknown>; fields: FilaCruda };

/**
 * De qué sucursal del sistema anterior es el código de una fila: la que dice
 * el archivo o, si no trae columna de sucursal, la de casa de la importación.
 * Antes las filas sin sucursal compartían el origen «GENERAL» en todo el
 * gimnasio: dos sucursales que migran cada una su archivo sin esa columna
 * tenían el mismo «027» y la segunda persona se unía sola a la ficha de la
 * primera (fase 2 · 2.7).
 */
export const origenDeLaFila = (sucursalDelArchivo: string | null | undefined, sedeDeCasa: string): string =>
  fuenteDelArchivo(sucursalDelArchivo?.trim() ? sucursalDelArchivo : sedeDeCasa);

/** Un día de calendario (aaaa-mm-dd) a las 00:00Z; null sin fecha. */
export const dia = (iso: string | null): Date | null => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);
const sinAcentos = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

/**
 * LIMPIEZA Y EMPAREJAMIENTO (paso 1 de la importación, docs/09 §3–4).
 *
 * Limpia cada fila, traduce las sucursales del archivo a las del gimnasio y
 * compara a cada persona contra el padrón y contra las filas anteriores del
 * MISMO archivo para proponer qué hacer. No escribe nada: lo guarda
 * `ImportService.stage`, con su bitácora, en una transacción.
 */
export async function prepararFilas(
  orgId: string, rows: readonly FilaEntrante[], sedes: ReadonlyArray<{ id: string; code: string; name: string }>, hoy: string,
  /** La sucursal de casa de la importación: de ahí son los códigos de las filas que no traen sucursal. */
  sedeDeCasa: { name: string },
): Promise<{ filas: NewImportRow[]; branchMap: Record<string, string | null> }> {
  // Sucursales del archivo → sucursales del gimnasio, por código o nombre.
  const limpias = rows.map((r) => ({ ...r, f: limpiarFila(r.fields, hoy) }));
  const branchMap: Record<string, string | null> = {};
  for (const label of new Set(limpias.map((r) => r.f.branch).filter((x): x is string => !!x))) {
    const k = sinAcentos(label);
    const sede = sedes.find((b) => sinAcentos(b.code) === k || sinAcentos(b.name) === k)
      ?? sedes.find((b) => k.includes(sinAcentos(b.name)) || sinAcentos(b.name).includes(k));
    branchMap[label] = sede?.id ?? null;
  }

  const members = new MemberRepository(orgId);
  const codigos = new LegacyCodeRepository(orgId);
  const filas: NewImportRow[] = [];
  // Índices de lo ya visto EN ESTE ARCHIVO, para los repetidos.
  const vistas: Array<{ id: string; cand: IdentityCandidate; source: string; code: string | null }> = [];
  const porTel = new Map<string, number[]>();
  const porCorreo = new Map<string, number[]>();
  const porNombre = new Map<string, number[]>();
  const porCodigo = new Map<string, number>();
  const agrega = (m: Map<string, number[]>, k: string | null, i: number) => { if (k) m.set(k, [...(m.get(k) ?? []), i]); };

  for (const r of limpias) {
    const f = r.f;
    const id = uuidv7();
    const source = origenDeLaFila(f.branch, sedeDeCasa.name);
    const base: NewImportRow = {
      id, rowNumber: r.rowNumber, raw: r.raw,
      firstName: f.firstName, lastName: f.lastName, phoneE164: f.phoneE164, email: f.email, curp: f.curp,
      birthDate: dia(f.birthDate), joinedAt: dia(f.joinedAt), periodEnd: dia(f.periodEnd),
      legacyCode: f.legacyCode, branchLabel: f.branch, planLabel: f.plan, notes: f.notes,
      balanceCents: f.balanceCents, problems: f.problems,
      kind: 'NEW', matchMemberId: null, matchRowId: null, matchScore: null, matchReason: null, decision: 'CREATE',
      // Saldo, vigencia o fecha de alta ilegibles: la fila espera a una persona (D18-02).
      doubtful: f.doubtful, dataStatus: f.doubtful.length > 0 ? 'PENDING' : null,
    };
    if (f.invalid) { filas.push({ ...base, kind: 'INVALID', decision: 'SKIP', dataStatus: null }); continue; }

    const cand: IdentityCandidate = {
      id: 'nuevo', firstName: f.firstName, lastName: f.lastName,
      phoneE164: f.phoneE164, email: f.email, curp: f.curp, birthDate: f.birthDate,
    };

    // a) El mismo código del sistema anterior: es la misma persona (reimportar no duplica).
    let existente: { memberId: string; score: number; reason: string; auto: boolean } | null = null;
    if (f.legacyCode) {
      const hallado = await codigos.ownerOf(f.legacyCode, source);
      if (hallado?.exact) existente = { memberId: hallado.memberId, score: 100, reason: `Mismo código del sistema anterior (${f.legacyCode})`, auto: true };
      else if (hallado) {
        // El código es de OTRO origen (otra sucursal, o un archivo viejo sin
        // sucursal): el «027» de Norte no es el «027» de Centro. Solo se une
        // sola si además el nombre coincide; si no, lo decide una persona.
        const socio = await members.findByIdIncludingArchived(hallado.memberId);
        const mismo = !!socio && !socio.anonymizedAt && matchIdentity(cand, {
          id: socio.id, firstName: socio.firstName, lastName: socio.lastName,
          phoneE164: socio.phoneE164, email: socio.email, curp: null, birthDate: socio.birthDate ? socio.birthDate.toISOString().slice(0, 10) : null,
        }).action !== 'DISTINCT';
        if (mismo) existente = { memberId: hallado.memberId, score: 100, reason: `Mismo código del sistema anterior (${f.legacyCode})`, auto: true };
        else if (socio && !socio.anonymizedAt) {
          existente = {
            memberId: hallado.memberId, score: 50, auto: false,
            reason: `El código ${f.legacyCode} ya es de ${socio.firstName} ${socio.lastName}`.trim() + ', con otro nombre: puede ser el mismo número de otra sucursal',
          };
        }
      }
    }
    // b) Contra el padrón: el mismo motor que el alta en mostrador. Un parecido seguro gana al código dudoso.
    if (!existente?.auto) {
      const mejor: MatchResult | undefined = rankMatches(cand, await members.findDuplicateCandidates(cand))[0];
      if (mejor && (!existente || mejor.score >= AUTO_MERGE_THRESHOLD)) existente = { memberId: mejor.candidateId, score: mejor.score, reason: mejor.explanation, auto: mejor.score >= AUTO_MERGE_THRESHOLD };
    }

    // c) Contra las filas anteriores del archivo.
    let enArchivo: { rowId: string; score: number; reason: string; auto: boolean } | null = null;
    const clave = f.legacyCode ? `${source}|${f.legacyCode}` : null;
    if (clave && porCodigo.has(clave)) {
      enArchivo = { rowId: vistas[porCodigo.get(clave)!]!.id, score: 100, reason: `Código ${f.legacyCode} repetido en el archivo`, auto: true };
    } else {
      const idx = new Set([
        ...(f.phoneE164 ? porTel.get(f.phoneE164) ?? [] : []),
        ...(f.email ? porCorreo.get(f.email) ?? [] : []),
        ...(porNombre.get(normalizedNameKey(`${f.firstName} ${f.lastName}`)) ?? []),
      ]);
      for (const i of idx) {
        const m = matchIdentity(cand, vistas[i]!.cand);
        if (m.action === 'DISTINCT') continue;
        // Mismo código en otra sucursal del archivo con nombre distinto: son dos personas.
        if (!enArchivo || m.score > enArchivo.score) enArchivo = { rowId: vistas[i]!.id, score: m.score, reason: `En el archivo: ${m.explanation.toLowerCase()}`, auto: m.score >= AUTO_MERGE_THRESHOLD };
      }
    }

    const i = vistas.length;
    vistas.push({ id, cand: { ...cand, id }, source, code: f.legacyCode });
    agrega(porTel, f.phoneE164, i); agrega(porCorreo, f.email, i);
    agrega(porNombre, normalizedNameKey(`${f.firstName} ${f.lastName}`), i);
    if (clave && !porCodigo.has(clave)) porCodigo.set(clave, i);

    // Prioridad: socio existente seguro > repetido seguro > dudoso existente > dudoso en archivo.
    if (existente?.auto) filas.push({ ...base, kind: 'MATCH', decision: 'MERGE', matchMemberId: existente.memberId, matchScore: existente.score, matchReason: existente.reason });
    else if (enArchivo?.auto) filas.push({ ...base, kind: 'FILE_DUP', decision: 'MERGE', matchRowId: enArchivo.rowId, matchScore: enArchivo.score, matchReason: enArchivo.reason });
    else if (existente) filas.push({ ...base, kind: 'REVIEW', decision: 'PENDING', matchMemberId: existente.memberId, matchScore: existente.score, matchReason: existente.reason });
    else if (enArchivo) filas.push({ ...base, kind: 'REVIEW', decision: 'PENDING', matchRowId: enArchivo.rowId, matchScore: enArchivo.score, matchReason: enArchivo.reason });
    else filas.push(base);
  }
  return { filas, branchMap };
}
