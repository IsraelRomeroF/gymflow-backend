import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nombrePersona } from '../../platform/http/person-name.js';
import { telefonoMx } from '../../platform/http/phone.js';
import { z } from 'zod';
import { INTAKE_CORRECTABLE_FIELDS, forbidden, intakeFolio, notFound, validation } from '@gymflow/core';
import {
  ConsentDocumentList, IntakeCorrectionsSaved, IntakeDetail, IntakeList, IntakeResolved, PAGINA_MAXIMA, PAGINA_POR_OMISION, leerCursor,
} from '@gymflow/core/contracts';
import { route } from '../../platform/http/registry.js';
import { respuesta } from '../../platform/http/respuesta.js';
import { DemasiadosIntentos, MENSAJE_POR_SUCURSAL, tiempoParaReintentar } from '../../platform/http/rate-limit.js';
import { contar, registerModuleUsage } from '../../platform/modules/usage.js';
import { isModuleOnAt } from '../../platform/modules/module-state.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ConsentDocumentRepository, esAvisoPorFirmar, guardianSchema, listarTextos, pedirFirmaDelAviso, publicarTexto, responsibleSchema, retirarTexto } from '../members/index.js';
import { planesPublicos } from '../prospects/index.js';
import { IntakeRepository, datosBorrados } from './intake.repository.js';
import { IntakeService, correccionesVigentes } from './intake.service.js';
import { registerOnboardingRoutes } from './onboarding.routes.js';
import type { Env } from '../../platform/env.js';

const idParam = z.object({ id: z.string().uuid() });
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const diaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Escribe la fecha como año-mes-día');
/**
 * Lo que recepción completa o corrige; solo viajan los campos que cambió y
 * `null` borra el dato. El mismo cuerpo para guardar sin aprobar, aprobar y vincular.
 */
const correctionsBody = z.object({
  firstName: nombrePersona(80), lastName: nombrePersona(80),
  phoneE164: telefonoMx().nullable(), email: z.string().email('Correo inválido').max(160).or(z.literal('')).nullable(),
  birthDate: diaIso.or(z.literal('')).nullable(), memberSince: diaIso.or(z.literal('')).nullable(),
  emergencyContactName: z.string().trim().max(120).nullable(), emergencyContactPhone: telefonoMx().nullable(),
} satisfies Record<(typeof INTAKE_CORRECTABLE_FIELDS)[number], z.ZodType>).partial();

/** Sin las claves que no vinieron: `{}` y «no mandó nada» son lo mismo. */
function limpias(c: z.infer<typeof correctionsBody> | undefined): Record<string, string | null> | undefined {
  if (!c) return undefined;
  const out = Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) as Record<string, string | null>;
  return Object.keys(out).length > 0 ? out : undefined;
}

const draftBody = z.object({
  firstName: nombrePersona(80),
  lastName: nombrePersona(80),
  phone: telefonoMx().nullish().transform((v) => v || null),
  email: z.string().max(160).nullish().transform((v) => v ?? null),
  birthDate: z.coerce.date().nullish().transform((v) => v ?? null),
  emergencyContactName: nombrePersona(120).or(z.literal('')).nullish().transform((v) => v ?? null),
  emergencyContactPhone: telefonoMx().nullish().transform((v) => v || null),
  memberSince: z.coerce.date().nullish().transform((v) => v ?? null),
  healthNotes: z.string().max(1000).nullish().transform((v) => v ?? null),
  // D-10: «¿Tienes 18 años o más?» y, de 15 a 17, su papá, mamá o tutor.
  adult: z.boolean().nullish().transform((v) => v ?? null),
  guardianName: nombrePersona(120).or(z.literal('')).nullish().transform((v) => v || null),
  guardianPhone: telefonoMx().nullish().transform((v) => v || null),
  consents: z.array(z.object({
    consentType: z.enum(['PRIVACY_NOTICE', 'HOUSE_RULES', 'HEALTH_DATA', 'MARKETING']),
    version: z.string().min(1).max(40),
    granted: z.boolean(),
  })).max(10),
});

/**
 * Lo que decide quien revisa además de corregir (bloque 3.4): el responsable
 * del celular compartido (D-09) y la firma del tutor en el mostrador (D-10),
 * con lo de la salud, que solo el tutor puede autorizar.
 */
