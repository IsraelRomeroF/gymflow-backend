import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MODULES, MODULE_BY_KEY, effectiveModules, moduleOfPermission, type ModuleKey } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, CONSENTIMIENTOS } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { registeredRoutes } from '../src/platform/http/registry.js';
import { forgetModules } from '../src/platform/modules/module-state.js';
import { ModuleStateRepository } from '../src/platform/modules/module-state.repository.js';
import { allJobs, armarPlanes, esDePlataforma, runsFor, type PlannedGymJob } from '../src/platform/jobs/plan.js';
import { BACKEND_MODULES } from '../src/modules.js';

/**
 * MÓDULOS POR GIMNASIO (ADR-036).
 *
 * Los cambios de estado se hacen en "Otro Gimnasio" y se deshacen al final:
 * la organización de demostración la comparten las demás pruebas.
 */
const opcionales = MODULES.filter((m) => m.kind === 'optional').map((m) => m.key as ModuleKey);
const UUID = '01999999-9999-7999-8999-999999999999';
const conParametros = (url: string) => url.replace(/:[a-zA-Z]+/g, UUID);

describe('toda ruta y todo trabajo pertenecen a un módulo', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); await app.ready(); });
  afterAll(async () => { await app.close(); });

  it('cada ruta dice su módulo de producto y la carpeta que la registró', () => {
    expect(registeredRoutes().length).toBeGreaterThan(150);
    for (const r of registeredRoutes()) {
      expect(MODULE_BY_KEY.has(r.module), `${r.method} ${r.url} → ${r.module}`).toBe(true);
      expect(BACKEND_MODULES.some((m) => m.name === r.source), `${r.method} ${r.url} ← ${r.source}`).toBe(true);
    }
  });

  it('cada módulo opcional tiene rutas que apagar', () => {
    for (const key of opcionales) {
      expect(registeredRoutes().some((r) => r.module === key), `ninguna ruta es de ${key}`).toBe(true);
    }
  });

  it('una ruta de lo fijo no exige un permiso de un módulo opcional', () => {
    // Si lo exigiera, apagar ese módulo dejaría la ruta viva pero su permiso
    // sin sentido. La lista de deuda conocida solo puede bajar.
    const cruces = registeredRoutes()
      .filter((r) => r.security.kind === 'permission' && MODULE_BY_KEY.get(r.module)!.kind === 'fixed')
      .filter((r) => r.security.kind === 'permission' && MODULE_BY_KEY.get(moduleOfPermission(r.security.permission)!)!.kind === 'optional')
      .map((r) => `${r.method} ${r.url}`);
    expect(cruces, `Rutas fijas con permiso de un módulo opcional:\n  ${cruces.join('\n  ')}`).toEqual([]);
  });

  it('todo trabajo nocturno tiene módulo; lo apagado deja de generar pero sigue cerrando', () => {
    const todos = allJobs(BACKEND_MODULES);
    expect(todos.size).toBeGreaterThan(10);
    // Los de plataforma no son de ningún gimnasio: corren una vez por corrida (23-12).
    const jobs = new Map([...todos].filter((e): e is [string, PlannedGymJob] => !esDePlataforma(e[1])));
    expect([...todos.values()].filter(esDePlataforma).map((j) => j.name)).toEqual(['audit.verify-platform-chain', 'platform.prices.apply', 'platform.invoices.issue', 'platform.collections']);
    for (const j of jobs.values()) expect(MODULE_BY_KEY.has(j.module), j.name).toBe(true);
    // Todo job declarado tiene su lugar en el orden que le toca (si no, el runner no arranca).
    const planes = armarPlanes(BACKEND_MODULES);
    expect(planes.diario.length + planes.frecuente.length + planes.plataforma.length).toBe(todos.size);

    const sinClases = effectiveModules({ classes: false });
    expect(runsFor(jobs.get('class.materialize-horizon')!, sinClases)).toBe(false);
    expect(runsFor(jobs.get('class.close-finished')!, sinClases)).toBe(true);
    // Lo fijo corre siempre, con cualquier combinación de módulos apagados.
    const todoApagado = effectiveModules(Object.fromEntries(opcionales.map((k) => [k, false])));
    for (const j of jobs.values()) {
      if (MODULE_BY_KEY.get(j.module)!.kind === 'fixed') expect(runsFor(j, todoApagado), j.name).toBe(true);
    }
    expect(runsFor(jobs.get('class.materialize-horizon')!, effectiveModules({}))).toBe(true);
  });
});

