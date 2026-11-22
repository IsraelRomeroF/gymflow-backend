import { createPrismaClient, type Db } from '@gymflow/db';

let instance: Db | undefined;

/**
 * Cliente compartido. Vive aquí y SOLO lo consumen los repositorios:
 * ninguna ruta ni servicio lo recibe directamente (regla de lint en
 * eslint.config.js). Es el control nº2 de ADR-001.
 */
export function getDb(): Db {
  instance ??= createPrismaClient();
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.$disconnect();
    instance = undefined;
  }
}

export type { Db };