const decisionBody = {
  corrections: correctionsBody.optional(),
  responsible: responsibleSchema.optional(),
  guardian: guardianSchema.extend({
    healthConsent: z.boolean().default(false),
    healthNotes: z.string().trim().max(1000).nullish(),
  }).optional(),
};

export function registerIntakeRoutes(app: FastifyInstance, env: Env): void {
  // Quien ya llenó sus datos espera respuesta: no se apaga con altas por revisar.
  registerModuleUsage('intake', async (orgId, branchId) => ({
    inUse: [],
    blockers: contar(await new IntakeRepository(orgId).pendingCount(branchId ? [branchId] : null), 'alta por revisar', 'altas por revisar'),
  }));
  const service = new IntakeService();
  const audit = new AuditService();
  // El cierre del alta, único para las tres puertas (`GET /members/:id/onboarding`).
  registerOnboardingRoutes(app);

  // ── Formulario público ────────────────────────────────────────────────────

  /**
   * Las rutas públicas no pasan por la puerta de módulos del registro: no
   * traen sesión de la que sacar el gimnasio. Aquí ya se sabe cuál es.
   * Responde 404, no "módulo apagado": a quien escanea un cartel viejo no
   * hay por qué contarle cómo está configurado el gimnasio.
   */
  async function exigirAltasEncendidas(orgId: string, branchId: string): Promise<void> {
    if (!(await isModuleOnAt(orgId, branchId, 'intake'))) {
      throw notFound('El alta en línea no está disponible en este gimnasio. Pasa al mostrador y con gusto te registramos.');
    }
  }

  route(app, {
    method: 'GET',
    url: '/intake/:id/form',
    security: {
      kind: 'public',
      why: 'Es el formulario que abre el socio al escanear el QR del mostrador; no hay sesión todavía',
    },
    config: { rateLimit: { max: 60, timeWindow: '5 minutes' } },
    handler: async (request) => {
      // El :id es la SUCURSAL. La organización se deriva de ella: aceptar un
      // organizationId del cliente sería el fallo clásico de multi-tenancy.
      const { id: orgId, branchId } = await sedePublica(request.params);
      await exigirAltasEncendidas(orgId, branchId);
      // D-31 (bloque 4.7, edición puntual): quien escanea el cartel ve los planes que vende ESA
      // sucursal con su precio de lista, sin promociones. Es público a propósito: es la lista de precios.
      return { ...(await service.form(orgId, branchId)), branchId, plans: await planesPublicos(orgId, branchId) };
    },
  });

  route(app, {
    method: 'POST',
    url: '/intake/:id',
    security: {
      kind: 'public',
      why: 'El socio se registra desde su teléfono y no tiene cuenta todavía; solo crea un BORRADOR que recepción revisa',
    },
    // Más estricto que el formulario: esto escribe. No hay cuenta que
    // bloquear, así que los límites son la única barrera contra el llenado
    // automático de la bandeja de revisión. Dos, y ninguno por red (9-05,
    // D28-01): este cuenta por TELÉFONO capturado (`platform/http/rate-limit.ts`)
    // y el de la sucursal, abajo, las altas aceptadas en una hora. En una
    // promoción, veinte teléfonos salen por la misma IP del gimnasio.
    config: { rateLimit: { max: env.INTAKE_SUBMIT_ATTEMPTS, timeWindow: '10 minutes' } },
    handler: async (request, reply) => {
      const { id: orgId, branchId } = await sedePublica(request.params);
      await exigirAltasEncendidas(orgId, branchId);
      const body = draftBody.parse(request.body);

      // Por la sucursal resuelta, no por el texto del enlace: el corto y el
      // UUID de la misma sede comparten cupo.
      const espera = app.topes.altasPorSucursal.espera(branchId);
      if (espera > 0) throw new DemasiadosIntentos(espera, MENSAJE_POR_SUCURSAL(tiempoParaReintentar(espera)));

      const intake = await service.submit(orgId, {
        branchId,
        draft: body,
        accepted: body.consents,
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
        maxPendientes: env.INTAKE_PENDING_MAX_PER_BRANCH,
      });
      // Solo cuenta el alta que entró: un envío con datos inválidos no le
      // quita lugar a la siguiente persona de la fila.
      app.topes.altasPorSucursal.gastar(branchId);

      // Se devuelve lo mínimo: el borrador no es del socio todavía, y un eco
      // completo convertiría este endpoint en un lector de datos ajenos.
      // El folio es lo que la persona dicta en recepción para que la encuentren (9-06).
      return reply.status(201).send({ id: intake.id, folio: intakeFolio(intake.id), submittedAt: iso(intake.submittedAt) });
    },
  });

  // ── Bandeja de revisión ───────────────────────────────────────────────────

  /**
   * El alta pertenece a una sede: solo la aprueba o rechaza quien opera ahí.
   *
   * `notaDeSalud` (D-33 y choque 6 del consolidado; bloque 4.7, edición
   * puntual): la nota de salud de un menor la dicta su tutor al firmar, y la
   * ESCRIBE solo quien puede leerla (`members:health:read` en esa sede: la
   * gerencia, o la persona a quien se lo encendieron con motivo). Recepción,
   * con su puesto, registra el permiso del tutor pero no teclea la nota: un
   * dato sensible no lo escribe quien después no puede ni verlo.
   */
  async function autorizarSede(request: FastifyRequest, intakeId: string, notaDeSalud?: string | null): Promise<void> {
    const intake = await new IntakeRepository(request.ctx!.tenant.organizationId).findById(intakeId);
    if (!intake) throw notFound('Alta no encontrada');
    request.requirePermission('members:intake:review', intake.branchId);
    if (notaDeSalud?.trim() && !request.holds('members:health:read', intake.branchId)) {
      throw forbidden('La nota de salud la escribe quien puede verla: la gerencia. Aprueba el alta sin la nota (el permiso del tutor sí queda) o pide a la gerencia que la apruebe');
    }
  }

  /** Solo el número de la bandeja: el menú del panel lo muestra en cada pantalla (OPT-07). */
  route(app, {
    method: 'GET',
    url: '/intakes/pending-count',
    security: { kind: 'permission', permission: 'members:intake:read' },
    handler: async (request) => {
      const sedes = request.branchScope('members:intake:read');
      return { pending: await new IntakeRepository(request.ctx!.tenant.organizationId).pendingCount(sedes) };
    },
  });

  route(app, {
    method: 'GET',
    url: '/intakes',
    security: { kind: 'permission', permission: 'members:intake:read' },
    schema: respuesta(200, IntakeList),
    handler: async (request): Promise<IntakeList> => {
      const q = z.object({
        status: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED']).optional(),
        /** Una sola sede, para quien ve varias (9-09). */
        branchId: z.string().uuid().optional(),
        /** Nombre, celular o el folio que dicta el socio (9-06). */
        q: z.string().trim().max(80).optional(),
        cursor: z.string().max(400).optional(),
        limit: z.coerce.number().int().min(1).max(PAGINA_MAXIMA).default(PAGINA_POR_OMISION),
      }).parse(request.query);
      const cursor = q.cursor === undefined ? null : leerCursor(q.cursor);
      if (q.cursor !== undefined && !cursor) throw validation('Esa página ya no existe. Vuelve a abrir la lista.');
      if (q.branchId) request.requirePermission('members:intake:read', q.branchId);

      const orgId = request.ctx!.tenant.organizationId;
      const repo = new IntakeRepository(orgId);
      // Recepción de una sede ve SU bandeja, no la de todas.
      const sedes = q.branchId ? [q.branchId] : request.branchScope('members:intake:read');
      const estado = q.status ?? 'SUBMITTED';
      const [pagina, pending] = await Promise.all([repo.page(estado, q.limit, cursor, sedes, { q: q.q }), repo.pendingCount(sedes)]);
      const nombres = await repo.staffNames(pagina.items.map((r) => r.reviewedByUserId));
      // Las insignias solo sirven para decidir: en la bandeja, no en el historial.
      const insignias = estado === 'SUBMITTED' ? await service.flagsFor(orgId, pagina.items) : null;
      // Contrato: `IntakeList` (`@gymflow/core/contracts`). Por páginas y con quién revisó (9-14).
      return {
        ...pagina,
        pending,
        items: pagina.items.map((r) => {
          const scrubbed = datosBorrados(r);
          return {
            id: r.id,
            branchId: r.branchId,
            status: r.status,
            // A los 90 días de revisada se borran sus datos: se dice, no se pinta «[eliminado] [eliminado]».
            fullName: scrubbed ? 'Datos borrados' : `${r.firstName} ${r.lastName}`,
            phoneE164: r.phoneE164,
            email: r.email,
            memberSince: day(r.memberSince),
            submittedAt: r.submittedAt.toISOString(),
            // Para el historial: a qué socio dio lugar, o por qué se rechazó.
            memberId: r.memberId,
            rejectionReason: r.rejectionReason,
            reviewedAt: r.reviewedAt ? iso(r.reviewedAt) : null,
            reviewedByUserId: r.reviewedByUserId,
            reviewedByName: r.reviewedByUserId ? nombres.get(r.reviewedByUserId) ?? null : null,
            scrubbed,
            folio: intakeFolio(r.id),
            flags: insignias?.get(r.id) ?? [],
          };
        }),
      };
    },
  });

  route(app, {
    method: 'GET',
    url: '/intakes/:id',
    security: { kind: 'permission', permission: 'members:intake:read' },
    schema: respuesta(200, IntakeDetail),
    handler: async (request): Promise<IntakeDetail> => {
      const { id } = idParam.parse(request.params);
      const orgId = request.ctx!.tenant.organizationId;
      const v = await service.review(orgId, id);
      request.requirePermission('members:intake:read', v.intake.branchId);
      // La nota de salud es un dato SENSIBLE: la ve quien tiene su permiso,
      // no cualquiera que revise altas. Los demás solo saben que existe.
      // De un menor no se enseña ninguna (D-10): lo de salud lo autoriza y lo dice su tutor al firmar.
      const veSalud = !v.minor && request.holds('members:health:read', v.intake.branchId);
      if (veSalud && v.intake.healthNotes) {
        await audit.record(request.ctx!, {
          action: 'health.read', resourceType: 'MemberIntake', resourceId: v.intake.id, branchId: v.intake.branchId,
        });
      }
      const corrigio = v.intake.correctedByUserId
        ? (await new IntakeRepository(orgId).staffNames([v.intake.correctedByUserId])).get(v.intake.correctedByUserId) ?? null : null;
      const corrections = correccionesVigentes(v.intake, v.intake.corrections);
      // Contrato: `IntakeDetail`. La IP ya no viaja (9-15): es evidencia de la firma, no un dato para decidir.
      return {
        intake: {
          id: v.intake.id,
          branchId: v.intake.branchId,
          status: v.intake.status,
          folio: intakeFolio(v.intake.id),
          firstName: v.intake.firstName,
          lastName: v.intake.lastName,
          phoneE164: v.intake.phoneE164,
          email: v.intake.email,
          birthDate: day(v.intake.birthDate),
          emergencyContactName: v.intake.emergencyContactName,
          emergencyContactPhone: v.intake.emergencyContactPhone,
          memberSince: day(v.intake.memberSince),
          healthNotes: veSalud ? v.intake.healthNotes : null,
          hasHealthNotes: !v.minor && !!v.intake.healthNotes,
          acceptedConsents: v.intake.acceptedConsents,
          submittedAt: v.intake.submittedAt.toISOString(),
          corrections: Object.keys(corrections).length > 0 ? corrections as Record<string, string | null> : null,
          correctedAt: iso(v.intake.correctedAt),
          correctedByName: corrigio,
          minor: v.minor,
          guardianName: v.intake.guardianName,
          guardianPhoneE164: v.intake.guardianPhoneE164,
        },
        suggestion: v.suggestion,
        // Con nombre y código: recepción decide "es la misma persona" viendo a
        // quién, no un identificador.
        matches: v.matches,
        pendingFields: v.pendingFields,
        // El interesado de otra sede se convierte igual al aprobar; aquí solo se dice que lo era.
        prospect: v.prospect ? { ...v.prospect, status: v.prospect.status as NonNullable<IntakeDetail['prospect']>['status'] } : null,
        flags: v.flags,
      };
    },
  });

  /**
   * «Guardar sin aprobar» (9-21): lo corregido queda en el borrador para que
   * no se pierda al cambiar de alta o al recargar, y lo pueda terminar otra
   * persona. `corrections: null` descarta lo guardado.
   */
  route(app, {
    method: 'PATCH',
    url: '/intakes/:id/corrections',
    security: { kind: 'permission', permission: 'members:intake:review' },
    schema: respuesta(200, IntakeCorrectionsSaved),
    handler: async (request): Promise<IntakeCorrectionsSaved> => {
      const { id } = idParam.parse(request.params);
      const { corrections } = z.object({ corrections: correctionsBody.nullable() }).parse(request.body);
      await autorizarSede(request, id);
      const orgId = request.ctx!.tenant.organizationId;
      const r = await service.saveCorrections(request.ctx!, id, corrections ? limpias(corrections) ?? null : null);
      const vigentes = correccionesVigentes(r, r.corrections);
      return {
        corrections: Object.keys(vigentes).length > 0 ? vigentes as Record<string, string | null> : null,
        correctedAt: iso(r.correctedAt),
        correctedByName: r.correctedByUserId ? (await new IntakeRepository(orgId).staffNames([r.correctedByUserId])).get(r.correctedByUserId) ?? null : null,
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/intakes/:id/approve',
    security: { kind: 'permission', permission: 'members:intake:review' },
    schema: respuesta(201, IntakeResolved),
    handler: async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { force, corrections, responsible, guardian, coachUserId } = z.object({
        force: z.boolean().default(false),
        // Lo que recepción completa o corrige en este momento; se suma a lo que ya había guardado.
        ...decisionBody,
        // D-29 (bloque 3.8): quien aprueba elige el coach, igual que en el alta del mostrador.
        coachUserId: z.string().uuid().nullish(),
      }).parse(request.body ?? {});
      await autorizarSede(request, id, guardian?.healthConsent ? guardian.healthNotes : null);
      const c = limpias(corrections);
      const r = await service.approve(request.ctx!, id, { force, responsible, guardian, coachUserId, ...(c ? { corrections: c } : {}) });
      return reply.status(201).send(r);
    },
  });

  /** Es la misma persona que una ficha existente: se vincula en lugar de duplicar. */
  route(app, {
    method: 'POST',
    url: '/intakes/:id/link',
    security: { kind: 'permission', permission: 'members:intake:review' },
    schema: respuesta(201, IntakeResolved),
    handler: async (request, reply) => {
      const { id } = idParam.parse(request.params);
      // Con lo corregido, igual que aprobar (9-03): antes la corrección se descartaba sin aviso.
      const { memberId, corrections, responsible, guardian } = z.object({ memberId: z.string().uuid(), ...decisionBody }).parse(request.body);
      await autorizarSede(request, id, guardian?.healthConsent ? guardian.healthNotes : null);
      const c = limpias(corrections);
      return reply.status(201).send(await service.link(request.ctx!, id, memberId, { responsible, guardian, ...(c ? { corrections: c } : {}) }));
    },
  });

  route(app, {
    method: 'POST',
    url: '/intakes/:id/reject',
    security: { kind: 'permission', permission: 'members:intake:review' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      // `reasonCode`: uno de los motivos de un toque (`rechazarAlta`); con «Otro…», lo escrito en `reason`.
      const { reason, reasonCode } = z.object({ reason: z.string().trim().max(300).default(''), reasonCode: z.string().max(40).optional() })
        .refine((b) => !!b.reasonCode || b.reason.length >= 3, { message: 'Escribe el motivo (3 letras o más)', path: ['reason'] })
        .parse(request.body);
      await autorizarSede(request, id);
      await service.reject(request.ctx!, id, reason, reasonCode);
      return { ok: true };
    },
  });

  // ── Textos de consentimiento ──────────────────────────────────────────────

  route(app, {
    method: 'GET',
    url: '/consent-documents',
    module: 'core',
    // `settings:consent:read` (3.7, D-25): la dueña lee los textos legales sin abrir expedientes.
    security: { kind: 'permission', permission: 'members:consent:read', anyOf: ['settings:consent:read'] },
    schema: respuesta(200, ConsentDocumentList),
    handler: async (request) => {
      // Con el historial (1.10, 21-07): cuándo se retiró cada versión y cuántas firmas la guardan.
      return { documents: await listarTextos(request.ctx!.tenant.organizationId) };
    },
  });

  /**
   * Un texto completo. El listado no trae el cuerpo porque son hasta 60 KB por
   * documento; se pide cuando alguien lo va a leer — por ejemplo, el socio
   * delante del mostrador antes de dar su consentimiento biométrico.
   */
  route(app, {
    method: 'GET',
    url: '/consent-documents/:id',
    module: 'core',
    security: { kind: 'permission', permission: 'members:consent:read', anyOf: ['settings:consent:read'] },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const d = await new ConsentDocumentRepository(request.ctx!.tenant.organizationId).findById(id);
      if (!d) throw notFound('Documento no encontrado');
      return {
        id: d.id,
        consentType: d.consentType,
        version: d.version,
        status: d.status,
        title: d.title,
        bodyText: d.bodyText,
        publishedAt: iso(d.publishedAt),
        bodyHash: d.bodyHash,
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/consent-documents',
    module: 'core',
    security: { kind: 'permission', permission: 'settings:consent:manage' },
    handler: async (request, reply) => {
      const body = z.object({
        consentType: z.enum([
          'PRIVACY_NOTICE', 'BIOMETRIC', 'RECURRING_CHARGE', 'MARKETING', 'HOUSE_RULES', 'HEALTH_DATA',
        ]),
        version: z.string().min(1).max(40),
        title: z.string().min(3).max(200),
        bodyText: z.string().min(20).max(60_000),
      }).parse(request.body);

      // Nace en BORRADOR siempre: publicar es un acto aparte, con su motivo.
      const doc = await new ConsentDocumentRepository(request.ctx!.tenant.organizationId).create(body);
      return reply.status(201).send({ id: doc.id, status: doc.status });
    },
  });

  route(app, {
    method: 'POST',
    url: '/consent-documents/:id/publish',
    module: 'core',
    security: { kind: 'permission', permission: 'settings:consent:manage' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      // `checklist`: los puntos del aviso de privacidad que la gerencia marcó como revisados (1.10, 21-08).
      const { reason, checklist } = z.object({ reason: z.string().min(3).max(300), checklist: z.array(z.string().max(40)).max(30).optional() }).parse(request.body);
      const ctx = request.ctx!;
      request.authorize('settings:consent:manage', { reason, branchId: null });

      // D-25 (fase 3, bloque 3.7): el aviso de privacidad NO se publica sin la firma de la dueña.
      // Quien no firma por todo el gimnasio deja la solicitud; ella lo lee y lo firma
      // (`POST /consent-documents/:id/sign`, `members/aviso-firma.ts`). Los demás textos, como siempre.
      if (!request.holds('approvals:grant', null) && await esAvisoPorFirmar(ctx.tenant.organizationId, id)) {
        return { ok: true, publishedAt: null, ...(await pedirFirmaDelAviso(ctx, id, reason, checklist)) };
      }

      // Solo un borrador, sin corchetes y, si es el aviso, con lo mínimo y revisado punto por punto.
      const doc = await publicarTexto(ctx.tenant.organizationId, id, ctx.tenant.actorUserId ?? null, checklist);

      await audit.record(ctx, {
        action: 'consent.document.publish',
        resourceType: 'consent_document',
        resourceId: id,
        reason,
        afterState: { consentType: doc.consentType, version: doc.version, bodyHash: doc.bodyHash, ...(checklist?.length ? { checklist } : {}) },
      });
      return { ok: true, status: doc.status, publishedAt: iso(doc.publishedAt), awaitingSignature: false };
    },
  });

  route(app, {
    method: 'POST',
    url: '/consent-documents/:id/retire',
    module: 'core',
    security: { kind: 'permission', permission: 'settings:consent:manage' },
    handler: async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(request.body);
      const ctx = request.ctx!;
      request.authorize('settings:consent:manage', { reason, branchId: null });

      // Sin reemplazo solo se retiran los opcionales (1.10, 21-07).
      const ok = await retirarTexto(ctx.tenant.organizationId, id);
      if (ok) {
        await audit.record(ctx, {
          action: 'consent.document.retire',
          resourceType: 'consent_document',
          resourceId: id,
          reason,
        });
      }
      return { ok };
    },
  });
}

/**
 * Sucursal → organización.
 *
 * Es la única resolución de tenant que NO viene de la sesión, y por eso se
 * hace aquí y con el identificador de la URL: un `organizationId` aceptado
 * desde el cuerpo de una petición pública es el ataque clásico de
 * multi-tenancy.
 */
async function sedePublica(params: unknown): Promise<{ id: string; branchId: string }> {
  const { BranchRepository } = await import('../organization/index.js');
  const { notFound } = await import('@gymflow/core');
  // El id de la sucursal o su enlace corto (`fuerza-centro`).
  const parsed = z.object({ id: z.string().trim().min(1).max(64) }).safeParse(params);
  const r = parsed.success ? await BranchRepository.resolvePublic(parsed.data.id) : null;
  // Antes un enlace mal escrito decía "Datos de entrada inválidos" (UXB-14).
  if (!r) throw notFound('Esa sucursal no existe. Revisa el enlace o pregunta en recepción');
  return { id: r.organizationId, branchId: r.branchId };
}
