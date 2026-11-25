import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ADJUSTABLE_BY_ROLE, ROLE_PERMISSIONS, uuidv7 } from '@gymflow/core';
import { PortalReceipt, diferenciasConElContrato } from '@gymflow/core/contracts';
import { makeApp, loginAs } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { gimnasioPropio, socioPropio, cargoPropio, type GimnasioPropio } from './gimnasio-propio.js';

/**
 * FASE 4 · BLOQUE 4.11 · CABOS SUELTOS: EL RECIBO DEL PORTAL Y CUATRO PERMISOS.
 *
 *  · El comprobante que el socio abre en su teléfono trae lo que el recibo
 *    imprime del gimnasio (logo, leyenda, teléfonos, RFC), como el del mostrador.
 *  · Lo que HOY pasa con los permisos que `fase3/3.15-guias.md` marcó como
 *    discrepancia. Este bloque no cambia ninguno (ver el informe: ninguno
 *    contradice una decisión escrita); la prueba deja dicho qué pasa, para que
 *    si Israel decide otra cosa el cambio se vea aquí.
 *
 * Gimnasio propio; datos inventados.
 */
describe('cabos sueltos de las fases 3 y 4 (bloque 4.11)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente: string; let recepcion: string;
  let sede: string;

  const db = () => getDb();
  const pedir = (cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    app = await makeApp(); await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Centro', cajas: 1 }] });
    sede = g.sedes[0]!.id;
    gerente = await loginAs(app, g.correos.gerente);
    recepcion = await loginAs(app, g.correos.recepcion);
  }, 120_000);
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  describe('el comprobante del portal imprime lo del gimnasio', () => {
    it('trae logo, leyenda, teléfonos y RFC cuando están registrados; lo que falta viene en null', async () => {
      const socio = await socioPropio(g);
      const cargo = await cargoPropio(g, socio, 45_000n);
      const pago = await pedir(gerente, 'POST', `/members/${socio}/payments`, {
        method: 'SPEI_TRANSFER', amountCents: '45000', branchId: sede, externalRef: 'RASTREO-RECIBO', idempotencyKey: `recibo-4-11-${uuidv7()}`, targetChargeIds: [cargo],
      });
      expect([200, 201], pago.body).toContain(pago.statusCode);
      const inv = await pedir(gerente, 'POST', `/members/${socio}/portal-invite`);
      expect(inv.statusCode, inv.body).toBe(201);
      const act = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: inv.json().code } });
      expect(act.statusCode, act.body).toBe(201);
      const cookie = `gf_portal=${act.cookies.find((c) => c.name === 'gf_portal')!.value}`;
      const recibo = async (): Promise<PortalReceipt> => {
        const r = await pedir(cookie, 'GET', `/portal/payments/${pago.json().payment.id}/receipt`);
        expect(r.statusCode, r.body).toBe(200);
        expect(diferenciasConElContrato(PortalReceipt, r.json())).toEqual([]);
        return r.json() as PortalReceipt;
      };

      // Un gimnasio recién creado no tiene nada de esto.
      expect((await recibo()).gym).toEqual({ logo: null, phone: null, whatsapp: null, rfc: null, receiptLegend: null });

      const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      await db().organization.update({ where: { id: g.organizationId }, data: { logo, phone: '+525500000001', rfc: 'XAXX010101000', receiptLegend: 'Gracias por entrenar con nosotros' } });
      expect((await recibo()).gym).toEqual({ logo, phone: '+525500000001', whatsapp: null, rfc: 'XAXX010101000', receiptLegend: 'Gracias por entrenar con nosotros' });
    });
  });

  describe('permisos que 3.15 marcó como discrepancia: lo que pasa hoy', () => {
    const idDe = async (correo: string) => (await db().user.findFirstOrThrow({ where: { organizationId: g.organizationId, email: correo }, select: { id: true } })).id;
    const ajustar = async (correo: string, add: string[]) => { await db().user.update({ where: { id: await idDe(correo) }, data: { permissionOverrides: { add, remove: [] } } }); };

    it('«se renueva sola»: recepción no la cambia por su puesto; sí, si la gerencia le enciende «cambiar de plan» a esa persona, y siempre con motivo', async () => {
      const socio = await socioPropio(g);
      const id = uuidv7();
      const inicio = new Date(Date.now() - 5 * 86_400_000);
      await db().membership.create({
        data: {
          id, organizationId: g.organizationId, memberId: socio, planId: g.planMensual, soldAtBranchId: sede, status: 'ACTIVE', autoRenew: false,
          startDate: inicio, currentPeriodStart: inicio, currentPeriodEnd: new Date(inicio.getTime() + 30 * 86_400_000), billingAnchorDay: 1,
        },
      });
      const url = `/memberships/${id}/auto-renew`;
      expect(ROLE_PERMISSIONS.RECEPTION).not.toContain('memberships:change_plan');
      expect(ADJUSTABLE_BY_ROLE.RECEPTION.flatMap((x) => x.permissions)).toContain('memberships:change_plan');
      expect((await pedir(recepcion, 'PUT', url, { autoRenew: true, reason: 'Lo pidió el socio' })).statusCode).toBe(403);
      await ajustar(g.correos.recepcion, ['memberships:change_plan']);
      try {
        expect((await pedir(recepcion, 'PUT', url, { autoRenew: true })).statusCode).toBe(422);
        const r = await pedir(recepcion, 'PUT', url, { autoRenew: true, reason: 'Lo pidió el socio' });
        expect(r.statusCode, r.body).toBe(200);
        expect(await db().auditLog.count({ where: { organizationId: g.organizationId, action: 'membership.auto_renew.set', resourceId: id } })).toBe(1);
      } finally {
        await ajustar(g.correos.recepcion, []);
      }
      expect((await pedir(recepcion, 'PUT', url, { autoRenew: false, reason: 'Otra vez' })).statusCode).toBe(403);
    });

    it('anular una venta de tienda: no viene con el puesto de recepción y, desde P-09 (bloque 4.19), tampoco se enciende por persona', () => {
      expect(ROLE_PERMISSIONS.RECEPTION).not.toContain('pos:sale:void');
      expect(ROLE_PERMISSIONS.RECEPTION).not.toContain('pos:sale:return');
      const ajustable = ADJUSTABLE_BY_ROLE.RECEPTION.flatMap((x) => x.permissions);
      expect(ajustable).not.toContain('pos:sale:void');
      // Devolver otro día (con firma) no se le enciende a nadie de recepción.
      expect(ajustable).not.toContain('pos:sale:return');
    });

    it('autorizar la entrada sin rostro: no se le enciende a recepción; la ruta se registra con el permiso de dejar pasar', () => {
      expect(ROLE_PERMISSIONS.RECEPTION).not.toContain('access:entry:authorize');
      expect(ADJUSTABLE_BY_ROLE.RECEPTION.flatMap((x) => x.permissions)).not.toContain('access:entry:authorize');
      expect(ROLE_PERMISSIONS.MANAGER).toContain('access:entry:authorize');
    });

    it('el código del coach: la gerencia trae el permiso por catálogo, pero la ruta solo deja a un coach activo', async () => {
      expect(ROLE_PERMISSIONS.MANAGER).toContain('members:coach:claim');
      const r = await pedir(gerente, 'POST', '/coach/claim', { code: '123456' });
      expect(r.statusCode, r.body).toBe(403);
      expect((await pedir(recepcion, 'POST', '/coach/claim', { code: '123456' })).statusCode).toBe(403);
    });
  });
});
