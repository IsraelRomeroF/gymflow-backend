import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict, DomainError, forbidden, MODULES, notFound, validation } from '@gymflow/core';
import { GymProfile } from '@gymflow/core/contracts';
import { AuditService } from '../../platform/audit/audit.service.js';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { ModuleStateRepository } from '../../platform/modules/module-state.repository.js';
import { BranchRepository } from './branch.repository.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { OrganizationRepository } from './organization.repository.js';
import { registerModuleRoutes } from './modules.routes.js';
import { SetupRepository } from './setup.repository.js';

const idParam = z.object({ id: z.string().uuid() });

/** ¿El servidor sabe calcular la hora en esa zona? Una inventada rompía el corte y las clases. */
function zonaConocida(zona: string): boolean {
  try {
    new Intl.DateTimeFormat('es-MX', { timeZone: zona });
    return true;
  } catch {
    return false;
  }
}

/**
 * Zona de la sede. Vacía o `null` = hereda la del gimnasio (19-10): si la
 * plataforma corrige la zona de la marca, la sede la sigue.
 */
const zonaDeSede = () => z.string().trim().max(60).refine((v) => !v || zonaConocida(v), 'Zona horaria desconocida').nullish();

const lista = (nombres: readonly string[]) => new Intl.ListFormat('es', { type: 'conjunction' }).format(nombres);

