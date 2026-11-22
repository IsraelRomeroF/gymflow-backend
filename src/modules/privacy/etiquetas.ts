/**
 * Palabras para el archivo ARCO (PS-01). El socio lo abre en su teléfono:
 * nada de claves internas, UUIDs ajenos ni centavos sueltos.
 */
import {
  CANAL_DE_CONSENTIMIENTO_SOCIO, ESTADO_DE_MEMBRESIA, ESTADO_DE_SOCIO, METODO_DE_PAGO, MODALIDAD_BIOMETRICA, TIPO_DE_CONSENTIMIENTO_SOCIO, formatMoney, money,
} from '@gymflow/core';

const TZ = 'America/Mexico_City';

export function fecha(d: Date | null | undefined): string | null {
  return d ? d.toLocaleDateString('es-MX', { timeZone: TZ, dateStyle: 'long' }) : null;
}

export function momento(d: Date | null | undefined): string | null {
  return d ? d.toLocaleString('es-MX', { timeZone: TZ, dateStyle: 'long', timeStyle: 'short' }) : null;
}

export function hora(d: Date | null | undefined): string | null {
  return d ? d.toLocaleTimeString('es-MX', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : null;
}

export const pesos = (c: bigint): string => formatMoney(money(c));

const CARGO: Record<string, string> = {
  DRAFT: 'Borrador', OPEN: 'Por pagar', PARTIALLY_PAID: 'Pagado en parte', PAID: 'Pagado', OVERDUE: 'Vencido', VOID: 'Anulado', WRITTEN_OFF: 'Condonado',
};
const TIPO_CARGO: Record<string, string> = {
  MEMBERSHIP_PERIOD: 'Cuota de membresía', SIGNUP_FEE: 'Inscripción', VISIT_PACK: 'Paquete de visitas', DAY_PASS: 'Pase del día',
  CLASS_SINGLE: 'Clase suelta', NO_SHOW_PENALTY: 'Penalización por no asistir', POS_SALE: 'Compra en mostrador',
  PRORATION_ADJUSTMENT: 'Ajuste por cambio de plan', OPENING_BALANCE: 'Saldo inicial', MANUAL_ADJUSTMENT: 'Ajuste manual', LATE_FEE: 'Recargo',
};
const PAGO: Record<string, string> = {
  INITIATED: 'Iniciado', PROCESSING: 'En proceso', REQUIRES_ACTION: 'Falta confirmar', SUCCEEDED: 'Recibido', FAILED: 'Rechazado', UNKNOWN: 'Sin confirmar',
};
const PAQUETE: Record<string, string> = { PENDING_PAYMENT: 'Sin pagar', ACTIVE: 'Vigente', EXHAUSTED: 'Agotado', EXPIRED: 'Caducado', FROZEN: 'Congelado' };
const CLASE: Record<string, string> = { BOOKED: 'Inscrito', CANCELED: 'Cancelado', ATTENDED: 'Asistió', NO_SHOW: 'No asistió' };
const ORIGEN: Record<string, string> = { PORTAL: 'Desde tu teléfono', FRONT_DESK: 'En recepción' };
const ALTA: Record<string, string> = { SUBMITTED: 'Por revisar', APPROVED: 'Aprobada', REJECTED: 'Rechazada' };

const de = (mapa: Readonly<Record<string, string>>) => (k: string | null | undefined) => (k ? mapa[k] ?? k : null);
const conTono = (mapa: Readonly<Record<string, { readonly label: string }>>) => (k: string | null | undefined) => (k ? mapa[k]?.label ?? k : null);
/**
 * Lo que el núcleo ya nombra sale del núcleo (auditoría 8, 27-07 y bloque
 * 1.10): el mismo pago, el mismo permiso y el mismo estado se llaman igual en
 * el panel, en el portal y en este archivo. El canal de la firma esperaba
 * `SELF` y la API escribe `SELF_SERVICE`: la descarga mostraba la clave.
 */
export const etiqueta = {
  consentimiento: de(TIPO_DE_CONSENTIMIENTO_SOCIO), socio: conTono(ESTADO_DE_SOCIO), membresia: conTono(ESTADO_DE_MEMBRESIA),
  cargo: de(CARGO), tipoCargo: de(TIPO_CARGO),
  metodo: de(METODO_DE_PAGO), pago: de(PAGO), paquete: de(PAQUETE), clase: de(CLASE), origen: de(ORIGEN), modalidad: de(MODALIDAD_BIOMETRICA),
  alta: de(ALTA), canal: de(CANAL_DE_CONSENTIMIENTO_SOCIO),
};
