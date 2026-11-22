import {
  ACCESS_POLICY_VERSION, checkPolicyVersion, DomainError, evaluateAccess, isOverridable,
  notFound, validation, visitBalance,
  type AccessDecision as PolicyDecision, type AccessSubject, type CredentialKind,
  type DenialReason,
  type PolicyVersionCheck, type TimeWindow, type VisitLedgerEntry } from '@gymflow/core';
import { codigoDeTexto } from '@gymflow/core/motivos';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { MemberRepository } from '../members/index.js';
import { OrganizationRepository } from '../organization/index.js';
import { ChargeRepository, DayPassRepository, PaymentRepository } from '../billing/index.js';
import { emitEntry } from './entry-hooks.js';
import { MembershipRepository, VisitPackRepository } from '../memberships/index.js';
import { PlanRepository } from '../catalog/index.js';
import { AccessRepository, type DecisionRecord, type GatewayRecord } from './access.repository.js';
import { CredentialRepository, type CredentialRecord } from './credential.repository.js';
import { EnrollmentRepository } from './enrollment.repository.js';
import { FaceTemplateRepository } from './face-template.repository.js';
import type { FaceEngine } from './face.engine.js';
import { moduleViewOf } from '../../platform/modules/module-state.js';
import type { RequestContext } from '../../platform/context.js';

/** Ventana anti-replay: dos pasos en menos de esto son el mismo intento. */
const ANTI_REPLAY_SEGUNDOS = 8;

export type AccessResult = {
  decision: PolicyDecision;
  record: DecisionRecord;
  attendanceId: string | null;
  /**
   * Cuánto debe, cuando el rechazo es por mora.
   *
   * La puerta es el único punto donde el gimnasio ve al socio moroso sin
   * buscarlo. Devolver el importe convierte el rechazo en un cobro posible en
   * el acto, en vez de un "no" que el socio se lleva a casa.
   */
  outstandingCents: bigint | null;
  /** Lo mínimo para abrir hoy (la cuota más vieja) y cuántos periodos debe (MC-22). */
  minimumCents: bigint | null;
  periodsOwed: number | null;
};

/** Cuánto debe y cuánto basta para pasar hoy. La usa también la pantalla de excepción. */
export async function deudaEnPuerta(orgId: string, memberId: string): Promise<{ outstandingCents: bigint; minimumCents: bigint; periodsOwed: number }> {
  const cargos = new ChargeRepository(orgId);
  const [outstandingCents, periodo] = await Promise.all([cargos.outstandingTotalCents(memberId), cargos.oldestOpenPeriod(memberId)]);
  return { outstandingCents, minimumCents: periodo?.minimumCents ?? outstandingCents, periodsOwed: periodo?.periodsOwed ?? 1 };
}

export class AccessService {
  private readonly audit = new AuditService();

  /**
   * Resuelve un intento de acceso.
   *
   * La POLÍTICA es pura y vive en `@gymflow/core`; aquí solo se reúnen los
   * datos que necesita y se persiste lo que decidió. Esa separación es lo que
   * permite que el gateway de la sucursal ejecute exactamente la misma función
   * sin base de datos (ADR-015).
   */
  async attempt(ctx: RequestContext, input: {
    branchId: string;
    memberId: string | null;
    credentialKind: CredentialKind;
    gatewayId?: string | null;
    credentialRevoked?: boolean;
    credentialExpiresAt?: Date | null;
    at?: Date;
    /** Clave del intento: el mismo enviado dos veces devuelve la misma decisión. */
    requestKey?: string | null;
    /** Entrada por el mostrador donde hay biometría: es una excepción y lleva motivo. */
    manualReason?: string | null;
    /** Evidencia del reconocimiento facial: con qué parecido y si pasó la prueba de vida. */
    evidencia?: { matchScore: number; matchMargin: number; livenessMode: string; livenessPassed: boolean } | null;
    /**
     * «Renovar y abrir» (5-25): el rechazo por «sin membresía» que esta entrada
     * resuelve después de venderle su plan. La política decide de verdad (si
     * la venta quedó sin pagar, vuelve a decir que no) y solo un GRANTED queda
     * ligado al rechazo; la base admite una sola resolución por rechazo.
     */
    resolvesDecisionId?: string | null;
  }): Promise<AccessResult> {
    const repo = new AccessRepository(ctx.tenant.organizationId);
    if (input.requestKey) {
      const previo = await this.repetido(ctx, repo, input.requestKey);
      if (previo) return previo;
    }
    if (!input.memberId) return this.decidir(ctx, input);
    // Un socio a la vez (UXA-01, BE2-04): el "ya entró hace 8 s" y el saldo
    // del paquete se leen y se escriben sin que otro intento se cuele en medio.
    return repo.withMemberLock(input.memberId, async () => {
      if (input.requestKey) {
        const previo = await this.repetido(ctx, repo, input.requestKey);
        if (previo) return previo;
      }
      return this.decidir(ctx, input);
    });
  }

