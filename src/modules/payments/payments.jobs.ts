import { unknownNeedsEscalation } from '@gymflow/core';
import type { JobResult } from '../../platform/jobs/types.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { AttemptRepository } from './attempt.repository.js';
import { PaymentMethodRepository } from './payment-method.repository.js';
import { WebhookRepository } from './webhook.repository.js';
import { PaymentsService } from './payments.service.js';
import { getPaymentProvider, onlinePaymentsEnabled } from './provider/index.js';

const LOTE = 100;

/** Sin procesador conectado no hay nada que procesar ni a quién reconsultar. */
const sinProcesador = (job: string): JobResult => ({ job, processed: 0, skipped: 0, batches: 0, truncated: false, errors: [] });
const MAX_LOTES = 50;

/**
 * Procesa la cola de eventos.
 *
 * Aquí, y no en la petición del webhook: la ingesta responde 200 y encola. Si
 * este job falla, el evento sigue en la cola con su carga cruda intacta.
 */
async function procesarWebhooks(organizationId: string): Promise<JobResult> {
  if (!onlinePaymentsEnabled()) return sinProcesador('payments.process-webhooks');
  const repo = new WebhookRepository();
  const provider = getPaymentProvider(process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev');
  const service = new PaymentsService(provider);
  const errors: JobResult['errors'] = [];
  let processed = 0;
  let skipped = 0;
  let batches = 0;

  // 1. Atribuir. Un evento se ata a la organización del pago que menciona;
  //    si ese pago todavía no existe se reintenta, y tras varios intentos va
  //    a la bandeja muerta en lugar de bloquear la cola.
  let cursor: string | null = null;
  for (let vuelta = 0; vuelta < MAX_LOTES; vuelta++) {
    const lote = await repo.unattributed(LOTE, cursor);
    if (lote.length === 0) break;
    for (const event of lote) {
      let ref: string | null = null;
      try { ref = provider.parseEvent(JSON.stringify(event.rawPayload)).providerPaymentId; } catch { ref = null; }
      if (!ref) { await repo.markIgnored(event.id, 'El evento no menciona ningún pago'); continue; }
      const org = await repo.organizationForProviderPayment(ref);
      if (org) await repo.attribute(event.id, org);
      else await repo.markFailed(event.id, 'No hay ningún pago con esa referencia (todavía)');
    }
    cursor = lote[lote.length - 1]!.id;
  }

  // 2. Aplicar los de ESTA organización, drenando por lotes.
  const vistos = new Set<string>();
  while (batches < MAX_LOTES) {
    const lote = (await repo.pending(organizationId, LOTE)).filter((e) => !vistos.has(e.id));
    if (lote.length === 0) break;
    batches += 1;
    for (const event of lote) {
      vistos.add(event.id);
      try {
        const parsed = provider.parseEvent(JSON.stringify(event.rawPayload));
        const outcome = await service.applyEvent(organizationId, {
          type: parsed.type,
          providerPaymentId: parsed.providerPaymentId,
          payload: parsed.payload,
        });
        if (outcome === 'APPLIED') {
          await repo.markProcessed(event.id, organizationId);
          processed += 1;
        } else {
          // Tipo desconocido, reenvío o transición que no procede: se cierra
          // CON su motivo. Dejarlo en RECEIVED era lo que atascaba la cola.
          await repo.markIgnored(event.id, 'No aplica al pago en su estado actual');
          skipped += 1;
        }
      } catch (error) {
        await repo.markFailed(event.id, error instanceof Error ? error.message : 'error');
        errors.push({ entityId: event.id, error: 'No se pudo aplicar el evento' });
      }
    }
  }

  return {
    job: 'payments.process-webhooks',
    processed, skipped, batches,
    truncated: batches >= MAX_LOTES,
    errors,
  };
}

/**
 * Cierra los intentos sin respuesta reconsultando al procesador.
 *
 * Es la única salida de `UNKNOWN`. Lo que no se resuelve en 24 h se marca
 * como error del job **a propósito**: pasa a ser trabajo de una persona, y no
 * se auto-resuelve nunca.
 */
async function resolverDesconocidos(organizationId: string): Promise<JobResult> {
  if (!onlinePaymentsEnabled()) return sinProcesador('payments.resolve-unknown');
  const attempts = new AttemptRepository(organizationId);
  const service = PaymentsService.withDefaults(process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev');

  const pendientes = await attempts.unresolved(LOTE);
  const errors: JobResult['errors'] = [];
  let processed = 0;

  const ahora = new Date();
  for (const attempt of pendientes) {
    try {
      await service.resolveUnknown(organizationId, attempt.id);
      processed += 1;
    } catch {
      if (unknownNeedsEscalation(attempt.attemptedAt, ahora)) {
        errors.push({
          entityId: attempt.id,
          error: 'Más de 24 h sin resolver: va a la bandeja de conciliación',
        });
      }
    }
  }

  return {
    job: 'payments.resolve-unknown',
    processed,
    skipped: pendientes.length - processed,
    batches: 1,
    truncated: pendientes.length === LOTE,
    errors,
  };
}

/**
 * Marca vencidas las tarjetas que ya no sirven.
 *
 * Avisar ANTES de que falle el cobro cuesta un mensaje; enterarse DESPUÉS
 * cuesta un cobro fallido, un socio en la puerta y una llamada.
 */
async function marcarTarjetasVencidas(organizationId: string): Promise<JobResult> {
  const repo = new PaymentMethodRepository(organizationId);
  // El mes es el del gimnasio, no el de UTC (2.13): una tarjeta de junio sirve
  // hasta que junio termina en TODAS sus sedes (antes se marcaba vencida desde
  // las 18:00 del día 30 en la Ciudad de México). `cierre` es una fecha de
  // calendario guardada a medianoche UTC: sus partes UTC son las de esa fecha.
  const hoy = (await new BusinessCalendar(organizationId).dias()).cierre;
  const vencidas = await repo.expiringBefore(hoy.getUTCFullYear(), hoy.getUTCMonth());

  for (const m of vencidas) await repo.markExpired(m.id);

  return {
    job: 'payments.expire-cards',
    processed: vencidas.length,
    skipped: 0, batches: 1, truncated: false, errors: [],
  };
}

export const PAYMENT_JOBS = [
  // Cada 15 minutos (bloque 1.16): el dinero en tránsito no espera al cierre.
  { name: 'payments.process-webhooks', handler: procesarWebhooks, cadence: 'frequent' },
  { name: 'payments.resolve-unknown', handler: resolverDesconocidos, cadence: 'frequent' },
  { name: 'payments.expire-cards', handler: marcarTarjetasVencidas },
] as const;
