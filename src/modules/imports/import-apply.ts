import { cycleChargeKey, formatMoney, mismoRegistroDeSaldo, money, type CampoDudoso } from '@gymflow/core';
import type { RequestContext } from '../../platform/context.js';
import { BranchRepository } from '../organization/index.js';
import type { PlanRecord, PlanRepository } from '../catalog/index.js';
import { LegacyCodeRepository, MemberRepository, MemberService } from '../members/index.js';
import { MembershipRepository } from '../memberships/index.js';
import { BillingService, ChargeRepository, PaymentRepository } from '../billing/index.js';
import { MemberImportRepository, type ImportRecord, type ImportRowRecord } from './import.repository.js';
import { origenDeLaFila } from './import-stage.js';

/**
 * APLICAR UNA FILA (paso 3 de la importación, docs/09 §5): crear o completar
 * la ficha, guardar el código anterior, el saldo inicial y la vigencia. Y la
 * regla de las claves por socio: un socio recibe a lo más un saldo inicial por
 * registro del sistema anterior (D18-01). Lo llama `ImportService.applyBatch`,
 * una fila por transacción.
 */

/** Un día de calendario hecho instante va a las 18:00Z: mediodía en CDMX, el mismo día en todo México. */
const instante = (d: Date): Date => new Date(`${d.toISOString().slice(0, 10)}T18:00:00.000Z`);
/** Un saldo como lo dice una persona: "$650.00" si debe, "$50.00 a favor" si no. */
const saldo = (c: bigint) => (c < 0n ? `${formatMoney(money(-c))} a favor` : formatMoney(money(c)));
const fechaCorta = (d: Date) => d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Mexico_City' });