  /**
   * LO QUE PASARÍA (5-03): la misma política, sin registrar nada (ni decisión,
   * ni asistencia, ni visita, ni gancho de clase). El diálogo de entrada la
   * llama al abrir y así el veredicto va ANTES que el motivo: nadie escribe
   * por qué entra por el mostrador quien de todos modos no entra.
   */
  async preview(ctx: RequestContext, input: { branchId: string; memberId: string }): Promise<{
    decision: PolicyDecision;
    outstandingCents: bigint | null; minimumCents: bigint | null; periodsOwed: number | null;
    creditCents: bigint;
    policy: { requiresReason: boolean; hasBiometric: boolean };
  }> {
    const orgId = ctx.tenant.organizationId;
    const repo = new AccessRepository(orgId);
    const calendario = new BusinessCalendar(orgId);
    const ahora = new Date();
    const [businessDate, tz, politica] = await Promise.all([
      calendario.today(input.branchId, ahora), calendario.timezoneFor(input.branchId), this.politicaManual(ctx, input.branchId, input.memberId),
    ]);
    const [revocada, subject, yaUsada, settings] = await Promise.all([
      credencialRevocada(orgId, input.memberId, 'MANUAL'),
      this.buildSubject(orgId, input.memberId, businessDate, ahora, input.branchId),
      repo.credentialUsedSince(input.memberId, new Date(ahora.getTime() - ANTI_REPLAY_SEGUNDOS * 1000)),
      new OrganizationRepository(orgId).accessSettings(),
    ]);
    const { minuteOfDay, weekday } = localClock(tz, ahora);
    const decision = evaluateAccess({
      at: ahora, localMinuteOfDay: minuteOfDay, localWeekday: weekday, branchId: input.branchId,
      credential: { kind: 'MANUAL', revoked: revocada, expiresAt: null, alreadyUsed: yaUsada },
      subject, settings,
    });
    const [deuda, creditCents] = await Promise.all([
      (decision.reason === 'MEMBERSHIP_PAST_DUE' || decision.reason === 'MEMBERSHIP_SUSPENDED') ? deudaEnPuerta(orgId, input.memberId) : null,
      new PaymentRepository(orgId).creditBalanceCents(input.memberId),
    ]);
    return {
      decision, policy: politica, creditCents,
      outstandingCents: deuda?.outstandingCents ?? null, minimumCents: deuda?.minimumCents ?? null, periodsOwed: deuda?.periodsOwed ?? null,
    };
  }

  /**
   * LO QUE DIRÍA LA PUERTA, para el portal del socio (fase 2, bloque 2.8 ·
   * 27-04). La misma política (`evaluateAccess`) con el mismo sujeto que arma
   * `preview`, sin personal de por medio y sin registrar nada: el teléfono, el
   * mostrador y la puerta contestan lo mismo. No es un paso por la puerta, así
   * que no hay doble paso que mirar. Devuelve también el sujeto, para que el
   * portal diga con qué entra (su pase de hoy) sin volver a leerlo.
   */
  async veredictoParaElSocio(orgId: string, memberId: string, branchId: string, ahora = new Date()): Promise<{ decision: PolicyDecision; subject: AccessSubject | null }> {
    const calendario = new BusinessCalendar(orgId);
    const [businessDate, tz, settings, revocada] = await Promise.all([
      calendario.today(branchId, ahora), calendario.timezoneFor(branchId),
      new OrganizationRepository(orgId).accessSettings(), credencialRevocada(orgId, memberId, 'MANUAL'),
    ]);
    const subject = await this.buildSubject(orgId, memberId, businessDate, ahora, branchId);
    const { minuteOfDay, weekday } = localClock(tz, ahora);
    const decision = evaluateAccess({
      at: ahora, localMinuteOfDay: minuteOfDay, localWeekday: weekday, branchId,
      credential: { kind: 'MANUAL', revoked: revocada, expiresAt: null, alreadyUsed: false },
      subject, settings,
    });
    return { decision, subject };
  }

