import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CAMPOS_IMPORTACION, mismoRegistroDeSaldo, notFound } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { LegacyCodeRepository, MemberRepository } from '../members/index.js';
import { ImportService, MAX_FILAS } from './import.service.js';
import { MemberImportRepository, type DataStatus, type ImportRowRecord } from './import.repository.js';

const idParam = z.object({ id: z.string().uuid() });
const rowParam = z.object({ id: z.string().uuid(), rowId: z.string().uuid() });
const KINDS = ['NEW', 'MATCH', 'REVIEW', 'FILE_DUP', 'INVALID'] as const;
const DECISIONES = ['CREATE', 'MERGE', 'SKIP'] as const;
const DATOS = ['PENDING', 'WITHOUT', 'FIXED'] as const;
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const valor = z.union([z.string().max(500), z.number(), z.null()]);

/**
 * IMPORTAR SOCIOS. La gerencia sube el archivo del sistema anterior, revisa
 * los posibles duplicados y aplica. Todo con `members:import` en la sucursal.
 */
export function registerImportRoutes(app: FastifyInstance): void {
  const service = new ImportService();

  route(app, {
    method: 'POST',
    url: '/member-imports',
    security: { kind: 'permission', permission: 'members:import' },
    // Unos miles de filas en JSON pasan del mega por omisión.
    bodyLimit: 25 * 1024 * 1024,
    handler: async (request, reply) => {
      const body = z.object({
        fileName: z.string().min(1).max(200),
        branchId: z.string().uuid(),
        cutoffDate: z.string().date(),
        // Cargar el archivo ya no pide motivo (18-07): el que vale es el de aplicar. La bitácora dice qué archivo fue.
        reason: z.string().min(3).max(300).optional(),
        rows: z.array(z.object({
          rowNumber: z.number().int().positive(),
          raw: z.record(z.string(), valor),
          fields: z.object(Object.fromEntries(CAMPOS_IMPORTACION.map((c) => [c, valor.optional()]))),
        })).min(1).max(MAX_FILAS),
      }).parse(request.body);
      const reason = body.reason ?? `Cargó ${body.fileName} para revisarlo`;
      request.authorize('members:import', { branchId: body.branchId, reason });
      const id = await service.stage(request.ctx!, { ...body, reason });
      return reply.status(201).send({ id });
    },
  });

  route(app, {
    method: 'GET',
    url: '/member-imports',
    security: { kind: 'permission', permission: 'members:import' },
    handler: async (request) => {
      const repo = new MemberImportRepository(request.ctx!.tenant.organizationId);
      // Un gerente de dos sucursales ve las importaciones de SUS sucursales.
      const sedes = request.branchScope('members:import');
      const lista = (await repo.list()).filter((i) => sedes === null || sedes.includes(i.branchId));
      return {
        imports: await Promise.all(lista.map(async (i) => ({
          id: i.id, fileName: i.fileName, status: i.status, branchId: i.branchId, totalRows: i.totalRows,
          createdAt: i.createdAt.toISOString(), appliedAt: i.appliedAt?.toISOString() ?? null, ...(await repo.counts(i.id)),
        }))),
      };
    },
  });

  route(app, {
    method: 'GET',
    url: '/member-imports/:id',
    security: { kind: 'permission', permission: 'members:import' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const repo = new MemberImportRepository(request.ctx!.tenant.organizationId);
      const imp = await repo.find(id);
      if (!imp) throw notFound('Esta importación no existe');
      request.requirePermission('members:import', imp.branchId);
      const [counts, labels, blockers, dinero] = await Promise.all([
        repo.counts(id), repo.labels(id),
        imp.status === 'REVIEW' ? service.pendientes(request.ctx!.tenant.organizationId, imp) : Promise.resolve([]),
        service.dinero(request.ctx!.tenant.organizationId, imp),
      ]);
      return {
        id: imp.id, fileName: imp.fileName, status: imp.status, branchId: imp.branchId, cutoffDate: iso(imp.cutoffDate),
        totalRows: imp.totalRows, createdAt: imp.createdAt.toISOString(), appliedAt: imp.appliedAt?.toISOString() ?? null,
        // Lo que falta decidir antes de aplicar, con las mismas palabras con que la API lo rechaza.
        planMap: imp.planMap, branchMap: imp.branchMap, ...counts, labels, blockers,
        reason: imp.reason,
        // El dinero y las vigencias de lo que entra, para cotejar con el reporte de cartera (18-04).
        money: {
          debtCents: dinero.debtCents.toString(), debtRows: dinero.debtRows,
          creditCents: dinero.creditCents.toString(), creditRows: dinero.creditRows,
          memberships: dinero.memberships, membershipsNotLoaded: dinero.membershipsNotLoaded, expired: dinero.expired,
          unreadBalances: dinero.unreadBalances,
          loadedDebtCents: dinero.loadedDebtCents.toString(), loadedCreditCents: dinero.loadedCreditCents.toString(),
        },
      };
    },
  });

  route(app, {
    method: 'GET',
    url: '/member-imports/:id/rows',
    security: { kind: 'permission', permission: 'members:import' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const q = z.object({
        kind: z.string().optional(), decision: z.string().optional(), data: z.string().optional(), q: z.string().max(100).optional(),
        after: z.coerce.number().int().nonnegative().optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
      }).parse(request.query);
      const orgId = request.ctx!.tenant.organizationId;
      const repo = new MemberImportRepository(orgId);
      const imp = await repo.find(id);
      if (!imp) throw notFound('Esta importación no existe');
      request.requirePermission('members:import', imp.branchId);
      const kinds = (q.kind?.split(',') ?? []).filter((k): k is (typeof KINDS)[number] => (KINDS as readonly string[]).includes(k));
      const decisions = (q.decision?.split(',') ?? []).filter((k): k is 'PENDING' | (typeof DECISIONES)[number] => ['PENDING', ...DECISIONES].includes(k));
      // Las filas con datos dudosos (D18-02), decididas o no: `data=PENDING,WITHOUT,FIXED`.
      const data = (q.data?.split(',') ?? []).filter((k): k is DataStatus => (DATOS as readonly string[]).includes(k));
      const rows = await repo.rows(id, { kinds, decisions, data, ...(q.q ? { q: q.q } : {}), ...(q.after ? { after: q.after } : {}), limit: q.limit + 1 });
      const pagina = rows.slice(0, q.limit);

      // Lo que la persona necesita para comparar, lado a lado: el socio o la fila con que se parece.
      const members = new MemberRepository(orgId);
      const codigos = new LegacyCodeRepository(orgId);
      const socios = new Map<string, unknown>();
      for (const mid of new Set(pagina.flatMap((r) => [r.matchMemberId, r.appliedMemberId]).filter((x): x is string => !!x))) {
        const m = await members.findById(mid);
        if (m) socios.set(mid, {
          id: m.id, memberCode: m.memberCode, fullName: `${m.firstName} ${m.lastName}`, phoneE164: m.phoneE164, email: m.email,
          birthDate: iso(m.birthDate), joinedAt: m.joinedAt.toISOString(), homeBranchId: m.homeBranchId,
          balanceCents: m.balanceCentsCached.toString(), legacyCodes: (await codigos.forMember(m.id)).map((c) => c.code),
        });
      }
      const otras = new Map((await repo.rowsByIds(id, [...new Set(pagina.map((r) => r.matchRowId).filter((x): x is string => !!x))])).map((r) => [r.id, r]));
      // Aviso previo de 18-01: la fila trae saldo y su socio ya tiene el de ese
      // registro (o uno capturado a mano). Al aplicar no se vuelve a cargar.
      const avisos = new Map<string, string>();
      for (const r of pagina) {
        // Solo lo que se UNE a una ficha puede encontrar un saldo previo; una alta nueva no tiene.
        if (!r.balanceCents || r.appliedAt || r.decision !== 'MERGE') continue;
        const principal = r.matchRowId ? otras.get(r.matchRowId) : undefined;
        const socio = r.matchMemberId ?? (principal?.decision === 'MERGE' ? principal.matchMemberId : null);
        const nota = socio
          ? await service.saldoYaCargado(orgId, id, socio, r, 'revision')
          : principal?.balanceCents && mismoRegistroDeSaldo(principal, r)
            ? `El renglón ${principal.rowNumber} ya trae el saldo de este registro (${principal.branchLabel ?? 'sin sucursal'}${principal.legacyCode ? `, código ${principal.legacyCode}` : ''}): no se carga dos veces`
            : null;
        if (nota) avisos.set(r.id, nota);
      }
      return {
        rows: pagina.map((r) => ({
          ...serializeRow(r),
          matchMember: r.matchMemberId ? socios.get(r.matchMemberId) ?? null : null,
          matchRow: r.matchRowId && otras.has(r.matchRowId) ? serializeRow(otras.get(r.matchRowId)!) : null,
          appliedMember: r.appliedMemberId ? socios.get(r.appliedMemberId) ?? null : null,
          openingNote: avisos.get(r.id) ?? null,
        })),
        next: rows.length > q.limit ? pagina.at(-1)!.rowNumber : null,
      };
    },
  });

  route(app, {
    method: 'PUT',
    url: '/member-imports/:id/rows/:rowId',
    security: { kind: 'permission', permission: 'members:import' },
    handler: async (request) => {
      const { id, rowId } = rowParam.parse(request.params);
      const fecha = z.string().date().nullable();
      const body = z.object({
        decision: z.enum(DECISIONES).optional(),
        memberId: z.string().uuid().nullish(),
        // Datos que no se entendieron (D18-02): sin ese dato, o con el valor que escribe la persona.
        data: z.enum(['WITHOUT', 'FIXED']).optional(),
        fix: z.object({
          balanceCents: z.string().regex(/^-?[0-9]{1,12}$/, 'Saldo en centavos: positivo si debe, negativo si tiene a favor').nullable().optional(),
          periodEnd: fecha.optional(),
          joinedAt: fecha.optional(),
        }).strict().optional(),
      }).refine((b) => b.decision !== undefined || b.data !== undefined, 'Indica qué se decide de la fila').parse(request.body);
      const imp = await new MemberImportRepository(request.ctx!.tenant.organizationId).find(id);
      if (!imp) throw notFound('Esta importación no existe');
      request.requirePermission('members:import', imp.branchId);
      let r: ImportRowRecord | null = null;
      if (body.decision) r = await service.decide(request.ctx!, id, rowId, body.decision, body.memberId);
      if (body.data) {
        const fix = body.fix ? {
          ...(body.fix.balanceCents !== undefined ? { balance: body.fix.balanceCents } : {}),
          ...(body.fix.periodEnd !== undefined ? { periodEnd: body.fix.periodEnd } : {}),
          ...(body.fix.joinedAt !== undefined ? { joinedAt: body.fix.joinedAt } : {}),
        } : undefined;
        r = await service.decideData(request.ctx!, id, rowId, body.data, fix);
      }
      return serializeRow(r!);
    },
  });

  route(app, {
    method: 'POST',
    url: '/member-imports/:id/decide-all',
    security: { kind: 'permission', permission: 'members:import' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ kind: z.enum(KINDS), decision: z.enum(DECISIONES) }).parse(request.body);
      const imp = await new MemberImportRepository(request.ctx!.tenant.organizationId).find(id);
      if (!imp) throw notFound('Esta importación no existe');
      request.requirePermission('members:import', imp.branchId);
      return { updated: await service.decideAll(request.ctx!, id, body.kind, body.decision) };
    },
  });

  route(app, {
    method: 'PUT',
    url: '/member-imports/:id/maps',
    security: { kind: 'permission', permission: 'members:import' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({
        planMap: z.record(z.string(), z.string().uuid().nullable()).optional(),
        branchMap: z.record(z.string(), z.string().uuid().nullable()).optional(),
      }).parse(request.body);
      const imp = await new MemberImportRepository(request.ctx!.tenant.organizationId).find(id);
      if (!imp) throw notFound('Esta importación no existe');
      request.requirePermission('members:import', imp.branchId);
      // Mandar socios a una sucursal ajena exige poder importar ahí.
      for (const b of Object.values(body.branchMap ?? {})) if (b) request.requirePermission('members:import', b);
      await service.setMaps(request.ctx!, id, { ...(body.planMap ? { planMap: body.planMap } : {}), ...(body.branchMap ? { branchMap: body.branchMap } : {}) });
      return { ok: true };
    },
  });

  route(app, {
    method: 'POST',
    url: '/member-imports/:id/apply',
    security: { kind: 'permission', permission: 'members:import' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ reason: z.string().min(3).max(300) }).parse(request.body);
      const repo = new MemberImportRepository(request.ctx!.tenant.organizationId);
      const imp = await repo.find(id);
      if (!imp) throw notFound('Esta importación no existe');
      request.authorize('members:import', { branchId: imp.branchId, reason: body.reason });
      for (const b of Object.values(imp.branchMap)) if (b) request.requirePermission('members:import', b);
      return service.applyBatch(request.ctx!, id, body.reason);
    },
  });

  route(app, {
    method: 'POST',
    url: '/member-imports/:id/cancel',
    security: { kind: 'permission', permission: 'members:import' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ reason: z.string().min(3).max(300) }).parse(request.body);
      const imp = await new MemberImportRepository(request.ctx!.tenant.organizationId).find(id);
      if (!imp) throw notFound('Esta importación no existe');
      request.authorize('members:import', { branchId: imp.branchId, reason: body.reason });
      await service.cancel(request.ctx!, id, body.reason);
      return { ok: true };
    },
  });
}

