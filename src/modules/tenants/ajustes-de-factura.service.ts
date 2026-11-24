import { conflict, notFound, validation } from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { systemContext } from '../../platform/jobs/types.js';
import { hoyDeCobro } from './cobro-reglas.js';
import { estadoDeAjuste, textoDeAjuste, ultimoMesDe, type ClaseDeAjuste } from './factura-reglas.js';
import { PlatformInvoiceRulesRepository, type AjusteGuardado } from './factura.repository.js';
import { PlatformBillingRepository } from './platform-billing.repository.js';

/** Lo más que dura un descuento o un precio especial. Uno más largo se renueva con otro. */
export const MESES_MAX_DE_AJUSTE = 24;

export type AjusteJson = ReturnType<typeof serializarAjuste>;

export function serializarAjuste(a: AjusteGuardado, mesActual: string) {
  return {
    id: a.id, organizationId: a.organizationId, kind: a.kind, percentBps: a.percentBps, amountCents: a.amountCents?.toString() ?? null,
    fromMonth: a.fromMonth, lastMonth: ultimoMesDe(a), months: a.months, reason: a.reason, label: textoDeAjuste(a),
    status: estadoDeAjuste(a, mesActual), createdAt: a.createdAt.toISOString(), cancelReason: a.cancelReason,
  };
}

/**
 * DESCUENTO O PRECIO ESPECIAL DE UNA MARCA, POR MESES Y CON MOTIVO (D-39,
 * bloque 4.9). Quien lleva GymFlow dice desde la factura de qué mes, por
 * cuántos meses, cuánto (un porcentaje, un importe o el precio especial de la
 * mensualidad) y por qué. Vale SOLO para las facturas de esos meses y caduca
 * solo: no hay nada que acordarse de apagar. El motivo sale en el renglón de
 * la factura, y darlo o cancelarlo queda en la bitácora de la marca (y, por su
 * espejo, en la cadena de plataforma).
 *
 * Lo conservador: un solo ajuste vivo por marca y mes (no se apilan); no se
 * edita (se cancela y se da otro); no alcanza a un mes anterior al que corre;
 * y NUNCA toca una factura ya emitida: cancelarlo solo cambia las que faltan.
 */
export class BillingAdjustmentService {
  private readonly repo = new PlatformInvoiceRulesRepository();
  private readonly cobro = new PlatformBillingRepository();
  private readonly audit = new AuditService();

  async lista(organizationId: string, ahora = new Date()): Promise<{ month: string; adjustments: AjusteJson[] }> {
    if (!(await this.cobro.organization(organizationId))) throw notFound('Marca no encontrada');
    const mes = hoyDeCobro(ahora).slice(0, 7);
    return { month: mes, adjustments: (await this.repo.ajustesDe(organizationId)).map((a) => serializarAjuste(a, mes)) };
  }

  async crear(organizationId: string, input: { kind: ClaseDeAjuste; percentBps?: number | undefined; amountCents?: bigint | undefined; fromMonth: string; months: number; reason: string }, byUserId: string, ahora = new Date()): Promise<{ adjustment: AjusteJson; alreadyInvoiced: string[] }> {
    const hoy = hoyDeCobro(ahora);
    const mesActual = `${hoy.slice(0, 7)}-01`;
    if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(input.fromMonth)) throw validation('El descuento empieza en una factura: elige el día 1 de un mes');
    if (input.fromMonth < mesActual) throw validation('El descuento no puede empezar en un mes que ya pasó');
    if (!Number.isInteger(input.months) || input.months < 1 || input.months > MESES_MAX_DE_AJUSTE) throw validation(`Dura de 1 a ${MESES_MAX_DE_AJUSTE} meses`);
    if (input.kind === 'PERCENT') {
      if (input.percentBps === undefined || !Number.isInteger(input.percentBps) || input.percentBps < 1 || input.percentBps > 10_000) throw validation('El porcentaje va de 0.01 % a 100 %');
    } else if (input.amountCents === undefined || input.amountCents <= 0n) {
      throw validation(input.kind === 'AMOUNT' ? 'Escribe el importe del descuento' : 'Escribe el precio especial de la mensualidad');
    }
    const r = await this.repo.crearAjuste({
      organizationId, kind: input.kind, percentBps: input.kind === 'PERCENT' ? input.percentBps! : null, amountCents: input.kind === 'PERCENT' ? null : input.amountCents!,
      fromMonth: input.fromMonth, months: input.months, reason: input.reason, byUserId,
    });
    if (r === null) throw notFound('Marca no encontrada');
    if (r === 'ENCIMA') throw conflict('Esta marca ya tiene un descuento o un precio especial en alguno de esos meses: cancélalo antes de dar otro', 'BILLING_ADJUSTMENT_OVERLAP');
    await this.audit.record(systemContext(organizationId), {
      action: 'platform.billing.adjustment.create', resourceType: 'OrganizationBillingAdjustment', resourceId: r.id, reason: input.reason,
      afterState: {
        kind: r.kind, percentBps: r.percentBps, ...(r.kind === 'PERCENT' ? {} : { adjustmentCents: r.amountCents!.toString() }),
        fromMonth: r.fromMonth, lastMonth: ultimoMesDe(r), months: r.months, label: textoDeAjuste(r), byPlatformUserId: byUserId,
      },
    });
    // Los meses del ajuste que YA tienen factura viva: esas no cambian (se le dice a quien lo captura).
    const ultimo = ultimoMesDe(r);
    const yaFacturados = (await this.cobro.invoices(organizationId))
      .filter((f) => f.status !== 'VOID').map((f) => f.periodStart.toISOString().slice(0, 10))
      .filter((d) => d >= r.fromMonth && d <= ultimo).map((d) => d.slice(0, 7)).sort();
    return { adjustment: serializarAjuste(r, mesActual), alreadyInvoiced: yaFacturados };
  }

  /** Cancela un ajuste que no ha terminado. Las facturas ya emitidas con él no cambian; las que faltan salen sin él. */
  async cancelar(id: string, reason: string, byUserId: string, ahora = new Date()): Promise<AjusteJson> {
    const mesActual = `${hoyDeCobro(ahora).slice(0, 7)}-01`;
    const a = await this.repo.ajuste(id);
    if (!a) throw notFound('Descuento no encontrado');
    const estado = estadoDeAjuste(a, mesActual);
    if (estado === 'ENDED' || estado === 'CANCELED' || !(await this.repo.cancelarAjuste(id, byUserId, reason, ahora))) {
      throw conflict(estado === 'ENDED' ? 'Ese descuento ya terminó: no hay nada que cancelar' : 'Ese descuento ya estaba cancelado', 'BILLING_ADJUSTMENT_CLOSED');
    }
    await this.audit.record(systemContext(a.organizationId), {
      action: 'platform.billing.adjustment.cancel', resourceType: 'OrganizationBillingAdjustment', resourceId: id, reason,
      afterState: { label: textoDeAjuste(a), fromMonth: a.fromMonth, lastMonth: ultimoMesDe(a), months: a.months, byPlatformUserId: byUserId },
    });
    return serializarAjuste((await this.repo.ajuste(id))!, mesActual);
  }
}
