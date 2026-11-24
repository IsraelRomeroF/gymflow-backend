import { conflict, notFound } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { descifrarSensible } from '../../platform/sensitive.js';
import { etiqueta, fecha, hora, momento, pesos } from './etiquetas.js';
import type { RequestContext } from '../../platform/context.js';
import { MemberRepository } from '../members/index.js';
import { ProspectRepository } from '../prospects/index.js';
import { IntakeRepository } from '../intake/index.js';
import { EnrollmentService } from '../access/index.js';
import { PaymentMethodRepository } from '../payments/index.js';
import { TrainingRepository } from '../training/index.js';
import { olvidarTextosDeMensajes } from '../outbound/index.js';
import { MemberPushRepository } from '../portal/index.js';
import { OrganizationRepository } from '../organization/index.js';
import { PrivacyRequestsService } from './privacy-requests.service.js';

/**
 * Lectura de todo lo que el gimnasio guarda de una persona, con nombres en
 * vez de ids (PS-01): el archivo lo abre el socio, no un programador. Solo lee.
 */
class ExportRepository extends TenantRepository {
  async todo(memberId: string) {
    const where = { organizationId: this.organizationId, memberId };
    const sucursal = { select: { name: true } } as const;
    const [consents, memberships, charges, payments, visitPacks, attendance, classBookings, routines, biometrics, intakes] = await Promise.all([
      this.db.memberConsent.findMany({
        where, orderBy: { grantedAt: 'asc' },
        select: { consentType: true, documentVersion: true, documentText: true, granted: true, grantedAt: true, revokedAt: true, channel: true },
      }),
      this.db.membership.findMany({
        where, orderBy: { startDate: 'asc' },
        select: {
          status: true, startDate: true, currentPeriodStart: true, currentPeriodEnd: true, graceUntil: true, autoRenew: true,
          frozenSince: true, frozenUntil: true, canceledAt: true, cancellationReason: true, endedAt: true,
          plan: { select: { name: true } }, soldAtBranch: sucursal,
        },
      }),
      this.db.charge.findMany({
        where, orderBy: { dueDate: 'asc' },
        select: {
          concept: true, chargeType: true, status: true, amountCents: true, allocatedCents: true, adjustedCents: true, dueDate: true,
          periodStart: true, periodEnd: true, voidReason: true, writeOffReason: true, branch: sucursal,
        },
      }),
      this.db.payment.findMany({
        where, orderBy: { receivedAt: 'asc' },
        select: { method: true, status: true, amountCents: true, receivedAt: true, businessDate: true, folio: true, isRefund: true, reversalReason: true, branch: sucursal },
      }),
      this.db.visitPack.findMany({ where, select: { visitsPurchased: true, purchasedOn: true, expiresOn: true, status: true } }),
      this.db.attendanceEvent.findMany({ where, orderBy: { at: 'desc' }, take: 2000, select: { at: true, branch: sucursal } }),
      this.db.classBooking.findMany({
        where, orderBy: { bookedAt: 'desc' },
        select: {
          status: true, source: true, bookedAt: true, canceledAt: true, checkedInAt: true,
          classSchedule: { select: { startsAt: true, room: true, classType: { select: { name: true } }, branch: sucursal } },
        },
      }),
      this.db.workoutAssignment.findMany({
        where, select: { assignedAt: true, endedAt: true, notes: true, template: { select: { name: true, goal: true, level: true } } },
      }),
      // La plantilla biométrica NO sale en el archivo: se informa que existe,
      // dónde vive y cuándo se borró. Dónde vive lo dice su referencia: las de
      // la cámara de recepción (`servidor:…`) viven cifradas en el servidor
      // del gimnasio (ADR-040); las de un lector, en el equipo de la sucursal.
      this.db.biometricEnrollment.findMany({
        where, select: { modality: true, templateRef: true, enrolledAt: true, revokedAt: true, templateDeletedAt: true, branch: sucursal },
      }),
      this.db.memberIntake.findMany({
        where, select: { status: true, submittedAt: true, reviewedAt: true, branch: sucursal },
      }),
    ]);

    return {
      consentimientos: consents.map((c) => ({
        documento: etiqueta.consentimiento(c.consentType), version: c.documentVersion,
        aceptado: c.granted ? 'Sí' : 'No', fecha: momento(c.grantedAt), retiradoEl: momento(c.revokedAt),
        como: etiqueta.canal(c.channel), texto: c.documentText,
      })),
      membresias: memberships.map((m) => ({
        plan: m.plan.name, sucursal: m.soldAtBranch?.name ?? null, estado: etiqueta.membresia(m.status),
        inicio: fecha(m.startDate), periodoActual: `del ${fecha(m.currentPeriodStart)} al ${fecha(m.currentPeriodEnd)}`,
        graciaHasta: fecha(m.graceUntil), seRenuevaSola: m.autoRenew ? 'Sí' : 'No',
        congelada: m.frozenSince ? `del ${fecha(m.frozenSince)} al ${fecha(m.frozenUntil)}` : null,
        canceladaEl: fecha(m.canceledAt), motivoDeCancelacion: m.cancellationReason, terminoEl: fecha(m.endedAt),
      })),
      cargos: charges.map((c) => {
        const saldo = ['OPEN', 'PARTIALLY_PAID', 'OVERDUE'].includes(c.status) ? c.amountCents - c.allocatedCents - c.adjustedCents : 0n;
        return {
          concepto: c.concept, tipo: etiqueta.tipoCargo(c.chargeType), estado: etiqueta.cargo(c.status),
          importe: pesos(c.amountCents), pagado: pesos(c.allocatedCents), descuentos: pesos(c.adjustedCents), saldo: pesos(saldo < 0n ? 0n : saldo),
          vence: fecha(c.dueDate), periodo: c.periodStart ? `del ${fecha(c.periodStart)} al ${fecha(c.periodEnd)}` : null,
          sucursal: c.branch?.name ?? null, motivo: c.voidReason ?? c.writeOffReason ?? null,
        };
      }),
      pagos: payments.map((p) => ({
        fecha: fecha(p.businessDate), hora: hora(p.receivedAt), metodo: etiqueta.metodo(p.method), estado: etiqueta.pago(p.status),
        importe: pesos(p.amountCents < 0n ? -p.amountCents : p.amountCents), esDevolucion: p.isRefund || p.amountCents < 0n ? 'Sí' : 'No',
        folio: p.folio, sucursal: p.branch?.name ?? null, motivoDeDevolucion: p.reversalReason,
      })),
      paquetesDeVisitas: visitPacks.map((v) => ({
        visitas: v.visitsPurchased, compradoEl: fecha(v.purchasedOn), caducaEl: fecha(v.expiresOn), estado: etiqueta.paquete(v.status),
      })),
      asistencias: attendance.map((a) => ({ fecha: fecha(a.at), hora: hora(a.at), sucursal: a.branch.name })),
      clases: classBookings.map((b) => ({
        clase: b.classSchedule.classType.name, sucursal: b.classSchedule.branch.name, sala: b.classSchedule.room,
        fecha: fecha(b.classSchedule.startsAt), hora: hora(b.classSchedule.startsAt), estado: etiqueta.clase(b.status),
        inscritoEl: momento(b.bookedAt), inscritoDesde: etiqueta.origen(b.source), canceladoEl: momento(b.canceledAt), llegoA: hora(b.checkedInAt),
      })),
      rutinas: routines.map((r) => ({
        rutina: r.template.name, objetivo: r.template.goal, nivel: r.template.level,
        asignadaEl: fecha(r.assignedAt), terminoEl: fecha(r.endedAt), notas: r.notes,
      })),
      biometria: biometrics.map((b) => ({
        modalidad: etiqueta.modalidad(b.modality), sucursal: b.branch.name, registradaEl: momento(b.enrolledAt),
        retiradaEl: momento(b.revokedAt), plantillaBorradaEl: momento(b.templateDeletedAt),
        nota: notaDePlantilla(b.templateRef, b.templateDeletedAt),
      })),
      altasDigitales: intakes.map((i) => ({
        sucursal: i.branch.name, estado: etiqueta.alta(i.status), enviadaEl: momento(i.submittedAt), revisadaEl: momento(i.reviewedAt),
      })),
    };
  }

