import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, PASSWORD, correoUnico, loginPlataforma } from './helpers.js';
import { cancelarCambiosAnunciados, ponerPrecios } from './precios-de-prueba.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * PLATAFORMA · MARCAS (ADR-037): quien opera GymFlow da de alta el siguiente
 * gimnasio con sus cuatro cuentas, y ese gimnasio nace aislado de los demás.
 */
describe('alta de marcas desde la plataforma', () => {
  let app: FastifyInstance;
  let plataforma: string;
  let gerencia: string;
  const sufijo = Date.now().toString(36).toUpperCase().slice(-4);
  const correo = (rol: string) => correoUnico(`${rol}.marca`);
  const NUEVA = `Mi.Gimnasio.${sufijo}.2026`;

  /**
   * Entra con la temporal y elige la suya sin volver a escribirla: la
   * temporal solo sirve para eso (A4-N1). Devuelve la misma sesión, ya útil.
   */
  async function entrarYElegir(email: string, temporal: string): Promise<string> {
    const l = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: temporal } });
    expect(l.statusCode, l.body).toBe(200);
    expect(l.json().mustChangePassword).toBe(true);
    const cookie = `gf_session=${l.cookies.find((c) => c.name === 'gf_session')!.value}`;
    const cambio = await app.inject({ method: 'POST', url: '/auth/password', headers: { cookie }, payload: { next: NUEVA } });
    expect(cambio.statusCode, cambio.body).toBe(200);
    return cookie;
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    [plataforma, gerencia] = await Promise.all([loginPlataforma(app), loginAs(app, 'gerencia@demo.mx')]);
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  it('la cuenta de plataforma no es de ningún gimnasio: entra por su propia puerta y no por la del personal', async () => {
    const yo = await app.inject({ method: 'GET', url: '/platform/me', headers: { cookie: plataforma } });
    expect(yo.statusCode, yo.body).toBe(200);
    expect(yo.json().templates.length).toBeGreaterThan(2);
    // Lo que es de un gimnasio no le responde: no tiene contexto de personal.
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: plataforma } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/members?limit=1', headers: { cookie: plataforma } })).statusCode).toBe(401);
    // Y el personal de un gimnasio no ve la plataforma ni por error.
    expect((await app.inject({ method: 'GET', url: '/platform/organizations', headers: { cookie: gerencia } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/platform/organizations' })).statusCode).toBe(401);
  });

  it('una marca nueva nace con su sede, su plantilla y cuatro cuentas con contraseña temporal', async () => {
    const cuerpo = {
      legalName: `Fuerza ${sufijo} S.A. de C.V.`, tradeName: `Fuerza ${sufijo}`, template: 'barrio',
      // Contrató Caja y Clases; nada más.
      contracted: ['cash', 'classes'],
      branch: { code: 'FZA', name: 'Matriz', addressLine: 'Av. Siempre Viva 1' },
      owner: { fullName: 'Ana Dueña Prueba', email: correo('duena'), phone: '55 1234 5678' },
      manager: { fullName: 'Beto Gerente Prueba', email: correo('gerente') },
      receptionists: [
        { fullName: 'Carla Recepcion Prueba', email: correo('recepcion') },
        { fullName: 'Dario Recepcion Prueba', email: correo('recepciondos') },
      ],
      reason: 'Alta del primer cliente de prueba',
    };
    const r = await app.inject({ method: 'POST', url: '/platform/organizations', headers: { cookie: plataforma }, payload: cuerpo });
    expect(r.statusCode, r.body).toBe(201);
    const { organizationId, credentials } = r.json();
    expect(credentials.map((c: { roleKey: string }) => c.roleKey)).toEqual(['OWNER', 'MANAGER', 'RECEPTION', 'RECEPTION']);
    for (const c of credentials) expect(c.password).toMatch(/^GYM-[ACDEFGHJKMNPQRTUVWXYZ2345679]{4}-[ACDEFGHJKMNPQRTUVWXYZ2345679]{4}$/);
    // Cada clave viaja con el celular de SU dueño, para entregársela solo a él (22-03).
    expect(credentials.map((c: { phoneE164: string | null }) => c.phoneE164)).toEqual(['+525512345678', null, null, null]);

    // El mismo correo no se repite en la plataforma.
    const repetido = await app.inject({ method: 'POST', url: '/platform/organizations', headers: { cookie: plataforma }, payload: { ...cuerpo, tradeName: 'Otra', branch: { ...cuerpo.branch, code: 'OTR' } } });
    expect(repetido.statusCode, repetido.body).toBe(409);

    // Nace SIN liberar: nadie de la marca entra hasta que la plataforma la libera.
    const duena = credentials.find((c: { roleKey: string }) => c.roleKey === 'OWNER');
    const antes = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: duena.email, password: duena.password } });
    expect(antes.statusCode, antes.body).toBe(403);
    expect(antes.json().message).toMatch(/todavía no está liberado/);
    const liberar = await app.inject({ method: 'POST', url: `/platform/organizations/${organizationId}/service`, headers: { cookie: plataforma }, payload: { status: 'ACTIVE', reason: 'Contrato firmado y primer pago recibido' } });
    expect(liberar.statusCode, liberar.body).toBe(200);

    // La dueña entra con su contraseña temporal y el login le pide cambiarla:
    // con ella sabe quién es, pero no opera nada (A4-N1).
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: duena.email, password: duena.password } });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json().mustChangePassword).toBe(true);
    const cookie = `gf_session=${login.cookies.find((c) => c.name === 'gf_session')!.value}`;
    expect((await app.inject({ method: 'GET', url: '/organization', headers: { cookie } })).statusCode).toBe(401);
    const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json();
    expect(me.organizationId).toBe(organizationId);
    expect(me.mustChangePassword).toBe(true);
    expect(me.roleKeys).toEqual(['OWNER']);
    // Lo contratado (Caja y Clases) nace ENCENDIDO aunque la plantilla "de barrio" apague Clases (UX5-PL-02);
    // lo demás queda apagado.
    expect(me.modules).toEqual(expect.arrayContaining(['core', 'cash', 'classes']));
    for (const k of ['pos', 'training', 'prospects', 'retention', 'biometrics', 'member_portal', 'intake']) expect(me.modules, k).not.toContain(k);
    // Con Caja contratada y encendida, nació con su primera caja.
    expect(await getDb().cashRegister.count({ where: { organizationId } })).toBe(1);
    // Lo contratado lo decide la plataforma: Clases sí, y encendido; Rutinas no.
    const detalleModulos = (await app.inject({ method: 'GET', url: `/platform/organizations/${organizationId}`, headers: { cookie: plataforma } })).json().modules;
    expect(detalleModulos.find((m: { key: string }) => m.key === 'classes')).toMatchObject({ contracted: true, enabled: true });
    expect(detalleModulos.find((m: { key: string }) => m.key === 'training')).toMatchObject({ contracted: false, enabled: false });

    // Recepción queda acotada a la sede; la gerencia, a todo el gimnasio.
    const detalle = (await app.inject({ method: 'GET', url: `/platform/organizations/${organizationId}`, headers: { cookie: plataforma } })).json();
    expect(detalle.users).toHaveLength(4);
    const rec = detalle.users.find((u: { email: string }) => u.email === cuerpo.receptionists[0]!.email);
    expect(rec.roleKeys).toEqual(['RECEPTION']);
    expect(rec.branchIds).toHaveLength(1);
    expect(detalle.users.find((u: { email: string }) => u.email === cuerpo.manager.email).branchIds).toBeNull();
    expect(detalle.modules.find((m: { key: string }) => m.key === 'classes').enabled).toBe(true);

    // El gimnasio nuevo no ve nada del de demostración (la gerencia ya eligió su contraseña).
    const gerente = credentials.find((c: { roleKey: string }) => c.roleKey === 'MANAGER');
    const cookie2 = await entrarYElegir(gerente.email, gerente.password);
    const padron = (await app.inject({ method: 'GET', url: '/members?limit=5', headers: { cookie: cookie2 } })).json();
    expect(padron.total).toBe(0);
    // Y queda en su bitácora, como acto de la plataforma.
    const asiento = await getDb().auditLog.findFirst({ where: { organizationId, action: 'platform.organization.create' } });
    expect(asiento?.reason).toBe('Alta del primer cliente de prueba');

    // La gerencia enciende lo contratado (Clases) pero no lo que no contrató (Rutinas).
    const enciendeClases = await app.inject({ method: 'PUT', url: '/organization/modules/classes', headers: { cookie: cookie2 }, payload: { enabled: true } });
    expect(enciendeClases.statusCode, enciendeClases.body).toBe(200);
    const enciendeRutinas = await app.inject({ method: 'PUT', url: '/organization/modules/training', headers: { cookie: cookie2 }, payload: { enabled: true } });
    expect(enciendeRutinas.statusCode, enciendeRutinas.body).toBe(409);
    expect(enciendeRutinas.json().detail).toBe('MODULE_NOT_CONTRACTED');
    const suyos = (await app.inject({ method: 'GET', url: '/organization/modules', headers: { cookie: cookie2 } })).json().modules;
    expect(suyos.find((m: { key: string }) => m.key === 'training')).toMatchObject({ contracted: false, enabled: false });
    expect(suyos.find((m: { key: string }) => m.key === 'classes')).toMatchObject({ contracted: true, enabled: true });
    // La plataforma concede Rutinas y entonces sí.
    const concede = await app.inject({ method: 'PUT', url: `/platform/organizations/${organizationId}/entitlements/training`, headers: { cookie: plataforma }, payload: { granted: true, reason: 'Contrató Rutinas' } });
    expect(concede.statusCode, concede.body).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/organization/modules/training', headers: { cookie: cookie2 }, payload: { enabled: true } })).statusCode).toBe(200);
    // Y si la plataforma retira Clases, se apagan aunque la gerencia las tuviera encendidas.
    await app.inject({ method: 'PUT', url: `/platform/organizations/${organizationId}/entitlements/classes`, headers: { cookie: plataforma }, payload: { granted: false, reason: 'Dejó de pagar Clases' } });
    const meGerente = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookie2 } })).json();
    expect(meGerente.modules).not.toContain('classes');
    expect((await app.inject({ method: 'GET', url: '/classes/types', headers: { cookie: cookie2 } })).json().error).toBe('MODULE_DISABLED');

    // Una cuenta más, un cajero acotado a la sede, con contraseña temporal.
    const sede = detalle.branches[0].id;
    const cajero = await app.inject({
      method: 'POST', url: `/platform/organizations/${organizationId}/users`, headers: { cookie: plataforma },
      payload: { fullName: 'Elena Cajera Prueba', email: correo('cajero'), roleKey: 'RECEPTION', branchIds: [sede], reason: 'El dueño pidió un cajero más' },
    });
    expect(cajero.statusCode, cajero.body).toBe(201);
    const l4 = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: cajero.json().email, password: cajero.json().password } });
    expect(l4.statusCode, l4.body).toBe(200);
    // Y se suspende desde la plataforma: su sesión muere y ya no entra.
    const cookie4 = `gf_session=${l4.cookies.find((c) => c.name === 'gf_session')!.value}`;
    const suspender = await app.inject({ method: 'POST', url: `/platform/organizations/${organizationId}/users/${cajero.json().userId}/active`, headers: { cookie: plataforma }, payload: { isActive: false, reason: 'Dejó de trabajar ahí' } });
    expect(suspender.statusCode, suspender.body).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookie4 } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: cajero.json().email, password: cajero.json().password } })).statusCode).toBe(401);

    // Suspender el servicio corta a toda la marca en la siguiente petición.
    await app.inject({ method: 'POST', url: `/platform/organizations/${organizationId}/service`, headers: { cookie: plataforma }, payload: { status: 'SUSPENDED', reason: 'Falta de pago' } });
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookie2 } })).statusCode).toBe(401);
    const otraVez = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: gerente.email, password: NUEVA } });
    expect(otraVez.statusCode).toBe(403);
    expect(otraVez.json().message).toMatch(/suspendido/);
    await app.inject({ method: 'POST', url: `/platform/organizations/${organizationId}/service`, headers: { cookie: plataforma }, payload: { status: 'ACTIVE', reason: 'Pagó' } });

    // La lista de marcas la incluye.
    const lista = (await app.inject({ method: 'GET', url: '/platform/organizations', headers: { cookie: plataforma } })).json();
    expect(lista.organizations.find((o: { id: string }) => o.id === organizationId)).toMatchObject({ tradeName: cuerpo.tradeName, branches: 1, staff: 4 });

    // Quien se quedó fuera recibe una contraseña temporal nueva desde la plataforma.
    const reset = await app.inject({ method: 'POST', url: `/platform/organizations/${organizationId}/users/${rec.id}/password-reset`, headers: { cookie: plataforma }, payload: { reason: 'La olvidó' } });
    expect(reset.statusCode, reset.body).toBe(200);
    const l3 = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: rec.email, password: reset.json().password } });
    expect(l3.statusCode, l3.body).toBe(200);
    expect(l3.json().mustChangePassword).toBe(true);
    // La ficha trae el celular de cada persona, para entregarle su temporal a ella (22-03).
    expect(detalle.users.find((u: { email: string }) => u.email === duena.email).phoneE164).toBe('+525512345678');
  });

  it('la plataforma cobra: sin precios no factura; la factura guarda sus líneas; se paga o se anula', async () => {
    // Una marca propia de la prueba, con Caja y Clases contratadas.
    const alta = await app.inject({
      method: 'POST', url: '/platform/organizations', headers: { cookie: plataforma },
      payload: {
        legalName: `Cobro ${sufijo} S.A.`, tradeName: `Cobro ${sufijo}`, template: 'cadena', contracted: ['cash', 'classes'],
        branch: { code: 'COB', name: 'Matriz' },
        owner: { fullName: 'Ana Cobro Prueba', email: correo('cobro.duena') }, manager: { fullName: 'Beto Cobro Prueba', email: correo('cobro.gerente') },
        receptionists: [{ fullName: 'Caja Cobro Prueba', email: correo('cobro.caja') }], reason: 'Prueba de cobro',
      },
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const orgId = alta.json().organizationId as string;

    // Los precios no se inventan: sin ellos la plataforma no factura.
    const precios = (await app.inject({ method: 'GET', url: '/platform/prices', headers: { cookie: plataforma } })).json().prices;
    expect(precios.find((p: { key: string }) => p.key === 'core')).toBeTruthy();
    // Fijar: básico 1500, Caja 300, Clases 500 (de prueba, no tarifas reales). Directo en la base (bloque 3.11):
    // desde D-38, cambiar por la API un precio que ya existe lo ANUNCIA con un mes de aviso, no lo cambia.
    await ponerPrecios({ core: 150000n, cash: 30000n, classes: 50000n, training: 0n });
    const resumen = (await app.inject({ method: 'GET', url: `/platform/organizations/${orgId}/billing`, headers: { cookie: plataforma } })).json();
    expect(resumen.monthly.totalCents).toBe('230000');
    expect(resumen.monthly.lines.map((l: { key: string }) => l.key).sort()).toEqual(['cash', 'classes', 'core']);
    // Sin liberar no se le cobra ni se le factura (23-06, bloque 1.13): antes decía «Sin facturar» y dejaba emitir.
    expect(resumen.status.code).toBe('SIN_COBRO');
    const mes = resumen.month as string;
    const emitirEl = () => app.inject({ method: 'POST', url: `/platform/organizations/${orgId}/invoices`, headers: { cookie: plataforma }, payload: { month: mes } });
    expect((await emitirEl()).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/platform/organizations/${orgId}/service`, headers: { cookie: plataforma }, payload: { status: 'ACTIVE', reason: 'Prueba' } })).statusCode).toBe(200);

    // La primera se emite y se anula: el mes queda libre para emitir otra.
    const primera = await emitirEl();
    expect(primera.statusCode, primera.body).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/platform/invoices/${primera.json().id}/void`, headers: { cookie: plataforma }, payload: { reason: 'Se emitió por error' } })).json().status).toBe('VOID');
    const emitir = await emitirEl();
    expect(emitir.statusCode, emitir.body).toBe(201);
    expect(emitir.json().folio).toMatch(new RegExp(`^GF-${mes.slice(0, 4)}-\\d{6}$`));
    expect(emitir.json().totalCents).toBe('230000');
    // Un mes, una factura.
    expect((await emitirEl()).statusCode).toBe(409);
    // Cambiar el precio después no toca la factura emitida, ni la mensualidad de hoy (D-38, bloque 3.11):
    // el cambio queda ANUNCIADO y la marca conserva lo que tenía hasta la fecha avisada.
    const anuncio = await app.inject({ method: 'PUT', url: '/platform/prices/classes', headers: { cookie: plataforma }, payload: { monthlyCents: '99900' } });
    expect(anuncio.json()).toMatchObject({ changed: 0, scheduled: [{ moduleKey: 'classes', afterCents: '99900', status: 'PENDING' }] });
    const porVencer = (await app.inject({ method: 'GET', url: `/platform/organizations/${orgId}/billing`, headers: { cookie: plataforma } })).json();
    expect(porVencer.invoices.find((f: { id: string }) => f.id === emitir.json().id).totalCents).toBe('230000');
    expect(porVencer.status.code).toBe('POR_VENCER');
    expect(porVencer.monthly.totalCents).toBe('230000');
    expect(porVencer.upcoming).toMatchObject({ effectiveFrom: anuncio.json().scheduled[0].effectiveFrom, totalCents: '279900' });
    await cancelarCambiosAnunciados(['classes']);
    // La plataforma la ve entre las pendientes de todas las marcas.
    const pendientes = (await app.inject({ method: 'GET', url: '/platform/invoices', headers: { cookie: plataforma } })).json().invoices;
    expect(pendientes.some((f: { id: string }) => f.id === emitir.json().id)).toBe(true);

    const pagar = await app.inject({ method: 'POST', url: `/platform/invoices/${emitir.json().id}/pay`, headers: { cookie: plataforma }, payload: { paymentMethod: 'SPEI_TRANSFER', paymentRef: 'SPEI-GF-001' } });
    expect(pagar.statusCode, pagar.body).toBe(200);
    expect(pagar.json().status).toBe('PAID');
    expect((await app.inject({ method: 'GET', url: `/platform/organizations/${orgId}/billing`, headers: { cookie: plataforma } })).json().status.code).toBe('AL_CORRIENTE');
    // Pagada, no se anula (la pendiente sí: es la que se anuló arriba).
    expect((await app.inject({ method: 'POST', url: `/platform/invoices/${emitir.json().id}/void`, headers: { cookie: plataforma }, payload: { reason: 'Error' } })).statusCode).toBe(409);
    // Y queda en la bitácora de la marca.
    expect(await getDb().auditLog.count({ where: { organizationId: orgId, action: { in: ['platform.invoice.issue', 'platform.invoice.pay', 'platform.invoice.void'] } } })).toBe(4);
    // El personal de la marca no ve el cobro de la plataforma.
    const gerente = alta.json().credentials.find((c: { roleKey: string }) => c.roleKey === 'MANAGER');
    const cookie = await entrarYElegir(gerente.email, gerente.password);
    expect((await app.inject({ method: 'GET', url: `/platform/organizations/${orgId}/billing`, headers: { cookie } })).statusCode).toBe(404);

    // El asistente de arranque le dice a esa gerencia qué le falta.
    const setup = (await app.inject({ method: 'GET', url: '/organization/setup', headers: { cookie } })).json();
    expect(setup.complete).toBe(false);
    expect(setup.canAct).toBe(true);
    const paso = (k: string) => setup.steps.find((p: { key: string }) => p.key === k);
    expect(paso('textos')).toMatchObject({ required: true, done: false, href: '/consentimientos' });
    expect(paso('planes')).toMatchObject({ required: true, done: false });
    expect(paso('caja')).toMatchObject({ required: true, done: true });       // nació con su caja
    expect(paso('personal')).toMatchObject({ required: true, done: true });   // nació con recepción
    expect(paso('clases')).toMatchObject({ required: false, done: false });   // contratadas, sin horario
    expect(paso('productos')).toBeUndefined();                                // tienda no contratada
    // En la marca de demostración, que ya opera, textos, planes y personal están
    // listos. La caja no se afirma: otras pruebas abren sucursales sin caja.
    const demo = (await app.inject({ method: 'GET', url: '/organization/setup', headers: { cookie: gerencia } })).json();
    const hecho = (k: string) => demo.steps.find((p: { key: string }) => p.key === k)?.done;
    expect([hecho('textos'), hecho('planes'), hecho('personal')]).toEqual([true, true, true]);
    expect(demo.requiredDone).toBeGreaterThanOrEqual(3);
  });

  it('planes de la plataforma (ADR-039): se crean, se asignan a una marca (liberan sus módulos), se cobran y se corrige la marca', async () => {
    // El catálogo de puestos y los planes vigentes viajan en /platform/me.
    const yo = (await app.inject({ method: 'GET', url: '/platform/me', headers: { cookie: plataforma } })).json();
    expect(yo.roles.map((r: { key: string }) => r.key)).toEqual(['OWNER', 'MANAGER', 'RECEPTION', 'COACH']);
    expect(yo.roles.find((r: { key: string }) => r.key === 'RECEPTION')).toMatchObject({ name: 'Recepción', scope: 'branch' });

    // Un plan: nombre, módulos y precio. Lo básico no se lista: todo plan lo incluye.
    const malo = await app.inject({ method: 'POST', url: '/platform/plans', headers: { cookie: plataforma }, payload: { name: 'Básico', modules: ['core', 'cash'] } });
    expect(malo.statusCode, malo.body).toBe(422);
    const basico = await app.inject({ method: 'POST', url: '/platform/plans', headers: { cookie: plataforma }, payload: { name: `Básico ${sufijo}`, description: 'Caja y clases', modules: ['cash', 'classes'], monthlyCents: '180000' } });
    expect(basico.statusCode, basico.body).toBe(201);
    const planId = basico.json().id as string;
    expect(basico.json()).toMatchObject({ name: `Básico ${sufijo}`, modules: ['cash', 'classes'], monthlyCents: '180000', isActive: true });
    const lista = (await app.inject({ method: 'GET', url: '/platform/plans', headers: { cookie: plataforma } })).json();
    expect(lista.plans.some((p: { id: string; organizations: number }) => p.id === planId && p.organizations === 0)).toBe(true);

    // Una marca nueva CON plan: contrata lo del plan más sus agregados.
    const alta = await app.inject({
      method: 'POST', url: '/platform/organizations', headers: { cookie: plataforma },
      payload: {
        legalName: `Plan ${sufijo} S.A.`, tradeName: `Plan ${sufijo}`, template: 'cadena', planId, contracted: ['prospects'],
        branch: { code: 'PLN', name: 'Matriz' },
        owner: { fullName: 'Olga Duena Plan', email: correo('duenaplan') }, manager: { fullName: 'Mario Gerente Plan', email: correo('gerenteplan') },
        receptionists: [{ fullName: 'Rita Recepcion Plan', email: correo('recepcionplan') }], reason: 'Contrato con plan',
      },
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const orgId = alta.json().organizationId as string;
    let detalle = (await app.inject({ method: 'GET', url: `/platform/organizations/${orgId}`, headers: { cookie: plataforma } })).json();
    expect(detalle.plan).toMatchObject({ id: planId, name: `Básico ${sufijo}`, monthlyCents: '180000' });
    const modulo = (k: string) => detalle.modules.find((m: { key: string }) => m.key === k);
    expect(modulo('cash')).toMatchObject({ contracted: true, inPlan: true });
    expect(modulo('prospects')).toMatchObject({ contracted: true, inPlan: false }); // agregado
    expect(modulo('pos')).toMatchObject({ contracted: false, inPlan: false });

    // La mensualidad: la línea del plan más el agregado a su precio (si lo tiene).
    await ponerPrecios({ prospects: 25000n });
    const cobro = (await app.inject({ method: 'GET', url: `/platform/organizations/${orgId}/billing`, headers: { cookie: plataforma } })).json();
    expect(cobro.monthly.lines.map((l: { name: string; monthlyCents: string }) => [l.name, l.monthlyCents])).toEqual([[`Plan Básico ${sufijo}`, '180000'], ['Prospectos', '25000']]);
    expect(cobro.monthly.totalCents).toBe('205000');

    // Cambiar de plan deja contratado EXACTAMENTE lo del plan nuevo.
    const completo = await app.inject({ method: 'POST', url: '/platform/plans', headers: { cookie: plataforma }, payload: { name: `Completo ${sufijo}`, modules: ['cash', 'pos', 'classes', 'training', 'member_portal'], monthlyCents: '320000' } });
    const cambio = await app.inject({ method: 'PUT', url: `/platform/organizations/${orgId}/plan`, headers: { cookie: plataforma }, payload: { planId: completo.json().id, reason: 'Subió de plan' } });
    expect(cambio.statusCode, cambio.body).toBe(200);
    detalle = (await app.inject({ method: 'GET', url: `/platform/organizations/${orgId}`, headers: { cookie: plataforma } })).json();
    expect(modulo('pos')).toMatchObject({ contracted: true, inPlan: true });
    expect(modulo('prospects')).toMatchObject({ contracted: false, inPlan: false }); // el agregado se vuelve a contratar aparte
    // Un plan desactivado ya no se asigna, pero las marcas que lo tienen lo conservan.
    expect((await app.inject({ method: 'PUT', url: `/platform/plans/${planId}`, headers: { cookie: plataforma }, payload: { isActive: false } })).json().isActive).toBe(false);
    expect((await app.inject({ method: 'PUT', url: `/platform/organizations/${orgId}/plan`, headers: { cookie: plataforma }, payload: { planId, reason: 'Bajar de plan' } })).statusCode).toBe(422);

    // Corregir la marca.
    const correoCobros = correo('cobros');
    const edicion = await app.inject({ method: 'PUT', url: `/platform/organizations/${orgId}`, headers: { cookie: plataforma }, payload: { tradeName: `Plan ${sufijo} Fit`, billingEmail: correoCobros, reason: 'Cambió de nombre comercial' } });
    expect(edicion.statusCode, edicion.body).toBe(200);
    detalle = (await app.inject({ method: 'GET', url: `/platform/organizations/${orgId}`, headers: { cookie: plataforma } })).json();
    expect(detalle.tradeName).toBe(`Plan ${sufijo} Fit`);
    expect(detalle.billingEmail).toBe(correoCobros);

    // Una cuenta más de recepción, por sucursal; el alcance lo manda el puesto.
    const sede = detalle.branches[0].id as string;
    const correoCaja = correo('cajaplan');
    const caja = await app.inject({ method: 'POST', url: `/platform/organizations/${orgId}/users`, headers: { cookie: plataforma }, payload: { fullName: 'Cata Caja Plan', email: correoCaja, roleKey: 'RECEPTION', branchIds: [sede], reason: 'Cajera del turno' } });
    expect(caja.statusCode, caja.body).toBe(201);
    expect(caja.json().roleName).toBe('Recepción');
    const sinSede = await app.inject({ method: 'POST', url: `/platform/organizations/${orgId}/users`, headers: { cookie: plataforma }, payload: { fullName: 'Cata Caja Dos', email: correo('cajados'), roleKey: 'RECEPTION', branchIds: null, reason: 'x' } });
    expect(sinSede.statusCode).toBe(422);
    const duenaAcotada = await app.inject({ method: 'POST', url: `/platform/organizations/${orgId}/users`, headers: { cookie: plataforma }, payload: { fullName: 'Dora Duena Dos', email: correo('duenados'), roleKey: 'OWNER', branchIds: [sede], reason: 'x' } });
    expect(duenaAcotada.statusCode).toBe(422);
    const plataformaNo = await app.inject({ method: 'POST', url: `/platform/organizations/${orgId}/users`, headers: { cookie: plataforma }, payload: { fullName: 'Sam Soporte', email: correo('soporte'), roleKey: 'SUPERADMIN', branchIds: null, reason: 'x' } });
    expect(plataformaNo.statusCode).toBe(422);

    // Entra (tras liberar): cobra, inscribe y da entradas, pero no modifica.
    await app.inject({ method: 'POST', url: `/platform/organizations/${orgId}/service`, headers: { cookie: plataforma }, payload: { status: 'ACTIVE', reason: 'Listo' } });
    const entrada = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: correoCaja, password: caja.json().password } });
    expect(entrada.statusCode, entrada.body).toBe(200);
    const cookieCaja = entrada.headers['set-cookie']!.toString().split(';')[0]!;
    const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookieCaja } })).json();
    expect(me.permissions).toContain('payments:record');
    expect(me.permissions).toContain('members:create');
    expect(me.permissions).not.toContain('members:update');
  });

  it('recepción atiende y consulta, no modifica', async () => {
    const recepcion = await loginAs(app, 'recepcion@demo.mx');
    const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: recepcion } })).json();
    const tiene = (p: string) => me.permissions.includes(p);
    for (const p of ['members:read', 'members:create', 'memberships:create', 'payments:record', 'access:manual_grant', 'cash:session:open', 'pos:sale:create', 'members:intake:review']) expect(tiene(p), p).toBe(true);
    for (const p of ['members:update', 'memberships:cancel', 'memberships:freeze', 'memberships:change_plan', 'billing:discount:apply', 'billing:waiver:apply', 'payments:refund', 'pos:sale:void', 'pos:sale:return', 'cash:limits:set', 'classes:manage', 'staff:manage', 'catalog:manage']) expect(tiene(p), p).toBe(false);
    // D-15 (fase 3, bloque 3.5): sí anota fondo y gasto chico del cajón, y retira o deposita con la firma de la dueña.
    for (const p of ['cash:petty:record', 'cash:withdraw']) expect(tiene(p), p).toBe(true);
    // Editar un socio existente ya no es suyo.
    const socio = await getDb().member.findFirst({ where: { organizationId: me.organizationId, status: 'ACTIVE' }, select: { id: true } });
    const editar = await app.inject({ method: 'PATCH', url: `/members/${socio!.id}`, headers: { cookie: recepcion }, payload: { notes: 'x' } });
    expect(editar.statusCode, editar.body).toBe(403);
    expect(PASSWORD.length).toBeGreaterThan(8);
  });
});
