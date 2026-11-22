import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { makeApp, orgFixtures } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * Lo que la base rechaza por integridad es un conflicto esperable, no un 500.
 * Se provoca el rechazo REAL del motor —no una imitación del error— para que
 * la prueba siga valiendo si cambia la forma en que Prisma lo reporta.
 */
describe('errores de la base se traducen a HTTP', () => {
  let app: FastifyInstance;
  let orgId: string;

  beforeAll(async () => {
    app = await makeApp();
    orgId = (await orgFixtures()).demo.id;
    app.post('/__prueba/check', async () => {
      // Viola charges_void_without_payments_chk.
      await getDb().$executeRaw`UPDATE "charges" SET "status" = 'VOID' WHERE "organizationId" = ${orgId}::uuid AND "allocatedCents" > 0 AND "id" = (SELECT "id" FROM "charges" WHERE "organizationId" = ${orgId}::uuid AND "allocatedCents" > 0 LIMIT 1)`;
      return { ok: true };
    });
    app.post('/__prueba/unico', async () => {
      // Una sede VIVA y siempre la misma (1.17b). Sin filtro ni orden, la base devolvía «la primera
      // que encuentre»: si era una sede archivada por otra prueba, repetir su código no viola nada
      // (la unicidad es entre sedes vivas), la ruta respondía 200 y dejaba en el gimnasio de pruebas
      // una sede «Duplicada» viva que rompía a los archivos siguientes (salió con el orden barajado).
      const b = await getDb().branch.findFirstOrThrow({ where: { organizationId: orgId, deletedAt: null }, orderBy: { code: 'asc' } });
      await getDb().branch.create({ data: { id: uuidv7(), organizationId: orgId, code: b.code, name: 'Duplicada' } });
      return { ok: true };
    });
    await app.ready();
  });

  afterAll(async () => { await app.close(); await closeDb(); });

  it('una violación de CHECK responde 409, no 500', async () => {
    const res = await app.inject({ method: 'POST', url: '/__prueba/check' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe('CONFLICT');
  });

  it('una violación de unicidad responde 409, no 500', async () => {
    const res = await app.inject({ method: 'POST', url: '/__prueba/unico' });
    expect(res.statusCode, res.body).toBe(409);
  });
});
