import { createHash } from 'node:crypto';
import { conflict, notFound, puntosSinRevisar, uuidv7, validation } from '@gymflow/core';
import type { NoticeSignatureRequests } from '@gymflow/core/contracts';
import type { RequestContext } from '../../platform/context.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { ConsentDocumentRepository, type ConsentDocumentRecord } from './consent-document.repository.js';
import { publicarTexto, revisionDeTexto } from './consent-document.service.js';

/**
 * LA FIRMA DE LA DUEÑA EN EL AVISO DE PRIVACIDAD (fase 3, bloque 3.7 · D-25).
 *
 * El aviso de privacidad es el único texto que compromete a la dueña ante la
 * ley: no se publica sin su firma. La gerencia lo redacta y lo revisa punto
 * por punto, como siempre; al «publicar», el aviso NO queda publicado: queda
 * una solicitud con el motivo, los puntos revisados y la huella del texto. La
 * dueña lo lee completo en Textos de consentimiento y lo firma con su
 * contraseña (entonces se publica, con las mismas validaciones de siempre) o
 * dice que no, con su motivo. Si el borrador cambia después de pedirla, la
 * firma ya no vale para ese texto: hay que volver a pedirla.
 *
 * Los demás textos (reglamento, biométrico…) los sigue publicando la gerencia.
 */

export type SolicitudDeFirma = {
  id: string; documentId: string; status: string; reason: string; checklist: string[]; bodyHash: string;
  requestedByUserId: string; requestedAt: Date; resolvedByUserId: string | null; resolvedAt: Date | null; note: string | null;
};

const SELECT = {
  id: true, documentId: true, status: true, reason: true, checklist: true, bodyHash: true,
  requestedByUserId: true, requestedAt: true, resolvedByUserId: true, resolvedAt: true, note: true,
} as const;

/** La huella de lo que la gerencia revisó: si cambia el título, la versión o el texto, es otro texto. */
export const huellaDelBorrador = (d: Pick<ConsentDocumentRecord, 'version' | 'title' | 'bodyText'>): string =>
  createHash('sha256').update(`${d.version}\n${d.title}\n${d.bodyText}`, 'utf8').digest('hex');

class SolicitudDeFirmaRepository extends TenantRepository {
  async pendiente(documentId: string): Promise<SolicitudDeFirma | null> {
    return this.db.consentSignatureRequest.findFirst({ where: this.scope({ documentId, status: 'PENDING' }), select: SELECT }) as Promise<SolicitudDeFirma | null>;
  }

  async crear(input: { documentId: string; reason: string; checklist: readonly string[]; bodyHash: string; requestedByUserId: string }): Promise<SolicitudDeFirma> {
    return this.db.consentSignatureRequest.create({
      data: { id: uuidv7(), organizationId: this.organizationId, ...input, checklist: [...input.checklist] },
      select: SELECT,
    }) as Promise<SolicitudDeFirma>;
  }

  /** Resuelve la solicitud viva de ese texto. Devuelve si había una. */
  async resolver(documentId: string, status: 'SIGNED' | 'REJECTED' | 'WITHDRAWN', byUserId: string, note: string | null): Promise<boolean> {
    const { count } = await this.db.consentSignatureRequest.updateMany({
      where: this.scope({ documentId, status: 'PENDING' }),
      data: { status, resolvedByUserId: byUserId, resolvedAt: new Date(), note },
    });
    return count > 0;
  }

  /** Las vivas y las últimas resueltas (para decir «no lo firmó» con su motivo). */
  async recientes(limite = 20): Promise<SolicitudDeFirma[]> {
    return this.db.consentSignatureRequest.findMany({
      where: this.scope({ status: { in: ['PENDING', 'REJECTED', 'SIGNED'] } }), select: SELECT, orderBy: { requestedAt: 'desc' }, take: limite,
    }) as Promise<SolicitudDeFirma[]>;
  }

