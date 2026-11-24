/**
 * Módulo ACCESO — política, decisiones, asistencias y gateways.
 *
 * Tablas propias: `access_gateways`, `access_decisions`, `attendance_events`,
 * `biometric_enrollments`.
 *
 * La POLÍTICA no vive aquí: vive en `@gymflow/core`, porque el gateway de la
 * sucursal tiene que ejecutar exactamente la misma función sin base de datos
 * (ADR-015). Este módulo reúne los datos que la política necesita y persiste
 * lo que decidió.
 *
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerAccessRoutes } from './access.routes.js';

// Consumida por: portal. El socio ve en su teléfono sus últimas visitas; la
// asistencia es de este módulo (antes la leía `analytics`, A3-T12).
export { AttendanceRepository } from './attendance.repository.js';

// Consumida por: portal (fase 2, bloque 2.8). «¿Puedo entrar hoy?» en el
// teléfono es la MISMA regla de la puerta (`veredictoParaElSocio`): el portal
// no decide nada por su cuenta (27-04).
export { AccessService } from './access.service.js';

// Consumida por: portal. El socio ve en su teléfono con qué entra y en qué
// sucursal; la constancia vive aquí y el portal solo la lee.
export { EnrollmentRepository } from './enrollment.repository.js';

// Consumida por: privacy. Anonimizar revoca todo lo biométrico y BORRA las
// plantillas del servidor (A1-N1); la limpieza única de rostros la corre un
// script (`scripts/limpiar-rostros-huerfanos.ts`).
export { EnrollmentService, type ResumenLimpiezaRostros } from './enrollment.service.js';

// Consumida por: privacy (bloque 3.9, D-32). El cierre diario pregunta qué
// rostros de exsocios siguen guardados para borrarlos a los 30 días de la baja.
export { FaceTemplateRepository } from './face-template.repository.js';

// Consumida por: privacy (bloque 3.12, D-32). Los rostros que se borran a los
// 30 días de apagar Biometría con el aviso confirmado.
export { rostrosQueBorraApagar } from './rostros-al-apagar.js';

// Consumida por: classes. Al entrar, la clase reservada queda con su llegada.
export { registerEntryHook, type EntryEvent } from './entry-hooks.js';

// Consumida por: analytics. La bandeja del Inicio (`GET /me/home`) cuenta los
// rechazos sin resolver con la MISMA definición que `GET /access/pending` (bloque 2.1).
export { pendientesDeLaPuerta } from './pending.routes.js';
