import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AUDIT_CATEGORIES, auditAmountCents, auditCategoryOf, auditLabel, auditNeedsReview, auditPhrase, auditReviewReason, formatMoney, isoDate, masDias, money,
  resolveWallTime, validation,
} from '@gymflow/core';
import { route } from '../http/registry.js';
import { BusinessCalendar } from '../time/business-calendar.js';
import { AuditService } from './audit.service.js';
import type { AuditEntry, AuditNames } from './audit.repository.js';
import { PlatformAuditService } from './platform-audit.service.js';

/** Grupos y frases de la bitácora: una sola fuente, en el núcleo (DP-05). */
const CATEGORIAS = AUDIT_CATEGORIES;
/** Cómo se llama cada categoría en la pantalla y en el CSV. */
const NOMBRE_DE_CATEGORIA: Readonly<Record<string, string>> = {
  dinero: 'Dinero', socios: 'Socios', acceso: 'Acceso', personal: 'Personal', clases: 'Clases', catalogo: 'Precios y catálogo', plataforma: 'GymFlow',
};

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** El primer instante de un día del calendario EN UNA ZONA (20-09): antes era `-06:00` fijo y fallaba en Tijuana o Ciudad Juárez. */
function inicioDelDia(fecha: string, zona: string): Date {
  const [a, m, d] = fecha.split('-').map(Number) as [number, number, number];
  return resolveWallTime(zona, a, m, d, 0, 0).at;
}

/** El periodo pedido como instantes, en la zona de la sede filtrada o, sin sede, en la del gimnasio. */
async function periodo(organizationId: string, q: { from?: string | undefined; to?: string | undefined; branchId?: string | undefined }): Promise<{ from: Date | undefined; to: Date | undefined }> {
  if (!q.from && !q.to) return { from: undefined, to: undefined };
  const zona = await new BusinessCalendar(organizationId).timezoneFor(q.branchId ?? null);
  return {
    from: q.from ? inicioDelDia(q.from, zona) : undefined,
    to: q.to ? inicioDelDia(masDias(q.to, 1), zona) : undefined,
  };
}

/**
 * UN ASIENTO COMO SE LEE (20-07): la frase completa la arma el núcleo con los
 * datos del asiento y los nombres ya resueltos; aquí solo se juntan.
 */
function leer(e: AuditEntry, nombres: AuditNames) {
  const socio = nombres.members.get(e.id) ?? null;
  const importe = auditAmountCents(e);
  return {
    actorName: e.actorUserId ? nombres.users.get(e.actorUserId) ?? null : null,
    approverName: e.approvedByUserId ? nombres.users.get(e.approvedByUserId) ?? null : null,
    member: socio,
    /** La persona del personal sobre la que se actuó, si el asiento es de alguien. */
    personName: nombres.people.get(e.id) ?? null,
    phrase: auditPhrase(e, { member: socio?.name, person: nombres.people.get(e.id) }),
    /** La misma frase sin nombres ni importe («renovó la membresía»): para leer varios asientos iguales como uno. */
    label: auditLabel(e.action),
    amountCents: importe === null ? null : importe.toString(),
    category: auditCategoryOf(e.action),
    sensitive: auditNeedsReview(e),
    /** Por qué entró a «Para revisar» cuando depende del asiento (el corte tuvo diferencia…). */
    reviewReason: auditReviewReason(e),
  };
}

const cursorDe = (texto: string | undefined): { at: Date; id: string } | undefined => {
  if (!texto) return undefined;
  const [at, id] = Buffer.from(texto, 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(Date.parse(at))) throw validation('Cursor inválido');
  return { at: new Date(at), id };
};
const cursorA = (ultimo: { at: Date; id: string } | undefined): string | null =>
  (ultimo ? Buffer.from(`${ultimo.at.toISOString()}|${ultimo.id}`).toString('base64url') : null);

/** Fecha (dd/mm/aaaa) y hora (24 h) de un instante en una zona. */
function enZona(at: Date, zona: string): { fecha: string; hora: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map((x) => [x.type, x.value]));
  return { fecha: `${p.day}/${p.month}/${p.year}`, hora: `${p.hour}:${p.minute}:${p.second}` };
}

/**
 * Una celda del CSV. Lo que empieza con `=`, `+`, `-` o `@` Excel lo toma por
 * fórmula: el motivo es texto libre de quien operó, así que se neutraliza.
 */