  async healthNotes(memberId: string): Promise<string | null> {
    const row = await this.db.member.findFirst({
      where: { id: memberId, organizationId: this.organizationId }, select: { healthNotes: true },
    });
    return descifrarSensible(row?.healthNotes ?? null);
  }

  async sucursalDeCasa(branchId: string | null): Promise<string | null> {
    if (!branchId) return null;
    const b = await this.db.branch.findFirst({ where: { id: branchId, organizationId: this.organizationId }, select: { name: true } });
    return b?.name ?? null;
  }
}

/**
 * Dónde vive la plantilla, dicho como es (6-03, 21-09). La de la cámara de
 * recepción la guarda cifrada el servidor del gimnasio; la de un lector, el
 * equipo de esa sucursal. En ningún caso viene en el archivo: es una serie de
 * números que solo sirve para reconocerte.
 */
function notaDePlantilla(templateRef: string, borradaEl: Date | null): string {
  if (templateRef.startsWith('servidor:')) {
    return borradaEl
      ? 'Tu rostro se registró con la cámara de recepción. La foto nunca se guardó, y la plantilla (una serie de números que solo sirve para reconocerte) ya se borró del servidor del gimnasio.'
      : 'Tu rostro se registró con la cámara de recepción. La foto nunca se guardó: solo una plantilla (una serie de números que solo sirve para reconocerte), cifrada en el servidor del gimnasio y ligada a tu consentimiento. No viene en este archivo; se borra en el acto si la revocas en recepción.';
  }
  return borradaEl
    ? 'La plantilla se tomó con el lector de esa sucursal y la sucursal confirmó que la borró.'
    : 'La plantilla se tomó con el lector de esa sucursal y vive solo en ese equipo: el gimnasio no la tiene en su servidor ni la puede entregar.';
}