  /** El mismo intento ya resuelto: se devuelve tal cual, sin registrar otro paso. */
  private async repetido(ctx: RequestContext, repo: AccessRepository, requestKey: string): Promise<AccessResult | null> {
    const r = await repo.findByRequestKey(requestKey);
    if (!r) return null;
    const reason = r.decision.denialReason as DenialReason | null;
    const deuda = (reason === 'MEMBERSHIP_PAST_DUE' || reason === 'MEMBERSHIP_SUSPENDED') && r.decision.memberId
      ? await deudaEnPuerta(ctx.tenant.organizationId, r.decision.memberId) : null;
    return {
      decision: {
        outcome: r.decision.outcome, reason, consumesVisit: r.consumedVisit, warning: null,
        overridable: reason ? isOverridable(reason) : false,
        policyVersion: r.decision.policyVersion, evaluatedAt: r.decision.at,
      },
      record: r.decision, attendanceId: r.attendanceId, outstandingCents: deuda?.outstandingCents ?? null, minimumCents: deuda?.minimumCents ?? null, periodsOwed: deuda?.periodsOwed ?? null,
    };
  }

  /**
   * ¿La entrada por el mostrador es una EXCEPCIÓN en esta sucursal? Donde la
   * sucursal usa biometría, el acceso normal es el rostro o la huella; la
   * entrada manual solo se registra con motivo y queda en la bitácora.
   */
  async politicaManual(ctx: RequestContext, branchId: string, memberId: string): Promise<{ requiresReason: boolean; hasBiometric: boolean }> {
    const orgId = ctx.tenant.organizationId;
    const conBiometria = (ctx.modules ?? await moduleViewOf(orgId)).at(branchId).has('biometrics');
    if (!conBiometria) return { requiresReason: false, hasBiometric: false };
    const vivos = (await new EnrollmentRepository(orgId).listForMember(memberId)).filter((e) => !e.revokedAt && e.branchId === branchId);
    return { requiresReason: true, hasBiometric: vivos.length > 0 };
  }

  /**
   * ESTACIÓN DE ACCESO (2026-10-09): la cámara de recepción reconoce al socio
   * y se aplica la MISMA regla de la puerta. Si hay rostro pero nadie se
   * parece lo suficiente, queda un rechazo "socio desconocido" con su evidencia.
   */
  async reconocerRostro(ctx: RequestContext, engine: FaceEngine, input: { branchId: string; frames: string[]; reto: string }): Promise<
    { reconocido: false; motivo: string; sinRostro: boolean } | { reconocido: true; memberId: string; memberName: string; resultado: AccessResult }
  > {
    const orgId = ctx.tenant.organizationId;
    const r = await engine.extraer(input.frames, input.reto, false);
    if (!r.ok) return { reconocido: false, motivo: r.error, sinRostro: !r.livenessFailed };
    // Bloque 2.3 (5-16): contra quién se compara lo dice `FACE_RECOGNITION_SCOPE`; por omisión `branch`, que es lo de siempre.
    const plantillas = await new FaceTemplateRepository(orgId).padron(input.branchId, engine.alcance);
    const m = engine.mejor(r.embedding, plantillas.map((p) => ({ id: p.memberId, embedding: engine.descifrar(p.embeddingEncrypted) })));
    // La evidencia se guarda acotada a [0, 1], que es lo que admite la base
    // (`access_decisions_match_range_check`): un coseno de 1.0000000000000002
    // por redondeo, un parecido negativo con el único rostro de la sede o una
    // ventaja mayor que 1 hacían que la estación respondiera 409 en vez de
    // reconocer o de decir "no te reconocí". La decisión no cambia: usa `m`.
    const acotar = (x: number) => Math.min(1, Math.max(0, x));
    if (!engine.reconoce(m)) {
      await this.attempt(ctx, { branchId: input.branchId, memberId: null, credentialKind: 'FACE',
        evidencia: { matchScore: acotar(m?.score ?? 0), matchMargin: acotar(m?.margin ?? 0), livenessMode: 'ACTIVE', livenessPassed: true } });
      return { reconocido: false, motivo: plantillas.length === 0 ? 'Nadie tiene su rostro dado de alta en esta sucursal todavía.' : 'No te reconocí. Pasa con recepción.', sinRostro: false };
    }
    const socio = await new MemberRepository(orgId).findById(m!.id);
    const resultado = await this.attempt(ctx, { branchId: input.branchId, memberId: m!.id, credentialKind: 'FACE',
      evidencia: { matchScore: acotar(m!.score), matchMargin: acotar(m!.margin), livenessMode: 'ACTIVE', livenessPassed: true } });
    return { reconocido: true, memberId: m!.id, memberName: socio ? `${socio.firstName} ${socio.lastName}` : 'Socio', resultado };
  }

