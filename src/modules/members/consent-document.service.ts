import {
  LISTA_DEL_AVISO_DE_PRIVACIDAD, SIGNUP_REQUIRED_CONSENTS, TIPO_DE_CONSENTIMIENTO_PERSONAL, conflict, corchetesSinCompletar, faltantesDelAviso,
  notFound, puntosSinRevisar, validation, type ConsentType,
} from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import type { RequestContext } from '../../platform/context.js';
import { ConsentDocumentRepository, type ConsentDocumentRecord } from './consent-document.repository.js';

/**
 * LOS TEXTOS QUE FIRMA EL SOCIO: revisar antes de publicar (auditoría 8,
 * bloque 1.10; 21-07, 21-08).
 *
 * Israel descartó al abogado (P5): el sistema es la única red. Por eso el
 * servidor no publica
 *  · un texto que no sea un borrador,
 *  · un texto con `[CORCHETES]` del modelo sin completar,
 *  · un aviso de privacidad que no trate lo mínimo (`LISTA_DEL_AVISO_DE_PRIVACIDAD`),
 *  · ni un aviso que la gerencia no haya revisado punto por punto (`checklist`).
 * No es asesoría legal: es lo que el aviso no puede dejar de decir.
 */

const nombre = (tipo: string) => TIPO_DE_CONSENTIMIENTO_PERSONAL[tipo] ?? tipo;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** La lista de Textos, con el historial: cada versión con su periodo y cuántas firmas la guardan. */
export async function listarTextos(organizationId: string) {
  const repo = new ConsentDocumentRepository(organizationId);
  const [docs, firmas] = await Promise.all([repo.listAll(), repo.firmasPorVersion()]);
  return docs.map((d) => ({
    id: d.id, consentType: d.consentType, version: d.version, status: d.status, title: d.title,
    publishedAt: iso(d.publishedAt), retiredAt: iso(d.retiredAt), bodyHash: d.bodyHash,
    signatures: firmas.get(`${d.consentType}:${d.version}`) ?? 0,
  }));
}

function revisar(doc: ConsentDocumentRecord) {
  const placeholders = corchetesSinCompletar(doc.bodyText);
  const faltan = doc.consentType === 'PRIVACY_NOTICE' ? new Set(faltantesDelAviso(doc.bodyText).map((p) => p.clave)) : new Set<string>();
  const checklist = doc.consentType === 'PRIVACY_NOTICE'
    ? LISTA_DEL_AVISO_DE_PRIVACIDAD.map((p) => ({ key: p.clave, text: p.texto, found: !faltan.has(p.clave) }))
    : [];
  return { placeholders, checklist, publishable: doc.status === 'DRAFT' && placeholders.length === 0 && checklist.every((c) => c.found) };
}

/** Lo que se ve en «Revisar y publicar»: el texto, el vigente que reemplazaría y lo que le falta. */
export async function revisionDeTexto(organizationId: string, id: string) {
  const repo = new ConsentDocumentRepository(organizationId);
  const doc = await repo.findById(id);
  if (!doc) throw notFound('Documento no encontrado');
  const vigente = doc.status === 'PUBLISHED' ? null : await repo.findPublished(doc.consentType);
  return {
    id: doc.id, consentType: doc.consentType, version: doc.version, title: doc.title, bodyText: doc.bodyText,
    current: vigente ? { id: vigente.id, version: vigente.version, bodyText: vigente.bodyText, publishedAt: iso(vigente.publishedAt) } : null,
    ...revisar(doc),
  };
}

/**
 * Publica un borrador. `checklist`: las claves que la gerencia marcó como
 * revisadas (solo el aviso de privacidad las exige). La bitácora la asienta
 * quien llama, con el motivo.
 */
