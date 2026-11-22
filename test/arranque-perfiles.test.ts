import { describe, it, expect } from 'vitest';
import {
  perfilDe, problemasDeArranque, procesadorEnUso, procesadorPorOmision, tipoDeBase, type Arranque,
} from '../src/platform/perfiles.js';

/**
 * ARRANQUE POR PERFILES (fase 0.1): uso real y pruebas no se confunden.
 *
 * Lo que se prueba es la regla, no el guion: la API se niega a arrancar con
 * una combinación que deja cobrar con la caja de arena en el gimnasio de
 * verdad, que sirve la base de pruebas en el puerto del mostrador o que abre
 * el uso real con una contraseña publicada.
 */
const usoReal = (over: Partial<Arranque> = {}): Arranque => ({
  NODE_ENV: 'development',
  API_PORT: 3001,
  DATABASE_URL: 'postgresql://gymflow_local_app:Una-Clave-Propia-1@127.0.0.1:5432/gymflow_local?schema=public',
  paymentProvider: 'none',
  trustedProxies: ['127.0.0.1', '::1'],
  CORS_ORIGINS: 'http://localhost:3003,http://localhost:3002',
  portalOrigins: ['http://localhost:3002'],
  ...over,
});

const pruebas = (over: Partial<Arranque> = {}): Arranque => ({
  NODE_ENV: 'development',
  API_PORT: 4001,
  DATABASE_URL: 'postgresql://gymflow_app:gymflow_app_dev@127.0.0.1:5432/gymflow_pruebas?schema=public',
  paymentProvider: 'sandbox',
  trustedProxies: ['127.0.0.1', '::1'],
  CORS_ORIGINS: 'http://localhost:4003,http://localhost:4002',
  portalOrigins: ['http://localhost:4002'],
  PORTAL_PUBLIC_URL: 'http://localhost:4002',
  ...over,
});