  private async decidir(ctx: RequestContext, input: Parameters<AccessService['attempt']>[1]): Promise<AccessResult> {
    const orgId = ctx.tenant.organizationId;
    const repo = new AccessRepository(orgId);

    // Entrada manual donde hay biometría: excepción con motivo (2026-10-09).
    // El motivo se exige DESPUÉS de evaluar (5-03): si la puerta dice que no,
    // el rechazo se registra sin pedirle a recepción que escriba por qué
    // iba a entrar por el mostrador. Con motivo, queda como excepción igual.
    const politica = input.credentialKind === 'MANUAL' && input.memberId
      ? await this.politicaManual(ctx, input.branchId, input.memberId) : null;
    const calendario = new BusinessCalendar(orgId);

    const ahora = input.at ?? new Date();
    const businessDate = await calendario.today(input.branchId, ahora);
    const tz = await calendario.timezoneFor(input.branchId);

    /**
     * Sin socio identificado no hay credencial que consultar: el rechazo será
     * `MEMBER_UNKNOWN` de todas formas.
     */
    const revocadaEnBase = await credencialRevocada(orgId, input.memberId, input.credentialKind);

    const subject = input.memberId
      ? await this.buildSubject(orgId, input.memberId, businessDate, ahora, input.branchId)
      : null;

    // Anti-replay: el mismo socio no entra dos veces en ocho segundos. Un
    // doble paso del torniquete no puede consumir dos visitas de su paquete.
    const yaUsada = input.memberId
      ? await repo.credentialUsedSince(input.memberId, new Date(ahora.getTime() - ANTI_REPLAY_SEGUNDOS * 1000))
      : false;

    const { minuteOfDay, weekday } = localClock(tz, ahora);
    const settings = await new OrganizationRepository(orgId).accessSettings();

    const decision = evaluateAccess({
      at: ahora,
      localMinuteOfDay: minuteOfDay,
      localWeekday: weekday,
      branchId: input.branchId,
      credential: {
        kind: input.credentialKind,
        /**
         * La revocación se CONSULTA, no se acepta.
         *
         * Venía del cuerpo de la petición, así que `POST /credentials/:id/revoke`
         * no tenía ningún efecto sobre este camino: se revocaba el enrolamiento
         * y el socio seguía entrando indefinidamente. El dato de fuera solo
         * puede endurecer la decisión, nunca ablandarla.
         */
        revoked: revocadaEnBase || (input.credentialRevoked ?? false),
        expiresAt: input.credentialExpiresAt ?? null,
        alreadyUsed: yaUsada,
      },
      subject,
      settings,
    });

    let excepcion: { reason: string; hasBiometric: boolean } | null = null;
    if (politica?.requiresReason) {
      const motivo = input.manualReason?.trim() ?? '';
      if (motivo.length >= 3) excepcion = { reason: motivo, hasBiometric: politica.hasBiometric };
      else if (decision.outcome === 'GRANTED') {
        throw validation(politica.hasBiometric
          ? 'La entrada por el mostrador es una excepción: escribe el motivo. Lo normal es que entre con su rostro o su huella.'
          : 'Este socio aún no tiene su rostro o huella dados de alta. Dalos de alta para que entre normalmente; si hoy es una excepción, escribe el motivo.');
      }
    }

    // «Renovar y abrir»: solo la entrada que SÍ pasa resuelve el rechazo; una
    // negativa nueva no se cuelga del rechazo viejo (seguiría pendiente).
    let resuelve: string | null = null;
    if (input.resolvesDecisionId && decision.outcome === 'GRANTED') {
      const rechazo = await repo.findDecision(input.resolvesDecisionId);
      if (!rechazo) throw notFound('Decisión no encontrada');
      if (rechazo.outcome !== 'DENIED' || rechazo.memberId !== input.memberId) throw validation('Ese rechazo no es de este socio');
      const previa = await repo.resolucionDe(rechazo.id);
      if (previa) throw await yaResuelto(orgId, repo, previa);
      resuelve = rechazo.id;
    }

    let registro: { decision: DecisionRecord; attendanceId: string | null };
    try {
      registro = await repo.record({
      branchId: input.branchId,
      gatewayId: input.gatewayId ?? null,
      memberId: input.memberId,
      outcome: decision.outcome,
      denialReason: decision.reason,
      credentialKind: input.credentialKind,
      policyVersion: decision.policyVersion,
      decidedOffline: false,
      businessDate,
      requestKey: input.requestKey ?? null,
      ...(excepcion ? { overriddenByUserId: ctx.tenant.actorUserId ?? null, overrideReason: excepcion.reason } : {}),
      ...(input.evidencia ?? {}),
      resolvesDecisionId: resuelve,
    });
    } catch (e) {
      // Otra persona resolvió ese rechazo en este mismo instante.
      if (resuelve && isUniqueViolation(e)) throw new DomainError('CONFLICT', 'Ese rechazo lo acaba de resolver otra persona. No se registra otra entrada.', 'ALREADY_RESOLVED');
      throw e;
    }
    const { decision: record, attendanceId } = registro;
    if (excepcion) {
      await this.audit.record(ctx, {
        action: 'access.manual_entry', resourceType: 'access_decision', resourceId: record.id, reason: excepcion.reason, branchId: input.branchId,
        // `reasonCode` del catálogo (`MOTIVOS.entradaManual`, 2.13): el chip escribe su texto y aquí se vuelve a contar; lo demás es `OTRO`.
        afterState: { memberId: input.memberId, outcome: decision.outcome, denialReason: decision.reason, hasBiometric: excepcion.hasBiometric, reasonCode: codigoDeTexto('entradaManual', excepcion.reason) },
      });
    }

    // El consumo de visita lo ejecuta QUIEN LLAMA, no la política: la política
    // es pura y no escribe. La clave de idempotencia del consumo es la
    // ASISTENCIA, como dice la columna (5-24): antes iba el id de la decisión y
    // la llave foránea que anuncia el esquema habría tumbado toda entrada con
    // paquete. Un reintento no cobra dos visitas: una decisión, una asistencia.
    if (decision.consumesVisit && subject?.visitPack) {
      // Atómico y con el agotado marcado en la misma transacción (BE2-04).
      await new VisitPackRepository(orgId).consume({
        visitPackId: subject.visitPack.packId,
        branchId: input.branchId,
        attendanceEventId: attendanceId,
        businessDate,
      });
    }

    // Si se le cerró la puerta por deber, se dice CUÁNTO: es lo que permite
    // cobrar ahí mismo en vez de mandarlo a casa con un "no".
    // En mora o suspendido por mora: la puerta dice CUÁNTO debe, para cobrarlo ahí.
    const deuda = (decision.reason === 'MEMBERSHIP_PAST_DUE' || decision.reason === 'MEMBERSHIP_SUSPENDED') && input.memberId
      ? await deudaEnPuerta(orgId, input.memberId) : null;
    // Entró: la clase que tenía reservada en esta sede queda con su llegada (puerta + clase en un registro).
    if (decision.outcome === 'GRANTED' && input.memberId && attendanceId) await emitEntry({ organizationId: orgId, memberId: input.memberId, branchId: input.branchId, at: new Date() });
    return { decision, record, attendanceId, outstandingCents: deuda?.outstandingCents ?? null, minimumCents: deuda?.minimumCents ?? null, periodsOwed: deuda?.periodsOwed ?? null };
  }

