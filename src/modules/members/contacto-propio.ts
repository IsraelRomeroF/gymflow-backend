import { z, ZodError } from 'zod';
import {
  AUTO_MERGE_THRESHOLD, CONTACT_CHANGE_LIMITS, CONTACT_CHANGE_WINDOW_DAYS, CONTACT_CONFIRM_MAX_FAILURES, CONTACT_CONFIRM_WINDOW_MINUTES,
  PORTAL_RESPONSIBLE_KINDS, confirmaCon, confirmacionCorrecta, conflict, limiteDe, mascaraDeCelular, mascaraDeCorreo, normalizeEmail,
  normalizePhoneMx, notFound, rankMatches, ultimos4, validation,
  type ContactField, type ContactLimitKey, type ResponsibleKind,
} from '@gymflow/core';
import type { ContactLimit, PortalContact } from '@gymflow/core/contracts';
import type { RequestContext } from '../../platform/context.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { nombrePersona } from '../../platform/http/person-name.js';
import { DemasiadosIntentos, tiempoParaReintentar } from '../../platform/http/rate-limit.js';
import { telefonoMx } from '../../platform/http/phone.js';
import { ContactChangeRepository } from './contact-change.repository.js';
import { MemberRepository, type MemberRecord } from './member.repository.js';
import { ResponsibleRepository, type ResponsibleColumns } from './responsible.js';

/**
 * EL SOCIO CAMBIA SUS DATOS DE CONTACTO DESDE EL PORTAL (auditoría 8, fase 4,
 * bloque 4.8; decisión D-36, opción c: «todo directo, incluido el celular»).
 *
 * Directo y sin aprobación: lo que guarda queda en su ficha en el acto. Lo que
 * lo rodea es para que ese atajo no sirva para quedarse con la cuenta de nadie:
 *
 *  1. SOLO CONTACTO. Celular, correo y contacto de emergencia. Nombre, fecha
 *     de nacimiento, CURP, plan y coach no tienen ruta aquí.
 *  2. CONFIRMA QUE ES ÉL. El portal no tiene contraseña ni manda códigos
 *     (D-34: ninguna conexión con costo). Para cambiar celular o correo
 *     escribe completo el celular que tiene registrado (sin celular, su
 *     correo); la pantalla solo le enseña la terminación. Cinco fallos en una
 *     hora y lo que sigue es recepción.
 *  3. TOPE POR PERIODO (`CONTACT_CHANGE_LIMITS`, en una ventana de 30 días).
 *  4. EL CELULAR NO UNE A NADIE (D-09). Si el nuevo ya es de otro socio vivo:
 *     con su mismo nombre es la misma persona y no se guarda desde aquí; con
 *     otro nombre se comparte diciendo quién responde por el número, y NUNCA
 *     se le dice de quién es. Desde el portal no se escribe nada en la ficha
 *     del otro socio (el mostrador sí propaga al responsable; aquí no: sería
 *     un socio escribiendo en la ficha de otro).
 *  5. QUEDA DICHO. Una fila por dato en `member_contact_changes` (antes y
 *     después: es lo que ve el mostrador), y un asiento «el socio actualizó»
 *     en la bitácora SIN los valores (SEC-08): qué datos y la terminación del
 *     celular. El aviso al propio socio lo emite la ruta del portal.
 *
 * Cambiar el celular no mueve nada más: su portal sigue abierto en los mismos
 * teléfonos (se activa con un código por socio que da recepción, no con el
 * celular), su pase de prueba sigue siendo uno por ficha, y los mensajes
 * pendientes de la bandeja de salida salen al número nuevo porque el número se
 * lee al mandarlos.
 */

const responsableDesdeElPortal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal(PORTAL_RESPONSIBLE_KINDS[0]) }),
  z.object({ kind: z.literal(PORTAL_RESPONSIBLE_KINDS[1]) }),
  z.object({ kind: z.literal(PORTAL_RESPONSIBLE_KINDS[2]), name: nombrePersona(120) }),
]);

