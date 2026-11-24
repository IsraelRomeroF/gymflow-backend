import { OWNER_ALERT_CATALOG, esOwnerAlertKind, OWNER_ALERT_KINDS, type OwnerAlertKind } from '@gymflow/core';
import { PushPreferenceRepository, PushService, PushSubscriptionRepository, type PushPayload } from '../identity/index.js';
import { OwnerAlertRepository, type NuevoAviso, type OwnerAlertRecord } from './owner-alert.repository.js';

/** Cómo sale un aviso al teléfono. Las pruebas ponen el suyo; el de verdad es `PushService`. */
export type EnviarAviso = (organizationId: string, userIds: readonly string[], payload: PushPayload) => Promise<number>;

/** Un aviso de la dueña vive un día en la cola del navegador: si el teléfono estaba apagado, le llega al encenderlo. */
const UN_DIA = 24 * 3600;

const enviarDeVerdad: EnviarAviso = (organizationId, userIds, payload) =>
  new PushService().sendToUsers(organizationId, userIds, payload, { ttl: UN_DIA, urgency: 'normal' });

/**
 * DAR UN AVISO A LA DUEÑA (bloque 4.2; D-05). Un solo camino para todos:
 *
 *  1. se guarda en `owner_alerts` (lo que se ve dentro del panel). Si ya
 *     existía con esa llave, aquí termina: no se manda dos veces;
 *  2. si no es «silencioso», sale al teléfono de quienes tienen el puesto
 *     Dueño, salvo a quien apagó ese tipo;
 *  3. se anota a cuántos equipos salió. Cero no es un error: sin llaves, sin
 *     equipo activado o con el tipo apagado, el aviso queda en el panel.
 *
 * Nunca lanza por el teléfono: un aviso que no suena no tira la corrida.
 */
export class OwnerAlertsService {
  constructor(private readonly enviar: EnviarAviso = enviarDeVerdad) {}

  async dar(organizationId: string, aviso: NuevoAviso, ahora: Date = new Date()): Promise<{ creado: boolean; equipos: number; aviso: OwnerAlertRecord | null }> {
    const repo = new OwnerAlertRepository(organizationId);
    const creado = await repo.crear(aviso);
    if (!creado) return { creado: false, equipos: 0, aviso: null };
    if (aviso.silent) return { creado: true, equipos: 0, aviso: creado };
    let equipos = 0;
    try {
      const duenos = await repo.duenos();
      if (duenos.length > 0) {
        equipos = await this.enviar(organizationId, duenos, { title: aviso.title, body: aviso.body, url: aviso.url, tag: `duena-${creado.id}`, kind: aviso.kind });
      }
    } catch { equipos = 0; }
    await repo.marcarMandado(creado.id, equipos, ahora);
    return { creado: true, equipos, aviso: { ...creado, pushedAt: ahora, pushDevices: equipos } };
  }

  /** «Qué avisos recibo»: el catálogo con lo que esta persona tiene encendido. */
  async preferencias(userId: string): Promise<Array<{ kind: OwnerAlertKind; label: string; description: string; inPanel: string; enabled: boolean }>> {
    const apagados = await new PushPreferenceRepository().apagados(userId);
    return OWNER_ALERT_KINDS.map((kind) => ({
      kind, label: OWNER_ALERT_CATALOG[kind].label, description: OWNER_ALERT_CATALOG[kind].description, inPanel: OWNER_ALERT_CATALOG[kind].inPanel,
      enabled: !apagados.has(kind),
    }));
  }

  async guardarPreferencia(organizationId: string, userId: string, kind: string, enabled: boolean): Promise<boolean> {
    if (!esOwnerAlertKind(kind)) return false;
    return new PushPreferenceRepository().guardar({ organizationId, userId, kind, enabled });
  }

  /** ¿El servidor puede avisar al teléfono, y en cuántos equipos lo tiene activo esta persona? */
  async telefono(userId: string): Promise<{ pushConfigured: boolean; devices: number }> {
    const pushConfigured = new PushService().publicKey() !== null;
    return { pushConfigured, devices: pushConfigured ? await new PushSubscriptionRepository().countForUser(userId) : 0 };
  }
}
