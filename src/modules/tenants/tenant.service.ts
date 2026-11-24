import { randomInt } from 'node:crypto';
import { hash as argonHash } from '@node-rs/argon2';
import {
  ALL_SECTIONS_UNLOCKED, MODULES, MODULE_BY_KEY, MODULE_TEMPLATES, ROLE_BY_KEY, conflict, notFound, validation, type RoleKey,
} from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { systemContext } from '../../platform/jobs/types.js';
import { forgetModules } from '../../platform/modules/module-state.js';
import { ModuleStateRepository } from '../../platform/modules/module-state.repository.js';
import { TenantRepository, type Cuenta } from './tenant.repository.js';
import { validarPuesto } from '../../platform/roles/puestos.js';
import { PlatformPlanRepository, type PlanDePlataforma } from './platform-plan.repository.js';
import { hoyDeCobro } from './cobro-reglas.js';

/**
 * La VERSIÓN del plan que una marca recibe al contratarlo (D-38, bloque 3.11):
 * lo que el plan cuesta e incluye ese día. El cobro lee esta, no el catálogo;
 * un cambio anunciado del plan se la actualiza a todas en su fecha.
 */
const versionDe = (plan: PlanDePlataforma, desde: string) => ({ planId: plan.id, name: plan.name, monthlyCents: plan.monthlyCents?.toString() ?? null, modules: plan.modules, since: desde });

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
/**
 * Solo mayúsculas y dígitos sin parecidos (sin 0/O, 1/I/L, 5/S, 8/B): la
 * contraseña temporal se dicta por teléfono o se copia de una hoja (UX5-PL-03).
 */
const ALFABETO = 'ACDEFGHJKMNPQRTUVWXYZ2345679';

export type Persona = { fullName: string; email: string; phoneE164: string | null };

export type AltaDeMarca = {
  legalName: string; tradeName: string; timezone: string;
  /**
   * Un atajo de contratación (22-01): sin plan y sin lista, lo contratado es lo
   * que la plantilla trae. No decide nada más: en el alta, contratado = encendido.
   */
  template?: string | null | undefined;
  /** Plan de la plataforma contratado (ADR-039). Con plan, lo contratado es lo que incluye más `contracted` como agregados. */
  planId?: string | null | undefined;
  /** Módulos opcionales contratados (sin plan) o agregados al plan. Sin lista, sin plan y sin plantilla: todos. */
  contracted?: readonly string[] | undefined;
  /** «Liberar al terminar» (22-11): la marca nace en uso. Por omisión nace sin liberar. */
  releaseNow?: boolean | undefined;
  branch: { code: string; name: string; addressLine: string | null; timezone: string | null };
  owner: Persona;
  /** Gerencia, recepción y coaches del arranque, tantos como se necesiten. */
  staff: Array<Persona & { roleKey: 'MANAGER' | 'RECEPTION' | 'COACH' }>;
};

/**
 * Lo que se entrega UNA vez a cada persona (22-03): su contraseña temporal y
 * su celular, para mandársela a ella y a nadie más.
 */
export type Credencial = { roleKey: RoleKey; roleName: string; fullName: string; email: string; phoneE164: string | null; password: string };

/** El nombre del puesto, del catálogo (ADR-039). */
const nombreDe = (key: RoleKey): string => ROLE_BY_KEY.get(key)?.name ?? key;

/** Lo que quedó en la bitácora al cambiar el servicio. */
export type AccionDeServicio = 'platform.service.activate' | 'platform.service.resume' | 'platform.service.suspend';

/**
 * Da de alta una marca de gimnasio con lo mínimo para operar mañana: su
 * primera sucursal, los módulos que contrató y las cuentas del arranque:
 * el dueño siempre, y la gerencia, recepción y coaches que se pidan. Las contraseñas son temporales y se entregan UNA
 * vez, cada una a su dueño: solo sirven para que esa persona elija la suya al
 * entrar y vencen a los 7 días (A4-N1).
 */
export class TenantService {
  private readonly repo = new TenantRepository();
  private readonly planes = new PlatformPlanRepository();
  private readonly audit = new AuditService();

  temporaryPassword(): string {
    // GYM-XXXX-XXXX: tres bloques que se leen de uno en uno.
    let s = '';
    for (let i = 0; i < 8; i++) s += ALFABETO[randomInt(ALFABETO.length)];
    return `GYM-${s.slice(0, 4)}-${s.slice(4)}`;
  }

