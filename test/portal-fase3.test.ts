import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { uuidv7 } from '@gymflow/core';
import {
  OUTBOUND_CHANNELS, OutboundMessages, PortalConsents, PortalMe, PortalNotices, PortalNotifications, PortalOffer, PortalReceipt, diferenciasConElContrato,
} from '@gymflow/core/contracts';
import { makeApp, loginAs, telefonoUnico } from './helpers.js';
import { gimnasioPropio, socioPropio, type GimnasioPropio, type SedePropia } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { registeredRoutes } from '../src/platform/http/registry.js';
import { systemContext } from '../src/platform/jobs/types.js';
import { BusinessCalendar } from '../src/platform/time/business-calendar.js';
import { OutboundService } from '../src/modules/outbound/index.js';
import { TEXTO_RETIRADO } from '../src/modules/outbound/outbound.repository.js';
import { responsableDelNumero } from '../src/modules/outbound/outbound.service.js';
import { textoDelMensaje } from '../src/modules/outbound/plantillas.js';
import { PrivacyService } from '../src/modules/privacy/privacy.service.js';
import { PortalNotificationsService, esperarEnvios, usarEnviadorDePrueba, type AvisoAlTelefono } from '../src/modules/portal/notificaciones.js';

const MS_DIA = 86_400_000;

/**
 * FASE 3 · BLOQUE 3.10 · PORTAL DEL SOCIO (auditoría 8; D-34 y D-35, y lo que
 * la oleada A dejó para el portal: D-06, D-08, D-09, D-19 y D-32).
 *
 * Gimnasio propio: aquí se enciende la regla del rostro, se cambian precios y
 * se anonimiza. Nada sale a internet: las notificaciones usan un enviador de
 * prueba.
 */
