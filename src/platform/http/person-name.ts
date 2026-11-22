import { z } from 'zod';

/**
 * Nombre de una persona tal como se escribe: letras de cualquier alfabeto,
 * espacios, apóstrofo, guion y punto. El alta pública aceptaba
 * `<img onerror=…>` como nombre (SEC-13): React lo escapaba al pintarlo, pero
 * ese texto viaja a recibos, exportaciones y sistemas que quizá no escapan.
 */
const NOMBRE = /^[\p{L}\p{M}][\p{L}\p{M} '’.-]*$/u;

export const nombrePersona = (max = 80) =>
  z.string().trim().min(1).max(max).regex(NOMBRE, 'Solo letras, espacios, apóstrofo, guion y punto');
