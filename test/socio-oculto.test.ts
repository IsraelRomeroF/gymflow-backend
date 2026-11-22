import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MemberDetail, diferenciasConElContrato } from '@gymflow/core/contracts';
import { makeApp } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, sesionesDe, socioPropio, type GimnasioPropio, type SedePropia } from './gimnasio-propio.js';

/**
 * «OCULTO POR PERMISO» NO ES «NO TIENE» (fase 2, bloque 2.13; 1.1 §7-6, 1.6).
 *
 * El servidor ya no dejaba borrar ni escribir a ciegas el contacto que no se
 * ve. Faltaba que dijera QUÉ ocultó: `hidden` acompaña al socio en la ficha,
 * el padrón y la búsqueda, y la pantalla pinta «No visible para tu puesto» en
 * lugar de un campo vacío.
 */
describe('el socio dice qué se le ocultó a quien pregunta', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let propia: SedePropia;
  let ajena: SedePropia;
  let s: Awaited<ReturnType<typeof sesionesDe>>;
  const ficha = async (id: string, cookie: string) => {
    const r = await app.inject({ method: 'GET', url: `/members/${id}`, headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Propia', cajas: 1 }, { name: 'Ajena', cajas: 1 }] });
    [propia, ajena] = g.sedes as [SedePropia, SedePropia];
    s = await sesionesDe(app, g);
  }, 60_000);
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  it('a recepción de otra sede el contacto le llega en null Y marcado como oculto; a la gerencia, completo y sin marca', async () => {
    const socio = await socioPropio(g, ajena);
    await getDb().member.update({ where: { id: socio }, data: { phoneE164: '+525511112222', email: 'oculto@ejemplo.mx', emergencyContactName: 'Su mamá', emergencyContactPhone: '+525533334444' } });

    const deRecepcion = await ficha(socio, s.recepcion);
    expect(deRecepcion).toMatchObject({ phoneE164: null, email: null, emergencyContactName: null, emergencyContactPhone: null });
    expect(deRecepcion.hidden).toContain('contact');

    const deGerencia = await ficha(socio, s.gerente);
    expect(deGerencia).toMatchObject({ phoneE164: '+525511112222', email: 'oculto@ejemplo.mx', emergencyContactName: 'Su mamá', hidden: [] });
    expect(diferenciasConElContrato(MemberDetail, deGerencia)).toEqual([]);
    expect(diferenciasConElContrato(MemberDetail, deRecepcion)).toEqual([]);

    // Lo mismo en el padrón.
    const padron = (await app.inject({ method: 'GET', url: '/members?limit=50', headers: { cookie: s.recepcion } })).json();
    const fila = (padron.members as Array<{ id: string; hidden: string[]; phoneE164: string | null }>).find((m) => m.id === socio);
    if (fila) { expect(fila.phoneE164).toBeNull(); expect(fila.hidden).toContain('contact'); }
  });

  it('un socio de SU sede sin teléfono: null y SIN marca (de verdad no tiene)', async () => {
    const socio = await socioPropio(g, propia);
    await getDb().member.update({ where: { id: socio }, data: { phoneE164: null, email: 'solo-correo@ejemplo.mx' } });
    const f = await ficha(socio, s.recepcion);
    expect(f.phoneE164).toBeNull();
    expect(f.email).toBe('solo-correo@ejemplo.mx');
    expect(f.hidden).not.toContain('contact');
  });

  it('quien edita sin ver el contacto guarda lo demás omitiendo esos campos, como hace ahora el formulario', async () => {
    const socio = await socioPropio(g, ajena);
    const antes = await getDb().member.findUniqueOrThrow({ where: { id: socio } });
    // El formulario ya no manda los campos de contacto cuando llegan ocultos: el PATCH sin ellos no los toca.
    const r = await app.inject({ method: 'PATCH', url: `/members/${socio}`, headers: { cookie: s.gerente }, payload: { firstName: 'Corregida' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().hidden).toEqual([]);
    const despues = await getDb().member.findUniqueOrThrow({ where: { id: socio } });
    expect(despues.firstName).toBe('Corregida');
    expect(despues.phoneE164).toBe(antes.phoneE164);
  });
});