/** Aplica UNA fila dentro de su transacción. Devuelve false si otra petición ya la había aplicado. */
export async function aplicarFila(
  ctx: RequestContext, imp: ImportRecord, hoy: Date, row: ImportRowRecord, branchId: string,
  plan: PlanRecord | null, precioPactadoCents: bigint | null,
  /** Nombre de la sucursal de casa de la importación: el origen de los códigos de las filas sin sucursal. */
  sedeDeCasa: string,
): Promise<boolean> {
  const orgId = ctx.tenant.organizationId;
  const repo = new MemberImportRepository(orgId);
  if (!(await repo.claim(row.id))) return false;
  const members = new MemberRepository(orgId);
  const notas: string[] = [];
  const joinedAt = row.joinedAt ? instante(row.joinedAt) : null;

  // ¿A quién va? Socio existente, la ficha que creó su fila principal, o uno nuevo.
  let memberId: string | null = null;
  if (row.decision === 'MERGE') {
    memberId = row.matchMemberId ?? (row.matchRowId ? await repo.appliedMemberOf(row.matchRowId) : null);
    // El candado del saldo va antes que cualquier asiento de bitácora: mismo orden en toda fila.
    if (memberId) await repo.lockMemberBalance(memberId);
    const destino = memberId ? await members.findByIdIncludingArchived(memberId) : null;
    if (!destino || destino.anonymizedAt) memberId = null;
    // Un exsocio que viene en el archivo vuelve con su ficha (PS-04).
    else if (destino.status === 'ARCHIVED') {
      await new MemberService().reactivate(ctx, destino.id, 'Volvió en la importación de la base');
      notas.push('Se reactivó su ficha dada de baja');
    }
    if (memberId) {
      const completados = await members.fillFromImport(memberId, {
        phoneE164: row.phoneE164, email: row.email, birthDate: row.birthDate, curp: row.curp, joinedAt,
      });
      if (completados.length) notas.push(`Se completó: ${completados.map((k) => CAMPO[k] ?? k).join(', ')}`);
    } else {
      // La principal se omitió: esta fila es la persona.
      notas.push('Su fila principal se omitió: se dio de alta con esta');
    }
  }
  const esNuevo = !memberId;
  if (!memberId) {
    const sede = await new BranchRepository(orgId).findById(branchId);
    // El celular es único por gimnasio: el de una familia lo conserva quien
    // ya lo tenía, y a esta persona se le guarda en sus notas.
    let phoneE164 = row.phoneE164;
    let notasFicha = row.notes;
    if (phoneE164 && (await members.isPhoneTaken(phoneE164))) {
      notas.push(`Su celular ya es de otro socio: quedó en sus notas`);
      notasFicha = [row.notes, `Celular del sistema anterior: ${phoneE164}`].filter(Boolean).join(' · ');
      phoneE164 = null;
    }
    // Sin apellidos entra sin apellidos (18-10): «Juan —» salía así en el padrón, la credencial y el portal.
    if (!row.lastName) notas.push('Entró sin apellidos: complétalos en su ficha');
    const creado = await members.create({
      firstName: row.firstName, lastName: row.lastName,
      phoneE164, email: row.email, birthDate: row.birthDate, curp: row.curp,
      homeBranchId: branchId, notes: notasFicha, joinedAt, createdByUserId: ctx.tenant.actorUserId!,
    }, sede?.code ?? 'GEN');
    memberId = creado.id;
  }

  if (row.legacyCode) {
    await new LegacyCodeRepository(orgId).add({ memberId, code: row.legacyCode, source: origenDeLaFila(row.branchLabel, sedeDeCasa), importId: imp.id });
  }

  // Saldo inicial (docs/09 §5): un cargo por registro del sistema anterior,
  // nunca el historial de pagos, y nunca dos veces el mismo (D18-01).
  let cargado: bigint | null = null;
  if (row.balanceCents) {
    // Una ficha recién creada en esta fila no tiene saldos previos.
    const yaLoTenia = esNuevo ? null : await saldoYaCargado(orgId, imp.id, memberId, row, 'aplicada');
    if (yaLoTenia) notas.push(yaLoTenia);
    else if (row.balanceCents > 0n) {
      await new ChargeRepository(orgId).create({
        memberId, branchId, chargeType: 'OPENING_BALANCE',
        concept: `Saldo del sistema anterior${row.legacyCode ? ` (código ${row.legacyCode})` : ''}`,
        subtotalCents: row.balanceCents, dueDate: imp.cutoffDate, idempotencyKey: `import:${row.id}:saldo`,
        createdByUserId: ctx.tenant.actorUserId ?? null,
      });
      cargado = row.balanceCents;
    } else {
      // Saldo a favor: un abono sin cargo, como nota de crédito. No es ingreso.
      await new PaymentRepository(orgId).record({
        memberId, branchId, method: 'CREDIT_NOTE', amountCents: -row.balanceCents, businessDate: imp.cutoffDate,
        idempotencyKey: `import:${row.id}:favor`, createdByUserId: ctx.tenant.actorUserId ?? null,
      });
      cargado = row.balanceCents;
    }
  }

  // Vigencia: una membresía activa hasta el día que decía el sistema anterior.
  if (row.periodEnd) {
    const fin = new Date(row.periodEnd.getTime() + 86_400_000); // semiabierto: vigente hasta ese día inclusive
    const memberships = new MembershipRepository(orgId);
    if (!plan) notas.push(row.planLabel ? `No se cargó su vigencia: se decidió no cargar el plan "${row.planLabel}"` : 'No se cargó su vigencia: se decidió no cargar las vigencias sin plan');
    else if (fin <= hoy) notas.push('Su vigencia ya venció: no se creó membresía');
    else if (await memberships.findLiveForMember(memberId)) notas.push('Ya tenía una membresía vigente: no se creó otra');
    else {
      const inicio = inicioDePeriodo(fin, plan.durationUnit, plan.durationValue);
      // Precio pactado (16-04, DM-05): como en una venta, el vigente del plan
      // en su sucursal al importar. Sin él, la renovación cobraría el precio
      // de lista de ese día y fallaría si la sede deja de vender el plan.
      // Con D-19 (bloque 3.6) un cambio de precio del plan también le toca: entra
      // al precio de lista y, como cualquier venta a precio de lista, sigue al plan.
      const pactado = precioPactadoCents ?? plan.priceCents;
      const m = await memberships.create({
        memberId, planId: plan.id, soldAtBranchId: branchId, startDate: inicio, periodStart: inicio, periodEnd: fin,
        billingAnchorDay: fin.getUTCDate(), autoRenew: plan.billingModel === 'RECURRING' && plan.autoRenewDefault,
        branchIds: [], createdByUserId: ctx.tenant.actorUserId!, agreedPriceCents: pactado,
      });
      await memberships.transition({
        membershipId: m.id, fromStatus: 'PENDING', toStatus: 'ACTIVE', eventType: 'ACTIVATED',
        payload: { origen: 'importacion', importId: imp.id, rowNumber: row.rowNumber, agreedPriceCents: pactado.toString() },
        reason: 'Vigencia del sistema anterior', actorUserId: ctx.tenant.actorUserId ?? null, branchId, businessDate: hoy,
      });
      // La cuota de ese periodo ya se pagó en el sistema anterior. Se emite
      // con la misma clave que usaría el job nocturno y se deja en cero con
      // un ajuste: así `generate-cycle-charges` no la vuelve a emitir, la
      // mora no la ve, y "Ganado" no la cuenta (DM-01).
      const cargos = new ChargeRepository(orgId);
      const { charge, created } = await cargos.create({
        memberId, membershipId: m.id, branchId, chargeType: 'MEMBERSHIP_PERIOD',
        concept: `${plan.name} · ${inicio.toISOString().slice(0, 10)} a ${fin.toISOString().slice(0, 10)} · cubierto en el sistema anterior`,
        subtotalCents: pactado, periodStart: inicio, periodEnd: fin, dueDate: inicio,
        idempotencyKey: cycleChargeKey(m.id, inicio), createdByUserId: ctx.tenant.actorUserId ?? null,
      });
      if (created && charge.amountCents > 0n) {
        await cargos.adjust({
          chargeId: charge.id, adjustmentType: 'CORRECTION', amountCents: charge.amountCents,
          reason: 'Cubierto en el sistema anterior (importación)', reasonCode: 'MIGRACION',
          createdByUserId: ctx.tenant.actorUserId ?? null, today: hoy,
        });
      }
    }
  }

  // Lo que decidió una persona sobre los datos que no se entendían (D18-02).
  if (row.dataStatus === 'WITHOUT') notas.push(`Entró sin: ${row.doubtful.map((d) => DATO[d.field]).join(', ')} (no se entendía en el archivo)`);
  if (row.dataStatus === 'FIXED') notas.push(`Se corrigió a mano: ${row.doubtful.map((d) => DATO[d.field]).join(', ')}`);

  if (cargado !== null && cargado < 0n) await new BillingService().applyCredit(ctx, memberId);
  if (cargado !== null) await new BillingService().refreshCachedBalance(orgId, memberId);
  await repo.markApplied(row.id, memberId, notas.length ? notas.join(' · ') : null, cargado);
  return true;
}

