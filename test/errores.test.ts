import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACTIONS_REQUIRING_REASON, DomainError, ERROR_REASONS, conflict, isSessionEndReason, unavailable, validation } from '@gymflow/core';
import { diferenciasConElContrato, ErrorDeLaApi } from '@gymflow/core/contracts';
import { registerErrorHandler } from '../src/platform/http/error-handler.plugin.js';
import { mountModule, route } from '../src/platform/http/registry.js';
import { respuesta } from '../src/platform/http/respuesta.js';
import { DemasiadosIntentos } from '../src/platform/http/rate-limit.js';
import { ErrorConMotivo } from '../src/platform/http/sesion.js';
import { mensajeDeValidacion, textoDeZod, usarZodEnEspanol } from '../src/platform/http/zod-es.js';
import { AuditService } from '../src/platform/audit/audit.service.js';
import type { Env } from '../src/platform/env.js';
import type { RequestContext } from '../src/platform/context.js';
import { loginAs, makeApp } from './helpers.js';

/**
 * ERRORES (auditoría 8, bloque 1.2; hallazgos 28-02, 28-13, 20-08).
 *
 * Tres cosas, cada una resuelta en un solo lugar de `platform/http`:
 *  - el porqué estable (`reason`) de un error de negocio;
 *  - Zod en español, con el campo nombrado como en la pantalla;
 *  - una sola forma de declarar lo que responde una ruta (`respuesta()`).
 */

// Nada de lo que escribe la librería: ni su inglés ni su español de diccionario.
const DE_LIBRERIA = /expected|received|invalid|too (small|big)|required|unrecognized|se esperaba|recibido|indefinido/i;

const Contrato = z.object({ id: z.string(), total: z.string(), nota: z.string().nullable() });

/** Una API mínima con el manejador de errores y `route()` de verdad. */
function apiDePrueba(): FastifyInstance {
  const app = Fastify();
  registerErrorHandler(app);
  const publica = { kind: 'public', why: 'ruta de prueba del manejador de errores' } as const;
  mountModule(app, {
    name: 'prueba', module: 'core',
    register(a) {
      route(a, { method: 'POST', url: '/zod', security: publica, handler: async (request) => {
        z.object({
          phoneE164: z.string().min(10),
          reason: z.string().min(3).max(300),
          amountCents: z.string().regex(/^[0-9]{1,12}$/, 'Importe en centavos, hasta 12 dígitos'),
          method: z.enum(['CASH', 'CARD_TERMINAL']),
          branchId: z.string().uuid(),
          planId: z.string().uuid(),
          inventado: z.number().int().positive(),
          receptionists: z.array(z.object({ email: z.string().email() })).min(1),
        }).parse(request.body);
        return { ok: true };
      } });
      route(a, { method: 'GET', url: '/sin-caja', security: publica, handler: async () => {
        throw conflict('No hay ninguna caja abierta en esta sucursal: abre turno antes de cobrar', 'NO_OPEN_REGISTER');
      } });
      route(a, { method: 'GET', url: '/varias-cajas', security: publica, handler: async () => {
        throw validation('Hay 2 cajas abiertas en la sucursal: indica en cuál se recibe el cobro', undefined, 'MULTIPLE_OPEN_REGISTERS');
      } });
      route(a, { method: 'GET', url: '/ya-resuelto', security: publica, handler: async () => {
        // Como se escribía antes de existir `reason`: la clave en `detail`.
        throw new DomainError('CONFLICT', 'Ese rechazo lo acaba de resolver otra persona. No se registra otra entrada.', 'ALREADY_RESOLVED');
      } });
      route(a, { method: 'GET', url: '/detalle-libre', security: publica, handler: async () => {
        throw new DomainError('FORBIDDEN', 'Operación no permitida', 'Tu puesto no cobra en esta sucursal');
      } });
      route(a, { method: 'GET', url: '/sin-porque', security: publica, handler: async () => { throw conflict('Ya existe una clase llamada Yoga'); } });
      route(a, { method: 'GET', url: '/credenciales', security: publica, handler: async () => {
        throw new DomainError('UNAUTHENTICATED', 'La contraseña actual no es correcta');
      } });
      route(a, { method: 'GET', url: '/sesion', security: publica, handler: async () => {
        throw new ErrorConMotivo('UNAUTHENTICATED', 'Tu sesión se cerró. Vuelve a entrar.', 'SESSION_REVOKED');
      } });
      route(a, { method: 'GET', url: '/motor', security: publica, handler: async () => {
        throw unavailable('El motor facial no está encendido en este equipo.', 'FACE_ENGINE_DOWN');
      } });
      route(a, { method: 'GET', url: '/limite', security: publica, handler: async () => {
        throw new DemasiadosIntentos(90, 'Demasiados intentos. Espera 2 minutos y vuelve a intentar.');
      } });
      route(a, { method: 'GET', url: '/unico', security: publica, handler: async () => {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      } });
      route(a, { method: 'GET', url: '/turno-cerrado', security: publica, handler: async () => {
        throw Object.assign(new Error('el turno de caja ya no está abierto'), { code: '23514' });
      } });
      // Contratos: la que cumple, la que trae un campo de más y la que cambió un tipo.
      route(a, { method: 'GET', url: '/contrato/bien', security: publica, schema: respuesta(200, Contrato),
        handler: async () => ({ id: 'a', total: '100', nota: null }) });
      route(a, { method: 'GET', url: '/contrato/de-mas', security: publica, schema: respuesta(200, Contrato),
        handler: async () => ({ id: 'a', total: '100', nota: null, passwordHash: 'no debe salir' }) });
      route(a, { method: 'GET', url: '/contrato/otro-tipo', security: publica, schema: respuesta(200, Contrato),
        handler: async () => ({ id: 'a', total: 100, nota: null }) });
      route(a, { method: 'GET', url: '/contrato/error', security: publica, schema: respuesta(200, Contrato),
        handler: async () => { throw conflict('Ese mes ya está cerrado', 'MONTH_ALREADY_CLOSED'); } });
    },
  }, {} as Env);
  return app;
}

