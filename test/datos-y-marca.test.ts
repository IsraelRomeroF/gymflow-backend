import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auditLabel } from '@gymflow/core';
import { GymProfile, PlatformBrand } from '@gymflow/core/contracts';
import { makeApp, loginAs, loginPlataforma } from './helpers.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { registeredRoutes } from '../src/platform/http/registry.js';
import { DATOS_DE_PLATAFORMA } from '../src/modules/organization/organization.routes.js';
import { LOGO_MAX_BYTES, logoValido, rfcValido, valorLimpio } from '../src/modules/tenants/ficha-de-marca.service.js';

/**
 * DATOS Y MARCA DEL GIMNASIO (D-27, opción d · auditoría 8, fase 4, bloque 4.6).
 *
 * Nada se cambia desde el panel: razón social, RFC, nombre comercial, logo,
 * teléfonos, horarios y leyenda del recibo los administra la plataforma. El
 * gimnasio PIDE el cambio (dueña o gerencia), la consola lo aplica o lo
 * rechaza con respuesta y quien lo pidió ve el resultado.
 *
 * Cada corrida usa dos gimnasios propios (datos inventados): no toca el Demo.
 */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const UUID_INEXISTENTE = '01890000-0000-7000-8000-000000000000';

describe('reglas de cada dato (las mismas al pedir y al aplicar)', () => {
  it('RFC: 12 o 13 caracteres, en mayúsculas y sin separadores', () => {
    expect(rfcValido(' abc-010203-xy1 ')).toBe('ABC010203XY1');
    expect(rfcValido('XAXX010101000')).toBe('XAXX010101000');
    expect(() => rfcValido('ABC0102')).toThrow(/RFC no válido/);
    expect(() => rfcValido('1BC010203XY1')).toThrow(/RFC no válido/);
  });

  it('logo: solo una imagen PNG, JPG o WebP de verdad y de hasta 200 KB', () => {
    expect(logoValido(PNG)).toBe(PNG);
    // Un SVG (puede llevar código) no pasa, ni un HTML que dice ser PNG.
    expect(() => logoValido(`data:image/svg+xml;base64,${Buffer.from('<svg onload="x()"/>').toString('base64')}`)).toThrow(/PNG, JPG o WebP/);
    expect(() => logoValido(`data:image/png;base64,${Buffer.from('<html><script>x()</script></html>').toString('base64')}`)).toThrow(/no es la imagen/);
    expect(() => logoValido('https://ejemplo.mx/logo.png')).toThrow(/PNG, JPG o WebP/);
    const grande = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(LOGO_MAX_BYTES)]);
    expect(() => logoValido(`data:image/png;base64,${grande.toString('base64')}`)).toThrow(/200 KB/);
  });

  it('teléfonos a E.164; vacío quita el dato; los nombres no se pueden quitar', () => {
    expect(valorLimpio('PHONE', '55 1234 5678')).toBe('+525512345678');
    expect(valorLimpio('BRANCH_PHONE', '+52 (55) 1234-5678')).toBe('+525512345678');
    expect(() => valorLimpio('WHATSAPP', '12345')).toThrow(/Teléfono no válido/);
    expect(valorLimpio('PHONE', '  ')).toBeNull();
    expect(valorLimpio('RECEIPT_LEGEND', null)).toBeNull();
    expect(() => valorLimpio('TRADE_NAME', '')).toThrow(/valor nuevo/);
    expect(() => valorLimpio('LEGAL_NAME', 'ab')).toThrow(/razón social/);
    expect(() => valorLimpio('RECEIPT_LEGEND', 'x'.repeat(301))).toThrow(/300/);
    expect(() => valorLimpio('OTHER', '')).toThrow(/qué quieres/);
  });
});

