import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DomainError, MODULES, MODULE_BY_KEY, MODULE_GROUPS, canDisableAtBranch, changeModule, dependentsOf, effectiveModules,
  effectiveModulesAt, notFound, rostrosSeBorranAlApagar, validation,
} from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { route } from '../../platform/http/registry.js';
import { forgetModules, withEntitlements } from '../../platform/modules/module-state.js';
import { ModuleStateRepository } from '../../platform/modules/module-state.repository.js';
import { erasureOf, usageOf } from '../../platform/modules/usage.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
// Los usuarios son de identidad: quién cambió qué se le pregunta a ella.
import { UserRepository } from '../identity/index.js';
import { BranchRepository } from './branch.repository.js';
import { OrganizationRepository } from './organization.repository.js';
import { SetupRepository } from './setup.repository.js';

const keyParam = z.object({ key: z.string().min(2).max(40) });
const branchParam = z.object({ key: z.string().min(2).max(40), branchId: z.string().uuid() });
const changeBody = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().max(300).optional(),
  /**
   * Al apagar un módulo que borra datos pasado un plazo (Biometría: los
   * rostros; 3.12, D-32): el número que el aviso de la pantalla enseñó. Si no
   * viene o ya no coincide, no se apaga.
   */
  erasureAcknowledged: z.number().int().min(0).optional(),
});

const dia = (d: Date) => d.toISOString().slice(0, 10);
const diaEnPalabras = (d: Date) => new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);

/**
 * LO QUE APAGAR BORRARÍA (3.12; D-32, «igual si se apaga Biometría, con aviso»).
 * `null` si apagar ese módulo ahí no borra nada (no es Biometría, o no hay
 * ningún rostro guardado). `on` es el día en que se borraría si se apaga hoy.
 */
async function avisoDeBorrado(orgId: string, key: string, branchId?: string): Promise<{ count: number; on: Date } | null> {
  const count = await erasureOf(key, orgId, branchId);
  if (!count) return null;
  return { count, on: rostrosSeBorranAlApagar(await new BusinessCalendar(orgId).today(branchId ?? null)) };
}

/** Sin el aviso confirmado con el número de hoy, no se apaga: nadie borra rostros sin haberlo leído. */
function exigirAvisoConfirmado(aviso: { count: number; on: Date } | null, confirmado: number | undefined, nombreDelModulo: string, donde: string): void {
  if (!aviso || confirmado === aviso.count) return;
  const n = aviso.count;
  throw new DomainError('CONFLICT',
    `${nombreDelModulo} tiene ${n.toLocaleString('es-MX')} ${n === 1 ? 'rostro guardado' : 'rostros guardados'}${donde}: al apagarla ${n === 1 ? 'deja de reconocerse y se borra' : 'dejan de reconocerse y se borran'} el ${diaEnPalabras(aviso.on)} si no se vuelve a encender. Confirma el aviso para apagarla.`,
    undefined, 'MODULE_ERASURE_WARNING');
}

/**
 * «FALTA CONFIGURAR» (19-08): un módulo encendido sin nada preparado deja a
 * recepción frente a una pantalla vacía. Aquí se dice qué falta y a dónde ir.
 * No bloquea nada. Solo los módulos que se preparan antes de usarse: los
 * demás (prospectos, retención) se llenan con la operación.
 */
const QUE_FALTA: Readonly<Record<string, { text: string; action: string; href: string }>> = {
  cash: { text: 'Ninguna sucursal tiene caja: sin caja no se abre turno ni se cobra en efectivo.', action: 'Agregar una caja', href: '/sucursales' },
  pos: { text: 'Todavía no hay productos: el punto de venta abre vacío.', action: 'Dar de alta productos', href: '/productos' },
  classes: { text: 'Todavía no hay clases ni horario: la pantalla de Clases abre vacía.', action: 'Armar el horario', href: '/clases' },
  training: { text: 'Ningún socio tiene rutina asignada todavía.', action: 'Armar una rutina', href: '/rutinas' },
  intake: { text: 'Ninguna sucursal tiene su enlace corto del alta: falta para el cartel, Instagram y WhatsApp.', action: 'Crear el enlace del alta', href: '/sucursales' },
  biometrics: { text: 'Ningún socio tiene su rostro registrado todavía: se registra desde su ficha.', action: 'Ir a Socios', href: '/socios' },
  member_portal: { text: 'Ningún socio ha activado el portal en su teléfono: se le invita desde su ficha.', action: 'Ir a Socios', href: '/socios' },
};