describe('1.2 · el manejador de errores (API mínima)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = apiDePrueba(); await app.ready(); });
  afterAll(async () => { await app.close(); });
  const pedir = async (url: string) => { const r = await app.inject({ method: 'GET', url }); return { status: r.statusCode, cuerpo: r.json(), cabeceras: r.headers }; };

  it('el porqué estable viaja en `reason` sin cambiar el código HTTP ni el texto (28-13)', async () => {
    const sinCaja = await pedir('/sin-caja');
    expect(sinCaja.status).toBe(409);
    expect(sinCaja.cuerpo).toMatchObject({ error: 'CONFLICT', reason: 'NO_OPEN_REGISTER', message: 'No hay ninguna caja abierta en esta sucursal: abre turno antes de cobrar' });
    const varias = await pedir('/varias-cajas');
    expect(varias.status).toBe(422);
    expect(varias.cuerpo).toMatchObject({ error: 'VALIDATION', reason: 'MULTIPLE_OPEN_REGISTERS' });
  });

  it('una clave del catálogo escrita en `detail` (como antes) sale también como `reason`; un detalle en palabras, no', async () => {
    const resuelto = await pedir('/ya-resuelto');
    expect(resuelto.cuerpo).toMatchObject({ error: 'CONFLICT', reason: 'ALREADY_RESOLVED', detail: 'ALREADY_RESOLVED' });
    const libre = await pedir('/detalle-libre');
    expect(libre.status).toBe(403);
    expect(libre.cuerpo.detail).toBe('Tu puesto no cobra en esta sucursal');
    expect(libre.cuerpo).not.toHaveProperty('reason');
  });

  it('un error sin porqué no inventa uno', async () => {
    const r = await pedir('/sin-porque');
    expect(r.status).toBe(409);
    expect(r.cuerpo).not.toHaveProperty('reason');
  });

  it('un 401 de credenciales NO lleva `reason`; el de sesión lleva uno de fin de sesión (el panel saca al login solo con esos)', async () => {
    const credenciales = await pedir('/credenciales');
    expect(credenciales.status).toBe(401);
    expect(credenciales.cuerpo).not.toHaveProperty('reason');
    const sesion = await pedir('/sesion');
    expect(sesion.status).toBe(401);
    expect(isSessionEndReason(sesion.cuerpo.reason)).toBe(true);
  });

  it('lo que no contesta es 503 con su porqué, y el texto llega (antes 422)', async () => {
    const r = await pedir('/motor');
    expect(r.status).toBe(503);
    expect(r.cuerpo).toMatchObject({ error: 'UNAVAILABLE', reason: 'FACE_ENGINE_DOWN', message: 'El motor facial no está encendido en este equipo.' });
  });

  it('el 429 dice RATE_LIMITED, cuánto esperar y en español (28-02)', async () => {
    const r = await pedir('/limite');
    expect(r.status).toBe(429);
    expect(r.cuerpo).toMatchObject({ error: 'RATE_LIMITED', reason: 'RATE_LIMITED', retryAfterSeconds: 90 });
    expect(r.cabeceras['retry-after']).toBe('90');
  });

  it('lo que rechaza la base lleva su porqué: choque de unicidad y turno ya cerrado', async () => {
    expect((await pedir('/unico')).cuerpo).toMatchObject({ error: 'CONFLICT', reason: 'CONCURRENT_CHANGE' });
    const turno = await pedir('/turno-cerrado');
    expect(turno.status).toBe(409);
    expect(turno.cuerpo).toMatchObject({ reason: 'CASH_SESSION_CLOSED', message: 'Ese turno de caja ya se cerró. Abre otro turno y vuelve a cobrar' });
  });

  it('todo `reason` que sale es del catálogo del núcleo o de fin de sesión, y todo error cumple `ErrorDeLaApi`', async () => {
    for (const url of ['/sin-caja', '/varias-cajas', '/ya-resuelto', '/detalle-libre', '/sin-porque', '/credenciales', '/sesion', '/motor', '/limite', '/unico', '/turno-cerrado', '/no-existe']) {
      const r = await pedir(url);
      expect(diferenciasConElContrato(ErrorDeLaApi, r.cuerpo), url).toEqual([]);
      const reason = r.cuerpo.reason as string | undefined;
      if (reason !== undefined) expect(reason in ERROR_REASONS || isSessionEndReason(reason), `${url}: ${reason}`).toBe(true);
    }
  });

  it('un 422 de Zod dice qué campo y por qué, en español y con la palabra de la pantalla', async () => {
    const r = await app.inject({ method: 'POST', url: '/zod', payload: {
      phoneE164: '55', reason: '', amountCents: 'doce', method: 'BITCOIN', branchId: 'no-es-uuid', inventado: -1, receptionists: [{ email: 'sin-arroba' }],
    } });
    expect(r.statusCode).toBe(422);
    const cuerpo = r.json() as { error: string; message: string; issues: Array<{ path: string; message: string }> };
    expect(cuerpo.error).toBe('VALIDATION');
    const de = (path: string) => cuerpo.issues.find((i) => i.path === path)?.message;
    expect(de('phoneE164')).toBe('Escribe al menos 10 caracteres');
    expect(de('reason')).toBe('Falta este dato');
    // El mensaje propio de un esquema se respeta.
    expect(de('amountCents')).toBe('Importe en centavos, hasta 12 dígitos');
    expect(de('method')).toBe('No es una de las opciones permitidas (CASH, CARD_TERMINAL)');
    expect(de('branchId')).toBe('No es un identificador válido');
    expect(de('planId')).toBe('Falta este dato');
    expect(de('inventado')).toBe('Debe ser mayor que cero');
    expect(de('receptionists.0.email')).toBe('No es un correo válido');
    for (const i of cuerpo.issues) expect(i.message, i.path).not.toMatch(DE_LIBRERIA);
    // El `message` resume los tres primeros con la palabra que ve la pantalla, y dice cuántos más hay.
    expect(cuerpo.message).toBe('Celular: Escribe al menos 10 caracteres · Motivo: Falta este dato · Importe: Importe en centavos, hasta 12 dígitos · y 5 más');
    expect(cuerpo.message).not.toMatch(DE_LIBRERIA);
    expect(diferenciasConElContrato(ErrorDeLaApi, cuerpo)).toEqual([]);
  });

  it('lo que Fastify rechaza antes de la ruta también sale en español', async () => {
    const vacio = await app.inject({ method: 'POST', url: '/zod', headers: { 'content-type': 'application/json' }, payload: '' });
    expect(vacio.statusCode).toBe(400);
    expect(vacio.json().message).toBe('La petición dice llevar datos y llegó vacía');
    const roto = await app.inject({ method: 'POST', url: '/zod', headers: { 'content-type': 'application/json' }, payload: '{"a":' });
    expect(roto.statusCode).toBe(400);
    expect(roto.json().message).not.toMatch(/unexpected|json at|body/i);
    expect((await app.inject({ method: 'GET', url: '/no-existe' })).json()).toMatchObject({ error: 'NOT_FOUND', message: 'Ruta no encontrada' });
  });

  describe('una sola forma de `schema.response`: `respuesta(codigo, Contrato)`', () => {
    it('la respuesta que cumple su contrato sale igual', async () => {
      const r = await pedir('/contrato/bien');
      expect(r.status).toBe(200);
      expect(r.cuerpo).toEqual({ id: 'a', total: '100', nota: null });
    });

    it('en las pruebas, un campo de más o un tipo distinto hace fallar la ruta con la lista (no se quita ni se convierte en silencio)', async () => {
      const deMas = await pedir('/contrato/de-mas');
      expect(deMas.status).toBe(500);
      expect(deMas.cuerpo.error).toBe('CONTRACT_MISMATCH');
      expect(deMas.cuerpo.message).toMatch(/GET \/contrato\/de-mas no cumple su contrato: passwordHash/);
      // El error dice QUÉ campo sobra, no su valor.
      expect(JSON.stringify(deMas.cuerpo)).not.toMatch(/no debe salir/);
      const otroTipo = await pedir('/contrato/otro-tipo');
      expect(otroTipo.status).toBe(500);
      expect(otroTipo.cuerpo.message).toMatch(/total/);
    });

    it('un error de la ruta no pasa por el contrato: sale como cualquier error', async () => {
      const r = await pedir('/contrato/error');
      expect(r.status).toBe(409);
      expect(r.cuerpo).toMatchObject({ error: 'CONFLICT', reason: 'MONTH_ALREADY_CLOSED' });
    });

    it('en producción no se comprueba ni se recorta ni se convierte: sale lo que el handler devolvió', async () => {
      const antes = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const prod = apiDePrueba();
      try {
        await prod.ready();
        const bien = await prod.inject({ method: 'GET', url: '/contrato/bien' });
        expect(bien.json()).toEqual({ id: 'a', total: '100', nota: null });
        // Un número donde el contrato dice texto NO sale disfrazado de texto (lo haría el serializador de Fastify).
        const otroTipo = await prod.inject({ method: 'GET', url: '/contrato/otro-tipo' });
        expect(otroTipo.statusCode).toBe(200);
        expect(otroTipo.json()).toEqual({ id: 'a', total: 100, nota: null });
      } finally {
        process.env.NODE_ENV = antes;
        await prod.close();
      }
    });
  });
});