  async crear(input: AltaDeMarca, byUserId: string, reason: string): Promise<{ organizationId: string; branchId: string; serviceStatus: 'PENDING' | 'ACTIVE'; credentials: Credencial[] }> {
    const plantilla = input.template ? MODULE_TEMPLATES.find((t) => t.key === input.template) ?? null : null;
    if (input.template && !plantilla) throw validation('Plantilla desconocida');
    const personas: Array<Persona & { roleKey: RoleKey; branchScoped: boolean }> = [
      { ...input.owner, roleKey: 'OWNER', branchScoped: false },
      // Gerencia abarca todo el gimnasio; recepción y coach, la primera sucursal.
      ...input.staff.map((p) => ({ ...p, branchScoped: p.roleKey !== 'MANAGER' })),
    ];
    const correos = personas.map((p) => p.email.toLowerCase());
    if (new Set(correos).size !== correos.length) throw validation('Dos cuentas no pueden compartir el correo');
    for (const correo of correos) {
      if (await this.repo.emailEnUso(correo)) throw conflict(`El correo ${correo} ya tiene una cuenta`);
    }

    // Lo contratado lo decide la plataforma. Con plan: lo que el plan incluye más
    // los agregados; sin plan: la lista; sin lista, lo que trae la plantilla (un
    // atajo); sin nada de eso, todo.
    const opcionales = MODULES.filter((m) => m.kind === 'optional').map((m) => m.key as string);
    const plan = input.planId ? await this.planActivo(input.planId) : null;
    const contratados = new Set(plan
      ? [...plan.modules, ...(input.contracted ?? [])]
      : (input.contracted ?? opcionales.filter((k) => !(plantilla?.off as readonly string[] | undefined)?.includes(k))));
    for (const k of contratados) if (!opcionales.includes(k)) throw validation(`Módulo desconocido: ${k}`);
    // CONTRATADO = ENCENDIDO (22-01). El alta ya no escribe el estado de los
    // módulos: lo que se paga nace a la vista y la gerencia apaga después, desde
    // Módulos, lo que no use. Antes la plantilla «apagaba» exactamente lo que no
    // se había contratado: dos preguntas para una sola decisión.
    const notGranted = opcionales.filter((k) => !contratados.has(k));
    const credentials: Credencial[] = [];
    const cuentas: Cuenta[] = [];
    // Solo el PRIMER gerente de la lista nace con Dirección y Cumplimiento
    // liberados (22-08): es quien arma el gimnasio. A los demás se las libera
    // el dueño, como a cualquier gerente que llega después.
    let gerenteLiberado = false;
    for (const p of personas) {
      const password = this.temporaryPassword();
      const liberado = p.roleKey === 'MANAGER' && !gerenteLiberado;
      if (liberado) gerenteLiberado = true;
      cuentas.push({
        fullName: p.fullName, email: p.email.toLowerCase(), phoneE164: p.phoneE164, passwordHash: await argonHash(password, ARGON), roleKey: p.roleKey, branchScoped: p.branchScoped,
        unlockedSections: liberado ? ALL_SECTIONS_UNLOCKED : [],
      });
      credentials.push({ roleKey: p.roleKey, roleName: nombreDe(p.roleKey), fullName: p.fullName, email: p.email.toLowerCase(), phoneE164: p.phoneE164, password });
    }

    const liberar = input.releaseNow === true;
    const origen = plan ? `plan «${plan.name}»` : plantilla ? `plantilla «${plantilla.name}»` : 'a la medida';
    const creado = await this.repo.crear({
      legalName: input.legalName, tradeName: input.tradeName, timezone: input.timezone, platformPlanId: plan?.id ?? null,
      platformPlanSnapshot: plan ? versionDe(plan, hoyDeCobro()) : null,
      branch: input.branch,
      contracted: { notGranted, reason: `Alta de la marca: ${origen}` },
      conCaja: contratados.has('cash'),
      liberar,
    }, cuentas, byUserId);
    forgetModules(creado.organizationId);

    // Queda en la bitácora de la marca nueva, como acto del sistema: quien
    // la creó no es personal de ese gimnasio.
    const nombres = (claves: readonly string[]) => claves.map((k) => MODULE_BY_KEY.get(k)?.name ?? k);
    await this.audit.record(systemContext(creado.organizationId), {
      action: 'platform.organization.create', resourceType: 'Organization', resourceId: creado.organizationId, reason,
      afterState: {
        tradeName: input.tradeName, timezone: input.timezone, template: plantilla?.name ?? null, plan: plan?.name ?? null, branch: input.branch.code, byPlatformUserId: byUserId,
        accounts: credentials.map((c) => ({ role: c.roleKey, email: c.email })),
        // Qué contrató y qué no: ya no hay «apagado por la plantilla» (22-01).
        contracted: nombres(opcionales.filter((k) => contratados.has(k))),
        notContracted: nombres(notGranted),
        released: liberar,
      },
    });
    // Liberada en el mismo paso: su propio asiento, igual que si se liberara desde la ficha.
    if (liberar) {
      await this.audit.record(systemContext(creado.organizationId), {
        action: 'platform.service.activate', resourceType: 'Organization', resourceId: creado.organizationId, reason,
        afterState: { serviceStatus: 'ACTIVE', atCreation: true, byPlatformUserId: byUserId },
      });
    }
    return { organizationId: creado.organizationId, branchId: creado.branchId, serviceStatus: liberar ? 'ACTIVE' : 'PENDING', credentials };
  }

