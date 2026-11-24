import webpush from 'web-push';
import { uuidv7, validation } from '@gymflow/core';
import type { PortalNotificationPreferences, PortalNotificationTopic, PortalNotifications } from '@gymflow/core/contracts';
import { GlobalRepository, TenantRepository } from '../../platform/db/tenant-repository.js';
import { MemberNoticeRepository, type NoticeKind } from '../members/index.js';
import { MEMBER_IDLE_DAYS } from './portal.repository.js';

/**
 * NOTIFICACIONES AL TELÉFONO DEL SOCIO (fase 3, bloque 3.10; D-34 opción c).
 *
 * «Ninguna conexión con costo por ahora: notificaciones gratis». Son las del
 * navegador (Web Push) con las llaves VAPID del propio servidor, las mismas
 * del personal (DP-10): no hay proveedor contratado, ni SMS, ni WhatsApp
 * automático. Si el servidor no tiene llaves, no se manda nada y el portal no
 * ofrece encenderlas: los avisos siguen en la campana, como siempre.
 *
 * El socio las enciende y las apaga:
 *  · por teléfono: encender es suscribir ESE navegador; apagar borra la fila.
 *    La suscripción vive lo que la sesión del portal de ese teléfono.
 *  · por tema: pagos y clases se apagan por separado. Lo de seguridad (el
 *    portal se abrió en otro teléfono), la suspensión y lo de privacidad
 *    llegan siempre que las tenga encendidas.
 *
 * Nada de esto decide qué se avisa: eso sigue siendo `member_notices`. Aquí
 * solo se lleva al teléfono lo que ya nació como aviso. Nunca lanza: una
 * notificación que no llega no tira la operación que la originó.
 */

/** De qué tema es cada aviso; lo que no está aquí llega siempre. */
const TEMA: Readonly<Partial<Record<NoticeKind, PortalNotificationTopic>>> = {
  PAYMENT_DUE_SOON: 'payments',
  PAYMENT_OVERDUE: 'payments',
  CLASS_TOMORROW: 'classes',
};

/** A dónde lleva tocar la notificación. */
function destino(kind: NoticeKind): string {
  if (kind === 'PAYMENT_DUE_SOON' || kind === 'PAYMENT_OVERDUE' || kind === 'MEMBERSHIP_SUSPENDED') return '/pagos';
  if (kind === 'CLASS_TOMORROW') return '/clases';
  if (kind === 'NEW_DEVICE' || kind.startsWith('PRIVACY_')) return '/cuenta';
  return '/';
}

export type AvisoAlTelefono = { title: string; body: string; url: string; tag: string };
type Suscripcion = { id: string; endpoint: string; p256dh: string; auth: string };
/** Manda UNA notificación. Lanza con `statusCode` 404 o 410 si esa suscripción ya murió. */
export type Enviador = (s: Suscripcion, aviso: AvisoAlTelefono) => Promise<void>;

function llaves(): { subject: string; publicKey: string; privateKey: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY; const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return { subject: process.env.VAPID_SUBJECT ?? 'mailto:soporte@gymflow.mx', publicKey, privateKey };
}

const porWebPush: Enviador = async (s, aviso) => {
  const vapidDetails = llaves();
  if (!vapidDetails) return;
  await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(aviso), { vapidDetails, TTL: 12 * 3600, timeout: 8000 });
};

/** Solo para las pruebas: un enviador que no sale a internet y una llave pública de mentira. `null` restaura. */
let dePrueba: { enviador: Enviador; publicKey: string } | null = null;
export function usarEnviadorDePrueba(enviador: Enviador | null, publicKey = 'llave-publica-de-prueba'): void {
  dePrueba = enviador ? { enviador, publicKey } : null;
}

/** Los envíos en curso: un job los espera antes de terminar (`esperarEnvios`). */
const enCurso = new Set<Promise<unknown>>();
export async function esperarEnvios(): Promise<void> {
  await Promise.allSettled([...enCurso]);
}

/** Suscripciones del teléfono del socio. Globales: el `endpoint` es único en el mundo. */
export class MemberPushRepository extends GlobalRepository {
  /** Ese navegador pasa a ser de ESTE socio y de ESTA sesión (si antes era de otro, deja de serlo: D-09). */
  async upsert(input: { organizationId: string; memberId: string; sessionId: string; endpoint: string; p256dh: string; auth: string; userAgent: string | null }): Promise<void> {
    const datos = { organizationId: input.organizationId, memberId: input.memberId, sessionId: input.sessionId, p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent };
    await this.db.memberPushSubscription.upsert({ where: { endpoint: input.endpoint }, create: { id: uuidv7(), endpoint: input.endpoint, ...datos }, update: datos });
  }

  async remove(organizationId: string, memberId: string, endpoint: string): Promise<boolean> {
    const { count } = await this.db.memberPushSubscription.deleteMany({ where: { organizationId, memberId, endpoint } });
    return count > 0;
  }

  /** Al cerrar el portal en un teléfono, ese teléfono deja de recibir avisos. */
  async removeForSessionToken(tokenHash: string): Promise<number> {
    const { count } = await this.db.memberPushSubscription.deleteMany({ where: { session: { tokenHash } } });
    return count;
  }

  /** Al cerrarlo en todos (teléfono perdido, o recepción): ninguno recibe nada más. */
  async removeAllForMember(organizationId: string, memberId: string): Promise<number> {
    const { count } = await this.db.memberPushSubscription.deleteMany({ where: { organizationId, memberId } });
    return count;
  }