describe('datos y marca del gimnasio (D-27)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let otro: GimnasioPropio;
  let plataforma: string;
  let duena: string;
  let gerente: string;
  let recepcion: string;
  let gerenteAjeno: string;

  const pedir = (cookie: string | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, ...(cookie ? { headers: { cookie } } : {}), ...(payload === undefined ? {} : { payload: payload as object }) });
  const marcaEnBase = () => getDb().organization.findUniqueOrThrow({
    where: { id: g.organizationId }, select: { legalName: true, tradeName: true, rfc: true, logo: true, phone: true, whatsapp: true, receiptLegend: true },
  });
  const sedesEnBase = async () => (await getDb().branch.findMany({ where: { organizationId: g.organizationId }, select: { id: true, phone: true, openingHours: true } }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const asientos = async (action: string) => getDb().auditLog.findMany({ where: { organizationId: g.organizationId, action }, select: { reason: true, afterState: true, actorUserId: true } });
  /** Manda una solicitud y la devuelve creada. */
  const solicitar = async (cookie: string, cuerpo: Record<string, unknown>) => {
    const r = await pedir(cookie, 'POST', '/gym-change-requests', cuerpo);
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; status: string; proposedValue: string | null; proposedLogo: string | null; mine: boolean };
  };
  const misSolicitudes = async (cookie: string) => (await pedir(cookie, 'GET', '/gym-change-requests')).json() as {
    unseen: number; requests: Array<{ id: string; status: string; response: string | null; appliedValue: string | null; mine: boolean; seen: boolean; field: string }>;
  };

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Matriz de marca', cajas: 1 }, { name: 'Norte de marca', cajas: 1 }] });
    otro = await gimnasioPropio();
    plataforma = await loginPlataforma(app);
    duena = await loginAs(app, g.correos.owner);
    gerente = await loginAs(app, g.correos.gerente);
    recepcion = await loginAs(app, g.correos.recepcion);
    gerenteAjeno = await loginAs(app, otro.correos.gerente);
  }, 60_000);

  afterAll(async () => {
    await g.cerrar();
    await otro.cerrar();
    await app.close();
    await closeDb();
  });

  // ── El panel no cambia nada ────────────────────────────────────────────────

  it('NINGUNA ruta de escritura del panel cambia un dato de D-27: se recorre el registro entero con esos datos en el cuerpo', async () => {
    const antes = { marca: await marcaEnBase(), sedes: await sedesEnBase() };
    const veneno = {
      legalName: 'Otra Razón Social S.A. de C.V.', tradeName: 'Otro Nombre', rfc: 'ABC010203XY1', logo: PNG, phone: '5511112222', whatsapp: '5533334444',
      receiptLegend: 'Leyenda puesta desde el panel', openingHours: 'Siempre abierto', hours: 'Siempre abierto',
      organization: { legalName: 'Otra Razón Social S.A. de C.V.', rfc: 'ABC010203XY1' }, brand: { rfc: 'ABC010203XY1', logo: PNG },
      reason: 'Prueba de D-27', name: 'Matriz de marca',
    };
    // Lo que escribe el personal del gimnasio (sesión o permiso). Las de cuenta propia cerrarían la sesión con la que se recorre.
    const escrituras = registeredRoutes().filter((r) => (r.security.kind === 'session' || r.security.kind === 'permission') && r.method !== 'GET' && r.method !== 'HEAD'
      && !r.url.startsWith('/auth') && !/logout|password|sessions/.test(r.url));
    expect(escrituras.length).toBeGreaterThan(100);
    const sede = g.sedes[0]!.id;
    let atendidas = 0;
    for (const cookie of [gerente, duena]) {
      for (const r of escrituras) {
        const url = r.url.replace(/:\w+/g, (p) => (p === ':key' ? 'classes' : (p === ':id' && r.url.startsWith('/branches')) || p === ':branchId' ? sede : UUID_INEXISTENTE));
        const res = await pedir(cookie, r.method as 'POST', url, r.method === 'DELETE' ? undefined : veneno);
        expect(res.statusCode, `${r.method} ${r.url}: ${res.body.slice(0, 200)}`).toBeLessThan(500);
        atendidas++;
      }
    }
    expect(atendidas).toBe(escrituras.length * 2);
    expect({ marca: await marcaEnBase(), sedes: await sedesEnBase() }).toEqual(antes);
    // Y por el camino no nació ninguna solicitud «aplicada» ni ningún asiento de cambio de marca.
    expect(await getDb().gymChangeRequest.count({ where: { organizationId: g.organizationId, status: { not: 'PENDING' } } })).toBe(0);
    expect((await asientos('platform.brand.update')).length).toBe(0);
  }, 120_000);

  it('las escrituras del panel sobre el gimnasio y sus sucursales son exactamente estas (una nueva obliga a mirar D-27)', () => {
    const delGimnasio = registeredRoutes()
      .filter((r) => (r.security.kind === 'session' || r.security.kind === 'permission') && r.method !== 'GET' && /^\/(organization|branches|gym-change-requests)(\/|$)/.test(r.url))
      .map((r) => `${r.method} ${r.url}`).sort();
    expect(delGimnasio).toEqual([
      'PATCH /branches/:id',
      'POST /branches',
      'POST /gym-change-requests',
      'POST /gym-change-requests/seen',
      'PUT /organization/modules/:key',
      'PUT /organization/modules/:key/branches/:branchId',
      'PUT /organization/setup/front-desk',
    ]);
  });

  it('editar una sucursal con un dato de D-27 se rechaza con 403 y su porqué; sin él, la gerencia sigue editando lo de siempre', async () => {
    const sede = g.sedes[1]!.id;
    for (const dato of DATOS_DE_PLATAFORMA) {
      const r = await pedir(gerente, 'PATCH', `/branches/${sede}`, { [dato]: 'x' });
      expect(r.statusCode, `${dato}: ${r.body}`).toBe(403);
      expect(r.json().reason).toBe('MANAGED_BY_PLATFORM');
      expect(r.json().message).toMatch(/lo administra GymFlow.*Pedir un cambio a GymFlow/);
      // La dueña consulta (D-25): a ella la detiene antes el permiso de la ruta.
      expect((await pedir(duena, 'PATCH', `/branches/${sede}`, { [dato]: 'x' })).statusCode).toBe(403);
    }
    const alta = await pedir(gerente, 'POST', '/branches', { code: 'ZZZ1', name: 'Con teléfono', phone: '5512345678' });
    expect(alta.statusCode).toBe(403);
    expect(alta.json().reason).toBe('MANAGED_BY_PLATFORM');
    // D-27 no se amplía: nombre, dirección, zona y enlace del alta siguen siendo de la gerencia.
    const ok = await pedir(gerente, 'PATCH', `/branches/${sede}`, { addressLine: 'Av. Inventada 123' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ addressLine: 'Av. Inventada 123', phone: null, openingHours: null });
  });

  it('no existe una ruta del panel para editar los datos del gimnasio: 404', async () => {
    for (const [metodo, url] of [['PUT', '/organization'], ['PATCH', '/organization'], ['PUT', '/organization/profile'], ['PATCH', '/organization/profile'], ['PUT', '/organization/logo'], ['PUT', '/organization/brand']] as const) {
      const r = await pedir(gerente, metodo, url, { tradeName: 'Otro Nombre', rfc: 'ABC010203XY1' });
      expect(r.statusCode, `${metodo} ${url}`).toBe(404);
    }
  });

  // ── Pedir un cambio ────────────────────────────────────────────────────────

  it('recepción no pide cambios (403) ni ve solicitudes; sin sesión, 401', async () => {
    const r = await pedir(recepcion, 'POST', '/gym-change-requests', { field: 'PHONE', value: '5512345678', reason: 'Cambió el número' });
    expect(r.statusCode).toBe(403);
    expect(await misSolicitudes(recepcion)).toEqual({ requests: [], unseen: 0 });
    expect((await pedir(recepcion, 'GET', '/organization/profile')).statusCode).toBe(403);
    expect((await pedir(null, 'GET', '/gym-change-requests')).statusCode).toBe(401);
    expect((await pedir(null, 'POST', '/gym-change-requests', {})).statusCode).toBe(401);
  });

  it('lo que no se podría guardar no se pide: valor inválido, sucursal ajena, el mismo valor, falta el motivo', async () => {
    const mal = async (cuerpo: Record<string, unknown>) => pedir(gerente, 'POST', '/gym-change-requests', cuerpo);
    expect((await mal({ field: 'PHONE', value: '123', reason: 'Cambió el número' })).statusCode).toBe(422);
    expect((await mal({ field: 'RFC', value: 'no-es-rfc', reason: 'Alta en el SAT' })).statusCode).toBe(422);
    expect((await mal({ field: 'PHONE', value: '5512345678' })).statusCode).toBe(422);
    expect((await mal({ field: 'BRANCH_HOURS', value: 'Lunes a viernes de 6 a 22', reason: 'Nuevo horario' })).statusCode).toBe(422);
    expect((await mal({ field: 'BRANCH_HOURS', branchId: otro.sedes[0]!.id, value: 'Lunes a viernes de 6 a 22', reason: 'Nuevo horario' })).statusCode).toBe(404);
    expect((await mal({ field: 'LOGO', value: 'data:image/svg+xml;base64,PHN2Zy8+', reason: 'Logo nuevo' })).statusCode).toBe(422);
    expect((await mal({ field: 'PHONE', value: '', reason: 'Quitar el teléfono' })).statusCode).toBe(422); // ya está vacío
    const mismo = await mal({ field: 'TRADE_NAME', value: (await marcaEnBase()).tradeName, reason: 'Sin cambio' });
    expect(mismo.statusCode).toBe(422);
    expect(mismo.json().message).toMatch(/ya es el valor registrado/);
    expect(await getDb().gymChangeRequest.count({ where: { organizationId: g.organizationId } })).toBe(0);
  });

  it('de punta a punta: la gerencia pide, la consola la ve pendiente, la aplica, y quien la pidió ve el resultado', async () => {
    const antes = await marcaEnBase();
    const s = await solicitar(gerente, { field: 'PHONE', value: '55 1234 5678', reason: 'Estrenamos línea' });
    expect(s).toMatchObject({ status: 'PENDING', proposedValue: '+525512345678', mine: true });
    // Pedir NO cambia nada.
    expect(await marcaEnBase()).toEqual(antes);
    // Otra del mismo dato espera a que GymFlow conteste.
    const doble = await pedir(duena, 'POST', '/gym-change-requests', { field: 'PHONE', value: '5587654321', reason: 'Otro número' });
    expect(doble.statusCode).toBe(409);
    expect(doble.json().reason).toBe('CHANGE_REQUEST_PENDING');
    expect((await asientos('settings.change_request.create')).length).toBe(1);

    // La consola: en la lista de todas las marcas y en la ficha de esta.
    const lista = (await pedir(plataforma, 'GET', '/platform/change-requests')).json() as { pending: number; requests: Array<{ id: string; tradeName: string; currentValue: string | null; reason: string; requestedBy: { fullName: string } }> };
    expect(lista.pending).toBeGreaterThanOrEqual(1);
    expect(lista.requests.find((x) => x.id === s.id)).toMatchObject({ tradeName: antes.tradeName, currentValue: null, reason: 'Estrenamos línea' });
    const ficha = await pedir(plataforma, 'GET', `/platform/organizations/${g.organizationId}/brand`);
    expect(ficha.statusCode, ficha.body).toBe(200);
    expect(PlatformBrand.safeParse(ficha.json()).success).toBe(true);
    expect(ficha.json().requests[0]).toMatchObject({ id: s.id, status: 'PENDING' });
    expect(ficha.json().branches.map((b: { name: string }) => b.name).sort()).toEqual(['Matriz de marca', 'Norte de marca']);

    const aplicada = await pedir(plataforma, 'POST', `/platform/change-requests/${s.id}/apply`, { response: 'Listo, ya sale en tu recibo.' });
    expect(aplicada.statusCode, aplicada.body).toBe(200);
    expect(aplicada.json()).toMatchObject({ status: 'APPLIED', appliedValue: '+525512345678', response: 'Listo, ya sale en tu recibo.', currentValue: '+525512345678' });
    // Solo cambió ese dato.
    expect(await marcaEnBase()).toEqual({ ...antes, phone: '+525512345678' });
    // No se aplica dos veces, ni se rechaza lo ya aplicado.
    const otraVez = await pedir(plataforma, 'POST', `/platform/change-requests/${s.id}/apply`, {});
    expect(otraVez.statusCode).toBe(409);
    expect(otraVez.json().reason).toBe('CHANGE_REQUEST_CLOSED');
    expect((await pedir(plataforma, 'POST', `/platform/change-requests/${s.id}/reject`, { response: 'Ya no' })).statusCode).toBe(409);

    // Quien la pidió tiene su aviso; la dueña la ve en la lista pero el aviso no es suyo.
    const delGerente = await misSolicitudes(gerente);
    expect(delGerente.unseen).toBe(1);
    expect(delGerente.requests.find((x) => x.id === s.id)).toMatchObject({ status: 'APPLIED', response: 'Listo, ya sale en tu recibo.', mine: true, seen: false });
    const deLaDuena = await misSolicitudes(duena);
    expect(deLaDuena.unseen).toBe(0);
    expect(deLaDuena.requests.find((x) => x.id === s.id)).toMatchObject({ status: 'APPLIED', mine: false });
    // Que la dueña mire no apaga el aviso del gerente; que lo mire él, sí.
    expect((await pedir(duena, 'POST', '/gym-change-requests/seen')).json()).toEqual({ seen: 0 });
    expect((await pedir(gerente, 'POST', '/gym-change-requests/seen')).json()).toEqual({ seen: 1 });
    expect((await misSolicitudes(gerente)).unseen).toBe(0);

    // El panel lo muestra (solo lectura) y el recibo lo recibe.
    const perfil = await pedir(gerente, 'GET', '/organization/profile');
    expect(GymProfile.safeParse(perfil.json()).success).toBe(true);
    expect(perfil.json().brand.phone).toBe('+525512345678');
    expect((await pedir(recepcion, 'GET', '/organization')).json()).toMatchObject({ phone: '+525512345678', hasLogo: false });

    // Bitácora de la marca y su espejo en la cadena de plataforma.
    const [asiento] = await asientos('platform.change_request.apply');
    expect(asiento!.reason).toMatch(/^Lo pidió .+: Estrenamos línea$/);
    expect(asiento!.afterState).toMatchObject({ field: 'PHONE', value: '+525512345678', response: 'Listo, ya sale en tu recibo.' });
    expect(await getDb().platformAuditLog.count({ where: { organizationId: g.organizationId, action: 'platform.change_request.apply' } })).toBe(1);
    const enConsola = (await pedir(plataforma, 'GET', `/platform/organizations/${g.organizationId}/audit`)).json() as { entries: Array<{ action: string; phrase: string }> };
    expect(enConsola.entries.find((e) => e.action === 'platform.change_request.apply')?.phrase).toBe(auditLabel('platform.change_request.apply'));
  });

  it('rechazar pide respuesta, no cambia nada, y la dueña que la pidió lee por qué', async () => {
    const antes = await marcaEnBase();
    const s = await solicitar(duena, { field: 'RFC', value: 'abc 010203 xy1', reason: 'Para mis facturas' });
    expect(s.proposedValue).toBe('ABC010203XY1');
    expect((await pedir(plataforma, 'POST', `/platform/change-requests/${s.id}/reject`, {})).statusCode).toBe(422);
    const r = await pedir(plataforma, 'POST', `/platform/change-requests/${s.id}/reject`, { response: 'El RFC no coincide con tu constancia: mándanos la vigente.' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: 'REJECTED', appliedValue: null });
    expect(await marcaEnBase()).toEqual(antes);
    const suyas = await misSolicitudes(duena);
    expect(suyas.unseen).toBe(1);
    expect(suyas.requests.find((x) => x.id === s.id)).toMatchObject({ status: 'REJECTED', response: 'El RFC no coincide con tu constancia: mándanos la vigente.' });
    expect((await asientos('platform.change_request.reject')).length).toBe(1);
    // Rechazada, ya puede volver a pedir el mismo dato.
    const otra = await solicitar(duena, { field: 'RFC', value: 'XAXX010101000', reason: 'Con la constancia vigente' });
    expect((await pedir(plataforma, 'POST', `/platform/change-requests/${otra.id}/apply`, {})).json()).toMatchObject({ status: 'APPLIED', appliedValue: 'XAXX010101000' });
    expect((await marcaEnBase()).rfc).toBe('XAXX010101000');
  });

  it('horario de una sucursal: la consola puede ajustar lo pedido; solo cambia esa sucursal', async () => {
    const norte = g.sedes[1]!.id;
    const s = await solicitar(gerente, { field: 'BRANCH_HOURS', branchId: norte, value: 'L a V 6 a 22', reason: 'Abrimos más temprano' });
    const r = await pedir(plataforma, 'POST', `/platform/change-requests/${s.id}/apply`, { value: 'Lunes a viernes de 6:00 a 22:00', response: 'Lo escribimos completo.' });
    expect(r.json()).toMatchObject({ status: 'APPLIED', appliedValue: 'Lunes a viernes de 6:00 a 22:00', branchName: 'Norte de marca' });
    const sedes = await getDb().branch.findMany({ where: { organizationId: g.organizationId }, select: { id: true, openingHours: true } });
    expect(sedes.find((b) => b.id === norte)!.openingHours).toBe('Lunes a viernes de 6:00 a 22:00');
    expect(sedes.filter((b) => b.id !== norte).every((b) => b.openingHours === null)).toBe(true);
    const lista = (await pedir(gerente, 'GET', '/branches')).json() as Array<{ id: string; openingHours: string | null }>;
    expect(lista.find((b) => b.id === norte)!.openingHours).toBe('Lunes a viernes de 6:00 a 22:00');
  });

  it('logo: se pide con la imagen, se aplica y el recibo lo recibe; «otro dato» no se aplica solo', async () => {
    const s = await solicitar(duena, { field: 'LOGO', value: PNG, reason: 'Logo nuevo' });
    expect(s).toMatchObject({ proposedValue: null, proposedLogo: PNG });
    expect((await pedir(recepcion, 'GET', '/organization/logo')).json()).toEqual({ logo: null });
    expect((await pedir(plataforma, 'POST', `/platform/change-requests/${s.id}/apply`, {})).json()).toMatchObject({ status: 'APPLIED', appliedValue: null });
    expect((await marcaEnBase()).logo).toBe(PNG);
    expect((await pedir(recepcion, 'GET', '/organization/logo')).json()).toEqual({ logo: PNG });
    expect((await pedir(recepcion, 'GET', '/organization')).json().hasLogo).toBe(true);
    // En la bitácora no se copia la imagen.
    expect(JSON.stringify(await asientos('platform.change_request.apply'))).not.toContain('iVBOR');

    const antes = { marca: await marcaEnBase(), sedes: await sedesEnBase() };
    const otro = await solicitar(gerente, { field: 'OTHER', value: 'Cambiar el correo al que llega el estado de cuenta', reason: 'Cambió el contador' });
    expect((await pedir(plataforma, 'POST', `/platform/change-requests/${otro.id}/apply`, {})).statusCode).toBe(422);
    const r = await pedir(plataforma, 'POST', `/platform/change-requests/${otro.id}/apply`, { response: 'Cambiado en tu ficha.' });
    expect(r.json()).toMatchObject({ status: 'APPLIED', response: 'Cambiado en tu ficha.' });
    expect({ marca: await marcaEnBase(), sedes: await sedesEnBase() }).toEqual(antes);
  });

  // ── La consola edita la ficha ──────────────────────────────────────────────

  it('la plataforma edita la ficha de marca con motivo y queda en la bitácora; sin motivo o sin cambio, 422', async () => {
    const url = `/platform/organizations/${g.organizationId}/brand`;
    expect((await pedir(plataforma, 'PUT', url, { whatsapp: '5511223344' })).statusCode).toBe(422);
    expect((await pedir(plataforma, 'PUT', url, { whatsapp: '12', reason: 'Lo pidió por teléfono' })).statusCode).toBe(422);
    const r = await pedir(plataforma, 'PUT', url, { whatsapp: '55 1122 3344', receiptLegend: 'Gracias por entrenar con nosotros.', reason: 'Lo pidió por teléfono' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ whatsapp: '+525511223344', receiptLegend: 'Gracias por entrenar con nosotros.', rfc: 'XAXX010101000' });
    const [asiento] = await asientos('platform.brand.update');
    expect(asiento!.reason).toBe('Lo pidió por teléfono');
    expect(asiento!.afterState).toMatchObject({ whatsapp: '+525511223344', receiptLegend: 'Gracias por entrenar con nosotros.' });
    // Lo que no vino no se toca; mandar lo mismo no es un cambio.
    expect((await marcaEnBase()).phone).toBe('+525512345678');
    expect((await pedir(plataforma, 'PUT', url, { whatsapp: '5511223344', reason: 'Otra vez' })).statusCode).toBe(422);
    // Quitar un dato: vacío o null.
    expect((await pedir(plataforma, 'PUT', url, { receiptLegend: null, reason: 'Ya no la quiere' })).json().receiptLegend).toBeNull();

    const sede = g.sedes[0]!.id;
    const c = await pedir(plataforma, 'PUT', `/platform/organizations/${g.organizationId}/branches/${sede}/contact`, { phone: '5599887766', openingHours: 'Todos los días de 7:00 a 21:00', reason: 'Alta de la sucursal' });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().branches.find((b: { id: string }) => b.id === sede)).toMatchObject({ phone: '+525599887766', openingHours: 'Todos los días de 7:00 a 21:00' });
    // La sucursal de otra marca no existe para esta ficha.
    expect((await pedir(plataforma, 'PUT', `/platform/organizations/${g.organizationId}/branches/${otro.sedes[0]!.id}/contact`, { phone: '5599887766', reason: 'Prueba' })).statusCode).toBe(404);
    expect((await pedir(plataforma, 'GET', `/platform/organizations/${UUID_INEXISTENTE}/brand`)).statusCode).toBe(404);
  });

  // ── Cada quien lo suyo ─────────────────────────────────────────────────────

  it('otro gimnasio no ve estas solicitudes ni estos datos; el personal no entra a las rutas de la consola', async () => {
    expect(await misSolicitudes(gerenteAjeno)).toEqual({ requests: [], unseen: 0 });
    const perfilAjeno = (await pedir(gerenteAjeno, 'GET', '/organization/profile')).json();
    expect(perfilAjeno.brand).toMatchObject({ rfc: null, phone: null, whatsapp: null, logo: null, receiptLegend: null });
    const delOtro = await getDb().organization.findUniqueOrThrow({ where: { id: otro.organizationId }, select: { rfc: true, phone: true, logo: true } });
    expect(delOtro).toEqual({ rfc: null, phone: null, logo: null });
    const alguna = (await misSolicitudes(gerente)).requests[0]!.id;
    for (const cookie of [gerente, duena, null]) {
      const esperado = cookie ? 404 : 401;
      expect((await pedir(cookie, 'GET', '/platform/change-requests')).statusCode).toBe(esperado);
      expect((await pedir(cookie, 'GET', `/platform/organizations/${g.organizationId}/brand`)).statusCode).toBe(esperado);
      expect((await pedir(cookie, 'PUT', `/platform/organizations/${g.organizationId}/brand`, { rfc: 'ABC010203XY1', reason: 'Yo mismo' })).statusCode).toBe(esperado);
      expect((await pedir(cookie, 'POST', `/platform/change-requests/${alguna}/apply`, {})).statusCode).toBe(esperado);
      expect((await pedir(cookie, 'POST', `/platform/change-requests/${alguna}/reject`, { response: 'No' })).statusCode).toBe(esperado);
    }
    expect((await marcaEnBase()).rfc).toBe('XAXX010101000');
  });

  it('una solicitud no se borra: el rol de la aplicación no puede', async () => {
    await expect(getDb().gymChangeRequest.deleteMany({ where: { organizationId: g.organizationId } })).rejects.toThrow();
    expect(await getDb().gymChangeRequest.count({ where: { organizationId: g.organizationId } })).toBeGreaterThan(0);
  });
});