/** El cuerpo de `PATCH /portal/me/contact`. Lo que no viene, no se toca. `strict`: nombre, CURP o nacimiento se rechazan, no se ignoran. */
export const contactoPropioSchema = z.object({
  /** El celular se reemplaza, no se quita. */
  phoneE164: telefonoMx().min(1, 'Escribe los 10 dígitos de tu celular').optional(),
  email: z.string().trim().max(254).nullable().optional(),
  emergencyContactName: nombrePersona(120).or(z.literal('')).nullable().optional(),
  emergencyContactPhone: telefonoMx().nullable().optional(),
  /** Solo si el celular nuevo ya es de otro socio: quién responde por el número (D-09). */
  responsible: responsableDesdeElPortal.optional(),
  /** Su celular actual completo (o su correo, si no tiene celular): solo se pide al cambiar celular o correo. */
  confirm: z.string().trim().max(254).optional(),
}).strict();
export type ContactoPropioInput = z.infer<typeof contactoPropioSchema>;

const DIA_MS = 86_400_000;

/**
 * Fallos de confirmación por socio, en ventana fija. En memoria, como el tope
 * de inicios de sesión: reiniciar la API los olvida. Confirmar bien los borra.
 */
const VENTANA_DE_FALLOS_MS = CONTACT_CONFIRM_WINDOW_MINUTES * 60_000;
const fallos = new Map<string, { usados: number; desde: number }>();
const fallosVigentes = (llave: string) => {
  const f = fallos.get(llave);
  if (f && f.desde + VENTANA_DE_FALLOS_MS <= Date.now()) { fallos.delete(llave); return null; }
  return f ?? null;
};
/** Segundos que faltan para poder intentar otra vez; 0 si puede. */
function esperaPorFallos(llave: string): number {
  const f = fallosVigentes(llave);
  return f && f.usados >= CONTACT_CONFIRM_MAX_FAILURES ? Math.max(1, Math.ceil((f.desde + VENTANA_DE_FALLOS_MS - Date.now()) / 1000)) : 0;
}
function anotarFallo(llave: string): void {
  const f = fallosVigentes(llave);
  if (f) f.usados += 1; else fallos.set(llave, { usados: 1, desde: Date.now() });
}
/** Solo para las pruebas. */
export function olvidarFallosDeConfirmacion(): void {
  fallos.clear();
}

function errorDeCampo(campo: string, mensaje: string): ZodError {
  return new ZodError([{ code: 'custom', path: [campo], message: mensaje, input: undefined }]);
}

type Uso = Record<ContactLimitKey, Date[]>;

/** Cuándo usó cada tope dentro de la ventana: un toque cuenta una vez aunque cambie nombre y teléfono de emergencia. */
async function usoDe(organizationId: string, memberId: string, ahora: Date): Promise<Uso> {
  const filas = await new ContactChangeRepository(organizationId).desde(memberId, new Date(ahora.getTime() - CONTACT_CHANGE_WINDOW_DAYS * DIA_MS));
  const uso: Uso = { PHONE: [], EMAIL: [], EMERGENCY: [] };
  const vistos = new Set<string>();
  for (const f of filas) {
    const llave = limiteDe(f.field);
    if (vistos.has(`${llave}:${f.batchId}`)) continue;
    vistos.add(`${llave}:${f.batchId}`);
    uso[llave].push(f.createdAt);
  }
  return uso;
}

function limite(llave: ContactLimitKey, usados: readonly Date[]): ContactLimit {
  const max = CONTACT_CHANGE_LIMITS[llave];
  const left = Math.max(0, max - usados.length);
  // El siguiente cambio se libera cuando el más viejo de los que cuentan sale de la ventana.
  const libera = left === 0 ? usados[usados.length - max] : undefined;
  return { max, left, nextAt: libera ? new Date(libera.getTime() + CONTACT_CHANGE_WINDOW_DAYS * DIA_MS).toISOString() : null };
}

