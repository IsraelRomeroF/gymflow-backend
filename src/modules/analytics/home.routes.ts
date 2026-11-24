import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ModuleKey, PermissionKey } from '@gymflow/core';
import { ASUNTOS_DEL_INICIO, MeHome, type AsuntoDelInicio, type RenglonDelInicio } from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { recordar } from '../../platform/cache.js';
import { moduleViewOf } from '../../platform/modules/module-state.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { BranchRepository, OrganizationRepository } from '../organization/index.js';
import { EnrollmentService, pendientesDeLaPuerta } from '../access/index.js';
import { RetentionService } from '../retention/index.js';
import { ProspectRepository } from '../prospects/index.js';
import { medianoche } from './pulse.service.js';
import { HomeRepository } from './home.repository.js';

/** Los textos sin los que no se puede dar de alta; el biométrico, solo si el gimnasio usa Biometría. */
const TEXTOS_OBLIGATORIOS = ['PRIVACY_NOTICE', 'HOUSE_RULES'] as const;
/** La cifra de Retención cambia despacio: el Inicio se abre veinte veces al día. */
const VIGENCIA_RIESGO_MS = 60_000;
/** «Socio nuevo» para el aviso de sin coach (D-29): dado de alta en los últimos 7 días. */
const DIAS_DE_SOCIO_NUEVO = 7;

type Parte = Omit<RenglonDelInicio, 'key'> | null;
const renglon = (count: number, tone: RenglonDelInicio['tone'], extra: Partial<Pick<RenglonDelInicio, 'amountCents' | 'detail' | 'until' | 'waiting'>> = {}): Parte =>
  (count > 0 ? { count, tone, amountCents: null, detail: [], until: null, ...extra } : null);

/**
 * `GET /me/home` · «HOY TE TOCA» (auditoría 8, bloque 2.1; 1-01, A1-T9).
 *
 * Una llamada arma la bandeja del inicio de quien opera. Antes el panel hacía
 * cinco peticiones y decidía él qué mostrar; el gerente veía «Todo al día»
 * con rechazos sin resolver, cajas de ayer y socios por decidir.
 *
 * Reglas:
 *  - cada asunto SOLO si esta persona lo puede resolver: su permiso, en las
 *    sedes donde lo tiene (la llave del dueño ya viene aplicada a la sesión),
 *    y con el módulo encendido en esa sede;
 *  - un asunto en cero no viaja;
 *  - si un asunto no se pudo revisar, va en `unchecked` y los demás salen;
 *  - el orden es el de `ASUNTOS_DEL_INICIO`: primero lo que detiene al mostrador.
 * No trae cifras del negocio (eso es `/dashboard`) ni nada del turno (`/me/shift`).
 */