/**
 * Derechos ARCO (LFPDPPP, SEC-08). Las solicitudes y sus plazos viven en
 * `privacy-requests.service.ts`.
 *
 *  · ACCESO: todo lo que se guarda del socio, en un archivo que se le puede
 *    entregar. Lo pide él desde su portal o la gerencia desde la ficha.
 *  · CANCELACIÓN: se anonimiza a la persona y se conserva lo contable, que
 *    la ley fiscal obliga a guardar. Exige baja previa, motivo y dos firmas.
 */
export class PrivacyService {
  private readonly audit = new AuditService();

  /**
   * `conSalud`: las notas de salud solo viajan por la vía ARCO del panel y a
   * quien puede leerlas. La del portal no las incluye: una sesión de portal
   * se puede abrir con una invitación, y eso no debe bastar para llevarse
   * un dato sensible (SEC2-01).
   */
  async export(ctx: RequestContext, memberId: string, via: 'staff' | 'self', conSalud = false): Promise<Record<string, unknown>> {
    const orgId = ctx.tenant.organizationId;
    const m = await new MemberRepository(orgId).findByIdIncludingArchived(memberId);
    if (!m) throw notFound('Socio no encontrado');
    const lector = new ExportRepository(orgId);
    const [salud, datos, sucursal] = await Promise.all([
      conSalud ? lector.healthNotes(memberId) : null, lector.todo(memberId), lector.sucursalDeCasa(m.homeBranchId),
    ]);

    await this.audit.record(ctx, {
      action: via === 'self' ? 'member.export.self' : 'member.export',
      resourceType: 'Member', resourceId: memberId, branchId: m.homeBranchId,
    });
    return {
      generadoEl: momento(new Date()),
      nota: 'Datos personales que el gimnasio conserva de ti (LFPDPPP, derecho de acceso). La plantilla de tu rostro o huella no viene en este archivo: en «biometria» se dice dónde se guarda, desde cuándo y si ya se borró.',
      socio: {
        id: m.id, codigo: m.memberCode, nombre: `${m.firstName} ${m.lastName}`, telefono: m.phoneE164, correo: m.email,
        fechaDeNacimiento: fecha(m.birthDate), sucursal, socioDesde: fecha(m.joinedAt), estado: etiqueta.socio(m.status),
        contactoDeEmergencia: m.emergencyContactName || m.emergencyContactPhone
          ? { nombre: m.emergencyContactName, telefono: m.emergencyContactPhone } : null,
        ...(conSalud ? { notasDeSalud: salud } : {}),
      },
      ...(conSalud ? {} : { notaSalud: 'Tus notas de salud no se incluyen en esta descarga. Pídelas en recepción como solicitud de acceso (ARCO).' }),
      ...datos,
    };
  }

