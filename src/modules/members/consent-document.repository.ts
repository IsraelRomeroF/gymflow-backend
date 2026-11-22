import { uuidv7, conflict, notFound, validation } from '@gymflow/core';
import { createHash } from 'node:crypto';
import { PrismaConsentDocumentStatus, PrismaConsentType } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

const D = PrismaConsentDocumentStatus;

export type ConsentDocumentRecord = {
  id: string;
  consentType: string;
  version: string;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  title: string;
  bodyText: string;
  bodyHash: string | null;
  publishedAt: Date | null;
  retiredAt: Date | null;
};

const SELECT = {
  id: true, consentType: true, version: true, status: true,
  title: true, bodyText: true, bodyHash: true, publishedAt: true, retiredAt: true,
} as const;

/**
 * Los TEXTOS que firma el socio.
 *
 * Publicados son inmutables —lo garantiza un trigger, no una costumbre— y solo
 * puede haber uno vigente por tipo, que lo garantiza un índice único parcial.
 * Las dos cosas existen por el mismo motivo: dentro de tres años hay que poder
 * decir exactamente qué palabras aceptó esta persona.
 */
export class ConsentDocumentRepository extends TenantRepository {
  async listAll(): Promise<ConsentDocumentRecord[]> {
    const rows = await this.db.consentDocument.findMany({
      where: this.scope({}),
      select: SELECT,
      orderBy: [{ consentType: 'asc' }, { createdAt: 'desc' }],
    });
    return rows as ConsentDocumentRecord[];
  }

  async listPublished(): Promise<ConsentDocumentRecord[]> {
    const rows = await this.db.consentDocument.findMany({
      where: this.scope({ status: D.PUBLISHED }),
      select: SELECT,
      orderBy: { consentType: 'asc' },
    });
    return rows as ConsentDocumentRecord[];
  }

  async findByTypeAndVersion(consentType: string, version: string): Promise<ConsentDocumentRecord | null> {
    const row = await this.db.consentDocument.findFirst({
      where: this.scope({ consentType: PrismaConsentType[consentType as keyof typeof PrismaConsentType], version }),
      select: SELECT,
    });
    return row as ConsentDocumentRecord | null;
  }

  /**
   * El TEXTO que queda como evidencia de una firma cuando quien firma dice qué
   * versión leyó (el alta en mostrador y la aprobación de un alta digital;
   * PS-06, 21-06). Lo resuelve el servidor por (tipo, versión); lo que mande
   * el navegador no cuenta.
   *
   *  · la versión VIGENTE vale siempre;
   *  · una RETIRADA solo vale si se firmó mientras estaba vigente (`firmadoEl`
   *    dentro de su periodo): el alta digital que se aprueba tarde. Antes una
   *    versión vieja seguía siendo firmable para siempre;
   *  · un borrador no, y una versión que no existe tampoco;
   *  · sin ningún texto publicado del tipo NO se firma (409): antes la firma se
   *    guardaba sin texto, y una firma sin texto no prueba nada.
   */
  async textoParaFirmar(consentType: string, version: string, firmadoEl?: Date | null): Promise<string> {
    const doc = await this.findByTypeAndVersion(consentType, version);
    const vigente = doc?.status === 'PUBLISHED' ? doc : await this.findPublished(consentType);
    if (doc?.status === 'PUBLISHED') return doc.bodyText;
    if (doc?.status === 'DRAFT') throw validation(`El texto ${consentType} ${version} es un borrador: publícalo antes de que alguien lo firme`);
    if (doc?.status === 'RETIRED') {
      const enSuPeriodo = !!firmadoEl && !!doc.publishedAt && doc.publishedAt <= firmadoEl && (!doc.retiredAt || firmadoEl <= doc.retiredAt);
      if (enSuPeriodo) return doc.bodyText;
      throw validation(vigente
        ? `La versión ${version} del texto ${consentType} ya se retiró; la vigente es ${vigente.version}`
        : `La versión ${version} del texto ${consentType} ya se retiró y no hay otra publicada: publícala en Textos de consentimiento`);
    }
    if (vigente) throw validation(`La versión ${version} del texto ${consentType} no existe; la vigente es ${vigente.version}`);
    throw conflict(`No hay texto publicado de ${consentType}: publícalo en Textos de consentimiento antes de que alguien lo firme`, 'CONSENT_TEXT_MISSING');
  }

