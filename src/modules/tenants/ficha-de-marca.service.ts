import { DomainError, conflict, normalizePhoneMx, notFound, validation } from '@gymflow/core';
import { GYM_BRANCH_FIELDS, type GymChangeRequest, type GymDataField, type PlatformBrand, type PlatformChangeRequest } from '@gymflow/core/contracts';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { RequestContext } from '../../platform/context.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { systemContext } from '../../platform/jobs/types.js';
import { GymBrandRepository, type CambioDeMarca, type CambioDeSede, type DatosDeMarca, type SedeDeMarca, type Solicitud } from './ficha-de-marca.repository.js';

/** El logo: PNG, JPEG o WebP de hasta 200 KB (una imagen de recibo, no una foto). */
export const LOGO_MAX_BYTES = 200 * 1024;
const FIRMAS: ReadonlyArray<{ mime: string; es: (b: Buffer) => boolean }> = [
  { mime: 'image/png', es: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', es: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', es: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/**
 * El logo llega como `data:` URL. Se acepta solo si lo que trae dentro ES la
 * imagen que dice ser (se miran sus primeros bytes): un SVG o un HTML con
 * nombre de imagen no pasan.
 */
export function logoValido(raw: string): string {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw.trim());
  if (!m) throw validation('El logo debe ser una imagen PNG, JPG o WebP');
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) throw validation('El logo pesa demasiado: usa una imagen de hasta 200 KB');
  if (!FIRMAS.some((f) => f.mime === m[1] && f.es(bytes))) throw validation('El archivo no es la imagen que dice ser: usa un PNG, JPG o WebP');
  return `data:${m[1]};base64,${bytes.toString('base64')}`;
}

/** RFC de persona moral (12) o física (13), en mayúsculas y sin separadores. */
export function rfcValido(raw: string): string {
  const rfc = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc)) throw validation('RFC no válido: son 12 caracteres para una empresa o 13 para una persona, sin espacios');
  return rfc;
}

const SE_PUEDE_QUITAR: ReadonlySet<GymDataField> = new Set(['RFC', 'LOGO', 'PHONE', 'WHATSAPP', 'RECEIPT_LEGEND', 'BRANCH_PHONE', 'BRANCH_HOURS']);

/**
 * El valor de un dato, limpio y validado, como se guarda. `null` = quitar el
 * dato (los nombres no se pueden quitar). Es la MISMA regla al pedir el cambio
 * desde el panel y al aplicarlo o editarlo en la consola.
 */
export function valorLimpio(field: GymDataField, raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (v === '') {
    if (SE_PUEDE_QUITAR.has(field)) return null;
    throw validation(field === 'OTHER' ? 'Escribe qué quieres que cambie' : 'Escribe el valor nuevo');
  }
  switch (field) {
    case 'TRADE_NAME':
      if (v.length < 2 || v.length > 80) throw validation('El nombre comercial lleva de 2 a 80 caracteres');
      return v;
    case 'LEGAL_NAME':
      if (v.length < 3 || v.length > 160) throw validation('La razón social lleva de 3 a 160 caracteres');
      return v;
    case 'RFC':
      return rfcValido(v);
    case 'PHONE': case 'WHATSAPP': case 'BRANCH_PHONE': {
      const tel = normalizePhoneMx(v);
      if (!tel) throw validation('Teléfono no válido: escribe los 10 dígitos');
      return tel;
    }
    case 'RECEIPT_LEGEND':
      if (v.length > 300) throw validation('La leyenda del recibo lleva hasta 300 caracteres');
      return v;
    case 'BRANCH_HOURS':
      if (v.length > 300) throw validation('El horario lleva hasta 300 caracteres');
      return v;
    case 'LOGO':
      return logoValido(v);
    case 'OTHER':
      if (v.length < 3 || v.length > 500) throw validation('Describe el cambio en 3 a 500 caracteres');
      return v;
  }
}

const esDeSede = (field: string): boolean => (GYM_BRANCH_FIELDS as readonly string[]).includes(field);
const COLUMNA: Partial<Record<GymDataField, keyof CambioDeMarca>> = {
  TRADE_NAME: 'tradeName', LEGAL_NAME: 'legalName', RFC: 'rfc', LOGO: 'logo', PHONE: 'phone', WHATSAPP: 'whatsapp', RECEIPT_LEGEND: 'receiptLegend',
};
const COLUMNA_DE_SEDE: Partial<Record<GymDataField, keyof CambioDeSede>> = { BRANCH_PHONE: 'phone', BRANCH_HOURS: 'openingHours' };
/** En la bitácora el logo no se copia entero: se dice que hay (o no hay) imagen. */
const paraBitacora = (field: string, v: string | null): string | null => (field === 'LOGO' && v ? '(imagen)' : v);