export function registerOrganizationRoutes(app: FastifyInstance): void {
  const audit = new AuditService();
  registerModuleRoutes(app);

  /**
   * ASISTENTE DE PRIMER ARRANQUE (ADR-038): qué le falta a una marca para
   * operar, paso por paso y con a dónde ir. Lo lee la gerencia nueva en su
   * inicio hasta que todo lo obligatorio está listo.
   */
  route(app, {
    method: 'GET',
    url: '/organization/setup',
    security: { kind: 'session' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const [c, flags] = await Promise.all([new SetupRepository(ctx.tenant.organizationId).conteos(), new OrganizationRepository(ctx.tenant.organizationId).setupFlags()]);
      const activos = ctx.modules?.org ?? new Set<string>();
      // Una sucursal con Caja apagada no necesita caja registradora.
      const sinCaja = c.sedesSinCaja.filter((id) => ctx.modules?.at(id).has('cash') ?? true).length;
      const textos = c.textosPublicados.has('PRIVACY_NOTICE') && c.textosPublicados.has('HOUSE_RULES');
      // Gimnasio de una persona y media (DP-07): si el gerente atiende el mostrador, no hace falta cuenta de recepción.
      const mostrador = c.recepcion > 0 || flags.managerAttendsFrontDesk;
      const pasos = [
        { key: 'textos', required: true, done: textos, href: '/consentimientos', permission: 'settings:consent:manage' as const, title: 'Publicar el Aviso de privacidad y el Reglamento', text: textos ? 'Publicados: ya se pueden firmar altas.' : 'Sin ellos no se puede dar de alta a nadie: el socio firma al inscribirse.' },
        { key: 'planes', required: true, done: c.planes > 0, href: '/planes', permission: 'catalog:manage' as const, title: 'Crear los planes y sus precios', text: c.planes > 0 ? `${c.planes} ${c.planes === 1 ? 'plan activo' : 'planes activos'}.` : 'Mensualidad, visitas, pase del día: lo que se vende en el mostrador.' },
        ...(activos.has('cash') ? [{ key: 'caja', required: true, done: sinCaja === 0, href: '/sucursales', permission: 'settings:branch' as const, title: 'Una caja en cada sucursal', text: sinCaja === 0 ? 'Todas las sucursales tienen caja.' : `${sinCaja} ${sinCaja === 1 ? 'sucursal sin caja' : 'sucursales sin caja'}: sin caja no se cobra en efectivo.` }] : []),
        { key: 'personal', required: true, done: mostrador, href: '/personal', permission: 'staff:manage' as const, title: 'Dar de alta a quien atiende el mostrador',
          text: c.recepcion > 0 ? `${c.recepcion} ${c.recepcion === 1 ? 'cuenta de recepción' : 'cuentas de recepción'}.` : flags.managerAttendsFrontDesk ? 'El gerente atiende el mostrador.' : 'Recepción entra con su propia cuenta; si el gerente atiende, márcalo aquí.' },
        ...(activos.has('classes') ? [{ key: 'clases', required: false, done: c.horarios > 0, href: '/clases', permission: 'classes:manage' as const, title: 'Armar el horario de clases', text: c.horarios > 0 ? `${c.horarios} ${c.horarios === 1 ? 'horario' : 'horarios'}.` : 'Las clases del día se generan desde el horario.' }] : []),
        ...(activos.has('pos') ? [{ key: 'productos', required: false, done: c.productos > 0, href: '/productos', permission: 'pos:product:manage' as const, title: 'Dar de alta los productos', text: c.productos > 0 ? `${c.productos} ${c.productos === 1 ? 'producto' : 'productos'}.` : 'Agua, suplementos, toallas: lo que se vende en el punto de venta.' }] : []),
        ...(activos.has('intake') ? [{ key: 'alta', required: false, done: c.enlaces > 0, href: '/sucursales', permission: 'settings:branch' as const, title: 'Enlace corto del alta digital', text: c.enlaces > 0 ? 'Listo para Instagram y WhatsApp.' : 'Cada sucursal puede tener su enlace: /alta/tu-gimnasio.' }] : []),
        // Para quien viene de otro sistema (DP-07): el padrón se importa, no se recaptura.
        { key: 'importar', required: false, done: c.importados > 0, href: '/importar', permission: 'members:import' as const, title: 'Importar la base de socios', text: c.importados > 0 ? `${c.importados} ${c.importados === 1 ? 'socio trae' : 'socios traen'} su código del sistema anterior.` : 'Si vienes de otro sistema, sube el archivo y revisa los duplicados antes de aplicar.' },
        { key: 'dueno', required: false, done: c.duenoEntro, href: '/personal', permission: 'staff:manage' as const, title: 'El dueño ya entró y cambió su contraseña', text: c.duenoEntro ? 'El dueño ya entró con su propia contraseña.' : 'Hasta que entre, nadie puede dar la segunda firma.' },
      ].map((p) => ({ ...p, canAct: request.holds(p.permission, null) }));
      const obligatorios = pasos.filter((p) => p.required);
      return {
        complete: obligatorios.every((p) => p.done), required: obligatorios.length, requiredDone: obligatorios.filter((p) => p.done).length, steps: pasos,
        // La tarjeta se muestra a quien puede resolver algo pendiente, no solo a quien tiene settings:org (DP-07).
        canAct: pasos.some((p) => !p.done && p.canAct),
      };
    },
  });
  /** Gimnasio de una persona y media: el gerente atiende el mostrador y no hay cuenta de recepción (DP-07). */
  route(app, {
    method: 'PUT',
    url: '/organization/setup/front-desk',
    security: { kind: 'permission', permission: 'settings:org' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { managerAttendsFrontDesk } = z.object({ managerAttendsFrontDesk: z.boolean() }).parse(request.body);
      request.requirePermission('settings:org', null);
      await new OrganizationRepository(ctx.tenant.organizationId).setSetupFlag('managerAttendsFrontDesk', managerAttendsFrontDesk);
      await audit.record(ctx, { action: 'settings.setup.update', resourceType: 'Organization', resourceId: ctx.tenant.organizationId, afterState: { managerAttendsFrontDesk } });
      return { managerAttendsFrontDesk };
    },
  });

  route(app, {
    method: 'GET',
    url: '/organization',
    security: { kind: 'session' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const org = await new OrganizationRepository(ctx.tenant.organizationId).current();
      if (!org) throw notFound('Organización no encontrada');
      return org;
    },
  });

  /**
   * «MI GIMNASIO» · DATOS (D-27): lo que la plataforma administra de la marca
   * —nombres, zona, moneda, a quién se le cobra— y lo que tiene contratado
   * (19-09). Solo consulta: desde el panel no se cambia nada, se le pide a
   * GymFlow. Lo ven la dueña y la gerencia que configura el gimnasio.
   */
  route(app, {
    method: 'GET',
    url: '/organization/profile',
    security: { kind: 'session' },
    schema: respuesta(200, GymProfile),
    handler: async (request): Promise<GymProfile> => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      // La dueña (lleva la llave) y quien configura el gimnasio o alguna sede; recepción y coach, no.
      if (!request.holds('settings:org', null) && request.branchScope('settings:branch')?.length === 0 && !request.holds('staff:unlock', null)) {
        throw forbidden('Los datos del gimnasio los consultan la dueña y la gerencia');
      }
      const repo = new OrganizationRepository(orgId);
      const [org, acceso, arranque, privacidad, contratos, sedes] = await Promise.all([
        repo.profile(), repo.accessSettings(), repo.setupFlags(), repo.privacySettings(),
        new ModuleStateRepository(orgId).entitlements(), new BranchRepository(orgId).list(),
      ]);
      if (!org) throw notFound('Organización no encontrada');
      const opcionales = MODULES.filter((m) => m.kind === 'optional');
      const contratados = opcionales.filter((m) => contratos.get(m.key) !== false);
      const delPlan = new Set(org.plan?.moduleKeys ?? []);
      return {
        tradeName: org.tradeName, legalName: org.legalName, timezone: org.timezone, defaultCurrency: org.defaultCurrency,
        billingEmail: org.billingEmail, activatedAt: org.activatedAt?.toISOString() ?? null,
        plan: {
          // Sin plan: contrato a la medida, módulo por módulo (ADR-039).
          name: org.plan?.name ?? null, description: org.plan?.description ?? null,
          included: contratados.filter((m) => !org.plan || delPlan.has(m.key)).map((m) => m.name),
          addOns: org.plan ? contratados.filter((m) => !delPlan.has(m.key)).map((m) => m.name) : [],
          notContracted: opcionales.filter((m) => contratos.get(m.key) === false).map((m) => m.name),
        },
        rules: {
          allowAccessWhilePastDue: acceso.allowAccessWhilePastDue,
          managerAttendsFrontDesk: arranque.managerAttendsFrontDesk,
          monthsAfterArchive: privacidad.monthsAfterArchive,
        },
        branches: { open: sedes.filter((b) => b.isActive).length, closed: sedes.filter((b) => !b.isActive).length },
      };
    },
  });

  route(app, {
    method: 'GET',
    url: '/branches',
    security: { kind: 'session' },
    handler: async (request) => {
      const ctx = request.ctx!;
      return new BranchRepository(ctx.tenant.organizationId).list();
    },
  });

  route(app, {
    method: 'GET',
    url: '/branches/:id',
    security: { kind: 'session' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const branch = await new BranchRepository(ctx.tenant.organizationId).findById(id);
      // Un id de otra organización cae aquí: 404, nunca 403.
      if (!branch) throw notFound('Sucursal no encontrada');
      return branch;
    },
  });

  /**
   * Abrir una sucursal. El código es corto y sus tres primeras letras son el
   * prefijo de los socios de esa sede (CEN-00042): por eso no puede repetir
   * ni el código ni el prefijo de otra sede viva.
   */
  route(app, {
    method: 'POST',
    url: '/branches',
    security: { kind: 'permission', permission: 'settings:org' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = z.object({
        code: z.string().trim().regex(/^[A-Za-z]{3}[A-Za-z0-9]{0,5}$/, 'De 3 a 8 caracteres, empezando con 3 letras'),
        name: z.string().trim().min(2).max(80),
        addressLine: z.string().trim().max(200).nullish().transform((v) => v || null),
        timezone: zonaDeSede().transform((v) => v || null),
      }).parse(request.body);
      request.requirePermission('settings:org', null);
      const repo = new BranchRepository(ctx.tenant.organizationId);
      const choque = await repo.codeClash(body.code);
      if (choque === 'CODE') throw conflict('Ya hay una sucursal con ese código');
      if (choque === 'PREFIX') throw conflict(`Otra sucursal ya usa el prefijo ${body.code.slice(0, 3).toUpperCase()} para sus socios: cambia las tres primeras letras`);
      const b = await repo.create(body);
      await audit.record(ctx, { action: 'branch.create', resourceType: 'Branch', resourceId: b.id, branchId: b.id, afterState: { code: b.code, name: b.name } });
      return reply.status(201).send(b);
    },
  });

  /** Qué se lleva por delante cerrar la sede: socios de casa, membresías vigentes, cajas abiertas, horarios y personal asignado (DP-09, 19-06). */
  route(app, {
    method: 'GET',
    url: '/branches/:id/closing-summary',
    security: { kind: 'permission', permission: 'settings:org' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      // Cerrar una sede es decisión de la organización: ver sus conteos también.
      request.requirePermission('settings:org', null);
      const repo = new BranchRepository(ctx.tenant.organizationId);
      if (!(await repo.findById(id))) throw notFound('Sucursal no encontrada');
      return repo.closingSummary(id);
    },
  });

  route(app, {
    method: 'PATCH',
    url: '/branches/:id',
    security: { kind: 'permission', permission: 'settings:branch' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        name: z.string().trim().min(2).max(80).optional(),
        addressLine: z.string().trim().max(200).nullish().transform((v) => (v === undefined ? undefined : v || null)),
        timezone: zonaDeSede().transform((v) => (v === undefined ? undefined : v || null)),
        isActive: z.boolean().optional(),
        // El enlace público del alta: `/alta/fuerza-centro` (UXB-14).
        publicSlug: z.string().trim().toLowerCase().max(40)
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Solo letras sin acento, números y guiones').nullish()
          .transform((v) => (v === undefined ? undefined : v || null)),
        // Cerrar (o reabrir) una sede dice por qué, como apagar un módulo (19-06).
        reason: z.string().trim().max(300).optional(),
      }).parse(request.body);
      request.requirePermission('settings:branch', id);
      // Cerrar una sede es decisión de la organización, no de su gerente.
      if (body.isActive !== undefined) request.requirePermission('settings:org', null);
      const repo = new BranchRepository(ctx.tenant.organizationId);
      const antes = await repo.findById(id);
      if (!antes) throw notFound('Sucursal no encontrada');
      const { reason, ...cambios } = body;
      if (cambios.isActive === false && antes.isActive) {
        if (!reason || reason.length < 3) throw validation('Escribe el motivo para cerrar la sucursal: queda en la bitácora');
        const resumen = await repo.closingSummary(id);
        // Con una caja abierta no se cierra (DP-09): quedaría un turno sin corte posible.
        if (resumen.openCashSessions > 0) throw conflict(`La sucursal tiene ${resumen.openCashSessions} ${resumen.openCashSessions === 1 ? 'caja abierta' : 'cajas abiertas'}: haz el corte antes de cerrarla`);
        // Ni con personal asignado (D19-03): entraría a una sede que ya no aparece para vender ni cobrar.
        if (resumen.staff.length > 0) {
          const nombres = resumen.staff.map((p) => p.fullName);
          throw new DomainError('CONFLICT', `Antes de cerrar ${antes.name}, quítale esta sucursal o da de baja a ${lista(nombres)} en Personal: nadie debe quedar asignado a una sucursal cerrada.`, 'BRANCH_HAS_STAFF');
        }
        // Ni con socios que ya apartaron su lugar ahí (fase 2 · 2.7): igual que al dejar de usar Clases en la sede.
        if (resumen.classBlockers.length > 0) {
          throw new DomainError('CONFLICT', `En ${antes.name} hay ${lista(resumen.classBlockers)}: cancela esas clases desde Clases (los socios reciben su aviso) y vuelve a cerrarla.`, 'BRANCH_HAS_BOOKINGS');
        }
      }
      const patch = Object.fromEntries(Object.entries(cambios).filter(([, v]) => v !== undefined));
      let b;
      try {
        b = await repo.update(id, patch);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('Ese enlace ya lo usa otra sucursal: elige otro');
        throw err;
      }
      await audit.record(ctx, { action: 'branch.update', resourceType: 'Branch', resourceId: id, branchId: id, reason: reason || null, beforeState: antes, afterState: b });
      return b;
    },
  });
}