  /**
   * Concesión MANUAL de recepción.
   *
   * Es el principio 8 de la visión hecho código: si el sistema impidiera a
   * recepción dejar entrar a un moroso, encontrarían la forma de saltárselo
   * —una llave, una puerta lateral— y el dato se perdería. Permitirlo CON
   * NOMBRE Y MOTIVO lo convierte en un registro. El objetivo es visibilidad,
   * no prohibición.
   *
   * Solo se levantan los rechazos de MOSTRADOR: una credencial revocada o un
   * socio dado de baja no son un trámite y ofrecer el botón sería un agujero.
   *
   * Y un rechazo se resuelve UNA sola vez (5-10): la concesión apunta al
   * rechazo que resuelve y la base no admite una segunda, tampoco si dos
   * personas la piden al mismo tiempo. Antes el mismo rechazo se podía dejar
   * pasar dos veces: dos asistencias y, con paquete, dos visitas.
   */
  async grantManually(ctx: RequestContext, input: {
    decisionId: string; reason: string;
  }): Promise<AccessResult> {
    const r = await this.concederSobreRechazo(ctx, { ...input, reasonCode: codigoDeTexto('dejarPasar', input.reason) });
    if (r.record.memberId && r.attendanceId) await emitEntry({ organizationId: ctx.tenant.organizationId, memberId: r.record.memberId, branchId: r.record.branchId, at: new Date() });
    return r;
  }

