import { Prisma } from '@gymflow/db';
import { uuidv7, type ContactField } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * LO QUE EL SOCIO CAMBIÓ DE SU CONTACTO DESDE EL PORTAL (auditoría 8, fase 4,
 * bloque 4.8; D-36 c). Tabla `member_contact_changes`: una fila por dato, con
 * el valor de antes y el de ahora.
 *
 * Sirve para tres cosas: avisar al mostrador (que confirma con el socio que
 * fue él), contar el tope de cambios por periodo, y que la gerencia pueda
 * regresar un dato si no fue el socio. Los valores NO van a la bitácora
 * (inmutable): viven aquí y se vacían cuando la ficha se anonimiza.
 */
export type ContactChangeRecord = {
  id: string;
  memberId: string;
  batchId: string;
  field: ContactField;
  oldValue: string | null;
  newValue: string | null;
  sharedPhone: boolean;
  responsibleKind: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedByUserId: string | null;
};

const SELECT = {
  id: true, memberId: true, batchId: true, field: true, oldValue: true, newValue: true, sharedPhone: true, responsibleKind: true,
  createdAt: true, reviewedAt: true, reviewedByUserId: true,
} as const;

/** Los datos cuyo cambio el mostrador confirma con el socio: con ellos el gimnasio lo reconoce y le escribe. */
const DE_IDENTIDAD = ['PHONE', 'EMAIL'];

export class ContactChangeRepository extends TenantRepository {
  /** Asienta lo que se guardó en un mismo toque. La hora la pone quien llama: con ella se cuenta el tope. */
  async registrar(input: {
    memberId: string; sessionId: string | null; at: Date; sharedPhone: boolean; responsibleKind: string | null;
    cambios: ReadonlyArray<{ field: ContactField; oldValue: string | null; newValue: string | null }>;
  }): Promise<string> {
    const batchId = uuidv7();
    await this.db.memberContactChange.createMany({
      data: input.cambios.map((c) => ({
        id: uuidv7(), organizationId: this.organizationId, memberId: input.memberId, batchId, field: c.field,
        oldValue: c.oldValue, newValue: c.newValue, sessionId: input.sessionId, createdAt: input.at,
        // Compartir y el responsable son del celular: no se repiten en los demás datos del mismo toque.
        sharedPhone: c.field === 'PHONE' ? input.sharedPhone : false, responsibleKind: c.field === 'PHONE' ? input.responsibleKind : null,
      })),
    });
    return batchId;
  }

  /** Cada dato cambiado desde `desde`, con su hora y su toque: de aquí sale el tope por periodo. */
  async desde(memberId: string, desde: Date): Promise<Array<{ field: ContactField; batchId: string; createdAt: Date }>> {
    return this.db.memberContactChange.findMany({
      where: this.scope({ memberId, createdAt: { gt: desde } }), select: { field: true, batchId: true, createdAt: true }, orderBy: { createdAt: 'asc' },
    }) as Promise<Array<{ field: ContactField; batchId: string; createdAt: Date }>>;
  }

  /** La última vez que cambió su celular o su correo. */
  async ultimoDeIdentidad(memberId: string): Promise<Date | null> {
    const fila = await this.db.memberContactChange.findFirst({
      where: this.scope({ memberId, field: { in: DE_IDENTIDAD } }), select: { createdAt: true }, orderBy: { createdAt: 'desc' },
    });
    return fila?.createdAt ?? null;
  }

  /** Los más recientes primero. */
  async deSocio(memberId: string, limit = 20): Promise<ContactChangeRecord[]> {
    return this.db.memberContactChange.findMany({
      where: this.scope({ memberId }), select: SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit,
    }) as Promise<ContactChangeRecord[]>;
  }

  /** Cuántos cambios de celular o correo de ese socio nadie ha confirmado con él. */
  async pendientesDe(memberId: string): Promise<number> {
    return this.db.memberContactChange.count({ where: this.scope({ memberId, reviewedAt: null, field: { in: DE_IDENTIDAD } }) });
  }

  /** «Ya lo confirmé con el socio»: todo lo suyo que estaba sin confirmar. Devuelve cuántos. */
  async confirmar(memberId: string, userId: string | null, at: Date): Promise<number> {
    const { count } = await this.db.memberContactChange.updateMany({
      where: this.scope({ memberId, reviewedAt: null }), data: { reviewedAt: at, reviewedByUserId: userId },
    });
    return count;
  }

  /** Al anonimizar: se va el dato y queda que hubo un cambio. Se puede correr dos veces. */
  async olvidarValores(memberId: string): Promise<number> {
    const { count } = await this.db.memberContactChange.updateMany({
      where: this.scope({ memberId, forgottenAt: null }), data: { oldValue: null, newValue: null, forgottenAt: new Date() },
    });
    return count;
  }

  async nombresDePersonal(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const filas = await this.db.user.findMany({ where: { id: { in: [...ids] }, organizationId: this.organizationId }, select: { id: true, fullName: true } });
    return new Map(filas.map((f) => [f.id, f.fullName]));
  }

  /**
   * Para el Inicio del mostrador: los socios VIVOS de esas sedes con un cambio
   * de celular o correo sin confirmar, los más antiguos primero (para que
   * ninguno se quede atrás), y si alguno pasó a compartir celular.
   * `sinSede`: quien tiene el permiso en todo el gimnasio ve también a los socios sin sede de casa.
   */
  async pendientesPorSede(sedes: readonly string[], sinSede: boolean): Promise<{ total: number; nombres: string[]; compartidos: number }> {
    if (sedes.length === 0 && !sinSede) return { total: 0, nombres: [], compartidos: 0 };
    const filas = await this.db.$queryRaw<Array<{ total: number; compartidos: number; nombre: string }>>(Prisma.sql`
      SELECT COUNT(*) OVER ()::int AS "total", (SUM(CASE WHEN p."compartido" THEN 1 ELSE 0 END) OVER ())::int AS "compartidos",
             m."firstName" || ' ' || m."lastName" AS "nombre"
        FROM (
          SELECT c."memberId", MIN(c."createdAt") AS "desde", bool_or(c."sharedPhone") AS "compartido"
            FROM "member_contact_changes" c
           WHERE c."organizationId" = ${this.organizationId}::uuid AND c."reviewedAt" IS NULL AND c."field" IN ('PHONE', 'EMAIL')
           GROUP BY c."memberId"
        ) p
        JOIN "members" m ON m."id" = p."memberId" AND m."organizationId" = ${this.organizationId}::uuid
       WHERE m."deletedAt" IS NULL AND m."anonymizedAt" IS NULL
         AND (m."homeBranchId" = ANY(${sedes as string[]}::uuid[]) OR (${sinSede} AND m."homeBranchId" IS NULL))
       ORDER BY p."desde" ASC, m."id" ASC
       LIMIT 4`);
    return { total: filas[0]?.total ?? 0, nombres: filas.map((f) => f.nombre), compartidos: filas[0]?.compartidos ?? 0 };
  }
}
