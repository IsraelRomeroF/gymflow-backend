import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CONTACT_CHANGE_LIMITS, uuidv7 } from '@gymflow/core';
import { makeApp, loginAs, telefonoUnico } from './helpers.js';
import { gimnasioPropio, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * FASE 4 · BLOQUE 4.11 · DOS CABOS DEL CONTACTO DEL SOCIO.
 *
 *  · En el mostrador (`PATCH /members/:id`) cambiar un celular suelta al
 *    responsable del número anterior, igual que cuando el socio lo cambia
 *    desde el portal (4.8).
 *  · En el portal, dos cambios simultáneos del mismo socio no pasan el tope
 *    por periodo: se cuenta con candado, dentro de la transacción.
 *
 * Gimnasio propio; teléfonos inventados.
 */
describe('contacto del socio · cabos de 4.8 (bloque 4.11)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente: string;

  const db = () => getDb();
  const ficha = (id: string) => db().member.findUniqueOrThrow({ where: { id }, select: { phoneE164: true, responsibleKind: true, responsibleMemberId: true, responsibleName: true, guardianSignedAt: true } });
  const editar = (id: string, payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/members/${id}`, headers: { cookie: gerente }, payload });
  async function socio(datos: Record<string, unknown> = {}): Promise<{ id: string; phone: string }> {
    const id = await socioPropio(g);
    const phone = (datos.phoneE164 as string | undefined) ?? telefonoUnico();
    await db().member.update({ where: { id }, data: { ...datos, phoneE164: phone } });
    return { id, phone };
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Centro', cajas: 1 }] });
    gerente = await loginAs(app, g.correos.gerente);
  }, 120_000);

  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  describe('mostrador: el responsable del número cuando la gerencia cambia un celular', () => {
    it('la mamá cambia de celular en el mostrador: sus hijos conservan el suyo y dejan de tenerla anotada', async () => {
      const numero = telefonoUnico();
      const mama = await socio({ phoneE164: numero, responsibleKind: 'SELF' });
      const hija = await socio({ phoneE164: numero, responsibleKind: 'MEMBER', responsibleMemberId: mama.id });
      const hijo = await socio({ phoneE164: numero, responsibleKind: 'MEMBER', responsibleMemberId: mama.id });
      const nuevo = telefonoUnico();
      const r = await editar(mama.id, { phoneE164: nuevo });
      expect(r.statusCode, r.body).toBe(200);
      expect(await ficha(mama.id)).toMatchObject({ phoneE164: nuevo });
      for (const h of [hija, hijo]) expect(await ficha(h.id)).toMatchObject({ phoneE164: numero, responsibleKind: null, responsibleMemberId: null });
      const mira = await app.inject({ method: 'GET', url: `/members/${hija.id}/shared-phone`, headers: { cookie: gerente } });
      expect(mira.json()).toMatchObject({ missingResponsible: true, responsible: null });
      const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'member.update', resourceId: mama.id }, orderBy: { at: 'desc' } });
      expect(asiento.afterState).toMatchObject({ dejaronDeTenerloDeResponsable: 2 });
    });

    it('la hija estrena número propio en el mostrador: suelta a su mamá como responsable; la mamá sigue igual', async () => {
      const numero = telefonoUnico();
      const mama = await socio({ phoneE164: numero, responsibleKind: 'SELF' });
      const hija = await socio({ phoneE164: numero, responsibleKind: 'MEMBER', responsibleMemberId: mama.id });
      expect((await editar(hija.id, { phoneE164: telefonoUnico() })).statusCode).toBe(200);
      expect(await ficha(hija.id)).toMatchObject({ responsibleKind: null, responsibleMemberId: null });
      expect(await ficha(mama.id)).toMatchObject({ phoneE164: numero, responsibleKind: 'SELF' });
    });

    it('editar otra cosa no suelta a nadie; y un adulto o un tutor anotados a mano no se pierden al cambiar el celular', async () => {
      const numero = telefonoUnico();
      const mama = await socio({ phoneE164: numero, responsibleKind: 'SELF' });
      const hija = await socio({ phoneE164: numero, responsibleKind: 'MEMBER', responsibleMemberId: mama.id });
      // Otra cosa, o el mismo celular otra vez: nada cambia.
      expect((await editar(mama.id, { notes: 'Prefiere la mañana', phoneE164: numero })).statusCode).toBe(200);
      expect(await ficha(hija.id)).toMatchObject({ responsibleKind: 'MEMBER', responsibleMemberId: mama.id });

      const firmado = new Date('2026-11-20T18:00:00.000Z');
      const menor = await socio({ responsibleKind: 'ADULT', responsibleName: 'Laura Reyprueba', guardianSignedAt: firmado });
      const conAdulto = await socio({ responsibleKind: 'ADULT', responsibleName: 'Tío Prueba' });
      for (const s of [menor, conAdulto]) expect((await editar(s.id, { phoneE164: telefonoUnico() })).statusCode).toBe(200);
      expect(await ficha(menor.id)).toMatchObject({ responsibleKind: 'ADULT', responsibleName: 'Laura Reyprueba', guardianSignedAt: firmado });
      expect(await ficha(conAdulto.id)).toMatchObject({ responsibleKind: 'ADULT', responsibleName: 'Tío Prueba' });
    });

    it('quitarle el celular a la mamá también suelta a quien la tenía anotada', async () => {
      const numero = telefonoUnico();
      const mama = await socio({ phoneE164: numero, responsibleKind: 'SELF', email: `mama-${uuidv7().slice(-8)}@prueba.example` });
      const hija = await socio({ phoneE164: numero, responsibleKind: 'MEMBER', responsibleMemberId: mama.id });
      const r = await editar(mama.id, { phoneE164: null });
      expect(r.statusCode, r.body).toBe(200);
      expect(await ficha(hija.id)).toMatchObject({ phoneE164: numero, responsibleKind: null, responsibleMemberId: null });
    });
  });

  describe('portal: el tope por periodo con cambios simultáneos', () => {
    it(`con ${CONTACT_CHANGE_LIMITS.EMERGENCY - 1} cambios usados, cinco a la vez: pasa uno y los demás topan`, async () => {
      const m = await socio();
      const inv = await app.inject({ method: 'POST', url: `/members/${m.id}/portal-invite`, headers: { cookie: gerente } });
      expect(inv.statusCode, inv.body).toBe(201);
      const act = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: inv.json().code } });
      expect(act.statusCode, act.body).toBe(201);
      const cookie = `gf_portal=${act.cookies.find((c) => c.name === 'gf_portal')!.value}`;
      // Los cambios ya usados, directo en la base (cada uno su lote), dentro de la ventana.
      const hace = (min: number) => new Date(Date.now() - min * 60_000);
      await db().memberContactChange.createMany({
        data: Array.from({ length: CONTACT_CHANGE_LIMITS.EMERGENCY - 1 }, (_, i) => ({
          id: uuidv7(), organizationId: g.organizationId, memberId: m.id, batchId: uuidv7(), field: 'EMERGENCY_NAME',
          oldValue: `Contacto ${i}`, newValue: `Contacto ${i + 1}`, createdAt: hace(600 - i),
        })),
      });
      const respuestas = await Promise.all(Array.from({ length: 5 }, (_, i) => app.inject({
        method: 'PATCH', url: '/portal/me/contact', headers: { cookie }, payload: { emergencyContactName: `Familiar Simultáneo ${'ABCDE'[i]}` },
      })));
      const codigos = respuestas.map((r) => r.statusCode).sort();
      expect(codigos, respuestas.map((r) => r.body).join('\n')).toEqual([200, 409, 409, 409, 409]);
      for (const r of respuestas.filter((x) => x.statusCode === 409)) expect(r.json()).toMatchObject({ reason: 'CONTACT_CHANGE_LIMIT' });
      const lotes = await db().memberContactChange.findMany({ where: { memberId: m.id }, select: { batchId: true }, distinct: ['batchId'] });
      expect(lotes).toHaveLength(CONTACT_CHANGE_LIMITS.EMERGENCY);
    });
  });
});
