import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ASSIGNABLE_ROLES, onlyEffectiveSections, MODULES, MODULE_BY_KEY, MODULE_GROUPS, MODULE_TEMPLATES, auditLabel, esFechaDeCalendario, isRoleKey, normalizePhoneMx, notFound, validation } from '@gymflow/core';
import {
  PlatformOrganizationCreated, PlatformOrganizationDetail, PlatformOrganizationList, PlatformServiceChanged, PlatformUserCreated,
} from '@gymflow/core/contracts';
import { readFileSync } from 'node:fs';
import { AuditService } from '../../platform/audit/audit.service.js';
import { platformActor } from '../../platform/audit/audit.routes.js';
import { PlatformAuditService } from '../../platform/audit/platform-audit.service.js';
import { opcionesDeCookie } from '../../platform/http/sesion.js';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { telefonoMx } from '../../platform/http/phone.js';
import { moduleViewOf } from '../../platform/modules/module-state.js';
import { TenantRepository } from './tenant.repository.js';
import { TenantService } from './tenant.service.js';
import { FORMAS_DE_PAGO, PIDE_REFERENCIA, PlatformBillingService } from './platform-billing.service.js';
import { diaDeCobroDe, esMes } from './cobro-reglas.js';
import { PlatformPlanRepository } from './platform-plan.repository.js';
import type { Env } from '../../platform/env.js';

const persona = z.object({
  fullName: z.string().trim().min(3).max(120),
  email: z.string().trim().email().max(160),
  phone: telefonoMx().optional().nullable(),
});

/** ¿El sistema conoce esa zona horaria (IANA)? Con una mal escrita, «hoy», el corte y los vencimientos del gimnasio fallarían. */
const esZona = (zona: string): boolean => {
  try { new Intl.DateTimeFormat('es-MX', { timeZone: zona }); return true; } catch { return false; }
};
const zonaHoraria = z.string().trim().min(3).max(60).refine(esZona, 'No es una zona horaria válida; por ejemplo America/Mexico_City o America/Tijuana');

const altaBody = z.object({
  legalName: z.string().trim().min(3).max(160),
  tradeName: z.string().trim().min(2).max(80),
  /** La zona del gimnasio (22-02): la consola la pide en el primer paso del alta. */
  timezone: zonaHoraria.default('America/Mexico_City'),
  /**
   * Un atajo de contratación (22-01): sin plan y sin `contracted`, lo contratado
   * es lo que trae la plantilla. Ya no decide nada más: contratado = encendido.
   */
  template: z.string().min(2).max(40).nullable().optional(),
  /** Plan de la plataforma contratado (ADR-039). */
  planId: z.string().uuid().nullable().optional(),
  /** Módulos opcionales contratados (sin plan) o agregados al plan. Sin lista, sin plan y sin plantilla: todos. */
  contracted: z.array(z.string().min(2).max(40)).max(20).optional(),
  /** «Liberar al terminar» (22-11): la marca nace en uso. Apagado por omisión: nace sin liberar. */
  releaseNow: z.boolean().optional(),
  branch: z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z]{3,6}$/, 'De 3 a 6 letras'),
    name: z.string().trim().min(2).max(80),
    addressLine: z.string().trim().max(200).optional().nullable(),
    timezone: zonaHoraria.optional().nullable(),
  }),
  owner: persona,
  /**
   * Las demás cuentas del arranque, las que la plataforma quiera (0 a 12):
   * gerencia, recepción o coach. Sin gerente, el dueño administra al personal.
   */
  staff: z.array(persona.extend({ role: z.enum(['MANAGER', 'RECEPTION', 'COACH']) })).max(12).optional(),
  /** Forma anterior (un gerente y una o dos recepciones); se acepta igual: la usan pruebas de otros módulos. La consola manda `staff`. */
  manager: persona.optional(),
  receptionists: z.array(persona).max(2).optional(),
  reason: z.string().trim().min(3).max(300),
});