/** Los módulos que al apagarse borran algo pasado un plazo: hoy, solo los rostros de Biometría (D-32). */
const BORRA_AL_APAGAR: ReadonlySet<string> = new Set(['biometrics']);

const nombre = (key: string) => MODULE_BY_KEY.get(key)?.name ?? key;
const lista = (nombres: readonly string[]) => new Intl.ListFormat('es', { type: 'conjunction' }).format(nombres);

/**
 * MÓDULOS DEL GIMNASIO (ADR-036): qué secciones usa y cuáles no.
 *
 * Verlos puede cualquiera del personal —de ahí sale su menú—; el detalle de
 * uso y el motivo, quien administra o audita todo el gimnasio. Cambiarlos,
 * solo quien configura la organización COMPLETA: una gerente de sede no
 * decide por las demás.
 */
export function registerModuleRoutes(app: FastifyInstance): void {
  const audit = new AuditService();

  async function estado(request: FastifyRequest) {
    const orgId = request.ctx!.tenant.organizationId;
    const repo = new ModuleStateRepository(orgId);
    const canManage = request.holds('settings:org', null);
    // El detalle (cuánto hay vivo, quién lo apagó y por qué) es para quien
    // dirige: recepción y coach solo necesitan saber qué está encendido.
    const conDetalle = canManage || request.holds('audit:read', null);
    const [estadoElegido, historia, porSede, sedes, contratos] = await Promise.all([repo.state(), repo.history(), repo.branchHistory(), new BranchRepository(orgId).list(), repo.entitlements()]);
    // Lo contratado y los enlaces del alta, solo para quien dirige (19-08, 19-09).
    const [perfil, enlaces] = conDetalle
      ? await Promise.all([new OrganizationRepository(orgId).profile(), new SetupRepository(orgId).conteos().then((c) => c.enlaces)])
      : [null, 0];
    // Lo no contratado cuenta como apagado, elija lo que elija la gerencia.
    const state = withEntitlements(estadoElegido, contratos);
    const activos = effectiveModules(state) as ReadonlySet<string>;
    const nombres = conDetalle
      ? await new UserRepository(orgId).namesById([
          ...[...historia.values()].flatMap((h) => (h.updatedByUserId ? [h.updatedByUserId] : [])),
          ...porSede.flatMap((h) => (h.updatedByUserId ? [h.updatedByUserId] : [])),
        ])
      : new Map<string, string>();
    const apagadoEn = (branchId: string) => new Set(porSede.filter((h) => h.branchId === branchId && !h.enabled).map((h) => h.moduleKey));
    const activosEn = new Map(sedes.map((b) => [b.id, effectiveModulesAt(state, apagadoEn(b.id)) as ReadonlySet<string>]));

    /**
     * El aviso del borrado (3.12): encendido, cuántos se borrarían y qué día si se
     * apaga hoy (`pending: false`); apagado con aviso confirmado, cuántos quedan
     * y el día ya fijado (`pending: true`). `null` si no hay nada que borrar.
     */
    const borradoDe = async (key: string, branchId: string | undefined, encendido: boolean, cambio: { enabled: boolean; erasureOn: Date | null; erasureWarned: number | null } | undefined) => {
      if (encendido) {
        const aviso = await avisoDeBorrado(orgId, key, branchId);
        return aviso ? { pending: false, count: aviso.count, on: dia(aviso.on), warned: null } : null;
      }
      if (!cambio || cambio.enabled || !cambio.erasureOn) return null;
      return { pending: true, count: (await erasureOf(key, orgId, branchId)) ?? 0, on: dia(cambio.erasureOn), warned: cambio.erasureWarned };
    };

    const modules = await Promise.all(MODULES.map(async (def) => {
      const cambio = historia.get(def.key);
      const usage = conDetalle && def.kind === 'optional' ? await usageOf(def.key, orgId) : null;
      const borra = BORRA_AL_APAGAR.has(def.key);
      // Encendido, contratado y sin nada preparado. Altas digitales no cuenta su uso: se mira el enlace.
      const sinPreparar = usage !== null && activos.has(def.key) && contratos.get(def.key) !== false
        && (def.key === 'intake' ? enlaces === 0 : usage.inUse.length === 0 && usage.blockers.length === 0);
      return {
        key: def.key, name: def.name, description: def.description, kind: def.kind,
        group: def.group, groupName: def.group ? MODULE_GROUPS[def.group] : null,
        usedBy: def.usedBy, screens: def.screens,
        requires: def.requires.map((k) => ({ key: k, name: nombre(k), fixed: MODULE_BY_KEY.get(k)?.kind === 'fixed' })),
        enabled: activos.has(def.key),
        /** Lo decide la plataforma: sin contrato no se puede encender. */
        contracted: def.kind === 'fixed' || contratos.get(def.key) !== false,
        scope: def.scope,
        // Quién lo necesita encendido: mientras alguno lo esté, no se apaga.
        dependents: dependentsOf(def.key, state).map(nombre),
        // Por sucursal: qué sedes lo usan. Una sede apaga; nunca enciende lo
        // que el gimnasio tiene apagado.
        branches: def.kind === 'optional' && def.scope === 'branch'
          ? await Promise.all(sedes.filter((b) => b.isActive).map(async (b) => {
              const cambio = porSede.find((h) => h.branchId === b.id && h.moduleKey === def.key);
              return {
                branchId: b.id, name: b.name, enabled: activosEn.get(b.id)!.has(def.key),
                canChange: request.holds('settings:branch', b.id),
                ...(conDetalle && cambio && !cambio.enabled
                  ? { reason: cambio.reason, at: cambio.updatedAt.toISOString(), byName: cambio.updatedByUserId ? nombres.get(cambio.updatedByUserId) ?? null : null }
                  : {}),
                // Lo que apagarlo ahí borraría, o lo que ya tiene fecha de borrado (3.12).
                ...(conDetalle && borra ? { erasure: await borradoDe(def.key, b.id, activosEn.get(b.id)!.has(def.key), cambio) } : {}),
              };
            }))
          : [],
        // Lo mismo para todo el gimnasio: solo Biometría borra algo al apagarse.
        ...(conDetalle && borra ? { erasure: await borradoDe(def.key, undefined, activos.has(def.key), cambio) } : {}),
        ...(usage
          ? {
              usage,
              setup: sinPreparar ? QUE_FALTA[def.key] ?? null : null,
              lastChange: cambio
                ? {
                    enabled: cambio.enabled, reason: cambio.reason, at: cambio.updatedAt.toISOString(),
                    byName: cambio.updatedByUserId ? nombres.get(cambio.updatedByUserId) ?? null : null,
                  }
                : null,
            }
          : {}),
      };
    }));
    if (!conDetalle) return { canManage, modules };
    // «Tu plan» (19-09): qué paquete contrató el gimnasio, cuántos módulos trae y cuántos se agregaron aparte.
    const opcionales = MODULES.filter((m) => m.kind === 'optional');
    const contratados = opcionales.filter((m) => contratos.get(m.key) !== false);
    const delPlan = new Set(perfil?.plan?.moduleKeys ?? []);
    const plan = {
      name: perfil?.plan?.name ?? null,
      included: perfil?.plan ? contratados.filter((m) => delPlan.has(m.key)).length : contratados.length,
      addOns: perfil?.plan ? contratados.filter((m) => !delPlan.has(m.key)).length : 0,
    };
    return { canManage, modules, plan };
  }

  route(app, {
    method: 'GET',
    url: '/organization/modules',
    security: { kind: 'session' },
    handler: (request) => estado(request),
  });

  route(app, {
    method: 'PUT',
    url: '/organization/modules/:key',
    security: { kind: 'permission', permission: 'settings:org' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      // De TODO el gimnasio: con alcance de una sede no se cambia.
      request.authorize('settings:org', { branchId: null });
      const { key } = keyParam.parse(request.params);
      const { enabled, reason, erasureAcknowledged } = changeBody.parse(request.body);

      const def = MODULE_BY_KEY.get(key);
      if (!def) throw notFound('Módulo no encontrado');
      const repo = new ModuleStateRepository(orgId);
      const [elegido, contratos] = await Promise.all([repo.state(), repo.entitlements()]);
      if (enabled && def.kind === 'optional' && contratos.get(key) === false) {
        throw new DomainError('CONFLICT', `${def.name} no está contratado para este gimnasio. Pídelo a GymFlow.`, 'MODULE_NOT_CONTRACTED');
      }
      const state = withEntitlements(elegido, contratos);
      const yaEstaba = (effectiveModules(state) as ReadonlySet<string>).has(key) === enabled;

      const cambio = changeModule(key, enabled, state);
      if (!cambio.ok) {
        if (cambio.code === 'FIXED') throw validation(`${def.name} es parte de lo básico y no se puede apagar`);
        if (cambio.code === 'HAS_DEPENDENTS') {
          const quienes = lista(cambio.dependents.map(nombre));
          throw new DomainError('CONFLICT', `No se puede apagar ${def.name} mientras ${quienes} esté encendido: lo necesita. Apaga primero ${quienes}.`, 'MODULE_HAS_DEPENDENTS');
        }
        throw notFound('Módulo no encontrado');
      }
      if (yaEstaba) return estado(request);
      if (enabled && cambio.alsoEnabled.some((k) => contratos.get(k) === false)) {
        const falta = lista(cambio.alsoEnabled.filter((k) => contratos.get(k) === false).map(nombre));
        throw new DomainError('CONFLICT', `${def.name} necesita ${falta}, que no está contratado para este gimnasio. Pídelo a GymFlow.`, 'MODULE_NOT_CONTRACTED');
      }

      if (!enabled) {
        // Apagar siempre dice por qué: es lo que leerá quien llegue a la
        // sección y la encuentre apagada.
        if (!reason || reason.length < 3) throw validation('Escribe el motivo para apagar el módulo');
        const { blockers } = await usageOf(key, orgId);
        if (blockers.length > 0) {
          throw new DomainError('CONFLICT', `Antes de apagar ${def.name} hay que resolver: ${lista(blockers)}.`, 'MODULE_BLOCKED');
        }
      }
      // Apagar Biometría borra los rostros a los 30 días (D-32): solo con el aviso leído y confirmado (3.12).
      const borrado = enabled ? null : await avisoDeBorrado(orgId, key);
      exigirAvisoConfirmado(borrado, erasureAcknowledged, def.name, '');

      await enUnaTransaccion(async () => {
        const quien = ctx.tenant.actorUserId ?? null;
        for (const requisito of cambio.alsoEnabled) await repo.set(requisito, true, quien, null);
        await repo.set(key, enabled, quien, enabled ? null : reason ?? null, borrado ? { on: borrado.on, warned: borrado.count } : null);
        // La bitácora al final de la unidad (ADR-035).
        await audit.record(ctx, {
          action: enabled ? 'settings.module.enable' : 'settings.module.disable',
          resourceType: 'Module',
          beforeState: { module: key, enabled: !enabled },
          afterState: {
            module: key, name: def.name, enabled, alsoEnabled: cambio.alsoEnabled.map(nombre),
            // Lo que el aviso decía al apagar: cuántos rostros y qué día se borran (3.12).
            ...(borrado ? { erasureWarned: borrado.count, erasureOn: dia(borrado.on) } : {}),
          },
          reason: reason ?? null,
        });
      });
      forgetModules(orgId);
      return estado(request);
    },
  });

  /**
   * Una sucursal deja de usar un módulo (o lo retoma). Lo decide la gerencia,
   * sede por sede (desde el 2026-10-06 solo hay un gerente con todo el
   * gimnasio; 19-12). Solo apaga lo que el gimnasio tiene encendido y, como en
   * todo el gimnasio, no con algo vivo ahí: Caja con un turno abierto (19-01).
   */
  route(app, {
    method: 'PUT',
    url: '/organization/modules/:key/branches/:branchId',
    security: { kind: 'permission', permission: 'settings:branch' },
    handler: async (request) => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const { key, branchId } = branchParam.parse(request.params);
      const { enabled, reason, erasureAcknowledged } = changeBody.parse(request.body);
      const sede = await new BranchRepository(orgId).findById(branchId);
      if (!sede) throw notFound('Sucursal no encontrada');
      request.authorize('settings:branch', { branchId });

      const def = MODULE_BY_KEY.get(key);
      if (!def) throw notFound('Módulo no encontrado');
      if (!canDisableAtBranch(key)) throw validation(`${def.name} es de todo el gimnasio: se enciende o apaga para todas las sucursales`);
      const repo = new ModuleStateRepository(orgId);
      const [elegido, porSede, contratos] = await Promise.all([repo.state(), repo.branchDisabled(), repo.entitlements()]);
      const state = withEntitlements(elegido, contratos);
      if (!(effectiveModules(state) as ReadonlySet<string>).has(key)) {
        throw new DomainError('CONFLICT', `${def.name} está apagado en todo el gimnasio: una sucursal no lo puede encender por su cuenta`, 'MODULE_OFF_IN_ORG');
      }
      const apagados = new Set(porSede.get(branchId) ?? []);
      const antes = effectiveModulesAt(state, apagados) as ReadonlySet<string>;
      if (antes.has(key) === enabled) return estado(request);

      if (!enabled) {
        if (!reason || reason.length < 3) throw validation('Escribe el motivo para dejar de usar el módulo en esta sucursal');
        const dependientes = [...antes].filter((k) => k !== key && !(effectiveModulesAt(state, new Set([...apagados, key])) as ReadonlySet<string>).has(k));
        if (dependientes.length > 0) {
          const quienes = lista(dependientes.map(nombre));
          throw new DomainError('CONFLICT', `En ${sede.name} no se puede apagar ${def.name} mientras ${quienes} esté encendido: lo necesita. Apaga primero ${quienes}.`, 'MODULE_HAS_DEPENDENTS');
        }
        const { blockers } = await usageOf(key, orgId, branchId);
        if (blockers.length > 0) {
          throw new DomainError('CONFLICT', `Antes de apagar ${def.name} en ${sede.name} hay que resolver: ${lista(blockers)}.`, 'MODULE_BLOCKED');
        }
      }
      // Los rostros tomados en esa sucursal se borran a los 30 días: solo con el aviso confirmado (3.12).
      const borrado = enabled ? null : await avisoDeBorrado(orgId, key, branchId);
      exigirAvisoConfirmado(borrado, erasureAcknowledged, def.name, ` en ${sede.name}`);

      await enUnaTransaccion(async () => {
        await repo.setBranch(branchId, key, enabled, ctx.tenant.actorUserId ?? null, enabled ? null : reason ?? null, borrado ? { on: borrado.on, warned: borrado.count } : null);
        await audit.record(ctx, {
          action: enabled ? 'settings.module.branch.enable' : 'settings.module.branch.disable',
          resourceType: 'Module', branchId,
          beforeState: { module: key, branchId, enabled: !enabled },
          afterState: { module: key, name: def.name, branchId, branchName: sede.name, enabled, ...(borrado ? { erasureWarned: borrado.count, erasureOn: dia(borrado.on) } : {}) },
          reason: reason ?? null,
        });
      });
      forgetModules(orgId);
      return estado(request);
    },
  });
}