  async nombres(ids: readonly string[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) return new Map();
    const filas = await this.db.user.findMany({ where: { organizationId: this.organizationId, id: { in: unicos } }, select: { id: true, fullName: true } });
    return new Map(filas.map((u) => [u.id, u.fullName]));
  }
}

/** ¿Este texto es un aviso de privacidad en borrador? Es el que necesita la firma de la dueña. */
export async function esAvisoPorFirmar(organizationId: string, id: string): Promise<boolean> {
  const doc = await new ConsentDocumentRepository(organizationId).findById(id);
  return doc?.consentType === 'PRIVACY_NOTICE';
}

/**
 * La gerencia pide publicar el aviso: se valida igual que al publicar (sin
 * corchetes, con lo mínimo y revisado punto por punto) y queda esperando la
 * firma. Una solicitud anterior del mismo texto se retira.
 */
export async function pedirFirmaDelAviso(ctx: RequestContext, id: string, reason: string, checklist: readonly string[] | null | undefined): Promise<{ status: 'DRAFT'; awaitingSignature: true }> {
  const orgId = ctx.tenant.organizationId;
  const doc = await new ConsentDocumentRepository(orgId).findById(id);
  if (!doc) throw notFound('Documento no encontrado');
  if (doc.status !== 'DRAFT') throw conflict(doc.status === 'PUBLISHED' ? 'Ese texto ya está publicado' : 'Ese texto ya se retiró: crea una versión nueva');
  const r = await revisionDeTexto(orgId, id);
  if (r.placeholders.length > 0) {
    throw validation(`Faltan datos por completar entre [corchetes]: ${r.placeholders.slice(0, 5).join(', ')}${r.placeholders.length > 5 ? '…' : ''}`);
  }
  const sinTratar = r.checklist.filter((c) => !c.found);
  if (sinTratar.length > 0) {
    throw validation(`Al aviso de privacidad le falta: ${sinTratar.map((c) => c.text.charAt(0).toLowerCase() + c.text.slice(1)).join('; ')}. Corrige el borrador y vuelve a revisarlo.`);
  }
  const sinMarcar = puntosSinRevisar(checklist);
  if (sinMarcar.length > 0) {
    throw validation(`Revisa y marca cada punto de la lista antes de pedir la firma del aviso de privacidad (${sinMarcar.length === 1 ? 'falta 1' : `faltan ${sinMarcar.length}`}).`);
  }
  const repo = new SolicitudDeFirmaRepository(orgId);
  const yo = ctx.tenant.actorUserId!;
  await enUnaTransaccion(async () => {
    await repo.resolver(id, 'WITHDRAWN', yo, 'Se volvió a pedir');
    const s = await repo.crear({ documentId: id, reason, checklist: checklist ?? [], bodyHash: huellaDelBorrador(doc), requestedByUserId: yo });
    await new AuditService().record(ctx, {
      action: 'consent.document.sign.request', resourceType: 'consent_document', resourceId: id, reason,
      afterState: { consentType: doc.consentType, version: doc.version, requestId: s.id, bodyHash: s.bodyHash },
    });
  });
  return { status: 'DRAFT', awaitingSignature: true };
}

/** La solicitud viva de ese texto (404 si el texto no es de este gimnasio, 409 si no hay firma pedida). */
export async function solicitudVigente(organizationId: string, id: string): Promise<{ doc: ConsentDocumentRecord; solicitud: SolicitudDeFirma }> {
  const doc = await new ConsentDocumentRepository(organizationId).findById(id);
  if (!doc) throw notFound('Documento no encontrado');
  const solicitud = await new SolicitudDeFirmaRepository(organizationId).pendiente(id);
  if (!solicitud) throw conflict('Ese texto no tiene una firma pedida', 'NOTICE_SIGNATURE_STALE');
  if (doc.status !== 'DRAFT') throw conflict('Ese texto ya no es un borrador');
  return { doc, solicitud };
}