function serializeRow(r: ImportRowRecord) {
  return {
    id: r.id, rowNumber: r.rowNumber, raw: r.raw,
    firstName: r.firstName, lastName: r.lastName, phoneE164: r.phoneE164, email: r.email, curp: r.curp,
    birthDate: iso(r.birthDate), joinedAt: iso(r.joinedAt), periodEnd: iso(r.periodEnd),
    legacyCode: r.legacyCode, branchLabel: r.branchLabel, planLabel: r.planLabel, notes: r.notes,
    balanceCents: r.balanceCents?.toString() ?? null, problems: r.problems,
    kind: r.kind, matchMemberId: r.matchMemberId, matchRowId: r.matchRowId, matchScore: r.matchScore, matchReason: r.matchReason,
    decision: r.decision, decidedAt: r.decidedAt?.toISOString() ?? null,
    appliedMemberId: r.appliedMemberId, appliedAt: r.appliedAt?.toISOString() ?? null, applyNote: r.applyNote,
    // El saldo que esta fila de verdad cargó; null si no cargó (D18-01).
    balanceLoadedCents: r.balanceLoadedCents?.toString() ?? null,
    doubtful: r.doubtful, dataStatus: r.dataStatus, dataDecidedAt: r.dataDecidedAt?.toISOString() ?? null,
  };
}