  private async planActivo(planId: string): Promise<PlanDePlataforma> {
    const plan = await this.planes.find(planId);
    if (!plan) throw notFound('Plan no encontrado');
    if (!plan.isActive) throw validation(`El plan «${plan.name}» ya no se ofrece`);
    return plan;
  }

  /** Los datos de la marca que la plataforma puede corregir. */
  async editar(organizationId: string, datos: { legalName?: string; tradeName?: string; timezone?: string; billingEmail?: string | null }, byUserId: string, reason: string): Promise<void> {
    const ok = await this.repo.editar(organizationId, datos);
    if (!ok) throw notFound('Marca no encontrada');
    await this.audit.record(systemContext(organizationId), {
      action: 'platform.organization.update', resourceType: 'Organization', resourceId: organizationId, reason,
      afterState: { ...datos, byPlatformUserId: byUserId },
    });
  }

  /**
   * El plan contratado (ADR-039). Al asignarlo, lo contratado pasa a ser
   * EXACTAMENTE lo que el plan incluye; los agregados se contratan después,
   * uno por uno. Quitar el plan (null) deja lo contratado como está.
   */
  async asignarPlan(organizationId: string, planId: string | null, byUserId: string, reason: string): Promise<void> {
    const plan = planId ? await this.planActivo(planId) : null;
    const ok = await this.repo.setPlan(organizationId, plan?.id ?? null, plan ? versionDe(plan, hoyDeCobro()) : null);
    if (!ok) throw notFound('Marca no encontrada');
    if (plan) {
      const estado = new ModuleStateRepository(organizationId);
      for (const m of MODULES.filter((x) => x.kind === 'optional')) {
        await estado.setEntitlement(m.key, plan.modules.includes(m.key), byUserId, `Plan «${plan.name}»`);
      }
    }
    forgetModules(organizationId);
    await this.audit.record(systemContext(organizationId), {
      action: 'platform.plan.assign', resourceType: 'Organization', resourceId: organizationId, reason,
      afterState: { plan: plan?.name ?? null, planId: plan?.id ?? null, modules: plan?.modules.map((k) => MODULE_BY_KEY.get(k)?.name ?? k) ?? null, byPlatformUserId: byUserId },
    });
  }

  /**
   * La plataforma libera el software a la marca, lo reanuda o lo suspende.
   * Liberar (la primera vez) y reanudar (tras una suspensión) son actos
   * distintos en la bitácora (22-07): «liberó el software» y «reanudó el servicio».
   */
  async cambiarServicio(organizationId: string, status: 'ACTIVE' | 'SUSPENDED', byUserId: string, reason: string): Promise<AccionDeServicio> {
    const antes = await this.repo.setServiceStatus(organizationId, status, reason);
    if (!antes) throw notFound('Marca no encontrada');
    forgetModules(organizationId);
    const action: AccionDeServicio = status === 'SUSPENDED' ? 'platform.service.suspend' : antes === 'SUSPENDED' ? 'platform.service.resume' : 'platform.service.activate';
    await this.audit.record(systemContext(organizationId), {
      action, resourceType: 'Organization', resourceId: organizationId, reason, afterState: { serviceStatus: status, previous: antes, byPlatformUserId: byUserId },
    });
    return action;
  }

  /** Lo que la marca contrató: la plataforma lo concede o lo retira. */
  async contratar(organizationId: string, moduleKey: string, granted: boolean, byUserId: string, reason: string): Promise<void> {
    const def = MODULE_BY_KEY.get(moduleKey);
    if (!def) throw notFound('Módulo no encontrado');
    if (def.kind !== 'optional') throw validation(`${def.name} es parte de lo básico: va con el software`);
    await new ModuleStateRepository(organizationId).setEntitlement(moduleKey, granted, byUserId, reason);
    forgetModules(organizationId);
    await this.audit.record(systemContext(organizationId), {
      action: granted ? 'platform.module.grant' : 'platform.module.revoke',
      resourceType: 'Module', reason, afterState: { module: moduleKey, name: def.name, granted, byPlatformUserId: byUserId },
    });
  }

