import { randomBytes } from 'node:crypto';
import { nombrePersona } from '../../platform/http/person-name.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { conflict, DomainError, forbidden, notFound, PERMISSIONS, PERMISSION_BY_KEY, ROLE_BY_KEY, validation, type PermissionKey, isSectionToken, UNLOCK_EXEMPT_ROLES, normalizeUnlocked, ADJUSTABLE_PERMISSIONS, ADJUSTABLE_PERMISSION_GROUPS, ADJUSTABLE_ROLES, adjustableFor, normalizeOverrides, normalizePhoneMx } from '@gymflow/core';
import { route } from '../../platform/http/registry.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { telefonoMx } from '../../platform/http/phone.js';
import { StaffRepository, type StaffRow } from './staff.repository.js';
import { SessionRepository } from './session.repository.js';
import { GrantRepository } from './role.repository.js';
import { TEMPORAL_DIAS, temporalVencida } from './auth.service.js';
import { validarPuesto } from '../../platform/roles/puestos.js';
import { antesDeLaBaja } from '../../platform/staff/baja.js';

const idParam = z.object({ id: z.string().uuid() });

/** Contraseña temporal legible para dictarla: sin 0/O ni 1/l. */
function temporal(): string {
  // Sin parecidos: se dicta por teléfono (UX5-PL-03). 28⁸ ≈ 3.8·10¹¹ combinaciones, y se cambia al entrar.
  const abc = 'ACDEFGHJKMNPQRTUVWXYZ2345679';
  const t = [...randomBytes(8)].map((b) => abc[b % abc.length]).join('');
  return `GYM-${t.slice(0, 4)}-${t.slice(4, 8)}`;
}

/** El celular del personal, como el de los socios: 10 dígitos o nada (17-07). */
const celular = () => telefonoMx().nullish().transform((v) => (v ? normalizePhoneMx(v) : null));

/** Hasta cuándo vale su temporal: 7 días desde que se dio (o desde el alta, sin dato). */
function venceTemporal(u: StaffRow): Date | null {
  if (!u.mustChangePassword) return null;
  return new Date((u.passwordResetAt ?? u.createdAt).getTime() + TEMPORAL_DIAS * 86_400_000);
}

function serialize(u: StaffRow) {
  return {
    id: u.id, email: u.email, fullName: u.fullName, phoneE164: u.phoneE164, isActive: u.isActive,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    // El estado de la cuenta, para leerlo de un vistazo en Personal (UX5-G-08).
    mustChangePassword: u.mustChangePassword,
    // Vencida ya no abre (A4-N1): Personal dice «Temporal vencida», no «Aún no entra».
    temporaryExpiresAt: venceTemporal(u)?.toISOString() ?? null,
    temporaryExpired: temporalVencida(u),
    // Gerente nuevo al que la dueña aún no le decide qué ve (17-06).
    sectionsReviewPending: u.sectionsReviewPending,
    role: u.assignments[0] ? { key: u.assignments[0].roleKey, name: u.assignments[0].roleName } : null,
    // Lo que el dueño le liberó de Dirección y Cumplimiento; null = el dueño no tiene llave.
    unlockedSections: u.assignments.some((a) => UNLOCK_EXEMPT_ROLES.has(a.roleKey)) ? null : normalizeUnlocked(u.unlockedSections),
    // Ajustes sobre su puesto (recepción y coach); null = no se le ajusta. Solo
    // los que su puesto admite: uno viejo que ya no le toca no se muestra (17-02).
    permissionOverrides: (() => {
      const puesto = u.assignments.find((a) => ADJUSTABLE_ROLES.has(a.roleKey))?.roleKey;
      return puesto ? normalizeOverrides(u.permissionOverrides, puesto) : null;
    })(),
    // Vacío = toda la organización.
    branchIds: u.assignments.some((a) => a.branchId === null) ? [] : u.assignments.map((a) => a.branchId as string),
  };
}