describe('perfiles de arranque', () => {
  it('el uso real completo y las pruebas completas arrancan', () => {
    expect(problemasDeArranque(usoReal())).toEqual([]);
    expect(problemasDeArranque(pruebas())).toEqual([]);
  });

  it('el uso real nunca cobra con la caja de arena (25-01)', () => {
    const p = problemasDeArranque(usoReal({ paymentProvider: 'sandbox' }));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/PAYMENT_PROVIDER=sandbox con la base gymflow_local/);
    expect(p[0]).toMatch(/Paga en recepción/);
  });

  it('la base de pruebas no se sirve en el puerto del mostrador, ni el uso real en el de las pruebas (27-01)', () => {
    expect(problemasDeArranque(pruebas({ API_PORT: 3001 }))[0]).toMatch(/gymflow_pruebas.*3001.*bash gymflow\.sh pruebas/);
    expect(problemasDeArranque(usoReal({ API_PORT: 4001 }))[0]).toMatch(/gymflow_local.*4001.*escribirían en el gimnasio de verdad/);
  });

  it('el uso real exige proxies de confianza: sin ellos todo el gimnasio es una sola IP (24-01)', () => {
    expect(problemasDeArranque(usoReal({ trustedProxies: [] }))[0]).toMatch(/TRUSTED_PROXIES=127\.0\.0\.1,::1/);
  });

  it('el uso real exige orígenes explícitos, no el valor de desarrollo', () => {
    for (const over of [{ CORS_ORIGINS: 'http://localhost:3000' }, { CORS_ORIGINS: '' }, { portalOrigins: [] }]) {
      expect(problemasDeArranque(usoReal(over))[0]).toMatch(/orígenes explícitos/);
    }
  });

  it('el uso real no se abre con una contraseña publicada en el repositorio', () => {
    for (const url of [
      'postgresql://gymflow_app:gymflow_app_dev@127.0.0.1:5432/gymflow_local?schema=public',
      'postgresql://gymflow_owner:gymflow_owner_dev@127.0.0.1:5432/gymflow_local',
      'postgresql://gymflow_app@127.0.0.1:5432/gymflow_local',
    ]) {
      const p = problemasDeArranque(usoReal({ DATABASE_URL: url }));
      expect(p, url).toHaveLength(1);
      expect(p[0]).toMatch(/gymflow_local_app/);
    }
  });

  it('en producción tampoco vale una contraseña de desarrollo', () => {
    const p = problemasDeArranque({
      ...usoReal(), NODE_ENV: 'production', API_PORT: 8080,
      DATABASE_URL: 'postgresql://gymflow_app:CAMBIAR@db.interna:5432/gymflow?schema=public',
    });
    expect(p).toEqual([expect.stringMatching(/^En producción la base no puede abrirse con la contraseña de desarrollo «CAMBIAR»/)]);
  });

  it('con el portal abierto al público (túnel o dominio) los proxies son obligatorios en cualquier base (9-05)', () => {
    const p = problemasDeArranque(pruebas({ trustedProxies: [] }));
    expect(p[0]).toMatch(/PORTAL_PUBLIC_URL.*TRUSTED_PROXIES es obligatoria/);
  });

  it('se dicen todos los problemas juntos, para no arreglar de uno en uno', () => {
    const p = problemasDeArranque(usoReal({
      paymentProvider: 'sandbox', trustedProxies: [], CORS_ORIGINS: 'http://localhost:3000',
      DATABASE_URL: 'postgresql://gymflow_app:gymflow_app_dev@127.0.0.1:5432/gymflow_local',
    }));
    expect(p).toHaveLength(4);
  });

  it('el tipo de base sale de su nombre exacto', () => {
    expect(tipoDeBase('gymflow_local')).toBe('uso-real');
    expect(tipoDeBase('gymflow_pruebas')).toBe('pruebas');
    expect(tipoDeBase('gymflow_test')).toBe('unitarias');
    expect(tipoDeBase('gymflow_test_a')).toBe('unitarias');
    expect(tipoDeBase('gymflow_dev')).toBe('desarrollo');
    // Ni la sombra del uso real ni una de ensayo son el uso real; tampoco son de pruebas.
    expect(tipoDeBase('gymflow_local_shadow')).toBe('otra');
    expect(tipoDeBase('gymflow_ensayo')).toBe('otra');
    expect(perfilDe('postgresql://x:y@h:5432/gymflow_local')).toBe('uso-real');
    expect(perfilDe('postgresql://x:y@h:5432/gymflow_test_a')).toBeNull();
  });

  it('sin PAYMENT_PROVIDER, la caja de arena solo nace en bases de prueba y nunca en producción', () => {
    expect(procesadorPorOmision('development', 'uso-real')).toBe('none');
    expect(procesadorPorOmision('development', 'otra')).toBe('none');
    expect(procesadorPorOmision('development', 'pruebas')).toBe('sandbox');
    expect(procesadorPorOmision('test', 'unitarias')).toBe('sandbox');
    expect(procesadorPorOmision('production', 'pruebas')).toBe('none');
  });

  it('quien pregunta sin cargar la configuración (los jobs) nunca obtiene la caja de arena en el uso real', () => {
    const local = 'postgresql://gymflow_local_app:x@127.0.0.1:5432/gymflow_local';
    expect(procesadorEnUso({ NODE_ENV: 'development', DATABASE_URL: local, PAYMENT_PROVIDER: 'sandbox' })).toBe('none');
    expect(procesadorEnUso({ NODE_ENV: 'development', DATABASE_URL: local })).toBe('none');
    const prueba = 'postgresql://gymflow_app:gymflow_app_dev@127.0.0.1:5432/gymflow_pruebas';
    expect(procesadorEnUso({ NODE_ENV: 'development', DATABASE_URL: prueba })).toBe('sandbox');
    expect(procesadorEnUso({ NODE_ENV: 'development', DATABASE_URL: prueba, PAYMENT_PROVIDER: 'none' })).toBe('none');
  });
});
