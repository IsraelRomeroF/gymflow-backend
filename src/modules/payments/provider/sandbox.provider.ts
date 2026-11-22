import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ProviderTimeoutError,
  type ChargeResult, type PaymentProvider, type PaymentReference, type ProviderCard,
  type ProviderCustomer, type ProviderEvent, type ProviderPayment, type RefundResult,
  type SetupSession, type Settlement,
} from './port.js';

/**
 * Procesador de CAJA DE ARENA.
 *
 * No es un doble de pruebas de conveniencia: es el procesador con el que se
 * desarrolla hasta que ADR-010 deje de ser provisional y existan credenciales.
 * Y hay una razón para que exista aunque las hubiera: **los cinco flujos que
 * el sprint exige probar incluyen un timeout y una disputa**, y ninguna caja
 * de arena real los produce cuando uno quiere.
 *
 * El escenario lo elige quien abre la sesión de alta, nunca un número de
 * tarjeta: aquí tampoco entra un PAN.
 */

export type SandboxScenario =
  | 'ok'
  | 'requires_action'
  | 'insufficient_funds'
  | 'stolen_card'
  | 'timeout'
  | 'auth_required_on_charge';

const SCENARIOS: readonly SandboxScenario[] = [
  'ok', 'requires_action', 'insufficient_funds', 'stolen_card', 'timeout', 'auth_required_on_charge',
];

export function isSandboxScenario(value: string): value is SandboxScenario {
  return (SCENARIOS as readonly string[]).includes(value);
}

/** Marca y últimos 4 FICTICIOS, derivados del token. Nunca de un PAN. */
function fakeCard(token: string): { brand: string; last4: string } {
  const n = [...token].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 10_000, 7);
  const brands = ['visa', 'mastercard', 'amex'];
  return { brand: brands[n % brands.length]!, last4: String(n).padStart(4, '0') };
}

type SetupRecord = { customerId: string; scenario: SandboxScenario };
type ChargeRecord = { id: string; amountCents: bigint; status: string; code: string | null; refunded: bigint };


/** Segundos de desfase aceptados entre la firma del webhook y nuestro reloj. */
const WEBHOOK_TOLERANCE_S = 300;