/**
 * PERSONAL: alta, rol y alcance, baja y contraseña temporal.
 *
 * La regla que no se negocia es que nadie da más de lo que tiene: el rol que
 * se asigna no puede traer permisos que quien lo asigna no posea, ni alcance
 * sobre sedes que no opera. Sin ella, una gerente se hacía dueña a sí misma
 * creando una cuenta nueva.
 */
/**
 * La cuenta del DUEÑO solo la administra GymFlow (DP-01). Un gerente con
 * `staff:manage` podía darlo de baja, degradarlo a Recepción o restablecerle
 * la contraseña, lo que lo dejaba 24 horas sin poder firmar: la segunda
 * firma dejaba de valer. Solo otro dueño (si lo hubiera) la toca.
 */
function protegerAlDueno(request: FastifyRequest, cuenta: StaffRow): void {
  if (!cuenta.assignments.some((a) => UNLOCK_EXEMPT_ROLES.has(a.roleKey))) return;
  if (request.holds('staff:unlock', null)) return;
  throw forbidden('La cuenta del dueño solo la administra GymFlow');
}

import { PushService } from './push.service.js';
import { PushSubscriptionRepository } from './push-subscription.repository.js';
import { KnownDeviceRepository } from './known-device.repository.js';

export function registerStaffRoutes(app: FastifyInstance): void {
  const audit = new AuditService();
  const sessions = new SessionRepository();

  /**
   * El motivo y el alcance de una acción sobre personal: la primera sede de
   * la persona va a `authorize` (SEC2-02) y `noEscala` revisa las demás.
   * Sin sedes = toda la organización, que exige alcance organizacional.
   */
  function autorizar(request: FastifyRequest, reason: string, sedes: readonly string[]) {
    request.authorize('staff:manage', { reason, branchId: sedes[0] ?? null });
  }

  /** El dueño (sin gerente activo, 2026-10-09) da de alta cualquier puesto de su gimnasio menos el suyo. */
  const esDueno = (request: FastifyRequest) => request.holds('staff:unlock', null);

  /** Lo que falta, en palabras y no en claves: «Abrir caja, Cerrar caja…» (17-01). */
  const enPalabras = (claves: readonly string[]) =>
    `${claves.slice(0, 3).map((k) => PERMISSION_BY_KEY.get(k)?.description ?? k).join(', ')}${claves.length > 3 ? '…' : ''}`;

  /** Tocar a alguien exige alcance sobre sus sedes; sin sedes = toda la organización. */
  function alcanceSobre(request: FastifyRequest, branchIds: readonly string[]) {
    if (branchIds.length === 0) request.requirePermission('staff:manage', null);
    for (const b of branchIds) request.requirePermission('staff:manage', b);
  }

  /**
   * Lo que trae el PUESTO de quien llama, sin la llave del dueño ni sus
   * ajustes: la llave le quita pantallas, no la facultad de contratar (17-01).
   * null = el dueño, exento por ser la cabeza del gimnasio.
   */
  async function puestoBase(request: FastifyRequest): Promise<ReadonlySet<string> | null> {
    if (esDueno(request)) return null;
    return new Set((await new GrantRepository().grantsForUser(request.ctx!.tenant.actorUserId!)).map((g) => g.permission));
  }

  /**
   * DAR UN PUESTO: no puede traer nada que el puesto de quien lo da no traiga.
   * Se compara contra su puesto base y no contra su sesión: a un gerente al que
   * el dueño le quitó Caja, «Recepción» le pedía `cash:session:open` y no podía
   * contratar (17-01).
   */
  async function noEscalaPuesto(request: FastifyRequest, permisosDelRol: readonly string[], branchIds: readonly string[]) {
    const base = await puestoBase(request);
    const ajenos = base ? permisosDelRol.filter((p) => !base.has(p)) : [];
    // En el mensaje y no en el detalle: es lo que el panel le enseña a quien contrata.
    if (ajenos.length) throw new DomainError('FORBIDDEN', `No puedes dar un puesto que trae más que el tuyo: ${enPalabras(ajenos)}`);
    alcanceSobre(request, branchIds);
  }

  /** AGREGAR EXCEPCIONES: lo que se enciende lo tiene HOY quien lo enciende (su sesión, con la llave). */
  function noEscalaExcepcion(request: FastifyRequest, agregados: readonly string[], branchIds: readonly string[]) {
    const mios = new Set(request.ctx!.tenant.grants.map((g) => g.permission));
    const ajenos = esDueno(request) ? [] : agregados.filter((p) => !mios.has(p as PermissionKey));
    if (ajenos.length) throw new DomainError('FORBIDDEN', `No puedes encender lo que tú no tienes: ${enPalabras(ajenos)}`);
    alcanceSobre(request, branchIds);
  }

  route(app, {
    method: 'GET', url: '/users',
    security: { kind: 'permission', permission: 'staff:read' },
    handler: async (request) => ({ users: (await new StaffRepository(request.ctx!.tenant.organizationId).list()).map(serialize) }),
  });

  route(app, {
    method: 'GET', url: '/users/:id',
    security: { kind: 'permission', permission: 'staff:read' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const u = await new StaffRepository(request.ctx!.tenant.organizationId).find(id);
      if (!u) throw notFound('Usuario no encontrado');
      return serialize(u);
    },
  });

  /** Los puestos del gimnasio (ADR-039): qué hace cada uno, su alcance y cuántas cuentas lo tienen. */
  route(app, {
    method: 'GET', url: '/roles',
    security: { kind: 'permission', permission: 'staff:read' },
    handler: async (request) => {
      const orgId = request.ctx!.tenant.organizationId;
      const repo = new StaffRepository(orgId);
      const [roles, enUso, base] = await Promise.all([repo.roles(), repo.roleUsage(), puestoBase(request)]);
      return {
        roles: roles.filter((r) => ROLE_BY_KEY.get(r.key)?.assignable).map((r) => {
          const def = ROLE_BY_KEY.get(r.key)!;
          return {
            key: r.key, name: r.name, permissions: r.permissions.length,
            description: def.description, sees: def.sees, scope: def.scope, inUse: enUso.get(r.key) ?? 0,
            // Se marca cuáles puede asignar ESTE usuario, con la misma regla que
            // `noEscalaPuesto`, para no ofrecer lo que la API rechazaría.
            assignable: !UNLOCK_EXEMPT_ROLES.has(r.key) && (base === null || r.permissions.every((p) => base.has(p))),
          };
        }),
      };
    },
  });

  /**
   * Qué puede hacer cada rol, sacado del catálogo y de la base: la pantalla
   * "Roles y permisos" no se escribe a mano, así no se desactualiza.
   */
  route(app, {
    method: 'GET', url: '/roles/matrix',
    security: { kind: 'permission', permission: 'staff:read' },
    handler: async (request) => {
      const repo = new StaffRepository(request.ctx!.tenant.organizationId);
      const [roles, limites] = await Promise.all([repo.roles(), repo.roleLimits()]);
      const porRol = new Map(limites.map((l) => [l.roleId, l]));
      const cents = (v: bigint | null) => (v === null ? null : v.toString());
      return {
        permissions: PERMISSIONS.map((p) => ({
          key: p.key, domain: p.domain, description: p.description,
          requiresReason: p.requiresReason, requiresApproval: p.requiresApproval,
        })),
        roles: roles.map((r) => {
          const l = porRol.get(r.id);
          const def = ROLE_BY_KEY.get(r.key);
          return {
            key: r.key, name: r.name, permissions: r.permissions,
            description: def?.description ?? null, scope: def?.scope ?? 'any',
            limits: l ? {
              maxDiscountPercent: l.maxDiscountPercent, maxWaiverAmountCents: cents(l.maxWaiverAmountCents),
              maxManualBalanceAdjustCents: cents(l.maxManualBalanceAdjustCents), maxCashWithdrawalCents: cents(l.maxCashWithdrawalCents),
              maxRefundAmountCents: cents(l.maxRefundAmountCents), maxManualAccessGrantsPerShift: l.maxManualAccessGrantsPerShift,
              maxPosVoidsPerShift: l.maxPosVoidsPerShift,
            } : null,
          };
        }),
      };
    },
  });

  route(app, {
    method: 'POST', url: '/users',
    security: { kind: 'permission', permission: 'staff:manage' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = z.object({
        email: z.string().trim().toLowerCase().email(),
        fullName: nombrePersona(120).pipe(z.string().min(3)),
        phoneE164: celular(),
        roleKey: z.string().min(2),
        branchIds: z.array(z.string().uuid()).max(50).default([]),
        reason: z.string().min(3).max(300),
      }).parse(request.body);
      autorizar(request, body.reason, body.branchIds);
      const repo = new StaffRepository(ctx.tenant.organizationId);
      const rol = (await repo.roles()).find((r) => r.key === body.roleKey);
      if (!rol) throw validation('Rol desconocido');
      // El puesto manda su alcance y si está activado aquí (ADR-039).
      validarPuesto(rol.key, body.branchIds);
      if (UNLOCK_EXEMPT_ROLES.has(rol.key)) throw forbidden('La cuenta del dueño solo la da de alta GymFlow');
      await noEscalaPuesto(request, rol.permissions, body.branchIds);
      if (await repo.emailInUse(body.email)) throw conflict('Ese correo ya tiene una cuenta en GymFlow', 'DUPLICATE_EMAIL');

      const clave = temporal();
      const id = await repo.create({ email: body.email, fullName: body.fullName, phoneE164: body.phoneE164, passwordHash: await app.auth.hashPassword(clave) }, ctx.tenant.actorUserId!);
      await repo.replaceRole(id, rol.id, body.branchIds, ctx.tenant.actorUserId!);
      await audit.record(ctx, {
        action: 'staff.create', resourceType: 'User', resourceId: id, reason: body.reason,
        afterState: { email: body.email, role: rol.key, branchIds: body.branchIds },
      });
      // La contraseña temporal se entrega UNA vez: no se guarda en claro.
      return reply.status(201).send({ user: serialize((await repo.find(id))!), temporaryPassword: clave });
    },
  });

  route(app, {
    method: 'PATCH', url: '/users/:id',
    security: { kind: 'permission', permission: 'staff:manage' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        fullName: nombrePersona(120).pipe(z.string().min(3)).optional(),
        // Sin la llave, no se toca; null o vacío lo borra.
        phoneE164: telefonoMx().nullish().transform((v) => (v === undefined ? undefined : v ? normalizePhoneMx(v) : null)),
        isActive: z.boolean().optional(),
        reason: z.string().min(3).max(300),
        // Al dar de baja a un coach con socios: a quién pasan (null = se quedan sin coach). Bloque 2.6, 12-07.
        coachHandover: z.object({ toUserId: z.string().uuid().nullable() }).optional(),
      }).parse(request.body);
      if (id === ctx.tenant.actorUserId && body.isActive === false) throw forbidden('No puedes darte de baja a ti mismo');
      const repo = new StaffRepository(ctx.tenant.organizationId);
      const antes = await repo.find(id);
      if (!antes) throw notFound('Usuario no encontrado');
      protegerAlDueno(request, antes);
      autorizar(request, body.reason, serialize(antes).branchIds);
      // Tocar a alguien exige alcance sobre sus sedes (o sobre toda la organización si la tiene).
      alcanceSobre(request, serialize(antes).branchIds);
      // Quien vuelve entra con una temporal nueva que ve quien lo reactiva, como
      // en el alta (17-10, D17-06): la de antes pudo quedar compartida.
      const reactiva = body.isActive === true && !antes.isActive;
      const clave = reactiva ? temporal() : null;
      const hash = clave ? await app.auth.hashPassword(clave) : null;
      await enUnaTransaccion(async () => {
        await repo.update(id, {
          ...(body.fullName ? { fullName: body.fullName } : {}),
          ...(body.phoneE164 !== undefined ? { phoneE164: body.phoneE164 } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        });
        if (hash) await repo.setPassword(id, hash, ctx.tenant.actorUserId!);
        // Lo que la persona deja pendiente en otros módulos (los socios de un coach, 12-07): si no se resuelve, no hay baja.
        if (body.isActive === false && antes.isActive) await antesDeLaBaja(ctx, id, { coachHandover: body.coachHandover });
        // Dar de baja cierra sus sesiones: una baja que deja la sesión abierta no es baja.
        if (body.isActive === false) await sessions.revokeAllForUser(id, 'staff_deactivated');
        await audit.record(ctx, {
          action: body.isActive === false ? 'staff.deactivate' : 'staff.update', resourceType: 'User', resourceId: id, reason: body.reason,
          beforeState: { fullName: antes.fullName, phoneE164: antes.phoneE164, isActive: antes.isActive },
          afterState: {
            fullName: body.fullName ?? antes.fullName, phoneE164: body.phoneE164 !== undefined ? body.phoneE164 : antes.phoneE164,
            isActive: body.isActive ?? antes.isActive, ...(reactiva ? { reactivated: true } : {}),
          },
        });
        // La temporal nueva es un restablecimiento: va a «Para revisar» como cualquiera.
        if (reactiva) await audit.record(ctx, { action: 'staff.password_reset', resourceType: 'User', resourceId: id, reason: body.reason, afterState: { reactivated: true } });
      });
      return { ...serialize((await repo.find(id))!), ...(clave ? { temporaryPassword: clave } : {}) };
    },
  });

  route(app, {
    method: 'PUT', url: '/users/:id/role',
    security: { kind: 'permission', permission: 'staff:manage' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        roleKey: z.string().min(2), branchIds: z.array(z.string().uuid()).max(50).default([]), reason: z.string().min(3).max(300),
      }).parse(request.body);
      if (id === ctx.tenant.actorUserId) throw forbidden('No puedes cambiar tu propio rol');
      const repo = new StaffRepository(ctx.tenant.organizationId);
      const antes = await repo.find(id);
      if (!antes) throw notFound('Usuario no encontrado');
      protegerAlDueno(request, antes);
      autorizar(request, body.reason, serialize(antes).branchIds);
      const rol = (await repo.roles()).find((r) => r.key === body.roleKey);
      if (!rol) throw validation('Rol desconocido');
      validarPuesto(rol.key, body.branchIds);
      if (UNLOCK_EXEMPT_ROLES.has(rol.key)) throw forbidden('La cuenta del dueño solo la da de alta GymFlow');
      await noEscalaPuesto(request, rol.permissions, body.branchIds);
      alcanceSobre(request, serialize(antes).branchIds);
      const puestoAntes = antes.assignments[0]?.roleKey ?? null;
      // Cambiar de puesto borra las excepciones (17-03): lo que se le encendió
      // a una recepcionista no pasa al coach, ni revive si vuelve a recepción.
      const cambiaPuesto = puestoAntes !== rol.key;
      const excepciones = antes.permissionOverrides;
      const borra = cambiaPuesto && excepciones.add.length + excepciones.remove.length > 0;
      await enUnaTransaccion(async () => {
        await repo.replaceRole(id, rol.id, body.branchIds, ctx.tenant.actorUserId!);
        if (cambiaPuesto) await repo.setPermissionOverrides(id, { add: [], remove: [] });
        // Permisos nuevos = sesiones nuevas: la vieja seguiría con los de antes hasta expirar.
        await sessions.revokeAllForUser(id, 'role_changed');
        await audit.record(ctx, {
          action: 'staff.role', resourceType: 'User', resourceId: id, reason: body.reason,
          beforeState: { role: puestoAntes, ...(borra ? { permissionOverrides: excepciones } : {}) },
          afterState: { role: rol.key, branchIds: body.branchIds, ...(borra ? { overridesCleared: true } : {}) },
        });
      });
      return serialize((await repo.find(id))!);
    },
  });

  /** Las acciones que se pueden ajustar por persona, agrupadas, con su descripción. */
  route(app, {
    method: 'GET', url: '/users/adjustable-permissions',
    security: { kind: 'permission', permission: 'staff:read' },
    handler: async () => ({
      groups: ADJUSTABLE_PERMISSION_GROUPS.map((g) => ({
        name: g.name,
        permissions: g.permissions.map((k) => ({ key: k, description: PERMISSIONS.find((p) => p.key === k)?.description ?? k })),
      })),
      roles: [...ADJUSTABLE_ROLES].map((k) => ({
        key: k,
        permissions: (ROLE_BY_KEY.get(k)?.permissions ?? []).filter((p) => adjustableFor(k).has(p)),
        // Lo que se le puede ajustar a ESTE puesto (17-02): el panel muestra solo eso.
        adjustable: [...adjustableFor(k)],
      })),
    }),
  });

  /**
   * PERMISOS POR PERSONA (2026-10-09): encender o apagar acciones sueltas a
   * una persona de recepción o a un coach, sobre su puesto. Lo hace quien
   * administra al personal (la gerencia, o el dueño mientras no haya gerente).
   */
  route(app, {
    method: 'PUT', url: '/users/:id/permissions',
    security: { kind: 'permission', permission: 'staff:manage' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({
        add: z.array(z.string().max(60)).max(40).default([]),
        remove: z.array(z.string().max(60)).max(40).default([]),
        reason: z.string().trim().min(3).max(300),
      }).parse(request.body);
      if (id === ctx.tenant.actorUserId) throw forbidden('Tus propios permisos no se cambian');
      const fuera = [...body.add, ...body.remove].filter((k) => !ADJUSTABLE_PERMISSIONS.has(k));
      if (fuera.length) throw validation(`Esa acción no se ajusta por persona: ${fuera.join(', ')}`);
      const repo = new StaffRepository(ctx.tenant.organizationId);
      const antes = await repo.find(id);
      if (!antes) throw notFound('Usuario no encontrado');
      const puesto = antes.assignments[0]?.roleKey;
      if (!puesto || !ADJUSTABLE_ROLES.has(puesto)) throw validation('Solo se ajustan los permisos de recepción y de coaches; gerencia y dueño van completos por su puesto');
      // Cada puesto con su lista (17-02): al coach nunca se le enciende dinero,
      // caja, punto de venta, acceso ni altas.
      const ajenas = [...body.add, ...body.remove].filter((k) => !adjustableFor(puesto).has(k));
      if (ajenas.length) throw validation(`A ${ROLE_BY_KEY.get(puesto)?.name ?? 'este puesto'} no se le ajusta: ${enPalabras(ajenas)}`);
      const sedes = serialize(antes).branchIds;
      autorizar(request, body.reason, sedes);
      // Lo que se agrega lo tiene quien lo da (el dueño, por ser la cabeza del gimnasio, está exento).
      noEscalaExcepcion(request, body.add, sedes);
      // Lo que el puesto ya trae no se "agrega", y lo que no trae no se "quita".
      const base = new Set(ROLE_BY_KEY.get(puesto)?.permissions ?? []);
      const o = normalizeOverrides({ add: body.add.filter((k) => !base.has(k as PermissionKey)), remove: body.remove.filter((k) => base.has(k as PermissionKey)) }, puesto);
      await repo.setPermissionOverrides(id, o);
      // Permisos nuevos = sesión nueva.
      await sessions.revokeAllForUser(id, 'permissions_changed');
      await audit.record(ctx, {
        action: 'staff.permissions', resourceType: 'User', resourceId: id, reason: body.reason,
        beforeState: antes.permissionOverrides, afterState: o,
      });
      return serialize((await repo.find(id))!);
    },
  });

  /**
   * LA LLAVE DEL DUEÑO (2026-10-06): qué pantallas de Dirección y Cumplimiento
   * ve cada persona de su equipo. Sección por sección; sin nada liberado, el
   * gerente y la recepción solo ven la operación.
   */
  route(app, {
    method: 'PUT', url: '/users/:id/sections',
    security: { kind: 'permission', permission: 'staff:unlock' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({ sections: z.array(z.string().max(40)).max(50), reason: z.string().min(3).max(300) }).parse(request.body);
      if (id === ctx.tenant.actorUserId) throw forbidden('Tu propia llave no se cambia');
      // `clave` libera lo de Dirección y Cumplimiento; `-clave` quita Caja o Punto de venta, que vienen con el puesto.
      const desconocidas = body.sections.filter((k) => !isSectionToken(k));
      if (desconocidas.length > 0) throw validation(`Sección desconocida: ${desconocidas.join(', ')}`);
      request.authorize('staff:unlock', { branchId: null, reason: body.reason });
      const repo = new StaffRepository(ctx.tenant.organizationId);
      const antes = await repo.find(id);
      if (!antes) throw notFound('Usuario no encontrado');
      if (antes.assignments.some((a) => UNLOCK_EXEMPT_ROLES.has(a.roleKey))) throw validation('El dueño ve todo por su puesto: no tiene llave');
      const sections = normalizeUnlocked(body.sections);
      await repo.setUnlockedSections(id, sections);
      // Permisos nuevos = sesión nueva: con la vieja seguiría viendo (o sin ver) lo de antes.
      await sessions.revokeAllForUser(id, 'sections_changed');
      await audit.record(ctx, {
        action: 'staff.unlock', resourceType: 'User', resourceId: id, reason: body.reason,
        beforeState: { unlockedSections: normalizeUnlocked(antes.unlockedSections) }, afterState: { unlockedSections: sections },
      });
      return serialize((await repo.find(id))!);
    },
  });

  /**
   * RESCATE DEL GERENTE (DP-02). El dueño no administra al personal, pero si
   * su gerente olvidó la contraseña un sábado o se fue, el gimnasio no puede
   * quedarse sin nadie que configure. Solo sobre cuentas de GERENTE, con
   * motivo y en la bitácora; lo demás sigue siendo de la gerencia.
   */
  route(app, {
    method: 'POST', url: '/users/:id/rescue',
    security: { kind: 'permission', permission: 'staff:rescue' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const body = z.object({ action: z.enum(['reset_password', 'deactivate', 'reactivate']), reason: z.string().min(3).max(300) }).parse(request.body);
      if (id === ctx.tenant.actorUserId) throw forbidden('Tu propia cuenta la administra GymFlow');
      request.authorize('staff:rescue', { branchId: null, reason: body.reason });
      const repo = new StaffRepository(ctx.tenant.organizationId);
      const u = await repo.find(id);
      if (!u) throw notFound('Usuario no encontrado');
      if (!u.assignments.some((a) => a.roleKey === 'MANAGER')) throw validation('El rescate es solo para cuentas de gerente; al resto lo administra la gerencia');
      // Reactivar también entrega una temporal nueva (17-10): la de antes pudo quedar compartida.
      const temporaryPassword = body.action === 'deactivate' || (body.action === 'reactivate' && u.isActive) ? null : temporal();
      const hash = temporaryPassword ? await app.auth.hashPassword(temporaryPassword) : null;
      await enUnaTransaccion(async () => {
        if (body.action !== 'reset_password') await repo.update(id, { isActive: body.action === 'reactivate' });
        if (hash) await repo.setPassword(id, hash, ctx.tenant.actorUserId!);
        if (body.action === 'deactivate') await sessions.revokeAllForUser(id, 'deactivated');
        else if (hash) await sessions.revokeAllForUser(id, 'password_reset');
        await audit.record(ctx, {
          action: 'staff.rescue', resourceType: 'User', resourceId: id, reason: body.reason,
          afterState: { action: body.action, ...(temporaryPassword ? { temporaryPassword: true } : {}) },
        });
      });
      return { ...serialize((await repo.find(id))!), temporaryPassword };
    },
  });

  route(app, {
    method: 'POST', url: '/users/:id/reset-password',
    security: { kind: 'permission', permission: 'staff:manage' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { id } = idParam.parse(request.params);
      const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(request.body);
      const repo = new StaffRepository(ctx.tenant.organizationId);
      const u = await repo.find(id);
      if (!u) throw notFound('Usuario no encontrado');
      protegerAlDueno(request, u);
      autorizar(request, reason, serialize(u).branchIds);
      alcanceSobre(request, serialize(u).branchIds);
      const clave = temporal();
      await repo.setPassword(id, await app.auth.hashPassword(clave), ctx.tenant.actorUserId!);
      await sessions.revokeAllForUser(id, 'password_reset');
      // Sus equipos conocidos se olvidan (D-01): si la contraseña se restablece porque alguien más la tenía, ese equipo no queda «de confianza».
      await new KnownDeviceRepository().olvidar(id);
      await audit.record(ctx, { action: 'staff.password_reset', resourceType: 'User', resourceId: id, reason });
      return { temporaryPassword: clave };
    },
  });

  // ── Avisos al teléfono (DP-10) ─────────────────────────────────────────────

  /** La llave pública VAPID, o null si el servidor no tiene llaves: entonces el panel no ofrece el botón. */
  route(app, {
    method: 'GET',
    url: '/me/push/public-key',
    security: { kind: 'session' },
    handler: async (request) => {
      const ctx = request.ctx!;
      return { publicKey: new PushService().publicKey(), subscriptions: ctx.tenant.actorUserId ? await new PushSubscriptionRepository().countForUser(ctx.tenant.actorUserId) : 0 };
    },
  });

  /**
   * «Probar»: un aviso de verdad a los equipos de quien lo pide (D-01, bloque
   * 3.1). Con la dirección fija es la manera de saber, sin esperar una firma,
   * que los avisos llegan a ese teléfono. Dice a cuántos equipos salió.
   */
  route(app, {
    method: 'POST',
    url: '/me/push/test',
    security: { kind: 'session' },
    config: { rateLimit: { max: 6, timeWindow: '5 minutes' } },
    handler: async (request) => {
      const ctx = request.ctx!;
      const sent = await new PushService().sendToUsers(ctx.tenant.organizationId, [ctx.tenant.actorUserId!], {
        title: 'Aviso de prueba de GymFlow', body: 'Si lees esto, los avisos llegan a este equipo.', url: '/seguridad', tag: 'push-test',
      });
      return { sent };
    },
  });

  route(app, {
    method: 'POST',
    url: '/me/push-subscriptions',
    security: { kind: 'session' },
    handler: async (request, reply) => {
      const ctx = request.ctx!;
      const body = z.object({
        endpoint: z.string().url().max(2000),
        keys: z.object({ p256dh: z.string().min(10).max(500), auth: z.string().min(5).max(200) }),
      }).parse(request.body);
      if (!new PushService().publicKey()) throw validation('Este servidor no tiene avisos al teléfono configurados');
      await new PushSubscriptionRepository().upsert({
        organizationId: ctx.tenant.organizationId, userId: ctx.tenant.actorUserId!, endpoint: body.endpoint,
        p256dh: body.keys.p256dh, auth: body.keys.auth, userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.status(201).send({ ok: true });
    },
  });

  route(app, {
    method: 'DELETE',
    url: '/me/push-subscriptions',
    security: { kind: 'session' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const { endpoint } = z.object({ endpoint: z.string().url().max(2000) }).parse(request.body);
      return { removed: await new PushSubscriptionRepository().remove(ctx.tenant.actorUserId!, endpoint) };
    },
  });
}
