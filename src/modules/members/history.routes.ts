import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AUDIT_CATEGORIES, CANAL_DE_CONTACTO, MOTIVO_DE_RECHAZO, RESULTADO_DE_CONTACTO,
  auditAmountCents, auditCategoryOf, auditPhrase, etiqueta, notFound, validation,
} from '@gymflow/core';
import { HISTORY_KINDS, MemberHistory, type HistoryKind, type MemberHistoryItem } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { AuditEntry } from '../../platform/audit/audit.repository.js';
import { MemberRepository } from './member.repository.js';
import { MemberHistoryRepository, type Tramo } from './history.repository.js';
import { idParam } from './members.serializers.js';

/**
 * LA HISTORIA DEL SOCIO (auditoría 8, bloque 2.2; 3-11).
 *
 * Una línea de tiempo con lo que pasó con él: dinero, membresía, puerta,
 * contacto, firmas y datos. No es otra bitácora: APROVECHA la que ya existe
 * (cada asiento del socio, con la frase que arma el núcleo) y le suma lo que
 * la bitácora no guarda: las entradas normales (un renglón por día), la nota
 * de cada contacto y los avisos de su portal.
 *
 * La pestaña «Bitácora» de la ficha sigue siendo el registro completo, para
 * quien tiene Bitácora y solo de sus sedes. La historia la lee quien abre la
 * ficha (`members:read`), y cada quien recibe solo las partes que ya ve en
 * otras pantallas: el dinero, con estado de cuenta; la puerta, con
 * asistencias; el contacto, con los datos de contacto; las firmas, con
 * consentimientos. El coach ve membresía y datos de sus socios, nada más.
 */

/** Asientos que no cuentan la historia del socio: quién leyó, quién firmó, la sesión. */
const FUERA = ['health.read', 'approval.', 'audit.', 'auth.', 'mfa.', 'session.', 'staff.', 'settings.', 'system.', 'platform.', 'cash.', 'expense.', 'report.'];
/** El contacto viene de su tabla, con la nota: el asiento se omite para no decirlo dos veces. */
const DE_OTRA_FUENTE = ['member.follow_up'];
const FIRMAS = ['consent.', 'privacy.', 'member.export', 'member.anonymize'];
const CONTACTO = ['portal.'];

const empieza = (prefijos: readonly string[], action: string): boolean => prefijos.some((p) => (p.endsWith('.') ? action.startsWith(p) : action === p || action.startsWith(`${p}.`)));

/** De qué habla un asiento, o `null` si no entra a la historia. */
export function parteDeLaHistoria(action: string): HistoryKind | null {
  if (empieza(FUERA, action) || empieza(DE_OTRA_FUENTE, action)) return null;
  if (empieza(CONTACTO, action)) return 'CONTACTO';
  if (auditCategoryOf(action) === 'dinero') return 'DINERO';
  if (action.startsWith('membership.') || action.startsWith('visitpack.')) return 'MEMBRESIA';
  if (action.startsWith('access.')) return 'PUERTA';
  if (empieza(FIRMAS, action)) return 'FIRMAS';
  return 'DATOS';
}

/** Los prefijos de la bitácora que alimentan cada parte (para pedir solo esa). */
const ACCIONES_DE: Record<HistoryKind, readonly string[] | null> = {
  DINERO: AUDIT_CATEGORIES.dinero!,
  MEMBRESIA: ['membership.', 'visitpack.'],
  PUERTA: ['access.'],
  CONTACTO: CONTACTO,
  FIRMAS: FIRMAS,
  // «Datos» es lo demás: se pide todo y se filtra.
  DATOS: null,
};

const COMO_ENTRO: Record<string, string> = { FACE: 'con su rostro', FINGERPRINT: 'con su huella', MANUAL: 'por el mostrador', RFID: 'con tarjeta', PIN: 'con PIN', QR: 'con código QR' };

const leerCursor = (texto: string | undefined): { at: Date; id: string } | undefined => {
  if (!texto) return undefined;
  const [at, id] = Buffer.from(texto, 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !z.string().uuid().safeParse(id).success) throw validation('Esa página ya no existe. Vuelve a abrir la historia.');
  return { at: new Date(at), id };
};
const armarCursor = (u: { at: Date; id: string }): string => Buffer.from(`${u.at.toISOString()}|${u.id}`).toString('base64url');