describe('1.2 · Zod en español: cada clase de problema', () => {
  beforeAll(() => usarZodEnEspanol());
  const problema = (esquema: z.ZodType, valor: unknown): string => {
    const r = esquema.safeParse(valor);
    if (r.success) throw new Error('se esperaba un error de validación');
    return r.error.issues[0]!.message;
  };

  it('dice lo que le pasa al dato en voz de mostrador', () => {
    const casos: Array<[z.ZodType, unknown, string]> = [
      [z.string(), undefined, 'Falta este dato'],
      [z.string(), null, 'Falta este dato'],
      [z.string(), 5, 'Debe ser un texto'],
      [z.number(), 'cinco', 'Debe ser un número'],
      [z.boolean(), 'sí', 'Debe ser sí o no'],
      [z.array(z.string()), 'a', 'Debe ser una lista'],
      [z.object({ a: z.string() }), 'a', 'Debe ser un grupo de datos'],
      [z.string().min(1), '', 'Falta este dato'],
      [z.string().min(3), 'ab', 'Escribe al menos 3 caracteres'],
      [z.string().max(5), 'abcdefgh', 'Es demasiado largo: máximo 5 caracteres'],
      [z.number().min(1), 0, 'Debe ser al menos 1'],
      [z.number().positive(), 0, 'Debe ser mayor que cero'],
      [z.number().max(365), 400, 'Debe ser como máximo 365'],
      [z.number().int(), 1.5, 'Debe ser un número'],
      [z.number().multipleOf(5), 7, 'Debe ser múltiplo de 5'],
      [z.array(z.string()).min(1), [], 'Agrega al menos 1 elemento'],
      [z.array(z.string()).max(2), ['a', 'b', 'c'], 'Son demasiados: máximo 2 elementos'],
      [z.string().email(), 'x', 'No es un correo válido'],
      [z.string().uuid(), 'x', 'No es un identificador válido'],
      [z.string().date(), '01/03/2024', 'Debe ser una fecha con la forma AAAA-MM-DD'],
      [z.string().regex(/^\d+$/), 'x', 'No tiene la forma esperada'],
      [z.enum(['A', 'B']), 'C', 'No es una de las opciones permitidas (A, B)'],
      [z.literal('MANUAL'), 'RFID', 'Debe ser MANUAL'],
      [z.object({ a: z.string() }).strict(), { a: 'x', b: 1 }, 'Sobra un dato: b'],
      [z.union([z.string(), z.number()]), true, 'No tiene ninguna de las formas esperadas'],
      [z.string().refine((v) => v === 'x'), 'y', 'No es válido'],
    ];
    for (const [esquema, valor, texto] of casos) {
      const dicho = problema(esquema, valor);
      expect(dicho, JSON.stringify(valor)).toBe(texto);
      expect(dicho).not.toMatch(DE_LIBRERIA);
    }
  });

  it('el mensaje propio de un esquema manda sobre el mapa', () => {
    expect(problema(z.string().min(3, 'Escribe el motivo: queda en la bitácora'), '')).toBe('Escribe el motivo: queda en la bitácora');
    expect(problema(z.literal('MANUAL', { message: 'Desde el panel solo se registra la entrada por el mostrador' }), 'PIN')).toMatch(/solo se registra la entrada por el mostrador/);
  });

  it('el resumen nombra el campo con la palabra de la pantalla; sin palabra, con su clave', () => {
    expect(mensajeDeValidacion([{ path: 'owner.email', message: 'No es un correo válido' }])).toBe('Correo: No es un correo válido');
    expect(mensajeDeValidacion([{ path: 'cashSessionId', message: 'Falta este dato' }])).toBe('Turno de caja: Falta este dato');
    expect(mensajeDeValidacion([{ path: 'rosterVersion', message: 'Falta este dato' }])).toBe('rosterVersion: Falta este dato');
    expect(mensajeDeValidacion([{ path: '', message: 'Debe ser un grupo de datos' }])).toBe('Debe ser un grupo de datos');
    expect(mensajeDeValidacion([])).toBe('Revisa los datos: hay algo que no es válido');
  });

  it('`textoDeZod` no deja ninguna clase de problema sin texto', () => {
    for (const code of ['invalid_type', 'invalid_value', 'too_small', 'too_big', 'invalid_format', 'not_multiple_of', 'unrecognized_keys', 'invalid_union', 'invalid_key', 'invalid_element', 'custom'] as const) {
      const texto = textoDeZod({ code, input: 'x', path: [], origin: 'string', minimum: 2, maximum: 2, values: ['A'], keys: ['k'], divisor: 2, format: 'regex', expected: 'string' } as never);
      expect(texto.trim().length, code).toBeGreaterThan(5);
      expect(texto, code).not.toMatch(DE_LIBRERIA);
    }
  });
});