describe('apagar un módulo lo apaga de verdad', () => {
  let app: FastifyInstance;
  let gerenciaOtro: string;
  let gerenciaDemo: string;
  let otroId: string;
  let otraSede: string;

  /** Escribe el estado directo, sin pasar por las reglas de la ruta. */
  async function forzar(key: ModuleKey, enabled: boolean) {
    await new ModuleStateRepository(otroId).set(key, enabled, null, enabled ? null : 'Prueba');
    forgetModules(otroId);
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    [gerenciaOtro, gerenciaDemo] = await Promise.all([loginAs(app, 'gerencia@otro.mx'), loginAs(app, 'gerencia@demo.mx')]);
    const f = await orgFixtures();
    otroId = f.other.id;
    otraSede = f.otherBranches[0]!.id;
  });

  afterAll(async () => {
    // El gimnasio queda como estaba: todo en su valor por omisión.
    for (const key of opcionales) await forzar(key, MODULE_BY_KEY.get(key)!.defaultEnabled);
    await new ModuleStateRepository(otroId).setBranch(otraSede, 'classes', true, null, null);
    forgetModules(otroId);
    await app.close();
    await closeDb();
  });

  const modulosDe = async (cookie: string) =>
    (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json().modules as string[];

  it('por omisión todo está encendido salvo lo que nace apagado', async () => {
    for (const key of opcionales) await forzar(key, MODULE_BY_KEY.get(key)!.defaultEnabled);
    const activos = await modulosDe(gerenciaOtro);
    expect(activos).toEqual(expect.arrayContaining(['core', 'cash', 'classes', 'pos', 'prospects', 'intake', 'training', 'retention', 'biometrics']));
    expect(activos).not.toContain('turnstile');
  });

  it('la gerencia general apaga Clases con motivo: sus rutas responden "módulo apagado", las demás siguen, y queda en la bitácora', async () => {
    const sinMotivo = await app.inject({ method: 'PUT', url: '/organization/modules/classes', headers: { cookie: gerenciaOtro }, payload: { enabled: false } });
    expect(sinMotivo.statusCode, sinMotivo.body).toBe(422);

    const apagar = await app.inject({
      method: 'PUT', url: '/organization/modules/classes', headers: { cookie: gerenciaOtro },
      payload: { enabled: false, reason: 'Dejamos de dar clases este mes' },
    });
    // Si la organización de pruebas tuviera reservas futuras, lo correcto es el bloqueo.
    if (apagar.statusCode === 409) {
      expect(apagar.json().detail).toBe('MODULE_BLOCKED');
      await forzar('classes', false);
    } else {
      expect(apagar.statusCode, apagar.body).toBe(200);
      const clases = apagar.json().modules.find((m: { key: string }) => m.key === 'classes');
      expect(clases.enabled).toBe(false);
      expect(clases.lastChange).toMatchObject({ enabled: false, reason: 'Dejamos de dar clases este mes' });
      expect(clases.lastChange.byName).toBeTruthy();
      const asiento = await getDb().auditLog.findFirst({
        where: { organizationId: otroId, action: 'settings.module.disable' }, orderBy: { at: 'desc' },
      });
      expect(asiento?.reason).toBe('Dejamos de dar clases este mes');
    }

    expect(await modulosDe(gerenciaOtro)).not.toContain('classes');
    // TODAS las rutas del personal que son de Clases, sin enumerarlas: una
    // ruta nueva queda cubierta sin escribir otra prueba.
    const deClases = registeredRoutes().filter((r) => r.module === 'classes' && r.security.kind !== 'public' && r.security.kind !== 'member');
    expect(deClases.length).toBeGreaterThan(8);
    for (const r of deClases) {
      const res = await app.inject({ method: r.method as 'GET', url: conParametros(r.url), headers: { cookie: gerenciaOtro }, ...(r.method === 'GET' ? {} : { payload: {} }) });
      expect(res.statusCode, `${r.method} ${r.url}: ${res.body}`).toBe(403);
      expect(res.json().error, `${r.method} ${r.url}`).toBe('MODULE_DISABLED');
    }
    // Lo fijo sigue igual.
    const socios = await app.inject({ method: 'GET', url: '/members/search?q=zz', headers: { cookie: gerenciaOtro } });
    expect(socios.statusCode, socios.body).toBe(200);
    // Y el otro gimnasio ni se entera: el interruptor es por gimnasio.
    expect(await modulosDe(gerenciaDemo)).toContain('classes');
    const enDemo = await app.inject({ method: 'GET', url: '/classes/types', headers: { cookie: gerenciaDemo } });
    expect(enDemo.statusCode, enDemo.body).toBe(200);
  });

  it('volver a encender no pide motivo y todo regresa', async () => {
    await forzar('classes', false);
    const encender = await app.inject({ method: 'PUT', url: '/organization/modules/classes', headers: { cookie: gerenciaOtro }, payload: { enabled: true } });
    expect(encender.statusCode, encender.body).toBe(200);
    expect(await modulosDe(gerenciaOtro)).toContain('classes');
    const tipos = await app.inject({ method: 'GET', url: '/classes/types', headers: { cookie: gerenciaOtro } });
    expect(tipos.statusCode, tipos.body).toBe(200);
  });

  it('las rutas que viven en la carpeta de otro módulo obedecen al suyo', async () => {
    // Los prospectos viven en `members`; la biometría, en `access`.
    await forzar('prospects', false);
    await forzar('biometrics', false);
    const prospectos = await app.inject({ method: 'GET', url: '/prospects', headers: { cookie: gerenciaOtro } });
    expect(prospectos.json().error).toBe('MODULE_DISABLED');
    const borrados = await app.inject({ method: 'GET', url: '/biometric-enrollments/pending-deletion', headers: { cookie: gerenciaOtro } });
    expect(borrados.json().error).toBe('MODULE_DISABLED');
    // …y lo que comparte carpeta con ellos pero es de lo fijo, no.
    const padron = await app.inject({ method: 'GET', url: '/members?limit=1', headers: { cookie: gerenciaOtro } });
    expect(padron.statusCode, padron.body).toBe(200);
    const textos = await app.inject({ method: 'GET', url: '/consent-documents', headers: { cookie: gerenciaOtro } });
    expect(textos.statusCode, textos.body).toBe(200);
    await forzar('prospects', true);
    await forzar('biometrics', true);
  });

  it('el monitor de accesos nace apagado: sustituye a la variable de compilación', async () => {
    await forzar('turnstile', false);
    const monitor = await app.inject({ method: 'GET', url: '/access/monitor', headers: { cookie: gerenciaOtro } });
    expect(monitor.json().error).toBe('MODULE_DISABLED');
    // Registrar una entrada en el mostrador es de lo fijo: no depende del equipo.
    const intentos = registeredRoutes().find((r) => r.url === '/access/attempts');
    expect(intentos?.module).toBe('core');
  });

  it('el formulario público de alta deja de recibir solicitudes, sin contar cómo está configurado el gimnasio', async () => {
    await forzar('intake', false);
    const form = await app.inject({ method: 'GET', url: `/intake/${otraSede}/form` });
    expect(form.statusCode, form.body).toBe(404);
    expect(form.json().message).toMatch(/no está disponible en este gimnasio/);
    const envio = await app.inject({ method: 'POST', url: `/intake/${otraSede}`, payload: {} });
    expect(envio.statusCode, envio.body).toBe(404);
    await forzar('intake', true);
    const otraVez = await app.inject({ method: 'GET', url: `/intake/${otraSede}/form` });
    expect(otraVez.json().message ?? '').not.toMatch(/no está disponible en este gimnasio/);
  });

  it('el socio tampoco entra a lo apagado desde su teléfono, y el portal sabe qué esconder', async () => {
    const alta = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerenciaOtro },
      payload: { firstName: nombreUnico('Mod'), lastName: nombreUnico('Ulo'), phoneE164: telefonoUnico(), homeBranchId: otraSede, force: true, consents: CONSENTIMIENTOS },
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const invitacion = await app.inject({ method: 'POST', url: `/members/${alta.json().id}/portal-invite`, headers: { cookie: gerenciaOtro } });
    expect(invitacion.statusCode, invitacion.body).toBe(201);
    const activar = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invitacion.json().code } });
    expect(activar.statusCode, activar.body).toBe(201);
    const socio = `gf_portal=${activar.cookies.find((c) => c.name === 'gf_portal')!.value}`;

    await forzar('classes', false);
    await forzar('training', false);
    const yo = (await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie: socio } })).json();
    expect(yo.modules).not.toContain('classes');
    expect(yo.modules).not.toContain('training');
    const clases = await app.inject({ method: 'GET', url: '/portal/classes', headers: { cookie: socio } });
    expect(clases.statusCode, clases.body).toBe(403);
    expect(clases.json().error).toBe('MODULE_DISABLED');
    const rutina = await app.inject({ method: 'GET', url: '/portal/routine', headers: { cookie: socio } });
    expect(rutina.json().error).toBe('MODULE_DISABLED');
    // "¿Da clases el gimnasio?" responde que no; no es un error.
    const ofrece = await app.inject({ method: 'GET', url: '/portal/classes/offered', headers: { cookie: socio } });
    expect(ofrece.json()).toEqual({ offered: false });
    // Sin sesión de socio la respuesta sigue siendo "sesión requerida".
    expect((await app.inject({ method: 'GET', url: '/portal/classes' })).statusCode).toBe(401);

    await forzar('classes', true);
    await forzar('training', true);
    expect((await app.inject({ method: 'GET', url: '/portal/classes', headers: { cookie: socio } })).statusCode).toBe(200);
  });

  it('solo quien configura TODO el gimnasio cambia módulos; lo fijo no se apaga', async () => {
    // La dueña y recepción no cambian módulos (ADR-039); el gerente, que
    // siempre abarca todo el gimnasio (2026-10-06), sí.
    const [duena, recepcion] = await Promise.all(
      ['owner@demo.mx', 'recepcion@demo.mx'].map((e) => loginAs(app, e)),
    );
    for (const cookie of [duena, recepcion]) {
      const r = await app.inject({ method: 'PUT', url: '/organization/modules/prospects', headers: { cookie }, payload: { enabled: false, reason: 'No lo usamos' } });
      expect(r.statusCode, r.body).toBe(403);
    }
    expect(await modulosDe(gerenciaDemo)).toContain('prospects');

    const fijo = await app.inject({ method: 'PUT', url: '/organization/modules/core', headers: { cookie: gerenciaOtro }, payload: { enabled: false, reason: 'Probando' } });
    expect(fijo.statusCode, fijo.body).toBe(422);
    // Caja ya se apaga, pero no mientras la tienda la necesite.
    const caja = await app.inject({ method: 'PUT', url: '/organization/modules/cash', headers: { cookie: gerenciaOtro }, payload: { enabled: false, reason: 'Probando' } });
    expect(caja.statusCode, caja.body).toBe(409);
    expect(caja.json().detail).toBe('MODULE_HAS_DEPENDENTS');
    const inventado = await app.inject({ method: 'PUT', url: '/organization/modules/inventado', headers: { cookie: gerenciaOtro }, payload: { enabled: true } });
    expect(inventado.statusCode, inventado.body).toBe(404);

    // Todos ven qué está encendido; el detalle, solo quien dirige.
    const vistaRecepcion = (await app.inject({ method: 'GET', url: '/organization/modules', headers: { cookie: recepcion } })).json();
    expect(vistaRecepcion.canManage).toBe(false);
    expect(vistaRecepcion.modules.find((m: { key: string }) => m.key === 'classes')).not.toHaveProperty('usage');
    const vistaDuena = (await app.inject({ method: 'GET', url: '/organization/modules', headers: { cookie: duena } })).json();
    expect(vistaDuena.canManage).toBe(false);
    expect(vistaDuena.modules.find((m: { key: string }) => m.key === 'classes')).toHaveProperty('usage');
    const vistaGerencia = (await app.inject({ method: 'GET', url: '/organization/modules', headers: { cookie: gerenciaDemo } })).json();
    expect(vistaGerencia.canManage).toBe(true);
    expect(vistaGerencia.modules.map((m: { key: string }) => m.key)).toEqual(MODULES.map((m) => m.key));
  });

  it('sin Caja, el efectivo entra sin turno: el gimnasio que no corta cajón sigue cobrando', async () => {
    // Punto de venta necesita Caja: primero se apaga la tienda.
    await forzar('pos', false);
    const apagar = await app.inject({ method: 'PUT', url: '/organization/modules/cash', headers: { cookie: gerenciaOtro }, payload: { enabled: false, reason: 'Cobramos por transferencia' } });
    expect(apagar.statusCode, apagar.body).toBe(200);
    const abiertas = await getDb().cashSession.count({ where: { organizationId: otroId, branchId: otraSede, status: 'OPEN' } });

    const plan = await app.inject({
      method: 'POST', url: '/plans', headers: { cookie: gerenciaOtro },
      payload: { code: `MOD${Date.now() % 1e6}`, name: 'Plan sin caja', billingModel: 'RECURRING', durationUnit: 'MONTH', durationValue: 1, priceCents: '50000', reason: 'Prueba de módulos' },
    });
    expect(plan.statusCode, plan.body).toBe(201);
    const socio = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerenciaOtro },
      payload: { firstName: nombreUnico('Sin'), lastName: nombreUnico('Caja'), phoneE164: telefonoUnico(), homeBranchId: otraSede, force: true, consents: CONSENTIMIENTOS },
    });
    expect(socio.statusCode, socio.body).toBe(201);
    const venta = await app.inject({
      method: 'POST', url: `/members/${socio.json().id}/memberships/sale`, headers: { cookie: gerenciaOtro },
      payload: { planId: plan.json().id, branchId: otraSede, payment: { method: 'CASH' } },
    });
    expect(venta.statusCode, `con ${abiertas} cajas abiertas: ${venta.body}`).toBe(201);
    const pago = await getDb().payment.findFirst({ where: { organizationId: otroId, memberId: socio.json().id }, orderBy: { receivedAt: 'desc' } });
    expect(pago?.cashSessionId ?? null).toBeNull();
    // La pantalla de Caja ya no existe para nadie.
    expect((await app.inject({ method: 'GET', url: '/cash-sessions', headers: { cookie: gerenciaOtro } })).json().error).toBe('MODULE_DISABLED');

    await forzar('cash', true);
    await forzar('pos', true);
  });

  it('con el portal apagado, ningún socio entra y recepción no invita', async () => {
    const alta = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerenciaOtro },
      payload: { firstName: nombreUnico('Por'), lastName: nombreUnico('Tal'), phoneE164: telefonoUnico(), homeBranchId: otraSede, force: true, consents: CONSENTIMIENTOS },
    });
    const invitacion = await app.inject({ method: 'POST', url: `/members/${alta.json().id}/portal-invite`, headers: { cookie: gerenciaOtro } });
    expect(invitacion.statusCode, invitacion.body).toBe(201);
    const activar = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invitacion.json().code } });
    const socio = `gf_portal=${activar.cookies.find((c) => c.name === 'gf_portal')!.value}`;
    const otraInvitacion = await app.inject({ method: 'POST', url: `/members/${alta.json().id}/portal-invite`, headers: { cookie: gerenciaOtro } });
    expect(otraInvitacion.statusCode, otraInvitacion.body).toBe(201);

    await forzar('member_portal', false);
    // La sesión que ya existía deja de servir, también para lo de otros módulos.
    expect((await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie: socio } })).json().error).toBe('MODULE_DISABLED');
    expect((await app.inject({ method: 'GET', url: '/portal/classes', headers: { cookie: socio } })).json().error).toBe('MODULE_DISABLED');
    // Un código emitido antes no abre nada, y se dice claro.
    const tarde = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: otraInvitacion.json().code } });
    expect(tarde.statusCode, tarde.body).toBe(404);
    expect(tarde.json().message).toMatch(/no está disponible/);
    // Recepción ya no puede invitar.
    expect((await app.inject({ method: 'POST', url: `/members/${alta.json().id}/portal-invite`, headers: { cookie: gerenciaOtro } })).json().error).toBe('MODULE_DISABLED');
    await forzar('member_portal', true);
    expect((await app.inject({ method: 'GET', url: '/portal/me', headers: { cookie: socio } })).statusCode).toBe(200);
  });

  it('una sucursal deja de usar Clases sin apagarlas en el gimnasio', async () => {
    const sinMotivo = await app.inject({ method: 'PUT', url: `/organization/modules/classes/branches/${otraSede}`, headers: { cookie: gerenciaOtro }, payload: { enabled: false } });
    expect(sinMotivo.statusCode, sinMotivo.body).toBe(422);
    const r = await app.inject({ method: 'PUT', url: `/organization/modules/classes/branches/${otraSede}`, headers: { cookie: gerenciaOtro }, payload: { enabled: false, reason: 'Esta sede no tiene salón' } });
    if (r.statusCode === 409) {
      expect(r.json().detail).toBe('MODULE_BLOCKED');
      await new ModuleStateRepository(otroId).setBranch(otraSede, 'classes', false, null, 'Prueba');
      forgetModules(otroId);
    } else {
      expect(r.statusCode, r.body).toBe(200);
      const clases = r.json().modules.find((m: { key: string }) => m.key === 'classes');
      expect(clases.enabled, 'en el gimnasio sigue encendido').toBe(true);
      expect(clases.branches.find((b: { branchId: string }) => b.branchId === otraSede)).toMatchObject({ enabled: false, reason: 'Esta sede no tiene salón' });
    }
    // La sesión lo sabe…
    const yo = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: gerenciaOtro } })).json();
    expect(yo.modules).toContain('classes');
    expect(yo.disabledByBranch[otraSede]).toContain('classes');
    // …las rutas del gimnasio siguen abiertas…
    expect((await app.inject({ method: 'GET', url: '/classes/types', headers: { cookie: gerenciaOtro } })).statusCode).toBe(200);
    // …pero crear algo EN esa sede se rechaza con el nombre de la sede.
    const tipo = await app.inject({ method: 'POST', url: '/classes/types', headers: { cookie: gerenciaOtro }, payload: { name: nombreUnico('Mod'), dropInPriceCents: '0' } });
    expect(tipo.statusCode, tipo.body).toBe(201);
    const horario = await app.inject({
      method: 'POST', url: '/classes/templates', headers: { cookie: gerenciaOtro },
      payload: { branchId: otraSede, classTypeId: tipo.json().id, effectiveFrom: new Date().toISOString(), slots: [{ weekday: 1, startMinute: 420, durationMin: 60, capacity: 10 }] },
    });
    expect(horario.statusCode, horario.body).toBe(403);
    expect(horario.json().error).toBe('MODULE_DISABLED');
    expect(horario.json().message).toMatch(/no se usa en esta sucursal/);
    // Lo que es de todo el gimnasio no se apaga por sede.
    const rutinas = await app.inject({ method: 'PUT', url: `/organization/modules/training/branches/${otraSede}`, headers: { cookie: gerenciaOtro }, payload: { enabled: false, reason: 'x' } });
    expect(rutinas.statusCode, rutinas.body).toBe(422);
    // Y una sede no enciende lo que el gimnasio tiene apagado.
    await forzar('prospects', false);
    const porSuCuenta = await app.inject({ method: 'PUT', url: `/organization/modules/prospects/branches/${otraSede}`, headers: { cookie: gerenciaOtro }, payload: { enabled: true } });
    expect(porSuCuenta.statusCode, porSuCuenta.body).toBe(409);
    await forzar('prospects', true);

    const otraVez = await app.inject({ method: 'PUT', url: `/organization/modules/classes/branches/${otraSede}`, headers: { cookie: gerenciaOtro }, payload: { enabled: true } });
    expect(otraVez.statusCode, otraVez.body).toBe(200);
    expect(((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: gerenciaOtro } })).json().disabledByBranch[otraSede] ?? [])).not.toContain('classes');
  });

  it('no se apaga con socios esperando respuesta: las altas por revisar bloquean', async () => {
    // Se registra el proveedor de uso de Altas con una solicitud pendiente
    // real de la organización de demostración, si la hay; si no, la regla
    // queda cubierta por el caso de Clases de arriba.
    const pendientes = await getDb().memberIntake.count({ where: { organizationId: otroId, status: 'SUBMITTED' } });
    const r = await app.inject({ method: 'PUT', url: '/organization/modules/intake', headers: { cookie: gerenciaOtro }, payload: { enabled: false, reason: 'Ya no recibimos altas en línea' } });
    if (pendientes > 0) {
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().detail).toBe('MODULE_BLOCKED');
      expect(r.json().message).toMatch(/por revisar/);
    } else {
      expect(r.statusCode, r.body).toBe(200);
      await forzar('intake', true);
    }
  });
});