  /** Una cuenta más para la marca con cualquier puesto del catálogo (gerente, encargado, caja, coach, profesor, dueña), con contraseña temporal. */
  async agregarCuenta(organizationId: string, p: Persona & { roleKey: RoleKey; branchIds: string[] | null }, byUserId: string, reason: string): Promise<Credencial & { userId: string; sectionsUnlocked: boolean }> {
    validarPuesto(p.roleKey, p.branchIds);
    if (await this.repo.emailEnUso(p.email.toLowerCase())) throw conflict(`El correo ${p.email.toLowerCase()} ya tiene una cuenta`);
    if (p.branchIds) {
      const sedes = await this.repo.branchesOf(organizationId);
      for (const b of p.branchIds) if (!sedes.has(b)) throw validation('Una de las sucursales no es de esta marca');
      if (p.branchIds.length === 0) throw validation('Elige al menos una sucursal, o todo el gimnasio');
    }
    // LA REGLA DEL GERENTE (22-09): un gerente dado desde la plataforma nace con
    // Dirección y Cumplimiento liberados solo si la marca no tiene otro gerente
    // activo. Es el rescate: sin gerente, quien llega tiene que poder armar el
    // gimnasio (planes, textos, personal). Si ya hay uno, nace cerrado y el
    // dueño decide qué ve, como con cualquier gerente nuevo.
    const liberado = p.roleKey === 'MANAGER' && !(await this.repo.hayGerenteActivo(organizationId));
    const password = this.temporaryPassword();
    const userId = await this.repo.addUser(organizationId, {
      fullName: p.fullName, email: p.email.toLowerCase(), phoneE164: p.phoneE164, passwordHash: await argonHash(password, ARGON), roleKey: p.roleKey, branchScoped: p.branchIds !== null,
      unlockedSections: liberado ? ALL_SECTIONS_UNLOCKED : [],
    }, p.branchIds);
    await this.audit.record(systemContext(organizationId), {
      action: 'platform.user.create', resourceType: 'User', resourceId: userId, reason,
      afterState: { role: p.roleKey, email: p.email.toLowerCase(), branchIds: p.branchIds, sectionsUnlocked: liberado, byPlatformUserId: byUserId },
    });
    return { userId, roleKey: p.roleKey, roleName: nombreDe(p.roleKey), fullName: p.fullName, email: p.email.toLowerCase(), phoneE164: p.phoneE164, password, sectionsUnlocked: liberado };
  }

  async activarCuenta(organizationId: string, userId: string, isActive: boolean, byUserId: string, reason: string): Promise<void> {
    const ok = await this.repo.setUserActive(organizationId, userId, isActive);
    if (!ok) throw notFound('Cuenta no encontrada');
    await this.audit.record(systemContext(organizationId), {
      action: isActive ? 'platform.user.activate' : 'platform.user.suspend', resourceType: 'User', resourceId: userId, reason,
      afterState: { isActive, byPlatformUserId: byUserId },
    });
  }

  /** Qué ve el dueño (2026-10-09): la plataforma le libera o le bloquea secciones. null = todo. */
  async seccionesDelDueno(organizationId: string, userId: string, sections: string[] | null, byUserId: string, reason: string): Promise<void> {
    const r = await this.repo.setPlatformSections(organizationId, userId, sections);
    if (r === 'no_existe') throw notFound('Cuenta no encontrada');
    if (r === 'no_es_dueno') throw validation('Solo se limitan desde la plataforma las secciones del dueño; las del personal las decide el dueño');
    await this.audit.record(systemContext(organizationId), {
      action: 'platform.user.sections', resourceType: 'User', resourceId: userId, reason,
      afterState: { sections, byPlatformUserId: byUserId },
    });
  }

  /**
   * Una temporal nueva para quien se quedó fuera: vale 7 días, solo para
   * elegir la suya, desbloquea la cuenta y cierra sus sesiones abiertas.
   */
  async restablecerContrasena(organizationId: string, userId: string, byUserId: string, reason: string): Promise<{ password: string }> {
    const password = this.temporaryPassword();
    const ok = await this.repo.setTemporaryPassword(organizationId, userId, await argonHash(password, ARGON));
    if (!ok) throw notFound('Cuenta no encontrada');
    await this.audit.record(systemContext(organizationId), {
      action: 'platform.password_reset', resourceType: 'User', resourceId: userId, reason,
      afterState: { byPlatformUserId: byUserId },
    });
    return { password };
  }
}
