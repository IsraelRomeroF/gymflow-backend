import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auditNeedsReview, hoyEn } from '@gymflow/core';
import { makeApp } from './helpers.js';
import { closeDb } from '../src/platform/db/client.js';
import { AuditService } from '../src/platform/audit/audit.service.js';
import { systemContext } from '../src/platform/jobs/types.js';
import { gimnasioPropio, sesionesDe, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';

/**
 * «SENSIBLES HOY» DEL INICIO DE LA DUEÑA = «PARA REVISAR» DE LA BITÁCORA
 * (fase 2, bloque 2.13; pendiente de 1.10). El pulso contaba con una lista
 * propia de 13 acciones: metía cada entrada por excepción (que la Bitácora
 * resume aparte) y dejaba fuera bajas, exportaciones, notas de salud leídas,
 * el corte con diferencia… Ahora cuenta con la regla del núcleo.
 */
describe('el pulso cuenta «para revisar» con la misma regla que la Bitácora', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let owner: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio();
    owner = (await sesionesDe(app, g)).owner;
  }, 60_000);
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  const sensiblesHoy = async () => {
    const r = await app.inject({ method: 'GET', url: '/reports/pulse?fresh=true', headers: { cookie: owner } });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().alerts.sensitiveToday as number;
  };
  const paraRevisarHoy = async () => {
    const hoy = hoyEn('America/Mexico_City');
    const r = await app.inject({ method: 'GET', url: `/audit?category=sensibles&from=${hoy}&to=${hoy}&limit=200`, headers: { cookie: owner } });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json().entries as unknown[]).length;
  };

  it('cuenta lo mismo antes y después de asentar cosas que la lista vieja contaba distinto', async () => {
    expect(await sensiblesHoy()).toBe(await paraRevisarHoy());
    const antes = await sensiblesHoy();

    const audit = new AuditService();
    const ctx = systemContext(g.organizationId);
    const sede = g.sedes[0]!;
    const socio = await socioPropio(g);
    const asentar = (action: string, afterState: Record<string, unknown> = {}) =>
      audit.record(ctx, { action, resourceType: 'Member', resourceId: socio, branchId: sede.id, afterState, reason: 'Prueba del pulso' });

    // Para revisar, y la lista vieja NO las contaba: una baja, una nota de salud leída y un corte con diferencia.
    await asentar('member.archive');
    await asentar('health.read');
    await asentar('cash.session.close', { varianceCents: '-5000' });
    // NO son para revisar: un corte cuadrado y una entrada por excepción (la Bitácora las resume aparte; la lista vieja sí la contaba).
    await asentar('cash.session.close', { varianceCents: '0' });
    await asentar('access.manual_grant');
    // La regla del núcleo dice lo mismo que se espera aquí.
    expect(auditNeedsReview({ action: 'member.archive', afterState: null, beforeState: null } as never)).toBe(true);
    expect(auditNeedsReview({ action: 'access.manual_grant', afterState: null, beforeState: null } as never)).toBe(false);

    expect(await sensiblesHoy()).toBe(antes + 3);
    expect(await sensiblesHoy()).toBe(await paraRevisarHoy());
  });
});