describe('portal del socio (3.10)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let centro: SedePropia;
  let norte: SedePropia;
  let gerente: string;
  let hoy: Date;

  const db = () => getDb();
  const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const dias = (n: number) => new Date(hoy.getTime() + n * MS_DIA);

  async function socio(sede: SedePropia = centro, datos: Record<string, unknown> = {}): Promise<string> {
    const id = await socioPropio(g, sede);
    await db().member.update({ where: { id }, data: { phoneE164: telefonoUnico(), ...datos } });
    return id;
  }
  async function membresia(memberId: string, opts: { status?: 'ACTIVE' | 'EXPIRED' | 'SUSPENDED'; termina?: Date; planId?: string; pactado?: bigint | null; autoRenew?: boolean; sede?: SedePropia } = {}): Promise<string> {
    const termina = opts.termina ?? dias(20);
    const inicio = new Date(termina.getTime() - 30 * MS_DIA);
    const m = await db().membership.create({
      data: {
        id: uuidv7(), organizationId: g.organizationId, memberId, planId: opts.planId ?? g.planMensual, soldAtBranchId: (opts.sede ?? centro).id, status: opts.status ?? 'ACTIVE',
        startDate: inicio, currentPeriodStart: inicio, currentPeriodEnd: termina, billingAnchorDay: inicio.getUTCDate(), autoRenew: opts.autoRenew ?? true,
        agreedPriceCents: opts.pactado ?? null,
      },
    });
    return m.id;
  }
  async function portalDe(memberId: string): Promise<string> {
    const inv = await app.inject({ method: 'POST', url: `/members/${memberId}/portal-invite`, headers: { cookie: gerente } });
    expect(inv.statusCode, inv.body).toBe(201);
    const act = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: inv.json().code } });
    expect(act.statusCode, act.body).toBe(201);
    return `gf_portal=${act.cookies.find((c) => c.name === 'gf_portal')!.value}`;
  }
  async function yo(cookie: string): Promise<PortalMe> {
    const r = await get('/portal/me', cookie);
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(PortalMe, r.json())).toEqual([]);
    return r.json() as PortalMe;
  }
  const regla = (enabled: boolean) => app.inject({
    method: 'PUT', url: '/access/face-rule', headers: { cookie: gerente }, payload: { enabled, reason: enabled ? 'Ya se registran rostros en recepción' : 'Se apaga para la prueba' },
  });
  const enrolar = async (memberId: string, sede: SedePropia = centro) => {
    const r = await app.inject({
      method: 'POST', url: `/members/${memberId}/biometric-enrollments`, headers: { cookie: gerente },
      payload: { modality: 'FACE', branchId: sede.id, templateRef: `tpl_${uuidv7()}`, algorithmVendor: 'insightface/buffalo_sc', algorithmVersion: '0.7.3', reason: 'Alta del rostro para la prueba' },
    });
    expect(r.statusCode, r.body).toBe(201);
  };
  const previa = async (memberId: string, sede: SedePropia = centro) => (await app.inject({
    method: 'POST', url: '/access/attempts/preview', headers: { cookie: gerente }, payload: { branchId: sede.id, memberId },
  })).json() as { outcome: string; reason: string | null };

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Centro', cajas: 1 }, { name: 'Norte', cajas: 1 }] });
    [centro, norte] = g.sedes as [SedePropia, SedePropia];
    gerente = await loginAs(app, g.correos.gerente);
    hoy = await new BusinessCalendar(g.organizationId).today(null);
    const { ConsentDocumentRepository } = await import('../src/modules/members/index.js');
    const textos = new ConsentDocumentRepository(g.organizationId);
    const bio = await textos.create({ consentType: 'BIOMETRIC', version: 'bio-1', title: 'Biométrico de prueba', bodyText: 'Texto biométrico de prueba' });
    await textos.publish(bio.id, null);
  }, 120_000);

  afterEach(() => usarEnviadorDePrueba(null));

  afterAll(async () => {
    await regla(false);
    await g.cerrar();
    await app.close();
    await closeDb();
  });

  // ── D-06 y D-08: lo que el teléfono dice de la puerta ─────────────────────

  describe('la regla del rostro y el pase de prueba en `/portal/me`', () => {
    it('con la regla apagada nada cambia: el teléfono contesta por su plan y no habla del rostro', async () => {
      const m = await socio();
      await membresia(m);
      const me = await yo(await portalDe(m));
      expect(me).toMatchObject({ canEnter: true, accessReason: null, faceRule: false, faceMissing: false, trialPass: null });
    });

    it('con la regla encendida, a quien no tiene rostro el teléfono le dice que le falta, igual que el mostrador', async () => {
      const sinRostro = await socio();
      await membresia(sinRostro);
      const conRostro = await socio();
      await membresia(conRostro);
      await enrolar(conRostro);
      const sinPlan = await socio();
      expect((await regla(true)).statusCode).toBe(200);
      try {
        // El mostrador lo detiene por el rostro; el teléfono dice que su plan está bien Y que le falta el rostro.
        expect(await previa(sinRostro)).toMatchObject({ outcome: 'DENIED', reason: 'BIOMETRIC_REQUIRED' });
        expect(await yo(await portalDe(sinRostro))).toMatchObject({ canEnter: true, accessReason: null, faceRule: true, faceMissing: true });
        // Con rostro, nada que decir.
        expect(await previa(conRostro)).toMatchObject({ outcome: 'GRANTED' });
        expect(await yo(await portalDe(conRostro))).toMatchObject({ canEnter: true, faceRule: true, faceMissing: false });
        // Sin plan, lo primero es el plan: no se le dice «te falta el rostro» a quien de todos modos no entra.
        expect(await yo(await portalDe(sinPlan))).toMatchObject({ canEnter: false, accessReason: 'NO_MEMBERSHIP', faceRule: true, faceMissing: false });
        // En Norte no hay regla distinta: la regla es del gimnasio y pesa donde la sede usa biometría.
        const deNorte = await socio(norte);
        await membresia(deNorte, { sede: norte });
        expect((await yo(await portalDe(deNorte))).faceMissing).toBe((await previa(deNorte, norte)).reason === 'BIOMETRIC_REQUIRED');
      } finally {
        await regla(false);
      }
    });

    it('quien hoy trae pase de prueba lo ve en su teléfono, y la regla del rostro no lo alcanza', async () => {
      const m = await socio();
      await regla(true);
      try {
        const dado = await app.inject({ method: 'POST', url: `/members/${m}/trial-pass`, headers: { cookie: gerente }, payload: { branchId: centro.id } });
        expect(dado.statusCode, dado.body).toBeLessThan(300);
        const me = await yo(await portalDe(m));
        expect(me).toMatchObject({ canEnter: true, accessReason: null, faceMissing: false, trialPass: { branchName: 'Centro' } });
        expect(me.trialPass!.validOn).toBe((await new BusinessCalendar(g.organizationId).today(centro.id)).toISOString().slice(0, 10));
        expect(await previa(m)).toMatchObject({ outcome: 'GRANTED' });
      } finally {
        await regla(false);
      }
    });
  });

  // ── D-32: el socio retira su rostro desde el teléfono ─────────────────────

  describe('retirar el rostro desde el teléfono', () => {
    it('el permiso biométrico es retirable; al retirarlo el rostro deja de servir y, con la regla encendida, necesita a la gerencia', async () => {
      const m = await socio();
      await membresia(m);
      await enrolar(m);
      const cookie = await portalDe(m);
      const antes = await get('/portal/consents', cookie);
      expect(diferenciasConElContrato(PortalConsents, antes.json())).toEqual([]);
      const bio = (antes.json() as PortalConsents).consents.find((c) => c.consentType === 'BIOMETRIC');
      expect(bio, 'registrar el rostro deja firmado el permiso biométrico').toBeTruthy();
      expect(bio).toMatchObject({ revocable: true, granted: true, revokedAt: null });
      expect((await yo(cookie)).accessMethods).toHaveLength(1);

      const r = await app.inject({ method: 'POST', url: '/portal/consents/BIOMETRIC/revoke', headers: { cookie }, payload: {} });
      expect(r.statusCode, r.body).toBe(200);

      // El permiso quedó retirado, el enrolamiento revocado y no queda plantilla.
      const despues = (await get('/portal/consents', cookie)).json() as PortalConsents;
      expect(despues.consents.filter((c) => c.consentType === 'BIOMETRIC' && c.granted && !c.revokedAt)).toHaveLength(0);
      expect(await db().biometricEnrollment.count({ where: { memberId: m, revokedAt: null } })).toBe(0);
      expect(await db().faceTemplate.count({ where: { memberId: m } })).toBe(0);
      expect((await yo(cookie)).accessMethods).toHaveLength(0);
      // Queda en la bitácora que lo hizo el socio, desde su teléfono.
      const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'consent.revoke', afterState: { path: ['memberCode'], equals: (await db().member.findUniqueOrThrow({ where: { id: m } })).memberCode } } });
      expect(asiento.actorType).toBe('MEMBER');
      expect(asiento.afterState).toMatchObject({ consentType: 'BIOMETRIC', via: 'portal' });

      // Sin regla: entra por recepción. Con la regla: su plan sigue bien, pero cada visita necesita autorización.
      expect(await yo(cookie)).toMatchObject({ canEnter: true, faceMissing: false });
      await regla(true);
      try {
        expect(await yo(cookie)).toMatchObject({ canEnter: true, faceRule: true, faceMissing: true });
        expect(await previa(m)).toMatchObject({ outcome: 'DENIED', reason: 'BIOMETRIC_REQUIRED' });
      } finally {
        await regla(false);
      }

      // Dos veces no: ya no lo tiene.
      const otra = await app.inject({ method: 'POST', url: '/portal/consents/BIOMETRIC/revoke', headers: { cookie }, payload: {} });
      expect(otra.statusCode).toBe(409);
    });

    it('lo obligatorio sigue sin retirarse desde el teléfono, y el texto ya no habla del rostro', async () => {
      const cookie = await portalDe(await socio());
      const r = await app.inject({ method: 'POST', url: '/portal/consents/PRIVACY_NOTICE/revoke', headers: { cookie }, payload: {} });
      expect(r.statusCode).toBe(422);
      expect(r.json().message).toMatch(/darte de baja en recepción/);
      expect(r.json().message).not.toMatch(/rostro/);
    });
  });

  // ── D-19: el comprobante avisa del cambio de precio ───────────────────────

  describe('el comprobante del portal trae el aviso de cambio de precio', () => {
    async function ventaPagada(): Promise<{ memberId: string; membershipId: string; paymentId: string; cookie: string }> {
      const memberId = await socio();
      const venta = await app.inject({
        method: 'POST', url: `/members/${memberId}/memberships/sale`, headers: { cookie: gerente },
        payload: { planId: g.planMensual, branchId: centro.id, saleKey: `venta-${randomUUID()}`, payment: { method: 'SPEI_TRANSFER', externalRef: `SPEI-${randomUUID().slice(0, 8)}` } },
      });
      expect(venta.statusCode, venta.body).toBe(201);
      const membershipId = venta.json().membership.id as string;
      const pago = await db().payment.findFirstOrThrow({ where: { memberId }, orderBy: { createdAt: 'desc' } });
      return { memberId, membershipId, paymentId: pago.id, cookie: await portalDe(memberId) };
    }
    async function cambioDePrecio(v: { memberId: string; membershipId: string }, cuando: Date): Promise<void> {
      const acto = uuidv7();
      await db().planPriceChange.create({ data: { id: acto, organizationId: g.organizationId, planId: g.planMensual, fromPriceCents: 60_000n, toPriceCents: 65_000n, reason: 'Ajuste anual de la prueba', touchedCount: 1, createdAt: cuando } });
      await db().membershipPriceChange.create({ data: { id: uuidv7(), organizationId: g.organizationId, planPriceChangeId: acto, membershipId: v.membershipId, memberId: v.memberId, fromPriceCents: 60_000n, toPriceCents: 65_000n, createdAt: cuando } });
    }
    const recibo = async (v: { paymentId: string; cookie: string }): Promise<PortalReceipt> => {
      const r = await get(`/portal/payments/${v.paymentId}/receipt`, v.cookie);
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(PortalReceipt, r.json())).toEqual([]);
      return r.json() as PortalReceipt;
    };

    it('sin cambio de precio no hay aviso; con un cambio posterior al pago, tampoco', async () => {
      const v = await ventaPagada();
      expect((await recibo(v)).priceNotice).toBeNull();
      await cambioDePrecio(v, new Date(Date.now() + 60_000));
      expect((await recibo(v)).priceNotice).toBeNull();
    });

    it('el primer pago al precio nuevo lo dice, con el antes y el después, igual que el comprobante del mostrador', async () => {
      const v = await ventaPagada();
      // El precio cambió ANTES de emitirse la cuota que este pago cubre: es su primer pago al precio nuevo.
      await cambioDePrecio(v, new Date(Date.now() - 3_600_000));
      const delPortal = await recibo(v);
      // `startsOn` (4.20): solo lo trae un aumento que espera sus 15 días; este cambio de la prueba es anterior a 4.20.
      expect(delPortal.priceNotice).toEqual({ kind: 'APPLIED', planName: 'Mensual', fromPriceCents: '60000', toPriceCents: '65000', startsOn: null });
      const delMostrador = await get(`/payments/${v.paymentId}/receipt`, gerente);
      expect(delMostrador.statusCode, delMostrador.body).toBe(200);
      expect(delMostrador.json().priceNotice).toEqual(delPortal.priceNotice);
    });
  });

  // ── D-35: qué puede renovar o comprar, a precio de lista ──────────────────

  describe('lo que puede renovar o comprar (solo lectura, precio de lista)', () => {
    let paquete: string;
    let anual: string;
    let soloNorte: string;

    beforeAll(async () => {
      [paquete, anual, soloNorte] = [uuidv7(), uuidv7(), uuidv7()];
      await db().plan.createMany({
        data: [
          { id: paquete, organizationId: g.organizationId, code: 'PAQ10', name: 'Paquete 10 visitas', billingModel: 'VISIT_PACK', durationUnit: 'VISIT', durationValue: 10, priceCents: 90_000n, visitsIncluded: 10, visitValidityDays: 60 },
          { id: anual, organizationId: g.organizationId, code: 'ANUAL', name: 'Anual', billingModel: 'PREPAID_PERIOD', durationUnit: 'MONTH', durationValue: 12, priceCents: 600_000n, signupFeeCents: 20_000n },
          { id: soloNorte, organizationId: g.organizationId, code: 'NORTE', name: 'Solo Norte', billingModel: 'RECURRING', durationUnit: 'MONTH', durationValue: 1, priceCents: 40_000n },
        ],
      });
      await db().planBranchAvailability.createMany({
        data: [
          { planId: paquete, branchId: centro.id, organizationId: g.organizationId },
          // El anual tiene precio propio en Centro.
          { planId: anual, branchId: centro.id, organizationId: g.organizationId, priceOverrideCents: 550_000n },
          { planId: anual, branchId: norte.id, organizationId: g.organizationId },
          { planId: soloNorte, branchId: norte.id, organizationId: g.organizationId },
          { planId: soloNorte, branchId: centro.id, organizationId: g.organizationId, isAvailable: false },
        ],
      });
      await db().classType.create({ data: { id: uuidv7(), organizationId: g.organizationId, name: `Spinning ${randomUUID().slice(0, 6)}`, dropInPriceCents: 12_000n } });
      await db().classType.create({ data: { id: uuidv7(), organizationId: g.organizationId, name: `Incluida ${randomUUID().slice(0, 6)}`, dropInPriceCents: 0n } });
    });

    async function oferta(cookie: string): Promise<PortalOffer> {
      const r = await get('/portal/offer', cookie);
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(PortalOffer, r.json())).toEqual([]);
      return r.json() as PortalOffer;
    }

    it('enseña lo que se vende en SU sede, al precio de lista de esa sede, y no se puede comprar desde el teléfono', async () => {
      const m = await socio();
      const o = await oferta(await portalDe(m));
      expect(o.branchName).toBe('Centro');
      expect(o.purchasable).toBe(false);
      expect(o.renewal).toBeNull();
      const porNombre = new Map(o.plans.map((p) => [p.name, p]));
      expect(porNombre.get('Mensual')).toMatchObject({ kind: 'PLAN', priceCents: '60000', current: false });
      // El precio propio de la sede manda sobre el del plan; la inscripción se dice aparte.
      expect(porNombre.get('Anual')).toMatchObject({ kind: 'PLAN', priceCents: '550000', signupFeeCents: '20000', durationUnit: 'MONTH', durationValue: 12 });
      expect(porNombre.get('Paquete 10 visitas')).toMatchObject({ kind: 'VISIT_PACK', priceCents: '90000', visitsIncluded: 10, visitValidityDays: 60 });
      // Lo que no se vende en su sede no aparece.
      expect(porNombre.has('Solo Norte')).toBe(false);
      // Planes primero, del más barato al más caro; después los paquetes.
      expect(o.plans.map((p) => p.name)).toEqual(['Mensual', 'Anual', 'Paquete 10 visitas']);
      // Clases sueltas: solo las que tienen precio.
      expect(o.classes).toHaveLength(1);
      expect(o.classes[0]).toMatchObject({ dropInPriceCents: '12000' });

      const enNorte = await oferta(await portalDe(await socio(norte)));
      expect(enNorte.plans.find((p) => p.name === 'Anual')!.priceCents).toBe('600000');
      expect(enNorte.plans.some((p) => p.name === 'Solo Norte')).toBe(true);
    });

    it('renovar su mismo plan: al precio que tiene si sigue viva; al de lista si ya terminó', async () => {
      // Viva, con un precio pactado más bajo que el de lista (una promoción que le dieron en el mostrador): renueva al suyo.
      const viva = await socio();
      await membresia(viva, { pactado: 50_000n, termina: dias(12) });
      const o1 = await oferta(await portalDe(viva));
      expect(o1.renewal).toEqual({ planId: g.planMensual, planName: 'Mensual', priceCents: '50000', priceKind: 'AGREED', from: dias(12).toISOString().slice(0, 10), autoRenew: true });
      // El plan en la lista sigue a precio de LISTA: el teléfono no reparte su promoción a nadie más.
      expect(o1.plans.find((p) => p.id === g.planMensual)).toMatchObject({ priceCents: '60000', current: true });

      // Terminó: el descuento que tenía ya no vale; vuelve al precio de lista.
      const terminada = await socio();
      await membresia(terminada, { status: 'EXPIRED', pactado: 50_000n, termina: dias(-10) });
      const o2 = await oferta(await portalDe(terminada));
      expect(o2.renewal).toEqual({ planId: g.planMensual, planName: 'Mensual', priceCents: '60000', priceKind: 'LIST', from: null, autoRenew: false });

      // Su último plan ya no se vende en su sede: no hay «renovar», elige de la lista.
      const sinVenta = await socio();
      await membresia(sinVenta, { status: 'EXPIRED', planId: soloNorte, termina: dias(-10) });
      expect((await oferta(await portalDe(sinVenta))).renewal).toBeNull();
    });

    it('«tu siguiente pago» usa la misma puerta que la cuota: el precio propio de la sede cuando no hay pactado', async () => {
      const m = await socio();
      await membresia(m, { planId: anual, termina: dias(40) });
      const me = await yo(await portalDe(m));
      expect(me.nextPayment).toEqual({ amountCents: '550000', date: dias(40).toISOString().slice(0, 10) });
    });

    it('no existe ninguna ruta de socio que compre, renueve o cambie de plan: la oferta es solo lectura', () => {
      const deSocio = registeredRoutes().filter((r) => r.security.kind === 'member').map((r) => `${r.method} ${r.url}`);
      expect(deSocio).toContain('GET /portal/offer');
      const queEscriben = deSocio.filter((r) => !r.startsWith('GET '));
      expect(queEscriben.filter((r) => /offer|renew|purchase|buy|plan|pack|sale|membership/i.test(r))).toEqual([]);
      // Las únicas rutas de socio que tocan dinero son las del procesador, que ya existían (fase 5 las revisa).
      expect(queEscriben.filter((r) => /pay/i.test(r)).sort()).toEqual([
        'DELETE /portal/payment-methods/:id', 'POST /portal/charges/:id/pay', 'POST /portal/payment-methods', 'POST /portal/payment-methods/setup',
      ]);
    });
  });

  // ── D-34: notificaciones gratis que el socio enciende y apaga ─────────────

  describe('notificaciones al teléfono', () => {
    const suscripcion = (n = randomUUID()) => ({ endpoint: `https://push.invalid/${n}`, keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` } });
    const estado = async (cookie: string): Promise<PortalNotifications> => {
      const r = await get('/portal/notifications', cookie);
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(PortalNotifications, r.json())).toEqual([]);
      return r.json() as PortalNotifications;
    };
    const encender = (cookie: string, s = suscripcion()) => app.inject({ method: 'POST', url: '/portal/push-subscriptions', headers: { cookie }, payload: s });
    /** Un enviador que solo anota a qué teléfono mandó qué. */
    function buzon(): Array<{ endpoint: string; aviso: AvisoAlTelefono }> {
      const llegados: Array<{ endpoint: string; aviso: AvisoAlTelefono }> = [];
      usarEnviadorDePrueba(async (s, aviso) => { llegados.push({ endpoint: s.endpoint, aviso }); });
      return llegados;
    }
    const avisar = async (memberId: string, kind: 'PAYMENT_OVERDUE' | 'CLASS_TOMORROW' | 'MEMBERSHIP_SUSPENDED', titulo: string) => {
      const n = await new PortalNotificationsService().avisar(g.organizationId, { memberId, kind, title: titulo, body: 'Cuerpo de prueba', dedupeKey: `${kind}:${randomUUID()}` });
      await esperarEnvios();
      return n;
    };

    it('la bandeja de salida no tiene ningún canal con costo: solo el enlace que abre recepción', () => {
      expect([...OUTBOUND_CHANNELS]).toEqual(['WHATSAPP_LINK']);
    });

    it('sin llaves en el servidor no se ofrece encenderlas y los avisos siguen en la campana', async () => {
      // El entorno de pruebas no trae llaves VAPID; si un día las trae, este caso no aplica.
      if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return;
      const m = await socio();
      const cookie = await portalDe(m);
      expect(await estado(cookie)).toEqual({ available: false, publicKey: null, devices: 0, preferences: { payments: true, classes: true } });
      const r = await encender(cookie);
      expect(r.statusCode).toBe(422);
      expect(r.json().message).toMatch(/siguen en la campana/);
      expect(await avisar(m, 'PAYMENT_OVERDUE', 'Tienes un pago vencido')).toBe(1);
      const campana = (await get('/portal/notices', cookie)).json() as PortalNotices;
      expect(campana.notices.some((n) => n.title === 'Tienes un pago vencido')).toBe(true);
    });

    it('el socio las enciende en su teléfono, le llegan sus avisos, y las apaga', async () => {
      const llegados = buzon();
      const m = await socio();
      const cookie = await portalDe(m);
      expect(await estado(cookie)).toMatchObject({ available: true, publicKey: 'llave-publica-de-prueba', devices: 0 });

      const s = suscripcion();
      const on = await encender(cookie, s);
      expect(on.statusCode, on.body).toBe(201);
      expect(diferenciasConElContrato(PortalNotifications, on.json())).toEqual([]);
      expect(on.json().devices).toBe(1);
      // Encender dos veces el mismo teléfono no lo cuenta dos veces.
      expect((await encender(cookie, s)).json().devices).toBe(1);

      expect(await avisar(m, 'PAYMENT_OVERDUE', 'Tienes un pago vencido')).toBe(1);
      expect(llegados).toHaveLength(1);
      expect(llegados[0]).toMatchObject({ endpoint: s.endpoint, aviso: { title: 'Tienes un pago vencido', body: 'Cuerpo de prueba', url: '/pagos' } });

      const off = await app.inject({ method: 'DELETE', url: '/portal/push-subscriptions', headers: { cookie }, payload: { endpoint: s.endpoint } });
      expect(off.statusCode, off.body).toBe(200);
      expect(off.json().devices).toBe(0);
      await avisar(m, 'PAYMENT_OVERDUE', 'Otro pago vencido');
      expect(llegados).toHaveLength(1);
      // Apagadas en el teléfono, el aviso sigue naciendo en la campana.
      const campana = (await get('/portal/notices', cookie)).json() as PortalNotices;
      expect(campana.notices.map((n) => n.title)).toEqual(expect.arrayContaining(['Tienes un pago vencido', 'Otro pago vencido']));
    });

    it('apaga un tema y deja el otro; lo de acceso llega siempre', async () => {
      const llegados = buzon();
      const m = await socio();
      const cookie = await portalDe(m);
      await encender(cookie);
      const r = await app.inject({ method: 'PUT', url: '/portal/notifications/preferences', headers: { cookie }, payload: { payments: false } });
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(PortalNotifications, r.json())).toEqual([]);
      expect(r.json().preferences).toEqual({ payments: false, classes: true });

      await avisar(m, 'PAYMENT_OVERDUE', 'Pago que no debe sonar');
      await avisar(m, 'CLASS_TOMORROW', 'Mañana: Spinning');
      await avisar(m, 'MEMBERSHIP_SUSPENDED', 'Tu membresía está suspendida');
      expect(llegados.map((l) => l.aviso.title)).toEqual(['Mañana: Spinning', 'Tu membresía está suspendida']);
      expect(llegados.map((l) => l.aviso.url)).toEqual(['/clases', '/pagos']);
      // El aviso de pago no sonó, pero está en la campana.
      expect(((await get('/portal/notices', cookie)).json() as PortalNotices).notices.some((n) => n.title === 'Pago que no debe sonar')).toBe(true);

      // Lo vuelve a encender.
      const otra = await app.inject({ method: 'PUT', url: '/portal/notifications/preferences', headers: { cookie }, payload: { payments: true, classes: false } });
      expect(otra.json().preferences).toEqual({ payments: true, classes: false });
      // Sin decir qué tema, o con algo que no es un tema: 422.
      expect((await app.inject({ method: 'PUT', url: '/portal/notifications/preferences', headers: { cookie }, payload: {} })).statusCode).toBe(422);
      expect((await app.inject({ method: 'PUT', url: '/portal/notifications/preferences', headers: { cookie }, payload: { seguridad: false } })).statusCode).toBe(422);
    });

    it('el mismo aviso no suena dos veces, y un teléfono que ya no existe se da de baja solo', async () => {
      const llegados = buzon();
      const m = await socio();
      const cookie = await portalDe(m);
      await encender(cookie);
      const servicio = new PortalNotificationsService();
      const aviso = { memberId: m, kind: 'PAYMENT_OVERDUE' as const, title: 'Una sola vez', body: 'x', dedupeKey: `PAYMENT_OVERDUE:${randomUUID()}` };
      expect(await servicio.avisar(g.organizationId, aviso)).toBe(1);
      expect(await servicio.avisar(g.organizationId, aviso)).toBe(0);
      await esperarEnvios();
      expect(llegados).toHaveLength(1);

      // El navegador responde 410: esa suscripción murió.
      usarEnviadorDePrueba(async () => { throw Object.assign(new Error('Gone'), { statusCode: 410 }); });
      expect(await avisar(m, 'CLASS_TOMORROW', 'A un teléfono que ya no existe')).toBe(1);
      expect((await estado(cookie)).devices).toBe(0);
    });

    it('al cerrar sesión en ese teléfono, o en todos, dejan de llegar', async () => {
      const llegados = buzon();
      const m = await socio();
      const [uno, dos] = [await portalDe(m), await portalDe(m)];
      await encender(uno);
      await encender(dos);
      // El aviso de «tu portal se activó» del segundo teléfono no cuenta aquí.
      llegados.length = 0;
      expect((await estado(uno)).devices).toBe(2);
      await avisar(m, 'CLASS_TOMORROW', 'A los dos');
      expect(llegados).toHaveLength(2);

      expect((await app.inject({ method: 'POST', url: '/portal/logout', headers: { cookie: uno }, payload: {} })).statusCode).toBe(200);
      expect((await estado(dos)).devices).toBe(1);
      await avisar(m, 'CLASS_TOMORROW', 'Solo al que sigue abierto');
      expect(llegados).toHaveLength(3);

      // Recepción cierra el portal en todos (teléfono perdido): ninguno recibe nada más.
      const cerrar = await app.inject({ method: 'POST', url: `/members/${m}/portal-sessions/revoke`, headers: { cookie: gerente } });
      expect(cerrar.statusCode, cerrar.body).toBe(200);
      await avisar(m, 'CLASS_TOMORROW', 'A nadie');
      expect(llegados).toHaveLength(3);
      expect(await db().memberPushSubscription.count({ where: { memberId: m } })).toBe(0);
    });

    it('abrir el portal en otro teléfono le avisa a los que ya tenía encendidos', async () => {
      const llegados = buzon();
      const m = await socio();
      const primero = await portalDe(m);
      await encender(primero);
      llegados.length = 0;
      await portalDe(m);
      await esperarEnvios();
      expect(llegados).toHaveLength(1);
      expect(llegados[0]!.aviso).toMatchObject({ title: 'Tu portal se activó en un teléfono', url: '/cuenta' });
    });

    it('celular compartido (D-09): un teléfono recibe los avisos de UN socio, y cada portal ve solo los suyos', async () => {
      const llegados = buzon();
      // Mamá e hija con el mismo número; cada una activa su portal con su propio código.
      const numero = telefonoUnico();
      const mama = await socio(centro, { phoneE164: numero, responsibleKind: 'SELF' });
      const hija = await socio(centro, { phoneE164: numero, responsibleKind: 'MEMBER', responsibleMemberId: mama });
      const [deMama, deHija] = [await portalDe(mama), await portalDe(hija)];

      // El MISMO navegador (un solo teléfono): primero lo enciende la mamá, después la hija.
      const elTelefono = suscripcion();
      expect((await encender(deMama, elTelefono)).statusCode).toBe(201);
      expect((await encender(deHija, elTelefono)).statusCode).toBe(201);
      // Ese teléfono quedó a nombre de la última que lo encendió: los avisos no se mezclan.
      expect((await estado(deMama)).devices).toBe(0);
      expect((await estado(deHija)).devices).toBe(1);

      await avisar(mama, 'PAYMENT_OVERDUE', 'Pago de la mamá');
      await avisar(hija, 'PAYMENT_OVERDUE', 'Pago de la hija');
      expect(llegados.map((l) => l.aviso.title)).toEqual(['Pago de la hija']);

      // Y en la campana cada quien ve lo suyo, aunque compartan número.
      const titulos = async (cookie: string) => ((await get('/portal/notices', cookie)).json() as PortalNotices).notices.map((n) => n.title);
      expect(await titulos(deMama)).toContain('Pago de la mamá');
      expect(await titulos(deMama)).not.toContain('Pago de la hija');
      expect(await titulos(deHija)).toContain('Pago de la hija');
      expect(await titulos(deHija)).not.toContain('Pago de la mamá');
      // La mamá no puede apagar el teléfono que ahora es de la hija.
      const ajeno = await app.inject({ method: 'DELETE', url: '/portal/push-subscriptions', headers: { cookie: deMama }, payload: { endpoint: elTelefono.endpoint } });
      expect(ajeno.statusCode).toBe(200);
      expect((await estado(deHija)).devices).toBe(1);
    });

    it('sin sesión de socio, ninguna de estas rutas responde', async () => {
      for (const [method, url] of [['GET', '/portal/notifications'], ['PUT', '/portal/notifications/preferences'], ['POST', '/portal/push-subscriptions'], ['DELETE', '/portal/push-subscriptions'], ['GET', '/portal/offer']] as const) {
        expect((await app.inject({ method, url, payload: {} })).statusCode, `${method} ${url}`).toBe(401);
        // La sesión del personal no es la del socio.
        expect((await app.inject({ method, url, payload: {}, headers: { cookie: gerente } })).statusCode, `${method} ${url} con sesión de personal`).toBe(401);
      }
    });
  });

  // ── D-09: a quién le habla un mensaje de la bandeja ───────────────────────

  describe('bandeja de salida con celular compartido', () => {
    async function cargoVencido(memberId: string): Promise<void> {
      await db().charge.create({
        data: {
          id: uuidv7(), organizationId: g.organizationId, memberId, branchId: centro.id, chargeType: 'MANUAL_ADJUSTMENT', status: 'OVERDUE',
          concept: 'Mensualidad', subtotalCents: 60_000n, taxCents: 0n, discountCents: 0n, amountCents: 60_000n, dueDate: dias(-2), issuedAt: new Date(),
        },
      });
    }
    const lista = async (): Promise<OutboundMessages> => {
      const r = await get('/outbound/messages?limit=500', gerente);
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(OutboundMessages, r.json())).toEqual([]);
      return r.json() as OutboundMessages;
    };

    it('el mensaje saluda a quien responde por el número y dice de quién se habla; con número propio, nada cambia', async () => {
      const numero = telefonoUnico();
      const mama = await socio(centro, { firstName: 'Mariana', lastName: 'Luna', phoneE164: numero, responsibleKind: 'SELF' });
      const hija = await socio(centro, { firstName: 'Renata', lastName: 'Luna', phoneE164: numero, responsibleKind: 'MEMBER', responsibleMemberId: mama });
      // Su tutor no es socio y dejó ESTE mismo número.
      const conTutor = await socio(centro, { firstName: 'Emilio', lastName: 'Paz', responsibleKind: 'ADULT', responsibleName: 'Jorge Paz Ruiz' });
      // Su tutor dejó OTRO número: el celular de la ficha es del socio.
      const conNumeroPropio = await socio(centro, { firstName: 'Sofía', lastName: 'Rey', responsibleKind: 'ADULT', responsibleName: 'Laura Rey', responsiblePhoneE164: telefonoUnico() });
      for (const m of [mama, hija, conTutor, conNumeroPropio]) await cargoVencido(m);
      await new OutboundService().generar(g.organizationId);

      const l = await lista();
      const de = (memberId: string) => l.pending.find((m) => m.memberId === memberId)!;
      // Las dos comparten número: dos mensajes distintos, y cada uno dice de quién es.
      expect(de(mama).phoneE164).toBe(de(hija).phoneE164);
      expect(de(mama).recipientName).toBeNull();
      expect(de(mama).text).toMatch(/^Hola Mariana, te escribimos de .+\. Tu pago de Mensualidad por \$600\.00 venció/);
      expect(de(hija).recipientName).toBe('Mariana Luna');
      // La fila de «Mensajes» lo dice antes de mandar, sin que el panel tenga que saber de celulares compartidos.
      expect(de(hija).detail).toMatch(/Mensualidad · \$600\.00 · venció el .+ · le llega a Mariana Luna, que responde por este celular$/);
      expect(de(mama).detail).not.toMatch(/le llega a/);
      expect(de(hija).text).toMatch(/^Hola Mariana, te escribimos de .+ por Renata Luna, que tiene registrado este celular\. Su pago de Mensualidad por \$600\.00 venció/);
      expect(de(hija).text).not.toMatch(/Hola Renata|Tu pago|ponerte/);
      expect(de(hija).memberName).toBe('Renata Luna');

      expect(de(conTutor).recipientName).toBe('Jorge Paz Ruiz');
      expect(de(conTutor).text).toMatch(/^Hola Jorge, te escribimos de .+ por Emilio Paz, que tiene registrado este celular\./);
      expect(de(conNumeroPropio).recipientName).toBeNull();
      expect(de(conNumeroPropio).text).toMatch(/^Hola Sofía, te escribimos de /);

      // Al mandarlo, lo guardado es lo que se mandó: a nombre de la mamá y hablando de la hija.
      const mandado = await app.inject({ method: 'POST', url: `/members/${hija}/outbound-messages/mark`, headers: { cookie: gerente }, payload: { messageId: de(hija).id, as: 'SENT' } });
      expect(mandado.statusCode, mandado.body).toBe(200);
      expect((await db().outboundMessage.findUniqueOrThrow({ where: { id: de(hija).id } })).body).toBe(de(hija).text);
    });

    it('un responsable ya anonimizado no es nadie: el mensaje vuelve a ir al socio', () => {
      const fila = { phoneE164: '+525500000001', responsibleKind: 'MEMBER', responsibleName: null, responsiblePhoneE164: null, responsibleMemberFirstName: 'Socio', responsibleMemberLastName: 'Anonimizado', responsibleMemberAnonymized: true };
      expect(responsableDelNumero(fila)).toBeNull();
      expect(responsableDelNumero({ ...fila, responsibleMemberFirstName: 'Mariana', responsibleMemberLastName: 'Luna', responsibleMemberAnonymized: false })).toEqual({ nombre: 'Mariana', completo: 'Mariana Luna' });
      expect(responsableDelNumero({ ...fila, responsibleKind: 'SELF' })).toBeNull();
      expect(responsableDelNumero({ ...fila, responsibleKind: null })).toBeNull();
    });

    it('lo que le dice al responsable, palabra por palabra, en cada motivo', () => {
      const base = {
        firstName: 'Renata', lastName: 'Luna', para: 'Mariana', gimnasio: 'Gimnasio Fuerza', sede: null, concept: 'Mensualidad', dueCents: 65_000n,
        dueDate: new Date('2026-11-24T00:00:00Z'), planName: 'Mensual', periodEnd: new Date('2026-11-24T00:00:00Z'), engagementState: null, enLinea: false,
        priceFromCents: 60_000n, priceToCents: 65_000n,
      };
      const saludo = 'Hola Mariana, te escribimos de Gimnasio Fuerza por Renata Luna, que tiene registrado este celular.';
      expect(textoDelMensaje({ ...base, kind: 'PAYMENT_DUE_SOON' })).toBe(`${saludo} Te recordamos que su pago de Mensualidad por $650.00 vence el martes, 24 de noviembre. Se puede pagar en recepción. ¡Gracias!`);
      expect(textoDelMensaje({ ...base, kind: 'PAYMENT_DUE_SOON', dueDate: null })).toBe(`${saludo} Te recordamos que su siguiente pago de Mensual es el martes, 24 de noviembre. Se puede pagar en recepción. ¡Gracias!`);
      expect(textoDelMensaje({ ...base, kind: 'PAYMENT_OVERDUE' })).toBe(`${saludo} Su pago de Mensualidad por $650.00 venció el martes, 24 de noviembre. Se puede poner al corriente en recepción para seguir entrenando sin interrupciones.`);
      expect(textoDelMensaje({ ...base, kind: 'MEMBERSHIP_SUSPENDED' })).toBe(`${saludo} Su membresía quedó suspendida porque se agotó el plazo para pagar. En cuanto se pague en recepción, vuelve a entrar.`);
      expect(textoDelMensaje({ ...base, kind: 'MEMBERSHIP_ENDING' })).toBe(`${saludo} Su plan Mensual termina el lunes, 23 de noviembre. Para seguir sin interrupciones, se puede renovar en recepción.`);
      expect(textoDelMensaje({ ...base, kind: 'PRICE_CHANGE' })).toBe(`${saludo} Te avisamos que a partir de su siguiente pago su plan Mensual cuesta $650.00 (antes $600.00). Cualquier duda, con gusto te atendemos en recepción.`);
      const extranamos = ['ONBOARDING_AT_RISK', 'SLIPPING', 'DORMANT'].map((engagementState) => textoDelMensaje({ ...base, kind: 'WE_MISS_YOU', engagementState }));
      expect(new Set(extranamos).size).toBe(3);
      // Ninguno le habla de tú al socio ni ofrece nada, y con sede se dice cuál.
      for (const t of extranamos) { expect(t.startsWith(saludo)).toBe(true); expect(t).not.toMatch(/\$|descuento|promoci|te extrañamos|has venido/i); }
      expect(textoDelMensaje({ ...base, kind: 'PAYMENT_DUE_SOON', sede: 'Norte', enLinea: true })).toContain('de Gimnasio Fuerza (Norte) por Renata Luna');
      expect(textoDelMensaje({ ...base, kind: 'PAYMENT_DUE_SOON', enLinea: true })).toContain('Se puede pagar desde su portal o en recepción.');
      // Sin responsable, el texto de siempre.
      expect(textoDelMensaje({ ...base, para: null, kind: 'MEMBERSHIP_SUSPENDED' })).toBe('Hola Renata, te escribimos de Gimnasio Fuerza. Tu membresía quedó suspendida porque se agotó el plazo para pagar. En cuanto pagues en recepción, vuelves a entrar.');
    });
  });

  // ── D-32: al anonimizar, lo ya mandado deja de traer su nombre ────────────

  describe('anonimizar a un exsocio', () => {
    it('el texto de los mensajes que se le mandaron deja de traer su nombre, y sus teléfonos dejan de estar suscritos', async () => {
      usarEnviadorDePrueba(async () => undefined);
      const m = await socio(centro, { firstName: 'Zuleica', lastName: 'Quintanar' });
      await db().charge.create({
        data: {
          id: uuidv7(), organizationId: g.organizationId, memberId: m, branchId: centro.id, chargeType: 'MANUAL_ADJUSTMENT', status: 'OVERDUE',
          concept: 'Mensualidad', subtotalCents: 60_000n, taxCents: 0n, discountCents: 0n, amountCents: 60_000n, dueDate: dias(-2), issuedAt: new Date(),
        },
      });
      const cookie = await portalDe(m);
      expect((await app.inject({ method: 'POST', url: '/portal/push-subscriptions', headers: { cookie }, payload: { endpoint: `https://push.invalid/${randomUUID()}`, keys: { p256dh: 'p256dh-de-prueba', auth: 'auth-de-prueba' } } })).statusCode).toBe(201);
      await new OutboundService().generar(g.organizationId);
      const mensaje = await db().outboundMessage.findFirstOrThrow({ where: { memberId: m, status: 'PENDING' } });
      const mandado = await app.inject({ method: 'POST', url: `/members/${m}/outbound-messages/mark`, headers: { cookie: gerente }, payload: { messageId: mensaje.id, as: 'SENT' } });
      expect(mandado.statusCode, mandado.body).toBe(200);
      expect((await db().outboundMessage.findUniqueOrThrow({ where: { id: mensaje.id } })).body).toMatch(/Hola Zuleica/);

      // Se da de baja y, firmado por la dueña, se anonimiza (la firma tiene sus pruebas en `privacy` y `conservacion`).
      await db().member.update({ where: { id: m }, data: { status: 'ARCHIVED', deletedAt: new Date() } });
      await new PrivacyService().anonymize(systemContext(g.organizationId), m, 'Solicitud de cancelación de la prueba');

      const queda = await db().outboundMessage.findUniqueOrThrow({ where: { id: mensaje.id } });
      // La fila sigue: quién lo mandó y cuándo. El texto, no.
      expect(queda.status).toBe('SENT');
      expect(queda.resolvedByUserId).toBeTruthy();
      expect(queda.resolvedAt).toBeTruthy();
      expect(queda.body).toBe(TEXTO_RETIRADO);
      expect(queda.body).not.toMatch(/Zuleica|Quintanar/);
      const todos = await db().outboundMessage.findMany({ where: { memberId: m } });
      expect(todos.filter((x) => x.body && /Zuleica|Quintanar/.test(x.body))).toEqual([]);
      expect(await db().memberPushSubscription.count({ where: { memberId: m } })).toBe(0);
      // Y en «Mandados hoy» la fila ya no dice a quién se le escribió.
      const hoyMandados = ((await get('/outbound/messages?limit=500', gerente)).json() as OutboundMessages).sentToday.find((x) => x.id === mensaje.id);
      expect(hoyMandados?.text ?? TEXTO_RETIRADO).toBe(TEXTO_RETIRADO);
      expect(JSON.stringify(hoyMandados ?? {})).not.toMatch(/Zuleica|Quintanar/);
    });
  });
});