  /** El texto vigente de un tipo. Solo puede haber uno: lo garantiza el índice. */
  async findPublished(consentType: string): Promise<ConsentDocumentRecord | null> {
    const row = await this.db.consentDocument.findFirst({
      where: this.scope({
        consentType: PrismaConsentType[consentType as keyof typeof PrismaConsentType],
        status: D.PUBLISHED,
      }),
      select: SELECT,
    });
    return row as ConsentDocumentRecord | null;
  }

  async findById(id: string): Promise<ConsentDocumentRecord | null> {
    const row = await this.db.consentDocument.findFirst({
      where: this.scope({ id }), select: SELECT,
    });
    return row as ConsentDocumentRecord | null;
  }

  async create(input: {
    consentType: string; version: string; title: string; bodyText: string;
  }): Promise<ConsentDocumentRecord> {
    const row = await this.db.consentDocument.create({
      data: {
        id: uuidv7(),
        organizationId: this.organizationId,
        consentType: PrismaConsentType[input.consentType as keyof typeof PrismaConsentType],
        version: input.version,
        title: input.title,
        bodyText: input.bodyText,
        status: D.DRAFT,
      },
      select: SELECT,
    });
    return row as ConsentDocumentRecord;
  }

  /**
   * Publicar retira lo anterior EN LA MISMA TRANSACCIÓN.
   *
   * No por elegancia: el índice único parcial rechaza dos publicados del mismo
   * tipo, así que hacerlo en dos pasos dejaría una ventana en la que no hay
   * ninguno vigente y el alta digital se cae sin explicación.
   */
  async publish(id: string, userId: string | null): Promise<ConsentDocumentRecord> {
    return this.db.$transaction(async (tx) => {
      const doc = await tx.consentDocument.findFirst({
        where: this.scope({ id }), select: { ...SELECT, consentType: true },
      });
      if (!doc) throw notFound('Documento no encontrado');
      // Solo se publica un BORRADOR (21-07): antes publicar dos veces el mismo
      // texto lo «republicaba» con otra fecha, y un retirado volvía a la vida.
      if (doc.status !== D.DRAFT) throw conflict(doc.status === D.PUBLISHED ? 'Ese texto ya está publicado' : 'Ese texto ya se retiró: crea una versión nueva');

      await tx.consentDocument.updateMany({
        where: this.scope({ consentType: doc.consentType, status: D.PUBLISHED }),
        data: { status: D.RETIRED, retiredAt: new Date() },
      });

      const row = await tx.consentDocument.update({
        where: { id },
        data: {
          status: D.PUBLISHED,
          publishedAt: new Date(),
          publishedByUserId: userId,
          bodyHash: createHash('sha256').update(doc.bodyText).digest('hex'),
        },
        select: SELECT,
      });
      return row as ConsentDocumentRecord;
    });
  }

  async retire(id: string): Promise<boolean> {
    const { count } = await this.db.consentDocument.updateMany({
      where: this.scope({ id, status: D.PUBLISHED }),
      data: { status: D.RETIRED, retiredAt: new Date() },
    });
    return count > 0;
  }

  /** Corregir un BORRADOR (21-07). Lo publicado y lo retirado no se tocan: además lo impide la base. */
  async updateDraft(id: string, patch: { version?: string; title?: string; bodyText?: string }): Promise<ConsentDocumentRecord | null> {
    const { count } = await this.db.consentDocument.updateMany({ where: this.scope({ id, status: D.DRAFT }), data: patch });
    return count > 0 ? this.findById(id) : null;
  }

  /** Borrar un BORRADOR que nadie va a publicar. */
  async deleteDraft(id: string): Promise<boolean> {
    const { count } = await this.db.consentDocument.deleteMany({ where: this.scope({ id, status: D.DRAFT }) });
    return count > 0;
  }

  /** Cuántas firmas guardan cada (tipo, versión): el historial de un texto (21-07). */
  async firmasPorVersion(): Promise<Map<string, number>> {
    const filas = await this.db.memberConsent.groupBy({
      by: ['consentType', 'documentVersion'], where: { organizationId: this.organizationId }, _count: { _all: true },
    });
    return new Map(filas.map((f) => [`${f.consentType}:${f.documentVersion}`, f._count._all]));
  }
}
