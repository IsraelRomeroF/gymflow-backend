import { z } from 'zod';
import type { FollowUpChannel, FollowUpOutcome } from '@gymflow/core';
import type { FollowUpContact } from '@gymflow/core/contracts';
import { MEMBER_OUTCOMES, PROSPECT_OUTCOMES } from '@gymflow/core';
import { CANALES, type FollowUpRecord } from './follow-up.repository.js';

/**
 * EL CONTRATO DE «Contacto con {nombre}» (UX7): lo que se manda y lo que
 * vuelve al registrar un contacto, igual para un prospecto que para un socio
 * en riesgo. Lo usan Prospectos y Retención; vive aquí, con la tabla, para que
 * los dos digan y guarden lo mismo (informes 10 y 15).
 */
const comun = {
  channel: z.enum(CANALES),
  note: z.string().max(500).optional(),
  nextStepOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
};
/** El contacto con un socio en riesgo: sus resultados son los de Retención (¿regresa?). */
export const contactoBody = z.object({ ...comun, outcome: z.enum(MEMBER_OUTCOMES) });
/**
 * El contacto con un interesado (bloque 2.4): sus resultados (¿se inscribe?)
 * incluyen «Vino a probar» y «Se le mandó el alta digital». «No le interesa»
 * lo cierra en el mismo paso y por eso trae el motivo (`interesadoPerdido`).
 */
export const contactoDeInteresadoBody = z.object({
  ...comun,
  outcome: z.enum(PROSPECT_OUTCOMES),
  lostReasonCode: z.string().max(40).optional(),
});
/** Contrato: `FollowUpContact` (`@gymflow/core/contracts`). */
export const contactoJson = (f: FollowUpRecord): FollowUpContact => ({
  id: f.id, channel: f.channel as FollowUpChannel, outcome: f.outcome as FollowUpOutcome, note: f.note,
  nextStepOn: f.nextStepOn ? f.nextStepOn.toISOString().slice(0, 10) : null,
  createdAt: f.createdAt.toISOString(), createdByName: f.createdByName ?? null,
});