  /** 409 si ese rechazo ya se resolvió, con quién y a qué hora. Va antes de cobrar nada. */
  async exigirSinResolver(ctx: RequestContext, decisionId: string): Promise<void> {
    const repo = new AccessRepository(ctx.tenant.organizationId);
    const previa = await repo.resolucionDe(decisionId);
    if (previa) throw await yaResuelto(ctx.tenant.organizationId, repo, previa);
  }

  /**
   * La concesión sin los ganchos de entrada, en una unidad con su bitácora.
   * La usa directo quien la registra dentro de una operación más grande
   * (cobrar y abrir): los ganchos corren después de confirmar, porque uno que
   * falle dentro de la transacción la dejaría inservible.
   */
  async concederSobreRechazo(ctx: RequestContext, input: {
    decisionId: string; reason: string;
    /** Código del catálogo `MOTIVOS.dejarPasar` cuando el motivo lo dio una persona (2.13); el cobro en la puerta no lleva. */
    reasonCode?: string;
  }): Promise<AccessResult> {
    const orgId = ctx.tenant.organizationId;
    const userId = ctx.tenant.actorUserId;
    if (!userId) throw validation('Una concesión manual exige un usuario: responde una persona');

    const repo = new AccessRepository(orgId);
    const original = await repo.findDecision(input.decisionId);
    if (!original) throw notFound('Decisión no encontrada');
    if (original.outcome !== 'DENIED') throw validation('Esa decisión no fue un rechazo');
    if (!original.denialReason || !isOverridable(original.denialReason as DenialReason)) {
      throw validation(
        `El rechazo por ${original.denialReason} no se levanta en el mostrador: ` +
        'no es un trámite de recepción',
      );
    }
    const previa = await repo.resolucionDe(original.id);
    if (previa) throw await yaResuelto(orgId, repo, previa);

    const businessDate = await new BusinessCalendar(orgId).today(original.branchId);

    return enUnaTransaccion(async () => {
      // Se registra una decisión NUEVA, no se edita la original: la bitácora de
      // acceso es append-only y el rechazo tiene que seguir constando.
      let registro: { decision: DecisionRecord; attendanceId: string | null };
      try {
        registro = await repo.record({
          branchId: original.branchId,
          gatewayId: original.gatewayId,
          memberId: original.memberId,
          outcome: 'GRANTED',
          denialReason: null,
          credentialKind: original.credentialKind,
          policyVersion: ACCESS_POLICY_VERSION,
          decidedOffline: false,
          overriddenByUserId: userId,
          overrideReason: input.reason,
          businessDate,
          resolvesDecisionId: original.id,
        });
      } catch (e) {
        // Otra concesión sobre el mismo rechazo se confirmó en este instante.
        if (isUniqueViolation(e)) throw new DomainError('CONFLICT', 'Ese rechazo lo acaba de resolver otra persona. No se registra otra entrada.', 'ALREADY_RESOLVED');
        throw e;
      }
      const { decision: record, attendanceId } = registro;

      await this.audit.record(ctx, {
        action: 'access.manual_grant',
        resourceType: 'access_decision',
        resourceId: record.id,
        beforeState: { deniedFor: original.denialReason, originalDecisionId: original.id },
        afterState: { outcome: 'GRANTED', ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}) },
        reason: input.reason,
        branchId: original.branchId,
      });

      return {
        decision: {
          outcome: 'GRANTED', reason: null, consumesVisit: false,
          warning: 'Paso concedido por recepción', overridable: false,
          policyVersion: ACCESS_POLICY_VERSION, evaluatedAt: record.at,
        },
        record,
        attendanceId,
        outstandingCents: null, minimumCents: null, periodsOwed: null,
      } satisfies AccessResult;
    });
  }

  /** Reúne el estado que la política necesita. Nada más. */
  private async buildSubject(orgId: string, memberId: string, businessDate: Date, ahora = new Date(), branchId?: string): Promise<AccessSubject | null> {
    // INCLUYE archivados: un socio dado de baja no es una credencial
    // desconocida, y la pantalla de excepción necesita esa diferencia.
    const member = await new MemberRepository(orgId).findByIdIncludingArchived(memberId);
    if (!member) return null;

    const membership = await new MembershipRepository(orgId).findCurrentForMember(memberId);
    let membershipView: AccessSubject['membership'] = null;

    if (membership) {
      const plan = await new PlanRepository(orgId).findById(membership.planId);
      membershipView = {
        status: membership.status,
        homeBranchId: member.homeBranchId,
        branchAccessScope: toScope(plan?.branchAccessScope),
        allowedBranchIds: membership.soldAtBranchId ? [membership.soldAtBranchId] : [],
        accessTimeWindows: parseWindows(plan?.accessTimeWindows),
      };
    }

    const packs = new VisitPackRepository(orgId);
    const vivos = await packs.listForMember(memberId);
    /**
     * Se prefiere el ACTIVO, pero si no hay ninguno se pasa el que haya.
     *
     * Antes se filtraba a `ACTIVE` aquí y el resto desaparecía, así que un
     * socio con un paquete vendido a cuenta recibía un rechazo genérico —
     * "sin membresía"— en vez de "el paquete está sin pagar". La diferencia
     * importa en el mostrador: uno se discute, el otro se cobra.
     *
     * Quien decide sigue siendo la política, que ahora sí ve el estado.
     */
    const usable = vivos.find((p) => p.status === 'ACTIVE') ?? vivos[0] ?? null;
    let packView: AccessSubject['visitPack'] = null;
    if (usable) {
      const entradas = await packs.entries(usable.id);
      packView = {
        packId: usable.id,
        balance: visitBalance(entradas as readonly VisitLedgerEntry[]),
        expired: usable.expiresOn !== null && usable.expiresOn.getTime() < businessDate.getTime(),
        status: usable.status,
      };
    }

    return {
      memberId,
      archived: member.status === 'ARCHIVED',
      membership: membershipView,
      visitPack: packView,
      // Su clase suelta pagada de ahora, de preferencia en esta sucursal (2026-10-09).
      classPass: await (async () => {
        const pases = await new AccessRepository(orgId).paseDeClase(memberId, ahora);
        return pases.find((p) => p.branchId === branchId) ?? pases[0] ?? null;
      })(),
      // Su pase del día PAGADO de hoy (1.8, 4-01), de preferencia el de esta
      // sede. `businessDate` es el día de operación de la sede por donde entra.
      dayPass: await (async () => {
        const pases = await new DayPassRepository(orgId).pagadosDelDia(memberId, businessDate);
        const suyo = pases.find((p) => p.branchId === branchId) ?? pases[0] ?? null;
        return suyo ? { branchId: suyo.branchId } : null;
      })(),
    };
  }

  // ── Gateways ──────────────────────────────────────────────────────────────

  /**
   * Latido del gateway, con comparación de versión de política.
   *
   * Es el entregable que la separación en repositorios hizo necesario: en un
   * monorepo la nube y la puerta compartían import y versión por construcción.
   * Ahora son dos desplegables y una divergencia rompe la garantía de ADR-015
   * SIN error visible. Por eso se compara aquí y se audita cuando no coincide.
   */
  async heartbeat(ctx: RequestContext, input: {
    gatewayId: string;
    policyVersion: string;
    rosterVersion?: bigint | null;
    status?: 'ONLINE' | 'DEGRADED' | 'OFFLINE';
  }): Promise<{ gateway: GatewayRecord; policy: PolicyVersionCheck }> {
    const orgId = ctx.tenant.organizationId;
    const repo = new AccessRepository(orgId);

    const gateway = await repo.heartbeat({
      gatewayId: input.gatewayId,
      policyVersion: input.policyVersion,
      rosterVersion: input.rosterVersion ?? null,
      status: input.status ?? 'ONLINE',
    });
    if (!gateway) throw notFound('Gateway no encontrado');

    const policy = checkPolicyVersion(input.policyVersion);
    if (!policy.ok) {
      await this.audit.record(ctx, {
        action: 'access.policy.version_mismatch',
        resourceType: 'access_gateway',
        resourceId: gateway.id,
        afterState: {
          gateway: input.policyVersion,
          cloud: ACCESS_POLICY_VERSION,
          severity: policy.severity,
        },
        branchId: gateway.branchId,
      });
    }

    return { gateway, policy };
  }

  async createGateway(ctx: RequestContext, input: {
    branchId: string; code: string; name: string;
  }): Promise<GatewayRecord> {
    const orgId = ctx.tenant.organizationId;
    if (input.code.trim().length === 0) throw validation('El gateway necesita un código');
    const gateway = await new AccessRepository(orgId).createGateway(input);
    await this.audit.record(ctx, {
      action: 'access.gateway.create',
      resourceType: 'access_gateway',
      resourceId: gateway.id,
      afterState: { code: gateway.code },
      branchId: input.branchId,
    });
    return gateway;
  }
}

