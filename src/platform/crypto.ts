import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * Cifrado simétrico para datos en reposo: las notas de salud, las plantillas
 * del rostro y el token de una firma a distancia, cada uso con su llave
 * derivada de la de datos sensibles (`sensitive.ts`).
 * AES-256-GCM: autenticado, así que una alteración del texto cifrado se
 * detecta al descifrar en lugar de producir basura silenciosa.
 */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [version, ivB64, tagB64, dataB64] = payload.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Formato de secreto cifrado no reconocido');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

/** Identificador opaco de sesión: 256 bits. Solo su sha256 se guarda. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