/**
 * ¿El socio ya tiene este saldo inicial? (D18-01). Devuelve la nota para la
 * fila o null si se puede cargar. Al aplicar se consulta con el candado del
 * socio tomado, así que dos importaciones a la vez no cargan las dos; en la
 * revisión (`'revision'`) es el aviso previo, con la misma regla.
 *
 * · Ya lo cargó una importación (otra, o un renglón anterior de esta) para
 *   el mismo registro del sistema anterior → no se vuelve a cargar; si el
 *   importe cambió, se dice y se corrige en la ficha con motivo.
 * · Tiene un saldo inicial capturado a mano en GymFlow → no se sabe de qué
 *   registro es y no se adivina: no se carga el del archivo y se dice.
 */
export async function saldoYaCargado(orgId: string, importId: string, memberId: string, row: ImportRowRecord, momento: 'revision' | 'aplicada'): Promise<string | null> {
  const archivo = row.balanceCents;
  if (!archivo) return null;
  const ya = momento === 'aplicada';
  const previo = (await new MemberImportRepository(orgId).loadedBalancesOf(memberId)).find((x) => x.id !== row.id && mismoRegistroDeSaldo(x, row));
  if (previo) {
    const deDonde = previo.importId === importId ? `renglón ${previo.rowNumber} de este archivo` : `importación del ${fechaCorta(previo.appliedAt)}`;
    return `${ya ? 'Ya tenía' : 'Ya tiene'} su saldo inicial de ${saldo(previo.balanceLoadedCents)} (${deDonde}): ${ya ? 'no se volvió a cargar' : 'no se vuelve a cargar'}`
      + (previo.balanceLoadedCents !== archivo ? `; el archivo trae ${saldo(archivo)}: si cambió, corrígelo en su ficha con motivo` : '');
  }
  const aMano = (await new ChargeRepository(orgId).listForMember(memberId, { limit: 100 }))
    .find((c) => c.chargeType === 'OPENING_BALANCE' && c.status !== 'VOID' && !c.idempotencyKey?.startsWith('import:'));
  if (aMano) return `Ya tiene un saldo inicial capturado en GymFlow (${saldo(aMano.amountCents)}): ${ya ? 'no se cargó' : 'no se cargará'} el del archivo (${saldo(archivo)}); si es otro, regístralo en su ficha con motivo`;
  return null;
}

const CAMPO: Record<string, string> = { phoneE164: 'teléfono', email: 'correo', birthDate: 'fecha de nacimiento', curp: 'CURP', joinedAt: 'antigüedad' };
const DATO: Record<CampoDudoso, string> = { balance: 'saldo', periodEnd: 'vigencia', joinedAt: 'fecha de alta' };

/**
 * Precio pactado de una vigencia importada (16-04): el del plan en esa
 * sucursal (su precio propio si lo tiene; si no, el de lista), aunque la sede
 * ya no lo venda a socios nuevos: la regla de `precioDeCuota` del consolidado.
 */
export async function precioPactado(planes: PlanRepository, plan: PlanRecord, branchId: string): Promise<bigint> {
  const sede = (await planes.availabilityFor(plan.id)).find((a) => a.branchId === branchId);
  return sede?.priceOverrideCents ?? plan.priceCents;
}

/** El inicio del periodo que termina en `fin`, contando hacia atrás la duración del plan. */
function inicioDePeriodo(fin: Date, unidad: string, valor: number): Date {
  if (unidad === 'DAY') return new Date(fin.getTime() - valor * 86_400_000);
  if (unidad === 'WEEK') return new Date(fin.getTime() - valor * 7 * 86_400_000);
  const y = fin.getUTCFullYear();
  const m = fin.getUTCMonth() - valor;
  const ultimo = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(fin.getUTCDate(), ultimo)));
}