/**
 * El "ya se resolvió" con nombre y hora (5-10): recepción tiene que saber
 * que ya pasó, quién lo dejó pasar y cuándo, no solo que algo chocó.
 */
async function yaResuelto(orgId: string, repo: AccessRepository, previa: DecisionRecord): Promise<DomainError> {
  const nombre = previa.overriddenByUserId ? (await repo.nombresDePersonal([previa.overriddenByUserId])).get(previa.overriddenByUserId) ?? null : null;
  const zona = await new BusinessCalendar(orgId).timezoneFor(previa.branchId);
  const aLas = new Intl.DateTimeFormat('es-MX', { timeZone: zona, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(previa.at);
  return new DomainError('CONFLICT', `Ese rechazo ya se resolvió${nombre ? `: lo resolvió ${nombre}` : ''} a las ${aLas}. No se registra otra entrada.`, 'ALREADY_RESOLVED');
}

/** Minuto del día y día de la semana en una zona concreta. */
function localClock(timeZone: string, at: Date): { minuteOfDay: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const partes = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const DIAS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hora = Number(partes.hour === '24' ? '0' : partes.hour);
  return {
    minuteOfDay: hora * 60 + Number(partes.minute),
    weekday: DIAS[partes.weekday ?? 'Sun'] ?? 0,
  };
}

/** El alcance viene del enum de la base; se estrecha aquí, con un valor por
 *  defecto CONSERVADOR: sin plan legible, la membresía no abre otras sedes. */
function toScope(raw: string | undefined): 'ALL_BRANCHES' | 'HOME_BRANCH' | 'LISTED_BRANCHES' {
  return raw === 'HOME_BRANCH' || raw === 'LISTED_BRANCHES' || raw === 'ALL_BRANCHES'
    ? raw
    : 'HOME_BRANCH';
}

/**
 * Se exporta para que el padrón use EXACTAMENTE la misma conversión.
 *
 * Tenerla dos veces fue lo que permitió que la nube evaluara las ventanas y
 * el gateway recibiera `null`: la misma regla implementada en dos sitios
 * acaba divergiendo, y aquí la divergencia no fallaba, abría la puerta.
 */
export function parseWindows(raw: unknown): readonly TimeWindow[] | null {
  if (!Array.isArray(raw)) return null;
  const ventanas = raw.filter(
    (w): w is TimeWindow =>
      typeof w === 'object' && w !== null &&
      typeof (w as TimeWindow).weekday === 'number' &&
      typeof (w as TimeWindow).fromMinute === 'number' &&
      typeof (w as TimeWindow).toMinute === 'number',
  );
  return ventanas.length > 0 ? ventanas : null;
}


/**
 * ¿Están revocados TODOS los enrolamientos de ese tipo?
 *
 * Si no hay ninguno, esto devuelve `false` a propósito: la ausencia de
 * credencial no es una revocación, y decirle al socio "tu credencial fue
 * revocada" cuando nunca tuvo una manda a recepción a buscar algo que no
 * existe. De ese caso se ocupan las otras reglas.
 */
async function credencialRevocada(
  orgId: string,
  memberId: string | null | undefined,
  kind: string,
): Promise<boolean> {
  if (!memberId) return false;
  const todas = await new CredentialRepository(orgId).listForMember(memberId);
  const delTipo = todas.filter((c: CredentialRecord) => c.kind === kind);
  return delTipo.length > 0 && delTipo.every((c: CredentialRecord) => c.revokedAt !== null);
}