const celda = (v: unknown): string => {
  const t = String(v ?? '');
  return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`;
};

/**
 * La bitácora es TRANSVERSAL: no pertenece a ningún módulo porque todos
 * escriben en ella. Vive en `platform` justamente por eso.
 */
export function registerAuditRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  const filtros = z.object({
    actorUserId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
    category: z.enum(Object.keys(CATEGORIAS) as [string, ...string[]]).optional(),
    /** «Todo lo de este socio» (ficha → Bitácora). */
    memberId: z.string().uuid().optional(),
    from: dia.optional(),
    to: dia.optional(),
  });
  /** `sensibles` no es una lista de acciones: es la regla de «Para revisar» (20-06). */
  const porCategoria = (category: string | undefined) => (category === 'sensibles' ? { review: true } : { actions: category ? CATEGORIAS[category] : undefined });

  /**
   * EXPORTAR la bitácora (DP-05, 20-09): el dueño se la entrega al contador o
   * al abogado, así que se lee sin ingeniería: la frase completa, el socio y
   * su número, el importe, la sucursal POR NOMBRE y la fecha y la hora EN LA
   * ZONA DE ESA SUCURSAL (el instante UTC va al final, para quien lo necesite).
   * Mismos filtros que la lista, con motivo, y la exportación misma queda
   * asentada. CSV con BOM para que Excel lea los acentos.
   */
  route(app, {
    method: 'GET',
    url: '/audit/export.csv',
    security: { kind: 'permission', permission: 'audit:export' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const query = filtros.extend({ reason: z.string().min(3).max(300) }).parse(request.query);
      if (query.branchId) request.requirePermission('audit:export', query.branchId);
      const alcance = request.branchScope('audit:export');
      request.authorize('audit:export', { branchId: query.branchId ?? null, reason: query.reason });
      const [{ from, to }, sedes, zonaDelGimnasio] = await Promise.all([periodo(orgId, query), audit.branches(orgId), new BusinessCalendar(orgId).timezoneFor(null)]);
      const sede = new Map(sedes.map((b) => [b.id, b]));
      const filas: string[][] = [[
        'Fecha', 'Hora', 'Quién', 'Qué hizo', 'Socio', 'No. de socio', 'Importe', 'Para revisar', 'Autorizó', 'Sucursal', 'Motivo', 'Motivo (clave)',
        'Categoría', 'Clave de la acción', 'Recurso', 'Id del recurso', 'Zona horaria', 'Fecha y hora (UTC)',
      ]];
      let before: { at: Date; id: string } | undefined;
      // Hasta 5,000 asientos por archivo, en páginas de 500.
      for (let i = 0; i < 10; i++) {
        const entries = await audit.list(orgId, {
          limit: 500, actorUserId: query.actorUserId, memberId: query.memberId,
          branchIds: query.branchId ? [query.branchId] : alcance,
          ...porCategoria(query.category),
          from, to, before,
        });
        if (entries.length === 0) break;
        const nombres = await audit.names(orgId, entries);
        for (const e of entries) {
          const l = leer(e, nombres);
          const b = e.branchId ? sede.get(e.branchId) : undefined;
          const zona = b?.timezone ?? zonaDelGimnasio;
          const local = enZona(e.at, zona);
          const clave = e.afterState && typeof e.afterState === 'object' ? (e.afterState as Record<string, unknown>).reasonCode : null;
          filas.push([
            local.fecha, local.hora,
            l.actorName ?? (e.action.startsWith('platform.') ? 'GymFlow' : e.actorType === 'MEMBER' ? 'El socio' : 'El sistema'),
            l.phrase, l.member?.name ?? '', l.member?.memberCode ?? '',
            l.amountCents === null ? '' : formatMoney(money(BigInt(l.amountCents))),
            l.sensitive ? 'Sí' : 'No', l.approverName ?? '',
            b?.name ?? (e.branchId ? 'Sucursal eliminada' : 'Todo el gimnasio'),
            e.reason ?? '', typeof clave === 'string' ? clave : '',
            NOMBRE_DE_CATEGORIA[l.category ?? ''] ?? '', e.action, e.resourceType, e.resourceId ?? '', zona, e.at.toISOString(),
          ]);
        }
        if (entries.length < 500) break;
        before = { at: entries.at(-1)!.at, id: entries.at(-1)!.id };
      }
      await audit.record(ctx, { action: 'audit.export', resourceType: 'AuditLog', resourceId: null, branchId: query.branchId ?? null, reason: query.reason, afterState: { rows: filas.length - 1 } });
      const csv = '\uFEFF' + filas.map((f) => f.map(celda).join(',')).join('\r\n');
      const hoy = isoDate(await new BusinessCalendar(orgId).today(query.branchId ?? null));
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="bitacora-${hoy}.csv"`).send(csv);
    },
  });

  route(app, {
    method: 'GET',
    url: '/audit',
    security: { kind: 'permission', permission: 'audit:read' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const query = filtros.extend({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        resourceType: z.string().max(40).optional(),
        resourceId: z.string().uuid().optional(),
        cursor: z.string().max(200).optional(),
      }).parse(request.query);
      // Gerencia de una o dos sedes ve la bitácora de SUS sedes (doc 06).
      if (query.branchId) request.requirePermission('audit:read', query.branchId);
      const alcance = request.branchScope('audit:read');
      const { from, to } = await periodo(orgId, query);
      const limite = query.limit;
      const entries = await audit.list(orgId, {
        limit: limite, actorUserId: query.actorUserId, resourceType: query.resourceType, resourceId: query.resourceId, memberId: query.memberId,
        branchIds: query.branchId ? [query.branchId] : alcance,
        ...porCategoria(query.category),
        from, to, before: cursorDe(query.cursor),
      });
      const nombres = await audit.names(orgId, entries);
      return {
        entries: entries.map((e) => ({
          ...e,
          // La lista muestra frases, no estados: viajan solo los valores
          // sueltos (importe, folio, nombre); un expediente completo dentro
          // del asiento multiplicaba por cuatro el peso de la página (OPT3-09).
          beforeState: resumenDeEstado(e.beforeState),
          afterState: resumenDeEstado(e.afterState),
          at: e.at.toISOString(),
          // La frase la pone el servidor desde el núcleo: el panel no mantiene su propio diccionario.
          ...leer(e, nombres),
        })),
        nextCursor: cursorA(entries.length === limite ? entries.at(-1) : undefined),
      };
    },
  });

  /**
   * QUIÉN HA ESCRITO en la bitácora en el periodo (20-12): de aquí sale el
   * filtro «Persona», con el permiso de la bitácora y en las sedes de quien
   * consulta. Antes salía de `/users` (permiso de Personal) y una gerencia con
   * Bitácora liberada y Personal no se quedaba sin filtro.
   */
  route(app, {
    method: 'GET',
    url: '/audit/actors',
    security: { kind: 'permission', permission: 'audit:read' },
    handler: async (request) => {
      const orgId = request.ctx!.tenant.organizationId;
      const query = z.object({ branchId: z.string().uuid().optional(), from: dia.optional(), to: dia.optional() }).parse(request.query);
      if (query.branchId) request.requirePermission('audit:read', query.branchId);
      const alcance = request.branchScope('audit:read');
      const { from, to } = await periodo(orgId, query);
      return { actors: await audit.actors(orgId, { branchIds: query.branchId ? [query.branchId] : alcance, from, to }) };
    },
  });

  /**
   * ENTRADAS POR EXCEPCIÓN, RESUMIDAS (20-06): un renglón por persona, día y
   * sede («Paola dejó pasar 4 veces por excepción»), con el tope de su puesto.
   * Solo lo que pasa del tope es «para revisar»; el detalle sigue en Acceso.
   */
  route(app, {
    method: 'GET',
    url: '/audit/exceptions',
    security: { kind: 'permission', permission: 'audit:read' },
    handler: async (request) => {
      const orgId = request.ctx!.tenant.organizationId;
      const query = z.object({ branchId: z.string().uuid().optional(), actorUserId: z.string().uuid().optional(), from: dia.optional(), to: dia.optional() }).parse(request.query);
      if (query.branchId) request.requirePermission('audit:read', query.branchId);
      const alcance = request.branchScope('audit:read');
      const { from, to } = await periodo(orgId, query);
      const sedes = query.branchId ? [query.branchId] : alcance;
      const [todas, sinRostro] = await Promise.all([
        audit.exceptionSummary(orgId, { branchIds: sedes, from, to }),
        audit.withoutFaceSummary(orgId, { branchIds: sedes, from, to }),
      ]);
      const filas = todas.filter((f) => !query.actorUserId || f.actorUserId === query.actorUserId);
      return {
        // Entradas autorizadas sin rostro (D-06; 3.12): por quién autorizó, día y sede. Sin tope.
        withoutFace: sinRostro.filter((f) => !query.actorUserId || f.byUserId === query.actorUserId)
          .map((f) => ({ date: isoDate(f.businessDate), byUserId: f.byUserId, byName: f.byName, branchId: f.branchId, count: f.count })),
        summary: filas.map((f) => ({
          date: isoDate(f.businessDate), actorUserId: f.actorUserId, actorName: f.actorName, branchId: f.branchId,
          count: f.count, limit: f.limit, overLimit: f.limit !== null && f.count > f.limit,
        })),
      };
    },
  });

  /**
   * Verificación de la cadena de hashes. En producción lo ejecuta el job
   * diario `audit.verify-hash-chain`; aquí se expone para poder comprobarlo
   * a demanda desde el panel.
   */
  route(app, {
    method: 'GET',
    url: '/audit/verify',
    security: { kind: 'permission', permission: 'audit:read' },
    handler: async (request) => {
      // La cadena es UNA para toda la organización.
      request.requirePermission('audit:read', null);
      const ctx = request.ctx!;
      const result = await audit.verifyChain(ctx.tenant.organizationId);
      return result.ok
        ? { ok: true, entries: result.checked }
        : { ok: false, entries: result.checked, brokenAtId: result.brokenAtId, reason: result.reason };
    },
  });

  registerPlatformAuditRoutes(app);
}