/** El valor que el dato tiene hoy. */
function valorActual(field: string, marca: DatosDeMarca, sede: SedeDeMarca | null): string | null {
  const col = COLUMNA[field as GymDataField];
  if (col) return marca[col];
  const deSede = COLUMNA_DE_SEDE[field as GymDataField];
  return deSede && sede ? sede[deSede] : null;
}

const cerrada = () => new DomainError('CONFLICT', 'Esa solicitud ya se aplicó o ya se rechazó', undefined, 'CHANGE_REQUEST_CLOSED');

/**
 * DATOS Y MARCA DEL GIMNASIO (D-27, opción d · bloque 4.6).
 *
 * Nada se cambia desde el panel: la plataforma edita la ficha de marca con
 * motivo, y el gimnasio PIDE el cambio con una solicitud (qué dato, valor
 * nuevo, motivo) que la plataforma aplica o rechaza con respuesta. Todo queda
 * en la bitácora de la marca como `platform.…` (y, por su espejo, en la cadena
 * de la plataforma).
 */
export class GymBrandService {
  private readonly repo = new GymBrandRepository();
  private readonly audit = new AuditService();

  // ── Lo que ve y hace el gimnasio ───────────────────────────────────────────

  async deGimnasio(organizationId: string, userId: string | null): Promise<{ requests: GymChangeRequest[]; unseen: number }> {
    const [filas, unseen] = await Promise.all([this.repo.deMarca(organizationId), userId ? this.repo.sinVer(organizationId, userId) : 0]);
    return { requests: filas.map((s) => this.paraGimnasio(s, userId)), unseen };
  }

  /** «Pedir un cambio a GymFlow». El valor se valida igual que al aplicarlo: lo que no se podría guardar no se pide. */
  async pedir(ctx: RequestContext, input: { field: GymDataField; branchId: string | null; value: string | null; reason: string }): Promise<GymChangeRequest> {
    const { organizationId, actorUserId } = ctx.tenant;
    if (!actorUserId) throw validation('La solicitud la manda una persona con sesión');
    const marca = await this.repo.marca(organizationId);
    if (!marca) throw notFound('Organización no encontrada');
    const deSede = esDeSede(input.field);
    if (deSede && !input.branchId) throw validation('Elige de qué sucursal es el dato');
    // Una sucursal de otro gimnasio no existe para este: 404.
    const sede = deSede ? await this.repo.sede(organizationId, input.branchId!) : null;
    if (deSede && !sede) throw notFound('Sucursal no encontrada');
    const valor = valorLimpio(input.field, input.value);
    if (input.field !== 'OTHER' && valor === valorActual(input.field, marca, sede)) {
      throw validation(valor === null ? 'Ese dato ya está vacío: no hay nada que quitar' : 'Ese ya es el valor registrado: no hay nada que cambiar');
    }
    const branchId = deSede ? sede!.id : null;
    if (input.field !== 'OTHER' && (await this.repo.hayPendiente(organizationId, input.field, branchId))) {
      throw conflict('Ya hay una solicitud pendiente para ese dato: espera la respuesta de GymFlow antes de mandar otra', 'CHANGE_REQUEST_PENDING');
    }
    const esLogo = input.field === 'LOGO';
    const creada = await this.repo.crear({
      organizationId, branchId, field: input.field, proposedValue: esLogo ? null : valor, proposedLogo: esLogo ? valor : null,
      reason: input.reason, requestedByUserId: actorUserId,
    });
    await this.audit.record(ctx, {
      action: 'settings.change_request.create', resourceType: 'GymChangeRequest', resourceId: creada.id, branchId, reason: input.reason,
      afterState: { field: input.field, branch: sede?.name ?? null, proposedValue: paraBitacora(input.field, valor) },
    });
    return this.paraGimnasio(creada, actorUserId);
  }

  /** Quien la pidió ya tiene el resultado a la vista. */
  vistas(organizationId: string, userId: string): Promise<number> {
    return this.repo.marcarVistas(organizationId, userId);
  }

  // ── Lo que ve y hace la plataforma ─────────────────────────────────────────

  async ficha(organizationId: string): Promise<PlatformBrand> {
    const [marca, sedes, solicitudes] = await Promise.all([this.repo.marca(organizationId), this.repo.sedes(organizationId), this.repo.deMarca(organizationId)]);
    if (!marca) throw notFound('Marca no encontrada');
    const porId = new Map(sedes.map((s) => [s.id, s]));
    const requests = solicitudes.map((s) => this.paraPlataforma(s, marca, s.branchId ? porId.get(s.branchId) ?? null : null));
    return {
      organizationId: marca.id, tradeName: marca.tradeName, legalName: marca.legalName,
      rfc: marca.rfc, phone: marca.phone, whatsapp: marca.whatsapp, receiptLegend: marca.receiptLegend, logo: marca.logo, branches: sedes,
      // Primero lo que espera respuesta, de lo más viejo a lo más nuevo; después lo resuelto, de lo más nuevo a lo más viejo.
      requests: [...requests.filter((r) => r.status === 'PENDING').reverse(), ...requests.filter((r) => r.status !== 'PENDING')],
    };
  }

