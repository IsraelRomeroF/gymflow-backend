import { describe, it, expect, vi } from 'vitest';
import { loadEnv } from '../src/platform/env.js';
import { decryptSecret } from '../src/platform/crypto.js';
import { ETIQUETA_ROSTRO, ETIQUETA_SALUD, derivarLlave, llaveDeDatos } from '../src/platform/sensitive.js';
import { FaceEngine } from '../src/modules/access/face.engine.js';

/**
 * LLAVE DE DATOS SENSIBLES (fase 0, bloque 0.3 · 21-17, 28-16).
 *
 * Cifra las notas de salud y las plantillas del rostro. Se llamaba como el 2FA
 * retirado; ahora tiene nombre propio y el anterior se acepta una versión.
 * Lo que importa es que lo ya cifrado se siga leyendo: los vectores de abajo
 * se generaron con el código ANTERIOR al cambio de nombre (MFA_ENCRYPTION_KEY).
 */
const K = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
const SALUD_ANTES = 'enc:v1:v1.EgGo2prQUdA7Nfcr.6CjL12Gtn0Q4fqB_-J82UQ.K40gSseX3B6MW_YiFsUKmy51ECqMPIV7';
const ROSTRO_ANTES = 'v1.piEpuy6pazRqnOsc.KGCvrMDFeLaFm9vA8aTAwA.sqn6ixjLwNEBrzB3tI5BSRU';

// Una base de pruebas unitarias: las reglas de arranque por perfil (0.1) no se meten aquí.
const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://gymflow_app:gymflow_app_dev@127.0.0.1:5432/gymflow_test_llave' } as NodeJS.ProcessEnv;

describe('llave de los datos sensibles', () => {
  it('con su nombre propio arranca, y quien lea el nombre anterior recibe la misma', () => {
    const env = loadEnv({ ...base, SENSITIVE_DATA_KEY: K });
    expect(env.SENSITIVE_DATA_KEY).toBe(K);
    expect(env.MFA_ENCRYPTION_KEY).toBe(K);
  });

  it('el nombre anterior se acepta esta versión, con el mismo valor', () => {
    const env = loadEnv({ ...base, MFA_ENCRYPTION_KEY: K });
    expect(env.SENSITIVE_DATA_KEY).toBe(K);
    expect(llaveDeDatos({ MFA_ENCRYPTION_KEY: K })?.nombre).toBe('MFA_ENCRYPTION_KEY');
    expect(llaveDeDatos({ MFA_ENCRYPTION_KEY: K, SENSITIVE_DATA_KEY: K })?.nombre).toBe('SENSITIVE_DATA_KEY');
  });

  it('no adivina ni arranca a medias: sin llave, con dos distintas o con una corta, se niega', () => {
    expect(() => loadEnv({ ...base })).toThrow(/Falta SENSITIVE_DATA_KEY/);
    const otra = Buffer.alloc(32, 9).toString('base64');
    expect(() => loadEnv({ ...base, SENSITIVE_DATA_KEY: K, MFA_ENCRYPTION_KEY: otra })).toThrow(/valores distintos/);
    expect(() => loadEnv({ ...base, SENSITIVE_DATA_KEY: Buffer.alloc(16, 1).toString('base64') })).toThrow(/SENSITIVE_DATA_KEY debe ser exactamente 32 bytes/);
    expect(() => loadEnv({ ...base, MFA_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') })).toThrow(/MFA_ENCRYPTION_KEY debe ser exactamente 32 bytes/);
    // Las dos con el mismo valor (a medio renombrar) arrancan.
    expect(() => loadEnv({ ...base, SENSITIVE_DATA_KEY: K, MFA_ENCRYPTION_KEY: K })).not.toThrow();
  });

  it('las notas de salud cifradas antes del cambio se leen igual con cualquiera de los dos nombres', () => {
    for (const fuente of [{ SENSITIVE_DATA_KEY: K }, { MFA_ENCRYPTION_KEY: K }]) {
      const llave = derivarLlave(ETIQUETA_SALUD, fuente);
      expect(decryptSecret(SALUD_ANTES.slice('enc:v1:'.length), llave)).toBe('Asma leve; usa inhalador');
    }
  });

  it('las plantillas del rostro guardadas antes del cambio se leen igual (el motor facial no se toca)', () => {
    const soloNueva = loadEnv({ ...base, SENSITIVE_DATA_KEY: K });
    expect(new FaceEngine(soloNueva).descifrar(ROSTRO_ANTES)).toEqual([0.125, -0.5, 0.75]);
    expect(JSON.parse(decryptSecret(ROSTRO_ANTES, derivarLlave(ETIQUETA_ROSTRO, { SENSITIVE_DATA_KEY: K })))).toEqual([0.125, -0.5, 0.75]);
    // Con otra llave no se descifra nada: por eso se respalda y no se reemplaza.
    expect(() => new FaceEngine(loadEnv({ ...base, SENSITIVE_DATA_KEY: Buffer.alloc(32, 9).toString('base64') })).descifrar(ROSTRO_ANTES)).toThrow();
  });

  it('con el nombre anterior la API arranca y lo avisa una sola vez; con el nuevo, nada', () => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      loadEnv({ ...base, NODE_ENV: 'development', SENSITIVE_DATA_KEY: K });
      expect(aviso).not.toHaveBeenCalled();
      loadEnv({ ...base, NODE_ENV: 'development', MFA_ENCRYPTION_KEY: K });
      loadEnv({ ...base, NODE_ENV: 'development', MFA_ENCRYPTION_KEY: K });
      expect(aviso).toHaveBeenCalledTimes(1);
      expect(String(aviso.mock.calls[0]![0])).toMatch(/MFA_ENCRYPTION_KEY es el nombre anterior de SENSITIVE_DATA_KEY.*MISMO valor/);
    } finally {
      aviso.mockRestore();
    }
  });
});
