import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { CONTACT_CHANGE_LIMITS, CONTACT_CHANGE_WINDOW_DAYS, CONTACT_CONFIRM_MAX_FAILURES, normalizedNameKey, uuidv7 } from '@gymflow/core';
import {
  MeHome, MemberContactChanges, MemberSharedPhone, OutboundMessages, PortalContact, PortalMe, PortalNotices, diferenciasConElContrato,
} from '@gymflow/core/contracts';
import { makeApp, loginAs, telefonoUnico } from './helpers.js';
import { gimnasioPropio, socioPropio, type GimnasioPropio, type SedePropia } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { registeredRoutes } from '../src/platform/http/registry.js';
import { MemberRepository, olvidarFallosDeConfirmacion } from '../src/modules/members/index.js';
import { OutboundService } from '../src/modules/outbound/index.js';
import { esperarEnvios, usarEnviadorDePrueba, type AvisoAlTelefono } from '../src/modules/portal/notificaciones.js';
import { avisoDeContactoCambiado } from '../src/modules/portal/contacto.routes.js';

const MS_DIA = 86_400_000;
/** `+5299…` de las pruebas, como lo teclea una persona: diez dígitos con espacios. */
const tecleado = (e164: string) => { const d = e164.slice(-10); return `${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}`; };
const ultimos = (e164: string) => e164.slice(-4);

/**
 * FASE 4 · BLOQUE 4.8 · EL SOCIO CAMBIA SUS DATOS DE CONTACTO DESDE EL PORTAL
 * (auditoría 8; D-36 opción c, con D-09, D-08 y D-34).
 *
 * Gimnasio propio. Nada depende de la hora: el tope por periodo se prueba
 * moviendo la fecha de las filas ya asentadas, no el reloj. Todos los
 * nombres, celulares y correos son inventados.
 */