const idParam = z.object({ id: z.string().uuid() });
/** `AAAA-MM`, con el mes del 01 al 12. */
const mes = z.string().refine(esMes, 'Escribe el mes como AAAA-MM');
/** Centavos enteros, como texto (un importe no viaja como número con decimales). */
const centavos = z.string().regex(/^\d{1,12}$/, 'Escribe el importe en centavos, solo con dígitos');
const segundosHasta = (d: Date) => Math.max(0, Math.ceil((d.getTime() - Date.now()) / 1000));
const instante = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * PLATAFORMA · MARCAS. Quien opera GymFlow da de alta el siguiente gimnasio
 * y lo acompaña: ve cuántas sedes y socios tiene, quién entra al panel y
 * puede darle una contraseña temporal a quien se quedó fuera. No ve ni toca
 * la operación del gimnasio: eso es de su personal.
 */
/** Versión desplegada: lo primero que soporte pregunta. */
const VERSION: string = (() => {
  try { return (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0'; } catch { return '0.0.0'; }
})();

export function registerTenantRoutes(app: FastifyInstance, env: Env): void {
  const service = new TenantService();
  const repo = new TenantRepository();
  const cobro = new PlatformBillingService();
  const planes = new PlatformPlanRepository();
  /** La cadena de plataforma: lo que solo pasa en la consola se asienta aquí (24-19, 23-09). */
  const cadena = new PlatformAuditService();
  const planPlano = (p: Awaited<ReturnType<PlatformPlanRepository['find']>> & object) => ({ ...p, monthlyCents: p.monthlyCents?.toString() ?? null, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() });

  /** Quién soy, más los catálogos que la consola necesita: plantillas, módulos, puestos y planes vigentes. */
  route(app, {
    method: 'GET',
    url: '/platform/me',
    security: { kind: 'platform', temporal: true },
    handler: async (request) => {
      // Desde cuándo y hasta cuándo vale esta sesión: la consola avisa antes de su tope (24-04).
      const sesion = await app.auth.sesionActual(request.platform!.sessionId);
      return {
      ...request.platform!,
      stepUpUntil: request.platform!.stepUpUntil?.toISOString() ?? null,
      session: sesion ? { startedAt: sesion.startedAt.toISOString(), endsAt: sesion.endsAt.toISOString(), secondsLeft: segundosHasta(sesion.endsAt) } : null,
      templates: MODULE_TEMPLATES,
      modules: MODULES.map((m) => ({ key: m.key, name: m.name, kind: m.kind })),
      roles: ASSIGNABLE_ROLES.map((r) => ({ key: r.key, name: r.name, description: r.description, sees: r.sees, scope: r.scope })),
      plans: (await planes.list()).filter((p) => p.isActive).map(planPlano),
      };
    },
  });

  // ── Seguridad de la cuenta de plataforma ───────────────────────────────────

  /** Reconfirmar con la contraseña: habilita las acciones críticas unos minutos en esta sesión. */
  route(app, {
    method: 'POST',
    url: '/platform/reauth',
    security: { kind: 'platform', reconfirm: false },
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    handler: async (request) => {
      const { password } = z.object({ password: z.string().min(1, 'Escribe tu contraseña') }).parse(request.body);
      const p = request.platform!;
      const until = await app.auth.stepUp(p.sessionId, p.userId, password);
      await cadena.record(platformActor(request), { action: 'platform.console.reauth', resourceType: 'User', resourceId: p.userId });
      return { stepUpUntil: until.toISOString() };
    },
  });

  /**
   * Cambiar la contraseña (la temporal se cambia aquí). Cierra las demás
   * sesiones. Igual que en el panel: en el cambio obligatorio no se manda
   * `current`, y la longitud mínima es la misma para todos (24-10).
   */
  route(app, {
    method: 'POST',
    url: '/platform/password',
    security: { kind: 'platform', reconfirm: false, temporal: true },
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    handler: async (request) => {
      const body = z.object({ current: z.string().min(1).optional(), next: z.string() }).parse(request.body);
      const p = request.platform!;
      const { obligatorio } = await app.auth.changePassword(p.userId, body.current, body.next, p.sessionId);
      await cadena.record(platformActor(request), {
        action: 'platform.console.password_change', resourceType: 'User', resourceId: p.userId,
        ...(obligatorio ? { afterState: { forced: true } } : {}),
      });
      return { ok: true };
    },
  });

  route(app, {
    method: 'POST',
    url: '/platform/logout',
    security: { kind: 'platform', reconfirm: false, temporal: true },
    handler: async (request, reply) => {
      await app.auth.logout(request.platform!.sessionId);
      await cadena.record(platformActor(request), { action: 'platform.console.logout', resourceType: 'User', resourceId: request.platform!.userId });
      // Los mismos `path` y `domain` con que se puso: con `SESSION_COOKIE_DOMAIN`, sin ellos no se borraba.
      reply.clearCookie('gf_session', opcionesDeCookie(request, env));
      return reply.send({ status: 'LOGGED_OUT' });
    },
  });

  /** Cerrar las demás sesiones de esta cuenta (un equipo olvidado, una sospecha). */
  route(app, {
    method: 'POST',
    url: '/platform/sessions/close-others',
    security: { kind: 'platform', reconfirm: false },
    handler: async (request) => {
      const p = request.platform!;
      const n = await app.auth.logoutOthers(p.userId, p.sessionId);
      await cadena.record(platformActor(request), { action: 'platform.console.sessions_close_others', resourceType: 'User', resourceId: p.userId, afterState: { closed: n } });
      return { closed: n };
    },
  });

  /** Seguridad: sus sesiones y las cuentas de plataforma. Lo que la plataforma hizo se lee de su cadena (`GET /platform/audit`). */
  route(app, {
    method: 'GET',
    url: '/platform/security',
    security: { kind: 'platform' },
    handler: async (request) => {
      const p = request.platform!;
      const [sesiones, cuentas] = await Promise.all([app.auth.listSessions(p.userId), repo.cuentasPlataforma()]);
      return {
        policy: {
          sessionHours: env.PLATFORM_SESSION_HOURS, idleMinutes: env.PLATFORM_IDLE_MINUTES,
          stepUpMinutes: env.PLATFORM_STEP_UP_MINUTES, allowedIps: env.platformAllowedIps,
        },
        sessions: sesiones.map((x) => ({ ...x, current: x.id === p.sessionId, createdAt: x.createdAt.toISOString(), lastSeenAt: x.lastSeenAt.toISOString(), expiresAt: x.expiresAt.toISOString() })),
        accounts: cuentas.map((c) => ({ ...c, lastLoginAt: c.lastLoginAt?.toISOString() ?? null, locked: !!c.lockedUntil && c.lockedUntil > new Date(), lockedUntil: undefined })),
      };
    },
  });

  // ── Planes de la plataforma (ADR-039) ──────────────────────────────────────
  const planBody = z.object({
    name: z.string().trim().min(2, 'Escribe el nombre del plan').max(80),
    description: z.string().trim().max(300).nullable().optional(),
    modules: z.array(z.string().min(2).max(40)).max(20),
    monthlyCents: centavos.nullable().optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  });
  /** Lo que el asiento guarda de un plan: nombre, precio, módulos y si se ofrece. */
  const estadoDePlan = (p: { name: string; monthlyCents: bigint | null; modules: string[]; isActive: boolean }) => ({
    name: p.name, monthlyCents: p.monthlyCents?.toString() ?? null, ...(p.monthlyCents !== null ? { amountCents: p.monthlyCents.toString() } : {}),
    modules: p.modules, isActive: p.isActive,
  });
  const modulosValidos = (keys: string[]) => {
    for (const k of keys) {
      const def = MODULE_BY_KEY.get(k);
      if (!def) throw validation(`Módulo desconocido: ${k}`);
      if (def.kind !== 'optional') throw validation(`${def.name} es parte de lo básico: todo plan lo incluye`);
    }
    return [...new Set(keys)];
  };

  route(app, {
    method: 'GET',
    url: '/platform/plans',
    security: { kind: 'platform' },
    handler: async () => ({ plans: (await planes.list()).map(planPlano) }),
  });

  route(app, {
    method: 'POST',
    url: '/platform/plans',
    security: { kind: 'platform' },
    handler: async (request, reply) => {
      const body = planBody.parse(request.body);
      const plan = await planes.create({
        name: body.name, description: body.description ?? null, modules: modulosValidos(body.modules),
        monthlyCents: body.monthlyCents ? BigInt(body.monthlyCents) : null, sortOrder: body.sortOrder ?? 0,
      });
      await cadena.record(platformActor(request), {
        action: 'platform.catalog.plan.create', resourceType: 'PlatformPlan', resourceId: plan.id,
        afterState: estadoDePlan(plan),
      });
      return reply.status(201).send(planPlano(plan));
    },
  });

  route(app, {
    method: 'PUT',
    url: '/platform/plans/:id',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const body = planBody.partial().extend({ isActive: z.boolean().optional() }).parse(request.body);
      const antes = await planes.find(id);
      if (!antes) throw notFound('Plan no encontrado');
      const plan = await planes.update(id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.modules !== undefined ? { modules: modulosValidos(body.modules) } : {}),
        ...(body.monthlyCents !== undefined ? { monthlyCents: body.monthlyCents ? BigInt(body.monthlyCents) : null } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      });
      if (!plan) throw notFound('Plan no encontrado');
      // Qué costaba y qué incluía antes, y cómo quedó (23-09): un plan cambia lo que pagan sus marcas.
      await cadena.record(platformActor(request), {
        action: 'platform.catalog.plan.update', resourceType: 'PlatformPlan', resourceId: plan.id,
        beforeState: estadoDePlan(antes), afterState: estadoDePlan(plan),
      });
      return planPlano(plan);
    },
  });

  /**
   * Las marcas, cada una con su uso, su estado de cobro y su último cierre.
   * Todo se carga para todas a la vez (22-15): el número de consultas ya no
   * crece con el número de marcas (`perf/medir.test.ts` le pone tope fijo).
   */
  route(app, {
    method: 'GET',
    url: '/platform/organizations',
    security: { kind: 'platform' },
    schema: respuesta(200, PlatformOrganizationList),
    handler: async () => {
      const [marcas, panorama, precios] = await Promise.all([repo.marcas(), cobro.panorama(), cobro.prices()]);
      // Salud de cada marca para la bandeja "Requiere atención" (UX7 Plataforma):
      // el último cierre diario, si falló algo y si la bitácora sigue íntegra.
      const cierres = await repo.ultimosCierres(marcas.map((m) => m.id));
      return {
        // Cuánto factura GymFlow al mes si todas las marcas en uso pagan (DP-03).
        monthlyIncomeCents: panorama.monthlyIncome.totalCents.toString(),
        // La bandeja y «Primeros pasos» ya no piden los precios aparte (22-15).
        pricesMissing: precios.filter((x) => x.monthlyCents === null).length,
        organizations: marcas.map((m) => {
          // El MISMO estado de cobro que la ficha (23-02): la lista y la bandeja ya no lo derivan por su cuenta.
          const estado = panorama.status.get(m.id);
          const cierre = cierres.get(m.id);
          return {
            ...m,
            serviceStatus: m.serviceStatus as 'PENDING' | 'ACTIVE' | 'SUSPENDED',
            createdAt: m.createdAt.toISOString(), activatedAt: instante(m.activatedAt), suspendedAt: instante(m.suspendedAt),
            lastActivityAt: instante(m.lastActivityAt), lastStaffLoginAt: instante(m.lastStaffLoginAt),
            billing: { status: estado?.code ?? 'SIN_COBRO', pendingCents: (estado?.pendingCents ?? 0n).toString(), overdueDays: estado?.overdueDays ?? 0 },
            lastDailyRun: cierre ? { at: cierre.at.toISOString(), failed: cierre.failed, chain: cierre.chain } : null,
          };
        }),
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/platform/organizations',
    security: { kind: 'platform' },
    schema: respuesta(201, PlatformOrganizationCreated),
    handler: async (request, reply) => {
      const body = altaBody.parse(request.body);
      const tel = (p: z.infer<typeof persona>) => ({ fullName: p.fullName, email: p.email, phoneE164: p.phone ? normalizePhoneMx(p.phone) : null });
      const creado = await service.crear({
        legalName: body.legalName, tradeName: body.tradeName, timezone: body.timezone, template: body.template ?? null, planId: body.planId ?? null, contracted: body.contracted,
        releaseNow: body.releaseNow === true,
        branch: { code: body.branch.code, name: body.branch.name, addressLine: body.branch.addressLine ?? null, timezone: body.branch.timezone ?? null },
        owner: tel(body.owner),
        staff: body.staff
          ? body.staff.map((p) => ({ ...tel(p), roleKey: p.role }))
          : [...(body.manager ? [{ ...tel(body.manager), roleKey: 'MANAGER' as const }] : []), ...(body.receptionists ?? []).map((p) => ({ ...tel(p), roleKey: 'RECEPTION' as const }))],
      }, request.platform!.userId, body.reason);
      return reply.status(201).send(creado);
    },
  });

  route(app, {
    method: 'GET',
    url: '/platform/organizations/:id',
    security: { kind: 'platform' },
    schema: respuesta(200, PlatformOrganizationDetail),
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const marca = await repo.marca(id);
      if (!marca) throw notFound('Marca no encontrada');
      const vista = await moduleViewOf(id);
      return {
        ...marca,
        serviceStatus: marca.serviceStatus as 'PENDING' | 'ACTIVE' | 'SUSPENDED',
        createdAt: marca.createdAt.toISOString(), activatedAt: instante(marca.activatedAt), suspendedAt: instante(marca.suspendedAt),
        users: marca.users.map((u) => ({ ...u, lastLoginAt: instante(u.lastLoginAt), platformSections: Array.isArray(u.platformSections) ? (u.platformSections as string[]) : null })),
        modules: MODULES.filter((m) => m.kind === 'optional').map((m) => ({
          key: m.key, name: m.name, description: m.description, groupName: m.group ? MODULE_GROUPS[m.group] : null,
          contracted: vista.contracted(m.key), enabled: vista.org.has(m.key),
          /** Si viene con el plan contratado (lo demás contratado es un agregado). */
          inPlan: marca.plan?.modules.includes(m.key) ?? false,
        })),
      };
    },
  });

  const motivo = z.object({ reason: z.string().trim().min(3, 'Escribe el motivo: queda en la bitácora').max(300) });

  /** Corregir los datos de la marca. */
  route(app, {
    method: 'PUT',
    url: '/platform/organizations/:id',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const body = motivo.extend({
        legalName: z.string().trim().min(3).max(160).optional(),
        tradeName: z.string().trim().min(2).max(80).optional(),
        timezone: zonaHoraria.optional(),
        billingEmail: z.string().trim().email().max(160).nullable().optional(),
      }).parse(request.body);
      const { reason, ...parcial } = body;
      // Solo lo que vino: un campo ausente no se toca.
      const datos = Object.fromEntries(Object.entries(parcial).filter(([, v]) => v !== undefined)) as Parameters<TenantService['editar']>[1];
      if (Object.keys(datos).length === 0) throw validation('No hay nada que cambiar');
      await service.editar(id, datos, request.platform!.userId, reason);
      return { ok: true };
    },
  });

  /** El plan contratado (ADR-039): al asignarlo, lo contratado pasa a ser lo que incluye. */
  route(app, {
    method: 'PUT',
    url: '/platform/organizations/:id/plan',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { planId, reason } = motivo.extend({ planId: z.string().uuid().nullable() }).parse(request.body);
      await service.asignarPlan(id, planId, request.platform!.userId, reason);
      return { ok: true };
    },
  });

  /**
   * Liberar el software a la marca, reanudarlo o suspenderlo. `ACTIVE` sobre una
   * marca suspendida es REANUDAR (22-07): queda como `platform.service.resume`
   * y no mueve la fecha de su primera liberación.
   */
  route(app, {
    method: 'POST',
    url: '/platform/organizations/:id/service',
    security: { kind: 'platform' },
    schema: respuesta(200, PlatformServiceChanged),
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { status, reason } = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().min(3, 'Escribe el motivo: queda en la bitácora').max(300) }).parse(request.body);
      const action = await service.cambiarServicio(id, status, request.platform!.userId, reason);
      return { ok: true as const, serviceStatus: status, action };
    },
  });

  /** Lo que la marca contrató. */
  route(app, {
    method: 'PUT',
    url: '/platform/organizations/:id/entitlements/:key',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { id, key } = z.object({ id: z.string().uuid(), key: z.string().min(2).max(40) }).parse(request.params);
      const { granted, reason } = z.object({ granted: z.boolean(), reason: z.string().trim().min(3).max(300) }).parse(request.body);
      await service.contratar(id, key, granted, request.platform!.userId, reason);
      return { ok: true };
    },
  });

  /** Una cuenta más para la marca con cualquier puesto del catálogo (ADR-039). */
  route(app, {
    method: 'POST',
    url: '/platform/organizations/:id/users',
    security: { kind: 'platform' },
    schema: respuesta(201, PlatformUserCreated),
    handler: async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = persona.extend({
        roleKey: z.string().refine(isRoleKey, 'Puesto desconocido'),
        branchIds: z.array(z.string().uuid()).max(50).nullable(),
        reason: z.string().trim().min(3).max(300),
      }).parse(request.body);
      const creada = await service.agregarCuenta(id, {
        fullName: body.fullName, email: body.email, phoneE164: body.phone ? normalizePhoneMx(body.phone) : null, roleKey: body.roleKey, branchIds: body.branchIds,
      }, request.platform!.userId, body.reason);
      return reply.status(201).send(creada);
    },
  });

  route(app, {
    method: 'POST',
    url: '/platform/organizations/:id/users/:userId/active',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { id, userId } = z.object({ id: z.string().uuid(), userId: z.string().uuid() }).parse(request.params);
      const { isActive, reason } = motivo.extend({ isActive: z.boolean() }).parse(request.body);
      await service.activarCuenta(id, userId, isActive, request.platform!.userId, reason);
      return { ok: true };
    },
  });

  /** Qué ve el dueño: el mismo modal de secciones que el dueño usa con su personal. */
  route(app, {
    method: 'PUT',
    url: '/platform/organizations/:id/users/:userId/sections',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { id, userId } = z.object({ id: z.string().uuid(), userId: z.string().uuid() }).parse(request.params);
      const body = motivo.extend({ sections: z.array(z.string().max(40)).max(40).nullable() }).parse(request.body);
      // Solo lo que tiene efecto para el Dueño (17-05): lo demás no hacía nada y no se guarda.
      const limpias = body.sections === null ? null : onlyEffectiveSections(body.sections, 'OWNER');
      await service.seccionesDelDueno(id, userId, limpias, request.platform!.userId, body.reason);
      return { ok: true, sections: limpias };
    },
  });

  route(app, {
    method: 'POST',
    url: '/platform/organizations/:id/users/:userId/password-reset',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { id, userId } = z.object({ id: z.string().uuid(), userId: z.string().uuid() }).parse(request.params);
      const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(request.body);
      return service.restablecerContrasena(id, userId, request.platform!.userId, reason);
    },
  });

  // ── Soporte sin abrir la base (DP-04) ──────────────────────────────────────

  /** Quién está dentro, si el cierre diario corrió, si la bitácora está íntegra y qué versión corre. */
  route(app, {
    method: 'GET',
    url: '/platform/organizations/:id/support',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      if (!(await repo.marca(id))) throw notFound('Marca no encontrada');
      const [soporte, cierres] = await Promise.all([repo.soporte(id), repo.ultimosCierres([id])]);
      const ultimo = cierres.get(id);
      return {
        version: { app: VERSION, gitSha: process.env.GIT_SHA ?? null, node: process.version },
        lastDailyRun: ultimo ? { at: ultimo.at.toISOString(), jobs: ultimo.jobs, failed: ultimo.failed, chain: ultimo.chain } : null,
        activeSessions: soporte.activeSessions.map((s) => ({ ...s, lastSeenAt: s.lastSeenAt.toISOString() })),
        staffLastLogin: soporte.staffLastLogin.map((u) => ({ ...u, lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null })),
      };
    },
  });

  /** Solo lo que la plataforma hizo sobre la marca: sin socios ni dinero del gimnasio (ADR-037). */
  route(app, {
    method: 'GET',
    url: '/platform/organizations/:id/audit',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
      if (!(await repo.marca(id))) throw notFound('Marca no encontrada');
      const entries = await new AuditService().list(id, { limit, actions: ['platform.'] });
      return {
        entries: entries.map((e) => ({
          id: e.id, at: e.at.toISOString(), action: e.action, reason: e.reason, phrase: auditLabel(e.action),
          afterState: e.afterState && typeof e.afterState === 'object' ? e.afterState : null,
        })),
      };
    },
  });

  // ── Cobro de la plataforma a las marcas (ADR-038; auditoría 8, bloque 1.13) ──

  /** Toda la cobranza en una pantalla (DP-03): ingreso mensual y facturas de todas las marcas, cada una con SU estado. */
  route(app, {
    method: 'GET',
    url: '/platform/billing',
    security: { kind: 'platform' },
    handler: async (request) => {
      const q = z.object({ status: z.enum(['PENDING', 'PAID', 'VOID']).optional(), month: mes.optional() }).parse(request.query);
      const [panorama, invoices] = await Promise.all([cobro.panorama(), cobro.facturas(q)]);
      const ingreso = panorama.monthlyIncome;
      return {
        /** El mes en curso en la Ciudad de México: el que «Emitir» propone (23-14). */
        month: panorama.month,
        monthlyIncome: { totalCents: ingreso.totalCents.toString(), organizations: ingreso.organizations, missingPrices: ingreso.missingPrices },
        /** Marcas en uso sin factura viva del mes en curso. */
        withoutInvoiceThisMonth: panorama.withoutInvoiceThisMonth,
        invoices,
      };
    },
  });

  /**
   * Lo que saldría al emitir ese mes (23-05): a quién, por cuánto y a quién se
   * salta y por qué. Es el mismo cálculo que hace la emisión. Con
   * `organizationId`, solo esa marca (el diálogo de la ficha).
   */
  route(app, {
    method: 'GET',
    url: '/platform/invoices/issue-month/preview',
    security: { kind: 'platform' },
    handler: async (request) => {
      const q = z.object({ month: mes.optional(), organizationId: z.string().uuid().optional() }).parse(request.query);
      return cobro.vistaPrevia(q);
    },
  });

  /** Emite el mes a todas las marcas en uso de una vez; el job del día 1 hace lo mismo. Una marca que falla no corta el lote. */
  route(app, {
    method: 'POST',
    url: '/platform/invoices/issue-month',
    security: { kind: 'platform' },
    handler: async (request) => {
      const body = z.object({ month: mes.optional() }).parse(request.body ?? {});
      return cobro.emitirMes(request.platform!.userId, body.month, new Date(), platformActor(request));
    },
  });

  route(app, {
    method: 'GET',
    url: '/platform/prices',
    security: { kind: 'platform' },
    handler: async () => ({ prices: await cobro.prices() }),
  });

  /** Varios precios de una vez: una transacción y un solo asiento con el antes y el después (23-09). */
  route(app, {
    method: 'PUT',
    url: '/platform/prices',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { prices } = z.object({
        prices: z.array(z.object({ key: z.string().min(2).max(40), monthlyCents: centavos })).min(1, 'No hay ningún precio que guardar').max(40),
      }).parse(request.body);
      const { changed } = await cobro.setPrices(prices.map((x) => ({ key: x.key, monthlyCents: BigInt(x.monthlyCents) })), platformActor(request));
      return { changed, prices: await cobro.prices() };
    },
  });

  route(app, {
    method: 'PUT',
    url: '/platform/prices/:key',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { key } = z.object({ key: z.string().min(2).max(40) }).parse(request.params);
      const { monthlyCents } = z.object({ monthlyCents: centavos }).parse(request.body);
      await cobro.setPrices([{ key, monthlyCents: BigInt(monthlyCents) }], platformActor(request));
      return { prices: await cobro.prices() };
    },
  });

  /** La mensualidad de hoy, las facturas, el estado de cobro de una marca y los meses que se le pueden facturar. */
  route(app, {
    method: 'GET',
    url: '/platform/organizations/:id/billing',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      return cobro.resumen(id);
    },
  });

  /** Emite a UNA marca, con las mismas reglas que el lote (23-06). El 409 trae `reason`. */
  route(app, {
    method: 'POST',
    url: '/platform/organizations/:id/invoices',
    security: { kind: 'platform' },
    handler: async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ month: mes.optional(), note: z.string().trim().max(300).optional() }).parse(request.body ?? {});
      const f = await cobro.emitir(id, request.platform!.userId, body);
      return reply.status(201).send(f);
    },
  });

  route(app, {
    method: 'GET',
    url: '/platform/invoices',
    security: { kind: 'platform' },
    handler: async () => ({ invoices: await cobro.pendientes() }),
  });

  /** Una factura con sus pagos (vivos y deshechos) y su marca. */
  route(app, {
    method: 'GET',
    url: '/platform/invoices/:id',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const f = await cobro.factura(id);
      if (!f) throw notFound('Factura no encontrada');
      const marca = await repo.marca(f.organizationId);
      return { ...f, organization: marca ? { tradeName: marca.tradeName, legalName: marca.legalName } : null };
    },
  });

  /**
   * Registrar un pago (23-08, 23-16): `amountCents` es lo que llegó (sin él,
   * lo que falta); la referencia es obligatoria en transferencia y tarjeta;
   * `paidOn` es el día en que llegó el dinero. `paidAt` (un instante) se
   * sigue aceptando: se toma su día en la Ciudad de México.
   */
  route(app, {
    method: 'POST',
    url: '/platform/invoices/:id/pay',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({
        amountCents: centavos.optional(),
        paymentMethod: z.enum(FORMAS_DE_PAGO),
        paymentRef: z.string().trim().max(120).optional(),
        paidOn: z.string().refine(esFechaDeCalendario, 'Escribe la fecha como AAAA-MM-DD').optional(),
        paidAt: z.coerce.date().optional(),
        note: z.string().trim().max(300).optional(),
      }).superRefine((b, ctx) => {
        if (PIDE_REFERENCIA.has(b.paymentMethod) && !b.paymentRef) {
          ctx.addIssue({ code: 'custom', path: ['paymentRef'], message: b.paymentMethod === 'CARD' ? 'Escribe la referencia: la autorización o los últimos dígitos de la tarjeta' : 'Escribe la referencia: la clave de rastreo del SPEI' });
        }
        if (b.amountCents !== undefined && BigInt(b.amountCents) <= 0n) ctx.addIssue({ code: 'custom', path: ['amountCents'], message: 'El importe debe ser mayor que cero' });
      }).parse(request.body);
      return cobro.pagar(id, request.platform!.userId, {
        amountCents: body.amountCents !== undefined ? BigInt(body.amountCents) : undefined,
        paidOn: body.paidOn ?? (body.paidAt ? diaDeCobroDe(body.paidAt) : undefined),
        paymentMethod: body.paymentMethod, paymentRef: body.paymentRef, note: body.note,
      });
    },
  });

  /** Deshacer un pago registrado por error (23-07): con motivo; la factura vuelve a deber ese importe. */
  route(app, {
    method: 'POST',
    url: '/platform/invoices/:id/payments/:paymentId/undo',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { id, paymentId } = z.object({ id: z.string().uuid(), paymentId: z.string().uuid() }).parse(request.params);
      const { reason } = motivo.parse(request.body);
      return cobro.deshacerPago(id, paymentId, request.platform!.userId, reason);
    },
  });

  route(app, {
    method: 'POST',
    url: '/platform/invoices/:id/void',
    security: { kind: 'platform' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = motivo.parse(request.body);
      return cobro.anular(id, request.platform!.userId, reason);
    },
  });
}