  async anonymize(ctx: RequestContext, memberId: string, reason: string, approvedByUserId: string | null = null): Promise<void> {
    const orgId = ctx.tenant.organizationId;
    const members = new MemberRepository(orgId);
    const m = await members.findByIdIncludingArchived(memberId);
    if (!m) throw notFound('Socio no encontrado');
    if (m.status !== 'ARCHIVED') throw conflict('Primero hay que darlo de baja: no se anonimiza a quien sigue siendo socio');

    // Las huellas y rostros se revocan y la plantilla que vive en el servidor
    // se BORRA en el acto (A1-N1, D-32). Antes solo se revocaba: el rostro
    // cifrado seguía guardado y `/biometria` pedía confirmar un borrado que
    // no había ocurrido. La de un lector de sucursal queda como obligación.
    const biometria = await new EnrollmentService().revokeAllForMember(ctx, memberId, 'Anonimización ARCO');
    await new IntakeRepository(orgId).scrubForMember(memberId);
    // Lo que antes quedaba vivo (PS-08): tarjetas domiciliadas, el prospecto
    // que fue, y las notas del coach. Sin procesador real no hay token que
    // borrar allá; cuando lo haya, se llama desde aquí.
    await new PaymentMethodRepository(orgId).revokeAllForMember(memberId, 'Anonimización ARCO');
    await new ProspectRepository(orgId).anonymizeConverted(memberId);
    await new TrainingRepository(orgId).scrubNotesForMember(memberId);
    // Fase 3, bloque 3.10 (pendiente de 2.9 y 3.9): el texto de los mensajes que ya se le mandaron
    // llevaba su nombre, y la suscripción de notificaciones identifica a su teléfono. Los dos se van.
    await olvidarTextosDeMensajes(orgId, memberId);
    await new MemberPushRepository().removeAllForMember(orgId, memberId);
    if (!await members.anonymize(memberId)) throw conflict('Ese socio ya estaba anonimizado');

    // Sin nombre en la bitácora: se identifica por el código, que ya no dice quién es.
    await this.audit.record(ctx, {
      action: 'member.anonymize', resourceType: 'Member', resourceId: memberId, branchId: m.homeBranchId,
      afterState: { memberCode: m.memberCode, faceTemplatesDeleted: biometria.plantillasBorradas }, reason, approvedByUserId,
    });
    // Si pidió la cancelación de sus datos y procedía, con esto quedó hecha (1.10, 21-03).
    await new PrivacyRequestsService().alHacerse(ctx, memberId, 'CANCELLATION', 'Se le dio de baja y sus datos se anonimizaron; lo contable se conserva');
  }

  // ── Plazo de supresión (PS-08) ────────────────────────────────────────────

  /** Exsocios que ya cumplieron el plazo del gimnasio: se PROPONEN; anonimizar sigue exigiendo dos firmas. */
  async candidatos(organizationId: string): Promise<{ monthsAfterArchive: number | null; members: Array<{ id: string; firstName: string; lastName: string; memberCode: string; archivedAt: Date; homeBranchId: string | null }> }> {
    const { monthsAfterArchive } = await new OrganizationRepository(organizationId).privacySettings();
    if (!monthsAfterArchive) return { monthsAfterArchive: null, members: [] };
    const limite = new Date(); limite.setUTCMonth(limite.getUTCMonth() - monthsAfterArchive);
    const filas = await new MemberRepository(organizationId).archivedBefore(limite, 100);
    return { monthsAfterArchive, members: filas.map((f) => ({ id: f.id, firstName: f.firstName, lastName: f.lastName, memberCode: f.memberCode, archivedAt: f.deletedAt, homeBranchId: f.homeBranchId })) };
  }
}
