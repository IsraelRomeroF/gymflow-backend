/**
 * PASE DE PRUEBA (auditoría 8, fase 3, bloque 3.3; D-08).
 *
 * «¿Cómo entra a probar alguien que todavía no es socio?» Con un pase de
 * prueba: gratis, UNO por persona (por celular) y registrado como entrada.
 *
 *   · No mueve dinero: no hay cargo, ni cobro, ni caja.
 *   · Vale el día de operación y la sede donde se dio, como el pase del día.
 *   · Uno por celular en TODO el gimnasio (no uno por sucursal) y uno por
 *     ficha: quien cambie de número no estrena otro.
 *   · Es para quien viene por primera vez: quien ya tiene o tuvo plan,
 *     paquete o pase del día no es una visita de prueba.
 *
 * Darlo no registra la entrada: eso lo hace la puerta (`POST /access/attempts`),
 * que lo reconoce en la política (`subject.trialPass`) y deja la decisión y la
 * asistencia como las de cualquiera.
 */
import { conflict, notFound, validation, type ErrorReason } from '@gymflow/core';
import type { RequestContext } from '../../platform/context.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { MemberRepository } from '../members/index.js';
import { MembershipRepository, VisitPackRepository } from '../memberships/index.js';
import { DayPassRepository } from './day-pass.repository.js';
import { TrialPassRepository, digitosDelCelular, huellaDelCelular, type TrialPassRecord } from './day-pass-prueba.repository.js';

export type TrialPassBlock = Extract<ErrorReason, 'TRIAL_PASS_ALREADY_USED' | 'TRIAL_PASS_NEEDS_PHONE' | 'TRIAL_PASS_NOT_FIRST_TIME'> | 'MEMBER_ARCHIVED';

export type TrialPassView = TrialPassRecord & { validToday: boolean };

const fechaCorta = (d: Date) => new Intl.DateTimeFormat('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(d);

async function ver(orgId: string, pase: TrialPassRecord): Promise<TrialPassView> {
  const hoy = await new BusinessCalendar(orgId).today(pase.branchId);
  return { ...pase, validToday: pase.validOn.getTime() === hoy.getTime() };
}

/**
 * ¿Se le puede dar? Una sola regla para la pregunta (`GET`) y para darlo
 * (`POST`). `phoneKey` y `phoneLast4` vienen cuando sí se puede.
 */
async function revisar(orgId: string, memberId: string): Promise<
  | { ok: true; phoneKey: string; phoneLast4: string }
  | { ok: false; block: TrialPassBlock; text: string; pass: TrialPassRecord | null }
> {
  const member = await new MemberRepository(orgId).findByIdIncludingArchived(memberId);
  if (!member) throw notFound('Socio no encontrado');
  const pases = new TrialPassRepository(orgId);

  const suyo = await pases.deSocio(memberId);
  if (suyo) return { ok: false, block: 'TRIAL_PASS_ALREADY_USED', pass: suyo, text: `Ya usó su pase de prueba el ${fechaCorta(suyo.validOn)}. Es uno por persona.` };
  if (member.status === 'ARCHIVED') return { ok: false, block: 'MEMBER_ARCHIVED', pass: null, text: 'Está dado de baja: reactívalo antes de darle un pase de prueba.' };

  const digitos = digitosDelCelular(member.phoneE164);
  if (!digitos) return { ok: false, block: 'TRIAL_PASS_NEEDS_PHONE', pass: null, text: 'Falta su celular: el pase de prueba es uno por persona y se identifica por su celular. Captúralo en su ficha.' };
  const phoneKey = huellaDelCelular(orgId, digitos);
  const phoneLast4 = digitos.slice(-4);
  const deEseCelular = await pases.deCelular(phoneKey);
  if (deEseCelular) {
    return { ok: false, block: 'TRIAL_PASS_ALREADY_USED', pass: null, text: `El celular que termina en ${phoneLast4} ya usó su pase de prueba el ${fechaCorta(deEseCelular.validOn)}, con otra ficha. Es uno por celular.` };
  }

  // Es para quien viene por primera vez.
  const [membresias, paquetes, pasesDelDia] = await Promise.all([
    new MembershipRepository(orgId).listForMember(memberId),
    new VisitPackRepository(orgId).listForMember(memberId),
    new DayPassRepository(orgId).totalPagados(memberId),
  ]);
  if (membresias.length > 0 || paquetes.length > 0 || pasesDelDia > 0) {
    return { ok: false, block: 'TRIAL_PASS_NOT_FIRST_TIME', pass: null, text: 'El pase de prueba es para quien viene por primera vez: ya tiene o tuvo un plan, un paquete o un pase del día.' };
  }
  return { ok: true, phoneKey, phoneLast4 };
}

/** `GET /members/:id/trial-pass`: su pase (si ya lo usó) y, si no, si se le puede dar. */
export async function trialPassOf(ctx: RequestContext, memberId: string): Promise<{ pass: TrialPassView | null; eligible: boolean; blockedBy: TrialPassBlock | null; blockedText: string | null }> {
  const orgId = ctx.tenant.organizationId;
  const r = await revisar(orgId, memberId);
  if (r.ok) return { pass: null, eligible: true, blockedBy: null, blockedText: null };
  return { pass: r.pass ? await ver(orgId, r.pass) : null, eligible: false, blockedBy: r.block, blockedText: r.text };
}

/**
 * Da el pase de prueba: vale HOY en esa sede. Repetirlo el mismo día en la
 * misma sede devuelve el mismo pase (`created: false`): el doble clic no es
 * un error. Cualquier otro «ya lo usó» es un 409 con su porqué.
 */
export async function grantTrialPass(ctx: RequestContext, input: { memberId: string; branchId: string }): Promise<{ pass: TrialPassView; created: boolean }> {
  const orgId = ctx.tenant.organizationId;
  const pases = new TrialPassRepository(orgId);
  const hoy = await new BusinessCalendar(orgId).today(input.branchId);

  const r = await revisar(orgId, input.memberId);
  if (!r.ok) {
    // El mismo pase, pedido otra vez hoy en la misma sede.
    if (r.pass && r.pass.branchId === input.branchId && r.pass.validOn.getTime() === hoy.getTime()) return { pass: await ver(orgId, r.pass), created: false };
    if (r.block === 'MEMBER_ARCHIVED') throw conflict(r.text);
    if (r.block === 'TRIAL_PASS_NEEDS_PHONE') throw validation(r.text, undefined, r.block);
    throw conflict(r.text, r.block);
  }

  try {
    return await enUnaTransaccion(async () => {
      const pase = await pases.crear({
        memberId: input.memberId, branchId: input.branchId, phoneKey: r.phoneKey, phoneLast4: r.phoneLast4,
        validOn: hoy, grantedByUserId: ctx.tenant.actorUserId ?? null,
      });
      await new AuditService().record(ctx, {
        action: 'access.trial_pass.grant', resourceType: 'TrialPass', resourceId: pase.id, branchId: input.branchId,
        afterState: { memberId: input.memberId, validOn: hoy.toISOString().slice(0, 10), phoneLast4: r.phoneLast4 },
      });
      return { pass: await ver(orgId, pase), created: true };
    });
  } catch (e) {
    // Otro mostrador lo dio en este mismo instante (al mismo socio o con el mismo celular).
    if (isUniqueViolation(e)) throw conflict('Ese pase de prueba se acaba de dar en otro mostrador. Es uno por persona.', 'TRIAL_PASS_ALREADY_USED');
    throw e;
  }
}