/**
 * La dueña firma: el aviso se publica (con las validaciones de siempre) y la
 * bitácora dice quién lo pidió y quién lo firmó. Su contraseña ya la comprobó
 * la ruta.
 */
export async function firmarAviso(ctx: RequestContext, id: string): Promise<ConsentDocumentRecord> {
  const orgId = ctx.tenant.organizationId;
  const yo = ctx.tenant.actorUserId!;
  const { doc, solicitud } = await solicitudVigente(orgId, id);
  if (huellaDelBorrador(doc) !== solicitud.bodyHash) {
    throw conflict('El borrador cambió después de pedir tu firma: la gerencia tiene que volver a pedirla con el texto nuevo.', 'NOTICE_SIGNATURE_STALE');
  }
  const publicado = await publicarTexto(orgId, id, yo, solicitud.checklist);
  await enUnaTransaccion(async () => {
    await new SolicitudDeFirmaRepository(orgId).resolver(id, 'SIGNED', yo, null);
    await new AuditService().record(ctx, {
      action: 'consent.document.publish', resourceType: 'consent_document', resourceId: id, reason: solicitud.reason,
      afterState: {
        consentType: publicado.consentType, version: publicado.version, bodyHash: publicado.bodyHash,
        ...(solicitud.checklist.length ? { checklist: solicitud.checklist } : {}),
        requestedByUserId: solicitud.requestedByUserId, signedByOwner: true,
      },
    });
  });
  return publicado;
}

/** La dueña no firma: el borrador sigue siendo borrador y la gerencia ve el motivo. */
export async function noFirmarAviso(ctx: RequestContext, id: string, reason: string): Promise<void> {
  const orgId = ctx.tenant.organizationId;
  const { doc, solicitud } = await solicitudVigente(orgId, id);
  await enUnaTransaccion(async () => {
    await new SolicitudDeFirmaRepository(orgId).resolver(id, 'REJECTED', ctx.tenant.actorUserId!, reason);
    await new AuditService().record(ctx, {
      action: 'consent.document.sign.reject', resourceType: 'consent_document', resourceId: id, reason,
      afterState: { consentType: doc.consentType, version: doc.version, requestId: solicitud.id, requestedByUserId: solicitud.requestedByUserId },
    });
  });
}

/** Lo que espera firma y lo último que se firmó o no: una fila por texto, la más reciente. */
export async function solicitudesDeFirma(organizationId: string): Promise<NoticeSignatureRequests['requests']> {
  const repo = new SolicitudDeFirmaRepository(organizationId);
  const filas = await repo.recientes();
  const vistos = new Set<string>();
  const ultimas = filas.filter((f) => (vistos.has(f.documentId) ? false : (vistos.add(f.documentId), true)));
  const docs = new ConsentDocumentRepository(organizationId);
  const nombres = await repo.nombres(ultimas.flatMap((f) => [f.requestedByUserId, ...(f.resolvedByUserId ? [f.resolvedByUserId] : [])]));
  const out: NoticeSignatureRequests['requests'] = [];
  for (const f of ultimas) {
    const doc = await docs.findById(f.documentId);
    if (!doc) continue;
    // Lo no firmado deja de mostrarse cuando el borrador ya se publicó por otra solicitud o se retiró.
    if (f.status === 'REJECTED' && doc.status !== 'DRAFT') continue;
    const cambio = f.status === 'PENDING' && huellaDelBorrador(doc) !== f.bodyHash;
    out.push({
      documentId: f.documentId, version: doc.version, title: doc.title,
      status: cambio ? 'STALE' : (f.status as 'PENDING' | 'SIGNED' | 'REJECTED'),
      requestedAt: f.requestedAt.toISOString(), requestedByName: nombres.get(f.requestedByUserId) ?? null, reason: f.reason,
      resolvedAt: f.resolvedAt?.toISOString() ?? null, resolvedByName: f.resolvedByUserId ? nombres.get(f.resolvedByUserId) ?? null : null, note: f.note,
    });
  }
  return out;
}
