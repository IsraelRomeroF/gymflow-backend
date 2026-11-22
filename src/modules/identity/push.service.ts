import webpush from 'web-push';
import { PushSubscriptionRepository } from './push-subscription.repository.js';

export type PushPayload = { title: string; body: string; url: string; tag?: string };

let configurado: { publicKey: string } | null | undefined;

/** Lee las llaves una vez. Sin llaves, el servicio existe pero no manda nada (y el panel no ofrece el botón). */
function llaves(): { publicKey: string } | null {
  if (configurado !== undefined) return configurado;
  const pub = process.env.VAPID_PUBLIC_KEY; const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) { configurado = null; return null; }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:soporte@gymflow.mx', pub, priv);
  configurado = { publicKey: pub };
  return configurado;
}

/**
 * Web Push al personal (DP-10): la firma llega al teléfono del dueño aunque el
 * panel esté cerrado. Sin proveedor externo: llaves VAPID propias. Nunca
 * lanza: un aviso que no llega no debe tirar la operación que lo originó.
 */
export class PushService {
  publicKey(): string | null { return llaves()?.publicKey ?? null; }

  async sendToUsers(organizationId: string, userIds: readonly string[], payload: PushPayload): Promise<number> {
    if (!llaves()) return 0;
    const repo = new PushSubscriptionRepository();
    const subs = await repo.forUsers(organizationId, userIds);
    let enviados = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 600, urgency: 'high' });
        await repo.markUsed(s.id);
        enviados += 1;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await repo.markDead(s.id);
      }
    }));
    return enviados;
  }
}