async function vistaDe(organizationId: string, m: MemberRecord, ahora: Date): Promise<PortalContact> {
  const responsables = new ResponsibleRepository(organizationId);
  const [uso, ultimo, mio, otros] = await Promise.all([
    usoDe(organizationId, m.id, ahora),
    new ContactChangeRepository(organizationId).ultimoDeIdentidad(m.id),
    responsables.de(m.id),
    m.phoneE164 ? responsables.titulares(m.phoneE164, m.id) : [],
  ]);
  return {
    hasPhone: !!m.phoneE164, phoneMasked: mascaraDeCelular(m.phoneE164),
    hasEmail: !!m.email, emailMasked: mascaraDeCorreo(m.email),
    emergencyContactName: m.emergencyContactName, emergencyContactPhone: m.emergencyContactPhone,
    // Que lo comparte, sí; con quién, nunca.
    sharedPhone: otros.length > 0,
    responsibleKind: otros.length > 0 ? (mio?.responsibleKind ?? null) : null,
    confirmWith: confirmaCon(m),
    windowDays: CONTACT_CHANGE_WINDOW_DAYS,
    limits: { phone: limite('PHONE', uso.PHONE), email: limite('EMAIL', uso.EMAIL), emergency: limite('EMERGENCY', uso.EMERGENCY) },
    lastIdentityChangeAt: ultimo ? ultimo.toISOString() : null,
  };
}

/** `GET /portal/me/contact`: sus datos de contacto como el portal los enseña. */
export async function contactoPropio(organizationId: string, memberId: string): Promise<PortalContact> {
  const m = await new MemberRepository(organizationId).findById(memberId);
  if (!m) throw notFound('Socio no encontrado');
  return vistaDe(organizationId, m, new Date());
}

/** Lo que se le dice al socio de cada tope cuando ya no le quedan cambios. */
const QUE: Record<ContactLimitKey, string> = { PHONE: 'tu celular', EMAIL: 'tu correo', EMERGENCY: 'tu contacto de emergencia' };

export type CambioHecho = { field: ContactField; oldValue: string | null; newValue: string | null };
export type ContactoCambiado = {
  contact: PortalContact;
  /** Vacío si lo que mandó ya era lo que tenía: no se asienta ni se avisa nada. */
  changes: CambioHecho[];
  batchId: string | null;
  at: Date;
  homeBranchId: string | null;
  sharedPhone: boolean;
};

/**
 * `PATCH /portal/me/contact`. `ctx` es el del socio (actor `MEMBER`): así el
 * asiento dice «El socio actualizó…».
 */
