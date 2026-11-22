import { describe, it, expect } from 'vitest';
import 'dotenv/config';
import { loadEnv } from '../src/platform/env.js';

/**
 * Configuración segura POR DEFECTO (SEC-06/07). Un despliegue que olvida una
 * variable no debe arrancar en modo inseguro sin decir nada.
 */
describe('configuración: lo que falta no se rellena con algo inseguro', () => {
  const base = () => ({ ...process.env, NODE_ENV: 'test' });

  it('sin NODE_ENV no arranca (antes asumía desarrollo: sin cookies Secure ni CSP)', () => {
    const sin = { ...base() } as NodeJS.ProcessEnv;
    delete sin.NODE_ENV;
    expect(() => loadEnv(sin)).toThrow(/NODE_ENV/);
  });

  it('en producción exige proxies de confianza', () => {
    expect(() => loadEnv({
      ...base(), NODE_ENV: 'production', TRUSTED_PROXIES: '',
      ROSTER_SIGNING_KEY: 'x', PAYMENT_WEBHOOK_SECRET: 'un-secreto-de-verdad-largo',
    })).toThrow(/TRUSTED_PROXIES/);
  });

  // Una base de producción con su propia contraseña: la de desarrollo está
  // publicada en el repositorio y en producción no arranca (fase 0.1).
  const prod = () => ({
    ...base(), NODE_ENV: 'production', TRUSTED_PROXIES: '127.0.0.1', PORTAL_ORIGINS: 'https://socios.ejemplo.mx', ROSTER_SIGNING_KEY: 'x',
    DATABASE_URL: 'postgresql://gymflow_app:una-clave-de-produccion@db.interna:5432/gymflow?schema=public',
  });

  it('en producción, sin procesador elegido, el cobro con tarjeta en línea nace APAGADO', () => {
    const env = prod() as NodeJS.ProcessEnv;
    delete env.PAYMENT_PROVIDER;
    expect(loadEnv(env).paymentProvider).toBe('none');
  });

  it('en producción la caja de arena no arranca: aprobaría cobros sin mover dinero', () => {
    expect(() => loadEnv({ ...prod(), PAYMENT_PROVIDER: 'sandbox', PAYMENT_WEBHOOK_SECRET: 'un-secreto-de-verdad-largo' })).toThrow(/sandbox/);
  });

  it('sin procesador, el secreto del webhook no se exige (no hay webhook que autenticar)', () => {
    const env = { ...prod(), PAYMENT_PROVIDER: 'none' } as NodeJS.ProcessEnv;
    delete env.PAYMENT_WEBHOOK_SECRET;
    expect(() => loadEnv(env)).not.toThrow();
  });

  it('en producción no arranca con una contraseña de base de desarrollo', () => {
    expect(() => loadEnv({ ...prod(), DATABASE_URL: 'postgresql://gymflow_app:gymflow_app_dev@db.interna:5432/gymflow' }))
      .toThrow(/contraseña de desarrollo «gymflow_app_dev»/);
  });
});

/**
 * PERFILES (fase 0.1): la API se niega a arrancar con una combinación que
 * confunde el uso real con las pruebas, y lo dice todo junto y en español.
 */
describe('configuración: perfiles de uso real y de pruebas', () => {
  const local = (over: Record<string, string | undefined> = {}) => ({
    ...process.env, NODE_ENV: 'development', API_PORT: '3001',
    DATABASE_URL: 'postgresql://gymflow_local_app:clave-propia-del-gimnasio@127.0.0.1:5432/gymflow_local?schema=public',
    PAYMENT_PROVIDER: 'none', TRUSTED_PROXIES: '127.0.0.1,::1',
    CORS_ORIGINS: 'http://localhost:3003,http://localhost:3002', PORTAL_ORIGINS: 'http://localhost:3002',
    PORTAL_PUBLIC_URL: undefined,
    ...over,
  }) as NodeJS.ProcessEnv;

  it('el uso real bien configurado arranca y se reconoce como tal', () => {
    const env = loadEnv(local());
    expect(env.perfil).toBe('uso-real');
    expect(env.paymentProvider).toBe('none');
    expect(env.trustedProxies).toEqual(['127.0.0.1', '::1']);
  });

  it('en el uso real, sin PAYMENT_PROVIDER, el cobro en línea nace apagado aunque no sea producción (25-01)', () => {
    expect(loadEnv(local({ PAYMENT_PROVIDER: undefined })).paymentProvider).toBe('none');
  });

  it('una combinación inválida no arranca y dice qué está mal, todo junto', () => {
    let mensaje = '';
    try {
      loadEnv(local({ PAYMENT_PROVIDER: 'sandbox', TRUSTED_PROXIES: '', DATABASE_URL: 'postgresql://gymflow_app:gymflow_app_dev@127.0.0.1:5432/gymflow_local' }));
    } catch (e) { mensaje = (e as Error).message; }
    expect(mensaje).toMatch(/^La configuración no corresponde a ningún perfil válido/);
    expect(mensaje).toMatch(/PAYMENT_PROVIDER=sandbox con la base gymflow_local/);
    expect(mensaje).toMatch(/TRUSTED_PROXIES=127\.0\.0\.1,::1/);
    expect(mensaje).toMatch(/gymflow_local_app/);
  });

  it('la base de pruebas no arranca en el puerto del uso real (27-01)', () => {
    expect(() => loadEnv(local({
      DATABASE_URL: 'postgresql://gymflow_app:gymflow_app_dev@127.0.0.1:5432/gymflow_pruebas?schema=public', PAYMENT_PROVIDER: 'sandbox',
    }))).toThrow(/gymflow_pruebas.*3001/);
  });

  it('las pruebas en 4001 con la caja de arena arrancan y se reconocen como tales', () => {
    const env = loadEnv(local({
      API_PORT: '4001', DATABASE_URL: 'postgresql://gymflow_app:gymflow_app_dev@127.0.0.1:5432/gymflow_pruebas?schema=public',
      PAYMENT_PROVIDER: undefined, PORTAL_PUBLIC_URL: 'http://localhost:4002',
    }));
    expect(env.perfil).toBe('pruebas');
    expect(env.paymentProvider).toBe('sandbox');
  });
});