describe('1.2 · la API de verdad', () => {
  let app: FastifyInstance;
  let gerencia: string;
  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
  });
  afterAll(async () => { await app.close(); });

  it('un alta sin datos responde 422 nombrando los campos como la pantalla, sin inglés', async () => {
    const r = await app.inject({ method: 'POST', url: '/members', headers: { cookie: gerencia }, payload: {} });
    expect(r.statusCode).toBe(422);
    const cuerpo = r.json() as { message: string; issues: Array<{ path: string; message: string }> };
    expect(cuerpo.issues.find((i) => i.path === 'firstName')?.message).toBe('Falta este dato');
    expect(cuerpo.message).toMatch(/^Nombre: Falta este dato/);
    expect(cuerpo.message).not.toBe('Datos de entrada inválidos');
    for (const i of cuerpo.issues) expect(i.message, i.path).not.toMatch(DE_LIBRERIA);
  });

  it('un motivo demasiado corto dice «Motivo» y cuánto falta', async () => {
    const r = await app.inject({ method: 'POST', url: '/payments/00000000-0000-7000-8000-000000000000/reverse', headers: { cookie: gerencia }, payload: { reason: 'x' } });
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toMatch(/Motivo: Escribe al menos 3 caracteres/);
  });

  it('la contraseña actual mal tecleada es un 401 SIN `reason`: no saca a nadie del panel', async () => {
    const coach = await loginAs(app, 'coach@demo.mx');
    const r = await app.inject({ method: 'POST', url: '/auth/password', headers: { cookie: coach }, payload: { current: 'no-es-la-actual', next: 'Otra-Clave-Larga-2026' } });
    expect(r.statusCode).toBe(401);
    expect(r.json()).not.toHaveProperty('reason');
    // Y la sesión sigue viva.
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: coach } })).statusCode).toBe(200);
  });

  it('sin sesión, el 401 lleva un motivo de fin de sesión, que no es del catálogo de negocio', async () => {
    const r = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(r.statusCode).toBe(401);
    expect(r.json().reason).toBe('NO_SESSION');
    expect(r.json().reason in ERROR_REASONS).toBe(false);
  });

  it('20-08 · el código del motivo de un ajuste se valida contra el catálogo de SU acción', async () => {
    const ajustar = (payload: Record<string, unknown>) => app.inject({
      method: 'POST', url: '/charges/00000000-0000-7000-8000-000000000000/adjustments', headers: { cookie: gerencia },
      payload: { amountCents: '1000', reason: 'Prueba del catálogo', ...payload },
    });
    // Descontar no acepta un motivo de condonar, ni uno inventado.
    for (const reasonCode of ['LESION', 'PORQUE_SI']) {
      const r = await ajustar({ adjustmentType: 'DISCOUNT', reasonCode });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().issues).toEqual([{ path: 'reasonCode', message: 'Elige un motivo de la lista' }]);
      expect(r.json().message).toBe('Motivo: Elige un motivo de la lista');
    }
    expect((await ajustar({ adjustmentType: 'WAIVER', reasonCode: 'PORQUE_SI' })).statusCode).toBe(422);
    // Lo válido pasa la validación y llega a buscar el cargo (que no existe): 404, no 422.
    for (const payload of [
      { adjustmentType: 'DISCOUNT', reasonCode: 'PROMOCION_VIGENTE' },
      { adjustmentType: 'WAIVER', reasonCode: 'LESION' },
      // Lo que el panel manda hoy al condonar: un código de descuento.
      { adjustmentType: 'WAIVER', reasonCode: 'RETENCION' },
      { adjustmentType: 'CORRECTION' },
    ]) {
      const r = await ajustar(payload);
      expect(r.statusCode, `${JSON.stringify(payload)} ${r.body}`).toBe(404);
    }
  });

  it('20-08 · la segunda red del motivo atrapa las acciones reales: sin motivo no se asienta', async () => {
    const audit = new AuditService();
    const ctx = { tenant: { organizationId: '00000000-0000-7000-8000-000000000000' } } as unknown as RequestContext;
    for (const action of ['payments.reverse', 'billing.discount.apply', 'billing.charge.void', 'billing.waiver.apply', 'cash.withdraw']) {
      expect(ACTIONS_REQUIRING_REASON.has(action), action).toBe(true);
      await expect(audit.record(ctx, { action, resourceType: 'Payment', reason: '  ' })).rejects.toMatchObject({ code: 'VALIDATION', message: `La acción ${action} exige un motivo` });
    }
  });
});
