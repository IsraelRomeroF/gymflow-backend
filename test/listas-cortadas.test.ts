import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { makeApp } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, sesionesDe, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';

/**
 * LISTAS QUE CORTAN SIN AVISAR (bloque 1.17b; pendiente de 1.6).
 *
 * `GET /members/:id/charges` y `GET /members/:id/payments` devolvían como
 * mucho 100 renglones y no decían que había más: ni `hasMore`, ni un total, ni
 * un cursor. No tenían pantalla (28-06) y se retiraron en 2.13. El estado de
 * cuenta paginado de 1.6 (`/members/:id/statement/charges|payments`) sí avisa
 * y es la única lista: aquí se prueba que se recorre entera.
 */
describe('listas del socio con más de 100 renglones', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let cookie: string;
  let socio: string;
  const N = 105;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio();
    cookie = (await sesionesDe(app, g)).gerente;
    socio = await socioPropio(g);
    const sede = g.sedes[0]!;
    const hoy = new Date(new Date().toISOString().slice(0, 10));
    await getDb().charge.createMany({
      data: Array.from({ length: N }, (_, i) => ({
        id: uuidv7(), organizationId: g.organizationId, memberId: socio, branchId: sede.id, chargeType: 'MANUAL_ADJUSTMENT' as const, status: 'OPEN' as const,
        concept: `Cargo ${i + 1}`, subtotalCents: 100n, taxCents: 0n, discountCents: 0n, amountCents: 100n, dueDate: hoy, issuedAt: new Date(),
      })),
    });
    await getDb().payment.createMany({
      data: Array.from({ length: N }, () => ({
        id: uuidv7(), organizationId: g.organizationId, memberId: socio, branchId: sede.id, method: 'SPEI_TRANSFER' as const, status: 'SUCCEEDED' as const,
        amountCents: 100n, unappliedCents: 100n, businessDate: hoy,
      })),
    });
  }, 60_000);

  afterAll(async () => {
    await g.cerrar();
    await app.close();
    await closeDb();
  });

  const pedir = async (url: string) => (await app.inject({ method: 'GET', url, headers: { cookie } })).json();
  /** ¿La respuesta dice de algún modo que hay más de lo que trae? */
  const avisa = (r: Record<string, unknown>) => r.hasMore === true || typeof r.nextCursor === 'string' || r.total === N;

  it('el estado de cuenta por páginas sí dice que hay más (así debe ser)', async () => {
    for (const lista of ['charges', 'payments']) {
      const r = await pedir(`/members/${socio}/statement/${lista}`);
      expect(r.items.length, lista).toBeLessThan(N);
      expect(avisa(r), `${lista}: ${JSON.stringify(Object.keys(r))}`).toBe(true);
    }
  });

  /**
   * Las dos listas viejas cortaban en 100 sin decirlo (defecto 4 de 1.17b). Ninguna
   * pantalla las usaba (ni panel, ni portal, ni recorridos): se retiraron en 2.13.
   * La lista de un socio se lee por páginas y se llega al final sin perder renglones.
   */
  it('las listas viejas que cortaban en 100 ya no existen', async () => {
    for (const lista of ['charges', 'payments']) {
      const r = await app.inject({ method: 'GET', url: `/members/${socio}/${lista}`, headers: { cookie } });
      expect(r.statusCode, lista).toBe(404);
    }
  });

  it('por páginas se llega a los 105 renglones, sin repetir ni perder ninguno', async () => {
    for (const lista of ['charges', 'payments']) {
      const vistos = new Set<string>();
      let cursor: string | null = null;
      for (let vuelta = 0; vuelta < 20; vuelta++) {
        const r = await pedir(`/members/${socio}/statement/${lista}?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        for (const x of r.items as Array<{ id: string }>) { expect(vistos.has(x.id), `${lista}: repetido`).toBe(false); vistos.add(x.id); }
        cursor = (r.nextCursor as string | null) ?? null;
        if (!cursor) break;
      }
      expect(vistos.size, lista).toBe(N);
    }
  });
});