/** Quién de la plataforma hace la petición, para asentar en su cadena. */
export function platformActor(request: FastifyRequest): { userId: string | null; sessionId: string | null; ip: string | null; userAgent: string | null; requestId: string } {
  const ua = request.headers['user-agent'];
  return {
    userId: request.platform?.userId ?? null, sessionId: request.platform?.sessionId ?? null,
    ip: request.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null, requestId: String(request.id),
  };
}

/**
 * LA CADENA DE PLATAFORMA en la consola (24-19, 23-09): lo que GymFlow hizo,
 * sobre qué marca, quién y cuándo; y su verificación, con el enlace a las
 * cadenas de las marcas.
 */
function registerPlatformAuditRoutes(app: FastifyInstance): void {
  const cadena = new PlatformAuditService();

  route(app, {
    method: 'GET',
    url: '/platform/audit',
    security: { kind: 'platform' },
    handler: async (request) => {
      const query = z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        organizationId: z.string().uuid().optional(),
        actorUserId: z.string().uuid().optional(),
        cursor: z.string().max(200).optional(),
      }).parse(request.query);
      const entries = await cadena.list({ limit: query.limit, organizationId: query.organizationId, actorUserId: query.actorUserId, before: cursorDe(query.cursor) });
      const nombres = await cadena.names(entries);
      return {
        entries: entries.map((e) => ({
          id: e.id, at: e.at.toISOString(), occurredAt: e.occurredAt.toISOString(), action: e.action,
          phrase: auditPhrase(e, { person: e.resourceId ? nombres.people.get(e.resourceId) : null }),
          actorUserId: e.actorUserId, actor: e.actorUserId ? nombres.actors.get(e.actorUserId) ?? null : null,
          organizationId: e.organizationId, tradeName: e.organizationId ? nombres.organizations.get(e.organizationId) ?? null : null,
          resourceType: e.resourceType, resourceId: e.resourceId, reason: e.reason,
          afterState: resumenDeEstado(e.afterState),
          /** El asiento espejo en la cadena de la marca, si lo tiene. */
          organizationAuditId: e.organizationAuditId, hash: e.hash,
        })),
        nextCursor: cursorA(entries.length === query.limit ? entries.at(-1) : undefined),
      };
    },
  });

  /** Verifica la cadena de plataforma y su enlace con las cadenas de las marcas. */
  route(app, {
    method: 'GET',
    url: '/platform/audit/verify',
    security: { kind: 'platform' },
    handler: async () => cadena.verify(),
  });
}

/** Solo los valores sueltos y cortos de un estado; los objetos anidados y los textos largos se quedan en la base. */
function resumenDeEstado(estado: unknown): Record<string, unknown> | null {
  if (!estado || typeof estado !== 'object' || Array.isArray(estado)) return null;
  const corto = (v: unknown): boolean => v === null || typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 120);
  const salida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(estado as Record<string, unknown>)) {
    if (corto(v)) salida[k] = v;
    else if (Array.isArray(v) && v.length <= 10 && v.every(corto)) salida[k] = v;
  }
  return salida;
}