export function registerHistoryRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  route(app, {
    method: 'GET',
    url: '/members/:id/history',
    security: { kind: 'permission', permission: 'members:read' },
    schema: respuesta(200, MemberHistory),
    handler: async (request): Promise<MemberHistory> => {
      const orgId = request.ctx!.tenant.organizationId;
      const { id } = idParam.parse(request.params);
      const q = z.object({
        kind: z.enum(HISTORY_KINDS).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(40),
        cursor: z.string().max(200).optional(),
      }).parse(request.query);
      // También de quien se dio de baja: su historia sigue ahí.
      const socio = await new MemberRepository(orgId).findByIdIncludingArchived(id);
      if (!socio) throw notFound('Socio no encontrado');

      // Qué partes ve quien pregunta: las mismas que ya ve en otras pantallas (SEC2-06).
      const sede = socio.homeBranchId;
      const puede: Record<HistoryKind, boolean> = {
        DINERO: request.holds('billing:statement:read', sede),
        MEMBRESIA: true,
        PUERTA: request.holds('access:attendance:read', sede),
        CONTACTO: request.holds('members:update', sede) || request.holds('members:create', sede),
        FIRMAS: request.holds('members:consent:read', sede),
        DATOS: true,
      };
      const kinds = HISTORY_KINDS.filter((k) => puede[k]);
      // Pedir una parte que no se ve no es un error de quien teclea: es una lista vacía.
      if (q.kind && !puede[q.kind]) return { items: [], nextCursor: null, hasMore: false, kinds };

      const antes = leerCursor(q.cursor);
      const acciones = q.kind ? ACCIONES_DE[q.kind] : null;
      const asientos = await audit.list(orgId, { memberId: id, limit: q.limit, before: antes, ...(acciones ? { actions: acciones } : {}) });
      const hayMas = asientos.length === q.limit;
      const ultimo = asientos.at(-1);
      // Lo que no está en la bitácora se lee del mismo tramo de tiempo que esta página de asientos.
      const tramo: Tramo = { hasta: antes?.at ?? null, desde: hayMas && ultimo ? ultimo.at : null };

      const lectura = new MemberHistoryRepository(orgId);
      const quiere = (k: HistoryKind) => puede[k] && (!q.kind || q.kind === k);
      const [nombres, visitas, contactos, avisos] = await Promise.all([
        audit.names(orgId, asientos),
        quiere('PUERTA') ? lectura.visitas(id, tramo) : [],
        quiere('CONTACTO') ? lectura.contactos(id, tramo) : [],
        quiere('CONTACTO') ? lectura.avisos(id, tramo) : [],
      ]);
      const personal = await lectura.staffNames(contactos.map((c) => c.createdByUserId));

      const items: MemberHistoryItem[] = [];
      for (const e of asientos) {
        const kind = parteDeLaHistoria(e.action);
        if (!kind || !puede[kind] || (q.kind && q.kind !== kind)) continue;
        items.push(deAsiento(e, kind, nombres, puede.DINERO));
      }
      for (const v of visitas) {
        items.push({
          // La hora va en el id: si el corte de página cae a medio día, ese día sale en dos renglones y no deben chocar.
          id: `visita:${v.dia}:${v.branchId}:${v.outcome}:${v.at.getTime()}`, at: v.at.toISOString(), kind: 'PUERTA', source: 'VISIT', action: null,
          actorName: 'El socio',
          phrase: v.outcome === 'GRANTED' ? `Entró ${COMO_ENTRO[v.credentialKind] ?? ''}`.trim() : 'No pasó',
          detail: v.outcome === 'GRANTED'
            ? (v.veces > 1 ? `${v.veces} pasos por la puerta ese día` : null)
            : [etiqueta(MOTIVO_DE_RECHAZO, v.denialReason, ''), v.veces > 1 ? `${v.veces} intentos` : ''].filter(Boolean).join(' · ') || null,
          amountCents: null, reason: null, approverName: null, branchId: v.branchId,
        });
      }
      for (const c of contactos) {
        const proximo = c.nextStepOn ? `Próximo paso: ${c.nextStepOn.toISOString().slice(0, 10)}` : null;
        items.push({
          id: `contacto:${c.id}`, at: c.at.toISOString(), kind: 'CONTACTO', source: 'CONTACT', action: 'member.follow_up',
          actorName: personal.get(c.createdByUserId) ?? 'Alguien',
          phrase: `${etiqueta(CANAL_DE_CONTACTO, c.channel, 'Contacto')} · ${etiqueta(RESULTADO_DE_CONTACTO, c.outcome, '')}`.replace(/ · $/, ''),
          detail: [c.note, proximo].filter(Boolean).join(' · ') || null,
          amountCents: null, reason: null, approverName: null, branchId: c.branchId,
        });
      }
      for (const a of avisos) {
        items.push({
          id: `aviso:${a.id}`, at: a.at.toISOString(), kind: 'CONTACTO', source: 'NOTICE', action: null,
          actorName: 'El sistema', phrase: `Aviso en su portal: ${a.title}`, detail: a.body || null,
          amountCents: null, reason: null, approverName: null, branchId: null,
        });
      }
      items.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));

      return { items, nextCursor: hayMas && ultimo ? armarCursor(ultimo) : null, hasMore: hayMas, kinds };
    },
  });
}

function deAsiento(e: AuditEntry, kind: HistoryKind, nombres: Awaited<ReturnType<AuditService['names']>>, conDinero: boolean): MemberHistoryItem {
  const socio = nombres.members.get(e.id) ?? null;
  const importe = conDinero ? auditAmountCents(e) : null;
  return {
    id: `asiento:${e.id}`,
    at: e.at.toISOString(),
    kind,
    source: 'AUDIT',
    action: e.action,
    actorName: e.actorUserId ? nombres.users.get(e.actorUserId) ?? 'Alguien' : e.actorType === 'MEMBER' ? 'El socio' : 'El sistema',
    // Sin permiso de dinero la frase no lleva importe (el asiento se arma sin sus cifras).
    phrase: auditPhrase(conDinero ? e : { action: e.action, approvedByUserId: e.approvedByUserId }, { member: socio?.name, person: nombres.people.get(e.id) }),
    detail: null,
    amountCents: importe === null ? null : importe.toString(),
    reason: e.reason,
    approverName: e.approvedByUserId ? nombres.users.get(e.approvedByUserId) ?? null : null,
    branchId: e.branchId,
  };
}