describe('el socio cambia sus datos de contacto desde el portal (4.8 · D-36)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let centro: SedePropia;
  let norte: SedePropia;
  let gerente: string;
  let recepcion: string;

  const db = () => getDb();
  const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });

  async function socio(datos: Record<string, unknown> = {}, sede: SedePropia = centro): Promise<{ id: string; phone: string }> {
    const id = await socioPropio(g, sede);
    const phone = (datos.phoneE164 as string | null | undefined) === undefined ? telefonoUnico() : (datos.phoneE164 as string);
    const nombre = datos.firstName || datos.lastName ? await db().member.findUniqueOrThrow({ where: { id }, select: { firstName: true, lastName: true } }) : null;
    await db().member.update({
      where: { id },
      data: {
        ...datos, phoneE164: phone,
        ...(nombre ? { nameKey: normalizedNameKey(`${(datos.firstName as string | undefined) ?? nombre.firstName} ${(datos.lastName as string | undefined) ?? nombre.lastName}`) } : {}),
      },
    });
    return { id, phone };
  }
  async function portalDe(memberId: string): Promise<string> {
    const inv = await app.inject({ method: 'POST', url: `/members/${memberId}/portal-invite`, headers: { cookie: gerente } });
    expect(inv.statusCode, inv.body).toBe(201);
    const act = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: inv.json().code } });
    expect(act.statusCode, act.body).toBe(201);
    return `gf_portal=${act.cookies.find((c) => c.name === 'gf_portal')!.value}`;
  }
  const cambiar = (cookie: string, payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/portal/me/contact', headers: { cookie }, payload });
  async function contacto(cookie: string): Promise<PortalContact> {
    const r = await get('/portal/me/contact', cookie);
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(PortalContact, r.json())).toEqual([]);
    return r.json() as PortalContact;
  }
  const ficha = (id: string) => db().member.findUniqueOrThrow({ where: { id } });
  const filas = (memberId: string) => db().memberContactChange.findMany({ where: { memberId }, orderBy: [{ createdAt: 'asc' }, { field: 'asc' }] });
  const asientos = (memberId: string, action: string) => db().auditLog.findMany({ where: { organizationId: g.organizationId, resourceId: memberId, action }, orderBy: { at: 'asc' } });
  const avisos = async (cookie: string) => ((await get('/portal/notices', cookie)).json() as PortalNotices).notices;
  const inicio = async (cookie: string) => {
    const r = await get('/me/home', cookie);
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(MeHome, r.json())).toEqual([]);
    return (r.json() as MeHome).items.find((i) => i.key === 'contactChanges') ?? null;
  };

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Centro', cajas: 1 }, { name: 'Norte', cajas: 1 }] });
    [centro, norte] = g.sedes as [SedePropia, SedePropia];
    gerente = await loginAs(app, g.correos.gerente);
    recepcion = await loginAs(app, g.correos.recepcion);
  }, 120_000);

  beforeEach(() => olvidarFallosDeConfirmacion());
  afterEach(() => usarEnviadorDePrueba(null));

  afterAll(async () => {
    await g.cerrar();
    await app.close();
    await closeDb();
  });

  // ── Lo que el portal enseña ───────────────────────────────────────────────

  describe('«Tus datos»', () => {
    it('enseña el celular y el correo a medias, el contacto de emergencia completo y cuántos cambios quedan', async () => {
      const m = await socio({ email: 'mariana.prueba@correo.invalid', emergencyContactName: 'Rosa Luna', emergencyContactPhone: '+529911112222' });
      const cookie = await portalDe(m.id);
      const r = await get('/portal/me/contact', cookie);
      const c = await contacto(cookie);
      expect(c).toMatchObject({
        hasPhone: true, phoneMasked: `•• •••• ${ultimos(m.phone)}`, hasEmail: true, emailMasked: 'ma•••@correo.invalid',
        emergencyContactName: 'Rosa Luna', emergencyContactPhone: '+529911112222', sharedPhone: false, responsibleKind: null, confirmWith: 'PHONE',
        windowDays: CONTACT_CHANGE_WINDOW_DAYS, lastIdentityChangeAt: null,
      });
      expect(c.limits.phone).toEqual({ max: CONTACT_CHANGE_LIMITS.PHONE, left: CONTACT_CHANGE_LIMITS.PHONE, nextAt: null });
      // El número completo y el correo completo no viajan: la confirmación no valdría nada.
      expect(r.body).not.toContain(m.phone.slice(-10));
      expect(r.body).not.toContain('mariana.prueba');
      expect(r.headers['cache-control']).toBe('no-store');
    });

    it('sin sesión del socio no hay nada; con sesión del personal tampoco', async () => {
      expect((await app.inject({ method: 'GET', url: '/portal/me/contact' })).statusCode).toBe(401);
      expect((await get('/portal/me/contact', gerente)).statusCode).toBe(401);
      expect((await cambiar(gerente, { email: 'otro@correo.invalid' })).statusCode).toBe(401);
    });
  });

  // ── Lo que el socio NO cambia ─────────────────────────────────────────────

  describe('solo contacto', () => {
    it('nombre, fecha de nacimiento, CURP, sucursal, plan o coach se rechazan (no se ignoran) y nada cambia', async () => {
      const m = await socio();
      const cookie = await portalDe(m.id);
      const antes = await ficha(m.id);
      for (const extra of [{ firstName: 'Otro' }, { lastName: 'Apellido' }, { birthDate: '2000-01-01' }, { curp: 'XAXX010101HDFXXX00' }, { homeBranchId: norte.id }, { coachUserId: randomUUID() }, { planId: g.planMensual }, { notes: 'x' }]) {
        const r = await cambiar(cookie, { emergencyContactName: 'Rosa Luna', ...extra });
        expect(r.statusCode, JSON.stringify(extra)).toBe(422);
      }
      const despues = await ficha(m.id);
      expect({ ...despues, updatedAt: null }).toEqual({ ...antes, updatedAt: null });
      expect(await filas(m.id)).toEqual([]);
    });

    it('ninguna ruta del socio que escriba toca su nombre, su CURP, su plan ni su coach', () => {
      // Las rutas de socio que escriben datos de la ficha son solo estas: si nace otra, hay que decidir aquí qué deja cambiar.
      const deFicha = registeredRoutes().filter((r) => r.security.kind === 'member' && r.method !== 'GET' && /^\/portal\/me(\/|$)/.test(r.url)).map((r) => `${r.method} ${r.url}`).sort();
      expect(deFicha).toEqual(['PATCH /portal/me/contact']);
    });
  });

  // ── Contacto de emergencia: directo ───────────────────────────────────────

  describe('contacto de emergencia', () => {
    it('se cambia directo y sin confirmación; queda en su ficha, en el historial y en la bitácora como «el socio», sin valores', async () => {
      const m = await socio();
      const cookie = await portalDe(m.id);
      const r = await cambiar(cookie, { emergencyContactName: ' Rosa Luna ', emergencyContactPhone: '99 1111 3333' });
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(PortalContact, r.json())).toEqual([]);
      expect(r.json()).toMatchObject({ emergencyContactName: 'Rosa Luna', emergencyContactPhone: '+529911113333' });
      expect(await ficha(m.id)).toMatchObject({ emergencyContactName: 'Rosa Luna', emergencyContactPhone: '+529911113333', phoneE164: m.phone });

      const f = await filas(m.id);
      expect(f.map((x) => [x.field, x.oldValue, x.newValue])).toEqual([['EMERGENCY_NAME', null, 'Rosa Luna'], ['EMERGENCY_PHONE', null, '+529911113333']]);
      // Un toque, un lote: cuenta una vez contra su tope.
      expect(new Set(f.map((x) => x.batchId)).size).toBe(1);
      expect((await contacto(cookie)).limits.emergency.left).toBe(CONTACT_CHANGE_LIMITS.EMERGENCY - 1);

      const [asiento, ...mas] = await asientos(m.id, 'member.contact.self_update');
      expect(mas).toEqual([]);
      expect(asiento).toMatchObject({ actorType: 'MEMBER', actorUserId: null, branchId: centro.id });
      expect(asiento!.afterState).toMatchObject({ via: 'portal', changedFields: ['EMERGENCY_NAME', 'EMERGENCY_PHONE'] });
      // La bitácora no se borra: ni el nombre ni el teléfono del contacto van en ella.
      const escrito = JSON.stringify([asiento!.beforeState, asiento!.afterState]);
      expect(escrito).not.toContain('Rosa');
      expect(escrito).not.toContain('11113333');

      // No es un dato de identidad: no avisa a su campana ni le deja tarea al mostrador.
      expect((await avisos(cookie)).filter((n) => n.kind === 'CONTACT_CHANGED')).toEqual([]);
      const pend = (await get(`/members/${m.id}/contact-changes`, recepcion)).json() as MemberContactChanges;
      expect(pend.pending).toBe(0);
      expect(pend.changes).toHaveLength(2);
    });

    it('mandar lo mismo que ya tiene no asienta nada', async () => {
      const m = await socio({ emergencyContactName: 'Rosa Luna' });
      const cookie = await portalDe(m.id);
      const r = await cambiar(cookie, { emergencyContactName: 'Rosa Luna', phoneE164: tecleado(m.phone) });
      expect(r.statusCode, r.body).toBe(200);
      expect(await filas(m.id)).toEqual([]);
      expect(await asientos(m.id, 'member.contact.self_update')).toEqual([]);
    });

    it('se puede borrar, y un nombre que no es un nombre no pasa', async () => {
      const m = await socio({ emergencyContactName: 'Rosa Luna', emergencyContactPhone: '+529911114444' });
      const cookie = await portalDe(m.id);
      expect((await cambiar(cookie, { emergencyContactName: '<b>x</b>' })).statusCode).toBe(422);
      expect((await cambiar(cookie, { emergencyContactPhone: '123' })).statusCode).toBe(422);
      const r = await cambiar(cookie, { emergencyContactName: '', emergencyContactPhone: null });
      expect(r.statusCode, r.body).toBe(200);
      expect(await ficha(m.id)).toMatchObject({ emergencyContactName: null, emergencyContactPhone: null });
    });
  });

  // ── Celular: confirmación, aviso, bitácora ────────────────────────────────

  describe('celular', () => {
    it('pide escribir completo el celular registrado: sin él, o con otro, no cambia nada', async () => {
      const m = await socio();
      const cookie = await portalDe(m.id);
      const nuevo = telefonoUnico();
      for (const confirm of [undefined, '', ultimos(m.phone), tecleado(nuevo)]) {
        const r = await cambiar(cookie, { phoneE164: tecleado(nuevo), ...(confirm === undefined ? {} : { confirm }) });
        expect(r.statusCode, r.body).toBe(422);
        expect(r.json()).toMatchObject({ reason: 'CONTACT_CONFIRMATION_FAILED' });
        // El mensaje no le dicta el número registrado.
        expect(r.body).not.toContain(m.phone.slice(-10));
      }
      expect((await ficha(m.id)).phoneE164).toBe(m.phone);
      expect(await filas(m.id)).toEqual([]);
    });

    it('con la confirmación correcta cambia en el acto, normalizado como en el mostrador', async () => {
      const m = await socio();
      const cookie = await portalDe(m.id);
      const nuevo = telefonoUnico();
      // Lo teclea con espacios y con lada de país; el registrado, con guiones.
      const r = await cambiar(cookie, { phoneE164: `+52 ${tecleado(nuevo)}`, confirm: tecleado(m.phone).replace(/ /g, '-') });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ phoneMasked: `•• •••• ${ultimos(nuevo)}`, sharedPhone: false, confirmWith: 'PHONE' });
      expect(r.json().lastIdentityChangeAt).not.toBeNull();
      expect((await ficha(m.id)).phoneE164).toBe(nuevo);
      expect((await filas(m.id)).map((x) => [x.field, x.oldValue, x.newValue, x.sharedPhone])).toEqual([['PHONE', m.phone, nuevo, false]]);

      // La bitácora: quién (el socio), qué dato y la terminación de antes y de ahora; nunca el número.
      const [asiento] = await asientos(m.id, 'member.contact.self_update');
      expect(asiento).toMatchObject({ actorType: 'MEMBER' });
      expect(asiento!.beforeState).toEqual({ phoneLast4: ultimos(m.phone) });
      expect(asiento!.afterState).toMatchObject({ via: 'portal', changedFields: ['PHONE'], phoneLast4: ultimos(nuevo), sharedPhone: false });
      const escrito = JSON.stringify([asiento!.beforeState, asiento!.afterState]);
      expect(escrito).not.toContain(m.phone.slice(-10));
      expect(escrito).not.toContain(nuevo.slice(-10));

      // El siguiente cambio se confirma con el número NUEVO: el viejo ya no sirve.
      const otro = telefonoUnico();
      expect((await cambiar(cookie, { phoneE164: otro, confirm: m.phone })).statusCode).toBe(422);
      expect((await cambiar(cookie, { phoneE164: otro, confirm: nuevo })).statusCode).toBe(200);
    });

    it('un celular que no es un celular no pasa, y el celular no se quita desde el portal', async () => {
      const m = await socio();
      const cookie = await portalDe(m.id);
      for (const phoneE164 of ['55123', '0000000000', '', null]) {
        const r = await cambiar(cookie, { phoneE164, confirm: m.phone });
        expect(r.statusCode, String(phoneE164)).toBe(422);
      }
      expect((await ficha(m.id)).phoneE164).toBe(m.phone);
    });

    it(`tras ${CONTACT_CONFIRM_MAX_FAILURES} confirmaciones fallidas se detiene una hora, aunque después escriba la correcta`, async () => {
      const m = await socio();
      const cookie = await portalDe(m.id);
      const nuevo = telefonoUnico();
      for (let i = 0; i < CONTACT_CONFIRM_MAX_FAILURES; i++) expect((await cambiar(cookie, { phoneE164: nuevo, confirm: '99 0000 0001' })).statusCode).toBe(422);
      const r = await cambiar(cookie, { phoneE164: nuevo, confirm: m.phone });
      expect(r.statusCode, r.body).toBe(429);
      expect(r.json().message).toMatch(/pasa a recepción/);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      expect((await ficha(m.id)).phoneE164).toBe(m.phone);
      // El contacto de emergencia no pide confirmación: sigue pudiendo.
      expect((await cambiar(cookie, { emergencyContactName: 'Rosa Luna' })).statusCode).toBe(200);
      // El freno es de ESE socio: otro socio cambia el suyo sin problema.
      const otro = await socio();
      expect((await cambiar(await portalDe(otro.id), { phoneE164: telefonoUnico(), confirm: otro.phone })).statusCode).toBe(200);
    });

    it('le avisa al propio socio en su campana y en todos sus teléfonos, sin cerrarle ninguno', async () => {
      const llegados: Array<{ endpoint: string; aviso: AvisoAlTelefono }> = [];
      usarEnviadorDePrueba(async (s, aviso) => { llegados.push({ endpoint: s.endpoint, aviso }); });
      const m = await socio();
      const [uno, dos] = [await portalDe(m.id), await portalDe(m.id)];
      for (const cookie of [uno, dos]) {
        const n = randomUUID();
        const on = await app.inject({ method: 'POST', url: '/portal/push-subscriptions', headers: { cookie }, payload: { endpoint: `https://push.invalid/${n}`, keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` } } });
        expect(on.statusCode, on.body).toBe(201);
      }
      await esperarEnvios();
      llegados.length = 0;

      // Lo cambia desde UN teléfono.
      const nuevo = telefonoUnico();
      expect((await cambiar(uno, { phoneE164: nuevo, confirm: m.phone })).statusCode).toBe(200);
      await esperarEnvios();

      // Llega a los DOS (el otro es donde se entera el titular si no fue él), y a /cuenta.
      expect(llegados).toHaveLength(2);
      expect(new Set(llegados.map((l) => l.endpoint)).size).toBe(2);
      expect(llegados[0]!.aviso).toMatchObject({ title: 'Tu celular cambió', url: '/cuenta' });
      const [aviso] = (await avisos(dos)).filter((n) => n.kind === 'CONTACT_CHANGED');
      expect(aviso).toMatchObject({ title: 'Tu celular cambió', readAt: null, priority: 'INFO' });
      expect(aviso!.body).toMatch(new RegExp(`^El .+ a las \\d{2}:\\d{2}, desde el portal\\. Tu celular ahora termina en ${ultimos(nuevo)}\\. Si no fuiste tú, cierra la sesión en todos tus teléfonos desde Cuenta y avisa en recepción\\.$`));
      expect(aviso!.body).not.toContain(nuevo.slice(-10));
      // Los dos teléfonos siguen abiertos: cerrarlos dejaría fuera justo al titular.
      expect((await get('/portal/sessions', dos)).json()).toMatchObject({ active: 2 });
      // Y el titular, desde el otro teléfono, los cierra todos.
      expect((await app.inject({ method: 'POST', url: '/portal/logout-all', headers: { cookie: dos }, payload: {} })).statusCode).toBe(200);
      expect((await get('/portal/me/contact', uno)).statusCode).toBe(401);
    });

    it('el aviso dice qué cambió sin repetir el dato', () => {
      const cuando = 'El 24 de noviembre a las 16:31';
      expect(avisoDeContactoCambiado({ changes: [{ field: 'EMERGENCY_NAME', oldValue: null, newValue: 'Rosa Luna' }] }, cuando)).toBeNull();
      expect(avisoDeContactoCambiado({ changes: [{ field: 'EMAIL', oldValue: null, newValue: 'mariana@correo.invalid' }] }, cuando))
        .toEqual({ title: 'Tu correo cambió', body: `${cuando}, desde el portal. Tu correo ahora es ma•••@correo.invalid. Si no fuiste tú, cierra la sesión en todos tus teléfonos desde Cuenta y avisa en recepción.` });
      expect(avisoDeContactoCambiado({ changes: [{ field: 'EMAIL', oldValue: 'mariana@correo.invalid', newValue: null }] }, cuando)!.body).toContain('Ya no tenemos un correo tuyo.');
      expect(avisoDeContactoCambiado({ changes: [{ field: 'PHONE', oldValue: null, newValue: '+529900001234' }, { field: 'EMAIL', oldValue: null, newValue: 'mariana@correo.invalid' }] }, cuando)!.title).toBe('Tu celular y tu correo cambiaron');
    });
  });

  // ── Tope por periodo ──────────────────────────────────────────────────────

  describe('tope de cambios', () => {
    it(`el celular cambia ${CONTACT_CHANGE_LIMITS.PHONE} veces en ${CONTACT_CHANGE_WINDOW_DAYS} días; la siguiente es en recepción, y al salir de la ventana vuelve a poder`, async () => {
      const m = await socio();
      const cookie = await portalDe(m.id);
      let actual = m.phone;
      for (let i = 0; i < CONTACT_CHANGE_LIMITS.PHONE; i++) {
        const nuevo = telefonoUnico();
        expect((await cambiar(cookie, { phoneE164: nuevo, confirm: actual })).statusCode).toBe(200);
        actual = nuevo;
      }
      const c = await contacto(cookie);
      expect(c.limits.phone).toMatchObject({ max: CONTACT_CHANGE_LIMITS.PHONE, left: 0 });
      expect(c.limits.phone.nextAt).not.toBeNull();
      // Cada dato lleva su cuenta: el correo y el contacto de emergencia siguen enteros.
      expect(c.limits.email.left).toBe(CONTACT_CHANGE_LIMITS.EMAIL);

      const r = await cambiar(cookie, { phoneE164: telefonoUnico(), confirm: actual });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ reason: 'CONTACT_CHANGE_LIMIT' });
      expect(r.json().message).toMatch(/pasa a recepción/);
      expect((await ficha(m.id)).phoneE164).toBe(actual);
      // El tope del celular no detiene lo demás.
      expect((await cambiar(cookie, { email: 'nuevo.correo@correo.invalid', confirm: actual })).statusCode).toBe(200);

      // El más viejo sale de la ventana: se libera UN cambio (sin mover el reloj: se mueve la fila).
      const [masViejo] = await filas(m.id);
      await db().memberContactChange.update({ where: { id: masViejo!.id }, data: { createdAt: new Date(Date.now() - (CONTACT_CHANGE_WINDOW_DAYS + 1) * MS_DIA) } });
      expect((await contacto(cookie)).limits.phone).toMatchObject({ left: 1, nextAt: null });
      expect((await cambiar(cookie, { phoneE164: telefonoUnico(), confirm: actual })).statusCode).toBe(200);
      expect((await contacto(cookie)).limits.phone.left).toBe(0);
    });

    it('el mostrador no gasta el tope del socio: lo que corrige la gerencia no cuenta', async () => {
      const m = await socio();
      const cookie = await portalDe(m.id);
      const r = await app.inject({ method: 'PATCH', url: `/members/${m.id}`, headers: { cookie: gerente }, payload: { phoneE164: telefonoUnico() } });
      expect(r.statusCode, r.body).toBe(200);
      expect((await contacto(cookie)).limits.phone.left).toBe(CONTACT_CHANGE_LIMITS.PHONE);
      expect(await filas(m.id)).toEqual([]);
    });
  });

  // ── Correo ────────────────────────────────────────────────────────────────

  describe('correo', () => {
    it('se cambia con la misma confirmación; uno mal escrito dice en qué campo', async () => {
      const m = await socio({ email: 'viejo@correo.invalid' });
      const cookie = await portalDe(m.id);
      const mal = await cambiar(cookie, { email: 'sin-arroba', confirm: m.phone });
      expect(mal.statusCode).toBe(422);
      expect(mal.body).toMatch(/email/);
      expect((await cambiar(cookie, { email: 'nuevo@correo.invalid' })).json()).toMatchObject({ reason: 'CONTACT_CONFIRMATION_FAILED' });
      const r = await cambiar(cookie, { email: '  Nuevo@Correo.invalid ', confirm: m.phone });
      expect(r.statusCode, r.body).toBe(200);
      expect((await ficha(m.id)).email).toBe('nuevo@correo.invalid');
      expect((await avisos(cookie)).find((n) => n.kind === 'CONTACT_CHANGED')).toMatchObject({ title: 'Tu correo cambió' });
      // El correo no va a la bitácora ni a medias.
      const [asiento] = await asientos(m.id, 'member.contact.self_update');
      expect(JSON.stringify([asiento!.beforeState, asiento!.afterState])).not.toMatch(/correo\.invalid|nuevo|viejo/);
    });

    it('quien solo tiene correo confirma con su correo; y nadie se queda sin celular ni correo desde el teléfono', async () => {
      const m = await socio({ phoneE164: null, email: 'solo.correo@correo.invalid' });
      const cookie = await portalDe(m.id);
      expect(await contacto(cookie)).toMatchObject({ hasPhone: false, phoneMasked: null, confirmWith: 'EMAIL' });
      // Quitar el correo lo dejaría sin forma de localizarlo.
      const quitar = await cambiar(cookie, { email: null, confirm: 'solo.correo@correo.invalid' });
      expect(quitar.statusCode, quitar.body).toBe(409);
      expect(quitar.json()).toMatchObject({ reason: 'CONTACT_CHANGE_NOT_ALLOWED' });
      // Agregar su celular: confirma con el correo.
      const nuevo = telefonoUnico();
      expect((await cambiar(cookie, { phoneE164: nuevo, confirm: 'otro@correo.invalid' })).statusCode).toBe(422);
      expect((await cambiar(cookie, { phoneE164: nuevo, confirm: 'SOLO.CORREO@correo.invalid' })).statusCode).toBe(200);
      // Ya con celular, el correo sí se puede quitar (y ahora se confirma con el celular).
      expect((await cambiar(cookie, { email: '', confirm: nuevo })).statusCode).toBe(200);
      expect(await ficha(m.id)).toMatchObject({ phoneE164: nuevo, email: null });
    });

    it('quien no tiene ni celular ni correo agrega el primero sin confirmación (no hay con qué)', async () => {
      const m = await socio({ phoneE164: null });
      const cookie = await portalDe(m.id);
      expect((await contacto(cookie)).confirmWith).toBeNull();
      const nuevo = telefonoUnico();
      expect((await cambiar(cookie, { phoneE164: nuevo })).statusCode).toBe(200);
      expect((await ficha(m.id)).phoneE164).toBe(nuevo);
      // Y también queda avisado y por confirmar en el mostrador.
      expect((await avisos(cookie)).some((n) => n.kind === 'CONTACT_CHANGED')).toBe(true);
    });
  });

  // ── D-09: el celular nuevo ya es de otro socio ────────────────────────────

  describe('celular que ya es de otro socio (D-09)', () => {
    it('sin decir quién responde se rechaza, y el mensaje no revela de quién es el número', async () => {
      const mama = await socio({ firstName: 'Mariana', lastName: 'Lunaprueba' });
      const mamaFicha = await ficha(mama.id);
      const hija = await socio({ firstName: 'Renata', lastName: 'Lunaprueba' });
      const cookie = await portalDe(hija.id);
      const r = await cambiar(cookie, { phoneE164: mama.phone, confirm: hija.phone });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ reason: 'PHONE_IN_USE' });
      for (const secreto of ['Mariana', mamaFicha.memberCode, mama.id]) expect(r.body).not.toContain(secreto);
      expect((await ficha(hija.id)).phoneE164).toBe(hija.phone);
    });

    it('«yo respondo»: comparte el número, queda anotada ella, y en la ficha de la otra persona no se escribe nada', async () => {
      const mama = await socio({ firstName: 'Mariana', lastName: 'Solprueba' });
      const hija = await socio({ firstName: 'Renata', lastName: 'Solprueba' });
      const cookie = await portalDe(hija.id);
      const antes = await ficha(mama.id);
      const r = await cambiar(cookie, { phoneE164: mama.phone, confirm: hija.phone, responsible: { kind: 'SELF' } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ sharedPhone: true, responsibleKind: 'SELF' });
      expect(r.body).not.toContain('Mariana');
      expect(await ficha(hija.id)).toMatchObject({ phoneE164: mama.phone, responsibleKind: 'SELF', responsibleMemberId: null });
      // Desde el portal un socio no escribe en la ficha de otro.
      expect({ ...(await ficha(mama.id)), updatedAt: null }).toEqual({ ...antes, updatedAt: null });
      // El mostrador sí ve con quién comparte (y que a la mamá le falta anotar quién responde).
      const comp = await get(`/members/${hija.id}/shared-phone`, gerente);
      expect(diferenciasConElContrato(MemberSharedPhone, comp.json())).toEqual([]);
      expect((comp.json() as MemberSharedPhone).sharedWith.map((s) => s.id)).toEqual([mama.id]);
      // Queda dicho para el mostrador y en la bitácora (la clase de responsable, sin nombres).
      expect((await filas(hija.id))[0]).toMatchObject({ field: 'PHONE', sharedPhone: true, responsibleKind: 'SELF' });
      expect((await asientos(hija.id, 'member.contact.self_update'))[0]!.afterState).toMatchObject({ sharedPhone: true, responsable: 'SELF' });
    });

    it('«responde mi familiar, que ya es socio»: se anota a quien ya tiene el número, sin decirle quién es', async () => {
      const mama = await socio({ firstName: 'Mariana', lastName: 'Rioprueba' });
      const hija = await socio({ firstName: 'Renata', lastName: 'Rioprueba' });
      const r = await cambiar(await portalDe(hija.id), { phoneE164: mama.phone, confirm: hija.phone, responsible: { kind: 'HOLDER' } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ sharedPhone: true, responsibleKind: 'MEMBER' });
      expect(r.body).not.toContain(mama.id);
      expect(await ficha(hija.id)).toMatchObject({ responsibleKind: 'MEMBER', responsibleMemberId: mama.id });
      // La ficha de la mamá no se tocó, y aun así el mostrador la ve como quien responde.
      expect((await ficha(mama.id)).responsibleKind).toBeNull();
      expect(((await get(`/members/${mama.id}/shared-phone`, gerente)).json() as MemberSharedPhone).responsible).toMatchObject({ kind: 'SELF' });
    });

    it('«es de un adulto que no es socio»: se anota su nombre', async () => {
      const otro = await socio();
      const m = await socio();
      const cookie = await portalDe(m.id);
      expect((await cambiar(cookie, { phoneE164: otro.phone, confirm: m.phone, responsible: { kind: 'ADULT' } })).statusCode).toBe(422);
      const r = await cambiar(cookie, { phoneE164: otro.phone, confirm: m.phone, responsible: { kind: 'ADULT', name: 'Jorge Paz Ruiz' } });
      expect(r.statusCode, r.body).toBe(200);
      expect(await ficha(m.id)).toMatchObject({ responsibleKind: 'ADULT', responsibleName: 'Jorge Paz Ruiz', responsiblePhoneE164: null });
    });

    it('mismo celular y mismo nombre sigue siendo duplicado: no se guarda ni diciendo quién responde', async () => {
      const a = await socio({ firstName: 'Carolina', lastName: 'Vegaprueba Ruiz' });
      const b = await socio({ firstName: 'Carolina', lastName: 'Vegaprueba Ruiz' });
      const cookie = await portalDe(b.id);
      const aFicha = await ficha(a.id);
      for (const responsible of [undefined, { kind: 'SELF' }, { kind: 'HOLDER' }]) {
        const r = await cambiar(cookie, { phoneE164: a.phone, confirm: b.phone, ...(responsible ? { responsible } : {}) });
        expect(r.statusCode, r.body).toBe(409);
        expect(r.json()).toMatchObject({ reason: 'CONTACT_CHANGE_NOT_ALLOWED' });
        expect(r.json().message).toMatch(/recepción/);
        expect(r.body).not.toContain(aFicha.memberCode);
      }
      expect((await ficha(b.id)).phoneE164).toBe(b.phone);
    });

    it('el celular de alguien dado de baja no es de nadie: se guarda sin preguntar', async () => {
      const exsocio = await socio();
      await db().member.update({ where: { id: exsocio.id }, data: { status: 'ARCHIVED', deletedAt: new Date() } });
      const m = await socio();
      const r = await cambiar(await portalDe(m.id), { phoneE164: exsocio.phone, confirm: m.phone });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ sharedPhone: false, responsibleKind: null });
    });

    it('preguntar número por número si es de un socio se frena igual que fallar la confirmación, y un rechazo no gasta el tope de cambios', async () => {
      const otro = await socio();
      const m = await socio();
      const cookie = await portalDe(m.id);
      for (let i = 0; i < CONTACT_CONFIRM_MAX_FAILURES; i++) expect((await cambiar(cookie, { phoneE164: otro.phone, confirm: m.phone })).statusCode).toBe(409);
      // El siguiente intento ya no contesta si el número es de alguien.
      const r = await cambiar(cookie, { phoneE164: otro.phone, confirm: m.phone });
      expect(r.statusCode, r.body).toBe(429);
      expect((await cambiar(cookie, { phoneE164: telefonoUnico(), confirm: m.phone })).statusCode).toBe(429);
      // Un rechazo no es un cambio: su tope sigue entero.
      expect((await contacto(cookie)).limits.phone.left).toBe(CONTACT_CHANGE_LIMITS.PHONE);
    });
  });

  // ── El responsable del número cuando el celular cambia ────────────────────

  describe('el responsable del número', () => {
    it('la mamá cambia de celular: ella deja de responder por el viejo y a la hija le vuelve a faltar responsable', async () => {
      const numero = telefonoUnico();
      const mama = await socio({ firstName: 'Mariana', lastName: 'Marprueba', phoneE164: numero, responsibleKind: 'SELF' });
      const hija = await socio({ firstName: 'Renata', lastName: 'Marprueba', phoneE164: numero, responsibleKind: 'MEMBER', responsibleMemberId: mama.id });
      const hermano = await socio({ firstName: 'Emilio', lastName: 'Marprueba', phoneE164: numero, responsibleKind: 'MEMBER', responsibleMemberId: mama.id });
      const nuevo = telefonoUnico();
      const r = await cambiar(await portalDe(mama.id), { phoneE164: nuevo, confirm: numero });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ sharedPhone: false, responsibleKind: null });
      expect(await ficha(mama.id)).toMatchObject({ phoneE164: nuevo, responsibleKind: null });
      // Los hijos conservan SU número y dejan de tener anotada a alguien que ya no lo tiene.
      for (const h of [hija, hermano]) expect(await ficha(h.id)).toMatchObject({ phoneE164: numero, responsibleKind: null, responsibleMemberId: null });
      expect(((await get(`/members/${hija.id}/shared-phone`, gerente)).json() as MemberSharedPhone)).toMatchObject({ missingResponsible: true, responsible: null });
      expect((await asientos(mama.id, 'member.contact.self_update'))[0]!.afterState).toMatchObject({ dejaronDeTenerloDeResponsable: 2 });
    });

    it('la hija estrena número propio: deja de tener responsable y la mamá sigue igual', async () => {
      const numero = telefonoUnico();
      const mama = await socio({ phoneE164: numero, responsibleKind: 'SELF' });
      const hija = await socio({ phoneE164: numero, responsibleKind: 'MEMBER', responsibleMemberId: mama.id });
      expect((await cambiar(await portalDe(hija.id), { phoneE164: telefonoUnico(), confirm: numero })).statusCode).toBe(200);
      expect(await ficha(hija.id)).toMatchObject({ responsibleKind: null, responsibleMemberId: null });
      expect(await ficha(mama.id)).toMatchObject({ phoneE164: numero, responsibleKind: 'SELF' });
    });

    it('el tutor de un menor (D-10) no se pierde por cambiar de celular, ni se pregunta otra vez', async () => {
      const firmado = new Date('2026-11-20T18:00:00.000Z');
      const menor = await socio({ responsibleKind: 'ADULT', responsibleName: 'Laura Reyprueba', guardianSignedAt: firmado });
      const cookie = await portalDe(menor.id);
      expect((await cambiar(cookie, { phoneE164: telefonoUnico(), confirm: menor.phone })).statusCode).toBe(200);
      expect(await ficha(menor.id)).toMatchObject({ responsibleKind: 'ADULT', responsibleName: 'Laura Reyprueba', guardianSignedAt: firmado });
      // A un número compartido: su tutor ya es el responsable.
      const otro = await socio();
      const actual = (await ficha(menor.id)).phoneE164!;
      const r = await cambiar(cookie, { phoneE164: otro.phone, confirm: actual });
      expect(r.statusCode, r.body).toBe(200);
      expect(await ficha(menor.id)).toMatchObject({ phoneE164: otro.phone, responsibleKind: 'ADULT', responsibleName: 'Laura Reyprueba', guardianSignedAt: firmado });
    });
  });

  // ── Mensajes pendientes de la bandeja de salida ───────────────────────────

  describe('mensajes pendientes', () => {
    it('el mensaje que estaba por mandarse sale al número nuevo y ya no saluda al responsable del número viejo', async () => {
      const numero = telefonoUnico();
      const mama = await socio({ firstName: 'Mariana', lastName: 'Valleprueba', phoneE164: numero, responsibleKind: 'SELF' });
      const hija = await socio({ firstName: 'Renata', lastName: 'Valleprueba', phoneE164: numero, responsibleKind: 'MEMBER', responsibleMemberId: mama.id });
      await db().charge.create({
        data: {
          id: uuidv7(), organizationId: g.organizationId, memberId: hija.id, branchId: centro.id, chargeType: 'MANUAL_ADJUSTMENT', status: 'OVERDUE',
          concept: 'Mensualidad', subtotalCents: 60_000n, taxCents: 0n, discountCents: 0n, amountCents: 60_000n, dueDate: new Date(Date.now() - 2 * MS_DIA), issuedAt: new Date(),
        },
      });
      await new OutboundService().generar(g.organizationId);
      const lista = async () => ((await get('/outbound/messages?limit=500', gerente)).json() as OutboundMessages).pending.find((x) => x.memberId === hija.id)!;
      const antes = await lista();
      expect(antes).toMatchObject({ phoneE164: numero, recipientName: 'Mariana Valleprueba' });

      const nuevo = telefonoUnico();
      expect((await cambiar(await portalDe(hija.id), { phoneE164: nuevo, confirm: numero })).statusCode).toBe(200);
      const despues = await lista();
      // El MISMO mensaje pendiente (no se duplica ni se pierde), ahora al número nuevo y a ella.
      expect(despues.id).toBe(antes.id);
      expect(despues).toMatchObject({ phoneE164: nuevo, recipientName: null });
      expect(despues.text).toMatch(/^Hola Renata, /);
    });
  });

  // ── Que no sirva para quedarse con lo de otro ─────────────────────────────

  describe('ni el portal ni el pase de prueba de otra persona', () => {
    it('poner el celular de otro socio no abre su portal, no le cierra el suyo ni le manda nada', async () => {
      const victima = await socio();
      const deVictima = await portalDe(victima.id);
      const m = await socio();
      const cookie = await portalDe(m.id);
      const invitaciones = await db().portalInvite.count({ where: { memberId: victima.id } });
      expect((await cambiar(cookie, { phoneE164: victima.phone, confirm: m.phone, responsible: { kind: 'SELF' } })).statusCode).toBe(200);

      // Su sesión sigue siendo la suya: el portal se activa con un código por socio, no con el celular.
      const yo = (await get('/portal/me', cookie)).json() as PortalMe;
      expect(yo.memberId).toBe(m.id);
      expect(((await get('/portal/me', deVictima)).json() as PortalMe).memberId).toBe(victima.id);
      expect(await db().portalInvite.count({ where: { memberId: victima.id } })).toBe(invitaciones);
      expect((await get('/portal/sessions', deVictima)).json()).toMatchObject({ active: 1 });
      // A la otra persona no le nace ningún aviso ni se le cambia ningún dato de contacto.
      expect((await avisos(deVictima)).filter((n) => n.kind === 'CONTACT_CHANGED')).toEqual([]);
      expect(await contacto(deVictima)).toMatchObject({ phoneMasked: `•• •••• ${ultimos(victima.phone)}`, sharedPhone: true, responsibleKind: null });
      expect(await filas(victima.id)).toEqual([]);
    });

    it('el pase de prueba es uno por ficha y uno por celular: cambiar de número no estrena otro ni hereda el de nadie', async () => {
      const pase = (id: string) => get(`/members/${id}/trial-pass`, gerente);
      const dar = (id: string) => app.inject({ method: 'POST', url: `/members/${id}/trial-pass`, headers: { cookie: gerente }, payload: { branchId: centro.id } });
      const previa = async (id: string) => (await app.inject({ method: 'POST', url: '/access/attempts/preview', headers: { cookie: gerente }, payload: { branchId: centro.id, memberId: id } })).json() as { outcome: string; reason: string | null };

      // A ya usó su pase con su número viejo. Cambia de número: sigue sin poder estrenar otro.
      const a = await socio();
      expect((await dar(a.id)).statusCode).toBe(201);
      const nuevoDeA = telefonoUnico();
      expect((await cambiar(await portalDe(a.id), { phoneE164: nuevoDeA, confirm: a.phone })).statusCode).toBe(200);
      expect((await pase(a.id)).json()).toMatchObject({ eligible: false, blockedBy: 'TRIAL_PASS_ALREADY_USED' });
      expect((await dar(a.id)).json()).toMatchObject({ created: false }); // el mismo de hoy, no uno nuevo
      expect(await db().trialPass.count({ where: { memberId: a.id } })).toBe(1);

      // C nunca ha tenido pase. Toma el número viejo de A (libre): ese celular ya usó el suyo.
      const c = await socio();
      expect((await pase(c.id)).json()).toMatchObject({ eligible: true });
      expect((await cambiar(await portalDe(c.id), { phoneE164: a.phone, confirm: c.phone })).statusCode).toBe(200);
      expect((await pase(c.id)).json()).toMatchObject({ eligible: false, blockedBy: 'TRIAL_PASS_ALREADY_USED' });
      expect((await dar(c.id)).statusCode).toBe(409);

      // B tiene un pase de prueba que vale HOY. D se pone el celular de B: la puerta no le abre con el pase de B.
      const b = await socio();
      expect((await dar(b.id)).statusCode).toBe(201);
      expect(await previa(b.id)).toMatchObject({ outcome: 'GRANTED' });
      const d = await socio();
      expect((await cambiar(await portalDe(d.id), { phoneE164: b.phone, confirm: d.phone, responsible: { kind: 'SELF' } })).statusCode).toBe(200);
      expect(await previa(d.id)).toMatchObject({ outcome: 'DENIED', reason: 'NO_MEMBERSHIP' });
      expect((await get('/portal/me', await portalDe(d.id))).json()).toMatchObject({ canEnter: false, trialPass: null });
      // Y tampoco puede pedir uno «suyo» con ese número: ya se usó.
      expect((await dar(d.id)).statusCode).toBe(409);
      // El de B sigue siendo de B.
      expect(await previa(b.id)).toMatchObject({ outcome: 'GRANTED' });
    });
  });

  // ── El aviso al mostrador ─────────────────────────────────────────────────

  describe('el mostrador se entera', () => {
    it('recepción lo ve en su Inicio y en la ficha, con el antes y el después, y lo confirma con el socio', async () => {
      const m = await socio({ firstName: 'Fernanda', lastName: 'Avisoprueba' });
      const cookie = await portalDe(m.id);
      const base = (await inicio(recepcion))?.count ?? 0;
      const nuevo = telefonoUnico();
      expect((await cambiar(cookie, { phoneE164: nuevo, email: 'fernanda@correo.invalid', confirm: m.phone })).statusCode).toBe(200);

      // Un socio, un pendiente (aunque cambió dos datos).
      const renglon = await inicio(recepcion);
      expect(renglon).toMatchObject({ count: base + 1, tone: expect.stringMatching(/info|warn/) });
      // La gerencia también lo ve.
      expect((await inicio(gerente))!.count).toBeGreaterThanOrEqual(1);

      const r = await get(`/members/${m.id}/contact-changes`, recepcion);
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(MemberContactChanges, r.json())).toEqual([]);
      const lista = r.json() as MemberContactChanges;
      expect(lista).toMatchObject({ hidden: false, pending: 2 });
      expect(lista.changes.map((c) => [c.field, c.oldValue, c.newValue, c.reviewedAt]).sort()).toEqual([['EMAIL', null, 'fernanda@correo.invalid', null], ['PHONE', m.phone, nuevo, null]]);

      // «Ya lo confirmé con el socio».
      const ok = await app.inject({ method: 'POST', url: `/members/${m.id}/contact-changes/review`, headers: { cookie: recepcion }, payload: {} });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toEqual({ reviewed: 2 });
      expect((await inicio(recepcion))?.count ?? 0).toBe(base);
      const despues = (await get(`/members/${m.id}/contact-changes`, recepcion)).json() as MemberContactChanges;
      expect(despues.pending).toBe(0);
      expect(despues.changes.every((c) => c.reviewedAt !== null && c.reviewedByName !== null)).toBe(true);
      const [asiento] = await asientos(m.id, 'member.contact.review');
      expect(asiento).toMatchObject({ actorType: 'USER', afterState: { reviewed: 2 } });
      // Repetirlo no hace nada ni asienta otra vez.
      expect((await app.inject({ method: 'POST', url: `/members/${m.id}/contact-changes/review`, headers: { cookie: recepcion }, payload: {} })).json()).toEqual({ reviewed: 0 });
      expect(await asientos(m.id, 'member.contact.review')).toHaveLength(1);
    });

    it('el renglón del Inicio trae los nombres, los más antiguos primero, y se pone ámbar si alguien pasó a compartir celular', async () => {
      // Se confirma todo lo anterior de este gimnasio para contar desde cero.
      await db().memberContactChange.updateMany({ where: { organizationId: g.organizationId, reviewedAt: null }, data: { reviewedAt: new Date() } });
      expect(await inicio(recepcion)).toBeNull();
      const uno = await socio({ firstName: 'Primera', lastName: 'Ordenprueba' });
      const dos = await socio({ firstName: 'Segunda', lastName: 'Ordenprueba' });
      expect((await cambiar(await portalDe(uno.id), { phoneE164: telefonoUnico(), confirm: uno.phone })).statusCode).toBe(200);
      expect(await inicio(recepcion)).toMatchObject({ count: 1, tone: 'info', detail: ['Primera Ordenprueba'] });
      const otro = await socio();
      expect((await cambiar(await portalDe(dos.id), { phoneE164: otro.phone, confirm: dos.phone, responsible: { kind: 'SELF' } })).statusCode).toBe(200);
      // El orden lo fija la consulta (el más antiguo primero), no la base.
      await db().memberContactChange.updateMany({ where: { memberId: uno.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
      expect(await inicio(recepcion)).toMatchObject({ count: 2, tone: 'warn', detail: ['Primera Ordenprueba', 'Segunda Ordenprueba'] });
      // Un socio dado de baja ya no es pendiente de nadie.
      await db().member.update({ where: { id: uno.id }, data: { status: 'ARCHIVED', deletedAt: new Date() } });
      expect(await inicio(recepcion)).toMatchObject({ count: 1, detail: ['Segunda Ordenprueba'] });
    });

    it('recepción solo de su sede; quien no da acceso al portal no lo ve', async () => {
      const deNorte = await socio({}, norte);
      expect((await cambiar(await portalDe(deNorte.id), { phoneE164: telefonoUnico(), confirm: deNorte.phone })).statusCode).toBe(200);
      // Recepción es de Centro.
      expect((await get(`/members/${deNorte.id}/contact-changes`, recepcion)).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/members/${deNorte.id}/contact-changes/review`, headers: { cookie: recepcion }, payload: {} })).statusCode).toBe(403);
      expect((await get(`/members/${deNorte.id}/contact-changes`, gerente)).statusCode).toBe(200);
      // La dueña no ve fichas: tampoco esto, ni el renglón en su Inicio.
      const duena = await loginAs(app, g.correos.owner);
      expect((await get(`/members/${deNorte.id}/contact-changes`, duena)).statusCode).toBe(403);
      expect(await inicio(duena)).toBeNull();
      // El renglón de recepción no cuenta a los socios de Norte.
      const enCentro = (await inicio(recepcion))?.count ?? 0;
      const enTodo = (await inicio(gerente))?.count ?? 0;
      expect(enTodo).toBeGreaterThan(enCentro);
    });
  });

  // ── Privacidad ────────────────────────────────────────────────────────────

  describe('al anonimizar', () => {
    it('los celulares y correos de su historial se vacían en el mismo acto; queda que hubo un cambio', async () => {
      const m = await socio({ email: 'se.va@correo.invalid' });
      const cookie = await portalDe(m.id);
      expect((await cambiar(cookie, { phoneE164: telefonoUnico(), email: 'se.fue@correo.invalid', emergencyContactName: 'Rosa Luna', confirm: m.phone })).statusCode).toBe(200);
      expect((await filas(m.id)).every((f) => f.forgottenAt === null)).toBe(true);
      await db().member.update({ where: { id: m.id }, data: { status: 'ARCHIVED', deletedAt: new Date() } });
      expect(await new MemberRepository(g.organizationId).anonymize(m.id)).toBe(true);
      const f = await filas(m.id);
      expect(f.map((x) => x.field).sort()).toEqual(['EMAIL', 'EMERGENCY_NAME', 'PHONE']);
      expect(f.every((x) => x.oldValue === null && x.newValue === null && x.forgottenAt !== null)).toBe(true);
    });
  });
});
