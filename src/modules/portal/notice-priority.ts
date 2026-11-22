import type { NoticePriority } from '@gymflow/core/contracts';

/**
 * QUÉ TAN ARRIBA VA CADA AVISO DEL SOCIO (fase 2, bloque 2.8 · 25-11).
 *
 * La campana ordenaba solo por fecha: seis «Tu portal se activó» tapaban la
 * suspensión, que era lo único que el socio tenía que resolver. Aquí cada
 * tipo de aviso dice de qué es (dinero, acceso, clase o información) y, con
 * el estado de HOY del socio, sale su prioridad:
 *
 *  - `RESOLVE`: de dinero mientras deba algo, o de acceso mientras su
 *    membresía siga en mora o suspendida. En cuanto paga, el aviso deja de
 *    estar «por resolver»: sigue en la lista, entre los recientes.
 *  - `CLASS`: su clase de mañana, mientras sea reciente.
 *  - `INFO`: lo demás (teléfono nuevo, privacidad, alta aprobada).
 *
 * Un tipo que no esté aquí es información: un aviso nuevo nunca nace arriba
 * sin que alguien lo decida. La bandeja de salida (2.9) puede leer este mapa.
 */
const DE_QUE_ES: Readonly<Record<string, 'MONEY' | 'ACCESS' | 'CLASS'>> = {
  PAYMENT_DUE_SOON: 'MONEY',
  PAYMENT_OVERDUE: 'MONEY',
  MEMBERSHIP_SUSPENDED: 'ACCESS',
  CLASS_TOMORROW: 'CLASS',
};

/** Una clase «de mañana» avisada hace más de dos días ya pasó. */
const CLASE_VIGENTE_MS = 2 * 86_400_000;

export type EstadoParaAvisos = {
  /** Tiene algo por pagar. */
  debe: boolean;
  /** Su membresía está en mora o suspendida. */
  sinAcceso: boolean;
  ahora: Date;
};

export function prioridadDe(aviso: { kind: string; createdAt: Date }, estado: EstadoParaAvisos): NoticePriority {
  const tipo = DE_QUE_ES[aviso.kind];
  if (tipo === 'MONEY') return estado.debe ? 'RESOLVE' : 'INFO';
  if (tipo === 'ACCESS') return estado.sinAcceso || estado.debe ? 'RESOLVE' : 'INFO';
  if (tipo === 'CLASS') return estado.ahora.getTime() - aviso.createdAt.getTime() <= CLASE_VIGENTE_MS ? 'CLASS' : 'INFO';
  return 'INFO';
}