export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'sandbox';

  private readonly setups = new Map<string, SetupRecord>();
  private readonly tokens = new Map<string, SandboxScenario>();
  private readonly charges = new Map<string, ChargeRecord>();
  /** Por clave de idempotencia. Es lo que hace que un reintento NO cobre dos veces. */
  private readonly byIdempotency = new Map<string, ChargeResult>();

  constructor(private readonly webhookSecret: string) {}

  /** Solo en pruebas: fija el escenario de la próxima alta. */
  nextScenario: SandboxScenario = 'ok';

  async createCustomer(input: { memberId: string }): Promise<ProviderCustomer> {
    return { id: `cus_sbx_${input.memberId.slice(0, 8)}` };
  }

  async createSetupSession(input: { customerId: string; returnUrl: string }): Promise<SetupSession> {
    // Sin tiras largas de dígitos: el filtro anti-tarjeta (PAN) rechaza 13–19
    // dígitos seguidos que pasen Luhn, y un UUID al azar a veces los formaba
    // (la prueba fallaba una vez de cada tantas).
    const id = `seti_${randomUUID().replace(/-/g, '').slice(0, 20).replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]!)}`;
    this.setups.set(id, { customerId: input.customerId, scenario: this.nextScenario });
    return {
      id,
      clientSecret: `${id}_secret`,
      // La caja de arena expone las dos vías porque **P4 todavía no ha
      // contestado cuál se usa**: si el procesador no confirma por escrito la
      // protección contra ataques de scripts, la integración tiene que ser por
      // redirección completa (docs/07 §4.2).
      redirectUrl: `${input.returnUrl}?setup_intent=${id}`,
      status: 'requires_action',
    };
  }

  async fetchCardFromSetup(setupId: string): Promise<ProviderCard> {
    const setup = this.setups.get(setupId);
    if (!setup) throw new Error(`Sesión de alta desconocida: ${setupId}`);

    const token = `pm_sbx_${setupId.slice(5, 17)}`;
    this.tokens.set(token, setup.scenario);
    const { brand, last4 } = fakeCard(token);
    const now = new Date();

    return {
      token,
      customerId: setup.customerId,
      brand,
      last4,
      expMonth: now.getUTCMonth() + 1,
      expYear: now.getUTCFullYear() + 3,
    };
  }

  async chargeOffSession(input: {
    token: string; amountCents: bigint; idempotencyKey: string; description: string;
  }): Promise<ChargeResult> {
    return this.charge(input, false);
  }

  async chargeOnSession(input: {
    token: string; amountCents: bigint; idempotencyKey: string; description: string;
  }): Promise<ChargeResult> {
    return this.charge(input, true);
  }

  private async charge(
    input: { token: string; amountCents: bigint; idempotencyKey: string },
    onSession: boolean,
  ): Promise<ChargeResult> {
    // Idempotencia real: la misma clave devuelve el MISMO resultado sin volver
    // a mover dinero. Es lo que se está probando de verdad.
    const previo = this.byIdempotency.get(input.idempotencyKey);
    if (previo) return previo;

    const scenario = this.tokens.get(input.token) ?? 'ok';

    // El timeout se lanza ANTES de registrar nada por un lado y DESPUÉS de
    // haber cobrado por el otro: en la realidad el cargo puede haber pasado
    // aunque la respuesta no llegue, y esa es exactamente la situación que
    // obliga a `UNKNOWN`. Aquí se registra el cargo y luego se rompe.
    if (scenario === 'timeout') {
      const id = `pi_sbx_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      this.charges.set(id, {
        id, amountCents: input.amountCents, status: 'succeeded', code: null, refunded: 0n,
      });
      // Se asocia a la clave para que la reconsulta pueda encontrarlo.
      this.byIdempotency.set(input.idempotencyKey, {
        providerPaymentId: id, status: 'succeeded', code: null, message: null,
        clientSecret: null, raw: { sandbox: true, scenario },
      });
      throw new ProviderTimeoutError('chargeOffSession');
    }

    const id = `pi_sbx_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    let status = 'succeeded';
    let code: string | null = null;

    if (scenario === 'insufficient_funds') { status = 'failed'; code = 'insufficient_funds'; }
    if (scenario === 'stolen_card') { status = 'failed'; code = 'stolen_card'; }
    if (scenario === 'auth_required_on_charge' && !onSession) {
      // El caso que el sprint exige probar: el cargo recurrente pide
      // autenticación, y solo se recupera con el socio delante.
      status = 'requires_action';
      code = 'authentication_required';
    }
    if (scenario === 'requires_action' && !onSession) {
      status = 'requires_action';
      code = 'authentication_required';
    }

    this.charges.set(id, { id, amountCents: input.amountCents, status, code, refunded: 0n });

    const result: ChargeResult = {
      providerPaymentId: id,
      status,
      code,
      message: code ? `sandbox: ${code}` : null,
      clientSecret: status === 'requires_action' ? `${id}_secret` : null,
      raw: { sandbox: true, scenario, onSession },
    };
    this.byIdempotency.set(input.idempotencyKey, result);
    return result;
  }

  async createPaymentReference(input: {
    amountCents: bigint; kind: 'SPEI' | 'OXXO'; expiresAt: Date;
  }): Promise<PaymentReference> {
    const id = `ref_sbx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    return {
      id,
      reference: `${input.kind}${String(input.amountCents).padStart(10, '0')}`,
      expiresAt: input.expiresAt,
    };
  }

  async refund(input: {
    providerPaymentId: string; amountCents: bigint; idempotencyKey: string;
  }): Promise<RefundResult> {
    const charge = this.charges.get(input.providerPaymentId);
    if (!charge) throw new Error(`Cargo desconocido: ${input.providerPaymentId}`);
    if (charge.refunded + input.amountCents > charge.amountCents) {
      throw new Error('sandbox: el reembolso excede el cargo');
    }
    charge.refunded += input.amountCents;
    return { id: `re_sbx_${input.idempotencyKey}`, status: 'succeeded', raw: { sandbox: true } };
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPayment> {
    const charge = this.charges.get(providerPaymentId);
    if (!charge) return { id: providerPaymentId, status: 'not_found', amountCents: 0n, code: null, raw: null };
    return {
      id: charge.id, status: charge.status, amountCents: charge.amountCents,
      code: charge.code, raw: { sandbox: true },
    };
  }

  /** Reconsulta por clave de idempotencia: el camino que resuelve un timeout. */
  async findByIdempotencyKey(key: string): Promise<ProviderPayment | null> {
    const result = this.byIdempotency.get(key);
    return result ? this.getPayment(result.providerPaymentId) : null;
  }

  async listSettlements(from: Date, to: Date): Promise<Settlement[]> {
    return [...this.charges.values()]
      .filter((c) => c.status === 'succeeded')
      .map((c) => {
        // Comisión ficticia del 3.6% + IVA, que es justo lo que docs/07 marca
        // como NO VERIFICADO. Aquí es un número de mentira a propósito.
        const fee = (c.amountCents * 360n) / 10_000n;
        return {
          date: from, providerPaymentId: c.id,
          grossCents: c.amountCents, feeCents: fee, netCents: c.amountCents - fee,
        };
      })
      .filter(() => from <= to);
  }

  /**
   * Firma con marca de tiempo, como la de los procesadores reales:
   * `t=<segundos>,v1=<HMAC(t.cuerpo)>`. El tiempo va DENTRO de lo firmado:
   * sin él, un evento capturado se podía reenviar para siempre (SEC-05).
   */
  sign(rawBody: string, at: Date = new Date()): string {
    const t = Math.floor(at.getTime() / 1000);
    return `t=${t},v1=${this.hmac(`${t}.${rawBody}`)}`;
  }

  private hmac(texto: string): string {
    return createHmac('sha256', this.webhookSecret).update(texto).digest('hex');
  }

  verifyWebhook(rawBody: string, signature: string | null, now: Date = new Date()): boolean {
    if (!signature) return false;
    const partes = Object.fromEntries(signature.split(',').map((p) => p.split('=', 2) as [string, string]));
    const t = Number(partes.t);
    if (!Number.isInteger(t) || !partes.v1) return false;
    // Cinco minutos de tolerancia: suficiente para el reloj de cualquiera,
    // corto para que un evento robado no sirva de nada.
    if (Math.abs(now.getTime() / 1000 - t) > WEBHOOK_TOLERANCE_S) return false;
    const esperada = Buffer.from(this.hmac(`${t}.${rawBody}`), 'utf8');
    const recibida = Buffer.from(partes.v1, 'utf8');
    // Comparación en tiempo constante: comparar con `===` filtra información
    // sobre la firma correcta byte a byte.
    return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
  }

  parseEvent(rawBody: string): ProviderEvent {
    const parsed = JSON.parse(rawBody) as {
      id?: string; type?: string; created?: string; paymentId?: string;
    };
    return {
      eventId: parsed.id ?? randomUUID(),
      type: parsed.type ?? 'unknown',
      occurredAt: parsed.created ? new Date(parsed.created) : new Date(),
      providerPaymentId: parsed.paymentId ?? null,
      payload: parsed,
    };
  }

  /** Solo pruebas: fuerza el estado de un cargo, como haría una disputa real. */
  forceStatus(providerPaymentId: string, status: string): void {
    const charge = this.charges.get(providerPaymentId);
    if (charge) charge.status = status;
  }
}
