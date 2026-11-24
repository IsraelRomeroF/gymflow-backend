import { uuidv7 } from '@gymflow/core';
import { GlobalRepository } from '../../platform/db/tenant-repository.js';

/** Cuánto se recuerda un equipo desde su último ingreso. */
export const EQUIPO_CONOCIDO_DIAS = 180;

/**
 * EQUIPOS CONOCIDOS (D-01, fase 3, bloque 3.1): el navegador en el que una
 * persona ya entró con su cuenta. El límite de intentos es por persona, no
 * por red: con la dirección fija cualquiera puede bloquearle la cuenta a la
 * dueña tecleando mal su contraseña, y su teléfono con datos cambia de IP
 * cada rato, así que «una IP en la que ya había entrado» no la reconoce. Su
 * navegador sí: guarda una llave al azar en una cookie y aquí queda solo su
 * sha256. Sirve únicamente junto con la contraseña correcta.
 */
export class KnownDeviceRepository extends GlobalRepository {
  /** ¿Esa persona ya entró desde ese equipo en los últimos `dias`? */
  async conocido(userId: string, keyHash: string, dias = EQUIPO_CONOCIDO_DIAS): Promise<boolean> {
    const n = await this.db.knownDevice.count({ where: { userId, keyHash, lastUsedAt: { gte: new Date(Date.now() - dias * 86_400_000) } } });
    return n > 0;
  }

  /** Lo anota (o renueva su último uso) al entrar con la contraseña correcta. */
  async anotar(userId: string, keyHash: string, label: string | null): Promise<void> {
    await this.db.knownDevice.upsert({
      where: { userId_keyHash: { userId, keyHash } },
      create: { id: uuidv7(), userId, keyHash, label },
      update: { lastUsedAt: new Date(), label },
    });
  }

  /** Olvida los equipos de una persona: al restablecerle la contraseña, vuelve a empezar. */
  async olvidar(userId: string): Promise<number> {
    const { count } = await this.db.knownDevice.deleteMany({ where: { userId } });
    return count;
  }
}