  async pendientes(): Promise<{ pending: number; requests: PlatformChangeRequest[] }> {
    const [filas, pending] = await Promise.all([this.repo.pendientes(), this.repo.contarPendientes()]);
    const [marcas, sedes] = await Promise.all([
      this.repo.marcas([...new Set(filas.map((s) => s.organizationId))]),
      this.repo.sedesDe([...new Set(filas.flatMap((s) => (s.branchId ? [s.branchId] : [])))]),
    ]);
    const marcaDe = new Map(marcas.map((m) => [m.id, m]));
    const sedeDe = new Map(sedes.map((s) => [s.id, s]));
    return { pending, requests: filas.flatMap((s) => { const m = marcaDe.get(s.organizationId); return m ? [this.paraPlataforma(s, m, s.branchId ? sedeDe.get(s.branchId) ?? null : null)] : []; }) };
  }

  /** La plataforma edita la ficha de marca directamente: solo lo que vino y solo lo que de verdad cambia. Con motivo. */
  async editarMarca(organizationId: string, datos: Partial<Record<'rfc' | 'phone' | 'whatsapp' | 'receiptLegend' | 'logo', string | null | undefined>>, byUserId: string, reason: string): Promise<void> {
    const marca = await this.repo.marca(organizationId);
    if (!marca) throw notFound('Marca no encontrada');
    const campo: Record<keyof typeof datos, GymDataField> = { rfc: 'RFC', phone: 'PHONE', whatsapp: 'WHATSAPP', receiptLegend: 'RECEIPT_LEGEND', logo: 'LOGO' };
    const cambio: CambioDeMarca = {};
    const antes: Record<string, string | null> = {};
    const despues: Record<string, string | null> = {};
    for (const [k, raw] of Object.entries(datos) as Array<[keyof typeof datos, string | null | undefined]>) {
      if (raw === undefined) continue;
      const v = valorLimpio(campo[k], raw);
      if (v === marca[k]) continue;
      cambio[k] = v;
      antes[k] = paraBitacora(campo[k], marca[k]);
      despues[k] = paraBitacora(campo[k], v);
    }
    if (Object.keys(cambio).length === 0) throw validation('No hay nada que cambiar');
    await this.repo.actualizarMarca(organizationId, cambio);
    await this.audit.record(systemContext(organizationId), {
      action: 'platform.brand.update', resourceType: 'Organization', resourceId: organizationId, reason,
      beforeState: antes, afterState: { ...despues, byPlatformUserId: byUserId },
    });
  }

  /** Teléfono y horario de una sucursal, desde la consola. Con motivo. */
  async editarSede(organizationId: string, branchId: string, datos: { phone?: string | null | undefined; openingHours?: string | null | undefined }, byUserId: string, reason: string): Promise<void> {
    const sede = await this.repo.sede(organizationId, branchId);
    if (!sede) throw notFound('Sucursal no encontrada');
    const cambio: CambioDeSede = {};
    if (datos.phone !== undefined) { const v = valorLimpio('BRANCH_PHONE', datos.phone); if (v !== sede.phone) cambio.phone = v; }
    if (datos.openingHours !== undefined) { const v = valorLimpio('BRANCH_HOURS', datos.openingHours); if (v !== sede.openingHours) cambio.openingHours = v; }
    if (Object.keys(cambio).length === 0) throw validation('No hay nada que cambiar');
    await this.repo.actualizarSede(organizationId, branchId, cambio);
    await this.audit.record(systemContext(organizationId), {
      action: 'platform.brand.update', resourceType: 'Branch', resourceId: branchId, branchId, reason,
      beforeState: Object.fromEntries(Object.keys(cambio).map((k) => [k, sede[k as keyof CambioDeSede]])),
      afterState: { branch: sede.name, ...cambio, byPlatformUserId: byUserId },
    });
  }