export async function publicarTexto(organizationId: string, id: string, userId: string | null, checklist?: readonly string[] | null): Promise<ConsentDocumentRecord> {
  const repo = new ConsentDocumentRepository(organizationId);
  const doc = await repo.findById(id);
  if (!doc) throw notFound('Documento no encontrado');
  if (doc.status !== 'DRAFT') throw conflict(doc.status === 'PUBLISHED' ? 'Ese texto ya está publicado' : 'Ese texto ya se retiró: crea una versión nueva');
  const r = revisar(doc);
  if (r.placeholders.length > 0) {
    throw validation(`Faltan datos por completar entre [corchetes]: ${r.placeholders.slice(0, 5).join(', ')}${r.placeholders.length > 5 ? '…' : ''}`);
  }
  if (doc.consentType === 'PRIVACY_NOTICE') {
    const sinTratar = r.checklist.filter((c) => !c.found);
    if (sinTratar.length > 0) {
      throw validation(`Al aviso de privacidad le falta: ${sinTratar.map((c) => c.text.charAt(0).toLowerCase() + c.text.slice(1)).join('; ')}. Corrige el borrador y vuelve a revisarlo.`);
    }
    const sinMarcar = puntosSinRevisar(checklist);
    if (sinMarcar.length > 0) {
      throw validation(`Revisa y marca cada punto de la lista antes de publicar el aviso de privacidad (${sinMarcar.length === 1 ? 'falta 1' : `faltan ${sinMarcar.length}`}).`);
    }
  }
  return repo.publish(id, userId);
}

/**
 * Retirar un texto SIN reemplazarlo: solo los opcionales. El aviso y el
 * reglamento se firman en toda alta: se reemplazan con otra versión, no se
 * dejan sin texto. Devuelve si había algo publicado que retirar.
 */
export async function retirarTexto(organizationId: string, id: string): Promise<boolean> {
  const repo = new ConsentDocumentRepository(organizationId);
  const doc = await repo.findById(id);
  if (!doc) throw notFound('Documento no encontrado');
  if (SIGNUP_REQUIRED_CONSENTS.includes(doc.consentType as ConsentType)) {
    throw validation(`«${nombre(doc.consentType)}» se firma en toda alta: no se retira sin reemplazo. Publica una versión nueva y esta se retira sola.`);
  }
  return repo.retire(id);
}

/** Corregir un borrador (21-07): antes un error obligaba a crear otra versión. */
export async function corregirBorrador(ctx: RequestContext, id: string, patch: { version?: string | undefined; title?: string | undefined; bodyText?: string | undefined }): Promise<ConsentDocumentRecord> {
  const repo = new ConsentDocumentRepository(ctx.tenant.organizationId);
  const doc = await repo.findById(id);
  if (!doc) throw notFound('Documento no encontrado');
  if (doc.status !== 'DRAFT') throw conflict('Un texto publicado o retirado no se edita: crea una versión nueva');
  if (patch.version && patch.version !== doc.version && await repo.findByTypeAndVersion(doc.consentType, patch.version)) {
    throw conflict(`Ya existe la versión ${patch.version} de «${nombre(doc.consentType)}»`);
  }
  const cambios = {
    ...(patch.version !== undefined ? { version: patch.version } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.bodyText !== undefined ? { bodyText: patch.bodyText } : {}),
  };
  return enUnaTransaccion(async () => {
    const nuevo = await repo.updateDraft(id, cambios);
    if (!nuevo) throw conflict('Ese texto ya no es un borrador');
    await new AuditService().record(ctx, {
      action: 'consent.document.update', resourceType: 'consent_document', resourceId: id,
      afterState: { consentType: doc.consentType, version: nuevo.version, changed: Object.keys(cambios) },
    });
    return nuevo;
  });
}

export async function borrarBorrador(ctx: RequestContext, id: string): Promise<void> {
  const repo = new ConsentDocumentRepository(ctx.tenant.organizationId);
  const doc = await repo.findById(id);
  if (!doc) throw notFound('Documento no encontrado');
  if (doc.status !== 'DRAFT') throw conflict('Solo se borra un borrador: lo publicado y lo retirado son evidencia');
  await enUnaTransaccion(async () => {
    if (!await repo.deleteDraft(id)) throw conflict('Ese texto ya no es un borrador');
    await new AuditService().record(ctx, {
      action: 'consent.document.delete', resourceType: 'consent_document', resourceId: id,
      afterState: { consentType: doc.consentType, version: doc.version },
    });
  });
}