export async function cambiarContactoPropio(ctx: RequestContext, memberId: string, input: ContactoPropioInput, sessionId: string | null): Promise<ContactoCambiado> {
  const orgId = ctx.tenant.organizationId;
  const members = new MemberRepository(orgId);
  const antes = await members.findById(memberId);
  if (!antes) throw notFound('Socio no encontrado');
  const ahora = new Date();

  // ── Qué cambia de verdad ───────────────────────────────────────────────────
  const cambios: CambioHecho[] = [];
  const patch: { phoneE164?: string; email?: string | null; emergencyContactName?: string | null; emergencyContactPhone?: string | null } = {};

  if (input.phoneE164 !== undefined) {
    const nuevo = normalizePhoneMx(input.phoneE164);
    if (!nuevo) throw errorDeCampo('phoneE164', 'Teléfono no válido: escribe los 10 dígitos');
    if (nuevo !== antes.phoneE164) { patch.phoneE164 = nuevo; cambios.push({ field: 'PHONE', oldValue: antes.phoneE164, newValue: nuevo }); }
  }
  if (input.email !== undefined) {
    const escrito = input.email?.trim() ?? '';
    const nuevo = escrito ? normalizeEmail(escrito) : null;
    if (escrito && !nuevo) throw errorDeCampo('email', 'Ese correo no parece válido. Revísalo.');
    if (nuevo !== (antes.email || null)) { patch.email = nuevo; cambios.push({ field: 'EMAIL', oldValue: antes.email, newValue: nuevo }); }
  }
  if (input.emergencyContactName !== undefined) {
    const nuevo = input.emergencyContactName?.trim() || null;
    // Vacío y «sin dato» son lo mismo: no es un cambio.
    const tenia = antes.emergencyContactName?.trim() || null;
    if (nuevo !== tenia) { patch.emergencyContactName = nuevo; cambios.push({ field: 'EMERGENCY_NAME', oldValue: tenia, newValue: nuevo }); }
  }
  if (input.emergencyContactPhone !== undefined) {
    const nuevo = normalizePhoneMx(input.emergencyContactPhone);
    const tenia = antes.emergencyContactPhone || null;
    if (nuevo !== tenia) { patch.emergencyContactPhone = nuevo; cambios.push({ field: 'EMERGENCY_PHONE', oldValue: tenia, newValue: nuevo }); }
  }
  if (cambios.length === 0) {
    return { contact: await vistaDe(orgId, antes, ahora), changes: [], batchId: null, at: ahora, homeBranchId: antes.homeBranchId, sharedPhone: false };
  }

  const celularNuevo = patch.phoneE164 ?? null;
  const telefonoFinal = celularNuevo ?? antes.phoneE164;
  const correoFinal = patch.email !== undefined ? patch.email : antes.email;
  // El gimnasio no se queda sin cómo localizarlo por un toque en el teléfono.
  if (!telefonoFinal && !correoFinal && (antes.phoneE164 || antes.email)) {
    throw conflict('Necesitamos tu celular o tu correo para localizarte. Para quitar los dos, pasa a recepción.', 'CONTACT_CHANGE_NOT_ALLOWED');
  }

  // ── Tope por periodo ───────────────────────────────────────────────────────
  const uso = await usoDe(orgId, memberId, ahora);
  for (const llave of new Set(cambios.map((c) => limiteDe(c.field)))) {
    const l = limite(llave, uso[llave]);
    if (l.left === 0) {
      throw conflict(
        `Ya cambiaste ${QUE[llave]} ${l.max} veces en los últimos ${CONTACT_CHANGE_WINDOW_DAYS} días. Para cambiarlo otra vez antes, pasa a recepción.`,
        'CONTACT_CHANGE_LIMIT',
      );
    }
  }

  // ── Que sea él ─────────────────────────────────────────────────────────────
  const deIdentidad = cambios.some((c) => c.field === 'PHONE' || c.field === 'EMAIL');
  const con = confirmaCon(antes);
  if (deIdentidad && con) {
    const llave = `${orgId}:${memberId}`;
    const espera = esperaPorFallos(llave);
    if (espera > 0) {
      throw new DemasiadosIntentos(espera, `Fallaste varias veces al confirmar. Espera ${tiempoParaReintentar(espera)} o pasa a recepción y lo cambian ahí.`);
    }
    if (!confirmacionCorrecta(antes, input.confirm)) {
      anotarFallo(llave);
      throw validation(
        con === 'PHONE'
          ? 'Ese no es el celular que tenemos registrado. Escríbelo completo, con sus 10 dígitos. Si ya no lo recuerdas, pasa a recepción.'
          : 'Ese no es el correo que tenemos registrado. Escríbelo completo. Si ya no lo recuerdas, pasa a recepción.',
        undefined, 'CONTACT_CONFIRMATION_FAILED',
      );
    }
  }

  // ── El celular nuevo y los demás socios (D-09) ─────────────────────────────
  const responsables = new ResponsibleRepository(orgId);
  let columnas: ResponsibleColumns | undefined;
  let comparte = false;
  if (celularNuevo) {
    const [otros, mio] = await Promise.all([responsables.titulares(celularNuevo, memberId), responsables.de(memberId)]);
    comparte = otros.length > 0;
    const conTutor = !!mio?.guardianSignedAt;
    if (comparte) {
      // Mismo celular y mismo nombre = la misma persona (`core/identity.ts`): dos fichas suyas no se arreglan desde un teléfono.
      const iguales = rankMatches(
        { id: memberId, firstName: antes.firstName, lastName: antes.lastName, phoneE164: celularNuevo },
        otros.map((t) => ({ id: t.id, firstName: t.firstName, lastName: t.lastName, phoneE164: celularNuevo })),
      ).filter((x) => x.score >= AUTO_MERGE_THRESHOLD);
      if (iguales.length > 0) {
        throw conflict('Ese celular ya está en otra ficha de este gimnasio que parece ser tuya. Pasa a recepción para que la revisen: desde aquí no se puede guardar.', 'CONTACT_CHANGE_NOT_ALLOWED');
      }
      if (conTutor) {
        // Un menor ya trae a su tutor como responsable (D-10): vale también para el número nuevo.
        columnas = undefined;
      } else if (!input.responsible) {
        // Sin nombres: a un socio no se le dice de quién es un número. Y preguntar número por número «¿este es de un
        // socio?» gasta los mismos intentos que fallar la confirmación: no es una forma de recorrer el padrón.
        anotarFallo(`${orgId}:${memberId}`);
        throw conflict('Ese celular ya lo tiene registrado otro socio de este gimnasio. Si lo comparten, dinos quién responde por ese número.', 'PHONE_IN_USE');
      } else if (input.responsible.kind === 'SELF') {
        columnas = { responsibleKind: 'SELF', responsibleMemberId: null, responsibleName: null, responsiblePhoneE164: null };
      } else if (input.responsible.kind === 'ADULT') {
        // El número ES el de ese adulto: no se pide otro teléfono.
        columnas = { responsibleKind: 'ADULT', responsibleMemberId: null, responsibleName: input.responsible.name.trim(), responsiblePhoneE164: null };
      } else {
        columnas = { responsibleKind: 'MEMBER', responsibleMemberId: quienResponde(otros), responsibleName: null, responsiblePhoneE164: null };
      }
    } else if (!conTutor && mio?.responsibleKind) {
      // El número nuevo es solo suyo: lo anotado hablaba del número anterior.
      columnas = { responsibleKind: null, responsibleMemberId: null, responsibleName: null, responsiblePhoneE164: null };
    }
  }

  // ── Se guarda todo junto, con su asiento ───────────────────────────────────
  const hecho = await enUnaTransaccion(async () => {
    const despues = await members.update(memberId, patch);
    if (!despues) throw notFound('Socio no encontrado');
    let sinResponsable = 0;
    if (celularNuevo) {
      if (columnas) await responsables.escribir(memberId, columnas);
      // Quien lo tenía anotado como responsable del número ANTERIOR se queda sin responsable: ya no es su número.
      sinResponsable = await responsables.soltarA(memberId);
    }
    const batchId = await new ContactChangeRepository(orgId).registrar({
      memberId, sessionId, at: ahora, sharedPhone: comparte, // Con tutor (D-10) no se pregunta: el responsable sigue siendo ese adulto.
      responsibleKind: comparte ? (columnas?.responsibleKind ?? 'ADULT') : null, cambios,
    });
    const delCelular = cambios.find((c) => c.field === 'PHONE');
    await new AuditService().record(ctx, {
      action: 'member.contact.self_update', resourceType: 'Member', resourceId: memberId, branchId: antes.homeBranchId,
      // QUÉ cambió y la terminación del celular; nunca el número ni el correo (SEC-08: la bitácora no se borra).
      beforeState: delCelular ? { phoneLast4: ultimos4(delCelular.oldValue) } : {},
      afterState: {
        via: 'portal', changedFields: cambios.map((c) => c.field), changeBatchId: batchId,
        ...(delCelular ? { phoneLast4: ultimos4(delCelular.newValue), sharedPhone: comparte } : {}),
        ...(comparte && columnas ? { responsable: columnas.responsibleKind as ResponsibleKind } : {}),
        ...(sinResponsable > 0 ? { dejaronDeTenerloDeResponsable: sinResponsable } : {}),
      },
    });
    return { despues, batchId };
  });

  // Confirmó bien: sus fallos anteriores ya no cuentan.
  if (deIdentidad && con) fallos.delete(`${orgId}:${memberId}`);

  return { contact: await vistaDe(orgId, hecho.despues, ahora), changes: cambios, batchId: hecho.batchId, at: ahora, homeBranchId: antes.homeBranchId, sharedPhone: comparte };
}

/**
 * «Es de un familiar que ya es socio aquí: esa persona responde», sin decir
 * quién. De los socios vivos con ese celular: quien ya responde por él
 * (`SELF`), o a quien los demás tienen anotado, o el más antiguo.
 */
function quienResponde(otros: ReadonlyArray<{ id: string; responsibleKind: string | null; responsibleMemberId: string | null }>): string {
  const propio = otros.find((t) => t.responsibleKind === 'SELF');
  if (propio) return propio.id;
  const anotado = otros.find((t) => t.responsibleKind === 'MEMBER' && otros.some((x) => x.id === t.responsibleMemberId));
  return anotado?.responsibleMemberId ?? otros[0]!.id;
}