  /**
   * APLICAR una solicitud: el dato cambia y la solicitud queda resuelta, en
   * una sola transacción. La plataforma puede ajustar el valor pedido
   * (`value`); «Otro dato» no escribe nada solo: se resuelve diciendo qué se hizo.
   */
  async aplicar(id: string, input: { value?: string | null | undefined; response?: string | null | undefined }, byUserId: string): Promise<PlatformChangeRequest> {
    const s = await this.repo.solicitud(id);
    if (!s) throw notFound('Solicitud no encontrada');
    if (s.status !== 'PENDING') throw cerrada();
    const field = s.field as GymDataField;
    const respuesta = input.response?.trim() || null;
    const marca = await this.repo.marca(s.organizationId);
    if (!marca) throw notFound('Marca no encontrada');
    const sede = s.branchId ? await this.repo.sede(s.organizationId, s.branchId) : null;
    if (s.branchId && !sede) throw conflict('La sucursal de esa solicitud ya no existe: recházala con esa respuesta');
    if (field === 'OTHER' && !respuesta) throw validation('Di qué se cambió: «Otro dato» no se aplica solo y quien lo pidió lee tu respuesta');
    const valor = field === 'OTHER' ? null : valorLimpio(field, input.value !== undefined ? input.value : field === 'LOGO' ? s.proposedLogo : s.proposedValue);
    const antes = valorActual(field, marca, sede);

    await enUnaTransaccion(async () => {
      const ok = await this.repo.resolver(id, { status: 'APPLIED', response: respuesta, appliedValue: field === 'LOGO' || field === 'OTHER' ? null : valor, resolvedByUserId: byUserId });
      if (!ok) throw cerrada();
      const col = COLUMNA[field];
      const colDeSede = COLUMNA_DE_SEDE[field];
      if (col) await this.repo.actualizarMarca(s.organizationId, { [col]: valor });
      else if (colDeSede && sede) await this.repo.actualizarSede(s.organizationId, sede.id, { [colDeSede]: valor });
    });
    await this.audit.record(systemContext(s.organizationId), {
      action: 'platform.change_request.apply', resourceType: 'GymChangeRequest', resourceId: id, branchId: s.branchId,
      reason: `Lo pidió ${s.requestedBy.fullName}: ${s.reason}`.slice(0, 300),
      beforeState: field === 'OTHER' ? null : { [field]: paraBitacora(field, antes) },
      afterState: { field, branch: sede?.name ?? null, value: paraBitacora(field, valor), response: respuesta, requestedByUserId: s.requestedByUserId, byPlatformUserId: byUserId },
    });
    return this.resuelta(id);
  }

  /** RECHAZAR: no cambia ningún dato; la respuesta es obligatoria y la lee quien la pidió. */
  async rechazar(id: string, response: string, byUserId: string): Promise<PlatformChangeRequest> {
    const s = await this.repo.solicitud(id);
    if (!s) throw notFound('Solicitud no encontrada');
    if (s.status !== 'PENDING') throw cerrada();
    const ok = await this.repo.resolver(id, { status: 'REJECTED', response, appliedValue: null, resolvedByUserId: byUserId });
    if (!ok) throw cerrada();
    await this.audit.record(systemContext(s.organizationId), {
      action: 'platform.change_request.reject', resourceType: 'GymChangeRequest', resourceId: id, branchId: s.branchId, reason: response.slice(0, 300),
      afterState: { field: s.field, branch: s.branch?.name ?? null, proposedValue: paraBitacora(s.field, s.field === 'LOGO' ? s.proposedLogo : s.proposedValue), requestedByUserId: s.requestedByUserId, byPlatformUserId: byUserId },
    });
    return this.resuelta(id);
  }

  private async resuelta(id: string): Promise<PlatformChangeRequest> {
    const s = (await this.repo.solicitud(id))!;
    const [marca, sede] = await Promise.all([this.repo.marca(s.organizationId), s.branchId ? this.repo.sede(s.organizationId, s.branchId) : null]);
    return this.paraPlataforma(s, marca!, sede);
  }

  private base(s: Solicitud) {
    return {
      id: s.id, field: s.field as GymDataField, branchId: s.branchId, branchName: s.branch?.name ?? null,
      proposedValue: s.proposedValue, proposedLogo: s.proposedLogo, reason: s.reason,
      requestedBy: { id: s.requestedBy.id, fullName: s.requestedBy.fullName }, requestedAt: s.requestedAt.toISOString(),
      status: s.status as GymChangeRequest['status'], response: s.response, appliedValue: s.appliedValue, resolvedAt: s.resolvedAt?.toISOString() ?? null,
    };
  }

  private paraGimnasio(s: Solicitud, userId: string | null): GymChangeRequest {
    return { ...this.base(s), mine: s.requestedByUserId === userId, seen: s.seenAt !== null };
  }

  private paraPlataforma(s: Solicitud, marca: DatosDeMarca, sede: SedeDeMarca | null): PlatformChangeRequest {
    return {
      ...this.base(s), organizationId: s.organizationId, tradeName: s.organization.tradeName,
      // El logo de hoy va en la ficha; aquí no se repite la imagen.
      currentValue: s.field === 'LOGO' || s.field === 'OTHER' ? null : valorActual(s.field, marca, sede),
      seenAt: s.seenAt?.toISOString() ?? null,
    };
  }
}
