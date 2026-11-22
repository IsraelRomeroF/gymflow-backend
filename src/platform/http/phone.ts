import { z } from 'zod';
import { normalizePhoneMx } from '@gymflow/core';

/**
 * Teléfono mexicano: si se escribe, debe ser uno de verdad (10 dígitos, con o
 * sin lada). Antes un "55123" se normalizaba a nada en silencio y el socio
 * quedaba de alta sin ningún contacto (UXA-05). Vacío sigue siendo válido.
 */
export const telefonoMx = () =>
  z.string().trim().max(30).refine((v) => !v || normalizePhoneMx(v) !== null, 'Teléfono no válido: escribe los 10 dígitos');