  /** Solo los teléfonos cuya sesión del portal sigue viva, de un socio que sigue en el padrón. */
  private vivas(organizationId: string, memberId: string) {
    return {
      organizationId, memberId,
      session: {
        revokedAt: null, expiresAt: { gt: new Date() },
        lastSeenAt: { gt: new Date(Date.now() - MEMBER_IDLE_DAYS * 86_400_000) },
        member: { deletedAt: null },
      },
    };
  }

  async countForMember(organizationId: string, memberId: string): Promise<number> {
    return this.db.memberPushSubscription.count({ where: this.vivas(organizationId, memberId) });
  }

  async forMember(organizationId: string, memberId: string): Promise<Suscripcion[]> {
    return this.db.memberPushSubscription.findMany({
      where: this.vivas(organizationId, memberId), select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
  }

  async markUsed(id: string): Promise<void> {
    await this.db.memberPushSubscription.updateMany({ where: { id }, data: { lastUsedAt: new Date() } });
  }

  /** El navegador dijo 404 o 410: esa suscripción murió. */
  async markDead(id: string): Promise<void> {
    await this.db.memberPushSubscription.deleteMany({ where: { id } });
  }
}

/** De qué quiere que se le notifique. Sin fila, todo encendido. */
class PreferenciasRepository extends TenantRepository {
  async de(memberId: string): Promise<PortalNotificationPreferences> {
    const fila = await this.db.memberNotificationPreference.findFirst({ where: this.scope({ memberId }), select: { payments: true, classes: true } });
    return fila ?? { payments: true, classes: true };
  }

  async guardar(memberId: string, cambios: Partial<PortalNotificationPreferences>): Promise<PortalNotificationPreferences> {
    const actual = await this.de(memberId);
    const nuevo = { ...actual, ...cambios };
    await this.db.memberNotificationPreference.upsert({
      where: { memberId },
      create: { memberId, organizationId: this.organizationId, ...nuevo },
      update: { ...nuevo, updatedAt: new Date() },
    });
    return nuevo;
  }
}

export class PortalNotificationsService {
  /** La llave con que el teléfono se suscribe, o `null` si este servidor no notifica. */
  publicKey(): string | null {
    return dePrueba?.publicKey ?? llaves()?.publicKey ?? null;
  }

  async estado(organizationId: string, memberId: string): Promise<PortalNotifications> {
    const publicKey = this.publicKey();
    const [devices, preferences] = await Promise.all([
      new MemberPushRepository().countForMember(organizationId, memberId),
      new PreferenciasRepository(organizationId).de(memberId),
    ]);
    return { available: publicKey !== null, publicKey, devices, preferences };
  }

  async guardarPreferencias(organizationId: string, memberId: string, cambios: Partial<PortalNotificationPreferences>): Promise<PortalNotifications> {
    await new PreferenciasRepository(organizationId).guardar(memberId, cambios);
    return this.estado(organizationId, memberId);
  }

  /** Encender en ESTE teléfono. */
  async suscribir(input: { organizationId: string; memberId: string; sessionId: string; endpoint: string; p256dh: string; auth: string; userAgent: string | null }): Promise<PortalNotifications> {
    if (!this.publicKey()) throw validation('Tu gimnasio todavía no tiene notificaciones al teléfono. Tus avisos siguen en la campana.');
    await new MemberPushRepository().upsert(input);
    return this.estado(input.organizationId, input.memberId);
  }

  /** Apagar en ESTE teléfono. */
  async desuscribir(organizationId: string, memberId: string, endpoint: string): Promise<PortalNotifications> {
    await new MemberPushRepository().remove(organizationId, memberId, endpoint);
    return this.estado(organizationId, memberId);
  }

  /**
   * UN AVISO AL SOCIO: nace en la campana (`member_notices`, idempotente por
   * `dedupeKey`) y, si es nuevo, sale a sus teléfonos con las notificaciones
   * encendidas, salvo que haya apagado ese tema. Devuelve cuántos avisos
   * nacieron (0 o 1), como `MemberNoticeRepository.emit`. El envío no se
   * espera aquí: no retrasa al job ni a la petición (`esperarEnvios`).
   */
  async avisar(organizationId: string, input: { memberId: string; kind: NoticeKind; title: string; body: string; dedupeKey: string }): Promise<number> {
    const creados = await new MemberNoticeRepository(organizationId).emit(input);
    if (creados === 0 || !this.publicKey()) return creados;
    const envio = this.alTelefono(organizationId, input).catch(() => 0);
    enCurso.add(envio);
    void envio.finally(() => enCurso.delete(envio));
    return creados;
  }

  /** Manda a los teléfonos del socio. Devuelve a cuántos llegó. */
  private async alTelefono(organizationId: string, aviso: { memberId: string; kind: NoticeKind; title: string; body: string; dedupeKey: string }): Promise<number> {
    const tema = TEMA[aviso.kind];
    if (tema && !(await new PreferenciasRepository(organizationId).de(aviso.memberId))[tema]) return 0;
    const repo = new MemberPushRepository();
    const telefonos = await repo.forMember(organizationId, aviso.memberId);
    const enviar = dePrueba?.enviador ?? porWebPush;
    // El `tag` agrupa en el teléfono: el mismo hecho avisado dos veces no deja dos globos.
    const carga: AvisoAlTelefono = { title: aviso.title, body: aviso.body, url: destino(aviso.kind), tag: aviso.dedupeKey.slice(0, 64) };
    let llegaron = 0;
    await Promise.all(telefonos.map(async (t) => {
      try {
        await enviar(t, carga);
        await repo.markUsed(t.id);
        llegaron += 1;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await repo.markDead(t.id);
      }
    }));
    return llegaron;
  }
}