export function registerHomeRoutes(app: FastifyInstance): void {
  const retention = new RetentionService();
  const enrollments = new EnrollmentService();

  route(app, {
    method: 'GET',
    url: '/me/home',
    security: { kind: 'session' },
    schema: respuesta(200, MeHome),
    handler: async (request): Promise<MeHome> => {
      const ctx = request.ctx!;
      const orgId = ctx.tenant.organizationId;
      const ahora = new Date();
      const [todas, modulos, zona] = await Promise.all([
        new BranchRepository(orgId).list(), moduleViewOf(orgId), new OrganizationRepository(orgId).effectiveTimezone(null),
      ]);
      const activas = todas.filter((b) => b.isActive);
      /** Las sedes donde tiene el permiso y el módulo está encendido. */
      const sedesCon = (permiso: PermissionKey, modulo?: ModuleKey): string[] =>
        activas.filter((b) => request.holds(permiso, b.id) && (!modulo || modulos.at(b.id).has(modulo))).map((b) => b.id);
      const repo = new HomeRepository(orgId);
      const calendario = new BusinessCalendar(orgId);
      const hoyDe = (sedes: readonly string[]) => Promise.all(sedes.map((s) => calendario.today(s)));

      const asuntos: Record<AsuntoDelInicio, () => Promise<Parte>> = {
        signatures: async () => {
          const yo = ctx.tenant.actorUserId;
          if (!yo) return null;
          const f = await repo.firmasPedidas(yo, ahora);
          return renglon(f.total, 'danger', { until: f.vence?.toISOString() ?? null });
        },
        door: async () => {
          if (sedesCon('access:monitor').length === 0) return null;
          return renglon((await pendientesDeLaPuerta(request)).length, 'danger');
        },
        registers: async () => {
          const sedes = sedesCon('cash:session:read', 'cash');
          const cajas = await repo.cajasDeAyer(sedes, await hoyDe(sedes));
          return renglon(cajas.length, 'warn', { detail: cajas.slice(0, 4) });
        },
        biometrics: async () => {
          const sedes = new Set(sedesCon('audit:read', 'biometrics'));
          if (sedes.size === 0) return null;
          const { overdue } = await enrollments.pendingDeletions(orgId, ahora);
          return renglon(overdue.filter((e) => sedes.has(e.branchId)).length, 'danger');
        },
        debts: async () => renglon(await repo.suspendidasPorDecidir(sedesCon('billing:charge:create'), await calendario.today(null)), 'warn'),
        texts: async () => {
          // Publicar es de todo el gimnasio: solo a quien puede hacerlo.
          if (!request.holds('settings:consent:manage', null)) return null;
          const publicados = await repo.textosPublicados();
          const faltan = [...TEXTOS_OBLIGATORIOS, ...(modulos.org.has('biometrics') ? ['BIOMETRIC'] : [])].filter((t) => !publicados.has(t));
          // Lo que ya se pidió publicar y espera la firma de la dueña no es «falta publicar» (3.12, D-25).
          const esperan = faltan.length > 0 ? await repo.textosEsperandoFirma() : new Set<string>();
          return renglon(faltan.length, 'warn', { detail: faltan, waiting: faltan.filter((t) => esperan.has(t)) });
        },
        classes: async () => {
          const hoy = medianoche(zona, ahora);
          return renglon(await repo.clasesSinCoach(sedesCon('classes:manage', 'classes'), ahora, new Date(hoy.getTime() + 86_400_000)), 'warn');
        },
        intakes: async () => renglon(await repo.altasPorRevisar(sedesCon('members:intake:review', 'intake')), 'info'),
        // D-29 (3.16): los socios de esta semana que nadie tiene de coach, para quien se lo puede poner.
        coachless: async () => {
          const r = await repo.nuevosSinCoach(sedesCon('members:coach:assign'), new Date(ahora.getTime() - DIAS_DE_SOCIO_NUEVO * 86_400_000));
          return renglon(r.total, 'info', { detail: r.nombres });
        },
        // La misma cuenta que la bandeja de interesados (2.4): los que tocan hoy más los que nadie ha contactado.
        prospects: async () => {
          const sedes = sedesCon('members:create', 'prospects');
          if (sedes.length === 0) return null;
          const p = await new ProspectRepository(orgId).pending(sedes, await calendario.today(null));
          return renglon(p.today + p.uncontacted, p.today > 0 ? 'warn' : 'info');
        },
        retention: async () => {
          const sedes = sedesCon('reports:branch:read', 'retention');
          if (sedes.length === 0) return null;
          // Con alcance de todo el gimnasio, una sola cuenta; si no, la suma de sus sedes.
          const alcances: Array<string | null> = request.holds('reports:branch:read', null) && sedes.length === activas.length ? [null] : sedes;
          const cifras = await Promise.all(alcances.map((s) =>
            recordar(`home-riesgo:${orgId}:${s ?? '*'}`, VIGENCIA_RIESGO_MS, () => retention.figures(ctx, { branchId: s }))));
          return renglon(cifras.reduce((a, c) => a + c.atRisk, 0), 'info');
        },
      };

      const items: RenglonDelInicio[] = [];
      const unchecked: AsuntoDelInicio[] = [];
      const partes = await Promise.allSettled(ASUNTOS_DEL_INICIO.map((k) => asuntos[k]()));
      partes.forEach((p, i) => {
        const key = ASUNTOS_DEL_INICIO[i]!;
        if (p.status === 'rejected') { unchecked.push(key); avisar(request, key, p.reason); return; }
        if (p.value) items.push({ key, ...p.value });
      });
      return { asOf: ahora.toISOString(), items, unchecked };
    },
  });
}

/** Un asunto que falla no tumba el inicio, pero queda en el registro: `unchecked` sin causa no se puede arreglar. */
function avisar(request: FastifyRequest, key: string, causa: unknown): void {
  request.log.warn({ asunto: key, err: causa }, 'inicio: no se pudo revisar un asunto de la bandeja');
}
