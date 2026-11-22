import type { Db } from './client.js';
import { dbActual } from './unit-of-work.js';

/**
 * Capa de repositorio: ÚNICO lugar del sistema que toca el cliente de base de
 * datos (control nº2 de ADR-001, verificado por regla de lint).
 *
 * Todo repositorio recibe el `organizationId` del CONTEXTO DE SESIÓN y lo
 * inyecta en cada `where`. Nunca se acepta un organizationId venido del body
 * ni de un query param: ese es el ataque clásico de multi-tenancy.
 */
export abstract class TenantRepository {
  private readonly dbFijo: Db | undefined;
  protected readonly organizationId: string;

  constructor(organizationId: string, db?: Db) {
    if (!organizationId) throw new Error('TenantRepository exige organizationId');
    this.organizationId = organizationId;
    this.dbFijo = db;
  }

  /** La transacción de la unidad de trabajo en curso, si la hay (OPT2-14). */
  protected get db(): Db {
    return this.dbFijo ?? dbActual();
  }

  /** Filtro obligatorio de tenant. Se compone con el resto del `where`. */
  protected scope<T extends object>(where: T): T & { organizationId: string } {
    return { ...where, organizationId: this.organizationId };
  }
}

/** Repositorios que operan fuera de un tenant (login, catálogo de plataforma). */
export abstract class GlobalRepository {
  private readonly dbFijo: Db | undefined;
  constructor(db?: Db) {
    this.dbFijo = db;
  }

  protected get db(): Db {
    return this.dbFijo ?? dbActual();
  }
}
