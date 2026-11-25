import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { uuidv7 } from '@gymflow/core';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { PlatformCollectionsService } from '../src/modules/tenants/cobranza.service.js';
import { PlatformNoticeRepository } from '../src/modules/tenants/platform-notice.repository.js';

/**
 * FASE 4 · BLOQUE 4.17 · LO QUE LA SUITE CONTABA DE TODA LA BASE.
 *
 * «Avisos por mandar» de la consola tomaba los 500 avisos abiertos más VIEJOS de
 * cualquier clase y filtraba después los que faltaba mandar. Con más de 500
 * abiertos (los ya entregados siguen abiertos hasta que la factura se paga) el
 * aviso más nuevo no salía en la lista: nadie lo mandaba y, sin constancia de
 * entrega, la marca nunca llegaba a la suspensión. En la base de pruebas, que
 * suma unos 50 avisos por corrida de la suite, fallaba `cobranza-de-plataforma`.
 */
describe('avisos por mandar · sin tope que esconda los nuevos (4.17)', () => {
  let viejo: GimnasioPropio;
  let nuevo: GimnasioPropio;
  const rellenos: string[] = [];
  const ahora = new Date();
  const hoy = ahora.toISOString().slice(0, 10);

  beforeAll(async () => {
    viejo = await gimnasioPropio();
    nuevo = await gimnasioPropio();
    // 501 avisos abiertos y YA ENTREGADOS, más viejos que el nuevo: antes llenaban solos el tope.
    const hace = ahora.getTime() - 3_600_000;
    for (let i = 0; i < 501; i++) rellenos.push(uuidv7());
    await getDb().platformNotice.createMany({
      data: rellenos.map((id, i) => ({
        id, organizationId: viejo.organizationId, kind: 'INVOICE_ISSUED', dedupeKey: `INVOICE_ISSUED:relleno-4-17-${id}:1`,
        title: 'Aviso de relleno', body: 'Ya entregado', noticeOn: new Date(`${hoy}T00:00:00.000Z`),
        createdAt: new Date(hace + i), sentAt: new Date(hace + i), deliveredOn: new Date(`${hoy}T00:00:00.000Z`),
      })),
    });
  });
  afterAll(async () => {
    // Se cierran (no se pueden borrar): no quedan abiertos para las corridas que siguen.
    await new PlatformNoticeRepository().cerrar(rellenos, 'CANCELED', new Date());
    await viejo.cerrar(); await nuevo.cerrar();
    await closeDb();
  });

  it('el aviso recién nacido sale en «Avisos por mandar» aunque haya más de 500 abiertos más viejos', async () => {
    const aviso = await new PlatformNoticeRepository().crear({
      organizationId: nuevo.organizationId, kind: 'INVOICE_ISSUED', llave: `prueba-4-17-${uuidv7()}`, title: 'Tu factura', body: 'De prueba', noticeOn: hoy,
    });
    expect(aviso).not.toBeNull();
    const tablero = await new PlatformCollectionsService().tablero(ahora);
    expect(tablero.toSend.map((a) => a.id)).toContain(aviso!.id);
    // Lo ya entregado no se vuelve a pedir.
    expect(tablero.toSend.some((a) => rellenos.includes(a.id))).toBe(false);
    await new PlatformNoticeRepository().cerrar([aviso!.id], 'CANCELED', new Date());
  });
});
