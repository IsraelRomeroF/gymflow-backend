import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PERMISSION_BY_KEY } from '@gymflow/core';
import { makeApp } from './helpers.js';
import { closeDb } from '../src/platform/db/client.js';
import { registeredRoutes } from '../src/platform/http/registry.js';
import { DE_ORGANIZACION } from './rutas-clasificacion.js';

/**
 * Cobertura de seguridad de rutas (docs/06-roles-permisos.md §7).
 * Una ruta sin declaración de seguridad no llega a registrarse: el registro
 * lanza al arrancar. Esta prueba comprueba además que lo declarado es válido
 * y que nada se volvió público por descuido.
 */
describe('declaración de seguridad de las rutas', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('hay rutas registradas', () => {
    expect(registeredRoutes().length).toBeGreaterThan(0);
  });

  it('toda ruta declara seguridad', () => {
    for (const r of registeredRoutes()) {
      expect(r.security, `${r.method} ${r.url}`).toBeDefined();
      expect(['public', 'session', 'member', 'permission', 'platform']).toContain(r.security.kind);
    }
  });

  it('todo permiso declarado existe en el catálogo', () => {
    for (const r of registeredRoutes()) {
      if (r.security.kind === 'permission') {
        for (const p of [r.security.permission, ...(r.security.anyOf ?? [])]) expect(PERMISSION_BY_KEY.has(p), `${r.url} -> ${p}`).toBe(true);
      }
    }
  });

  it('las rutas públicas son EXACTAMENTE las esperadas y están justificadas', () => {
    const publicRoutes = registeredRoutes()
      .filter((r) => r.security.kind === 'public')
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    // Cualquier ruta nueva que se declare pública rompe esta prueba a propósito:
    // hacer público un endpoint debe ser una decisión consciente y revisada.
    expect(publicRoutes).toEqual([
      'GET /health',
      // El formulario del alta digital: lo abre quien escanea el QR del
      // mostrador, y por definición todavía no tiene cuenta. Solo devuelve el
      // nombre de la sucursal y los textos que de todos modos se le van a
      // enseñar, y solo escribe un BORRADOR que recepción revisa.
      'GET /intake/:id/form',
      // La dirección pública del portal que el panel pone en sus QR (túnel o dominio).
      'GET /public/config',
      'POST /auth/login',
      'POST /intake/:id',
      'POST /portal/enroll',
      'POST /portal/logout',
      // La llama el PROCESADOR, que no tiene sesión. Lo que la autentica es
      // la firma del cuerpo, no una cookie.
      'POST /webhooks/payments',
    ]);
    for (const r of registeredRoutes()) {
      if (r.security.kind === 'public') expect(r.security.why.length).toBeGreaterThan(10);
    }
  });

  /**
   * Las rutas del SOCIO tienen categoría propia.
   *
   * Marcarlas `public` porque "ya validan en el handler" es el atajo que
   * erosiona el control: la siguiente que se marque igual puede no validar
   * nada y nadie lo notará.
   */
  it('las rutas de SOCIO están declaradas como tales, no como públicas', () => {
    const deSocio = registeredRoutes()
      .filter((r) => r.security.kind === 'member')
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(deSocio).toEqual([
      'DELETE /portal/payment-methods/:id',
      'DELETE /portal/push-subscriptions',
      'GET /portal/attendance',
      'GET /portal/attendance/summary',
      'GET /portal/bookings',
      'GET /portal/classes',
      'GET /portal/classes/offered',
      'GET /portal/coach',
      'GET /portal/consents',
      'GET /portal/me',
      'GET /portal/me/export',
      'GET /portal/notices',
      'GET /portal/notifications',
      'GET /portal/offer',
      'GET /portal/payment-methods',
      'GET /portal/payments/:id/receipt',
      'GET /portal/privacy-requests',
      'GET /portal/routine',
      'GET /portal/sessions',
      'GET /portal/statement',
      'GET /portal/statement/charges',
      'GET /portal/statement/payments',
      'POST /portal/bookings/:id/cancel',
      'POST /portal/charges/:id/pay',
      'POST /portal/classes/:id/book',
      'POST /portal/coach/code',
      'POST /portal/consents/:type/revoke',
      'POST /portal/logout-all',
      'POST /portal/notices/read',
      'POST /portal/payment-methods',
      'POST /portal/payment-methods/setup',
      'POST /portal/privacy-requests',
      'POST /portal/push-subscriptions',
      'POST /portal/routine/done',
      'POST /portal/routine/undo',
      'PUT /portal/notifications/preferences',
    ]);
  });

  /**
   * Toda ruta pública que ESCRIBE lleva límite de peticiones.
   *
   * Detrás de una ruta pública no hay cuenta que bloquear, así que el límite
   * es la única barrera. Esta prueba destapó que `/auth/login` no lo tenía:
   * había bloqueo POR CUENTA, que no frena probar la misma contraseña contra
   * quinientos correos ni el gasto de CPU de mil verificaciones de Argon2.
   *
   * La única excepción es cerrar sesión, y es deliberada: limitar el logout
   * sería dejar a alguien sin poder cerrar su sesión.
   */
  it('toda ruta pública que escribe tiene límite de peticiones', () => {
    const sinLimite = registeredRoutes().filter(
      (r) => r.security.kind === 'public' && r.method !== 'GET' && !r.hasRateLimit,
    );
    expect(sinLimite.map((r) => `${r.method} ${r.url}`)).toEqual(['POST /portal/logout']);
  });

  /**
   * El segundo usuario del maker-checker se comprueba contra la BASE.
   *
   * Durante mucho tiempo no se comprobó: `can()` solo miraba que
   * `approvedByUserId` no estuviera vacío y no fuera el mismo que ejecuta, así
   * que **un UUID inventado aprobaba un reembolso** — y la bitácora quedaba
   * incriminando a quien no hizo nada.
   *
   * Se verifica leyendo el CÓDIGO y no el comportamiento porque el fallo es
   * por omisión: la ruta que se olvide de llamar a `verifyApprover` no falla,
   * simplemente deja de comprobar, y eso no se nota nunca.
   */
  it('toda ruta que acepta una autorización la CONSUME contra la base', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');

    const modulos = resolve(import.meta.dirname, '../src/modules');
    const incumplen: string[] = [];

    for (const modulo of readdirSync(modulos)) {
      const dir = join(modulos, modulo);
      if (!statSync(dir).isDirectory()) continue;

      for (const archivo of readdirSync(dir).filter((f) => f.endsWith('.routes.ts'))) {
        const texto = readFileSync(join(dir, archivo), 'utf8');
        const declara = texto.split('approvalToken: z.string()').length - 1;
        const verifica = texto.split('verifyApprover(').length - 1;
        if (declara > verifica) incumplen.push(`${modulo}/${archivo}: declara ${declara}, verifica ${verifica}`);
      }
    }

    expect(incumplen).toEqual([]);
  });

  /**
   * El ALCANCE POR SUCURSAL se evalúa junto con el permiso (doc 06, §1).
   *
   * La puerta del registro solo exige tener el permiso en ALGUNA sede, así que
   * una ruta que no vuelva a mirar la sucursal del recurso la deja abierta a
   * todas — y eso no falla nunca, simplemente no se nota. Pasó en unas 30
   * rutas. Se verifica leyendo el código: cada ruta con permiso comprueba la
   * sucursal, o está en esta lista con el porqué de que sea de organización.
   */
  it('toda ruta con permiso comprueba la sucursal, o declara por qué es de organización', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');

    // La lista de las que valen para todo el gimnasio, con su porqué, vive en
    // `rutas-clasificacion.ts` (la comparte con la prueba de COMPORTAMIENTO de
    // `rutas-registro.test.ts`, que pide de verdad un recurso de otra sede).
    const modulos = resolve(import.meta.dirname, '../src/modules');
    const archivos = readdirSync(modulos).flatMap((m) => {
      const dir = join(modulos, m);
      return statSync(dir).isDirectory() ? readdirSync(dir).filter((f) => f.endsWith('.routes.ts')).map((f) => join(dir, f)) : [];
    });
    archivos.push(resolve(import.meta.dirname, '../src/platform/audit/audit.routes.ts'));

    const COMPRUEBA = /authorize\(|requirePermission\(|branchScope\(|holds\(|sedeDeConsulta\(|sedeDe\w*\(|autorizarSede\(|autorizarCorreccion\(|autorizar\(request/;
    const sinAlcance: string[] = [];
    const leidas = new Set<string>();
    for (const archivo of archivos) {
      for (const bloque of readFileSync(archivo, 'utf8').split('route(app, {').slice(1)) {
        // Entre la URL y la seguridad puede ir `module:` (ADR-036) u otro campo corto.
        const m = /^\s*method: '(\w+)',\s*url: '([^']+)',[^{}]{0,200}?security: \{ kind: '(\w+)'/.exec(bloque);
        if (!m || m[3] !== 'permission') continue;
        const clave = `${m[1]} ${m[2]}`;
        leidas.add(clave);
        if (!COMPRUEBA.test(bloque) && !DE_ORGANIZACION[clave]) sinAlcance.push(clave);
      }
    }
    expect(sinAlcance).toEqual([]);
    // Lo leído del código tiene que ser TODO lo que el registro montó (1.17b):
    // una ruta declarada con otro formato (otro orden de campos, otra carpeta)
    // se saltaba esta lectura sin avisar, y entonces nadie miraba su sede.
    const noLeidas = registeredRoutes()
      .filter((r) => r.security.kind === 'permission' && !leidas.has(`${r.method} ${r.url}`))
      .map((r) => `${r.method} ${r.url} (${r.source})`);
    expect(noLeidas, 'rutas con permiso que la lectura del código no encontró').toEqual([]);
  });

  it('ninguna ruta de socio expone datos de otro: todas cuelgan de /portal', () => {
    for (const r of registeredRoutes()) {
      if (r.security.kind === 'member') expect(r.url.startsWith('/portal/')).toBe(true);
    }
  });
});
